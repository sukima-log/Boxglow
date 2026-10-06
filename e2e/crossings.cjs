/**
 * 線どうしの交差を数える (経路の質の目安。変更の前後で比べる)
 * 使い方: PLAYWRIGHT=... node e2e/crossings.cjs (run.sh と同じ環境変数。プレビューが 4173 番で動いていること)
 */
const fs = require("fs");
const path = require("path");
const { chromium, ROOT, open, load, majorsOf, switchTab, crossings } = require("./lib.cjs");

(async () => {
  const browser = await chromium.launch();
  const plans = [["DAW の例", path.join(ROOT, "examples/logic-daw/boxglow.json")], ["notes-app の例", path.join(ROOT, "examples/notes-app/boxglow.json")]];
  if (fs.existsSync(path.join(ROOT, "boxglow.json"))) plans.push(["自分の計画", path.join(ROOT, "boxglow.json")]);
  for (const [label, file] of plans) {
    const { page } = await open(browser);
    await load(page, file);
    const majors = await majorsOf(page);
    let total = 0;
    const per = [];
    for (const m of [{ id: null, title: "Top" }, ...majors]) {
      await switchTab(page, m.id);
      const n = await crossings(page);
      total += n;
      if (n > 0) per.push(`${m.title} ${n}`);
    }
    console.log(`${label}: 交差 ${total} (${per.join(", ")})`);
    await page.context().close();
  }
  await browser.close();
})();
