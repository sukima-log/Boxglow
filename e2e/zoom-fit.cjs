/**
 * 縮小の下限、パネル開閉時の位置・倍率維持、明示Fitがパネルを避けることを検査する。
 * 使い方: node e2e/zoom-fit.cjs (事前にWebビルドと4173番のプレビューを起動。環境変数はrun.shを参照)。
 */
const { chromium, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    const { page: p, errors } = await open(browser, { query: '?demo=1&lang=ja&theme=dark' });
    const pause = () => p.waitForTimeout(450);
    const zoom = () => p.evaluate(() => window.boxglow.rf.getViewport().zoom);
    const viewport = () => p.evaluate(() => window.boxglow.rf.getViewport());
    const same = (a, b) => Math.abs(a.x - b.x) < .01 && Math.abs(a.y - b.y) < .01 && Math.abs(a.zoom - b.zoom) < .00001;
    const inside = () => p.evaluate(() => {
      const canvas = document.querySelector('.react-flow').getBoundingClientRect();
      let left = canvas.left, right = canvas.right;
      for (const el of document.querySelectorAll('.tree-panel,.drawer,.panel.right:not(.hidden-panel)')) {
        const r = el.getBoundingClientRect();
        if (r.right > canvas.left && r.left <= canvas.left + 16)
          left = Math.max(left, r.right);
        if (r.left < canvas.right && r.right >= canvas.right - 1)
          right = Math.min(right, r.left);
      }
      return [...document.querySelectorAll('.react-flow__node')].filter(e => e.getClientRects().length).every(e => {
        const r = e.getBoundingClientRect();
        return r.left >= left - 2 && r.right <= right + 2 && r.top >= canvas.top - 2 && r.bottom <= canvas.bottom + 2;
      });
    });
    const wheel = async (delta) => {
      const r = await p.locator('.react-flow').boundingBox();
      await p.mouse.move(r.x + r.width * .7, r.y + r.height * .6);
      await p.mouse.wheel(0, delta);
      await pause();
    };
    await pause();
    const initial = await zoom();
    await wheel(4000);
    check('Fitでさらに縮小しても倍率と全体表示を維持', Math.abs(await zoom() - initial) < .001 && await inside());
    await wheel(-600);
    check('Fitから拡大できる', await zoom() > initial + .05);
    await wheel(4000);
    check('拡大後に縮小するとFitで止まり、両端が見える', Math.abs(await zoom() - initial) < .001 && await inside());
    const beforePanels = await viewport();
    await p.getByRole('button', { name: 'サイドバーを表示', exact: true }).click();
    await pause();
    check('左Treeを開いても位置と倍率を維持', same(beforePanels, await viewport()));
    const id = await p.evaluate(() => Object.values(window.boxglow.store.getState().project.blocks).find(b => b.kind === 'task')?.id);
    await p.evaluate(id => window.boxglow.store.getState().select({ blockId: id }), id);
    await pause();
    check('右詳細を同時に開いても位置と倍率を維持', same(beforePanels, await viewport()));
    await p.getByRole('button', { name: '☰', exact: true }).click();
    await pause();
    check('左引き出しを開いても位置と倍率を維持', same(beforePanels, await viewport()));
    await p.getByRole('button', { name: 'Fit', exact: true }).click();
    await pause();
    check('明示のFitは左右パネルと引き出しを避けて全体を収める', await inside());
    const panelZoom = await zoom();
    await wheel(4000);
    check('パネルを開いた状態のFitより縮小しない', Math.abs(await zoom() - panelZoom) < .001 && await inside());
    await p.getByRole('button', { name: '☰', exact: true }).click();
    await pause();
    await p.evaluate(() => window.boxglow.store.getState().select({}));
    await p.getByRole('button', { name: 'サイドバーを隠す', exact: true }).click();
    await pause();
    check('パネルを閉じたら新しい下限まで倍率を引き上げる', Math.abs(await zoom() - initial) < .001);
    await wheel(-600);
    const closeZoom = await zoom();
    await p.getByRole('button', { name: 'サイドバーを表示', exact: true }).click();
    await pause();
    check('拡大中のパネル開閉は倍率を維持', Math.abs(await zoom() - closeZoom) < .001);
    await p.getByRole('button', { name: 'Fit', exact: true }).click();
    await pause();
    check('Fitボタンもパネル内に全体を収める', await inside());
    await p.setViewportSize({ width: 1100, height: 800 });
    await pause();
    check('ウィンドウ縮小でも全体を収める', await inside());
    check('画面エラーなし', errors.length === 0, JSON.stringify(errors));
  }
  finally {
    await browser.close();
  }
  const r = result();
  console.log(r);
  process.exitCode = r.failed ? 1 : 0;
})();
