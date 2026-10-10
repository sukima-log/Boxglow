/**
 * 自分の計画 (リポジトリ直下の boxglow.json) での、線の質と速さの検査
 * 何を: 全部のタブ (Top と大項目) の線どうしの交差の合計が 220 以下、一番大きいタブへの切り替えが 1.2 秒以内。
 * なぜ: 例の計画 (DAW / notes-app) は小さく、経路選びの罰を変えたときの後退 (交差 162 → 781、切り替え 0.57 秒 → 1.6 秒) を
 *       検出できなかった。ボックスと線が多い本物の計画で見張る。
 * boxglow.json が無い環境 (公開リポジトリを取ってきただけ、など) では何もせずに終わる。ファイルは読むだけで書き換えない
 * (ブラウザ内保存に取り込んで表示する)。
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const fs = require("fs");
const path = require("path");
const { chromium, ROOT, check, result, open, load, majorsOf, switchTab, crossings, penetrations } = require("./lib.cjs");

/** 交差の合計の上限 (修正後の実測は 170 前後。配置を少し変えても通り、後退 (数百) は落とす値) */
const MAX_CROSSINGS = 220;
/** 一番大きいタブへの切り替えの上限 (ms。修正後の実測は 600 前後) */
const MAX_SWITCH_MS = 1200;

(async () => {
  const file = path.join(ROOT, "boxglow.json");
  if (!fs.existsSync(file)) { console.log("自分の計画 (boxglow.json) が無いので、この検査は省きます"); return; }
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser);
    await load(page, file);
    const majors = await majorsOf(page);
    // 一番大きいタブ = 中のボックス (子孫) の数が一番多い大項目
    const sizes = await page.evaluate((ids) => {
      const bs = Object.values(window.boxglow.store.getState().project.blocks);
      const kids = new Map();
      for (const b of bs) { const l = kids.get(b.parentId) ?? []; l.push(b.id); kids.set(b.parentId, l); }
      const count = (id) => (kids.get(id) ?? []).reduce((n, c) => n + 1 + count(c), 0);
      return ids.map((id) => count(id));
    }, majors.map((m) => m.id));
    const big = majors[sizes.indexOf(Math.max(...sizes))];

    // 交差: Top と全部の大項目のタブを順に開いて数える
    let total = 0;
    const per = [];
    const hits = [];
    for (const m of [{ id: null, title: "Top" }, ...majors]) {
      await switchTab(page, m.id);
      hits.push(...(await penetrations(page)).map(hit => ({ view: m.title, ...hit })));
      const n = await crossings(page);
      total += n;
      if (n > 0) per.push(`${m.title} ${n}`);
    }
    check(`自分の計画: 線どうしの交差の合計が ${MAX_CROSSINGS} 以下`, total <= MAX_CROSSINGS, `合計 ${total} (${per.join(", ")})`);
    // 大項目が 9 個以上の計画では、完了した大項目のタブが「✓ n」に畳まれ、押すと展開する
    const majorsN = await page.evaluate(() => { const s = window.boxglow.store.getState(); const pj = new Set(Object.values(s.project.blocks).filter((b) => b.kind === "project").map((b) => b.id)); return Object.values(s.project.blocks).filter((b) => pj.has(b.parentId)).length; });
    if (majorsN >= 9) {
      const before = await page.locator(".canvas-tab").count();
      check("自分の計画: 完了した大項目のタブが畳まれる", await page.locator(".canvas-tab--done-fold").count() === 1 && before < majorsN + 1, `${before} / ${majorsN}`);
      await page.locator(".canvas-tab--done-fold").click(); await page.waitForTimeout(300);
      check("自分の計画: 畳んだタブを押すと展開する", await page.locator(".canvas-tab").count() === majorsN + 2);
    }

    check("自分の計画: どのタブでもボックスを貫く配線がない", hits.length === 0, JSON.stringify(hits));

    // 速さ: Top → 一番大きいタブ を 3 回測り、真ん中の値で判定する (1 回だけの引っかかりで落とさない)
    const times = [];
    for (let i = 0; i < 3; i++) {
      await switchTab(page, null);
      times.push(await switchTab(page, big.id));
    }
    const median = [...times].sort((a, b) => a - b)[1];
    check("自分の計画: 切り替えの時間が測れている (0 ms ではない)", times.every((t) => t > 0), times.join(" / ") + " ms");
    check(`自分の計画: 一番大きいタブ (${big.title}、ボックス ${Math.max(...sizes)} 個) への切り替えが ${MAX_SWITCH_MS / 1000} 秒以内`, median <= MAX_SWITCH_MS, `${times.join(" / ")} ms (中央値 ${median} ms)`);
    check("自分の計画: 実行時のエラーが無い", errors.length === 0, errors.join(" | "));
    await page.context().close();
  } finally { await browser.close(); }
  const { passed, failed } = result();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
