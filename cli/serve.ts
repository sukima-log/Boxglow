/**
 * ローカルサーバ: 同梱の Web アプリ (dist/) を配信し、boxglow.json を API で読み書きする。
 * File System Access API の無いブラウザ (Firefox / Safari) でも手元のファイルを開けるようにするため。
 *   GET  /api/project  -> ファイルの中身 (JSON)。ヘッダ etag にリビジョン、x-boxglow-file にファイル名、x-boxglow-version / x-boxglow-protocol に版
 *   PUT  /api/project  <- 新しい中身 (JSON)。If-Match に読んだときの etag が必須。
 *                         計画として検査し、ロック + リビジョン照合 + 原子的な置換で書く (cli/file-store.ts)
 *                         428 = If-Match なし, 412 = 読んだ後に他が書き換えた, 423 = 他が書き込み中, 400 = 計画として不正, 413 = 大きすぎ
 *   GET  /api/events   -> SSE。ファイルが変わるたびに "change" を送る (CLI や AI が書いたとき画面が読み直す)
 * 127.0.0.1 にだけ bind し、Host / Origin も確かめる (他の端末や、他のサイトを開いたブラウザからは読み書きできない)
 * Input : file = boxglow.json の場所, port, dist = Web アプリの置き場, open = ブラウザを開くか, log = 出力
 * Output: 起動した http.Server (常駐。Ctrl+C で終了)
 */
import { rememberSync, syncWasEnabled } from "./sync/server-config";
import { APP_VERSION, SAVE_PROTOCOL } from "../src/model/version";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { commitFile, FileBusy, FileConflict, revisionOf } from "./file-store";
import { validateProjectText } from "../src/model/validate-file";
// 文言を今の言語 (日本語 / 英語) で出す。言語は main.ts の serve の入口で決めてある
import { t } from "../src/i18n/core";
import { MAX_SYNC_ACTION_BYTES, parseHostAction, SyncHost, SyncDestinationError, type SyncStatus } from "./sync/host";

/** PUT で受け付ける本文の上限 (バイト)。これを超える計画は保存を断る */
export const MAX_BODY = 5 * 1024 * 1024;

/** 拡張子 → Content-Type (配信する dist/ の中身の分だけ) */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8"
, ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".map": "application/json"
};

/** HTTP の状態コード付きのエラー (catch でそのまま応答にする) */
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * リクエストの本文を最後まで読む (上限を超えたら 413 で失敗させ、溜めた分は捨てる)
 * Input : req = HTTP リクエスト
 * Output: 本文の文字列 (UTF-8)。上限超過・中断は HttpError で reject
 */
function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) { fail(new HttpError(413, limit === MAX_BODY ? t("計画が大きすぎます (上限 5 MiB)") : t("要求が大きすぎます"))); chunks.length = 0; }
      else chunks.push(chunk);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
    req.on("aborted", () => fail(new HttpError(400, t("リクエストが中断されました"))));
  });
}


