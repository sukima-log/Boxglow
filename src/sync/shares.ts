/**
 * 共有リンク (閲覧専用) に関する、ホスト共通の処理
 *   - 一覧の応答の検証 (信頼しない入力として扱う)
 *   - 閲覧用の URL の組み立て: 公開の画面 (https://boxglow.app) の #share=<トークン>。送り先が製品のサーバーでなければ &server=<URL> を添える
 */
import { isDefaultSyncServer } from "../../cli/sync/server-policy";

export interface ShareEntry { id: string; createdAt: string; expiresAt: string | null; revoked: boolean; expired: boolean }

/** 公開の画面の場所 (共有リンクはここで開く) */
export const SHARE_VIEWER = "https://boxglow.app/";

/** 一覧の応答を検証する。Output: ShareEntry[] (多くても 100 件)。形が合わなければ例外 */
export function parseShareList(data: unknown): ShareEntry[] {
  const list = (data as { shares?: unknown } | null)?.shares;
  if (!Array.isArray(list) || list.length > 1000) throw new Error("shares: unexpected response");
  return list.slice(0, 100).map((v) => {
    const s = v as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.createdAt !== "string") throw new Error("shares: unexpected entry");
    return { id: s.id.slice(0, 64), createdAt: s.createdAt.slice(0, 64), expiresAt: typeof s.expiresAt === "string" ? s.expiresAt.slice(0, 64) : null, revoked: s.revoked === true, expired: s.expired === true };
  });
}

/** 閲覧用の URL。Input: token = 発行された共有トークン, server = 送り先。Output: https://boxglow.app/#share=... (自分のサーバーなら &server= 付き) */
export function shareUrl(token: string, server: string): string {
  return `${SHARE_VIEWER}#share=${encodeURIComponent(token)}${isDefaultSyncServer(server) ? "" : `&server=${encodeURIComponent(server)}`}`;
}

/** 画面の URL のハッシュから、共有トークンと送り先を読む。Output: { token, server? } か null */
export function shareFromHash(hash: string): { token: string; server?: string } | null {
  const m = /(?:^#|&)share=([A-Za-z0-9_.%-]+)/.exec(hash);
  if (!m) return null;
  const token = decodeURIComponent(m[1]);
  if (!/^bgs_acc[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const s = /(?:^#|&)server=([^&]+)/.exec(hash);
  const server = s ? decodeURIComponent(s[1]) : undefined;
  return { token, ...(server && /^https?:\/\//.test(server) ? { server } : {}) };
}
