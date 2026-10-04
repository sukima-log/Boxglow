/**
 * 常時の同期 (boxglow sync --watch)
 * 1 つの処理が、この端末の「同じサーバーに結び付いた計画すべて」を受け持つ:
 *   - 手元の変更: 計画のファイルを見張り、変わったら 2 秒まとめてから送る。変更が続いても、最初の変更から最長 10 秒で送る
 *   - サーバーの変更: 一覧 (全部の計画の最新の版) を 1 回の要求で確かめる。間隔は 30 秒。変化が無い状態が続けば 60 秒まで延ばす
 *   - 止まった計画 (競合・確認待ち) は、手元かサーバーが変わるまで、同じ内容を繰り返し試さない
 *   - 通信できないときは、間隔を延ばしながらやり直す
 * 同じ端末・同じサーバーで動かせる常時の同期は 1 つだけ (2 つ目は、1 つ目に任せて終わる)。確認の要求を、計画の数だけ倍にしないため。
 * 時刻と通信は外から渡せる (試験で差し替える)。tick() を呼ぶたびに、その時刻で行うべきことを 1 回分だけ行う
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileBusy, lockFile } from "../file-store";
import { fetchHeads, syncOnce, SyncNetworkError, type SyncResult } from "./client";
import { configDir, hashOf, normalizeServer, StateStore, type Binding, type StoredState } from "./state-store";

/** 手元の変更をまとめる時間 (ms): 最後の変更からこれだけ静かなら送る */
export const DEBOUNCE_MS = 2_000;
/** 変更が続いていても、最初の変更からこれだけ経ったら送る (ms) */
export const MAX_WAIT_MS = 10_000;
/** サーバーを確かめる間隔 (ms)。変化が無い状態が続いたら IDLE_POLL_MS まで延ばす */
export const POLL_MS = 30_000;
export const IDLE_POLL_MS = 60_000;
/** この回数つづけて変化が無ければ、確かめる間隔を延ばす */
const IDLE_AFTER = 10;
/** 失敗した後のやり直しの間隔 (ms): 最初と上限 */
const RETRY_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/** 常時の同期が知らせる出来事 */
export type WatchEvent =
  | { kind: "synced"; file: string; pulled: number; pushed: number; revision: string | null }
  | { kind: "halted"; file: string; result: Extract<SyncResult, { status: "halted" }> }
  | { kind: "network"; message: string; retryInMs: number }
  | { kind: "error"; file: string; message: string };

/** 計画 1 つ分の見張りの状態 */
interface Watched {
  binding: Binding;
  /** 最後に見たファイルの印 (更新時刻と大きさ)。変わったら「手元が変わった」とみなす */
  seen: string;
  /** まとめている変更の、最初と最後の時刻 (変更が無ければ null) */
  firstChangeAt: number | null;
  lastChangeAt: number | null;
  /** サーバーが進んでいる (次の機会に同期する) */
  remoteAhead: boolean;
  /** 最後に確かめた、サーバーの最新の版 (まだ確かめていなければ undefined) */
  head: string | null | undefined;
  /** 止まっている: そのときの手元の印とサーバーの最新の版。どちらかが変わるまで、もう一度試さない */
  halted: { seen: string; head: string | null | undefined } | null;
}

/** 常時の同期の指定 */
export interface WatchOptions {
  server: string;
  token?: string;
  /** 今の時刻 (ms)。試験で差し替える */
  now?: () => number;
  /** 通信の関数。試験で差し替える */
  fetch?: typeof fetch;
  /** 間隔のばらつきに使う乱数 (0 以上 1 未満)。試験では固定値にする */
  random?: () => number;
  onEvent?: (event: WatchEvent) => void;
}

/** ファイルの印 (更新時刻と大きさ。無ければ "none") */
function signature(file: string): string {
  try { const st = statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return "none"; }
}

/**
 * この端末で、指定したサーバーに結び付いている計画をすべて挙げる (各フォルダの state.json を調べる)
 * Input : server = サーバーの場所
 * Output: 結び付けの一覧 (状態を読めないフォルダは飛ばす)
 */
