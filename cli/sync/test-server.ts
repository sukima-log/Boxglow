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
  head: { revision: string; text: string } | null;
  deleted: boolean;
  seq: number;
  /** 操作 ID → { 要求の印 (中身のハッシュと前提の版), 受理された版 } */
  ops: Map<string, { request: string; revision: string }>;
  /** 受理した版の一覧 (履歴) */
  versions: { revision: string; hash: string }[];
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
  googleTx = new Map<string, { claimHash: string; status: "pending" | "ready" | "denied"; token?: string; account?: string }>();
  /** Google のサインインを許可したことにする (トークンを発行して取引に置く) */
  approveGoogle(id: string, user: { account: string; login: string } | "denied"): void {
    const tx = this.googleTx.get(id);
    if (!tx) return;
    if (user === "denied") { tx.status = "denied"; return; }
    const token = `tok-${user.account}-${this.issued.size + 1}`;
    this.issued.set(token, user);
    tx.status = "ready"; tx.token = token; tx.account = user.account;
  }
  /** 発行したトークン → 利用者 (発行していないトークンは、文字列そのものを利用者の ID として扱う) */
  issued = new Map<string, { account: string; login: string }>();
  /** 取り消したトークン */
  revoked = new Set<string>();
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
    // ---- サインインの手順 (認証なしで呼べる) ----
    const plain = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };
    if (req.method === "POST" && req.url === "/v1/auth/device") {
      const code = "dc" + String(++this.codes).padStart(38, "0");
      this.deviceCodes.set(code, "pending");
      plain(200, { device_code: code, user_code: "TEST-" + this.codes, verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 });
      return;
    }
    // ---- Google のサインイン (取引の仲立ち。本番と同じ約束。試験は googleTx の状態を直接変えて「許可された」ことにする) ----
    if (req.method === "POST" && req.url === "/v1/auth/google/start") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const claimHash = String((JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { claimHash?: unknown }).claimHash ?? "");
      const id = `tx-${++this.codes}`;
      this.googleTx.set(id, { claimHash, status: "pending" });
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
      else { this.googleTx.delete(String(body.id)); plain(200, { status: "ok", token: tx.token, account: tx.account }); }
      return;
    }
    if (req.method === "POST" && req.url === "/v1/auth/device/token") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const state = this.deviceCodes.get(String((JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { device_code?: unknown }).device_code));
      if (state === undefined) plain(400, { code: "incorrect_device_code" });
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
    if (bearer !== undefined && this.revoked.has(bearer)) { plain(401, { code: "unauthorized" }); return; }
    const account = bearer === undefined ? "test" : this.issued.get(bearer)?.account ?? bearer;
    const projects = this.space(account);
    const send = (status: number, body = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "x-boxglow-epoch": this.epoch, "x-boxglow-account": account, "content-type": "application/json; charset=utf-8", ...headers });
      res.end(body);
    };
    if (req.method === "GET" && req.url === "/v1/me") {
      send(200, JSON.stringify({ account, login: this.issued.get(bearer ?? "")?.login ?? account, devices: [{ name: "this", current: true }]
      , usage: { projects: projects.size, contentBytes: 1_500_000 }, limits: { projects: 10, contentBytes: 200_000_000 } }));
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
    // 操作の結果の問い合わせ: 受理されていれば、その版。受理されていなければ null
    const opMatch = /^\/v1\/projects\/([^/]+)\/ops\/([^/]+)$/.exec(req.url ?? "");
    if (opMatch && req.method === "GET") {
      const done = projects.get(decodeURIComponent(opMatch[1]))?.ops.get(decodeURIComponent(opMatch[2]));
      send(200, JSON.stringify({ revision: done?.revision ?? null }));
      return;
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
    project.head = { revision, text };
    project.versions.push({ revision, hash });
    project.ops.set(op, { request, revision });
    projects.set(id, project);
    return { status: create ? 201 : 200, body: { revision }, revision };
  }
}
