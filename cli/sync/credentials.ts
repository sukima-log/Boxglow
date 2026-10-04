/**
 * 資格情報 (サインインして得たトークン) の置き場
 *     <設定フォルダ>/credentials/<サーバーの印>.json   { server, account, login, token, createdAt }
 * - 1 つのサーバーにつき、サインインは 1 つ。
 * - 書く前に、置き場が本人だけのものであることを確かめる。確かめられるまで、秘密を 1 バイトも書かない。
 * - 保存の成功は「置いた後の確認まで通った」時点。それまで、今までの資格情報を控えとして残し、失敗したら戻す。
 * - 資格情報を変える処理 (保存・削除) は、サーバーごとのロックの中で行う (login と logout が重ならない)。
 * - Windows は、まだ保存に対応していない (本人だけの権限を、書く前に確かめる手順が未実装)。環境変数 BOXGLOW_TOKEN を使う
 */
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { FileBusy, lockFile } from "../file-store";
import { configDir, hashOf, normalizeServer } from "./state-store";

/** 保存する資格情報 */
export interface Credentials {
  /** サーバーの場所 (normalizeServer を通した値) */
  server: string;
  /** サーバーが確かめた利用者の ID */
  account: string;
  /** 表示用のログイン名 */
  login: string;
  token: string;
  createdAt: string;
}

/** 資格情報を保存できない (置き場が本人だけのものと確かめられない・この OS では未対応など)。reason は、表示用の短い説明 */
export class CredentialsUnsafe extends Error {
  constructor(readonly reason: string) { super(`cannot store credentials safely: ${reason}`); }
}
/** ほかの login / logout が動いている */
export class CredentialsBusy extends Error {
  constructor() { super("another login or logout is running"); }
}

/** 資格情報のフォルダ */
const dir = (): string => join(configDir(), "credentials");
/** そのサーバーの資格情報のファイル */
export const credentialsPath = (server: string): string => join(dir(), hashOf(normalizeServer(server)).slice(0, 32) + ".json");

/**
 * パスが「本人だけのもの」かを確かめる (POSIX)
 * Input : path = フォルダかファイル, kind = "dir" / "file"
 * Output: 問題が無ければ null。あれば理由
 */
