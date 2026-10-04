/**
 * 同期の状態の置き場 (手元の端末の設定フォルダ)
 * 計画のファイルの外に、結び付けごとに 1 つのフォルダを持つ:
 *     <設定フォルダ>/sync/<結び付けの印>/
 *         state.json        同期の状態 (結び付け・サーバーの履歴の世代・基準・やりかけの操作)。置き換えは原子的
 *         objects/<ハッシュ>  中身の写し (基準・送る中身・受け取った中身)。書いたら変えない
 * 結び付けの印は「サーバーの場所 + 計画のファイルの実体のパス」から作る。1 つのパスにつき、サーバーごとに 1 つの結び付けだけを持つ。
 * state.json の書き換えは「読んだ世代のままなら置き換える」。同じ結び付けを扱う同期の処理は、状態用のロックで 1 つに絞る
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { FileBusy, lockFile } from "../file-store";
import type { SyncState } from "../../src/sync/engine";

/** 文字列の SHA-256 (16 進)。送受信した文字列そのものに対して計算する (中身のハッシュ) */
export const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 結び付け: どのファイルを、どのサーバーのどの計画と同期するか */
export interface Binding {
  /** 計画のファイルの実体のパス */
  file: string;
  /** サーバーの場所 (URL。末尾の / は付けない) */
  server: string;
  /** サーバー側の計画の ID (手元で決めた ID) */
  remoteId: string;
  /** 結び付けたときの、計画のファイルの中の ID (同じパスに別の計画が置かれたことに気づくため) */
  planId: string;
}

/** state.json の中身 */
export interface StoredState extends SyncState {
  /** この形式の版 */
  version: 1;
  binding: Binding;
}

/** 状態の世代が、読んだときと違っていた (他の同期の処理が書き換えた) */
export class StateConflict extends Error {
  constructor() { super("sync state changed by another process"); }
}

/**
 * 同期の状態を置く、設定フォルダの場所を決める
 * Input : なし (環境変数 BOXGLOW_CONFIG_DIR > XDG_CONFIG_HOME > APPDATA (Windows) > ~/.config の順)
 * Output: <設定フォルダ>/boxglow の絶対パス
 */
export function configDir(): string {
  if (process.env.BOXGLOW_CONFIG_DIR) return resolve(process.env.BOXGLOW_CONFIG_DIR);
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "boxglow");
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "boxglow");
  return join(homedir(), ".config", "boxglow");
}

/** サーバーの場所を、比べやすい形にそろえる (末尾の / を取る) */
export const normalizeServer = (server: string): string => server.replace(/\/+$/, "");

/**
 * 結び付けのフォルダを決める (サーバーの場所と、計画のファイルの実体のパスから)
 * Input : file = 計画のファイルのパス, server = サーバーの場所
 * Output: 結び付けのフォルダの絶対パス (まだ無いこともある)
 */
export function bindingDir(file: string, server: string): string {
  const real = existsSync(file) ? realpathSync(file) : resolve(file);
  return join(configDir(), "sync", hashOf(`${normalizeServer(server)}\n${real}`).slice(0, 32));
}

/**
 * 計画のファイルに結び付いているサーバーを探す (boxglow sync を、サーバーの指定なしで実行したとき用)
 * Input : file = 計画のファイルのパス
 * Output: そのファイルの結び付けの一覧 (結び付けが無ければ空)
 */
export function bindingsOf(file: string): Binding[] {
  const index = readIndex();
  const real = existsSync(file) ? realpathSync(file) : resolve(file);
  return index.filter((b) => b.file === real);
}

/** 結び付けの索引 (<設定フォルダ>/sync/bindings.json): ファイルからサーバーを引くための一覧。正は各フォルダの state.json */
const indexPath = (): string => join(configDir(), "sync", "bindings.json");
function readIndex(): Binding[] {
  try { const v = JSON.parse(readFileSync(indexPath(), "utf8")); return Array.isArray(v) ? v as Binding[] : []; } catch { return []; }
}

/**
 * ファイルを、同じフォルダの一時ファイルに書いてから改名で置く (途中で落ちても、半端な中身のファイルは残らない)
 * Input : path = 置き先, text = 中身
 * Output: なし
 */
function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, text, { encoding: "utf8", mode: 0o600 });
  try { renameSync(temp, path); } catch (e) { try { rmSync(temp, { force: true }); } catch { /* 一時ファイルが残っても、状態としては読まれない */ } throw e; }
}

/** 結び付け 1 つ分の状態の読み書き (状態用のロックを持っている間だけ使う) */
export class StateStore {
  constructor(readonly dir: string) {}
  private get statePath(): string { return join(this.dir, "state.json"); }

  /**
   * 状態用のロックを取る (同じ結び付けを扱う同期の処理を 1 つに絞る)
   * Output: ロックを外す関数。他の同期の処理が動いていれば null (待たない)
   */
  lock(): (() => void) | null {
    mkdirSync(join(this.dir, "objects"), { recursive: true, mode: 0o700 });
    try { return lockFile(this.statePath, { waitMs: 0 }); } catch (e) { if (e instanceof FileBusy) return null; throw e; }
  }

  /** 状態を読む。まだ無ければ null。壊れていれば例外 (推測で作り直さない) */
  read(): StoredState | null {
    if (!existsSync(this.statePath)) return null;
    const s = JSON.parse(readFileSync(this.statePath, "utf8")) as StoredState;
    if (s?.version !== 1 || typeof s.generation !== "number" || !s.binding) throw new Error("sync state is unreadable: " + this.statePath);
    return s;
  }

  /**
   * 状態を書く (読んだ世代のままなら置き換える)
   * Input : next = 新しい状態, expectedGeneration = 読んだときの世代 (初めて書くときは null)
   * Output: なし。世代が違っていたら StateConflict
   */
  write(next: StoredState, expectedGeneration: number | null): void {
    const current = this.read();
    if ((current?.generation ?? null) !== expectedGeneration) throw new StateConflict();
    writeAtomic(this.statePath, JSON.stringify(next, null, 2) + "\n");
    // 索引に結び付けを載せる (同じファイル・同じサーバーの古い行は置き換える)
    const index = readIndex().filter((b) => !(b.file === next.binding.file && b.server === next.binding.server));
    writeAtomic(indexPath(), JSON.stringify([...index, next.binding], null, 2) + "\n");
  }

  /** 中身の写しを置く (同じハッシュの写しが既にあれば何もしない)。state.json がそのハッシュを指す前に、必ず先に置く */
  putObject(text: string): string {
    const hash = hashOf(text);
    const path = join(this.dir, "objects", hash);
    if (!existsSync(path)) writeAtomic(path, text);
    return hash;
  }

  /** 中身の写しを読む。無い・中身がハッシュと合わない (壊れている) なら null */
  getObject(hash: string): string | null {
    try { const text = readFileSync(join(this.dir, "objects", hash), "utf8"); return hashOf(text) === hash ? text : null; } catch { return null; }
  }
}
