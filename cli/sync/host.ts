/**
 * 同期の裏方 (SyncHost): 画面 (boxglow serve の画面・VS Code の拡張の画面) から同期を使うための、Node 側の 1 つの入口
 *   - 常時の同期 (SyncWatcher) を所有し、開いていて有効にした計画だけを見張る (閉じた計画・有効にしていない計画は触らない)
 *   - 状態 (SyncStatus) を 1 つの構造にまとめて画面へ知らせ、操作 (HostAction) を受ける
 *   - サインイン (GitHub の端末向けの手順) / サインアウト、確認が要る場面の選択 (CLI と同じ印・同じ経路)
 *   - 資格情報は同期のたびに解決し直す (別の CLI の login / logout を次の同期から使う)。トークンの値は、状態にもログにも出さない
 * serve と拡張は、この裏方と画面の間の通信路 (HTTP + SSE / postMessage) を変換するだけ。
 * 常駐の同期の所有者は、設定フォルダ × サーバーにつき 1 つ (CLI の boxglow sync --watch と同じロック lockWatch)。別のプロセスが所有していれば、
 * 「別のプロセスが受け持っている」と表示して、自分が制御できるようには見せない。
 * 設計: docs/private/SYNC_GUI_DESIGN.md (第 4 版)
 */
import { listTrash, previewLifecycle, commitLifecycle, type LifecyclePreview } from "./lifecycle";
import { isDefaultSyncServer } from "./server-policy";
import { parseConflictResolution, type ConflictResolution } from "../../src/model/conflict-groups";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { APP_VERSION } from "../../src/model/version";
import { t } from "../../src/i18n/core";
import { inspectLock } from "../file-store";
import { syncOnce, SyncConfigurationError, SyncAuthError, SyncNetworkError, SyncRejectedError, type SyncResult } from "./client";
import { haltView, type SyncAction } from "./command";
import { credentialsPath, readCredentials, resolveToken } from "./credentials";
import { runGoogleLogin, runLogin, runLogout, serverProblem } from "./login";
import { bindingsOf, hashOf, normalizeServer, realFile, SyncStateUnreadable } from "./state-store";
import { lockWatch, SyncWatcher, type WatchEvent } from "./watch";

import type { HostAction, SyncStatus } from "../../src/sync/status";
export type { HostAction, SyncStatus };

/** 裏方の指定 */
export interface HostOptions {
  server: string;
  /** 呼出元が環境トークンを追加で禁止する場合はfalse。URLの共通規則が常に優先する。 */
  allowEnvironmentToken?: boolean;
  /** 入力: 元ファイルと提案名。出力: 人が選んだ未使用の保存先、取消はnull。任意パスは画面から受け取らない。 */
  chooseDestination?: (file:string, name?:string) => Promise<string|null>;
  destinationPicker?: "dialog" | "sibling";
  /** 新しい保存先を開く。serveでは別の画面へのURL、拡張ではopenWithを使う。 */
  onOpened?: (file:string) => Promise<string|void>;
  /** 明示有効化をホスト設定へ保存する。計画JSONには書かない。 */
  onEnabled?: (file:string, enabled:boolean) => void;
  /** 状態が変わったときに呼ぶ (画面へ知らせる) */
  onStatus?: (status: SyncStatus) => void;
  /** 通信の関数 (試験で差し替える) */
  fetch?: typeof fetch;
  /** 時計 (試験で差し替える) */
  now?: () => number;
  elapsed?: () => number;
  random?: () => number;
  /** 動いている OS (試験で差し替える。省略時は process.platform) */
  platform?: string;
  /** サインインの待ち時間の関数 (試験で差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** 端末の名前 (サインインのときにサーバーへ伝える) */
  deviceName?: string;
}

/** 進行中のサインイン (中止の合図つき) */
interface SignIn { owner?: { file: string; operationId?: string }; provider: "github" | "google"; code?: SyncStatus["signIn"]; cancelled: boolean; done: Promise<number> }

/** 人が選べる操作に付ける、選択 ID の中身 (対象・表示した操作・同期の状態の世代・資格情報の世代を結び付ける) */
interface Choice { action: SyncAction; file: string; server: string; remoteId: string; generation: number | null; credentials: string }

/** 保存先選択の安全な利用者向けエラー。外部サーバーの例外文とは区別する。 */
export class SyncDestinationError extends Error {}

export class SyncHost {
  readonly session = randomUUID();
  private seq = 0;
  private readonly server: string;
  private readonly doFetch: typeof fetch;
  private readonly wall: () => number;
  /** 開いているファイル (実体のパス) → 参照数 */
  private readonly open = new Map<string, number>();
  /** 有効にしたファイル (実体のパス) */
  private readonly enabled = new Set<string>();
  /** 計画ごとの、最後の同期の結果 */
  private readonly results = new Map<string, { result: SyncResult | { status: "error"; error: unknown }; at: number; credentials: string }>();
  /** 人の選択で実際に作った控え。後続の監視結果で消さず、このホストの同じ資格情報でだけ表示する。 */
  private readonly localBackups = new Map<string, { path: string; credentials: string }>();
  private watcher: SyncWatcher | null = null;
  private unlockWatch: (() => void) | null = null;
  private owner: SyncStatus["owner"] = "none";
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  /** 進行中のサインイン (中止の合図つき) */
  private signingIn: SignIn | null = null;
  /** 確かめた利用者 (資格情報の世代ごと) */
  private account: { credentials: string; account?: SyncStatus["credentials"]["account"]; problem?: string } | null = null;
  /** 選択 ID → 中身 */
  private readonly choices = new Map<string, Choice>();
  private busy = 0;

  constructor(private readonly options: HostOptions) {
    this.server = normalizeServer(options.server);
    this.doFetch = options.fetch ?? fetch;
    this.wall = options.now ?? (() => Date.now());
  }

  /** この環境で、サインインを保存できるか */
  get support(): SyncStatus["support"] { return (this.options.platform ?? process.platform) === "win32" ? "unsupported-platform" : "ok"; }

  /** 送り先の選択根拠をすべての認証処理で維持する。 */
  private resolveCredentials() { return resolveToken(this.server, this.options.allowEnvironmentToken); }

