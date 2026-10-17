/**
 * 試験用の同期サーバー (メモリの中だけ。サインイン無し、localhost だけ)
 * 同期のクライアント (cli/sync/client.ts) が前提にしている約束を、そのまま実装した最小のもの:
 *   GET /v1/projects      -> 200 計画の一覧 [{ id, revision, deleted }] (全部の計画の最新の版を 1 回で確かめるため)
 *   GET /v1/projects/:id/ops/:op -> 200 { revision } (その操作が受理されていれば版、記録が無ければ null。表示と調査用)
 *   POST /v1/projects/:id/ops/:op/settle -> 操作の結果を確定させる (x-boxglow-epoch が必須。違えば 409): 受理済みなら { revision }、
 *        未受理なら「今後も受理しない」と記録して { revision: null, cancelled: true }。記録した操作 ID の PUT は、後から届いても 422 で断る
 *   GET /v1/projects/:id  -> 200 中身 (ETag = 版) / 404 まだ無い / 410 消されている。どの応答にも x-boxglow-epoch (履歴の世代)
 *   PUT /v1/projects/:id  <- 中身。If-Match: "<版>" (置き換え) か If-None-Match: * (作成)、x-boxglow-op (操作 ID) が必須
 *        200 / 201 受理 (ETag = 新しい版) / 412 前提の版が違う / 409 履歴の世代が違う / 410 消されている / 428 前提なし / 422 同じ操作 ID で違う要求
 * どの応答にも x-boxglow-account (サーバーが確かめた利用者の ID) を付ける。利用者は Authorization: Bearer <名前> で決まる (省くと "test")。
 * 計画は利用者ごとの名前空間にある (別の利用者が同じ ID を使っても、別の計画)。
 * 置き換えは「同じ操作の結果があればそれを返す → 無ければ前提の版を確かめる → 合えば確定」を、割り込まれない 1 つの処理で行う。
 * 本番のサーバー (別のリポジトリ) も、同じ約束を守る
 */
import { createHash } from "node:crypto";
import { validateProjectText } from "../../src/model/validate-file";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

interface StoredProject {
  head: { revision: string; text: string; updatedAt?: string } | null;
  deleted: boolean;
  seq: number;
  /** 操作 ID → { 要求の印 (中身のハッシュと前提の版), 受理された版 } */
  ops: Map<string, { request: string; revision: string }>;
  /** 受理した版の一覧 (履歴)。at は受理した時刻 */
  versions: { revision: string; hash: string; text: string; at: string }[];
}

