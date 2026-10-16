/**
 * Markdown の表示 (メモ・作業記録)。marked で HTML にし、DOMPurify で無害化してから描く
 *   - 見出し・箇条書き・チェックボックス・表・コード・リンク・画像に対応 (GFM)。改行はそのまま改行にする (メモの書き方に合わせる)
 *   - リンクは新しいタブで開く。スクリプトやイベント属性は落とす
 *   - 画像: http(s) の URL はそのまま。相対パス (boxglow.assets/... など) は assetBase を前に付ける (serve / VS Code が解決する)。
 *     assetBase が無い環境 (ブラウザだけ) では、相対パスの画像は代替文 (alt) だけを出す
 * Input : text = Markdown, assetBase = 相対パスの画像の置き場の URL (末尾は / で終える。無ければ undefined)
 * Output: 整形した HTML を描く JSX
 */
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { useProjectStore } from "../store/useProjectStore";

marked.setOptions({ gfm: true, breaks: true });

/** DOMPurify の設定: リンクは新しいタブ、画像の相対パスの解決、危険な属性の除去 */
let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
}

/** 相対パスの画像を assetBase で解決する (http(s) / data はそのまま。assetBase が無ければ alt だけにする) */
function resolveImages(html: string, assetBase: string | undefined): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const img of [...doc.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    if (/^(https?:)?\/\//i.test(src) || src.startsWith("data:") || src.startsWith("blob:")) continue;
    if (assetBase) { img.setAttribute("src", assetBase + src.replace(/^\.?\//, "")); continue; }
    // 置き場が無い環境: 画像の代わりに代替文を出す
    const span = doc.createElement("span");
    span.className = "md-img-missing";
    span.textContent = `[${img.getAttribute("alt") || src}]`;
    img.replaceWith(span);
  }
  return doc.body.innerHTML;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const assetBase = useProjectStore((s) => s.assetBase);
  const html = useMemo(() => {
    ensureHooks();
    // チェックボックス (- [ ] / - [x]): marked が出す input を、無害化の前に印つきの li に変える (input は落とす)
    const raw = (marked.parse(text, { async: false }) as string)
      .replace(/<li(?: class="[^"]*")?>\s*<input checked="" disabled="" type="checkbox">\s?/g, '<li class="md-task" data-done="true">')
      .replace(/<li(?: class="[^"]*")?>\s*<input disabled="" type="checkbox">\s?/g, '<li class="md-task" data-done="false">');
    const clean = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "input"], ADD_ATTR: ["target"] });
    return resolveImages(clean, assetBase ?? undefined);
  }, [text, assetBase]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