  /**
   * 資格情報の世代: 出どころと、保存ファイルの印 (更新時刻・大きさ・内容のハッシュ)。値そのものは含めない。
   * 別の CLI の login / logout で変わる。要求ごとに世代を控え、違う世代の遅い応答を状態に採用しない
   */
  private credentialsGeneration(): string {
    const resolved = this.resolveCredentials();
    if (resolved?.source === "env") return "env:" + hashOf(resolved.token).slice(0, 16);
    const path = credentialsPath(this.server);
    try { const st = statSync(path); return `stored:${st.mtimeMs}:${st.size}:${hashOf(readFileSync(path, "utf8")).slice(0, 16)}`; } catch { return "none"; }
  }

  // ---------------------------------------------------------------- 開く・閉じる・有効 / 無効

  /** 計画のファイルを開いた (画面が 1 つ増えた)。同じファイルの複数の画面は参照数で数える */
  openFile(file: string): void {
    const real = realFile(file);
    this.open.set(real, (this.open.get(real) ?? 0) + 1);
    if (this.enabled.has(real)) this.applyTargets();
    this.emit();
  }
  /** 計画のファイルを閉じた。最後の画面が閉じたら、見張りから外す (実行中の 1 回は、終わるまで待つ) */
  closeFile(file: string): void {
    const real = realFile(file);
    const n = (this.open.get(real) ?? 1) - 1;
    if (n <= 0) this.open.delete(real); else this.open.set(real, n);
    this.applyTargets();
    this.emit();
  }
  /** この計画の同期を有効にする (所有権を取り、見張りを始める) */
  enable(file: string): void {
    // 停止・サインアウトの途中と、停止の後は、新しい同期を始めない (R41-04)
    if (this.stopping || this.stopped) { this.message = t("同期を止めています。終わってから、もう一度操作してください"); this.emit(); return; }
    const real = realFile(file);
    this.enabled.add(real);
    this.rememberSuccessfulSync(real);
    this.ensureWatcher();
    this.applyTargets();
    this.emit();
  }
  /** 成功した世代だけ再開設定を記憶する。失敗・比較待ちでは新たに保存しない。 */
  private rememberSuccessfulSync(file: string): void {
    const last = this.results.get(file);
    if (this.enabled.has(file) && last?.result.status === "synced" && last.credentials === this.credentialsGeneration() && !this.remembered.has(file)) {
      this.options.onEnabled?.(file, true);
      this.remembered.add(file);
    }
  }
  private readonly remembered = new Set<string>();
  /** この計画の同期を無効にする (次の 1 回を始めない。対象が無くなったら、見張りを止めて所有権を手放す) */
  disable(file: string): void {
    this.enabled.delete(realFile(file));
    this.remembered.delete(realFile(file));
    this.options.onEnabled?.(realFile(file), false);
    this.applyTargets();
    this.emit();
  }
  /** 有効で、かつ開いている計画 = 見張る対象 */
  private targets(): Set<string> { return new Set([...this.enabled].filter((f) => this.open.has(f))); }
  private applyTargets(): void {
    const files = this.targets();
    if (files.size === 0 || this.stopping || this.stopped) { void this.releaseWatcher(); return; }
    // 停止の途中なら、停止が終わって所有権を手放してから、改めて取り直す (停止と再開を直列にする)
    if (this.releasing) { void this.releasing.then(() => this.applyTargets()); return; }
    this.ensureWatcher();
    this.watcher?.setTargets({ mode: "selected", files });
  }

  // ---------------------------------------------------------------- 常駐の同期の所有権

  private ensureWatcher(): void {
    if (this.watcher || this.targets().size === 0 || this.stopping || this.stopped) return;
    const lock = lockWatch(this.server);
    if (!lock.unlock) {
      // 別のプロセスが所有している (CLI の --watch か、別の裏方)。持ち主を判定できなければ、断定しない
      // (lockWatch は、持ち主が終了していると確かめられたロックを既に回収している。ここで取れないのは、生きている持ち主がいるか、判定できないか)
      const info = inspectLock(lock.path);
      this.owner = info?.verdict === "live" ? "external" : "unknown";
      return;
    }
    this.unlockWatch = lock.unlock;
    this.owner = "self";
    // (見張りを始めた時点の資格情報の世代。ここから変わったら、tick が画面に知らせる)
    this.lastCredentials = this.credentialsGeneration();
    this.watcher = new SyncWatcher({
      server: this.server
      // トークンと資格情報の世代を、1 回の同期の始めに一緒に解決する (出来事に世代が付く。R39-03)
    , credentials: () => ({ token: this.resolveCredentials()?.token, tag: this.credentialsGeneration() })
    , targets: { mode: "selected", files: this.targets() }
    , fetch: this.doFetch, now: this.options.now, elapsed: this.options.elapsed, random: this.options.random
    , onEvent: (e) => this.onEvent(e)
    });
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }
  /**
   * 見張りを止めて、所有権を手放す (R39-01): 新しい実行を止める → 実行中の 1 回 (保持している Promise) を待つ → この見張りが取ったロックを外す。
   * Output: 停止が終わったら解決する Promise (stop / signOut はこれを待つ)。止める見張りが無ければ、進行中の停止 (あれば) を返す
   */
  private releaseWatcher(): Promise<void> {
    if (!this.watcher) return this.releasing ?? Promise.resolve();
    const w = this.watcher;
    const unlock = this.unlockWatch;          // (この見張りが取ったロック。後から取り直したものと取り違えない)
    this.watcher = null; this.unlockWatch = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    w.setTargets({ mode: "selected", files: new Set() });
    const running = this.running;
    const manual = [...this.manual];
    const release = (async () => {
      // 常駐の 1 回と、始めた手動の操作の全部が終わるのを待つ (R40-02)
      await Promise.allSettled([running, ...manual]);
      unlock?.();
      if (this.owner === "self" && !this.watcher) this.owner = "none";
    })();
    const releasing = release.finally(() => { if (this.releasing === releasing) this.releasing = null; this.emit(); });
    this.releasing = releasing;
    return releasing;
  }
  /** 進行中の停止 (終わるまで、新しい所有権を取らない) */
  private releasing: Promise<void> | null = null;
  /** 実行中の 1 回の見張りの処理 (停止はこれを待つ) */
  private running: Promise<void> | null = null;
  /** 資格情報の世代 (前の tick で見たもの。変わったら、全部を確かめ直す) */
  private lastCredentials: string | null = null;
  /** 1 秒ごと: 一時停止中は見張りだけ (同期しない)。実行中の同期の間は「同期中」と見せる */
  async tick(): Promise<void> {
    if (!this.watcher) return;
    if (this.running) return this.running;
    const w = this.watcher;
    // 資格情報が変わった (別の CLI の login / logout): 止まっていた計画も含めて確かめ直し、画面に知らせる (R39-03)。
    // 変化の検知と画面への知らせは、送ってよいかの判定より先に行う (別の CLI で消されたときも、画面を「未サインイン」にする。R46-02)。
    // 一時停止中も行う (止めるのは計画の送受信だけ。利用者の表示は今の資格情報に合わせる。R47-02)。
    // (recheck は「次の機会に確かめ直す」印を付けるだけで、通信はしない)
    const credentials = this.credentialsGeneration();
    if (this.lastCredentials !== null && this.lastCredentials !== credentials) { w.recheck(); this.account = null; this.emit(); }
    this.lastCredentials = credentials;
    // 一時停止中は、計画の同期をしない (再開すると、次の tick から)
    if (this.paused) return;
    // (資格情報が無い間は、見張りも同期しない。サインインすれば、次の tick から)
    if (!this.resolveCredentials()) return;
    this.busy++; this.emit();
    this.running = w.tick().finally(() => { this.running = null; this.busy--; this.emit(); });
    return this.running;
  }
  /** 裏方を止める (プロセスの終了・最後の画面が閉じた後)。停止が終わってから解決する */
  async stop(): Promise<void> {
    if (this.signingIn) this.signingIn.cancelled = true;
    this.stopped = true;
    await this.releaseWatcher();
    // (見張りが無かった場合も、始めた手動の操作の終わりを待つ)
    await Promise.allSettled([...this.manual]);
  }

