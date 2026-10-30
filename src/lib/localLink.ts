/**
 * リンクの行き先が「手元のファイル」(相対パスや file://) かを見分ける (成果物・資料・Notes のリンクで共通)
 */

/**
 * Input : href = リンクの行き先 (成果物の URL 欄、Markdown のリンク)
 * Output: 手元のファイルのパス (相対パス、絶対パス、file:// を外したもの)。URL (https: など)・ページ内の # ・空なら undefined
 */
export function localTarget(href: string | null | undefined): string | undefined {
  const u = (href ?? "").trim();
  if (!u || u.startsWith("#") || u.startsWith("//")) return undefined;
  if (u.startsWith("file://")) return decodeURIComponent(u.slice("file://".length));
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) && !/^[a-z]:[\\/]/i.test(u)) return undefined; // https: mailto: など (C:\ のような Windows のドライブは手元のファイル)
  return u;
}
