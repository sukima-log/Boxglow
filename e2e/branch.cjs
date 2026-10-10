/**
 * 分岐と合流の画面の検査:
 *   - 答える前: 分岐のボックスに「分岐」の札、その先のボックスは「分岐待ち」(点線の枠)
 *   - 詳細パネルで選択肢を押して答えると: 分岐のボックスは完了、選んだ道は ✓、選ばなかった道の先は「見送り」(薄く・取り消し線)、
 *     見送りは完了数の分母から外れ、合流の入力を持つ結合テストは見送りにならない
 *   - 上部の「+ Block」のメニューの「Branch (IF)」から、問いと選択肢で分岐を足せる (選択肢ごとに道ができる)
 *   - 詳細パネルの ⋯ の「分岐にする」で、今あるボックスを分岐に変えられる (今の出力は 1 つ目の道、線は残る)
 * 計画は e2e/fixtures/branch.boxglow.json (設計 → 分岐 (REST / GraphQL) → 各実装 → 結合テスト (合流))
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const path = require('path');
const { chromium, ROOT, open, load, check, result } = require('./lib.cjs');

(async () => {
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(browser, { query: '?lang=ja' });
    await load(page, path.join(ROOT, 'e2e/fixtures/branch.boxglow.json'));
    // ボックスの要素を題名で引く
    const box = (title) => page.locator('.react-flow__node-block', { has: page.locator('.bg-block__title', { hasText: new RegExp(`^${title}$`) }) }).first().locator('.bg-block');

    // ---- 答える前 ----
    check('分岐: 分岐のボックスに「分岐」の札が付く', await box('API の方式を決める').locator('.bg-block__tag.branch').isVisible());
    check('分岐: 答える前は、各道と合流先が「分岐待ち」', (await box('REST で実装する').getAttribute('class')).includes('branch-waiting')
      && (await box('GraphQL で実装する').getAttribute('class')).includes('branch-waiting')
      && (await box('結合テスト').getAttribute('class')).includes('branch-waiting'));
    const totalBefore = await page.evaluate(() => document.body.innerText.match(/Done \d+ \/ (\d+)/)?.[1]);

    // ---- 詳細パネルで REST を選んで答える ----
    await box('API の方式を決める').click(); await page.waitForTimeout(400);
    await page.locator('.panel.right button', { hasText: /^REST$/ }).first().click(); await page.waitForTimeout(600);
    const st = await page.evaluate(() => { const s = window.boxglow.store.getState(); const b = Object.values(s.project.blocks).find((x) => x.title === 'API の方式を決める'); return b.status; });
    check('分岐: 選択肢で答えると、分岐のボックスは完了になる', st === 'white', st);
    check('分岐: 選んだ道は ✓、選ばなかった道は見送りの印', await box('API の方式を決める').locator('.bg-block__port.out.branch-chosen').innerText().then((x) => x.includes('REST'))
      && await box('API の方式を決める').locator('.bg-block__port.out.branch-rejected').innerText().then((x) => x.includes('GraphQL')));
    check('分岐: 選ばなかった道の先のボックスは「見送り」', (await box('GraphQL で実装する').getAttribute('class')).includes('is-skipped')
      && await box('GraphQL で実装する').locator('.meta-chip.skipped').isVisible());
    check('分岐: 選んだ道と合流先は、見送りでも分岐待ちでもない', !/is-skipped|branch-waiting/.test(await box('REST で実装する').getAttribute('class'))
      && !/is-skipped|branch-waiting/.test(await box('結合テスト').getAttribute('class')));
    const totalAfter = await page.evaluate(() => document.body.innerText.match(/Done \d+ \/ (\d+)/)?.[1]);
    check('分岐: 見送りのボックスは完了数の分母から外れる', Number(totalAfter) === Number(totalBefore) - 1, `${totalBefore} -> ${totalAfter}`);

    // ---- 「+ Block」のメニューから分岐を足す ----
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } }); await page.waitForTimeout(200);
    await page.getByRole('button', { name: '+ Block', exact: true }).click();
    const addItems = await page.getByRole('menu', { name: '足すもの' }).getByRole('menuitem').allInnerTexts();
    check('追加: 「+ Block」で Block / Branch (IF) / Merge を選ぶメニューが開く', addItems.length === 3 && /Block/.test(addItems[0]) && /Branch \(IF\)/.test(addItems[1]) && /Merge/.test(addItems[2]), JSON.stringify(addItems));
    await page.getByRole('menuitem', { name: /^Branch \(IF\)/ }).click();
    const dialog = page.getByRole('dialog', { name: '分岐を足す' });
    check('分岐: 選択肢が 2 つそろうまで「分岐を足す」は押せない', await dialog.getByRole('button', { name: '分岐を足す', exact: true }).isDisabled());
    await dialog.getByPlaceholder('例: API の方式はどれにしますか?').fill('公開先はどれにしますか?');
    await dialog.locator('textarea').fill('静的ホスティング\n自前のサーバー');
    await dialog.getByRole('button', { name: '分岐を足す', exact: true }).click(); await page.waitForTimeout(600);
    const made = await page.evaluate(() => { const s = window.boxglow.store.getState(); const b = Object.values(s.project.blocks).find((x) => x.title === '公開先はどれにしますか?'); if (!b) return null; return { branch: !!b.branch, outs: Object.values(s.project.ports).filter((q) => q.blockId === b.id && q.direction === 'out').map((q) => q.branchOption), selected: s.selection.blockId === b.id }; });
    check('分岐: ダイアログから足した分岐は、選択肢ごとの道を持ち、選ばれた状態になる', !!made && made.branch && made.outs.join('|') === '静的ホスティング|自前のサーバー' && made.selected, JSON.stringify(made));

    // ---- 「+ Block」のメニューから合流の部品を足す (OR ゲート風の形で描かれ、作業の件数には入らない) ----
    const totalBeforeMerge = await page.evaluate(() => document.body.innerText.match(/Done \d+ \/ (\d+)/)?.[1]);
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } }); await page.waitForTimeout(200);
    await page.getByRole('button', { name: '+ Block', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Merge/ }).click(); await page.waitForTimeout(600);
    const mergeMade = await page.evaluate(() => { const s = window.boxglow.store.getState(); const b = s.project.blocks[s.selection.blockId]; return b ? { merge: !!b.merge, title: b.title } : null; });
    check('合流: 「+ Block」のメニューの「Merge」で合流の部品が足され、選ばれた状態になる', !!mergeMade && mergeMade.merge, JSON.stringify(mergeMade));
    check('合流: 合流の部品は OR ゲート風の形で描かれる', await page.locator('.bg-block.kind-merge .bg-merge svg').count() >= 1);
    check('合流: 部品の表記は「OR」だけ', (await page.locator('.bg-block.kind-merge .bg-merge').first().innerText()).trim() === 'OR');
    check('分岐: 分岐のボックスには、八角形の枠と「IF」の印が付く', await page.locator('.bg-block.kind-branch:not(.expanded) .bg-branch-outline').count() >= 1 && (await page.locator('.bg-block.kind-branch .bg-branch-emblem').first().innerText()).trim() === 'IF');
    const totalAfterMerge = await page.evaluate(() => document.body.innerText.match(/Done \d+ \/ (\d+)/)?.[1]);
    check('合流: 合流の部品は完了数の分母に入らない', totalAfterMerge === totalBeforeMerge, `${totalBeforeMerge} -> ${totalAfterMerge}`);

    // ---- 今あるボックスを分岐に変える (詳細パネルの ⋯ →「分岐にする」) ----
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } }); await page.waitForTimeout(200);
    await box('設計する').click(); await page.waitForTimeout(400);
    await page.locator('.panel.right button[title="その他"]').click();
    await page.getByRole('button', { name: /分岐にする/ }).click();
    const convert = page.getByRole('dialog', { name: '分岐にする' });
    check('分岐にする: 変えるときは題名の欄を出さない', await convert.getByPlaceholder('例: API の方式を決める').count() === 0);
    await convert.getByPlaceholder('例: API の方式はどれにしますか?').fill('設計の進め方は?');
    await convert.locator('textarea').fill('画面から\nAPI から');
    await convert.getByRole('button', { name: '分岐にする', exact: true }).click(); await page.waitForTimeout(600);
    const converted = await page.evaluate(() => { const s = window.boxglow.store.getState(); const b = Object.values(s.project.blocks).find((x) => x.title === '設計する'); const outs = Object.values(s.project.ports).filter((q) => q.blockId === b.id && q.direction === 'out'); return { branch: !!b.branch, outs: outs.map((q) => q.branchOption), wired: Object.values(s.project.edges).some((e) => e.from.portId === outs[0]?.id) }; });
    check('分岐にする: 今の出力は 1 つ目の道になり、線も残る。2 つ目の道が足される', converted.branch && converted.outs.join('|') === '画面から|API から' && converted.wired, JSON.stringify(converted));
    check('分岐にする: 変えたボックスに「分岐」の札が付く', await box('設計する').locator('.bg-block__tag.branch').isVisible());

    check('分岐: 実行時のエラーが無い', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
  const r = result();
  console.log(`${r.passed}/${r.passed + r.failed} passed`);
  process.exit(r.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
