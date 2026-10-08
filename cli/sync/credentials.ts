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
import { environmentTokenAllowed } from "./server-policy";
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

/** 保存済みの資格情報の状態: 無い / 使える / 在るが、安全に読めない・形が合わない */
export type StoredCredentials =
  | { kind: "absent" }
  | { kind: "valid"; credentials: Credentials }
  /** ファイルは在るが、使えない (ほかの利用者から読める・リンク・JSON でない・別のサーバーのもの・読み取りの失敗)。「サインインしていない」とは扱わない */
  | { kind: "unusable"; path: string; reason: string };

/**
 * 保存済みの資格情報の状態を調べる
 * Input : server = サーバーの場所
 * Output: StoredCredentials。使えないファイルからは、トークンを取り出さない (送らない)
 */
export function inspectCredentials(server: string): StoredCredentials {
  const path = credentialsPath(server);
  // (リンクも「在る」として扱う。existsSync は、切れたリンクを「無い」と答えるので、lstat で確かめる)
  try { lstatSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" }; return { kind: "unusable", path, reason: String(e) }; }
  try {
    if (process.platform !== "win32") {
      const reason = unsafeReason(dir(), "dir") ?? unsafeReason(path, "file");
      if (reason) return { kind: "unusable", path, reason };
    }
    const text = readFileSync(path, "utf8");
    // 理由には、ファイルの中身を混ぜない (中身はトークンかもしれない)。JSON の解析の失敗は、例外の文言に入力の抜粋が入ることがあるので、決まった文言にする
    let value: Partial<Credentials> | null;
    try { value = JSON.parse(text) as Partial<Credentials> | null; } catch { return { kind: "unusable", path, reason: "the file is not valid JSON" }; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "unusable", path, reason: "the file is not a credentials file" };
    if (value.server !== normalizeServer(server)) return { kind: "unusable", path, reason: "the file belongs to another server" };
    if (typeof value.token !== "string" || typeof value.account !== "string" || typeof value.login !== "string") return { kind: "unusable", path, reason: "the file is not a credentials file" };
    return { kind: "valid", credentials: { server: value.server, account: value.account, login: value.login, token: value.token, createdAt: String(value.createdAt ?? "") } };
  } catch (e) {
    // 読み取りの失敗: 理由は、エラーの種類 (EACCES など) だけにする
    return { kind: "unusable", path, reason: `the file could not be read (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
}

/**
 * 保存済みの資格情報を読む (同期に使うトークンを決めるとき用)
 * Input : server = サーバーの場所
 * Output: 使える資格情報。無い・使えないなら null (別のサーバーのトークンや、漏れたかもしれないトークンを送らない)。
 *         「無い」と「在るが使えない」を分けたいときは inspectCredentials を使う
 */
export function readCredentials(server: string): Credentials | null {
  const stored = inspectCredentials(server);
  return stored.kind === "valid" ? stored.credentials : null;
}

/**
 * 資格情報の保存に失敗した (権限の確認の失敗でも、ふつうのファイル操作の失敗でも、この形で伝える)
 *   restored = 今までの資格情報が、置き場に在る状態か (もともと無かった場合も true)
 *   backup   = 戻せなかったときの、控えの場所
 *   unsafe   = 置いたファイルの権限が不適切だと確かめた (確かめられなかった、ではなく)
 */
export class CredentialsSaveFailed extends Error {
  constructor(readonly reason: string, readonly restored: boolean, readonly backup: string | null, readonly unsafe: boolean) { super(`could not store credentials: ${reason}`); }
}

/**
 * 資格情報を保存する (ロックの中で呼ぶ)
 * Input : credentials = 保存する資格情報, hooks.afterPlace = 新しいファイルを置いた直後 (最後の確認の前) に呼ぶ (試験で、その時点の失敗を作るために使う)
 * Output: なし。保存の成功は、置いた後の確認まで通った時点 (その後の、控えの片付けの失敗は、失敗として扱わない)。
 *         失敗は、どの段でも CredentialsSaveFailed (今までの資格情報を戻せたかどうかを含む)
 */
export function saveCredentials(credentials: Credentials, hooks: { afterPlace?: () => void } = {}): void {
  const path = credentialsPath(credentials.server);
  const op = randomUUID();
  const temp = `${path}.${op}.tmp`, prev = `${path}.prev-${op}`;
  const text = JSON.stringify({ ...credentials, server: normalizeServer(credentials.server) }, null, 2) + "\n";
  const message = (e: unknown) => e instanceof CredentialsUnsafe ? e.reason : e instanceof Error ? e.message : String(e);
  const quiet = (fn: () => void) => { try { fn(); } catch { /* 片付けの失敗は、結果を変えない */ } };
  // ---- 置き換える前 (ここまでの失敗では、今までの資格情報は、そのまま在る) ----
  try {
    ensureDir();
    // 1) 排他の作成 (既に在れば失敗) で空の一時ファイルを作り、開いたまま、本人だけのものであることを確かめる。確かめてから、同じ口に書く
    const fd = openSync(temp, "wx", 0o600);
    try {
      const st = fstatSync(fd);
      if ((st.mode & 0o077) !== 0 || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new CredentialsUnsafe(`${temp} is not private`);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  } catch (e) {
    quiet(() => rmSync(temp, { force: true }));
    throw new CredentialsSaveFailed(message(e), true, null, false);
  }
  // 2) 今までの資格情報を、控えとして残す (同じ中身への、別の名前)。それから、新しいファイルを改名で置く
  let hadPrevious = false;
  try {
    hadPrevious = existsSync(path);
    if (hadPrevious) linkSync(path, prev);
    renameSync(temp, path);
  } catch (e) {
    quiet(() => rmSync(temp, { force: true })); quiet(() => rmSync(prev, { force: true }));
    throw new CredentialsSaveFailed(message(e), true, null, false);
  }
  // 3) 置いた後の確認。ここまで通って、保存の成功
  let reason: string | null, unsafe = false;
  try {
    hooks.afterPlace?.();
    reason = unsafeReason(path, "file");
    unsafe = reason !== null;
    if (reason === null && readFileSync(path, "utf8") !== text) reason = "the stored file is not what was written";
  } catch (e) { reason = message(e); }
  if (reason === null) {
    // (控えの片付けに失敗しても、保存は成功している。新しい資格情報を、失敗として取り消させない)
    quiet(() => rmSync(prev, { force: true }));
    return;
  }
  // 失敗: 置き場に在るのが、自分の置いたものであることを確かめてから、控えを戻す (ロックの中なので、ほかの login は割り込まない)
  let restored = false;
  try {
    if (readFileSync(path, "utf8") === text) {
      if (hadPrevious) renameSync(prev, path); else rmSync(path, { force: true });
      restored = true;
    }
  } catch { /* 戻せなかった (下で、そのことを伝える) */ }
  throw new CredentialsSaveFailed(reason, restored, !restored && hadPrevious ? prev : null, unsafe);
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
export function resolveToken(server: string, allowEnvironmentToken = true): { token: string; source: "env" | "file"; login?: string } | null {
  if (allowEnvironmentToken && environmentTokenAllowed(server) && process.env.BOXGLOW_TOKEN) return { token: process.env.BOXGLOW_TOKEN, source: "env" };
  const saved = readCredentials(server);
  return saved ? { token: saved.token, source: "file", login: saved.login } : null;
}

/** (試験用) 置き場のファイルの権限 */
export const modeOf = (path: string): number => statSync(path).mode & 0o777;
