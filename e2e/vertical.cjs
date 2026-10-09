/**
 * 明暗テーマで縦フローの上下ポート、スクロール、配線、幅合わせ、横表示との切り替えを検査する。
 * 使い方: node e2e/vertical.cjs (事前にWebビルドと4173番のプレビューを起動。環境変数はrun.shを参照)。
 */
const { chromium, open, check, result, penetrations } = require('./lib.cjs');
const { fixture } = require('./overview-fixture.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const { page: p, errors } = await open(browser, { query: `?demo=daw&lang=ja&theme=${theme}` });
      const pause = () => p.waitForTimeout(500), vp = () => p.evaluate(() => window.boxglow.rf.getViewport());
      await p.getByRole('tab', { name: 'In Progress サウンドエンジン', exact: true }).click();
      await pause();
      const original = await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project));
      await p.getByRole('button', { name: '縦フロー', exact: true }).click();
      await pause();
      const first = await vp();
      check(`${theme}: 縦への切替は幅に合わせた読み取り倍率`, Math.abs(first.zoom - 1) < .001, JSON.stringify(first));
      check(`${theme}: 入力は上、出力は下の専用カード`, await p.locator('.vertical-card:not(.expanded)').evaluateAll(es => es.length > 5 && es.every(e => {
        const r = e.getBoundingClientRect();
        return [...e.querySelectorAll('.react-flow__handle')].every(h => {
          const b = h.getBoundingClientRect();
          return Math.abs(b.y + b.height / 2 - (h.dataset.handleid.startsWith('in:') ? r.top : r.bottom)) < 3;
        });
      })));
      check(`${theme}: 親の内側の接続点はポート名の外にある`, await p.locator('.vertical-card.expanded').evaluateAll(es => es.every(e => {
        const band = e.querySelector('.vertical-ports.in');
        if (!band)
          return true;
        return [...e.querySelectorAll('.port-inner[data-handleid^="in:"]')].every(h => h.getBoundingClientRect().top >= band.getBoundingClientRect().bottom - 1);
      })));
      const wheel = async (d) => {
        const r = await p.locator('.react-flow').boundingBox();
        await p.mouse.move(r.x + r.width * .75, r.y + r.height * .65);
        await p.mouse.wheel(0, d);
        await pause();
      };
      await wheel(800);
      let moved = await vp();
      check(`${theme}: ホイールは倍率を変えず上下スクロール`, Math.abs(first.zoom - moved.zoom) < .001 && moved.y < first.y - 100);
      await p.keyboard.down('Control');
      await wheel(-400);
      await p.keyboard.up('Control');
      check(`${theme}: Ctrlホイールで拡大できる`, (await vp()).zoom > moved.zoom);
      await p.getByRole('button', { name: '幅に合わせる', exact: true }).click();
      await pause();
      await p.getByRole('button', { name: 'サイドバーを表示', exact: true }).click();
      await pause();
      await p.getByRole('button', { name: '幅に合わせる', exact: true }).click();
      await pause();
      check(`${theme}: 左パネルを開いて幅合わせすると横幅が収まる`, await p.evaluate(() => {
        const canvas = document.querySelector('.react-flow').getBoundingClientRect();
        return [...document.querySelectorAll('.react-flow__node')].filter(e => e.getClientRects().length).every(e => {
          const r = e.getBoundingClientRect();
          return r.left >= canvas.left - 2 && r.right <= canvas.right + 2;
        });
      }));
      const blockId = await p.locator('.vertical-card:not(.expanded)').first().evaluate(e => e.closest('.react-flow__node').dataset.id);
      await p.evaluate(id => window.boxglow.store.getState().select({ blockId: id }), blockId);
      await pause();
      await p.getByRole('button', { name: '☰', exact: true }).click();
      await pause();
      await p.getByRole('button', { name: '幅に合わせる', exact: true }).click();
      await pause();
      check(`${theme}: 左右パネルと引き出しを開いて幅合わせすると収まる`, await p.evaluate(() => {
        const c = document.querySelector('.react-flow').getBoundingClientRect(), d = document.querySelector('.drawer').getBoundingClientRect();
        return [...document.querySelectorAll('.react-flow__node')].filter(e => e.getClientRects().length).every(e => {
          const r = e.getBoundingClientRect();
          return r.left >= Math.max(c.left, d.right) - 2 && r.right <= c.right + 2;
        });
      }));
      await p.getByRole('button', { name: '☰', exact: true }).click();
      await p.evaluate(() => window.boxglow.store.getState().select({}));
      await pause();
      await wheel(100000);
      check(`${theme}: スクロールで最後のOutputまで読める`, await p.locator('[data-id="scope-out"]').evaluate(e => {
        const r = e.getBoundingClientRect(), c = document.querySelector('.react-flow').getBoundingClientRect();
        return r.top >= c.top && r.bottom <= c.bottom;
      }));
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await pause();
      const fit = await vp();
      await p.keyboard.down('Control');
      await wheel(4000);
      await p.keyboard.up('Control');
      check(`${theme}: 縦表示もFitより小さくならない`, Math.abs((await vp()).zoom - fit.zoom) < .001);
      const hits = await penetrations(p);
      check(`${theme}: 深い階層の配線が他の箱を貫かない`, hits.length === 0, JSON.stringify(hits));
      const id = await p.locator('.react-flow__edge.edge-ready').first().getAttribute('data-id');
      await p.evaluate(id => window.boxglow.store.getState().select({ edgeId: id }), id);
      await pause();
      check(`${theme}: 縦の配線も選択時は従来の動く破線`, await p.locator(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`).evaluate(e => getComputedStyle(e).animationName === 'edge-flow' && getComputedStyle(e).strokeDasharray === '14px, 10px'));
      await p.evaluate(() => window.boxglow.store.getState().select({}));
      await p.locator('.mode-toggle').click();
      await pause();
      check(`${theme}: 編集は既存の左右ポートに戻る`, await p.locator('.vertical-card').count() === 0 && await p.getByRole('button', { name: '縦フロー', exact: true }).isDisabled());
      await p.locator('.mode-toggle').click();
      await pause();
      check(`${theme}: Viewへ戻すと縦表示を復元`, await p.locator('.vertical-card').count() > 0);
      await p.getByRole('button', { name: '横フロー', exact: true }).click();
      await pause();
      check(`${theme}: 横表示に切り替えられる`, await p.locator('.vertical-card').count() === 0);
      check(`${theme}: 表示切替は保存データを変更しない`, original === await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project)));
      await p.evaluate(async (q) => {
        await window.boxglow.store.getState().importJSON(JSON.stringify(q));
        window.boxglow.store.getState().setViewScope('app');
      }, fixture());
      await pause();
      await p.getByRole('button', { name: '縦フロー', exact: true }).click();
      await pause();
      check(`${theme}: 分岐先の設計タスクを横に並べ、後続を下へ置く`, await p.evaluate(() => {
        const rf = window.boxglow.rf, a = rf.getNode('a'), d = rf.getNode('d'), u = rf.getNode('u');
        return a.position.y === d.position.y && a.position.x !== d.position.x && u.position.y > d.position.y + d.height;
      }));
      check(`${theme}: 並行フローも配線が箱を貫かない`, (await penetrations(p)).length === 0);
      check(`${theme}: 複数ポートの名前が帯からはみ出さない`, await p.locator('.vertical-port__name').evaluateAll(es => es.every(e => {
        const b = e.closest('.vertical-ports').getBoundingClientRect(), r = e.getBoundingClientRect();
        return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
      })));
      if (process.env.BOXGLOW_E2E_SHOTS)
        await p.screenshot({ path: process.env.BOXGLOW_E2E_SHOTS + '/vertical-parallel-' + theme + '.png' });
      check(`${theme}: 実行エラーなし`, !errors.length, JSON.stringify(errors));
      await p.context().close();
    }
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
