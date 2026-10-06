/**
 * 常時の同期 (boxglow sync --watch)
 * 1 つの処理が、この端末の「同じサーバーに結び付いた計画すべて」を受け持つ:
 *   - 手元の変更: 計画のファイルを見張り、変わったら 2 秒まとめてから送る。変更が続いても、最初の変更から最長 10 秒で送る
 *   - サーバーの変更: 一覧 (全部の計画の最新の版) を 1 回の要求で確かめる。間隔は 30 秒。変化が無い状態が続けば 60 秒まで延ばす
 *   - 止まった計画 (競合・確認待ち) は、手元かサーバーが変わるまで、同じ内容を繰り返し試さない
 *   - 通信できないときは、間隔を延ばしながらやり直す
 * 同じ端末・同じサーバーで動かせる常時の同期は 1 つだけ (2 つ目は、1 つ目に任せて終わる)。確認の要求を、計画の数だけ倍にしないため。
 * 変更に気づく方法: ふだんはファイルの更新時刻と大きさを見る (軽い)。それだけでは見落とす書き換え (同じ時刻・同じ大きさ) があるので、
 * サーバーを確かめるたびに、中身のハッシュも「最後にそろえた中身」と比べる。
 * 時間の測り方: 待ち時間 (2 秒・10 秒・確認の間隔・やり直しの間隔) は、巻き戻らない時計 (elapsed) で測る。
 * 操作の記録に残す日時だけ、ふつうの時計 (now) を使う。PC の時計が巻き戻っても、待っている変更が送られなくならない。
 * 時刻と通信は外から渡せる (試験で差し替える)。tick() を呼ぶたびに、その時点で行うべきことを 1 回分だけ行う
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileBusy, lockFile } from "../file-store";
import { fetchHeads, syncOnce, SyncAuthError, SyncNetworkError, type SyncResult } from "./client";
import { bindingDir, configDir, hashOf, normalizeServer, StateStore, type Binding, type StoredState } from "./state-store";

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
  | { kind: "synced"; file: string; pulled: number; pushed: number; revision: string | null
      /** 「そろった」と確かめたときの手元の中身のハッシュ (画面の裏方が、今のディスクと比べて「同期済み」かを決めるのに使う) */
    ; localHash: string | null }
  | { kind: "halted"; file: string; result: Extract<SyncResult, { status: "halted" }> }
  | { kind: "network"; message: string; retryInMs: number }
  /** サーバーが利用者を確かめられない (トークンが無い・無効)。全部の計画に効くので、直るまで待つ (1 回だけ知らせる) */
  | { kind: "auth" }
  | { kind: "error"; file: string; message: string }
  /** 変更なしで「そろっている」と確かめた (表示には出さない。画面の裏方の状態の更新用) */
  | { kind: "checked"; file: string; revision: string | null; localHash: string | null };

/** 計画 1 つ分の見張りの状態 */
interface Watched {
  binding: Binding;
  /** 最後に見たファイルの印 (更新時刻と大きさ)。変わったら「手元が変わった」とみなす */
  seen: string;
  /** 最後に「そろった / 止まると判断した」ときに確かめた、手元の中身のハッシュ。今の中身がこれと違えば、まだ扱っていない変更がある */
  checkedHash: string | null | undefined;
  /** まとめている変更の、最初と最後の時点 (変更が無ければ null)。巻き戻らない時計の値 */
  firstChangeAt: number | null;
  lastChangeAt: number | null;
  /** サーバーが進んでいる (次の機会に同期する) */
  remoteAhead: boolean;
  /** 最後に確かめた、サーバーの最新の版 (まだ確かめていなければ undefined) */
  head: string | null | undefined;
  /** 止まっている: そのときに確かめた手元の中身と、サーバーの最新の版。どちらかが変わるまで、もう一度試さない */
  halted: { hash: string | null | undefined; head: string | null | undefined } | null;
  /** 最後に知らせた「止まった内容」の印 (同じ内容は繰り返し知らせない。サーバーが進んで選択肢や印が変わったら、もう一度知らせる) */
  notified: string | null;
  /** 状態を読めなくなっている (知らせ済み)。読めるようになるまで、この計画は同期しない */
  broken: boolean;
  /**
   * 最後に確かめた、同期の状態の世代番号 (自分の同期の後に覚え直す)。
   * これが変わっていたら、別の同期の実行 (別の端末画面からの結び直し・人の選択) が状態を進めている。手元もサーバーも変わっていなくても、もう一度判断する
   */
  generation: number | undefined;
}

