/**
 * ブラウザだけの画面 (boxglow.app) の同期の裏方。裏方 (cli/sync/host.ts: serve / VS Code) と同じ約束 (SyncStatus / HostAction) を、
 * ブラウザの中で実装する。画面 (同期の印・同期パネル・開始の手順・競合の選択・Home の受け取り) は、裏方がどれかを区別しない。
 *   - 資格情報: サーバー (sync.boxglow.app) が発行する HttpOnly Cookie (設計書 SYNC_BROWSER_DESIGN.md 3 章)。画面はトークンを持たない。
 *     サインインの手順 (GitHub のコード / Google の URL) で受け取ったトークンは、その場で POST /v1/session に渡して Cookie にし、捨てる
 *   - 手元: ブラウザ内の計画 (IndexedDB)。同期の本体は src/sync/run.ts (裏方と共通)、入出力は src/sync/browser-io.ts
 *   - 常時の同期: 有効にした計画を、開いている間 30 秒ごと + 保存の直後に同期する (タブが隠れている間は止める)
 *   - 複数タブ: 同じ結び付けの同期は Web Locks で 1 つに絞られる (browser-io の lockState)。2 つ目は busy で譲る
 * 作らないもの (CLI / 裏方で行う): サーバーの計画の削除・復元 (lifecycle)、結び直し・復旧の控えの取り出し
 */
import { t } from "../i18n/core";
import { sha256Hex } from "../lib/sha256";
import { loadProject, saveProject } from "../lib/storage";
import { fromJSON, toJSON } from "../model/graph";
import { parseConflictResolution, type ConflictResolution } from "../model/conflict-groups";
import { browserSyncIO } from "./browser-io";
import { applyRevert, parseVersionList, planNameOf } from "./versions";
import { parseBilling } from "./billing";
import { parseShareList, shareUrl } from "./shares";
import { SyncPaymentError } from "./run";
import { haltView } from "./halt-view";
import { runSync, SyncAuthError, SyncNetworkError, SyncRejectedError, type SyncOptions, type SyncResult } from "./run";
import type { HostAction, SyncAction, SyncStatus } from "./status";
import { isDefaultSyncServer, serverProblem } from "../../cli/sync/server-policy";

/** 常時の同期の間隔 (ms) と、保存の直後にまとめて送るまでの待ち (ms) */
const TICK_MS = 30_000, AFTER_SAVE_MS = 1_500;
/** 有効にした計画を覚える場所 (このブラウザの中だけ) */
const ENABLED_KEY = "boxglow:sync:enabled";

type Startup = NonNullable<SyncStatus["startup"]> & { credentials?: number };
/** サインインの途中の記録 (コードや URL は画面に出す。cancelled = 中止された) */
type SignInEntry = { provider: "github" | "google"; link?: boolean; code?: SyncStatus["signIn"]; cancelled: boolean };
type Result = { result: SyncResult | { status: "error"; error: unknown }; at: number; credentials: number };

export interface BrowserSyncHostOptions {
  server: string;
  fetch?: typeof fetch;
  /** 状態が変わったときに呼ぶ (画面へ渡す) */
  onStatus?: (status: SyncStatus) => void;
  /** サーバーの計画を受け取って、ブラウザ内の計画として保存したときに呼ぶ (画面がその計画を開く) */
  onOpened?: (projectId: string) => void;
  /** 同期で手元 (IndexedDB の計画) を書き換えたときに呼ぶ (画面が読み直す) */
  onLocalChanged?: (projectId: string) => void;
  /** 待つ関数 (試験で差し替える) */
  sleep?: (ms: number) => Promise<void>;
  /** 時計 (試験で差し替える) */
  now?: () => number;
}

