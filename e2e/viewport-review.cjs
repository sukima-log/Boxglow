/**
 * 選択時の位置維持、Fit倍率でのパン、手動調整後/全体表示中のリサイズ、実測Fitの待機上限を検査する。
 * 使い方: node e2e/viewport-review.cjs (事前にWebビルドと4173番のプレビューを起動。環境変数はrun.shを参照)。
 */
const { chromium, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    const { page: p, errors } = await open(browser, { query: '?demo=1&lang=ja&theme=dark' });
    const viewport = () => p.evaluate(() => window.boxglow.rf.getViewport());
    const same = (a, b) => Math.abs(a.x - b.x) < .1 && Math.abs(a.y - b.y) < .1 && Math.abs(a.zoom - b.zoom) < .00001;
    const ids = await p.locator('.react-flow__node-block').evaluateAll(es => es.map(e => e.dataset.id));
    for (const id of ids) {
      await p.evaluate(() => window.boxglow.store.getState().select({}));
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(400);
      const before = await viewport();
      await p.getByTestId('rf__node-' + id).locator('.bg-block__title').click();
      await p.waitForTimeout(500);
      check('Topの各ボックスをクリックしても位置と倍率を維持: ' + id, same(before, await viewport()));
    }
    await p.evaluate(() => window.boxglow.store.getState().select({}));
    for (const mode of ['View', 'Edit']) {
      if (mode === 'Edit')
        await p.locator('.mode-toggle').click();
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(400);
      const fit = await viewport(), canvas = await p.locator('.react-flow').boundingBox();
      const x = canvas.x + canvas.width - 12, y = canvas.y + canvas.height / 2;
      await p.mouse.move(x, y);
      await p.mouse.down();
      await p.mouse.move(x - 80, y + 80, { steps: 8 });
      await p.mouse.up();
      await p.waitForTimeout(400);
      const moved = await viewport();
      check(mode + ': Fit倍率でパンしても元の位置へ戻らない', Math.abs(moved.x - fit.x + 80) < 2 && Math.abs(moved.y - fit.y - 80) < 2 && Math.abs(moved.zoom - fit.zoom) < .00001, JSON.stringify({ fit, moved }));
      await p.evaluate(() => {
        const s = window.boxglow.store.getState(), id = Object.values(s.project.blocks).find(b => b.parentId && b.kind !== 'project').id;
        s.apply(q => ({ ...q, blocks: { ...q.blocks, [id]: { ...q.blocks[id], description: 'viewport regression' } } }));
      });
      await p.waitForTimeout(400);
      check(mode + ': 内容だけ更新しても位置と倍率を維持', same(moved, await viewport()));
    }
    await p.locator('.mode-toggle').click();
    await p.waitForTimeout(400);
    // 手で拡大・移動した表示と、全体表示中のリサイズを分けて検査する。
    for (const direction of ['横', '縦']) {
      if (direction === '縦') {
        await p.getByRole('button', { name: '縦フロー', exact: true }).click();
        await p.waitForTimeout(500);
      }
      await p.evaluate(async () => {
        const rf = window.boxglow.rf, v = rf.getViewport();
        await rf.setViewport({ x: v.x - 180, y: v.y - 160, zoom: 1.5 });
      });
      const manual = await viewport();
      await p.setViewportSize({ width: 1200, height: 800 });
      await p.waitForTimeout(500);
      check(direction + ': 手動調整後にウィンドウを縮めても位置・倍率を維持', same(manual, await viewport()));
      await p.setViewportSize({ width: 1600, height: 1000 });
      await p.waitForTimeout(500);
      check(direction + ': 手動調整後にウィンドウを広げても位置・倍率を維持', same(manual, await viewport()));
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(400);
      await p.setViewportSize({ width: 1200, height: 800 });
      await p.waitForTimeout(500);
      const autoFit = await viewport();
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(400);
      check(direction + ': 全体表示中の縮小リサイズは新しいFitと一致', same(autoFit, await viewport()));
      await p.setViewportSize({ width: 1600, height: 1000 });
      await p.waitForTimeout(500);
      const largerFit = await viewport();
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(400);
      check(direction + ': 全体表示中の拡大リサイズは新しいFitと一致', same(largerFit, await viewport()));
    }
    await p.getByRole('button', { name: '横フロー', exact: true }).click();
    await p.waitForTimeout(500);
    // CSS の実寸がモデル寸法と一致しなくても、階層移動の Fit 待ちが終了する。
    await p.addStyleTag({ content: '.react-flow__node-block { min-width: 720px !important; }' });
    await p.getByRole('tab', { name: 'In Progress 実装する', exact: true }).click();
    await p.waitForTimeout(1100);
    check('測定値が指定幅と不一致でも実測範囲へFitする', await p.evaluate(() => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      return [...document.querySelectorAll('.react-flow__node')].filter(n => n.getClientRects().length).every(n => {
        const r = n.getBoundingClientRect();
        return r.left >= c.left - 2 && r.top >= c.top - 2 && r.right <= c.right + 2 && r.bottom <= c.bottom + 2;
      });
    }));
    check('実行エラーなし', errors.length === 0, JSON.stringify(errors));
  }
  finally {
    await browser.close();
  }
  const r = result();
  console.log(r);
  process.exitCode = r.failed ? 1 : 0;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