/**
 * 見張る対象の指定
 *   all      = 設定フォルダの、このサーバーに結び付いた計画すべて (CLI の boxglow sync --watch だけが使う)
 *   selected = 指定したファイル (実体のパス) だけ。空なら 0 件 (全部にはならない)。画面の裏方が使う (開いていて有効にした計画だけ)
 */
export type WatchTargets = { mode: "all" } | { mode: "selected"; files: ReadonlySet<string> };

/** 常時の同期の指定 */
export interface WatchOptions {
  server: string;
  /** トークン。関数なら、同期のたびに解決し直す (画面の裏方: サインイン / サインアウトの変化を次の同期から使う) */
  token?: string | (() => string | undefined);
  /** 見張る対象 (省略時は all) */
  targets?: WatchTargets;
  /** 今の日時 (ms)。操作の記録に残す日時に使う。試験で差し替える */
  now?: () => number;
  /** 巻き戻らない時計 (ms)。待ち時間を測るのに使う。試験で差し替える (省略時は performance.now) */
  elapsed?: () => number;
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
/** ファイルの中身のハッシュ (無ければ null) */
function contentHash(file: string): string | null {
  try { return hashOf(readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * この端末で、指定したサーバーに結び付いている計画をすべて挙げる (各フォルダの state.json を調べる)
 * Input : server = サーバーの場所
 * Output: { states = 読めた結び付け (フォルダつき), unreadable = 状態を読めなかったフォルダ }
 */
export function bindingsFor(server: string): { states: { dir: string; state: StoredState }[]; unreadable: string[] } {
  const root = join(configDir(), "sync");
  let names: string[] = [];
  try { names = readdirSync(root); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const states: { dir: string; state: StoredState }[] = [], unreadable: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    if (!existsSync(join(dir, "state.json"))) continue;
    try { const state = new StateStore(dir).read(); if (state && state.binding.server === normalizeServer(server)) states.push({ dir, state }); }
    catch { unreadable.push(dir); }
  }
  return { states, unreadable };
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

/**
 * 止まった内容の印 (同じ内容を繰り返し知らせないために比べる)
 * 理由と、人が選ぶための印 (競合・初回の選択・削除の承認・復旧) を含める。サーバーが進んで印が変わったら、別の内容として扱う
 */
function haltKey(result: Extract<SyncResult, { status: "halted" }>): string {
  const h = result.halt as { reason: string; token?: string; approval?: string };
  // (結び直しの印は、止まった理由の中ではなく、見比べ (relink) に入っている。見比べる相手が変わったら、別の内容として知らせる)
  return JSON.stringify([h.reason, h.token ?? null, h.approval ?? null, result.recovery?.token ?? null, result.relink?.token ?? null]);
}

/** 常時の同期の本体。tick() を定期的に呼ぶ (呼ぶ間隔は 1 秒程度) */
export class SyncWatcher {
  private readonly wall: () => number;
  private readonly elapsed: () => number;
  private readonly random: () => number;
  private readonly watched = new Map<string, Watched>();
  /** この tick で読んだ、結び付けの状態 (ファイル → 状態)。同期が要るかの目安にだけ使う (実際の同期は、ロックの中で読み直す) */
  private states = new Map<string, StoredState>();
  /** 次にサーバーを確かめる時点 */
  private nextPollAt = 0;
  /** 変化が無かった確認の回数 (間隔を延ばす判断に使う) */
  private quietPolls = 0;
  /** 通信の失敗が続いている間の、やり直しの間隔と、次に通信してよい時点 */
  private retryMs = 0;
  private blockedUntil = 0;
  /** 最後に確かめた、サーバーの履歴の世代 */
  private epoch: string | null = null;
  /** 1 回分の処理が動いている間は、次の tick を重ねない */
  private running = false;

  constructor(private readonly options: WatchOptions) {
    this.wall = options.now ?? (() => Date.now());
    this.elapsed = options.elapsed ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.targets = options.targets ?? { mode: "all" };
    // 最初の tick で、すぐにサーバーを確かめる
    this.nextPollAt = this.elapsed();
  }

  /** 見張っている計画のファイルの一覧 (試験の確認用) */
  files(): string[] { return [...this.watched.keys()]; }

  /** 見張る対象 (省略時は all) */
  private targets: WatchTargets = { mode: "all" };
  /**
   * 見張る対象を替える (画面の裏方が、計画を開いた・閉じた・有効 / 無効にしたときに呼ぶ)
   * 外した計画は、次の tick から見張らない。実行中の 1 回の同期は、終わるまで待つ (途中で切らない)
   */
  setTargets(targets: WatchTargets): void { this.targets = targets; }
  /** ファイルが、今の対象に入っているか (実体のパスで比べる) */
  private targeted(file: string): boolean { return this.targets.mode === "all" || this.targets.files.has(file); }
  /** 同期のたびに解決し直すトークン */
  private token(): string | undefined { const t = this.options.token; return typeof t === "function" ? t() : t; }

  /**
   * その時点で行うべきことを 1 回分行う: 結び付けの一覧を取り直す → 手元の変更を調べる → (時点が来ていれば) サーバーを確かめる → 送る・受け取る
   * Output: なし (出来事は onEvent で知らせる)。例外は投げない (想定外の失敗も出来事として知らせ、次の tick でやり直す)
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.step();
    } catch (e) {
      // 想定外の失敗で、常時の同期の全体を止めない
      this.options.onEvent?.({ kind: "error", file: "", message: e instanceof Error ? e.message : String(e) });
    } finally {
      this.running = false;
    }
  }

  private async step(): Promise<void> {
    const at = this.elapsed();
    this.refreshBindings();
    // ---- 手元の変更を調べる (軽い確認: 更新時刻と大きさ) ----
    for (const w of this.watched.values()) {
      const sig = signature(w.binding.file);
      if (sig !== w.seen) { w.seen = sig; this.markChanged(w, at); }
    }
    if (at < this.blockedUntil) return;
    // ---- サーバーを確かめる (全部の計画を 1 回の要求で) ----
    if (at >= this.nextPollAt && this.watched.size > 0) {
      try {
        const { epoch, heads } = await fetchHeads({ server: this.options.server, token: this.token(), fetch: this.options.fetch });
        let changed = false;
        // 履歴の世代が変わったら、全部の計画を確かめ直す (版の文字列が同じでも、同じ履歴とはみなさない)
        const epochChanged = this.epoch !== null && this.epoch !== epoch;
        this.epoch = epoch;
        for (const w of this.watched.values()) {
          if (w.broken) continue;
          const entry = heads.get(w.binding.remoteId);
          const head = entry?.deleted ? "(deleted)" : entry?.revision ?? null;
          const base = this.states.get(w.binding.file)?.base?.revision ?? null;
          w.head = head;
          // サーバーの最新の版が、前回そろえた版と違えば、受け取りが要る (消された・まだ無い場合も、1 回の同期に任せて確かめる)。
          // 止まっている計画は、止まったときからサーバーが動いていなければ、もう一度試さない
          if (epochChanged || (head !== base && !(w.halted && w.halted.head === head))) { w.remoteAhead = true; changed = true; }
          // 中身のハッシュでも確かめる: 更新時刻と大きさが同じままの書き換えを、ここで拾う
          if (w.checkedHash !== undefined && contentHash(w.binding.file) !== w.checkedHash && w.firstChangeAt === null) { this.markChanged(w, at); changed = true; }
        }
        this.retryMs = 0;
        this.authNotified = false;
        this.quietPolls = changed ? 0 : this.quietPolls + 1;
        const interval = this.quietPolls >= IDLE_AFTER ? IDLE_POLL_MS : POLL_MS;
        // ばらつきを入れる (±10%)。たくさんの端末が、同じ瞬間に確かめに来ないように
        this.nextPollAt = at + interval * (0.9 + 0.2 * this.random());
      } catch (e) {
        if (!(e instanceof SyncNetworkError)) throw e;
        this.fail(at, e);
        return;
      }
    }
    // ---- 同期が要る計画を、1 つずつ同期する ----
    for (const w of this.watched.values()) {
      if (w.broken) continue;
      // (非同期の待ちの間に対象から外れた計画は、次の 1 回を始めない)
      if (!this.targeted(w.binding.file)) continue;
      const localDue = w.firstChangeAt !== null && w.lastChangeAt !== null
        && (at - w.lastChangeAt >= DEBOUNCE_MS || at - w.firstChangeAt >= MAX_WAIT_MS);
      if (!localDue && !w.remoteAhead) continue;
      // 止まっている計画は、手元の中身かサーバーが変わったときだけ、もう一度試す (同じ内容を繰り返し送らない)
      if (w.halted && !w.remoteAhead && contentHash(w.binding.file) === w.halted.hash) { w.firstChangeAt = w.lastChangeAt = null; continue; }
      const ok = await this.syncOne(w, at);
      if (!ok) return; // 通信できなかった。残りは、次に通信できるときに
    }
  }

  /** 「手元が変わった」と記録する (まとめる変更の最初と最後の時点) */
  private markChanged(w: Watched, at: number): void {
    w.firstChangeAt ??= at;
    w.lastChangeAt = at;
  }

  /** 結び付けの一覧を取り直す (常時の同期を始めた後で結び付けた計画も、次の tick から受け持つ) */
  private refreshBindings(): void {
    const { states, unreadable } = bindingsFor(this.options.server);
    // (対象に入っていない計画は、結び付いていても見張らない。対象から外れた計画は、ここで見張りから外す)
    this.states = new Map(states.filter((s) => this.targeted(s.state.binding.file)).map((s) => [s.state.binding.file, s.state] as const));
    for (const file of [...this.watched.keys()]) if (!this.targeted(file)) this.watched.delete(file);
    const broken = new Set(unreadable);
    for (const [file, w] of [...this.watched]) {
      const dir = bindingDir(file, this.options.server);
      if (this.states.has(file)) {
        // 読めるようになった (直された): もう一度、同期から始める
        if (w.broken) { w.broken = false; w.remoteAhead = true; w.halted = null; w.notified = null; }
        // 別の同期の実行が、状態を進めていた (結び直しを始めて途中で終わった・人の選択で進んだ、など): 手元もサーバーも同じままでも、もう一度判断する (R32-03)
        const generation = this.states.get(file)!.generation;
        // (止まっていた印は消さない: そろったときに「止まった状態が解けた」と知らせるのに使う)
        if (w.generation !== undefined && generation !== w.generation) w.remoteAhead = true;
        w.generation = generation;
        continue;
      }
      if (broken.has(dir)) {
        // 見張っていた計画の状態が読めなくなった: 黙って外さず、1 回だけ知らせて、直るまで同期しない (ほかの計画は続ける)
        if (!w.broken) { w.broken = true; this.options.onEvent?.({ kind: "error", file, message: "sync state is unreadable: " + dir }); }
        continue;
      }
      this.watched.delete(file); // 結び付けが無くなった
    }
    for (const [file, state] of this.states) {
      // 新しく見つけた計画は、最初に 1 回同期する (止まっている間の変更を取り込む)
      if (!this.watched.has(file)) {
        this.watched.set(file, { binding: state.binding, seen: signature(file), checkedHash: undefined, firstChangeAt: null, lastChangeAt: null
        , remoteAhead: true, head: undefined, halted: null, notified: null, broken: false, generation: state.generation });
      }
    }
  }

  /** 「利用者を確かめられない」を知らせ済みか (同じことを繰り返し知らせない) */
  private authNotified = false;

  /** 通信の失敗: やり直しの間隔を延ばす (最初 5 秒、倍々で 60 秒まで)。利用者を確かめられない場合は、1 回だけ知らせて、長い間隔で待つ */
  private fail(at: number, e: SyncNetworkError): void {
    if (e instanceof SyncAuthError) {
      this.retryMs = RETRY_MAX_MS;
      this.blockedUntil = at + this.retryMs;
      if (!this.authNotified) { this.authNotified = true; this.options.onEvent?.({ kind: "auth" }); }
      return;
    }
    this.backOff(at, e.message);
  }

  /** 通信の失敗: やり直しの間隔を延ばす (最初 5 秒、倍々で 60 秒まで) */
  private backOff(at: number, message: string): void {
    this.retryMs = this.retryMs === 0 ? RETRY_MS : Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.blockedUntil = at + this.retryMs;
    this.options.onEvent?.({ kind: "network", message, retryInMs: this.retryMs });
  }

  /**
   * 計画 1 つを同期する
   * Output: 通信できたら true (止まった・ほかが動いていた場合も true)。通信できなかったら false
   */
  private async syncOne(w: Watched, at: number): Promise<boolean> {
    const file = w.binding.file;
    let result: SyncResult;
    try {
      result = await syncOnce({ file, server: this.options.server, token: this.token(), fetch: this.options.fetch, now: () => new Date(this.wall()) });
      // 自分の同期が処理した状態の世代番号を覚え直す (自分で進めた分を「別の実行が進めた」と数えて、同期を繰り返さないように)。
      // 値は、同期がロックの中で確かめたもの (結果に入っている)。ロックを外した後に読み直すと、その隙に別の実行が進めた分を「自分が処理した」と
      // 取り違えて、その実行の続き (結び直しなど) を見落とす (R33-01)
      if (result.stateGeneration !== undefined) w.generation = result.stateGeneration;
    } catch (e) {
      // (例外で終わった同期も、ロックの中で最後に確かめた世代番号を例外に添えてくる。無ければ変えず、次の一覧の取り直しに任せる)
      const generation = (e as { stateGeneration?: number }).stateGeneration;
      if (generation !== undefined) w.generation = generation;
      if (e instanceof SyncNetworkError) { this.fail(at, e); return false; }
      // 状態が読めないなど: この計画は止めておき、ほかの計画は続ける
      w.halted = { hash: contentHash(file), head: w.head }; w.remoteAhead = false; w.firstChangeAt = w.lastChangeAt = null;
      const message = e instanceof Error ? e.message : String(e);
      if (w.notified !== message) { w.notified = message; this.options.onEvent?.({ kind: "error", file, message }); }
      return true;
    }
    // ほかの同期・書き込みが動いている: 何も確かめられていないので、変更の記録は残したまま、次の tick でやり直す
    if (result.status === "busy") return true;
    // この同期が読んだ・書いた後の状態を取り直す (次の「サーバーが進んだか」の目安に使う)
    try { const fresh = new StateStore(bindingDir(file, this.options.server)).read(); if (fresh) this.states.set(file, fresh); } catch { /* 次の tick の取り直しで知らせる */ }
    // 同期が「確かめた」手元の中身と、今のファイルの中身を比べる。
    // 同期の最後の通信を待っている間に入った編集は、まだ扱われていない。更新時刻を取り直すだけで「送った」ことにしない
    w.seen = signature(file);
    w.checkedHash = result.localHash;
    w.firstChangeAt = w.lastChangeAt = null;
    w.remoteAhead = false;
    if (result.localHash !== undefined && contentHash(file) !== result.localHash) this.markChanged(w, at);
    if (result.status === "synced") {
      // 止まっていた計画がそろったときは、送受信が無くても知らせる (止まったままではないことが分かるように)
      const resumed = w.halted !== null;
      w.halted = null; w.notified = null;
      if (result.pulled || result.pushed || resumed) this.options.onEvent?.({ kind: "synced", file, pulled: result.pulled, pushed: result.pushed, revision: result.revision, localHash: result.localHash });
      // (変更なしの成功は知らせないが、状態の確認には使えるように、別の出来事で伝える)
      else this.options.onEvent?.({ kind: "checked", file, revision: result.revision, localHash: result.localHash });
      return true;
    }
    // 止まった: 同じ内容 (理由と、選ぶための印が同じ) は繰り返し知らせない。サーバーが進んで選択肢が変わったら、もう一度知らせる
    w.halted = { hash: result.localHash, head: w.head };
    const key = haltKey(result);
    if (w.notified !== key) { w.notified = key; this.options.onEvent?.({ kind: "halted", file, result }); }
    return true;
  }
}