function unsafeReason(path: string, kind: "dir" | "file"): string | null {
  // リンクは追わない (予期しない場所を、置き場として使わない)
  const st = lstatSync(path);
  if (st.isSymbolicLink()) return `${path} is a symbolic link`;
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) return `${path} is not a ${kind === "dir" ? "directory" : "regular file"}`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return `${path} is owned by another user`;
  if ((st.mode & 0o077) !== 0) return `${path} is accessible by other users (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/** 置き場のフォルダを用意して、本人だけのものであることを確かめる。だめなら CredentialsUnsafe */
function ensureDir(): void {
  if (process.platform === "win32") throw new CredentialsUnsafe("storing credentials on Windows is not supported yet");
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const reason = unsafeReason(dir(), "dir");
  if (reason) throw new CredentialsUnsafe(reason);
}

/**
 * 資格情報を変える処理を、サーバーごとに 1 つずつにする
 * Input : server = サーバーの場所, fn = ロックの中で行う処理
 * Output: fn の値。ほかの login / logout が動いていたら CredentialsBusy (待たない)
 */
export async function withCredentialsLock<T>(server: string, fn: () => Promise<T>): Promise<T> {
  ensureDir();
  let unlock: () => void;
  try { unlock = lockFile(credentialsPath(server), { waitMs: 0 }); } catch (e) { if (e instanceof FileBusy) throw new CredentialsBusy(); throw e; }
  try { return await fn(); } finally { unlock(); }
}

/**
 * 保存済みの資格情報を読む
 * Input : server = サーバーの場所
 * Output: 資格情報。無ければ null。中のサーバーが違う・形が合わない・ほかの利用者から読める置き場なら null (別のサーバーのトークンや、漏れたかもしれないトークンを送らない)
 */
export function readCredentials(server: string): Credentials | null {
  const path = credentialsPath(server);
  if (!existsSync(path)) return null;
  try {
    if (process.platform !== "win32" && (unsafeReason(dir(), "dir") || unsafeReason(path, "file"))) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>;
    if (value.server !== normalizeServer(server) || typeof value.token !== "string" || typeof value.account !== "string" || typeof value.login !== "string") return null;
    return { server: value.server, account: value.account, login: value.login, token: value.token, createdAt: String(value.createdAt ?? "") };
  } catch { return null; }
}

/**
 * 資格情報を保存する (ロックの中で呼ぶ)
 * Input : credentials = 保存する資格情報
 * Output: なし。保存の成功は、置いた後の確認まで通った時点。
 *         失敗 (CredentialsUnsafe など) のときは、今までの資格情報が置き場に残っている (戻せなかったときだけ、例外の restored が false)
 */
export function saveCredentials(credentials: Credentials): void {
  ensureDir();
  const path = credentialsPath(credentials.server);
  const op = randomUUID();
  const temp = `${path}.${op}.tmp`, prev = `${path}.prev-${op}`;
  const text = JSON.stringify({ ...credentials, server: normalizeServer(credentials.server) }, null, 2) + "\n";
  // 1) 排他の作成 (既に在れば失敗) で空の一時ファイルを作り、開いたまま、本人だけのものであることを確かめる。確かめてから、同じ口に書く
  const fd = openSync(temp, "wx", 0o600);
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new CredentialsUnsafe(`${temp} is not private`);
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd); rmSync(temp, { force: true });
    throw e;
  }
  closeSync(fd);
  // 2) 今までの資格情報を、控えとして残す (同じ中身への、別の名前)。それから、新しいファイルを改名で置く
  const hadPrevious = existsSync(path);
  try {
    if (hadPrevious) linkSync(path, prev);
    renameSync(temp, path);
  } catch (e) {
    rmSync(temp, { force: true }); rmSync(prev, { force: true });
    throw e;
  }
  // 3) 置いた後の確認。ここまで通って、保存の成功
  const reason = (() => { try { return unsafeReason(path, "file") ?? (readFileSync(path, "utf8") === text ? null : "the stored file is not what was written"); } catch (e) { return String(e); } })();
  if (reason === null) { rmSync(prev, { force: true }); return; }
  // 失敗: 置き場に在るのが、自分の置いたものであることを確かめてから、控えを戻す (ロックの中なので、ほかの login は割り込まない)
  let restored = false;
  try {
    if (readFileSync(path, "utf8") === text) {
      if (hadPrevious) renameSync(prev, path); else rmSync(path, { force: true });
      restored = true;
    }
  } catch { /* 戻せなかった (下で、そのことを伝える) */ }
  const error = new CredentialsUnsafe(reason) as CredentialsUnsafe & { restored: boolean; backup?: string };
  error.restored = restored;
  if (!restored && hadPrevious) error.backup = prev;
  throw error;
}

/** 保存済みの資格情報を消す (ロックの中で呼ぶ)。Output: 消したら true */
export function removeCredentials(server: string): boolean {
  const path = credentialsPath(server);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/**
 * 同期に使うトークンを決める: 環境変数 BOXGLOW_TOKEN > 保存済みの資格情報
 * Input : server = サーバーの場所
 * Output: { token, source = "env" / "file", login? }。どちらも無ければ null
 */
export function resolveToken(server: string): { token: string; source: "env" | "file"; login?: string } | null {
  if (process.env.BOXGLOW_TOKEN) return { token: process.env.BOXGLOW_TOKEN, source: "env" };
  const saved = readCredentials(server);
  return saved ? { token: saved.token, source: "file", login: saved.login } : null;
}

/** (試験用) 置き場のファイルの権限 */
export const modeOf = (path: string): number => statSync(path).mode & 0o777;
