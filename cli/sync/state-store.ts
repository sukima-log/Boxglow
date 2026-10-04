/**
 * 同期の状態の置き場 (手元の端末の設定フォルダ)
 * 計画のファイルの外に、結び付けごとに 1 つのフォルダを持つ:
 *     <設定フォルダ>/sync/<結び付けの印>/
 *         state.json        同期の状態 (結び付け・サーバーの履歴の世代・基準・やりかけの操作)。置き換えは原子的。読むときに形を検査する
 *         objects/<ハッシュ>  中身の写し (基準・送る中身・受け取った中身)。書いたら変えない
 * 結び付けの印は「サーバーの場所 + 計画のファイルの実体のパス」から作る。1 つのパスにつき、サーバーごとに 1 つの結び付けだけを持つ。
 * state.json の書き換えは「読んだ世代のままなら置き換える」。同じ結び付けを扱う同期の処理は、状態用のロックで 1 つに絞る
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

/** state.json が読めない・形が合わない (壊れている。自動では直さない) */
export class SyncStateUnreadable extends Error {
  constructor(readonly path: string, readonly problem: string) { super(`sync state is unreadable (${problem}): ${path}`); }
}

/**
 * state.json の中身が、決めた形になっているかを確かめる (型の宣言だけでは、ファイルの中身は検査できない)
 * Input : value = JSON を解釈した値
 * Output: 問題が無ければ null。あれば、どこが合わないかの短い説明
 */
export function stateProblem(value: unknown): string | null {
  const text = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  const obj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  if (!obj(value)) return "not an object";
  if (value.version !== 1) return "unknown version";
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) return "generation";
  if (value.epoch !== null && !text(value.epoch)) return "epoch";
  const b = value.binding;
  if (!obj(b) || !text(b.file) || !text(b.server) || !text(b.remoteId) || typeof b.planId !== "string") return "binding";
  const base = value.base;
  if (base !== null && (!obj(base) || !text(base.hash) || !text(base.revision))) return "base";
  const p = value.pending;
  if (p !== null) {
    if (!obj(p) || !text(p.hash) || !text(p.at)) return "pending";
    if (p.kind === "push") { if (!text(p.opId) || (p.expected !== null && !text(p.expected))) return "pending push"; }
    else if (p.kind === "pull") {
      if ((p.expectedLocal !== null && !text(p.expectedLocal)) || !obj(p.remote) || !text(p.remote.hash) || !text(p.remote.revision)) return "pending pull";
    } else return "pending kind";
    // 操作を記録した状態には、必ず履歴の世代がある
    if (value.epoch === null) return "pending without epoch";
  }
  return null;
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
 * 計画のファイルの「実体のパス」を決める。ファイルがまだ無くても、作った後と同じパスになるようにする
 * (ファイルが無いときは、存在するいちばん近い親フォルダの実体のパスに、残りの名前をつなぐ。
 *  親がシンボリックリンクのフォルダだと、作る前と作った後でパスが変わり、別の結び付けとして扱ってしまうため)
 * Input : file = 計画のファイルのパス (相対でもよい。無くてもよい)
 * Output: 実体の絶対パス
 */
export function realFile(file: string): string {
  let at = resolve(file);
  const rest: string[] = [];
  while (!existsSync(at)) {
    const parent = dirname(at);
    if (parent === at) return resolve(file); // ルートまで無い (ありえないが、そのままのパスを返す)
    rest.unshift(basename(at));
    at = parent;
  }
  return join(realpathSync(at), ...rest);
}

/**
 * 結び付けのフォルダを決める (サーバーの場所と、計画のファイルの実体のパスから)
 * Input : file = 計画のファイルのパス, server = サーバーの場所
 * Output: 結び付けのフォルダの絶対パス (まだ無いこともある)
 */
export function bindingDir(file: string, server: string): string {
  return join(configDir(), "sync", hashOf(`${normalizeServer(server)}\n${realFile(file)}`).slice(0, 32));
}

/**
 * 計画のファイルに結び付いているサーバーを探す (boxglow sync を、サーバーの指定なしで実行したとき用)
 * 索引のファイルは持たない。結び付けのフォルダの state.json を直接調べる (state.json が正。索引を別に持つと、
 * 書く途中で落ちたときや、別の結び付けが同時に書いたときに、索引だけが欠ける)
 * Input : file = 計画のファイルのパス
 * Output: { bindings = そのファイルの結び付けの一覧, unreadable = 状態を読めなかった結び付けのフォルダ (どのファイルのものか分からない) }
 */
export function bindingsOf(file: string): { bindings: Binding[]; unreadable: string[] } {
  const real = realFile(file);
  const root = join(configDir(), "sync");
  const bindings: Binding[] = [], unreadable: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  for (const name of names) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "state.json"))) continue;
    try { const state = new StateStore(dir).read(); if (state && state.binding.file === real) bindings.push(state.binding); }
    catch { unreadable.push(dir); }
  }
  return { bindings, unreadable };
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

  /** 状態を読む。まだ無ければ null。壊れている・形が合わなければ例外 (推測で作り直さない。読めない操作の記録を「無いもの」として扱わない) */
  read(): StoredState | null {
    if (!existsSync(this.statePath)) return null;
    let value: unknown;
    try { value = JSON.parse(readFileSync(this.statePath, "utf8")); } catch { throw new SyncStateUnreadable(this.statePath, "not JSON"); }
    const problem = stateProblem(value);
    if (problem) throw new SyncStateUnreadable(this.statePath, problem);
    return value as StoredState;
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
  }

  /**
   * 中身の写しを置く。state.json がそのハッシュを指す前に、必ず先に置く
   * Input : text = 中身
   * Output: 中身のハッシュ。返したハッシュの写しは、必ず読み戻せる
   *         (同じハッシュの写しが既にあっても、中身が壊れていたら置き直す。置き直せなければ例外にして、状態を進ませない)
   */
  putObject(text: string): string {
    const hash = hashOf(text);
    if (this.getObject(hash) === null) {
      writeAtomic(join(this.dir, "objects", hash), text);
      if (this.getObject(hash) === null) throw new Error("could not store a content copy in the sync state folder: " + hash);
    }
    return hash;
  }

  /** 中身の写しを読む。無い・中身がハッシュと合わない (壊れている) なら null */
  getObject(hash: string): string | null {
    try { const text = readFileSync(join(this.dir, "objects", hash), "utf8"); return hashOf(text) === hash ? text : null; } catch { return null; }
  }
}
