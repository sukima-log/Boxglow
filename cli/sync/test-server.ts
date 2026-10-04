/**
 * 試験用の同期サーバー (メモリの中だけ。サインイン無し、localhost だけ)
 * 同期のクライアント (cli/sync/client.ts) が前提にしている約束を、そのまま実装した最小のもの:
 *   GET /v1/projects      -> 200 計画の一覧 [{ id, revision, deleted }] (全部の計画の最新の版を 1 回で確かめるため)
 *   GET /v1/projects/:id  -> 200 中身 (ETag = 版) / 404 まだ無い / 410 消されている。どの応答にも x-boxglow-epoch (履歴の世代)
 *   PUT /v1/projects/:id  <- 中身。If-Match: "<版>" (置き換え) か If-None-Match: * (作成)、x-boxglow-op (操作 ID) が必須
 *        200 / 201 受理 (ETag = 新しい版) / 412 前提の版が違う / 409 履歴の世代が違う / 410 消されている / 428 前提なし / 422 同じ操作 ID で違う要求
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
  projects = new Map<string, StoredProject>();
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
  project(id: string): StoredProject | undefined { return this.projects.get(id); }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body = "", headers: Record<string, string> = {}) => {
      res.writeHead(status, { "x-boxglow-epoch": this.epoch, "content-type": "application/json; charset=utf-8", ...headers });
      res.end(body);
    };
    // 一覧: 全部の計画の最新の版 (常時の同期は、これ 1 回で、どの計画が進んだかを確かめる)
    if (req.method === "GET" && req.url === "/v1/projects") {
      this.lists++;
      send(200, JSON.stringify([...this.projects.entries()].map(([id, p]) => ({ id, revision: p.head?.revision ?? null, deleted: p.deleted }))));
      return;
    }
    const match = /^\/v1\/projects\/([^/]+)$/.exec(req.url ?? "");
    if (!match) { send(404, JSON.stringify({ code: "not-found" })); return; }
    const id = decodeURIComponent(match[1]);
    const project = this.projects.get(id);
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
      const result = this.put(id, text, req.headers);
      if (this.dropNextPutResponse) { this.dropNextPutResponse = false; req.socket.destroy(); return; }
      send(result.status, JSON.stringify(result.body), result.revision ? { etag: `"${result.revision}"` } : {});
      return;
    }
    send(405, JSON.stringify({ code: "method" }));
  }

  /**
   * 置き換え・作成を確定する (同期の処理。途中で他の要求が割り込まない)
   * Input : id = 計画の ID, text = 中身, headers = 要求のヘッダ
   * Output: 応答の状態コード・本文・(受理なら) 版
   */
  put(id: string, text: string, headers: IncomingMessage["headers"]): { status: number; body: unknown; revision?: string } {
    const op = typeof headers["x-boxglow-op"] === "string" ? headers["x-boxglow-op"] : "";
    const ifMatch = typeof headers["if-match"] === "string" ? headers["if-match"].replace(/^"|"$/g, "") : null;
    const create = headers["if-none-match"] === "*";
    // 履歴の世代 (クライアントが操作を記録したときの世代) も必須。無い要求は受け付けない
    const epoch = typeof headers["x-boxglow-epoch"] === "string" ? headers["x-boxglow-epoch"] : null;
    if (!op || epoch === null || (!create && ifMatch === null)) return { status: 428, body: { code: "precondition-required" } };
    // (1) 履歴の世代と、対象の計画: 世代が今と違えば、412 とは別の応答にする。消した計画には、何も受け付けない (消した ID は二度と使わない)
    if (epoch !== this.epoch) return { status: 409, body: { code: "history-changed" } };
    const project: StoredProject = this.projects.get(id) ?? { head: null, deleted: false, seq: 0, ops: new Map(), versions: [] };
    if (project.deleted) return { status: 410, body: { code: "deleted" } };
    // 受け取る中身は、計画として検査する (JSON であるだけでは足りない)
    try { validateProjectText(text); } catch (e) { return { status: 400, body: { code: "invalid", message: e instanceof Error ? e.message : String(e) } }; }
    const hash = createHash("sha256").update(text).digest("hex");
    const request = JSON.stringify([hash, create ? null : ifMatch]);
    // (2) 同じ操作の結果が既にあれば、今の版との照合より先に、その結果を返す (違う要求なら断る)
    const done = project.ops.get(op);
    if (done) return done.request === request ? { status: 200, body: { revision: done.revision }, revision: done.revision } : { status: 422, body: { code: "operation-mismatch" } };
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
    this.projects.set(id, project);
    return { status: create ? 201 : 200, body: { revision }, revision };
  }
}
