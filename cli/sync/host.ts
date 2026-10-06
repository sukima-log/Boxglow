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
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { t } from "../../src/i18n/core";
import { inspectLock } from "../file-store";
import { syncOnce, SyncAuthError, SyncNetworkError, SyncRejectedError, type SyncResult } from "./client";
import { haltView, type SyncAction } from "./command";
import { credentialsPath, resolveToken } from "./credentials";
import { runGoogleLogin, runLogin, runLogout, runWhoami } from "./login";
import { bindingsOf, hashOf, normalizeServer, realFile, SyncStateUnreadable } from "./state-store";
import { lockWatch, SyncWatcher, type WatchEvent } from "./watch";

import type { HostAction, SyncStatus } from "../../src/sync/status";
export type { HostAction, SyncStatus };

/** 裏方の指定 */
export interface HostOptions {
  server: string;
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
interface SignIn { provider: "github" | "google"; code?: SyncStatus["signIn"]; cancelled: boolean; done: Promise<number> }

/** 人が選べる操作に付ける、選択 ID の中身 (対象・表示した操作・同期の状態の世代・資格情報の世代を結び付ける) */
interface Choice { action: SyncAction; file: string; server: string; remoteId: string; generation: number | undefined; credentials: string }

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

  /**
   * 資格情報の世代: 出どころと、保存ファイルの印 (更新時刻・大きさ・内容のハッシュ)。値そのものは含めない。
   * 別の CLI の login / logout で変わる。要求ごとに世代を控え、違う世代の遅い応答を状態に採用しない
   */
  private credentialsGeneration(): string {
    if (process.env.BOXGLOW_TOKEN) return "env:" + hashOf(process.env.BOXGLOW_TOKEN).slice(0, 16);
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
    const real = realFile(file);
    this.enabled.add(real);
    this.ensureWatcher();
    this.applyTargets();
    this.emit();
  }
  /** この計画の同期を無効にする (次の 1 回を始めない。対象が無くなったら、見張りを止めて所有権を手放す) */
  disable(file: string): void {
    this.enabled.delete(realFile(file));
    this.applyTargets();
    this.emit();
  }
  /** 有効で、かつ開いている計画 = 見張る対象 */
  private targets(): Set<string> { return new Set([...this.enabled].filter((f) => this.open.has(f))); }
  private applyTargets(): void {
    const files = this.targets();
    if (files.size === 0) { this.releaseWatcher(); return; }
    this.ensureWatcher();
    this.watcher?.setTargets({ mode: "selected", files });
  }

  // ---------------------------------------------------------------- 常駐の同期の所有権

  private ensureWatcher(): void {
    if (this.watcher || this.targets().size === 0) return;
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
    this.watcher = new SyncWatcher({
      server: this.server
    , token: () => resolveToken(this.server)?.token
    , targets: { mode: "selected", files: this.targets() }
    , fetch: this.doFetch, now: this.options.now, elapsed: this.options.elapsed, random: this.options.random
    , onEvent: (e) => this.onEvent(e)
    });
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }
  /** 見張りを止めて、所有権を手放す (実行中の 1 回は待つ) */
  private releaseWatcher(): void {
    if (!this.watcher) return;
    const w = this.watcher;
    this.watcher = null;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    w.setTargets({ mode: "selected", files: new Set() });
    const done = () => { this.unlockWatch?.(); this.unlockWatch = null; if (this.owner === "self") this.owner = "none"; this.emit(); };
    // (実行中の 1 回が終わるのを待ってから手放す。tick は実行中なら何もしないので、次の tick が終わる時点で待てる)
    void w.tick().then(done, done);
  }
  /** 1 秒ごと: 一時停止中は見張りだけ (同期しない)。実行中の同期の間は「同期中」と見せる */
  async tick(): Promise<void> {
    if (!this.watcher || this.paused) return;
    this.busy++; this.emit();
    try { await this.watcher.tick(); } finally { this.busy--; this.emit(); }
  }
  /** 裏方を止める (プロセスの終了・最後の画面が閉じた後) */
  async stop(): Promise<void> {
    this.releaseWatcher();
    this.signingIn && (this.signingIn.cancelled = true);
  }

  private onEvent(e: WatchEvent): void {
    const credentials = this.credentialsGeneration();
    if (e.kind === "synced" || e.kind === "checked") this.results.set(e.file, { result: { status: "synced", pulled: e.kind === "synced" ? e.pulled : 0, pushed: e.kind === "synced" ? e.pushed : 0, edited: 0, revision: e.revision, localHash: e.localHash }, at: this.wall(), credentials });
    else if (e.kind === "halted") this.results.set(e.file, { result: e.result, at: this.wall(), credentials });
    else if (e.kind === "error") this.results.set(e.file, { result: { status: "error", error: new Error(e.message) }, at: this.wall(), credentials });
    else if (e.kind === "auth") this.account = { credentials, problem: "auth" };
    else if (e.kind === "network") this.network = { message: e.message, at: this.wall() };
    this.emit();
  }
  private network: { message: string; at: number } | null = null;

  // ---------------------------------------------------------------- サインイン / サインアウト

