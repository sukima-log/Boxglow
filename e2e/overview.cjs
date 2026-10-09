/**
 * 明暗テーマでカードの読みやすさ、Topの階層動作、左右の接続点、表示変更で保存データを変えないことを検査する。
 * 使い方: node e2e/overview.cjs (事前にWebビルドと4173番のプレビューを起動。環境変数はrun.shを参照)。
 */
const { chromium, open, check, result, penetrations } = require('./lib.cjs');
const { fixture } = require('./overview-fixture.cjs');
const fs = require('fs'), path = require('path');
(async () => {
  const browser = await chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      const { page: p, errors } = await open(browser, { query: `?demo=1&lang=ja&theme=${theme}` });
      check(`${theme}: デモの全体表示でも題名の実寸が14px以上`, await p.locator(".bg-block:not(.expanded) .bg-block__title").evaluateAll(es => es.length > 0 && es.every(e => parseFloat(getComputedStyle(e).fontSize) * window.boxglow.rf.getViewport().zoom >= 14)));
      const terminalsAtSides = () => p.evaluate(() => {
        const rf = window.boxglow.rf, bs = rf.getNodes().filter(n => !n.hidden && n.type === 'block');
        const positions = bs.map(n => {
          const i = rf.getInternalNode(n.id);
          return { x: i.internals.positionAbsolute.x, w: i.measured?.width ?? n.width };
        });
        const left = Math.min(...positions.map(n => n.x)), right = Math.max(...positions.map(n => n.x + n.w));
        return rf.getNodes().filter(n => !n.hidden && n.type === 'terminal').every(n => n.data.which === 'in' ? n.position.x + (n.measured?.width ?? n.width) <= left : n.position.x >= right);
      });
      check(`${theme}: TopのInputは左・Outputは右`, await terminalsAtSides());
      const initial = await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project));
      const major = await p.locator('.bg-block__toggle[title*="タブ"]').first();
      await major.click();
      await p.waitForTimeout(500);
      check(`${theme}: Topの矢印はその場で展開せずタブを開く`, await p.evaluate(() => !!window.boxglow.store.getState().viewScope));
      check(`${theme}: 階層タブでもInputは左・Outputは右`, await terminalsAtSides());
      check(`${theme}: タブ移動で保存データを変更しない`, initial === await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project)));
      await p.evaluate(q => window.boxglow.store.getState().openProjectObject(q, true), fixture());
      await p.waitForTimeout(700);
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(400);
      const original = await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project));
      check(`${theme}: 依存関係の工程列と見出しが四つ表示される`, JSON.stringify(await p.locator('.bg-stage').allTextContents()) === JSON.stringify(['工程 1', '工程 2', '工程 3', '工程 4']));
      const readingGeometry = await p.evaluate(() => window.boxglow.rf.getNodes().filter(n => !n.hidden).map(n => [n.id, n.position]));
      await p.evaluate(() => window.boxglow.store.getState().setReadingView(false));
      await p.waitForTimeout(400);
      check(`${theme}: 保存配置に戻せる`, await p.locator('.bg-stage').count() === 0 && JSON.stringify(readingGeometry) !== JSON.stringify(await p.evaluate(() => window.boxglow.rf.getNodes().filter(n => !n.hidden).map(n => [n.id, n.position]))));
      const savedGeometry = await p.evaluate(() => window.boxglow.rf.getNodes().filter(n => !n.hidden).map(n => [n.id, n.position]));
      await p.evaluate(() => {
        window.boxglow.store.getState().setReadingView(true);
        window.boxglow.store.getState().setEditMode(true);
      });
      await p.waitForTimeout(400);
      check(`${theme}: Editは保存配置で操作し、工程の見出しを出さない`, await p.locator('.bg-stage').count() === 0 && JSON.stringify(savedGeometry) === JSON.stringify(await p.evaluate(() => window.boxglow.rf.getNodes().filter(n => !n.hidden).map(n => [n.id, n.position]))));
      await p.evaluate(() => window.boxglow.store.getState().setEditMode(false));
      await p.evaluate(() => window.boxglow.store.getState().setReadingView(true));
      await p.waitForTimeout(400);
      check(`${theme}: 工程表示への切替は保存データを変更しない`, original === await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project)));
      const cards = p.locator('.bg-block:not(.expanded)');
      check(`${theme}: 六つのタスクを同時表示`, await cards.count() === 6);
      check(`${theme}: 分類→題名→状態→入力→出力が別の行`, await cards.evaluateAll(bs => bs.every(b => {
        const rect = s => b.querySelector(s).getBoundingClientRect();
        return rect('.bg-block__cat').bottom <= rect('.bg-block__title').top && rect('.bg-block__title').bottom <= rect('.bg-block__meta').top && rect('.bg-block__meta').bottom <= rect('.bg-block__port.in').top + 1 && rect('.bg-block__port.in').bottom <= rect('.bg-block__port.out').top + 1;
      })));
      check(`${theme}: カテゴリはアイコンと文字を併記`, await cards.locator('.bg-block__cat svg').count() === 6);
      check(`${theme}: 長い入出力名もカード内で読める`, await cards.locator('.bg-block__port-name').evaluateAll(es => es.every(e => e.scrollWidth <= e.clientWidth + 1 && e.getBoundingClientRect().bottom <= e.parentElement.getBoundingClientRect().bottom + 1)));
      check(`${theme}: 接続点の中心と入出力名の行が一致`, await cards.evaluateAll(bs => bs.every(b => [...b.querySelectorAll('[data-port-id]')].every(row => {
        const h = b.querySelector(`[data-handleid$=":${row.dataset.portId}:outer"]`);
        if (!h)
          return false;
        const a = row.getBoundingClientRect(), c = h.getBoundingClientRect();
        return Math.abs((a.top + a.bottom - c.top - c.bottom) / 2) < 2;
      }))));
      check(`${theme}: 配線が工程見出しを横切らない`, await p.evaluate(() => {
        const rects = [...document.querySelectorAll('.bg-stage')].map(e => e.getBoundingClientRect());
        return [...document.querySelectorAll('.react-flow__edge-path')].every(path => {
          const m = path.getScreenCTM();
          for (let d = 0; d < path.getTotalLength(); d += 8) {
            const p = path.getPointAtLength(d);
            const q = new DOMPoint(p.x, p.y).matrixTransform(m);
            if (rects.some(r => q.x > r.left + 1 && q.x < r.right - 1 && q.y > r.top + 1 && q.y < r.bottom - 1))
              return false;
          }
          return true;
        });
      }));
      check(`${theme}: ボックスを貫く配線なし`, (await penetrations(p)).length === 0, JSON.stringify(await penetrations(p)));
      await p.evaluate(() => window.boxglow.rf.zoomTo(.5));
      await p.waitForTimeout(200);
      check(`${theme}: 俯瞰でも入出力を隠さない`, await cards.locator('.bg-block__ports').evaluateAll(es => es.every(e => getComputedStyle(e).visibility === 'visible')));
      const before = await p.evaluate(() => window.boxglow.rf.getViewport());
      const area = await p.locator('.react-flow').boundingBox();
      await p.mouse.move(area.x + area.width * .5, area.y + area.height * .5);
      await p.mouse.wheel(0, -220);
      await p.waitForTimeout(300);
      const after = await p.evaluate(() => window.boxglow.rf.getViewport());
      check(`${theme}: ホイールで拡大できる`, after.zoom > before.zoom);
      await p.mouse.wheel(0, 220);
      await p.waitForTimeout(300);
      check(`${theme}: ホイールで縮小できる`, (await p.evaluate(() => window.boxglow.rf.getViewport())).zoom < after.zoom);
      check(`${theme}: 強調解除専用ボタンなし`, await p.getByRole('button', { name: /強調.*解除/ }).count() === 0);
      check(`${theme}: 表示操作は計画を変更しない`, original === await p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project)));
      await p.getByRole('button', { name: 'Fit', exact: true }).click();
      await p.waitForTimeout(300);
      const out = process.env.BOXGLOW_E2E_SHOTS;
      if (out) {
        fs.mkdirSync(out, { recursive: true });
        await p.screenshot({ path: path.join(out, `reference-${theme}.png`) });
        fs.writeFileSync(path.join(out, 'reference-plan.json'), JSON.stringify(fixture(), null, 2));
      }
      check(`${theme}: 画面エラーなし`, errors.length === 0, errors.join('|'));
      await p.context().close();
    }
  }
  finally {
    await browser.close();
  }
  console.log(result());
  process.exitCode = result().failed ? 1 : 0;
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
