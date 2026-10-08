import { t } from "../../src/i18n/core";
/** 認証情報の送り先をURLで判定する。選択経路や過去のbindingを許可の根拠にしない。 */
export const DEFAULT_SYNC_SERVER = "https://boxglow-sync.sukima945.workers.dev";
/** 入力: サーバーURL。出力: ホスト名・既定ポート・末尾スラッシュを正規化したURL、不正ならnull。 */
export function serverIdentity(server: string): string | null {
  try {
    const url = new URL(server.trim());
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    url.hostname = url.hostname.replace(/\.+$/, "");
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}
/** 製品のホストをスキームに依存せず保護する。通常のHTTP/HTTPSポートは同じ送り先として扱う。 */
export function isDefaultSyncServer(server: string): boolean {
  try {
    const url = new URL(server.trim());
    url.hostname = url.hostname.replace(/\.+$/, "");
    const product = new URL(DEFAULT_SYNC_SERVER);
    const port = (u: URL) => ["80", "443"].includes(u.port) ? "" : u.port;
    return url.hostname === product.hostname && port(url) === port(product);
  }
  catch { return false; }
}
/** 入力: 送り先と任意のトークン専用送り先。出力: 環境トークンを使えるか。通信・保存はしない。 */
export function environmentTokenAllowed(server: string, tokenServer = process.env.BOXGLOW_TOKEN_SERVER): boolean {
  const destination = serverIdentity(server);
  if (!destination || serverProblem(server)) return false;
  // 専用送り先を指定したら、自分のサーバーも含め一致しない先には送らない。
  if (tokenServer !== undefined) return serverIdentity(tokenServer) === destination;
  return !isDefaultSyncServer(server);
}

/** 入力: 同期先URL。出力: HTTPSまたはローカルHTTPならnull、それ以外は通信前に表示する理由。 */
export function serverProblem(server: string): string | null {
  let url: URL;
  try { url = new URL(server); } catch { return t("サーバーの場所が URL として読めません: {server}", { server }); }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
  return t("https ではないサーバーには接続しません (手元の localhost を除く): {server}", { server });
}
