/**
 * 画面の検査 (e2e) の共通部品
 * Playwright はこのリポジトリに入れていない: 環境変数 PLAYWRIGHT で場所を渡す (run.sh が既定値を入れる)。
 * 検査は window.boxglow.store (Zustand) と window.boxglow.rf (React Flow) を page.evaluate から読む。
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

/** アプリの URL (run.sh が vite preview を 4173 番で起動する) */
const BASE = process.env.BOXGLOW_URL || "http://localhost:4173/apps/boxglow/";
/** リポジトリの根 */
const ROOT = path.resolve(__dirname, "..");

let passed = 0;
let failed = 0;
/**
 * 検査 1 件の結果を出力して数える
 * Input : name = 検査の名前, ok = 合否, detail = 補足 (失敗時の手がかり)
 * Output: なし (標準出力)
 */
function check(name, ok, detail = "") {
  console.log(`${ok ? "OK  " : "NG  "}${name}${detail ? " " + detail : ""}`);
  if (ok) passed++; else failed++;
}
/** 合否の集計 */
const result = () => ({ passed, failed });

/**
 * ページを開く
 * Input : browser, opts.lang = "ja" | "en" (ブラウザの言語), opts.query = URL の引数, opts.vscode = true なら VS Code の webview を模す
 * Output: { page, errors } (errors = コンソールのエラー文の配列)
 */
async function open(browser, opts = {}) {
  const ctx = await browser.newContext({ locale: opts.lang === "en" ? "en-US" : "ja-JP", viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  if (opts.vscode) {
    // 拡張との通信を記録する偽の API
    await page.addInitScript(() => { window.__posted = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m) }); });
  }
  await page.goto(BASE + (opts.query || ""));
  await page.waitForTimeout(500);
  return { page, errors };
}

/**
 * 計画のファイルを読み込ませる (ブラウザ内保存に取り込む)
 * Input : page, file = boxglow.json のパス (または JSON 文字列を返す関数)
 * Output: なし (箱が描かれるまで待つ)
 */
async function load(page, file) {
  const text = typeof file === "function" ? file() : fs.readFileSync(file, "utf8");
  await page.evaluate(async (t) => { await window.boxglow.store.getState().importJSON(t); }, text);
  await page.waitForSelector(".react-flow__node-block");
  await page.waitForTimeout(900);
}

/** 大項目 (プロジェクト直下の箱) の一覧 [{ id, title }] */
const majorsOf = (page) => page.evaluate(() => {
  const s = window.boxglow.store.getState();
  const bs = Object.values(s.project.blocks);
  const pj = new Set(bs.filter((b) => b.kind === "project").map((b) => b.id));
  return bs.filter((b) => pj.has(b.parentId)).map((b) => ({ id: b.id, title: b.title }));
});

/** 題名から箱の id を引く */
const idOf = (page, title) => page.evaluate((t) => Object.values(window.boxglow.store.getState().project.blocks).find((b) => b.title === t)?.id ?? null, title);

/**
 * タブを切り替えて、画面が落ち着くまでの時間を測る
 * Input : page, scope = 大項目の id (null = All)
 * Output: 所要時間 (ms)
 */
async function switchTab(page, scope) {
  return page.evaluate(async (id) => {
    const t0 = performance.now();
    window.boxglow.store.getState().setViewScope(id);
    let last = document.querySelector(".react-flow__viewport").style.transform;
    let since = performance.now();
    return await new Promise((res) => {
      const i = setInterval(() => {
        const tr = document.querySelector(".react-flow__viewport").style.transform;
        const now = performance.now();
        if (tr !== last) { last = tr; since = now; }
        if (now - since > 350) { clearInterval(i); res(Math.round(since - t0)); }
      }, 10);
    });
  }, scope);
}

/**
 * 今の画面で、描かれている線 (SVG の path そのもの) が箱の内側を通っていないか調べる
 * 判定: path を 4px ごとに標本化し、両端以外の箱の内側 (1px 内側) に 3 点以上、
 *       または両端の箱の内側 (8px 内側 = 反対側から貫いている) に 3 点以上あれば貫通
 * Output: 貫通の一覧 [{ src, dst, box }]
 */
const penetrations = (page) => page.evaluate(() => {
  const rf = window.boxglow.rf;
  const p = window.boxglow.store.getState().project;
  const rects = rf.getNodes().filter((n) => !n.hidden && n.type === "block").map((n) => {
    const i = rf.getInternalNode(n.id);
    return { id: n.id, title: p.blocks[n.id]?.title, x: i.internals.positionAbsolute.x, y: i.internals.positionAbsolute.y, w: n.measured?.width ?? 0, h: n.measured?.height ?? 0 };
  });
  const anc = (id) => { const out = new Set(); let c = p.blocks[id]?.parentId; while (c) { out.add(c); c = p.blocks[c]?.parentId; } return out; };
  const hits = [];
  for (const el of document.querySelectorAll(".react-flow__edge")) {
    const e = rf.getEdges().find((x) => x.id === el.getAttribute("data-id"));
    if (!e || e.hidden) continue;
    const path = el.querySelector(".react-flow__edge-path");
    if (!path) continue;
    const len = path.getTotalLength();
    const pts = [];
    for (let d = 0; d <= len; d += 4) { const q = path.getPointAtLength(d); pts.push(q); }
    const ends = new Set([e.source, e.target]);
    const around = new Set([...(p.blocks[e.source] ? anc(e.source) : []), ...(p.blocks[e.target] ? anc(e.target) : [])]);
    for (const r of rects) {
      if (around.has(r.id) && !ends.has(r.id)) continue; // 親の箱の中を通るのは当然
      const other = r.id === e.source ? e.target : e.source;
      if (ends.has(r.id) && p.blocks[other] && anc(other).has(r.id)) continue; // 親子の線 (内側のポート)
      const inset = ends.has(r.id) ? 8 : 1;
      const inside = pts.filter((q) => q.x > r.x + inset && q.x < r.x + r.w - inset && q.y > r.y + inset && q.y < r.y + r.h - inset).length;
      if (inside >= 3) hits.push({ src: p.blocks[e.source]?.title ?? e.source, dst: p.blocks[e.target]?.title ?? e.target, box: r.title });
    }
  }
  return hits;
});

/** 計画の文字列 (題名・出力名・説明など) を除いて、画面に残っている日本語の文言を集める (英語 UI の検査) */
const japaneseLeft = (page) => page.evaluate(() => {
  const jp = /[ぁ-んァ-ヶ一-龠]/;
  const out = [];
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const s = n.textContent.trim();
    if (s && jp.test(s) && !n.parentElement.closest("noscript")) out.push(s.slice(0, 50));
  }
  for (const el of document.querySelectorAll("[title], [placeholder], [aria-label]")) {
    for (const a of ["title", "placeholder", "aria-label"]) { const v = el.getAttribute(a); if (v && jp.test(v)) out.push(`${a}: ${v.slice(0, 50)}`); }
  }
  return out;
});

module.exports = { chromium, BASE, ROOT, check, result, open, load, majorsOf, idOf, switchTab, penetrations, japaneseLeft };