  /** サインインを始める (GitHub の端末向けの手順)。コードは状態の signIn に出る。終わると状態が変わる */
  signIn(provider: "github" | "google"): void {
    if (this.signingIn || this.support !== "ok") { this.emit(); return; }
    const entry: SignIn = { provider, cancelled: false, done: Promise.resolve(1) };
    this.signingIn = entry;
    const lines: string[] = [];
    const common = { server: this.server, out: (line: string) => lines.push(line), fetch: this.doFetch, sleep: this.options.sleep, deviceName: this.options.deviceName, cancelled: () => entry.cancelled };
    entry.done = (provider === "google"
      ? runGoogleLogin({ ...common, onUrl: (info) => { entry.code = { provider: "google", ...info }; this.emit(); } })
      : runLogin({ ...common, onCode: (code) => { entry.code = { provider: "github", ...code }; this.emit(); } })
    ).then((code) => {
      if (this.signingIn === entry) { this.signingIn = null; if (code !== 0 && !entry.cancelled) this.message = lines.filter((l) => !l.startsWith("  ")).at(-1); else this.message = undefined; }
      this.account = null;
      this.emit();
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
  async signOut(): Promise<void> {
    this.cancelSignIn();
    const targets = [...this.enabled];
    this.enabled.clear();
    this.releaseWatcher();
    const lines: string[] = [];
    await runLogout({ server: this.server, out: (line) => lines.push(line), fetch: this.doFetch });
    this.account = null;
    this.results.clear();
    this.message = lines.at(-1);
    // (サインアウトの後も、有効にしていた計画の記憶は画面側 (拡張の設定) が持つ。ここでは、見張りを止めるだけ)
    void targets;
    this.emit();
  }
  private message: string | undefined;

  /** 確かめた利用者を読み直す (資格情報の世代が変わっていたら、/v1/me で確かめる) */
  private async refreshAccount(): Promise<void> {
    const credentials = this.credentialsGeneration();
    if (this.account?.credentials === credentials) return;
    if (!resolveToken(this.server)) { this.account = { credentials }; return; }
    const lines: string[] = [];
    const code = await runWhoami({ server: this.server, out: (line) => lines.push(line), fetch: this.doFetch });
    // (遅い応答: その間に資格情報が変わっていたら、採用しない)
    if (this.credentialsGeneration() !== credentials) return;
    if (code !== 0) { this.account = { credentials, problem: lines.at(-1) }; return; }
    const m = /^.*?: (.+?) \((acc[0-9a-f]+)\)/.exec(lines[0] ?? "");
    this.account = { credentials, account: { accountId: m?.[2] ?? "", display: m?.[1] ?? "", signedInWith: "github" } };
  }

  // ---------------------------------------------------------------- 画面からの操作

  /** 操作を受ける (serve の POST /api/sync、拡張の sync-action)。結果は状態で返す */
  async act(file: string | null, action: HostAction): Promise<SyncStatus> {
    const real = file ? realFile(file) : null;
    switch (action.kind) {
      case "enable": if (real) this.enable(real); break;
      case "disable": if (real) this.disable(real); break;
      case "signIn": this.signIn(action.provider); break;
      case "cancelSignIn": this.cancelSignIn(); break;
      case "signOut": await this.signOut(); break;
      case "pause": this.paused = true; break;
      case "resume": this.paused = false; break;
      case "bind":
      case "syncNow": if (real) await this.syncFile(real, {}); break;
      case "choose": await this.choose(action.choiceId); break;
    }
    return this.status(file);
  }
  /** 1 回の同期をこの場で行う (結び付け・今すぐ同期・人の選択)。常駐の同期と同じロックで排他される */
  private async syncFile(file: string, extra: Partial<Parameters<typeof syncOnce>[0]>): Promise<void> {
    const credentials = this.credentialsGeneration();
    this.busy++; this.emit();
    try {
      const result = await syncOnce({ file, server: this.server, token: resolveToken(this.server)?.token, fetch: this.doFetch, now: () => new Date(this.wall()), ...extra });
      this.results.set(file, { result, at: this.wall(), credentials });
    } catch (e) {
      this.results.set(file, { result: { status: "error", error: e }, at: this.wall(), credentials });
    } finally { this.busy--; this.emit(); }
  }
  /** 選択 ID で、人の選択を実行する。対象・状態の世代・資格情報の世代が、表示したときと違えば、何もしない */
  private async choose(choiceId: string): Promise<void> {
    const c = this.choices.get(choiceId);
    if (!c) { this.message = t("その選択は、今の表示のものではありません。表示を確かめてから、選び直してください"); this.emit(); return; }
    const stored = this.generationOf(c.file);
    if (c.server !== this.server || c.credentials !== this.credentialsGeneration() || stored !== c.generation) {
      this.message = t("表示したときから、状態が変わっています。選び直してください"); this.emit(); return;
    }
    const a = c.action;
    const extra: Partial<Parameters<typeof syncOnce>[0]> =
      a.kind === "resolve" ? { resolution: { token: a.token, prefer: a.prefer } }
      : a.kind === "link" ? { remoteId: c.remoteId, firstLink: { token: a.token, prefer: a.prefer } }
      : a.kind === "relink" ? { relink: { token: a.token, prefer: a.prefer } }
      : a.kind === "recover" ? { recover: { token: a.token, applied: a.applied } }
      : a.kind === "adopt" ? { approvedDeletion: a.approval }
      : a.kind === "restore" ? { restoreDeletion: a.approval }
      : { confirmAccount: a.account };
    await this.syncFile(c.file, extra);
  }
  /** 同期の状態の世代番号 (読めなければ undefined) */
  private generationOf(file: string): number | undefined {
    try {
      const { bindings } = bindingsOf(file);
      const b = bindings.find((x) => x.server === this.server);
      if (!b) return undefined;
      const r = this.results.get(file)?.result as { stateGeneration?: number } | undefined;
      return r?.stateGeneration;
    } catch { return undefined; }
  }

  // ---------------------------------------------------------------- 状態

  /** 今の状態を組み立てる (file = 今の画面のファイル) */
  status(file: string | null): SyncStatus {
    const real = file ? realFile(file) : null;
    const credentialsSource = process.env.BOXGLOW_TOKEN ? "env" as const : existsSync(credentialsPath(this.server)) ? "stored" as const : "none" as const;
    const credentials: SyncStatus["credentials"] = { source: credentialsSource, ...(this.account?.account ? { account: this.account.account } : {}) };
    let binding: { server: string; remoteId: string } | null = null;
    if (real) { try { const b = bindingsOf(real).bindings.find((x) => x.server === this.server); if (b) binding = { server: b.server, remoteId: b.remoteId }; } catch { /* 読めない状態は problem に出る */ } }
    const enabled = real !== null && this.enabled.has(real);
    const status: SyncStatus = {
      session: this.session, seq: ++this.seq, support: this.support, credentials, owner: this.owner
    , file: real ? { path: real, enabled, binding } : null
    , state: "off", revision: null
    , ...(this.signingIn?.code ? { signIn: this.signingIn.code } : {})
    , ...(this.message ? { message: this.message } : {})
    };
    if (this.support !== "ok") { status.state = "unsupported"; return status; }
    if (!real) { status.state = credentialsSource === "none" ? "signed-out" : "off"; return status; }
    if (credentialsSource === "none" && !this.signingIn) { status.state = "signed-out"; return status; }
    if (!enabled) { status.state = "off"; return status; }
    if (this.owner === "external" || this.owner === "unknown") { status.state = "external"; status.message = this.owner === "external" ? t("別のプロセス (boxglow sync --watch など) が、このサーバーの同期を受け持っています。そちらを止めると、ここから同期できます") : t("同期のロックの持ち主を判定できません。boxglow unlock で確かめてください"); return status; }
    if (!binding) { status.state = "unbound"; return status; }
    if (this.paused) { status.state = "paused"; return status; }
    const last = this.results.get(real);
    if (this.busy > 0 && (!last || this.wall() - last.at > 500)) { status.state = "syncing"; }
    if (!last) { if (status.state !== "syncing") status.state = "syncing"; return status; }
    const r = last.result;
    if (r.status === "error") {
      const e = r.error;
      status.state = "problem";
      status.problem = e instanceof SyncAuthError ? { kind: "auth", text: t("サーバーが利用者を確かめられませんでした"), fix: "credentials" }
        : e instanceof SyncRejectedError ? { kind: "rejected", text: t("サーバーが、この計画の同期を受け付けませんでした (待っても直りません)"), fix: "local-file" }
        : e instanceof SyncNetworkError ? { kind: "network", text: t("サーバーと通信できませんでした"), fix: "wait" }
        : e instanceof SyncStateUnreadable ? { kind: "state-unreadable", text: t("同期の状態のファイルを読めません"), fix: "sync-state" }
        : { kind: "busy", text: e instanceof Error ? e.message : String(e), fix: "rerun" };
      if (status.problem.kind === "network") status.state = "offline";
      return status;
    }
    if (r.status === "busy") { status.state = "syncing"; return status; }
    if (r.status === "halted") {
      status.state = "halted";
      const view = haltView(r, real);
      const choiceIds: Record<string, string> = {};
      for (const item of view.items) {
        if (item.kind !== "choice") continue;
        const id = `${this.session}:${randomUUID().slice(0, 8)}`;
        this.choices.set(id, { action: item.action, file: real, server: view.target.server, remoteId: view.target.remoteId, generation: (r as { stateGeneration?: number }).stateGeneration, credentials: last.credentials });
        choiceIds[item.id] = id;
      }
      status.halt = { ...view, choiceIds };
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
export function parseHostAction(text: string): HostAction | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  switch (o.kind) {
    case "enable": case "disable": case "cancelSignIn": case "signOut": case "bind": case "syncNow": case "pause": case "resume":
      return { kind: o.kind };
    case "signIn": return o.provider === "github" || o.provider === "google" ? { kind: "signIn", provider: o.provider } : null;
    case "choose": return typeof o.choiceId === "string" && o.choiceId.length <= 128 ? { kind: "choose", choiceId: o.choiceId } : null;
    default: return null;
  }
}
