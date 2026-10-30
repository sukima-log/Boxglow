/**
 * Markdown の表示 (メモ・作業記録)。marked で HTML にし、DOMPurify で無害化してから描く
 *   - 見出し・箇条書き・チェックボックス・表・コード・リンク・画像に対応 (GFM)。改行はそのまま改行にする (メモの書き方に合わせる)
 *   - リンクは新しいタブで開く。手元のファイルを指すリンク (相対パス・file://) は、押すと openAttachedFile で開く (VS Code = エディタ、serve = 新しいタブ)。スクリプトやイベント属性は落とす
 *   - 画像: http(s) の URL はそのまま。相対パス (boxglow.assets/... など) は assetBase を前に付ける (serve / VS Code が解決する)。
 *     assetBase が無い環境 (ブラウザだけ) では、相対パスの画像は代替文 (alt) だけを出す
 * Input : text = Markdown, assetBase = 相対パスの画像の置き場の URL (末尾は / で終える。無ければ undefined)
 * Output: 整形した HTML を描く JSX
 */
import { localTarget, splitLinks } from "../lib/localLink";
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
  linkifyPaths(doc);
  return doc.body.innerHTML;
}

/**
 * 文中のファイルらしいパス (docs/design.md など。[文字](パス) の形で書いていないもの) を、押せるリンクにする。コードの書式の中も対象。
 * URL は marked が自動でリンクにするので、ここではパスだけを扱う。リンクの中の文字はそのまま
 * Input : doc = 無害化した後の HTML の文書 (直接書き換える) / Output: なし
 */
function linkifyPaths(doc: Document): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!(n.parentElement?.closest("a"))) nodes.push(n as Text);
  for (const node of nodes) {
    const pieces = splitLinks(node.data);
    if (!pieces.some((p) => p.kind === "path")) continue;
    const frag = doc.createDocumentFragment();
    for (const p of pieces) {
      if (p.kind !== "path") { frag.append(p.text); continue; }
      const a = doc.createElement("a");
      a.setAttribute("href", p.text);
      a.textContent = p.text;
      frag.append(a);
    }
    node.replaceWith(frag);
  }
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
  const openAttachedFile = useProjectStore((s) => s.openAttachedFile);
  // 手元のファイルを指すリンク (相対パス・file://) は、押すと開く (VS Code = エディタ、serve = 新しいタブ)。URL のリンクは今までどおり
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const local = a ? localTarget(a.getAttribute("href")) : undefined;
    if (!local) return;
    e.preventDefault();
    openAttachedFile(local);
  };
  return <div className={`md ${className ?? ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