  private onEvent(e: WatchEvent): void {
    // 出来事の資格情報の世代 (同期の始めに解決したもの)。今の世代と違う結果は、状態に採用しない (遅れて終わった古い同期。R39-03)
    const current = this.credentialsGeneration();
    const credentials = "tag" in e && e.tag !== undefined ? e.tag : current;
    if (credentials !== current) { this.watcher?.recheck(); this.emit(); return; }
    // 成功したら、この世代の認証の失敗は解ける
    if (e.kind === "synced" || e.kind === "checked" || e.kind === "halted" || e.kind === "authOk") { if (this.authProblem === credentials) this.authProblem = null; }
    if (e.kind === "authOk") { this.emit(); return; }
    if (e.kind === "synced" || e.kind === "checked") this.results.set(e.file, { result: { status: "synced", pulled: e.kind === "synced" ? e.pulled : 0, pushed: e.kind === "synced" ? e.pushed : 0, edited: 0, revision: e.revision, localHash: e.localHash }, at: this.wall(), credentials });
    else if (e.kind === "halted") this.results.set(e.file, { result: e.result, at: this.wall(), credentials });
    else if (e.kind === "error") this.results.set(e.file, { result: { status: "error", error: new Error(e.message) }, at: this.wall(), credentials });
    // 認証の失敗: この資格情報の世代について、成功の結果より優先して表示する (R39-10)
    else if (e.kind === "auth") this.authProblem = credentials;
    else if (e.kind === "configuration") { this.network = null; }
    else if (e.kind === "network") this.network = { message: e.message, at: this.wall() };
    if (e.kind === "synced" || e.kind === "checked") this.rememberSuccessfulSync(e.file);
    this.emit();
  }
  private network: { message: string; at: number } | null = null;
  /** 認証の失敗が起きた資格情報の世代 (今の世代と同じ間だけ、問題として表示する) */
  private authProblem: string | null = null;

  // ---------------------------------------------------------------- サインイン / サインアウト

  /** サインインを始める (GitHub の端末向けの手順)。コードは状態の signIn に出る。終わると状態が変わる */
  signIn(provider: "github" | "google", file?: string): void {
    if (this.signingIn || this.support !== "ok") { this.emit(); return; }
    const entry: SignIn = { ...(file ? { owner: { file, operationId: this.startups.get(file)?.operationId } } : {}), provider, cancelled: false, done: Promise.resolve(1) };
    this.signingIn = entry;
    const lines: string[] = [];
    const common = { server: this.server, allowEnvironmentToken: this.options.allowEnvironmentToken, out: (line: string) => lines.push(line), fetch: this.doFetch, sleep: this.options.sleep, deviceName: this.options.deviceName, cancelled: () => entry.cancelled };
    entry.done = (provider === "google"
      ? runGoogleLogin({ ...common, onUrl: (info) => { entry.code = { provider: "google", ...info }; this.emit(); } })
      : runLogin({ ...common, onCode: (code) => { entry.code = { provider: "github", ...code }; this.emit(); } })
    ).then((code) => {
      if (this.signingIn === entry) { this.signingIn = null; if (code !== 0 && !entry.cancelled) this.message = lines.filter((l) => !l.startsWith("  ")).at(-1); else this.message = undefined; }
      this.account = null;
      if (code !== 0 && !entry.cancelled) {
        for (const op of this.startups.values()) {
          if (op.stage === "signin") op.error = t("サインインできませんでした。もう一度サインインするか、中止してください。");
        }
      }
      this.emit();
      if (code === 0 && !entry.cancelled) for (const [file,op] of this.startups) {
        if (op.stage === "signin") void this.continueStart(file,op.operationId).catch(() => { op.stage = "choose"; op.error = t("開始できませんでした。接続とサインインを確認して再試行してください。"); this.emit(); });
      }
      return code;
    });
    this.emit();
  }
  /** 進行中のサインインを中止する (遅れて許可されても、トークンは保存しない) */
  cancelSignIn(): void {
    if (this.signingIn) this.signingIn.cancelled = true;
    this.emit();
  }
  /**
   * サインアウト: 進行中のサインインを無効にし、所有している常駐の同期を止めてから、保存済みの資格情報を失効・削除する。
   * 環境変数のトークンは対象にしない (残っていれば、状態にそう出る)
   */
  signOut(): Promise<void> {
    // 重ねて呼ばれたら、進行中のサインアウトの完了を待つだけ (停止の印は、そのサインアウトだけが外す。R42-01)
    if (this.signingOut) return this.signingOut;
    const run = this.signOutOnce().finally(() => { if (this.signingOut === run) this.signingOut = null; });
    this.signingOut = run;
    return run;
  }
  /** 進行中のサインアウト */
  private signingOut: Promise<void> | null = null;
  private async signOutOnce(): Promise<void> {
    // 停止・失効・資格情報の削除・結果の片付けまでを、1 つの排他的な期間にする (この間は、有効化・手動の操作・見張りの取り直しをしない。R41-04)
    this.stopping = true;
    try {
      this.cancelSignIn();
      for (const file of this.enabled) this.options.onEnabled?.(file,false);
      this.enabled.clear();
      this.remembered.clear();
      this.startups.clear();
      // 常駐の同期と、始めた手動の操作が終わってから、資格情報を失効させる (R39-01 / R40-02)
      await this.releaseWatcher();
      await Promise.allSettled([...this.manual]);
      const lines: string[] = [];
      await runLogout({ server: this.server, allowEnvironmentToken: this.options.allowEnvironmentToken, out: (line) => lines.push(line), fetch: this.doFetch });
      this.account = null;
      this.results.clear();
      this.message = lines.at(-1);
    } finally {
      this.stopping = false;
      this.emit();
    }
  }
  private message: string | undefined;