export class TestSyncServer {
  /** サーバーの履歴の世代 (バックアップからの復旧を模すときに変える) */
  epoch = "e1";
  /** 既定の利用者 ("test") の計画 */
  projects = new Map<string, StoredProject>();
  /** 利用者の ID → その利用者の計画 (既定の利用者は projects と同じもの) */
  accounts = new Map<string, Map<string, StoredProject>>([["test", this.projects]]);
  /** 利用者の ID → 「受理しない」と確定した操作 (計画の ID と操作 ID の組) */
  cancelled = new Map<string, Set<string>>();
  /** 受け取った「操作の確定」の要求の数 */
  settles = 0;
  /** true にすると、次の「操作の確定」を処理した後、応答を返さずに接続を切る。1 回で false に戻る */
  dropNextSettleResponse = false;
  /** サインインの手順: device_code → 状態 ("pending" / "slow_down" / "denied" / "not-invited"、または許可された利用者) */
  deviceCodes = new Map<string, "pending" | "slow_down" | "denied" | "not-invited" | { account: string; login: string }>();
  /** Google の取引: id → 状態。試験が approveGoogle(id, user) で「許可された」ことにする */
  googleTx = new Map<string, { claimHash: string; status: "pending" | "ready" | "denied"; token?: string; account?: string; link?: string }>();
  /** Google のサインインを許可したことにする (トークンを発行して取引に置く) */
  approveGoogle(id: string, user: { account: string; login: string } | "denied"): void {
    const tx = this.googleTx.get(id);
    if (!tx) return;
    if (user === "denied") { tx.status = "denied"; return; }
    // 結び付けの取引: トークンは発行せず、手段を足すだけ (link = 結び付け先の利用者)
    if (tx.link) { const list = this.identities.get(tx.link) ?? ["github"]; if (!list.includes("google")) list.push("google"); this.identities.set(tx.link, list); tx.status = "ready"; tx.account = tx.link; return; }
    const token = `tok-${user.account}-${this.issued.size + 1}`;
    this.issued.set(token, user);
    tx.status = "ready"; tx.token = token; tx.account = user.account;
  }
  /** 発行したトークン → 利用者 (発行していないトークンは、文字列そのものを利用者の ID として扱う) */
  issued = new Map<string, { account: string; login: string }>();
  /** 利用者 → 付いているサインインの手段 (結び付けの試験用。無ければ ["github"]) */
  identities = new Map<string, ("github" | "google")[]>();
  /** 取り消したトークン */
  revoked = new Set<string>();
  /** 本人の操作で削除を受け付けた利用者 (DELETE /v1/account) */
  deletedAccounts = new Set<string>();
  /** 共有リンク: id → { token, projectId, revoked, expiresAt } (利用者ごと) */
  shares = new Map<string, { id: string; token: string; account: string; projectId: string; revoked: boolean; expiresAt: string | null; createdAt: string }>();
  /** AI エージェント用トークン (利用者ごと): id → { name, projectId, write, revoked, requests } */
  agentTokens = new Map<string, { id: string; token: string; account: string; name: string; projectId: string; write: boolean; revoked: boolean; createdAt: string; requests: number }>();
  /** 課金の再現: required = 契約を求める (契約の無い利用者の同期は 402)、subscribed = 契約のある利用者、customers = 顧客のできた利用者 */
  billing = { required: false, subscribed: new Set<string>(), customers: new Set<string>(), calls: [] as { kind: string; account: string; body: unknown }[] };
  private codes = 0;
  /** 中身の大きさの上限 (バイト)。超えた PUT は、操作の照合より前に 413 で断る (本番のサーバーと同じ順) */
  maxBytes = Infinity;
  /** true にすると、次の PUT を処理した後、応答を返さずに接続を切る (応答の紛失の再現)。1 回で false に戻る */
  dropNextPutResponse = false;
  /** 受け取った PUT の数 (送り直しの確認用) */
  puts = 0;
  /** 受け取った一覧の要求の数 (確認を 1 回にまとめているかの確認用) */
  lists = 0;
  private server: Server | null = null;
  url = "";