export class BrowserSyncHost {
  readonly session = crypto.randomUUID();
  private seq = 0;
  /** 資格情報の世代 (サインイン・サインアウトで進める。古い応答・選択を捨てる印) */
  private generation = 0;
  /** 確かめた利用者 (null = まだ確かめていない / undefined = サインインしていない) */
  private account: { credentials: number; account?: SyncStatus["credentials"]["account"]; problem?: string } | null = null;
  private readonly open = new Map<string, number>();
  private readonly enabled = new Set<string>(loadEnabled());
  private readonly results = new Map<string, Result>();
  private readonly startups = new Map<string, Startup>();
  private readonly choices = new Map<string, { action: SyncAction; file: string; remoteId: string; generation: number | null; credentials: number }>();
  private signingIn: SignInEntry | null = null;
  private message?: string;
  private notInvited?: SyncStatus["notInvited"];
  /** 計画ごとの、サーバーの計画の管理 (ブラウザ版は履歴と「この版に戻す」だけ)。preview の中身 (text) は状態に出さない */
  private readonly lifecycles = new Map<string, { state: NonNullable<SyncStatus["lifecycle"]>; credentials: number; text?: string }>();
  private busy = 0;
  private paused = false;
  private network: { at: number; message: string } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: BrowserSyncHostOptions) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? (() => Date.now());
    // 全部の要求に Cookie を付ける (同じサイトの同期サーバーへ。トークンは持たない)
    const base = options.fetch ?? fetch;
    this.doFetch = (input, init) => base(input, { ...init, credentials: "include" });
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void this.tick(); });
  }
  get server(): string { return this.options.server; }

  // ---------------------------------------------------------------- 画面のファイル (= ブラウザ内の計画) の開閉

  /** 計画を開いた (画面が見ている間、常時の同期の対象になる) */
  openFile(projectId: string): void { this.open.set(projectId, (this.open.get(projectId) ?? 0) + 1); void this.tick(projectId); this.emit(); }
  closeFile(projectId: string): void { const n = (this.open.get(projectId) ?? 1) - 1; if (n <= 0) this.open.delete(projectId); else this.open.set(projectId, n); this.emit(); }
  /** 手元の計画を保存した (少し待ってから送る: 連続する編集を 1 回にまとめる) */
  notifyLocalChange(projectId: string): void {
    if (!this.enabled.has(projectId)) return;
    const old = this.saveTimers.get(projectId); if (old) clearTimeout(old);
    this.saveTimers.set(projectId, setTimeout(() => { this.saveTimers.delete(projectId); void this.syncFile(projectId, {}); }, AFTER_SAVE_MS));
  }
  /** 片付け (試験用) */
  dispose(): void { if (this.timer) clearInterval(this.timer); this.timer = null; for (const tm of this.saveTimers.values()) clearTimeout(tm); }

  // ---------------------------------------------------------------- 利用者

  /** サインインしているか (Cookie のセッションが有効か) を /v1/me で確かめ、利用者と手段の一覧を控える */
  private async refreshAccount(): Promise<void> {
    const credentials = this.generation;
    if (this.account?.credentials === credentials) return;
    try {
      const res = await this.doFetch(`${this.server}/v1/me`, { redirect: "error" });
      if (credentials !== this.generation) return;
      if (res.status === 401 || res.status === 403) { this.account = { credentials }; return; }
      if (!res.ok) { this.account = { credentials, problem: `HTTP ${res.status}` }; return; }
      const me = await res.json() as { account?: unknown; login?: unknown; signedInWith?: unknown; billing?: unknown };
      if (typeof me.account !== "string") { this.account = { credentials, problem: "me" }; return; }
      let identities: ("github" | "google")[] | undefined;
      try {
        const r2 = await this.doFetch(`${this.server}/v1/identities`, { redirect: "error" });
        if (r2.ok) { const list = (await r2.json() as { identities?: unknown }).identities; if (Array.isArray(list)) identities = list.filter((x): x is "github" | "google" => x === "github" || x === "google"); }
      } catch { /* 一覧は無くてもよい */ }
      if (credentials !== this.generation) return;
      this.account = { credentials, account: { accountId: me.account, display: typeof me.login === "string" && me.login ? me.login : me.account
        , signedInWith: me.signedInWith === "google" || me.signedInWith === "github" ? me.signedInWith : "unknown", ...(identities ? { identities } : {}), ...(parseBilling(me.billing) ? { billing: parseBilling(me.billing)! } : {}) } };
    } catch (e) { if (credentials === this.generation) this.account = { credentials, problem: e instanceof Error ? e.message : String(e) }; }
  }
  private signedIn(): boolean { return !!this.account?.account; }

  /**
   * サインイン (本人の操作)。受け取ったトークンは、その場で Cookie のセッションに替えて捨てる
   * Input : provider = 手段, link = true なら 2 つ目の手段として足す (トークンは発行されない)
   */
  private signIn(provider: "github" | "google", link = false): void {
    if (this.signingIn) { this.emit(); return; }
    const entry: SignInEntry = { provider, link, cancelled: false };
    this.signingIn = entry; this.notInvited = undefined; this.message = undefined;
    for (const op of this.startups.values()) if (op.stage === "signin") delete op.error;
    this.emit();
    void (async () => {
      let outcome: { ok: true } | { ok: false; message?: string; notInvited?: SyncStatus["notInvited"] };
      try { outcome = provider === "github" ? await this.deviceFlow(entry, link) : await this.googleFlow(entry, link); }
      catch (e) { outcome = { ok: false, message: t("サーバーと通信できませんでした: {message}", { message: e instanceof Error ? e.message : String(e) }) }; }
      if (this.signingIn !== entry) return;
      this.signingIn = null;
      if (outcome.ok) { this.generation++; this.account = null; this.message = undefined; }
      else if (!entry.cancelled) { this.notInvited = outcome.notInvited; this.message = outcome.notInvited ? undefined : outcome.message; }
      if (!outcome.ok && !entry.cancelled) for (const op of this.startups.values()) if (op.stage === "signin") op.error = outcome.notInvited ? t("同期は招待制の試験中です。このアカウントはまだ招待されていません。") : (outcome.message ?? t("サインインできませんでした"));
      this.emit();
      if (outcome.ok && !link) { await this.refreshAccount(); for (const [file, op] of this.startups) if (op.stage === "signin") await this.continueStart(file, op.operationId); }
      if (outcome.ok && link) { this.account = null; this.emit(); }
    })();
  }
  /** GitHub の端末向けの手順 (画面がコードを出し、サーバーに引き換えを問い合わせる) */
  private async deviceFlow(entry: SignInEntry, link: boolean): Promise<{ ok: true } | { ok: false; message?: string; notInvited?: SyncStatus["notInvited"] }> {
    const res = await this.doFetch(`${this.server}/v1/auth/device`, { method: "POST", redirect: "error" });
    if (!res.ok) return { ok: false, message: t("サインインを始められませんでした (サーバーの応答: {status})", { status: res.status }) };
    const started = await res.json() as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
    const deadline = this.now() + Math.max(1, Number(started.expires_in) || 900) * 1000;
    entry.code = { provider: "github", userCode: started.user_code, verificationUrl: started.verification_uri, expiresAt: new Date(deadline).toISOString(), ...(link ? { link: true } : {}) };
    this.emit();
    let interval = Math.max(1, Number(started.interval) || 5);
    for (;;) {
      await this.sleep(interval * 1000);
      if (entry.cancelled) return { ok: false };
      if (this.now() > deadline) return { ok: false, message: t("コードの期限が切れました。もう一度実行してください") };
      let r: Response;
      try { r = await this.doFetch(`${this.server}/v1/auth/device/token`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code: started.device_code, device_name: "browser", ...(link ? { link: true } : {}) }) }); } catch { continue; }
      if (r.status === 429 || r.status === 502) continue;
      const body = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (r.status === 200 && body.status === "pending") continue;
      if (r.status === 200 && body.status === "slow_down") { interval = Math.max(interval, Number(body.interval) || interval + 5); continue; }
      if (r.status === 200 && body.status === "ok" && link && body.linked === "github") return { ok: true };
      if (r.status === 200 && body.status === "ok" && typeof body.token === "string") return this.establishSession(body.token);
      if (r.status === 403 && body.code === "not-invited") return { ok: false, notInvited: { provider: "github", ...(typeof body.waitlist === "string" && /^https:\/\//.test(body.waitlist) ? { waitlist: body.waitlist } : {}) } };
      if (r.status === 409 && body.code === "identity-in-use") return { ok: false, message: t("その GitHub のアカウントは、別の Boxglow のアカウントで使われています。結び付けられません") };
      return { ok: false, message: t("サインインできませんでした (サーバーの応答: {status} {code})", { status: r.status, code: String(body.code ?? "") }) };
    }
  }
  /** Google の認可 (サーバーが仲立ち。画面は URL を新しいタブで開いてもらい、claim で結果を待つ) */
  private async googleFlow(entry: SignInEntry, link: boolean): Promise<{ ok: true } | { ok: false; message?: string; notInvited?: SyncStatus["notInvited"] }> {
    const secret = randomBase64url(32), claimHash = sha256Hex(secret);
    const res = await this.doFetch(`${this.server}/v1/auth/google/start`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimHash, ...(link ? { link: true } : {}) }) });
    if (res.status === 404) return { ok: false, message: t("このサーバーでは、Google でのサインインはまだ使えません") };
    if (!res.ok) return { ok: false, message: t("サインインを始められませんでした (サーバーの応答: {status})", { status: res.status }) };
    const started = await res.json() as { id: string; url: string; expiresAt: string };
    entry.code = { provider: "google", url: started.url, expiresAt: started.expiresAt, ...(link ? { link: true } : {}) };
    this.emit();
    const deadline = Date.parse(started.expiresAt) || this.now() + 600_000;
    const cancel = async () => { try { await this.doFetch(`${this.server}/v1/auth/google/cancel`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: started.id, claimSecret: secret }) }); } catch { /* 最善努力 */ } };
    for (;;) {
      await this.sleep(3000);
      if (entry.cancelled) { await cancel(); return { ok: false }; }
      if (this.now() > deadline) return { ok: false, message: t("サインインの期限が切れました。もう一度実行してください") };
      let r: Response;
      try { r = await this.doFetch(`${this.server}/v1/auth/google/claim`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: started.id, claimSecret: secret }) }); } catch { continue; }
      if (r.status === 429 || r.status === 502 || r.status === 503) continue;
      const body = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (r.status === 200 && body.status === "pending") continue;
      if (r.status === 200 && body.status === "ok" && link && body.linked === "google") return { ok: true };
      if (r.status === 200 && body.status === "ok" && typeof body.token === "string") return this.establishSession(body.token);
      if (r.status === 403 && body.code === "not-invited") return { ok: false, notInvited: { provider: "google", ...(typeof body.waitlist === "string" && /^https:\/\//.test(body.waitlist) ? { waitlist: body.waitlist } : {}) } };
      if (r.status === 403 && body.code === "identity-in-use") return { ok: false, message: t("その Google のアカウントは、別の Boxglow のアカウントで使われています。結び付けられません") };
      return { ok: false, message: t("サインインできませんでした (サーバーの応答: {status} {code})", { status: r.status, code: String(body.code ?? "") }) };
    }
  }
  /** 受け取ったトークンを Cookie のセッションに替える (トークンはここで捨てる。失敗したらサーバー側で失効させる) */
  private async establishSession(token: string): Promise<{ ok: true } | { ok: false; message?: string }> {
    const res = await this.doFetch(`${this.server}/v1/session`, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return { ok: true };
    try { await this.doFetch(`${this.server}/v1/tokens/current`, { method: "DELETE", redirect: "error", headers: { authorization: `Bearer ${token}` } }); } catch { /* 最善努力 */ }
    return { ok: false, message: t("サインインを保存できませんでした (サーバーの応答: {status})", { status: res.status }) };
  }
  private cancelSignIn(): void { if (this.signingIn) { this.signingIn.cancelled = true; this.signingIn = null; this.emit(); } }
  /** サインアウト: サーバーのセッション (トークン) を失効させ、Cookie を消す。開始の手順と選択は捨てる */
  private async signOut(): Promise<void> {
    this.cancelSignIn();
    try { await this.doFetch(`${this.server}/v1/session`, { method: "DELETE", redirect: "error" }); } catch { /* Cookie が消えれば、サーバー側のトークンは期限で消える */ }
    this.generation++; this.account = null; this.startups.clear(); this.choices.clear(); this.results.clear(); this.message = undefined; this.billingLink = undefined;
    this.emit();
  }

  /**
   * アカウントの削除 (本人の操作): Cookie のセッションで DELETE /v1/account (confirm: true)。受け付けられたらサインアウトと同じ片付け
   *   - サーバーはアカウントを止めてトークンを全部失効させ Cookie を消し、30 日後に保存データを消す (それまでは support@ への連絡で取り消せる)
   * Input : なし。Output: なし (結果は message と状態に出す)
   */
  private async deleteAccount(): Promise<void> {
    if (!this.signedIn()) { this.message = t("アカウントの削除は、サインインしてから行えます"); this.emit(); return; }
    let accepted: { wipeAt?: string };
    try {
      const res = await this.doFetch(`${this.server}/v1/account`, { method: "DELETE", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      if (!res.ok) { this.message = t("アカウントを削除できませんでした (サーバーの応答: {status})", { status: res.status }); this.emit(); return; }
      accepted = (await res.json().catch(() => ({}))) as { wipeAt?: string };
    } catch {
      this.message = t("サーバーと通信できませんでした。アカウントは削除されていません"); this.emit(); return;
    }
    await this.signOut();
    this.message = t("アカウントの削除を受け付けました。保存データは {date} に消えます (それまでは support@boxglow.app への連絡で取り消せます)", { date: accepted.wipeAt ? accepted.wipeAt.slice(0, 10) : t("30 日後") });
    this.emit();
  }

  // ---------------------------------------------------------------- 開始の手順 (同期を始める / サーバーの計画を受け取る)

  private beginSync(file: string): void {
    if (this.startups.get(file)?.stage === "working") return;
    this.startups.set(file, { operationId: crypto.randomUUID(), stage: "choose" });
    this.emit();
  }
  private async continueStart(file: string, operationId: string, intent?: "new" | "existing"): Promise<void> {
    const op = this.startups.get(file);
    if (!op || op.operationId !== operationId || op.stage === "working") return;
    if (intent) op.intent = intent;
    if (!op.intent) return;
    const unsafe = serverProblem(this.server);
    if (unsafe) { op.error = unsafe; op.stage = "choose"; this.emit(); return; }
    await this.refreshAccount();
    if (!this.signedIn()) { op.stage = "signin"; this.emit(); return; }
    op.credentials = this.generation;
    if (op.intent === "existing") { await this.listProjects(file, operationId); return; }
    // この計画を新しくサーバーに置く (本体が結び付けを作り、送る)
    op.stage = "working"; op.error = undefined; this.emit();
    await this.syncFile(file, {});
    if (this.startups.get(file) !== op) return;
    const result = this.results.get(file)?.result;
    if (result && result.status !== "error" && result.status !== "busy") { this.enable(file); this.startups.delete(file); }
    else { op.stage = "choose"; op.error = t("開始できませんでした。接続とサインインを確認して再試行してください。"); }
    this.emit();
  }
  private async listProjects(file: string, operationId: string, cursor?: string): Promise<void> {
    const op = this.startups.get(file), credentials = this.generation;
    if (!op || op.operationId !== operationId || op.stage === "working") return;
    op.stage = "working"; op.error = undefined; op.credentials = credentials; this.emit();
    try {
      const res = await this.doFetch(`${this.server}/v1/projects?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { redirect: "error" });
      if (this.startups.get(file) !== op || credentials !== this.generation) return;
      if (res.status === 401 || res.status === 403) { this.generation++; this.account = null; op.stage = "signin"; return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as { projects?: unknown; nextCursor?: unknown } | unknown[];
      if (this.startups.get(file) !== op || credentials !== this.generation) return;
      if (Array.isArray(body) || !Array.isArray((body as { projects?: unknown }).projects)) { op.unsupported = true; op.projects = []; return; }
      const list = (body as { projects: unknown[]; nextCursor?: unknown }).projects;
      op.projects = list.filter((p): p is { id: string; name: string; revision: string; updatedAt: string | null; bytes: number } => typeof p === "object" && p !== null && typeof (p as { id?: unknown }).id === "string")
        .map((p) => ({ id: p.id, name: String(p.name ?? ""), revision: String(p.revision ?? ""), updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : null, bytes: Number(p.bytes) || 0 }));
      op.nextCursor = typeof (body as { nextCursor?: unknown }).nextCursor === "string" ? (body as { nextCursor: string }).nextCursor : null;
      op.unsupported = false;
    } catch (e) { op.error = t("一覧を取得できませんでした: {error}", { error: e instanceof Error ? e.message : String(e) }); }
    finally { if (this.startups.get(file) === op && op.stage === "working") op.stage = "list"; this.emit(); }
  }
  /**
   * サーバーの計画を受け取る: 中身を取得して、その計画 id のブラウザ内の計画として保存し、結び付けて開く
   * (ブラウザでは「今開いているファイル」への受け取りはしない: 計画 id が置き場の鍵なので、受け取った計画は自分の id の置き場に入る)
   */
  private async openProject(file: string, action: Extract<HostAction, { kind: "openProject" }>): Promise<void> {
    const op = this.startups.get(file);
    if (!op || op.operationId !== action.operationId || op.stage !== "list") return;
    if (op.credentials !== this.generation) { op.error = t("表示したときから、状態が変わっています。選び直してください"); this.emit(); return; }
    op.stage = "working"; op.error = undefined; this.emit();
    try {
      const res = await this.doFetch(`${this.server}/v1/projects/${encodeURIComponent(action.projectId)}`, { redirect: "error" });
      if (res.status === 401 || res.status === 403) throw new Error(t("サインインが確かめられませんでした。サインインし直してください"));
      if (!res.ok) throw new Error(t("選んだ計画はサーバーにありません。一覧から選び直してください。"));
      const text = await res.text();
      const plan = fromJSON(text);
      const existing = await loadProject(plan.id);
      // 既に同じ id の計画がブラウザにあれば、それを置き換えない (結び付けて、同期の本体に比較させる)
      if (!existing) await saveProject(plan);
      const io = browserSyncIO(plan.id, this.server);
      const result = await runSync({ server: this.server, remoteId: action.projectId, requireRemote: true, fetch: this.doFetch, now: () => new Date(this.now()) }, io);
      this.results.set(plan.id, { result, at: this.now(), credentials: this.generation });
      this.knownBindings.set(plan.id, { server: this.server, remoteId: action.projectId });
      this.enable(plan.id);
      this.startups.delete(file);
      op.stage = "opened"; op.opened = { path: plan.id };
      this.options.onOpened?.(plan.id);
    } catch (e) {
      op.stage = "list";
      op.error = e instanceof Error ? e.message : t("計画を開けませんでした。接続と現在の一覧を確認してください。");
    }
    this.emit();
  }

  // ---------------------------------------------------------------- 同期の実行

  private enable(file: string): void { this.enabled.add(file); saveEnabled(this.enabled); void this.syncFile(file, {}); }
  private disable(file: string): void { this.enabled.delete(file); saveEnabled(this.enabled); this.emit(); }
  /** 常時の同期の 1 回 (開いていて有効な計画を順に)。file を渡すと、その計画だけ */
  private async tick(file?: string): Promise<void> {
    if (this.paused || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    await this.refreshAccount();
    if (!this.signedIn()) { this.emit(); return; }
    for (const id of file ? [file] : [...this.open.keys()]) if (this.enabled.has(id)) await this.syncFile(id, {});
  }
  private async syncFile(file: string, extra: Partial<SyncOptions>): Promise<void> {
    await this.refreshAccount();
    if (!this.signedIn()) { this.message = t("先にサインインしてください"); this.emit(); return; }
    const credentials = this.generation;
    this.busy++; this.emit();
    try {
      const io = browserSyncIO(file, this.server);
      const result = await runSync({ server: this.server, fetch: this.doFetch, now: () => new Date(this.now()), ...extra }, io);
      this.results.set(file, { result, at: this.now(), credentials });
      this.network = null;
      // 結び付け (サーバー側の計画の ID) は、保存した状態から読む (初回の送りで決まる)
      try { const state = await io.readState(); if (state) this.knownBindings.set(file, { server: this.server, remoteId: state.binding.remoteId }); } catch { /* 状態が読めないときは、次の結果で */ }
      // 受け取った・手元だけを直した: 画面に読み直してもらう。そろったときの手元のハッシュも控える
      if ((result.status === "synced" || result.status === "halted") && (result.pulled > 0 || result.edited > 0)) this.options.onLocalChanged?.(file);
      if (result.status === "synced") this.localHashes.set(file, result.localHash);
    } catch (e) {
      this.results.set(file, { result: { status: "error", error: e }, at: this.now(), credentials });
      if (e instanceof SyncNetworkError && !(e instanceof SyncAuthError)) this.network = { at: this.now(), message: t("サーバーと通信できませんでした") };
      if (e instanceof SyncAuthError) { this.generation++; this.account = null; }
    } finally { this.busy--; this.emit(); }
  }
  /** 人の選択 (競合・初回・結び直し・受け取りの再開・消えた項目) を、同期の指定に写して実行する */
  private async choose(choiceId: string, file: string | null, resolution?: ConflictResolution): Promise<void> {
    const c = this.choices.get(choiceId);
    if (!c || c.file !== file) { this.message = t("その選択は、今の表示のものではありません。表示を確かめてから、選び直してください"); this.emit(); return; }
    if (c.credentials !== this.generation) { this.message = t("表示したときから、状態が変わっています。選び直してください"); this.emit(); return; }
    const a = c.action;
    if (resolution && (a.kind !== "resolve" || resolution.token !== a.token || !parseConflictResolution(resolution))) { this.message = t("表示したときから、状態が変わっています。選び直してください"); this.emit(); return; }
    const extra: Partial<SyncOptions> =
      a.kind === "reconnectRestored" ? { reconnectRestored: a.token }
      : a.kind === "resolve" ? { resolution: resolution ?? { token: a.token, prefer: a.prefer } }
      : a.kind === "link" ? { remoteId: c.remoteId, firstLink: { token: a.token, prefer: a.prefer } }
      : a.kind === "relink" ? { relink: { token: a.token, prefer: a.prefer } }
      : a.kind === "recover" ? { recover: { token: a.token, applied: a.applied } }
      : a.kind === "adopt" ? { approvedDeletion: a.approval }
      : a.kind === "restore" ? { restoreDeletion: a.approval }
      : { confirmAccount: a.account };
    this.message = undefined;
    await this.syncFile(file, { ...extra, expectGeneration: c.generation });
  }

  // ---------------------------------------------------------------- 画面からの操作と状態

  /** 操作を受ける。結果は状態で返す */
  async act(file: string | null, action: HostAction): Promise<SyncStatus> {
    switch (action.kind) {
      case "beginSync": if (file) this.beginSync(file); break;
      case "cancelBegin": if (file && this.startups.get(file)?.stage !== "working") { this.startups.delete(file); if (this.signingIn && !this.signingIn.link) this.cancelSignIn(); } break;
      case "continueStart": if (file) await this.continueStart(file, action.operationId, action.intent); break;
      case "listProjects": if (file) await this.listProjects(file, action.operationId, action.cursor); break;
      case "openProject": if (file) await this.openProject(file, action); break;
      case "enable": if (file) this.enable(file); break;
      case "disable": if (file) this.disable(file); break;
      case "signIn": this.signIn(action.provider); break;
      case "linkIdentity": if (this.signedIn()) this.signIn(action.provider, true); break;
      case "cancelSignIn": this.cancelSignIn(); break;
      case "signOut": await this.signOut(); break;
      case "deleteAccount": await this.deleteAccount(); break;
      case "billingCheckout": await this.billingLinkFor("checkout", action.plan, action.seats); break;
      case "billingPortal": await this.billingLinkFor("portal"); break;
      case "billingDismiss": this.billingLink = undefined; this.emit(); break;
      case "pause": this.paused = true; break;
      case "resume": this.paused = false; break;
      case "bind": case "syncNow": if (file) await this.syncFile(file, {}); break;
      case "choose": await this.choose(action.choiceId, file); break;
      case "resolveGroups": await this.choose(action.choiceId, file, action.resolution); break;
      case "listVersions": case "previewRevert": case "confirmLifecycle": case "cancelLifecycle": case "listShares": case "createShare": case "revokeShare": if (file) await this.lifecycleAction(file, action); break;
      case "listTrash": case "previewDelete": case "previewRestore":
        this.message = t("サーバーの計画の削除と復元は、ブラウザ版ではまだ使えません (npx boxglow remote か、serve / VS Code の画面で)"); break;
    }
    return this.status(file);
  }

  /**
   * 履歴の操作 (listVersions / previewRevert / confirmLifecycle / cancelLifecycle)。Node の host の lifecycleAction と同じ約束:
   * 選択 ID と資格情報の世代が表示したときと同じときだけ確定する。戻すときは手元の計画を控えてから置き換え、画面に知らせ、すぐ同期する
   */
  private async lifecycleAction(file: string, action: HostAction): Promise<void> {
    const old = this.lifecycles.get(file);
    if (old?.state.busy) return;
    if (action.kind === "cancelLifecycle") { this.lifecycles.delete(file); this.emit(); return; }
    if (!this.signedIn()) { this.message = t("先にサインインしてください"); this.emit(); return; }
    if (action.kind === "confirmLifecycle" && (!old?.state.preview || old.state.choiceId !== action.choiceId || old.credentials !== this.generation)) {
      this.lifecycles.delete(file); this.message = t("表示したときから、状態が変わっています。選び直してください"); this.emit(); return;
    }
    const entry = action.kind === "confirmLifecycle" ? old! : { state: { choiceId: crypto.randomUUID(), busy: false } as NonNullable<SyncStatus["lifecycle"]>, credentials: this.generation };
    this.lifecycles.set(file, entry); entry.state.busy = true; entry.state.error = undefined; this.emit();
    try {
      if (action.kind === "listVersions") {
        const res = await this.doFetch(`${this.server}/v1/projects/${encodeURIComponent(action.projectId)}/versions`, { redirect: "error" });
        if (!res.ok) throw new Error(t("履歴を読めませんでした (サーバーの応答: {status})", { status: res.status }));
        entry.state.versions = parseVersionList(await res.json()); entry.state.versionsOf = action.projectId;
      }
      // 共有リンク: 一覧・作る (URL は作ったときだけ)・失効 (Cookie のセッション)
      if (action.kind === "listShares" || action.kind === "createShare" || action.kind === "revokeShare") {
        const base = `${this.server}/v1/projects/${encodeURIComponent(action.projectId)}/shares`;
        if (action.kind === "createShare") {
          const res = await this.doFetch(base, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresInDays: action.expiresInDays }) });
          const body = await res.json().catch(() => ({})) as { id?: unknown; token?: unknown; expiresAt?: unknown; code?: unknown; limit?: unknown };
          if (res.status === 409 && body.code === "quota") throw new Error(t("共有リンクは {n} 本までです。使わないリンクを失効させてください", { n: String(body.limit ?? "") }));
          if (!res.ok || typeof body.id !== "string" || typeof body.token !== "string") throw new Error(t("共有リンクを作れませんでした (サーバーの応答: {status})", { status: res.status }));
          entry.state.newShare = { id: body.id, url: shareUrl(body.token, this.server), expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null };
        }
        if (action.kind === "revokeShare") {
          const res = await this.doFetch(`${base}/${encodeURIComponent(action.shareId)}`, { method: "DELETE", redirect: "error" });
          if (!res.ok) throw new Error(t("共有リンクを失効できませんでした (サーバーの応答: {status})", { status: res.status }));
          if (entry.state.newShare?.id === action.shareId) entry.state.newShare = undefined;
        }
        const list = await this.doFetch(base, { redirect: "error" });
        if (!list.ok) throw new Error(t("共有リンクの一覧を読めませんでした (サーバーの応答: {status})", { status: list.status }));
        entry.state.shares = parseShareList(await list.json()); entry.state.sharesOf = action.projectId;
      }
      if (action.kind === "previewRevert") {
        const res = await this.doFetch(`${this.server}/v1/projects/${encodeURIComponent(action.projectId)}/versions/${encodeURIComponent(action.revision)}`, { redirect: "error" });
        if (!res.ok) throw new Error(t("履歴を読めませんでした (サーバーの応答: {status})", { status: res.status }));
        const text = await res.text();
        entry.text = text;
        entry.state.preview = { kind: "revert", id: action.projectId, name: planNameOf(text, action.projectId), account: this.account?.account?.accountId ?? "", revision: action.revision };
      }
      if (action.kind === "confirmLifecycle") {
        const preview = entry.state.preview!;
        if (preview.kind !== "revert" || typeof entry.text !== "string") throw new Error(t("計画の操作を完了できませんでした。状態を確認してください。"));
        await applyRevert(browserSyncIO(file, this.server), entry.text);
        entry.state.preview = undefined; entry.text = undefined;
        entry.state.message = t("版 {rev} の中身に戻しました。置き換える前の控え: {path}。次の同期で新しい版として送られます。", { rev: preview.revision, path: t("このブラウザの保存先") });
        this.options.onLocalChanged?.(file);
        await this.syncFile(file, {});
      }
    } catch (e) { entry.state.error = e instanceof Error ? e.message : String(e); }
    finally {
      entry.state.busy = false;
      if (entry.credentials !== this.generation) this.lifecycles.delete(file);
      this.emit();
    }
  }

  /** 申し込み / 契約の管理の URL (最新の 1 つ。サインアウトで消す) */
  private billingLink: SyncStatus["billingLink"];
  /** 課金の画面の URL をサーバーにもらう (Cookie のセッション)。結果は status.billingLink */
  private async billingLinkFor(kind: "checkout" | "portal", plan?: "personal" | "team", seats?: number): Promise<void> {
    if (!this.signedIn()) { this.message = t("先にサインインしてください"); this.emit(); return; }
    this.billingLink = undefined;
    try {
      const res = await this.doFetch(`${this.server}/v1/billing/${kind}`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(kind === "checkout" ? { plan, seats } : {}) });
      const body = await res.json().catch(() => ({})) as { url?: unknown; code?: unknown };
      if (!res.ok || typeof body.url !== "string" || !/^https:\/\//.test(body.url)) {
        this.message = res.status === 409 && body.code === "already-subscribed" ? t("すでに契約があります。契約の管理から変更してください")
          : res.status === 503 ? t("このサーバーでは、課金はまだ使えません")
          : t("課金の画面を用意できませんでした (サーバーの応答: {status})", { status: res.status });
        this.emit(); return;
      }
      this.billingLink = { kind, url: body.url, ...(plan ? { plan } : {}) };
      this.message = undefined;
      this.account = null;
    } catch { this.message = t("サーバーと通信できませんでした"); }
    this.emit();
  }

  /** 今の状態を組み立てる (file = 今の画面の計画 id) */
  status(file: string | null): SyncStatus {
    const account = this.account?.account;
    const status: SyncStatus = {
      session: this.session, seq: ++this.seq, support: "ok"
    , credentials: { source: account ? "stored" : "none", ...(account ? { account } : {}) }
    , owner: "self", server: this.server, isDefaultServer: isDefaultSyncServer(this.server)
    , ...(file && this.startups.has(file) ? { startup: (({ credentials: _c, ...safe }) => safe)(this.startups.get(file)!) } : {})
    , file: file ? { path: file, enabled: this.enabled.has(file), binding: this.bindingOf(file) } : null
    , ...(file && this.lifecycles.has(file) ? { lifecycle: this.lifecycles.get(file)!.state } : {})
    , state: "off", revision: null
    , ...(this.signingIn?.code ? { signIn: this.signingIn.code } : {})
    , ...(this.message ? { message: this.message } : {})
    , ...(this.notInvited ? { notInvited: this.notInvited } : {})
    , ...(this.billingLink ? { billingLink: this.billingLink } : {})
    };
    const unsafe = serverProblem(this.server);
    if (unsafe) { status.state = "problem"; status.problem = { kind: "configuration", text: unsafe, fix: "server-setting" }; return status; }
    if (!account) { status.state = "signed-out"; return status; }
    if (!file) { status.state = "off"; return status; }
    if (!status.file!.binding && !this.enabled.has(file)) { status.state = "unbound"; return status; }
    if (this.busy > 0) status.state = "syncing";
    const last = this.results.get(file);
    if (!last) { status.state = this.paused && this.busy === 0 ? "paused" : "syncing"; return status; }
    const r = last.result;
    if (r.status === "error") {
      const e = r.error;
      status.state = "problem";
      status.problem = e instanceof SyncPaymentError ? { kind: "payment", text: t("有料プランの契約が必要です"), fix: "billing" }
        : e instanceof SyncAuthError ? { kind: "auth", text: t("サーバーが利用者を確かめられませんでした"), fix: "credentials" }
        : e instanceof SyncRejectedError ? { kind: "rejected", text: t("サーバーが、この計画の同期を受け付けませんでした (待っても直りません)"), fix: "rerun" }
        : e instanceof SyncNetworkError ? { kind: "network", text: t("サーバーと通信できませんでした"), fix: "wait" }
        : { kind: "busy", text: e instanceof Error ? e.message : String(e), fix: "rerun" };
      if (status.problem?.kind === "network") status.state = "offline";
      return status;
    }
    if (this.paused && r.status !== "halted") { status.state = "paused"; return status; }
    if (r.status === "busy") { status.state = "syncing"; return status; }
    if (r.status === "halted") {
      status.state = "halted";
      const view = haltView(r, file);
      const choiceIds: Record<string, string> = {};
      for (const item of view.items) {
        if (item.kind !== "choice") continue;
        const id = `${this.session}:${crypto.randomUUID().slice(0, 8)}`;
        this.choices.set(id, { action: item.action, file, remoteId: view.target.remoteId, generation: (r as { stateGeneration?: number }).stateGeneration ?? null, credentials: last.credentials });
        choiceIds[item.id] = id;
      }
      const resolveItem = view.items.find((item) => item.kind === "choice" && item.action.kind === "resolve");
      status.halt = { ...view, choiceIds, ...(view.review && resolveItem?.kind === "choice" ? { resolutionChoiceId: choiceIds[resolveItem.id] } : {}) };
      return status;
    }
    status.revision = r.revision;
    // そろった: 最後に確かめた手元の中身が、今の手元と同じなら synced。違えば unsent (保存の直後に送る)
    const current = this.localHashes.get(file);
    status.state = r.localHash === current && last.credentials === this.generation && status.state !== "syncing" ? "synced" : status.state === "syncing" ? "syncing" : "unsent";
    if (this.network && this.now() - this.network.at < 60_000) { status.state = "offline"; status.problem = { kind: "network", text: this.network.message, fix: "wait" }; }
    return status;
  }
  /** 今の手元の中身のハッシュ (画面が保存のたびに知らせる。synced / unsent の判定に使う) */
  private readonly localHashes = new Map<string, string | null>();
  /** 画面が計画を保存したときに、中身を知らせる (ハッシュを控え、少し待ってから送る) */
  noteLocalContent(projectId: string, project: Parameters<typeof toJSON>[0] | null): void {
    this.localHashes.set(projectId, project ? sha256Hex(toJSON(project) + "\n") : null);
    this.notifyLocalChange(projectId);
    this.emit();
  }
  /** 結び付け (状態を読まずに、最後の結果から) */
  private readonly knownBindings = new Map<string, { server: string; remoteId: string }>();
  private bindingOf(file: string): { server: string; remoteId: string } | null { return this.knownBindings.get(file) ?? null; }
  /** 開いた計画の結び付けを、保存した状態から読む (起動時。結果が無くても「結び付け済み」と出すため) */
  async loadBinding(projectId: string): Promise<void> {
    const state = await browserSyncIO(projectId, this.server).readState();
    if (state) this.knownBindings.set(projectId, { server: this.server, remoteId: state.binding.remoteId });
    this.emit();
  }

  /** 状態が変わったことを画面へ知らせる */
  private emit(): void {
    if (!this.options.onStatus) return;
    void this.refreshAccount().then(() => { for (const file of this.open.size ? this.open.keys() : [null]) this.options.onStatus?.(this.status(file)); });
  }
}

function loadEnabled(): string[] { try { return JSON.parse(localStorage.getItem(ENABLED_KEY) ?? "[]") as string[]; } catch { return []; } }
function saveEnabled(set: Set<string>): void { try { localStorage.setItem(ENABLED_KEY, JSON.stringify([...set])); } catch { /* 保存できなくても動く */ } }
function randomBase64url(bytes: number): string {
  const buf = new Uint8Array(bytes); crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