  /** 確かめた利用者を読み直す (資格情報の世代が変わっていたら、/v1/me で確かめる) */
  private async refreshAccount(): Promise<void> {
    const credentials = this.credentialsGeneration();
    if (this.account?.credentials === credentials) return;
    if (!this.enabled.size && !this.startups.size && !this.signingIn) return;
    if (!this.resolveCredentials()) { this.account = { credentials }; return; }
    // 資格情報を送ってよい場所か (https、または手元の http)。サインイン・同期と同じ制約を、利用者の確認にもかける (R46-01)
    const unsafe = serverProblem(this.server);
    if (unsafe) { this.account = { credentials, problem: unsafe }; return; }
    // (/v1/me を JSON で読む。whoami の表示の文を読み取ると、言語や ID の形で読めなくなる)
    type Me = { account?: unknown; login?: unknown; signedInWith?: unknown };
    const read = async (): Promise<{ me: Me | null; problem?: string }> => {
      try {
        const res = await this.doFetch(`${this.server}/v1/me`, { headers: { authorization: `Bearer ${this.resolveCredentials()!.token}`, "x-boxglow-version": APP_VERSION }, redirect: "error" });
        return res.ok ? { me: await res.json() as Me } : { me: null, problem: `HTTP ${res.status}` };
      } catch (e) { return { me: null, problem: e instanceof Error ? e.message : String(e) }; }
    };
    const { me, problem } = await read();
    // (遅い応答: その間に資格情報が変わっていたら、採用しない)
    if (this.credentialsGeneration() !== credentials) return;
    if (!me || typeof me.account !== "string") { this.account = { credentials, problem: problem ?? "me" }; return; }
    const signedInWith = me.signedInWith === "google" || me.signedInWith === "github" ? me.signedInWith : "github";
    this.account = { credentials, account: { accountId: me.account, display: typeof me.login === "string" && me.login ? me.login : me.account, signedInWith } };
  }

