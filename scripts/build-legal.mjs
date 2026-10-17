#!/usr/bin/env node
/**
 * 法務ページ (特定商取引法に基づく表記・利用規約・プライバシーポリシー) を Markdown から HTML にして、公開用の置き場に出す
 *   - 元の Markdown は公開リポジトリの外 (LEGAL_SRC で指定。無ければ何もしない = 提供開始前のビルドでは出さない)
 *   - 出力: <out>/legal/index.html (特商法), <out>/terms/index.html, <out>/privacy/index.html と、英語版 <out>/<name>/en/index.html
 *   - LEGAL_DRAFT=1 か --draft なら、各ページの先頭に「準備中 (提供開始前の草案)」の帯を出し、検索エンジンに載せない
 *   - 見た目は順番待ちページ (public/waitlist) と同じ配色
 * 使い方: LEGAL_SRC=/mnt/c/Users/PC_User/Documents/ChatGPT/boxglow/legal node scripts/build-legal.mjs [--out dist-pages] [--draft]
 * Input : LEGAL_SRC の tokushoho.md / terms.md / privacy.md (+ .en.md)。Output: HTML ファイル (標準出力に一覧)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";

const src = process.env.LEGAL_SRC;
const args = process.argv.slice(2);
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : "dist-pages";
const draft = args.includes("--draft") || process.env.LEGAL_DRAFT === "1";
if (!src || !existsSync(src)) { console.log("LEGAL_SRC が無いので、法務ページは出しません"); process.exit(0); }

/** ページの定義: 公開パス、元のファイル、題名 */
const PAGES = [
  { path: "legal", file: "tokushoho.md", title: "特定商取引法に基づく表記", titleEn: "Legal notice" }
, { path: "terms", file: "terms.md", title: "利用規約", titleEn: "Terms of service" }
, { path: "privacy", file: "privacy.md", title: "プライバシーポリシー", titleEn: "Privacy policy" }
];

/** 1 ページ分の HTML。Input: 本文の HTML、題名、言語、他のページへのリンク。Output: HTML 文字列 */
function page(body, title, lang, nav) {
  const notice = draft
    ? (lang === "ja" ? "準備中: 提供開始前の草案です。内容は変わることがあります。" : "In preparation: this is a draft before launch and may change.")
    : "";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Boxglow</title>
<link rel="icon" href="/favicon.svg">
<meta name="robots" content="${draft ? "noindex" : "index"}">
<style>
  :root { --bg: #eceef0; --card: #fbfbfb; --text: #2f343a; --muted: #6b7075; --line: #3a3f46; --primary: #0d8080; --accent: #e8875e; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1a1d21; --card: #23272c; --text: #e8eaed; --muted: #a3a9b1; --line: #4a5058; --primary: #3fb5b5; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--text); font: 15px/1.8 system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif; }
  main { max-width: 720px; margin: 0 auto; background: var(--card); border: 3px solid var(--line); border-radius: 16px; padding: 24px 28px; box-shadow: 6px 6px 0 rgba(0,0,0,.12); }
  h1 { font-size: 22px; margin: 0 0 16px; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 2px solid var(--line); padding-bottom: 4px; } h3 { font-size: 15px; margin: 20px 0 6px; }
  p, li { margin: 6px 0; } table { border-collapse: collapse; width: 100%; font-size: 14px; } th, td { border: 1px solid var(--line); padding: 6px 8px; vertical-align: top; text-align: left; }
  a { color: var(--primary); } .notice { background: var(--accent); color: #1a1d21; padding: 8px 12px; border-radius: 8px; font-weight: 700; margin-bottom: 16px; }
  nav { max-width: 720px; margin: 0 auto 12px; display: flex; flex-wrap: wrap; gap: 12px; font-size: 13px; } nav a { color: var(--muted); }
</style>
</head>
<body>
<nav><a href="/">Boxglow</a>${nav}</nav>
<main>
${notice ? `<div class="notice">${notice}</div>` : ""}
${body}
</main>
</body>
</html>
`;
}

const written = [];
for (const p of PAGES) {
  for (const lang of ["ja", "en"]) {
    const file = join(src, lang === "ja" ? p.file : p.file.replace(/\.md$/, ".en.md"));
    if (!existsSync(file)) continue;
    // 草案のメモ行 (括弧で始まる「(草案 …)」「(Draft …)」「(メモ: …)」) は公開しない
    const md = readFileSync(file, "utf8").split("\n").filter((line) => !/^\((草案|Draft|メモ)/.test(line.trim())).join("\n");
    const body = marked.parse(md, { async: false });
    const nav = PAGES.map((q) => `<a href="/${q.path}/${lang === "en" ? "en/" : ""}">${lang === "ja" ? q.title : q.titleEn}</a>`).join("")
      + (lang === "ja" ? `<a href="/${p.path}/en/">English</a>` : `<a href="/${p.path}/">日本語</a>`);
    const dir = join(out, p.path, lang === "en" ? "en" : "");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "index.html");
    writeFileSync(target, page(body, lang === "ja" ? p.title : p.titleEn, lang, nav));
    written.push(target);
  }
}
console.log(written.join("\n"));