  /** 起動する (空いているポートを使う)。Output: サーバーの URL */
  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((done) => this.server!.listen(0, "127.0.0.1", done));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    return this.url;
  }
  async stop(): Promise<void> {
    await new Promise<void>((done) => this.server ? this.server.close(() => done()) : done());
  }
  /** 計画の今の状態 (試験の確認用) */
  project(id: string, account = "test"): StoredProject | undefined { return this.accounts.get(account)?.get(id); }
  /** 利用者の名前空間 (無ければ作る) */
  private space(account: string): Map<string, StoredProject> {
    let space = this.accounts.get(account);
    if (!space) { space = new Map(); this.accounts.set(account, space); }
    return space;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ---- ブラウザだけの画面の検査用: CORS (試験ではどのオリジンでも許す) と、HttpOnly Cookie のセッション (本番の入口と同じ約束) ----
    const origin = req.headers.origin;
    const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "origin", "access-control-expose-headers": "etag, x-boxglow-epoch, x-boxglow-account, x-boxglow-version, retry-after" } : {};
    if (req.method === "OPTIONS") { res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "access-control-allow-headers": req.headers["access-control-request-headers"] ?? "content-type, authorization", "access-control-max-age": "600" }); res.end(); return; }
    const cookieToken = /(?:^|;\s*)bgl_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    // Authorization が無く Cookie があれば、Cookie の値をトークンとして扱う (本番と同じ。Origin の照合は試験では省く)
    if (!req.headers.authorization && cookieToken) req.headers.authorization = `Bearer ${decodeURIComponent(cookieToken)}`;
    const plain = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors, ...headers }); res.end(JSON.stringify(body)); };
    // 共有リンクで読む (誰でも。トークンなし)
    const shareRead = /^\/v1\/shares\/([^/]+)$/.exec(req.url ?? "");
    if (shareRead && req.method === "GET") {
      const token = decodeURIComponent(shareRead[1]);
      const s = [...this.shares.values()].find((x) => x.token === token && !x.revoked && (x.expiresAt === null || x.expiresAt > new Date().toISOString()));
      const head = s ? this.space(s.account).get(s.projectId)?.head : undefined;
      if (!s || !head) { plain(404, { code: "not-found" }, { "access-control-allow-origin": "*" }); return; }
      plain(200, { text: head.text, name: (JSON.parse(head.text) as { name?: string }).name ?? s.projectId, revision: head.revision, projectId: s.projectId }, { "access-control-allow-origin": "*" }); return;
    }
    if (req.method === "OPTIONS" && req.url?.startsWith("/v1/shares/")) { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" }); res.end(); return; }
    if (req.method === "POST" && req.url === "/v1/session") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const user = token ? this.issued.get(token) : undefined;
      if (!token || !user || this.revoked.has(token)) { plain(401, { code: "unauthorized" }); return; }
      plain(200, { account: user.account, login: user.login }, { "set-cookie": `bgl_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000` });
      return;
    }
    if (req.method === "DELETE" && req.url === "/v1/session") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (token) this.revoked.add(token);
      plain(200, { signedOut: true }, { "set-cookie": "bgl_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
      return;
    }
    if (req.method === "POST" && req.url === "/v1/auth/device") {
      const code = "dc" + String(++this.codes).padStart(38, "0");
      this.deviceCodes.set(code, "pending");
      plain(200, { device_code: code, user_code: "TEST-" + this.codes, verification_uri: `${this.url}/fake/github/login/device`, interval: 1, expires_in: 900 });
      return;
    }
    // ---- Google のサインイン (取引の仲立ち。本番と同じ約束。試験は googleTx の状態を直接変えて「許可された」ことにする) ----
    if (req.method === "POST" && req.url === "/v1/auth/google/start") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const startBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { claimHash?: unknown; link?: unknown };
      const claimHash = String(startBody.claimHash ?? "");
      const id = `tx-${++this.codes}`;
      // 結び付け (link: true): サインイン済みのトークンの利用者を取引に控える
      const linkBearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const linkTo = startBody.link === true ? (linkBearer ? this.issued.get(linkBearer)?.account : undefined) : undefined;
      if (startBody.link === true && !linkTo) { plain(401, { code: "unauthorized" }); return; }
      this.googleTx.set(id, { claimHash, status: "pending", ...(linkTo ? { link: linkTo } : {}) });
      plain(200, { id, url: `https://accounts.google.com/o/oauth2/v2/auth?state=${id}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
      return;
    }
    if (req.method === "POST" && (req.url === "/v1/auth/google/claim" || req.url === "/v1/auth/google/cancel")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { id?: string; claimSecret?: string };
      const tx = this.googleTx.get(String(body.id));
      const hash = createHash("sha256").update(String(body.claimSecret ?? "")).digest("hex");
      if (!tx || tx.claimHash !== hash) { plain(req.url.endsWith("cancel") ? 200 : 410, req.url.endsWith("cancel") ? { status: "gone" } : { code: "gone" }); return; }
      if (req.url.endsWith("cancel")) { this.googleTx.delete(String(body.id)); if (tx.status === "ready") this.revoked.add(tx.token!); plain(200, { status: tx.status === "pending" ? "cancelled" : "aborting" }); return; }
      if (tx.status === "pending") plain(200, { status: "pending" });
      else if (tx.status === "denied") { this.googleTx.delete(String(body.id)); plain(403, { code: "not-invited" }); }
      else if (tx.link) { this.googleTx.delete(String(body.id)); plain(200, { status: "ok", linked: "google", account: tx.account }); }
      else { this.googleTx.delete(String(body.id)); plain(200, { status: "ok", token: tx.token, account: tx.account }); }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/auth/device/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const tokenBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { device_code?: unknown; link?: unknown };
      const state = this.deviceCodes.get(String(tokenBody.device_code));
      // 結び付け (link: true): サインイン済みの利用者に GitHub を足す (トークンは発行しない)
      const linkBearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const linkTo = tokenBody.link === true ? (linkBearer ? this.issued.get(linkBearer)?.account : undefined) : undefined;
      if (tokenBody.link === true && !linkTo) plain(401, { code: "unauthorized" });
      else if (linkTo && typeof state === "object") { const list = this.identities.get(linkTo) ?? ["google"]; if (!list.includes("github")) list.push("github"); this.identities.set(linkTo, list); plain(200, { status: "ok", linked: "github", login: state.login }); }
      else if (state === undefined) plain(400, { code: "incorrect_device_code" });
      else if (state === "pending") plain(200, { status: "pending" });
      else if (state === "slow_down") plain(200, { status: "slow_down", interval: 2 });
      else if (state === "denied") plain(400, { code: "access_denied" });
      else if (state === "not-invited") plain(403, { code: "not-invited", login: "stranger", waitlist: "https://example.test/waitlist" });
      else {
        const token = `tok-${state.account}-${this.issued.size + 1}`;
        this.issued.set(token, state);
        plain(200, { status: "ok", token, account: state.account, login: state.login });
      }
      return;
    }
    // 利用者: 発行したトークンなら、その利用者。それ以外は、トークンの文字列を、そのまま利用者の ID として扱う (試験用)
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    // ブラウザ (Origin あり) からトークンも Cookie も無しの要求は、本番と同じく 401 (匿名の "test" 利用者にしない)
    if (origin && bearer === undefined) { plain(401, { code: "unauthorized" }); return; }
    if (bearer !== undefined && this.revoked.has(bearer)) { plain(401, { code: "unauthorized" }); return; }
    const account = bearer === undefined ? "test" : this.issued.get(bearer)?.account ?? bearer;
    const projects = this.space(account);
    const send = (status: number, body = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "x-boxglow-epoch": this.epoch, "x-boxglow-account": account, "content-type": "application/json; charset=utf-8", ...cors, ...headers });
      res.end(body);
    };
    if (req.method === "GET" && req.url === "/v1/identities") {
      send(200, JSON.stringify({ account, identities: this.identities.get(account) ?? ["github"] }));
      return;
    }
    const billingOf = () => ({ required: this.billing.required, entitled: !this.billing.required || this.billing.subscribed.has(account)
      , plan: this.billing.subscribed.has(account) ? "personal" : null, status: this.billing.subscribed.has(account) ? "active" : "none", seats: 1, periodEnd: null
      , checkout: !this.billing.subscribed.has(account), portal: this.billing.customers.has(account) });
    if (req.method === "GET" && req.url === "/v1/me") {
      send(200, JSON.stringify({ account, login: this.issued.get(bearer ?? "")?.login ?? account, devices: [{ name: "this", current: true }]
      , usage: { projects: projects.size, contentBytes: 1_500_000 }, limits: { projects: 10, contentBytes: 200_000_000 }, billing: billingOf() }));
      return;
    }
    // 課金の口 (本番と同じ形。URL は偽物)
    if (req.method === "GET" && req.url === "/v1/billing") { send(200, JSON.stringify(billingOf())); return; }
    if (req.method === "POST" && (req.url === "/v1/billing/checkout" || req.url === "/v1/billing/portal")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      const kind = req.url.endsWith("checkout") ? "checkout" : "portal";
      this.billing.calls.push({ kind, account, body });
      if (kind === "checkout" && this.billing.subscribed.has(account)) { send(409, JSON.stringify({ code: "already-subscribed" })); return; }
      if (kind === "portal" && !this.billing.customers.has(account)) { send(409, JSON.stringify({ code: "no-customer" })); return; }
      if (kind === "checkout") this.billing.customers.add(account);
      send(200, JSON.stringify({ url: `https://stripe.test/${kind}/${account}`, ...(kind === "checkout" ? { plan: body.plan, seats: body.plan === "team" ? body.seats ?? 2 : 1 } : {}) }));
      return;
    }
    // 契約を求めていて、この利用者に契約が無ければ、同期の要求は 402 (自分の情報・課金・サインアウトは上で済んでいる)
    if (this.billing.required && !this.billing.subscribed.has(account) && req.url?.startsWith("/v1/projects")) { send(402, JSON.stringify({ code: "payment-required" })); return; }
    if (req.method === "DELETE" && req.url === "/v1/account") {
      // 本人によるアカウントの削除: confirm: true が無ければ 400。受け付けたら、その利用者に発行したトークンを全部失効させ、削除済みに印を付ける
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { confirm?: unknown };
      if (body.confirm !== true) { send(400, JSON.stringify({ code: "confirmation-required" })); return; }
      for (const [tok, user] of this.issued) if (user.account === account) this.revoked.add(tok);
      if (bearer !== undefined) this.revoked.add(bearer);
      this.deletedAccounts.add(account);
      send(200, JSON.stringify({ deleted: true, wipeAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() }), { "set-cookie": "bgl_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
      return;
    }
    if (req.method === "DELETE" && req.url === "/v1/tokens/current") {
      if (bearer !== undefined) this.revoked.add(bearer);
      send(200, JSON.stringify({ revoked: true }));
      return;
    }
    // 一覧: 全部の計画の最新の版 (常時の同期は、これ 1 回で、どの計画が進んだかを確かめる)
    if (req.method === "GET" && req.url === "/v1/projects") {
      this.lists++;
      send(200, JSON.stringify([...projects.entries()].map(([id, p]) => ({ id, revision: p.head?.revision ?? null, deleted: p.deleted }))));
      return;
    }
    // 画面向けのページング。監視用の引数なし一覧とは応答を分ける。
    const listUrl = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && listUrl.pathname === "/v1/projects") {
      const raw = listUrl.searchParams.get("limit") ?? "20", limit = Number(raw), cursor = listUrl.searchParams.get("cursor") ?? "";
      if (!/^[0-9]+$/.test(raw) || !Number.isInteger(limit) || limit < 1 || limit > 100 || cursor.length > 256) { send(400, JSON.stringify({code:"bad-page"})); return; }
      const rows = [...projects.entries()].filter(([id,p]) => !p.deleted && p.head && id > cursor).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0);
      send(200, JSON.stringify({ projects: rows.slice(0,limit).map(([id,p]) => ({id, name:JSON.parse(p.head!.text).name, revision:p.head!.revision, updatedAt:p.head!.updatedAt ?? null, bytes:Buffer.byteLength(p.head!.text)})), nextCursor: rows.length > limit ? rows[limit-1][0] : null }));
      return;
    }
    // 操作の結果を確定させる: 受理済みならその版。未受理なら、その操作 ID を今後も受理しないと記録する (割り込まれない 1 つの処理)
    const settleMatch = /^\/v1\/projects\/([^/]+)\/ops\/([^/]+)\/settle$/.exec(req.url ?? "");
    if (settleMatch && req.method === "POST") {
      this.settles++;
      const epoch = req.headers["x-boxglow-epoch"];
      if (typeof epoch !== "string") { send(428, JSON.stringify({ code: "precondition-required" })); return; }
      if (epoch !== this.epoch) { send(409, JSON.stringify({ code: "history-changed" })); return; }
      const id = decodeURIComponent(settleMatch[1]), op = decodeURIComponent(settleMatch[2]);
      const done = projects.get(id)?.ops.get(op);
      if (!done) {
        let set = this.cancelled.get(account);
        if (!set) { set = new Set(); this.cancelled.set(account, set); }
        set.add(JSON.stringify([id, op]));
      }
      if (this.dropNextSettleResponse) { this.dropNextSettleResponse = false; req.socket.destroy(); return; }
      send(200, JSON.stringify(done ? { revision: done.revision } : { revision: null, cancelled: true }));
      return;
    }
    // 履歴: 版の一覧 (新しい順) と、その版の中身
    const versionsMatch = /^\/v1\/projects\/([^/]+)\/versions(?:\/([^/]+))?$/.exec(req.url ?? "");
    if (versionsMatch && req.method === "GET") {
      const project = projects.get(decodeURIComponent(versionsMatch[1]));
      if (!project || project.deleted) { send(404, JSON.stringify({ code: "absent" })); return; }
      if (versionsMatch[2] === undefined) { send(200, JSON.stringify([...project.versions].reverse().map((v) => ({ revision: v.revision, hash: v.hash, at: v.at, opId: "" })))); return; }
      const found = project.versions.find((v) => v.revision === decodeURIComponent(versionsMatch[2]!));
      if (!found) { send(404, JSON.stringify({ code: "absent" })); return; }
      send(200, found.text); return;
    }
    // 操作の結果の問い合わせ: 受理されていれば、その版。受理されていなければ null
    const opMatch = /^\/v1\/projects\/([^/]+)\/ops\/([^/]+)$/.exec(req.url ?? "");
    if (opMatch && req.method === "GET") {
      const done = projects.get(decodeURIComponent(opMatch[1]))?.ops.get(decodeURIComponent(opMatch[2]));
      send(200, JSON.stringify({ revision: done?.revision ?? null }));
      return;
    }
    // AI エージェント用トークン: 一覧・作る・失効 (本番と同じ形)
    const agentsMatch = /^\/v1\/agent-tokens(?:\/([^/]+))?$/.exec(req.url ?? "");
    if (agentsMatch) {
      const nowAt = new Date().toISOString();
      const list = () => [...this.agentTokens.values()].filter((a) => a.account === account).reverse().map((a) => ({ id: a.id, name: a.name, projectId: a.projectId, write: a.write, createdAt: a.createdAt, lastUsedAt: null, revoked: a.revoked, requests: a.requests }));
      if (agentsMatch[1] === undefined && req.method === "GET") { send(200, JSON.stringify({ tokens: list() })); return; }
      if (agentsMatch[1] === undefined && req.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { name?: string; projectId?: string; write?: boolean };
        if (!body.projectId || !projects.get(body.projectId)?.head) { send(404, JSON.stringify({ code: "absent" })); return; }
        const n = this.agentTokens.size + 1;
        const id = "ag" + String(n).padStart(6, "0");
        const token = `bga_acc${String(n).padStart(32, "0")}.${(id + "x".repeat(43)).slice(0, 43)}`;
        this.agentTokens.set(id, { id, token, account, name: body.name || "agent", projectId: body.projectId, write: body.write === true, revoked: false, createdAt: nowAt, requests: 0 });
        send(201, JSON.stringify({ id, token, name: body.name || "agent", projectId: body.projectId, write: body.write === true, createdAt: nowAt })); return;
      }
      if (agentsMatch[1] !== undefined && req.method === "DELETE") {
        const a = this.agentTokens.get(decodeURIComponent(agentsMatch[1]));
        if (a && a.account === account) a.revoked = true;
        send(200, JSON.stringify({ revoked: true })); return;
      }
    }
    // 共有リンク: 一覧・作る・失効 (本番と同じ形。トークンは bgs_<利用者>.<秘密> の見た目だけ合わせる)
    const sharesMatch = /^\/v1\/projects\/([^/]+)\/shares(?:\/([^/]+))?$/.exec(req.url ?? "");
    if (sharesMatch) {
      const projectId = decodeURIComponent(sharesMatch[1]);
      const nowAt = new Date().toISOString();
      const list = () => [...this.shares.values()].filter((s) => s.account === account && s.projectId === projectId).reverse().map((s) => ({ id: s.id, createdAt: s.createdAt, expiresAt: s.expiresAt, revoked: s.revoked, expired: s.expiresAt !== null && s.expiresAt <= nowAt }));
      if (sharesMatch[2] === undefined && req.method === "GET") { send(200, JSON.stringify({ shares: list() })); return; }
      if (sharesMatch[2] === undefined && req.method === "POST") {
        if (!projects.get(projectId)?.head) { send(404, JSON.stringify({ code: "absent" })); return; }
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { expiresInDays?: number };
        const active = [...this.shares.values()].filter((s) => s.account === account && !s.revoked).length;
        if (active >= 5) { send(409, JSON.stringify({ code: "quota", which: "shares", limit: 5 })); return; }
        const n = this.shares.size + 1;
        const id = "sh" + String(n).padStart(6, "0");
        const token = `bgs_acc${String(n).padStart(32, "0")}.${(id + "x".repeat(43)).slice(0, 43)}`;
        const expiresAt = typeof body.expiresInDays === "number" && body.expiresInDays > 0 ? new Date(Date.now() + body.expiresInDays * 86_400_000).toISOString() : null;
        this.shares.set(id, { id, token, account, projectId, revoked: false, expiresAt, createdAt: nowAt });
        send(201, JSON.stringify({ id, token, expiresAt, createdAt: nowAt })); return;
      }
      if (sharesMatch[2] !== undefined && req.method === "DELETE") {
        const s = this.shares.get(decodeURIComponent(sharesMatch[2]));
        if (s && s.account === account) s.revoked = true;
        send(200, JSON.stringify({ revoked: true })); return;
      }
    }
    const match = /^\/v1\/projects\/([^/]+)$/.exec(req.url ?? "");
    if (!match) { send(404, JSON.stringify({ code: "not-found" })); return; }
    const id = decodeURIComponent(match[1]);
    const project = projects.get(id);
    if (req.method === "GET") {
      if (project?.deleted) { send(410, JSON.stringify({ code: "deleted" })); return; }
      if (!project?.head) { send(404, JSON.stringify({ code: "absent" })); return; }
      send(200, project.head.text, { etag: `"${project.head.revision}"` });
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const text = Buffer.concat(chunks).toString("utf8");
      this.puts++;
      if (Buffer.byteLength(text) > this.maxBytes) { send(413, JSON.stringify({ code: "too-large" })); return; }
      const result = this.put(id, text, req.headers, projects, account);
      if (this.dropNextPutResponse) { this.dropNextPutResponse = false; req.socket.destroy(); return; }
      send(result.status, JSON.stringify(result.body), result.revision ? { etag: `"${result.revision}"` } : {});
      return;
    }
    send(405, JSON.stringify({ code: "method" }));
  }

  /**
   * 置き換え・作成を確定する (同期の処理。途中で他の要求が割り込まない)
   * Input : id = 計画の ID, text = 中身, headers = 要求のヘッダ, projects = 利用者の名前空間 (省くと既定の利用者), account = 利用者の ID
   * Output: 応答の状態コード・本文・(受理なら) 版
   */
  put(id: string, text: string, headers: IncomingMessage["headers"], projects = this.projects, account = "test"): { status: number; body: unknown; revision?: string } {
    const op = typeof headers["x-boxglow-op"] === "string" ? headers["x-boxglow-op"] : "";
    const ifMatch = typeof headers["if-match"] === "string" ? headers["if-match"].replace(/^"|"$/g, "") : null;
    const create = headers["if-none-match"] === "*";
    // 履歴の世代 (クライアントが操作を記録したときの世代) も必須。無い要求は受け付けない
    const epoch = typeof headers["x-boxglow-epoch"] === "string" ? headers["x-boxglow-epoch"] : null;
    if (!op || epoch === null || (!create && ifMatch === null)) return { status: 428, body: { code: "precondition-required" } };
    // (1) 履歴の世代と、対象の計画: 世代が今と違えば、412 とは別の応答にする。消した計画には、何も受け付けない (消した ID は二度と使わない)
    if (epoch !== this.epoch) return { status: 409, body: { code: "history-changed" } };
    const project: StoredProject = projects.get(id) ?? { head: null, deleted: false, seq: 0, ops: new Map(), versions: [] };
    if (project.deleted) return { status: 410, body: { code: "deleted" } };
    // 受け取る中身は、計画として検査する (JSON であるだけでは足りない)
    try { validateProjectText(text); } catch (e) { return { status: 400, body: { code: "invalid", message: e instanceof Error ? e.message : String(e) } }; }
    const hash = createHash("sha256").update(text).digest("hex");
    const request = JSON.stringify([hash, create ? null : ifMatch]);
    // (2) 同じ操作の結果が既にあれば、今の版との照合より先に、その結果を返す (違う要求なら断る)
    const done = project.ops.get(op);
    if (done) return done.request === request ? { status: 200, body: { revision: done.revision }, revision: done.revision } : { status: 422, body: { code: "operation-mismatch" } };
    // 「受理しない」と確定した操作は、適用しない (確定の後で届いた、遅れた要求)
    if (this.cancelled.get(account)?.has(JSON.stringify([id, op]))) return { status: 422, body: { code: "operation-cancelled" } };
    // (3) 前提の版を確かめる (同じ中身の送信でも省かない)
    if ((project.head?.revision ?? null) !== (create ? null : ifMatch)) return { status: 412, body: { code: "revision-mismatch" } };
    // 最新と同じ中身なら、新しい版を作らずに受理する (操作の結果は「今の版」)
    if (project.head && createHash("sha256").update(project.head.text).digest("hex") === hash) {
      project.ops.set(op, { request, revision: project.head.revision });
      return { status: 200, body: { revision: project.head.revision }, revision: project.head.revision };
    }
    // (4) 確定する: 最新の版・履歴・操作の結果を一緒に
    const revision = `${this.epoch}.${++project.seq}`;
    project.head = { revision, text, updatedAt:new Date().toISOString() };
    project.versions.push({ revision, hash, text, at: project.head.updatedAt! });
    project.ops.set(op, { request, revision });
    projects.set(id, project);
    return { status: create ? 201 : 200, body: { revision }, revision };
  }
}