  /** 計画ごとの開始操作。IDは画面の古いクリックを拒否するための印。認証情報は入れない。 */
  private readonly startups = new Map<string, NonNullable<SyncStatus["startup"]> & {
    credentials?: string;
  }>();
  /** 入力: 開いている計画。出力: 開始選択の状態。ここでは送受信も有効化もしない。 */
  private beginSync(file: string): void {
    if (this.stopping || this.stopped || this.startups.get(file)?.stage === "working")
      return;
    this.startups.set(file, { operationId: randomUUID(), stage: "choose" });
    this.emit();
  }
  /** 入力: 操作IDと意図。出力: 必要なサインイン、一覧、または新規配置へ進む。 */
  private async continueStart(file: string, operationId: string, intent?: "new" | "existing"): Promise<void> {
    const op = this.startups.get(file);
    if (!op || op.operationId !== operationId || op.stage === "working" || this.stopping || this.stopped)
      return;
    if (intent)
      op.intent = intent;
    if (!op.intent)
      return;
    const unsafe = serverProblem(this.server);
    if (unsafe) {
      op.error = unsafe;
      op.stage = "choose";
      this.emit();
      return;
    }
    if (!this.resolveCredentials()) {
      op.stage = "signin";
      this.emit();
      return;
    }
    op.credentials = this.credentialsGeneration();
    if (op.intent === "existing") {
      await this.listProjects(file, operationId);
      return;
    }
    op.stage = "working";
    op.error = undefined;
    this.emit();
    // syncOnceが送信前に結び付けと操作を保存するので、再クリック・再起動も同じ計画へ再試行する。
    await this.syncFile(file, {});
    if (this.startups.get(file) !== op || this.stopped || this.stopping) return;
    if (op.credentials !== this.credentialsGeneration()) {
      op.stage = "choose";
      op.error = t("表示したときから、状態が変わっています。選び直してください");
      this.emit();
      return;
    }
    const result = this.results.get(file)?.result;
    if (result && result.status !== "error" && result.status !== "busy") {
      this.enable(file);
      this.startups.delete(file);
    }
    else {
      op.stage = "choose";
      op.error = t("開始できませんでした。接続とサインインを確認して再試行してください。");
    }
    this.emit();
  }
  /** 入力: 対象ファイル・操作ID・ページのcursor。出力: 公開メタデータをstartupへ設定する。
   * 一覧は認証済みの同じ送り先だけ。遅い応答は操作IDと資格情報世代で捨てる。 */
  private async listProjects(file: string, operationId: string, cursor?: string): Promise<void> {
    const op = this.startups.get(file), credentials = this.credentialsGeneration();
    if (!op || op.operationId !== operationId || op.stage === "working" || this.stopped || this.stopping)
      return;
    const token = this.resolveCredentials()?.token;
    if (!token) {
      op.stage = "signin";
      this.emit();
      return;
    }
    const unsafe = serverProblem(this.server);
    if (unsafe) {
      op.error = unsafe;
      op.stage = "list";
      this.emit();
      return;
    }
    op.stage = "working";
    op.error = undefined;
    op.credentials = credentials;
    this.emit();
    try {
      const res = await this.doFetch(`${this.server}/v1/projects?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { authorization: `Bearer ${token}` }, redirect: "error" });
      if (this.startups.get(file) !== op || credentials !== this.credentialsGeneration())
        return;
      if ([404, 405, 501].includes(res.status)) {
        op.unsupported = true;
        op.projects = [];
        return;
      }
      if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as {
        projects?: unknown;
        nextCursor?: unknown;
      };
      if (this.startups.get(file) !== op || credentials !== this.credentialsGeneration())
        return;
      // 旧サーバーはqueryを無視して配列を返す。本文を取りに行かずID入力へ戻す。
      if (Array.isArray(body)) {
        op.unsupported = true;
        op.projects = [];
        return;
      }
      if (!Array.isArray(body.projects) || body.projects.length > 100 || !(body.nextCursor === null || typeof body.nextCursor === "string" && body.nextCursor.length <= 256))
        throw new Error("Invalid project list");
      const projects = body.projects.map((p: Record<string, unknown>) => {
        if (!p || typeof p.id !== "string" || !p.id || p.id.length > 256 || typeof p.name !== "string" || typeof p.revision !== "string" || typeof p.bytes !== "number" || !Number.isSafeInteger(p.bytes) || p.bytes < 0)
          throw new Error("Invalid project list");
        return { id: p.id, name: p.name.slice(0, 512), revision: p.revision, bytes: p.bytes, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null };
      });
      op.projects = projects;
      op.nextCursor = body.nextCursor as string | null;
      op.credentials = credentials;
      op.unsupported = false;
    }
    catch {
      if (this.startups.get(file) === op)
        op.error = t("計画一覧を取得できませんでした。接続とサインインを確認してください。");
    }
    finally {
      if (this.startups.get(file) === op) {
        if (credentials !== this.credentialsGeneration()) {
          op.projects = [];
          op.nextCursor = null;
          op.credentials = undefined;
          op.error = t("表示したときから、状態が変わっています。選び直してください");
        }
        op.stage = "list";
        this.emit();
      }
    }
  }
  /** 入力: 一覧の操作ID、計画ID、保存先の種別。出力: 現在の比較、または新しい計画の画面。
  * 新規保存先はホストが選び、存在確認と同期内のCASの両方で上書きを防ぐ。 */
  private async openProject(file: string, action: Extract<HostAction, {
    kind: "openProject";
  }>): Promise<void> {
    const op = this.startups.get(file);
    if (!op || op.operationId !== action.operationId || op.stage !== "list" || this.stopping || this.stopped)
      return;
    if (op.credentials !== this.credentialsGeneration()) {
      op.error = t("表示したときから、状態が変わっています。選び直してください");
      this.emit();
      return;
    }
    op.stage = "working";
    op.error = undefined;
    this.emit();
    try {
      if (serverProblem(this.server))
        throw new Error("Invalid server");
      const destination = action.destination === "new"
        ? await this.options.chooseDestination?.(file, action.name) : file;
      if (!destination) {
        op.stage = "list";
        this.emit();
        return;
      }
      const target = realFile(destination);
      if (action.destination === "new" && (existsSync(target) || bindingsOf(target).bindings.length))
        throw new SyncDestinationError(t("保存先には既にファイルがあります。別の名前を選んでください。"));
      if (this.startups.get(file) !== op || this.stopping || this.stopped) return;
      if (op.credentials !== this.credentialsGeneration()) throw new Error("Credentials changed");
      // 不存在のIDを作成に転じない条件を同期のロック内でも検証する。
      await this.syncFile(target, { remoteId: action.projectId, requireRemote: true });
      if (this.startups.get(file) !== op || this.stopping || this.stopped) return;
      if (op.credentials !== this.credentialsGeneration()) throw new Error("Credentials changed");
      const result = this.results.get(target)?.result;
      if (!result || result.status === "error" || result.status === "busy")
        throw new Error("Not opened");
      if (target === file) {
        this.enable(file);
        this.startups.delete(file);
      }
      else {
        if (result.status !== "synced")
          throw new Error("Needs review");
        this.options.onEnabled?.(target, true);
        const url = await this.options.onOpened?.(target);
        op.stage = "opened";
        op.opened = { path: target, ...(url ? { url } : {}) };
      }
    }
    catch (e) {
      op.stage = "list";
      op.error = e instanceof SyncDestinationError ? e.message : t("計画を開けませんでした。未使用の保存先を選び、接続と現在の一覧を確認してください。");
    }
    this.emit();
  }

  /** 確認内容はホストが保持。画面から版・送り先・復元先を受け取らない。 */
  private readonly lifecycles = new Map<string,{state:NonNullable<SyncStatus["lifecycle"]>;credentials:string;preview?:LifecyclePreview}>();
  private async lifecycleAction(file:string,action:HostAction):Promise<void> {
    if(this.stopping || this.stopped || !this.open.has(file)) return;
    const old=this.lifecycles.get(file);
    if(old?.state.busy) return;
    if(action.kind === "cancelLifecycle") {this.lifecycles.delete(file);this.emit();return;}
    const credentials=this.credentialsGeneration();
    if(action.kind === "confirmLifecycle" && (!old?.preview || old.state.choiceId !== action.choiceId || old.credentials !== credentials)) {
      this.lifecycles.delete(file);this.message=t("表示したときから、状態が変わっています。選び直してください");this.emit();return;
    }
    const entry=action.kind === "confirmLifecycle" ? old! : {state:{choiceId:randomUUID(),busy:false} as NonNullable<SyncStatus["lifecycle"]>,credentials,preview:undefined as LifecyclePreview|undefined};
    this.lifecycles.set(file,entry);entry.state.busy=true;entry.state.error=undefined;this.emit();
    const o={server:this.server,fetch:this.doFetch,allowEnvironmentToken:this.options.allowEnvironmentToken};
    try {
      if(action.kind === "listTrash") Object.assign(entry.state,await listTrash(o,action.cursor));
      if(action.kind === "previewDelete" || action.kind === "previewRestore") {
        entry.preview=await previewLifecycle(o,action.kind === "previewDelete" ? "delete" : "restore",action.projectId);
        const {kind,id,name,account,revision,expiresAt,targetId}=entry.preview;
        entry.state.preview={kind,id,name,account,revision,expiresAt,targetId};
      }
      if(action.kind === "confirmLifecycle") {
        const deletedId=entry.preview!.id;
        const result=await commitLifecycle(o,entry.preview!);
        entry.state.preview=undefined;entry.preview=undefined;
        entry.state.message=result.kind === "restored" ? t("復元しました。元のファイルで「今すぐ同期」から結び直すか、一覧から新しいファイルとして開けます。")+" "+result.projectId : t("サーバーから削除しました。手元のファイルは残っています。")+" "+result.expiresAt;
        // 開いた計画の同期結果を取り直す。削除の410は既存の停止理由となり、同じIDを作り直さない。
        if(bindingsOf(file).bindings.some(b=>b.server === this.server && b.remoteId === deletedId)) await this.syncFile(file,{});
      }
    } catch(e) { entry.state.error=e instanceof Error ? e.message : String(e); }
    finally {
      entry.state.busy=false;
      if(credentials !== this.credentialsGeneration()) this.lifecycles.delete(file);
      this.emit();
    }
  }

  // ---------------------------------------------------------------- 画面からの操作

  /** 操作を受ける (serve の POST /api/sync、拡張の sync-action)。結果は状態で返す */
  async act(file: string | null, action: HostAction): Promise<SyncStatus> {
    const real = file ? realFile(file) : null;
    if (["listTrash","cancelLifecycle","previewDelete","previewRestore","confirmLifecycle"].includes(action.kind)) {
      if(real) { const work=this.lifecycleAction(real,action);this.manual.add(work);try {await work;} finally {this.manual.delete(work);} }
      return this.status(file);
    }
    switch (action.kind) {
      case "beginSync": if (real) this.beginSync(real); break;
      case "cancelBegin":
        if (real && this.startups.get(real)?.stage !== "working") {
          const op = this.startups.get(real);
          if (op && this.signingIn?.owner?.file === real && this.signingIn.owner.operationId === op.operationId) this.cancelSignIn();
          this.startups.delete(real);
        }
        break;
      case "continueStart": if (real) await this.continueStart(real,action.operationId,action.intent); break;
      case "listProjects": if (real) await this.listProjects(real,action.operationId,action.cursor); break;
      case "openProject": if (real) await this.openProject(real,action); break;
      case "enable": if (real) this.enable(real); break;
      case "disable": if (real) this.disable(real); break;
      case "signIn": this.signIn(action.provider, real ?? undefined); break;
      case "cancelSignIn": if (!this.signingIn?.owner || this.signingIn.owner.file === real) this.cancelSignIn(); break;
      case "signOut": await this.signOut(); break;
      case "pause": this.paused = true; break;
      case "resume": this.paused = false; break;
      case "bind":
      case "syncNow": if (real) await this.syncFile(real, {}); break;
      case "choose": await this.choose(action.choiceId, real); break;
      case "resolveGroups": await this.choose(action.choiceId, real, action.resolution); break;
    }
    return this.status(file);
  }
  /** 1 回の同期をこの場で行う (結び付け・今すぐ同期・人の選択)。常駐の同期と同じロックで排他される */
  private syncFile(file: string, extra: Partial<Parameters<typeof syncOnce>[0]>): Promise<void> {
    // 資格情報が無ければ同期しない (トークン無しの要求を送らない)
    if (!this.resolveCredentials()) { this.message = t("先にサインインしてください"); this.emit(); return Promise.resolve(); }
    // 停止の途中・停止の後は、新しい操作を始めない (R40-02)
    if (this.stopping || this.stopped) { this.message = t("同期を止めています。終わってから、もう一度操作してください"); this.emit(); return Promise.resolve(); }
    const op = this.syncFileNow(file, extra);
    // 手動の操作も、停止が待つ対象に入れる (停止の完了は、始めた操作が全部終わった後)
    this.manual.add(op);
    void op.finally(() => this.manual.delete(op));
    return op;
  }
  private async syncFileNow(file: string, extra: Partial<Parameters<typeof syncOnce>[0]>): Promise<void> {
    const credentials = this.credentialsGeneration();
    this.busy++; this.emit();
    try {
      const token = this.resolveCredentials()?.token;
      const result = await syncOnce({ file, server: this.server, token, fetch: this.doFetch, now: () => new Date(this.wall()), ...extra });
      this.results.set(file, { result, at: this.wall(), credentials });
      if ("localBackup" in result && result.localBackup) this.localBackups.set(file, { path: result.localBackup, credentials });
      this.rememberSuccessfulSync(file);
      // (この資格情報で同期できた: 同じ世代の認証の失敗は解ける。R40-05)
      if (this.authProblem === credentials) this.authProblem = null;
    } catch (e) {
      this.results.set(file, { result: { status: "error", error: e }, at: this.wall(), credentials });
    } finally { this.busy--; this.emit(); }
  }
  /** 始めた手動の操作 (結び付け・今すぐ同期・選択) */
  private readonly manual = new Set<Promise<void>>();
  /** 停止の途中 (signOut の全体)。この間は、新しい手動の操作も、見張りの取り直しもしない */
  private stopping = false;
  /** 停止した (stop の後。この裏方では、もう同期を始めない) */
  private stopped = false;
  /** 選択 ID で、人の選択を実行する。対象・状態の世代・資格情報の世代が、表示したときと違えば、何もしない */
  private async choose(choiceId: string, file: string | null, resolution?: ConflictResolution): Promise<void> {
    const c = this.choices.get(choiceId);
    // (要求のファイルと、選択のファイルが同じであること。別のファイルの選択を、この画面から実行しない)
    if (!c || c.file !== file) { this.message = t("その選択は、今の表示のものではありません。表示を確かめてから、選び直してください"); this.emit(); return; }
    if (c.server !== this.server || c.credentials !== this.credentialsGeneration()) {
      this.message = t("表示したときから、状態が変わっています。選び直してください"); this.emit(); return;
    }
    // 状態の世代は、同期のロックの中で照合する (事前に読むだけでは、照合とロックの間の変化を見落とす。R39-02)
    const a = c.action;
    // 共通形式も従来の一括選択と同じ能力IDへ結び付ける。別の確認のtokenでは実行させない。
    if (resolution && (a.kind !== "resolve" || resolution.token !== a.token || !parseConflictResolution(resolution))) {
      this.message = t("表示したときから、状態が変わっています。選び直してください");
      this.emit();
      return;
    }
    const extra: Partial<Parameters<typeof syncOnce>[0]> =
      a.kind === "reconnectRestored" ? {reconnectRestored:a.token}
      : a.kind === "resolve" ? { resolution: resolution ?? { token: a.token, prefer: a.prefer } }
      : a.kind === "link" ? { remoteId: c.remoteId, firstLink: { token: a.token, prefer: a.prefer } }
      : a.kind === "relink" ? { relink: { token: a.token, prefer: a.prefer } }
      : a.kind === "recover" ? { recover: { token: a.token, applied: a.applied } }
      : a.kind === "adopt" ? { approvedDeletion: a.approval }
      : a.kind === "restore" ? { restoreDeletion: a.approval }
      : { confirmAccount: a.account };
    await this.syncFile(c.file, { ...extra, expectGeneration: c.generation });
  }
  // ---------------------------------------------------------------- 状態

  /** 今の状態を組み立てる (file = 今の画面のファイル) */
  status(file: string | null): SyncStatus {
    const real = file ? realFile(file) : null;
    const resolved = this.resolveCredentials();
    const credentialsSource = resolved?.source === "env" ? "env" : resolved ? "stored" : "none";
    const saved = credentialsSource === "stored" ? readCredentials(this.server) : null;
    const account = this.account?.credentials === this.credentialsGeneration() ? this.account.account
      : saved ? { accountId: saved.account, display: saved.login, signedInWith: "unknown" as const } : undefined;
    const credentials: SyncStatus["credentials"] = { source: credentialsSource, ...(account ? { account } : {}) };
    let binding: { server: string; remoteId: string } | null = null;
    if (real) { try { const b = bindingsOf(real).bindings.find((x) => x.server === this.server); if (b) binding = { server: b.server, remoteId: b.remoteId }; } catch { /* 読めない状態は problem に出る */ } }
    const enabled = real !== null && this.enabled.has(real);
    const status: SyncStatus = {
      session: this.session, seq: ++this.seq, support: this.support, credentials, owner: this.owner,
      server: this.server, isDefaultServer: isDefaultSyncServer(this.server), destinationPicker:this.options.destinationPicker,
      ...(real && this.localBackups.get(real)?.credentials === this.credentialsGeneration() ? {localBackup:this.localBackups.get(real)!.path} : {}),
      ...(real && this.lifecycles.get(real)?.credentials === this.credentialsGeneration() ? {lifecycle:this.lifecycles.get(real)!.state} : {}),
      ...(real && this.startups.has(real) ? {startup:(( {credentials:_,...safe} ) => safe)(this.startups.get(real)!)} : {})
    , file: real ? { path: real, enabled, binding } : null
    , state: "off", revision: null
    , ...(this.signingIn?.code ? { signIn: this.signingIn.code } : {})
    , ...(this.message ? { message: this.message } : {})
    };
    if (serverProblem(this.server)) {
      status.state = "problem";
      status.problem = { kind: "configuration", text: new SyncConfigurationError(this.server).message, fix: "server-setting" };
      return status;
    }
    if (this.support !== "ok") { status.state = "unsupported"; return status; }
    if (!real) { status.state = credentialsSource === "none" ? "signed-out" : "off"; return status; }
    // 資格情報が無い間は、サインインの途中でも「未サインイン」(途中で「オフ」に見せない。サインインの欄は signIn で出る。実機の VS Code で見つけた)
    if (credentialsSource === "none") { status.state = "signed-out"; return status; }
    if (!enabled) { status.state = "off"; return status; }
    if (this.owner === "external" || this.owner === "unknown") { status.state = "external"; status.message = this.owner === "external" ? t("別のプロセス (boxglow sync --watch など) が、このサーバーの同期を受け持っています。そちらを止めると、ここから同期できます") : t("同期のロックの持ち主を判定できません。boxglow unlock で確かめてください"); return status; }
    // 初回の比較は結び付けをまだ保存しないため、結果があれば先に表示する。
    if (!binding && !this.results.has(real)) { status.state = "unbound"; return status; }
    // 今の資格情報で、サーバーが利用者を確かめられなかった: 前の成功より優先する (R39-10)
    if (this.authProblem !== null && this.authProblem === this.credentialsGeneration()) {
      status.state = "problem";
      status.problem = { kind: "auth", text: t("サーバーが利用者を確かめられませんでした"), fix: "credentials" };
      return status;
    }
    const last = this.results.get(real);
    if (this.busy > 0 && (!last || this.wall() - last.at > 500)) { status.state = "syncing"; }
    // 結果がまだ無い: 一時停止中で、手動の同期も動いていなければ「一時停止」(結果が無いことだけを「同期中」の根拠にしない。
    // 一時停止中は tick が進まないので、「同期中」のまま変わらなくなる。R47-01)。それ以外は、最初の同期を待っている「同期中」
    if (!last) { status.state = this.paused && this.busy === 0 ? "paused" : "syncing"; return status; }
    const r = last.result;
    if (r.status === "error") {
      const e = r.error;
      status.state = "problem";
      status.problem = e instanceof SyncAuthError ? { kind: "auth", text: t("サーバーが利用者を確かめられませんでした"), fix: "credentials" }
        : e instanceof SyncRejectedError ? { kind: "rejected", text: t("サーバーが、この計画の同期を受け付けませんでした (待っても直りません)")+(e.status===507 ? " "+t("削除した計画も30日間は保存量に含まれます。") : ""), fix: "local-file" }
        : e instanceof SyncNetworkError ? { kind: "network", text: t("サーバーと通信できませんでした"), fix: "wait" }
        : e instanceof SyncStateUnreadable ? { kind: "state-unreadable", text: t("同期の状態のファイルを読めません"), fix: "sync-state" }
        : { kind: "busy", text: e instanceof Error ? e.message : String(e), fix: "rerun" };
      if (status.problem.kind === "network") status.state = "offline";
      return status;
    }
    // (一時停止中でも、手動の同期で止まった・問題が起きたことは見せる。「一時停止」は、それ以外のときだけ)
    if (this.paused && r.status !== "halted") { status.state = "paused"; return status; }
    if (r.status === "busy") { status.state = "syncing"; return status; }
    if (r.status === "halted") {
      status.state = "halted";
      const view = haltView(r, real);
      const choiceIds: Record<string, string> = {};
      for (const item of view.items) {
        if (item.kind !== "choice") continue;
        const id = `${this.session}:${randomUUID().slice(0, 8)}`;
        this.choices.set(id, { action: item.action, file: real, server: view.target.server, remoteId: view.target.remoteId, generation: (r as { stateGeneration?: number }).stateGeneration ?? null, credentials: last.credentials });
        choiceIds[item.id] = id;
      }
      const resolveItem = view.items.find(item => item.kind === "choice" && item.action.kind === "resolve");
      status.halt = { ...view, choiceIds, ...(view.review && resolveItem?.kind === "choice" ? { resolutionChoiceId: choiceIds[resolveItem.id] } : {}) };
      return status;
    }
    // そろった: 結果の localHash が今のディスクと同じで、資格情報の世代が同じなら synced。違えば unsent (送信待ち)
    status.revision = r.revision;
    let disk: string | null = null;
    try { disk = hashOf(readFileSync(real, "utf8")); } catch { disk = null; }
    status.state = r.localHash === disk && last.credentials === this.credentialsGeneration() && status.state !== "syncing" ? "synced" : status.state === "syncing" ? "syncing" : "unsent";
    if (this.network && this.wall() - this.network.at < 60_000) { status.state = "offline"; status.problem = { kind: "network", text: this.network.message, fix: "wait" }; }
    return status;
  }

  /** 状態が変わったことを画面へ知らせる (ファイルごとに 1 回) */
  private emit(): void {
    if (!this.options.onStatus) return;
    void this.refreshAccount().then(() => { for (const file of this.open.size ? this.open.keys() : [null]) this.options.onStatus?.(this.status(file)); });
  }
}

/**
 * 画面からの同期の操作を、許可リストで読む (知らない種類・引数の形が違うものは受け付けない)
 * Input : text = 要求の本文 (JSON)
 * Output: HostAction。読めなければ null
 */
/** ブロック/項目ごとの選択を載せられる上限。serveとVS Codeで同じバイト数を適用する。 */
export const MAX_SYNC_ACTION_BYTES = 256 * 1024;

export function parseHostAction(text: string): HostAction | null {
  if (Buffer.byteLength(text, "utf8") > MAX_SYNC_ACTION_BYTES)
    return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  }
  catch {
    return null;
  }
  if (typeof v !== "object" || v === null)
    return null;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "listTrash": return o.cursor === undefined || typeof o.cursor === "string" && o.cursor.length <= 256 ? {kind:o.kind,cursor:o.cursor as string|undefined} : null;
    case "previewDelete":
    case "previewRestore": return typeof o.projectId === "string" && o.projectId.length > 0 && o.projectId.length <= 256 ? {kind:o.kind,projectId:o.projectId} : null;
    case "confirmLifecycle": return typeof o.choiceId === "string" && o.choiceId.length <= 128 ? {kind:o.kind,choiceId:o.choiceId} : null;
    case "cancelLifecycle":
    case "beginSync":
    case "cancelBegin":
      return { kind: o.kind };
    case "continueStart": return typeof o.operationId === "string" && o.operationId.length <= 128 && (o.intent === "new" || o.intent === "existing") ? { kind: o.kind, operationId: o.operationId, intent: o.intent } : null;
    case "listProjects": return typeof o.operationId === "string" && o.operationId.length <= 128 && (o.cursor === undefined || typeof o.cursor === "string" && o.cursor.length <= 256) ? { kind: o.kind, operationId: o.operationId, ...(typeof o.cursor === "string" ? { cursor: o.cursor } : {}) } : null;
    case "openProject": return typeof o.operationId === "string" && o.operationId.length <= 128 && typeof o.projectId === "string" && o.projectId.length > 0 && o.projectId.length <= 256 && (o.destination === undefined || o.destination === "current" || o.destination === "new") && (o.name === undefined || typeof o.name === "string" && o.name.length <= 128) ? { kind: o.kind, operationId: o.operationId, projectId: o.projectId, destination: o.destination as "current" | "new" | undefined, name: o.name as string | undefined } : null;
    case "enable":
    case "disable":
    case "cancelSignIn":
    case "signOut":
    case "bind":
    case "syncNow":
    case "pause":
    case "resume":
      return { kind: o.kind };
    case "signIn": return o.provider === "github" || o.provider === "google" ? { kind: "signIn", provider: o.provider } : null;
    case "resolveGroups": {
      const resolution = parseConflictResolution(o.resolution);
      return resolution && typeof o.choiceId === "string" && o.choiceId.length <= 128
        ? { kind: "resolveGroups", choiceId: o.choiceId, resolution } : null;
    }
    case "choose": return typeof o.choiceId === "string" && o.choiceId.length <= 128 ? { kind: "choose", choiceId: o.choiceId } : null;
    default: return null;
  }
}