export function bindingsFor(server: string): StoredState[] {
  const root = join(configDir(), "sync");
  let names: string[] = [];
  try { names = readdirSync(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const found: StoredState[] = [];
  for (const name of names) {
    if (!existsSync(join(root, name, "state.json"))) continue;
    try { const state = new StateStore(join(root, name)).read(); if (state && state.binding.server === normalizeServer(server)) found.push(state); } catch { /* 読めない状態は、1 回の同期 (boxglow sync) で知らせる */ }
  }
  return found;
}

/**
 * 「この端末・このサーバーの常時の同期は 1 つだけ」のためのロックを取る
 * Input : server = サーバーの場所
 * Output: { unlock = 外す関数, path = ロックの対象のパス }。すでに動いていれば unlock は null
 */
export function lockWatch(server: string): { unlock: (() => void) | null; path: string } {
  const root = join(configDir(), "sync");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, `watch-${hashOf(normalizeServer(server)).slice(0, 16)}`);
  try { return { unlock: lockFile(path, { waitMs: 0 }), path }; } catch (e) { if (e instanceof FileBusy) return { unlock: null, path }; throw e; }
}

/** 常時の同期の本体。tick() を定期的に呼ぶ (呼ぶ間隔は 1 秒程度) */
export class SyncWatcher {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly watched = new Map<string, Watched>();
  /** 次にサーバーを確かめる時刻 */
  private nextPollAt = 0;
  /** 変化が無かった確認の回数 (間隔を延ばす判断に使う) */
  private quietPolls = 0;
  /** 通信の失敗が続いている間の、やり直しの間隔と、次に通信してよい時刻 */
  private retryMs = 0;
  private blockedUntil = 0;
  /** 1 回分の処理が動いている間は、次の tick を重ねない */
  private running = false;

  constructor(private readonly options: WatchOptions) {
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /** 見張っている計画のファイルの一覧 (試験の確認用) */
  files(): string[] { return [...this.watched.keys()]; }

  /**
   * その時刻で行うべきことを 1 回分行う: 結び付けの一覧を取り直す → 手元の変更を調べる → (時刻が来ていれば) サーバーを確かめる → 送る・受け取る
   * Output: なし (出来事は onEvent で知らせる)。例外は投げない (失敗は出来事として知らせ、次の tick でやり直す)
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      this.refreshBindings();
      // ---- 手元の変更を調べる ----
      for (const w of this.watched.values()) {
        const sig = signature(w.binding.file);
        if (sig !== w.seen) { w.seen = sig; w.firstChangeAt ??= now; w.lastChangeAt = now; }
      }
      if (now < this.blockedUntil) return;
      // ---- サーバーを確かめる (全部の計画を 1 回の要求で) ----
      if (now >= this.nextPollAt && this.watched.size > 0) {
        try {
          const { heads } = await fetchHeads({ server: this.options.server, token: this.options.token, fetch: this.options.fetch });
          let changed = false;
          for (const w of this.watched.values()) {
            const entry = heads.get(w.binding.remoteId);
            const head = entry?.deleted ? "(deleted)" : entry?.revision ?? null;
            const base = this.baseRevision(w.binding);
            w.head = head;
            // サーバーの最新の版が、前回そろえた版と違えば、受け取りが要る (消された・まだ無い場合も、1 回の同期に任せて確かめる)。
            // 止まっている計画は、止まったときからサーバーが動いていなければ、もう一度試さない
            if (head !== base && !(w.halted && w.halted.head === head)) { w.remoteAhead = true; changed = true; }
          }
          this.retryMs = 0;
          this.quietPolls = changed ? 0 : this.quietPolls + 1;
          const interval = this.quietPolls >= IDLE_AFTER ? IDLE_POLL_MS : POLL_MS;
          // ばらつきを入れる (±10%)。たくさんの端末が、同じ瞬間に確かめに来ないように
          this.nextPollAt = now + interval * (0.9 + 0.2 * this.random());
        } catch (e) {
          if (!(e instanceof SyncNetworkError)) throw e;
          this.backOff(now, e.message);
          return;
        }
      }
      // ---- 同期が要る計画を、1 つずつ同期する ----
      for (const w of this.watched.values()) {
        const localDue = w.firstChangeAt !== null && w.lastChangeAt !== null
          && (now - w.lastChangeAt >= DEBOUNCE_MS || now - w.firstChangeAt >= MAX_WAIT_MS);
        // 止まっている計画は、手元かサーバーが変わったときだけ、もう一度試す (同じ内容を繰り返し送らない)
        if (w.halted && w.halted.seen === w.seen && !w.remoteAhead) { w.firstChangeAt = w.lastChangeAt = null; continue; }
        if (!localDue && !w.remoteAhead) continue;
        const ok = await this.syncOne(w, now);
        if (!ok) return; // 通信できなかった。残りは、次に通信できるときに
      }
    } finally {
      this.running = false;
    }
  }

  /** 結び付けの一覧を取り直す (常時の同期を始めた後で結び付けた計画も、次の tick から受け持つ) */
  private refreshBindings(): void {
    const current = new Map(bindingsFor(this.options.server).map((s) => [s.binding.file, s.binding] as const));
    for (const file of [...this.watched.keys()]) if (!current.has(file)) this.watched.delete(file);
    for (const [file, binding] of current) {
      // 新しく見つけた計画は、最初に 1 回同期する (止まっている間の変更を取り込む)
      if (!this.watched.has(file)) this.watched.set(file, { binding, seen: signature(file), firstChangeAt: null, lastChangeAt: null, remoteAhead: true, head: undefined, halted: null });
    }
  }

  /** 前回そろえたサーバーの版 (状態が読めなければ null) */
  private baseRevision(binding: Binding): string | null {
    try { return bindingsFor(binding.server).find((s) => s.binding.file === binding.file)?.base?.revision ?? null; } catch { return null; }
  }

  /** 通信の失敗: やり直しの間隔を延ばす (最初 5 秒、倍々で 60 秒まで) */
  private backOff(now: number, message: string): void {
    this.retryMs = this.retryMs === 0 ? RETRY_MS : Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.blockedUntil = now + this.retryMs;
    this.options.onEvent?.({ kind: "network", message, retryInMs: this.retryMs });
  }

  /**
   * 計画 1 つを同期する
   * Output: 通信できたら true (止まった・ほかが動いていた場合も true)。通信できなかったら false
   */
  private async syncOne(w: Watched, now: number): Promise<boolean> {
    let result: SyncResult;
    try {
      result = await syncOnce({ file: w.binding.file, server: this.options.server, token: this.options.token, fetch: this.options.fetch, now: () => new Date(this.now()) });
    } catch (e) {
      if (e instanceof SyncNetworkError) { this.backOff(now, e.message); return false; }
      // 状態が読めないなど: この計画は止めておき、ほかの計画は続ける
      w.halted = { seen: w.seen, head: w.head }; w.remoteAhead = false; w.firstChangeAt = w.lastChangeAt = null;
      this.options.onEvent?.({ kind: "error", file: w.binding.file, message: e instanceof Error ? e.message : String(e) });
      return true;
    }
    // 同期が書いた分を「手元の変更」と数えないように、印を取り直す
    w.seen = signature(w.binding.file);
    if (result.status === "busy") return true; // ほかの同期・書き込みが動いている。変更の記録は残したまま、次の tick でやり直す
    w.firstChangeAt = w.lastChangeAt = null;
    w.remoteAhead = false;
    if (result.status === "synced") {
      // 止まっていた計画がそろったときは、送受信が無くても知らせる (止まったままではないことが分かるように)
      const resumed = w.halted !== null;
      w.halted = null;
      if (result.pulled || result.pushed || resumed) this.options.onEvent?.({ kind: "synced", file: w.binding.file, pulled: result.pulled, pushed: result.pushed, revision: result.revision });
      return true;
    }
    // 止まった: 同じ状態では繰り返し知らせない
    const first = !w.halted || w.halted.seen !== w.seen;
    w.halted = { seen: w.seen, head: w.head };
    if (first) this.options.onEvent?.({ kind: "halted", file: w.binding.file, result });
    return true;
  }
}
