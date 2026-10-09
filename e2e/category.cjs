/**
 * 入力: ローカル preview のデモ計画。出力: テーマ×言語の表示・編集検査と失敗時の終了コード 1。
 * 未選択の図・俯瞰・詳細の別タブ・ツリーで、同じカテゴリを見つけられることを確かめる。
 * サンプルへの編集だけで動き、同期サーバーには接続しない。
 * BOXGLOW_E2E_SHOTS があれば、390px の画面画像を指定フォルダへ保存する。
 */
const { chromium, open, check, result } = require("./lib.cjs");
const fs = require("fs");
const path = require("path");
/** 入力: ローカル環境と任意の画像出力先。出力: Promise<void>。ブラウザは finally で必ず閉じる。 */
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    // 各組合せは新しいページ環境で開始し、前の試験の変更や閲覧専用状態を持ち越さない。
    for (const theme of ["light", "dark"])
      for (const lang of ["ja", "en"]) {
        const { page, errors } = await open(browser, { query: `?demo=1&theme=${theme}&lang=${lang}` });
        // 表示名は翻訳されるため、カテゴリの保存キー build で対象を探し内部 ID を受け取る。
        const data = await page.evaluate(() => {
          const p = window.boxglow.store.getState().project;
          const b = Object.values(p.blocks).find((b) => b.category === "build");
          return { id: b.id, blocks: JSON.stringify(p.blocks) };
        });
        const node = page.locator(`.react-flow__node[data-id="${data.id}"]`);
        const badge = node.locator(".bg-block__head > .bg-block__cat");
        check(`${theme}/${lang}: 選択前にカテゴリ札を読める`, await badge.isVisible());
        const dims = await node.boundingBox();
        // 50% まで縮小してもカテゴリは隠さない。続くクリック前には図を画面内に戻す。
        await page.evaluate(() => window.boxglow.rf.setViewport({ x: 0, y: 0, zoom: 0.5 }));
        check(`${theme}/${lang}: 俯瞰でもカテゴリ札を隠さない`, await badge.isVisible());
        await page.evaluate(() => window.boxglow.rf.fitView({ padding: 0.15, minZoom: 0.05, maxZoom: 1 }));
        await node.locator(".bg-block__title").click();
        const field = page.getByRole("combobox", { name: lang === "ja" ? "カテゴリ" : "Category", exact: true });
        check(
          `${theme}/${lang}: 詳細の先頭に現在のカテゴリ`,
          (await field.isVisible()) && (await field.inputValue()) === "build",
        );
        // 分類欄は「状態」だけに閉じ込めず、「その他」の説明を読んでいる間も出す。
        await page
          .locator(".panel.right .seg__btn")
          .filter({ hasText: lang === "ja" ? "その他" : "More" })
          .first()
          .click();
        check(`${theme}/${lang}: 説明のタブでもカテゴリを確認できる`, await field.isVisible());
        // 実際の選択欄から変更し、図の札とツリーの読み上げ名が同じ分類へ更新されることを確かめる。
        await field.selectOption("research");
        check(
          `${theme}/${lang}: 分類を変えるとボックスにも反映`,
          (await badge.textContent()) === (lang === "ja" ? "調査" : "Research"),
        );
        await page.locator(".tree-toggle").click();
        check(
          `${theme}/${lang}: ツリーのアイコンにも同じカテゴリ`,
          (await page.locator(`.tree-row[data-block-id="${data.id}"] .tree-kind`).getAttribute("aria-label")).includes(
            lang === "ja" ? "調査" : "Research",
          ),
        );
        // 図とツリーで同じカテゴリフィルタを使い、変更したボックスを見失わないことを確認する。
        await page
          .getByTitle(lang === "ja" ? "絞り込み / メンバー / 部品" : "Filters / Members / Parts", { exact: true })
          .click();
        await page
          .locator(".drawer .cat-chip")
          .filter({ hasText: lang === "ja" ? "調査" : "Research" })
          .click();
        check(
          `${theme}/${lang}: カテゴリの絞り込みがツリーにも効く`,
          (await page.locator('.tree-kind[data-category="research"]').count()) === 1,
        );
        await page.locator('.drawer .panel-close').first().click();
        await page.locator(".tree-toggle").click();
        // 空の選択はカテゴリ解除。札が消え、戻した後は readonly の制約が効くことも確認する。
        await field.selectOption("");
        check(`${theme}/${lang}: 未分類へ戻せる`, (await node.locator(".bg-block__cat").count()) === 0);
        await field.selectOption("build");
        await page.evaluate(() => window.boxglow.store.getState().setMode({ readonly: true }));
        check(`${theme}/${lang}: 閲覧専用ではカテゴリ変更不可`, await field.isDisabled());
        await page.setViewportSize({ width: 390, height: 900 });
        check(
          `${theme}/${lang}: 狭い詳細内にカテゴリが収まる`,
          await field.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth;
          }),
        );
        // 画像は検査を通した実画面。出力先が指定されたときだけ作り、通常の検査では画像を残さない。
        const out = process.env.BOXGLOW_E2E_SHOTS;
        if (out) {
          fs.mkdirSync(out, { recursive: true });
          await page.screenshot({ path: path.join(out, `category-${theme}-${lang}-390.png`) });
        }
        check(`${theme}/${lang}: 画面エラーなし`, errors.length === 0, errors.join("\n"));
        await page.close();
      }
  } finally {
    await browser.close();
  }
  console.log("Category:", result());
  if (result().failed) process.exitCode = 1;
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
