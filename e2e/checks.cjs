/**
 * 画面の検査 (e2e) 本体。使い方: npm run e2e (run.sh がプレビューを起動してこのファイルを実行する)
 *
 * 1. 配線: 例の計画 (と、手元にあれば自分の計画) の全タブで、線が箱の上を通らない。詰めた配置でも通らない
 * 2. 速さ: タブの切り替えが落ち着くまでの時間
 * 3. 操作: タブ、ダブルクリック、選択、判断への回答 (答えた後も残る)、線を選んだままタブ移動、強調の光
 * 4. 英語 UI: 計画の中身以外に日本語が残らない
 * 5. VS Code モード: 拡張との読み書き
 */
const fs = require("fs");
const path = require("path");
const { chromium, ROOT, check, result, open, load, majorsOf, idOf, switchTab, penetrations, japaneseLeft } = require("./lib.cjs");

const DAW = path.join(ROOT, "examples/logic-daw/boxglow.json");
const NOTES = path.join(ROOT, "examples/notes-app/boxglow.json");
const OWN = path.join(ROOT, "boxglow.json"); // この開発自身の計画 (公開対象外。手元にあるときだけ検査する)

/** 箱の位置を縮めた計画 (間隔を広げる前に保存した配置の再現) を返す */
function squeezed(file) {
  const p = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const b of Object.values(p.blocks)) {
    if (b.parentId) b.position = { x: Math.round(120 + (b.position.x - 120) * 0.78), y: Math.round(76 + (b.position.y - 76) * 0.85) };
  }
  return JSON.stringify(p);
}

