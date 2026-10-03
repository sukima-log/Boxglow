/**
 * ローカルサーバ: 同梱の Web アプリ (dist/) を配信し、boxglow.json を API で読み書きする。
 * File System Access API の無いブラウザ (Firefox / Safari) でも手元のファイルを開けるようにするため。
 *   GET  /api/project  -> ファイルの中身 (JSON)。ヘッダ x-boxglow-file にファイル名
 *   PUT  /api/project  <- 新しい中身 (JSON)。そのまま書く
 *   GET  /api/events   -> SSE。ファイルが変わるたびに "change" を送る (CLI や AI が書いたとき画面が読み直す)
 * 127.0.0.1 にだけ bind する (他の端末からは見えない)
 * Input : file = boxglow.json の場所, port, dist = Web アプリの置き場, open = ブラウザを開くか, log = 出力
 * Output: 常駐 (Ctrl+C で終了)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8"
, ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2", ".map": "application/json"
};

export function startServe(opts: { file: string; port: number; dist: string; open: boolean; log: (text: string) => void }): void {
  const { file, port, dist, log } = opts;
  if (!existsSync(join(dist, "index.html"))) throw new Error(`Web アプリが見つかりません: ${dist} (npm run build で dist/ を作ってください)`);
  const clients = new Set<ServerResponse>();
  let lastWritten = ""; // 自分 (API) が書いた中身。監視で拾ったときに区別する

  // ファイルの監視 (ディレクトリを見て、同名のファイルの変化だけ拾う。連続する変化は 1 回にまとめる)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const broadcast = () => {
    for (const res of clients) res.write("event: change\ndata: {}\n\n");
  };
  try {
    watch(dirname(file), (_ev, name) => {
      if (name && name !== basename(file)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const text = readFileSync(file, "utf8");
          if (text === lastWritten) return; // 自分の書き込み
        } catch { return; }
        broadcast();
      }, 250);
    });
  } catch (e) {
    log(`[serve] ファイルの監視を始められません: ${e instanceof Error ? e.message : String(e)}`);
  }

  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string) => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };
  const readBody = (req: IncomingMessage): Promise<string> => new Promise((ok, ng) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", ng);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/project") {
        if (req.method === "GET") {
          const text = readFileSync(file, "utf8");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-boxglow-file": encodeURIComponent(basename(file)) });
          res.end(text);
          return;
        }
        if (req.method === "PUT") {
          const text = await readBody(req);
          try { JSON.parse(text); } catch { send(res, 400, JSON.stringify({ ok: false, error: "JSON ではありません" }), "application/json"); return; }
          lastWritten = text;
          writeFileSync(file, text, "utf8");
          send(res, 200, JSON.stringify({ ok: true }), "application/json");
          return;
        }
        send(res, 405, "method not allowed", "text/plain");
        return;
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write("event: hello\ndata: {}\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25000);
        req.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      // 静的ファイル (dist/)。無いパスは index.html (アプリは 1 画面)
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith("/")) rel += "index.html";
      const target = normalize(join(dist, rel));
      if (!target.startsWith(resolve(dist))) { send(res, 403, "forbidden", "text/plain"); return; }
      const path = existsSync(target) && statSync(target).isFile() ? target : join(dist, "index.html");
      send(res, 200, readFileSync(path), MIME[extname(path)] ?? "application/octet-stream");
    } catch (e) {
      send(res, 500, `error: ${e instanceof Error ? e.message : String(e)}`, "text/plain");
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const addr = `http://localhost:${port}/?serve=1`;
    log(`[serve] ${file}\n[serve] ${addr}  (Ctrl+C で終了)`);
    if (opts.open) {
      const cmd = process.platform === "win32" ? ["cmd", "/c", "start", "", addr] : process.platform === "darwin" ? ["open", addr] : ["xdg-open", addr];
      try { spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref(); } catch { /* 開けなくても URL は表示している */ }
    }
  });
}
