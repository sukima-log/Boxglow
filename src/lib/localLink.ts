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

/** 文中の URL (http / https) */
const URL_RE = /https?:\/\/[^\s<>"'`、。，．（）「」『』【】]+[^\s<>"'`、。，．（）「」『』【】.,;:!?)\]]/;
/** 文中のファイルらしいパス: "/" を 1 つ以上含み、拡張子 (英数字 1〜8 文字) で終わる。先頭の ./ ../ も可 (英数字と . _ - / だけ。日本語の文の途中でも切り出せる) */
const PATH_RE = /(?:\.{1,2}\/)?[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9_/.-]*[A-Za-z0-9_/])/;
const TOKEN_RE = new RegExp(`${URL_RE.source}|${PATH_RE.source}`, "g");

/** 文を分けた 1 片 (ただの文字 / URL / 手元のファイルのパス) */
export type TextPiece = { kind: "text" | "url" | "path"; text: string };

/**
 * 文の中の URL とファイルらしいパスを見つけて、前後の文字と分ける (入出力の説明・検査結果・判断の文脈など、自由に書く欄のリンク化)
 * Input : text / Output: 片の配列 (つなげると元の文に戻る)
 */
export function splitLinks(text: string): TextPiece[] {
  const out: TextPiece[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    // 直前が英数字や / なら、語の途中なので切り出さない (例: abc/def.md の一部だけを拾わない)
    if (at > 0 && /[A-Za-z0-9_/.-]/.test(text[at - 1])) continue;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: /^https?:\/\//.test(m[0]) ? "url" : "path", text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