(async () => {
  const browser = await chromium.launch();

  /* ---------------- 1 / 2. 配線と速さ ---------------- */
  const plans = [["DAW の例", DAW], ["notes-app の例", NOTES], ["DAW の例 (詰めた配置)", () => squeezed(DAW)]];
  if (fs.existsSync(OWN)) plans.push(["自分の計画", OWN], ["自分の計画 (詰めた配置)", () => squeezed(OWN)]);
  for (const [label, file] of plans) {
    const { page, errors } = await open(browser);
    await load(page, file);
    const majors = await majorsOf(page);
    let total = 0;
    let slowest = 0;
    const detail = [];
    for (const scope of [null, ...majors.map((m) => m.id)]) {
      const ms = await switchTab(page, scope);
      slowest = Math.max(slowest, ms);
      const hits = await penetrations(page);
      total += hits.length;
      for (const h of hits.slice(0, 3)) detail.push(`${h.src} -> ${h.dst} が ${h.box} を貫通`);
    }
    check(`${label}: 線が箱の上を通らない (${majors.length + 1} 画面)`, total === 0, total ? `${total} 件: ${detail.join(" / ")}` : "");
    check(`${label}: タブの切り替えが 2.5 秒以内`, slowest < 2500, `最大 ${slowest} ms`);
    check(`${label}: コンソールにエラーが無い`, errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.context().close();
  }

  /* ---------------- 3. 操作 (notes-app) ---------------- */
  {
    const { page, errors } = await open(browser);
    await load(page, NOTES);
    await switchTab(page, null);
    const tabs = await page.locator(".canvas-tab").allInnerTexts();
    check("タブ: All と大項目 4 つが並ぶ", tabs.length === 5 && tabs[0].trim() === "All", JSON.stringify(tabs.map((t) => t.trim())));

    // All の大項目をダブルクリックするとそのタブが開く (1 回のクリックでは開かない)
    const apiId = await idOf(page, "API");
    const pt = await page.evaluate((id) => { const rf = window.boxglow.rf; const n = rf.getInternalNode(id); return rf.flowToScreenPosition({ x: n.internals.positionAbsolute.x + 60, y: n.internals.positionAbsolute.y + 14 }); }, apiId);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(400);
    const afterClick = await page.evaluate(() => { const s = window.boxglow.store.getState(); return { scope: s.viewScope, sel: s.selection.blockId }; });
    check("クリック 1 回では選ぶだけ (タブは開かない)", afterClick.scope === null && afterClick.sel === apiId, JSON.stringify(afterClick));
    await page.mouse.dblclick(pt.x, pt.y);
    await page.waitForTimeout(900);
    check("ダブルクリックで大項目のタブが開く", (await page.evaluate(() => window.boxglow.store.getState().viewScope)) === apiId);
    const inTab = await page.evaluate(() => ({ blocks: document.querySelectorAll(".react-flow__node-block").length, terminals: document.querySelectorAll(".react-flow__node-terminal").length }));
    check("タブの中: 大項目の箱と中の箱、Inputs / Outputs ノードが出る", inTab.blocks >= 6 && inTab.terminals === 2, JSON.stringify(inTab));

    // 箱を選ぶと右に詳細が出る
    const signIn = await idOf(page, "Sign-in");
    await page.evaluate((id) => window.boxglow.store.getState().select({ blockId: id }), signIn);
    await page.waitForTimeout(400);
    const panel = await page.locator("aside.right").innerText();
    check("箱を選ぶと右のパネルに題名と判断の質問が出る", panel.includes("Which sign-in method should ship first?") && (await page.locator("aside.right input.input").first().inputValue()) === "Sign-in");

    // 判断: 帯に判断待ち → 一覧で答える → 答えた後も Answered に残る (AI が引き取るまで)
    const chip = await page.locator(".summary-chip").innerText();
    check("上の帯に作業中と判断待ちが出る", chip.includes("作業中") && chip.includes("判断待ち"), chip.replace(/\n/g, " "));
    await page.evaluate(() => window.boxglow.store.getState().select({ timeline: true }));
    await page.waitForTimeout(400);
    await page.locator("aside.right textarea").first().fill("Email magic link で進める");
    await page.locator("aside.right").getByRole("button", { name: "Answer", exact: true }).first().click(); // タブの「Answered」と区別する
    await page.waitForTimeout(600);
    const after = await page.locator("aside.right").innerText();
    const dec = await page.evaluate((id) => { const d = window.boxglow.store.getState().project.blocks[id].decisions[0]; return { answer: d.answer, by: d.answeredBy, acked: !!d.ackedAt }; }, signIn);
    check("答えた直後も一覧に残り、どの箱の何への回答か分かる (AI 未確認)", /answered/i.test(after) && after.includes("Sign-in") && after.includes("Email magic link で進める") && after.includes("AI 未確認"), "");
    check("人の回答は AI が引き取るまで未確認のまま", dec.answer === "Email magic link で進める" && dec.by === "human" && !dec.acked, JSON.stringify(dec));
    check("帯に回答済みが出る", (await page.locator(".summary-chip").innerText()).includes("回答済み"));
    // Activity は項目ごとのタブ: 件数つきの 5 つのタブがあり、押した項目だけが出る
    const tabLabels = (await page.locator("aside.right .seg__btn").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
    check("Activity: 項目ごとのタブ (件数つき) が並ぶ", tabLabels.length === 5 && tabLabels[0].startsWith("Decisions") && tabLabels[1] === "Answered 1" && tabLabels[2] === "Working 1", JSON.stringify(tabLabels));
    await page.locator("aside.right .seg__btn", { hasText: "Working" }).click();
    await page.waitForTimeout(300);
    const working = await page.locator("aside.right").innerText();
    check("Activity: Working を開くと作業中の箱だけが出る", working.includes("Full-text search") && !working.includes("Email magic link で進める"), "");
    await page.locator("aside.right .seg__btn", { hasText: "Log" }).click();
    await page.waitForTimeout(300);
    check("Activity: Log を開くと記録が出る", (await page.locator("aside.right .tl-row").count()) > 5);

    // 線を選んだままタブを移る: All で大項目どうしの線を選び、行き先の箱をダブルクリック
    await switchTab(page, null);
    const edge = await page.evaluate(() => {
      const s = window.boxglow.store.getState(); const p = s.project;
      const by = (t) => Object.values(p.blocks).find((b) => b.title === t).id;
      const e = Object.values(p.edges).find((x) => p.ports[x.from.portId].blockId === by("Plan and design") && p.ports[x.to.portId].blockId === by("API"));
      s.select({ edgeId: e.id });
      return e.id;
    });
    await page.waitForTimeout(400);
    const marked = (await page.locator('.canvas-tab[data-marked="true"]').allInnerTexts()).map((t) => t.trim());
    check("選んだ線が通るタブに印が付く", marked.includes("All") && marked.includes("API") && marked.includes("Plan and design"), JSON.stringify(marked));
    check("線を 1 本選ぶと光 (halo) が付く", (await page.locator(".react-flow__edge-halo").count()) >= 1);
    const pt2 = await page.evaluate((id) => { const rf = window.boxglow.rf; const n = rf.getInternalNode(id); return rf.flowToScreenPosition({ x: n.internals.positionAbsolute.x + 60, y: n.internals.positionAbsolute.y + 14 }); }, apiId);
    await page.mouse.dblclick(pt2.x, pt2.y);
    await page.waitForTimeout(900);
    const kept = await page.evaluate(() => { const s = window.boxglow.store.getState(); return { edge: s.selection.edgeId, scope: s.viewScope, lit: document.querySelectorAll(".react-flow__edge.edge-net, .react-flow__edge.selected").length }; });
    check("線を選んで行き先の箱をダブルクリックしても、線を選んだままタブが開き、続きが光る", kept.edge === edge && kept.scope === apiId && kept.lit >= 1, JSON.stringify(kept));

    // 箱を選んだときは、つながる線に光を付けない (束が 1 本の帯に潰れるため)
    await switchTab(page, null);
    await page.evaluate(() => { const s = window.boxglow.store.getState(); const pj = Object.values(s.project.blocks).find((b) => b.kind === "project"); s.select({ blockId: pj.id }); });
    await page.waitForTimeout(400);
    check("箱を選んだときは線に光を付けない", (await page.locator(".react-flow__edge-halo").count()) === 0);
    check("操作の間、コンソールにエラーが無い", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.context().close();
  }

  /* ---------------- 4. 英語 UI ---------------- */
  {
    const { page } = await open(browser, { lang: "en" });
    await load(page, NOTES); // 中身が英語の計画なので、日本語が出たら UI の訳し漏れ
    await page.waitForTimeout(3500); // 読み込みの通知が消えるのを待つ
    const leftView = await japaneseLeft(page);
    await page.evaluate(() => { const s = window.boxglow.store.getState(); const b = Object.values(s.project.blocks).find((x) => x.title === "Sign-in"); s.setViewScope(b.id); s.select({ blockId: b.id }); });
    await page.waitForTimeout(700);
    const leftPanel = await japaneseLeft(page);
    await page.evaluate(() => window.boxglow.store.getState().select({ timeline: true }));
    await page.waitForTimeout(500);
    const leftTimeline = await japaneseLeft(page);
    // 例の計画は英語 (lang: en) で作ってあるので、ログの行も含めて日本語が 1 つも出ないこと
    const all = [...new Set([...leftView, ...leftPanel, ...leftTimeline])];
    check("英語 UI: 画面・箱の詳細・一覧に日本語が残らない", all.length === 0, all.slice(0, 5).join(" | "));
    check("英語 UI: html の lang が en", (await page.evaluate(() => document.documentElement.lang)) === "en");
    await page.context().close();
  }

  /* ---------------- 5. VS Code モード ---------------- */
  {
    const { page, errors } = await open(browser, { vscode: true });
    const text = fs.readFileSync(NOTES, "utf8");
    check("VS Code: 起動時に ready を拡張へ送る", (await page.evaluate(() => window.__posted)).some((m) => m.type === "ready"));
    await page.evaluate((t) => window.postMessage({ type: "load", text: t, name: "boxglow.json" }, "*"), text);
    await page.waitForSelector(".react-flow__node-block", { timeout: 10000 });
    const st = await page.evaluate(() => { const s = window.boxglow.store.getState(); return { source: s.source, n: Object.keys(s.project.blocks).length }; });
    check("VS Code: load で開く", st.source === "vscode" && st.n > 10, JSON.stringify(st));
    await page.evaluate(() => { const s = window.boxglow.store.getState(); const b = Object.values(s.project.blocks).find((x) => x.title === "Sign-in"); s.apply((p) => { const q = structuredClone(p); q.blocks[b.id].description = "webview から書いたメモ"; return q; }); });
    await page.waitForTimeout(2200);
    const saves = await page.evaluate(() => window.__posted.filter((m) => m.type === "save"));
    check("VS Code: 画面の変更が save として拡張へ届く", saves.length >= 1 && saves[saves.length - 1].text.includes("webview から書いたメモ"));
    await page.evaluate((t) => window.postMessage({ type: "update", text: t.replace('"name": "Notes app"', '"name": "Notes app (CLI)"'), name: "boxglow.json" }, "*"), text);
    await page.waitForTimeout(500);
    check("VS Code: 外の変更 (update) で読み直す", (await page.evaluate(() => window.boxglow.store.getState().project.name)) === "Notes app (CLI)");
    const hits = await penetrations(page);
    check("VS Code: 線が箱の上を通らない", hits.length === 0, hits.slice(0, 2).map((h) => `${h.src} -> ${h.dst} が ${h.box}`).join(" / "));
    check("VS Code: コンソールにエラーが無い", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.context().close();
  }

  await browser.close();
  const r = result();
  console.log(`\n${r.passed}/${r.passed + r.failed} passed`);
  process.exit(r.failed === 0 ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