export function startServe(opts: { file: string; port: number; dist: string; open: boolean; log: (text: string) => void
  /** 同期先を渡すと開始の入口を提供する。autoEnable=falseは記憶した有効化だけを復元する */
; sync?: { server: string; host?: SyncHost; autoEnable?: boolean; restoreEnabled?: boolean; allowEnvironmentToken?: boolean } }): ReturnType<typeof createServer> {
  const { file, dist, log } = opts;
  if (!existsSync(join(dist, "index.html"))) throw new Error(t("Web アプリが見つかりません: {dist} (npm run build で dist/ を作ってください)", { dist }));
  const children: ReturnType<typeof createServer>[] = [];
  const clients = new Set<ServerResponse>();
  // 画面 (SSE でつながっている全員) に「ファイルが変わった」と知らせる
  const broadcast = () => { for (const res of clients) res.write("event: change\ndata: {}\n\n"); };
  // ---- 画面からの同期の裏方 (同期先が有効なとき)。状態が変わったら SSE の sync で知らせる ----
  let syncHost: SyncHost | null = null;
  let lastSync: SyncStatus | null = null;
  const sendSync = (status: SyncStatus) => { lastSync = status; const data = JSON.stringify(status); for (const res of clients) res.write(`event: sync\ndata: ${data}\n\n`); };
  if (opts.sync) {
    syncHost = opts.sync.host ?? new SyncHost({ server: opts.sync.server, allowEnvironmentToken: opts.sync.allowEnvironmentToken, onStatus: sendSync,
      destinationPicker:"sibling",
      chooseDestination:async (source,name) => {
        // ディレクトリ移動・隠し設定・特殊デバイス名を画面から指定させない。
        if (!name || !/^[^./\\][^/\\:<>"|?*]*\.json$/.test(name) || /[\x00-\x1f]/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(name)) throw new SyncDestinationError(t("保存ファイル名を確認してください。フォルダを含めず、.jsonで終わる名前を指定します。"));
        return join(dirname(source),name);
      },
      onOpened:async (target) => {
        const child = startServe({file:target,port:0,dist,open:false,log,sync:{server:opts.sync!.server,allowEnvironmentToken:opts.sync!.allowEnvironmentToken,autoEnable:false}});
        children.push(child);
        await new Promise<void>((ok,fail)=>{child.once("listening",ok); child.once("error",fail);});
        const address = child.address();
        return `http://localhost:${typeof address === "object" && address ? address.port : 0}/?serve=1`;
      }, onEnabled:(path,enabled)=>rememberSync(path,opts.sync!.server,enabled) });
    syncHost.openFile(file);
    if (opts.sync.autoEnable !== false || (opts.sync.restoreEnabled !== false && syncWasEnabled(file,opts.sync.server))) syncHost.enable(file);
  }

  // ファイルの監視 (ディレクトリを見て、同名のファイルの変化だけ拾う。連続する変化は 1 回にまとめる)
  // 一時ファイルやロックのディレクトリは名前が違うので拾わない。監視できない環境でもサーバは起動する
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(file), (_ev, name) => {
      if (name && String(name) !== basename(file)) return;
      clearTimeout(timer);
      timer = setTimeout(broadcast, 80);
    });
  } catch (e) {
    log(t("[serve] ファイルの監視を始められません: {message}", { message: e instanceof Error ? e.message : String(e) }));
  }

  const server = createServer(async (req, res) => {
    // 応答を 1 回で返す (キャッシュさせない。種類の推測もさせない)
    const send = (status: number, body: string | Buffer, type = "application/json", headers = {}) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
      res.end(body);
    };
    try {
      // 自分のアドレス宛て (localhost / 127.0.0.1 の待ち受けポート) のリクエストだけ受ける (DNS リバインディング対策)
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      const allowed = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
      if (!req.headers.host || !allowed.has(req.headers.host.toLowerCase())) throw new HttpError(403, t("信頼できない Host です"));
      // 他のサイトのページからの読み書きを断る
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new HttpError(403, t("他のオリジンからのアクセスは受け付けません"));
      if (req.headers["sec-fetch-site"] === "cross-site") throw new HttpError(403, t("他のサイトからのアクセスは受け付けません"));
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/api/project") {
        if (req.method === "GET") {
          // 中身と一緒にリビジョン (etag) を返す。画面は保存のときにこれを If-Match で送り返す
          const text = readFileSync(file, "utf8");
          send(200, text, "application/json; charset=utf-8", {
            etag: revisionOf(text)
          , "x-boxglow-file": encodeURIComponent(basename(file))
          , "x-boxglow-version": APP_VERSION
          , "x-boxglow-protocol": String(SAVE_PROTOCOL)
          });
          return;
        }
        if (req.method !== "PUT") throw new HttpError(405, t("このメソッドは使えません"));
        if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") throw new HttpError(415, t("application/json で送ってください"));
        if (Number(req.headers["content-length"]) > MAX_BODY) throw new HttpError(413, t("計画が大きすぎます (上限 5 MiB)"));
        const expected = req.headers["if-match"];
        if (typeof expected !== "string") throw new HttpError(428, t("先に計画を読み、その ETag を If-Match で送ってください"));
        const text = await readBody(req);
        // 正規化の前に検査する (壊れた参照を黙って落として保存しない)。詳細は返さず、不正とだけ伝える
        try { validateProjectText(text); } catch { throw new HttpError(400, t("Boxglow の計画として正しくありません (形式・参照・つなぎ方)")); }
        // 読んだときの版 (If-Match) のままなら書く。違えば FileConflict (412)、ロック中なら FileBusy (423)
        const revision = commitFile(file, text, expected);
        send(200, JSON.stringify({ ok: true }), "application/json", { etag: revision });
        broadcast();
        return;
      }
      if (url.pathname === "/api/sync") {
        // 画面からの同期: GET = 今の状態、POST = 操作 (本文は { kind, ... }。種類と引数は許可リストで検査する)
        if (!syncHost) { send(404, JSON.stringify({ ok: false, error: t("画面からの同期は、boxglow serve --sync で起動したときだけ使えます") })); return; }
        if (req.method === "GET") { send(200, JSON.stringify(syncHost.status(file))); return; }
        if (req.method !== "POST") throw new HttpError(405, t("このメソッドは使えません"));
        // グループ別の選択は4KiBを超えることがある。ヘッダーと受信中の両方で同じ上限を守る。
        if (Number(req.headers["content-length"]) > MAX_SYNC_ACTION_BYTES) throw new HttpError(413, t("要求が大きすぎます"));
        const action = parseHostAction(await readBody(req, MAX_SYNC_ACTION_BYTES));
        if (!action) throw new HttpError(400, t("同期の操作として読めません"));
        send(200, JSON.stringify(await syncHost.act(file, action)));
        return;
      }
      if (url.pathname === "/api/events") {
        if (req.method !== "GET") throw new HttpError(405, t("このメソッドは使えません"));
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("event: hello\ndata: {}\n\n");
        clients.add(res);
        // (つないだ画面に、同期の今の状態をすぐ知らせる)
        if (syncHost) res.write(`event: sync\ndata: ${JSON.stringify(lastSync ?? syncHost.status(file))}\n\n`);
        // 接続が切られないよう、定期的に空のコメントを送る
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        res.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      // 静的ファイル (dist/)。無いパスは index.html (アプリは 1 画面)。dist の外 (.. やリンク先) は出さない
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, t("このメソッドは使えません"));
      const base = realpathSync(dist);
      const target = resolve(base, "." + decodeURIComponent(url.pathname));
      const inside = (path: string) => { const rel = relative(base, path); return rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"); };
      if (!inside(target)) throw new HttpError(403, t("このパスは配信できません"));
      const path = existsSync(target) && statSync(target).isFile() ? realpathSync(target) : join(base, "index.html");
      if (!inside(path)) throw new HttpError(403, t("このパスは配信できません"));
      send(200, req.method === "HEAD" ? "" : readFileSync(path), MIME[extname(path)] ?? "application/octet-stream");
    } catch (e) {
      // 想定したエラーはその状態コードと理由を返す。想定外 (500) は中身を外に出さない
      const status = e instanceof HttpError ? e.status : e instanceof FileConflict ? 412 : e instanceof FileBusy ? 423 : 500;
      send(status, JSON.stringify({ ok: false, error: status === 500 ? t("ローカルサーバでエラーが起きました") : (e as Error).message }));
    }
  });
  // サーバを閉じるときは監視と SSE の接続も終える (テストで後始末できるように)
  server.on("close", () => { for (const child of children) { child.closeAllConnections(); child.close(); } watcher?.close(); clearTimeout(timer); for (const res of clients) res.end(); void syncHost?.stop(); });
  server.listen(opts.port, "127.0.0.1", () => {
    // port に 0 を渡したときは、実際に割り当てられたポートを使う
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : opts.port;
    const url = `http://localhost:${port}/?serve=1`;
    log(`[serve] ${file}\n[serve] ${url}  ${t("(Ctrl+C で終了)")}`);
    if (opts.open) {
      const args = process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
      // 開けなくても URL は表示している (失敗は無視する)
      const child = spawn(args[0], args.slice(1), { stdio: "ignore", detached: true });
      child.on("error", () => {});
      child.unref();
    }
  });
  return server;
}
