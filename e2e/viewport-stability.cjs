/**
 * 縦・横フローで、縮小とスクロールの限界に達しても揺れないこと、および修飾キーホイールの方向を検査する。
 * 使い方: node e2e/viewport-stability.cjs (事前にWebビルドと4173番のプレビューを起動。環境変数はrun.shを参照)。
 */
const { chromium, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    const { page: p, errors } = await open(browser, { query: '?demo=daw&lang=ja&theme=dark' });
    await p.getByRole('tab', { name: 'In Progress サウンドエンジン', exact: true }).click();
    await p.getByRole('button', { name: '縦フロー', exact: true }).click();
    await p.waitForTimeout(500);
    const measure = async (delta, ctrl = false) => {
      const box = await p.locator('.react-flow').boundingBox();
      await p.mouse.move(box.x + box.width * .8, box.y + box.height * .5);
      if (ctrl)
        await p.keyboard.down('Control');
      await p.evaluate(() => {
        window.__vpSamples = [window.boxglow.rf.getViewport()];
        window.__vpObserver = new MutationObserver(() => window.__vpSamples.push(window.boxglow.rf.getViewport()));
        window.__vpObserver.observe(document.querySelector('.react-flow__viewport'), { attributes: true, attributeFilter: ['style'] });
      });
      for (let i = 0; i < 6; i++) {
        await p.mouse.wheel(0, delta);
        await p.waitForTimeout(40);
      }
      await p.waitForTimeout(400);
      if (ctrl)
        await p.keyboard.up('Control');
      return p.evaluate(() => {
        window.__vpObserver.disconnect();
        const a = window.__vpSamples;
        return Object.fromEntries(['x', 'y', 'zoom'].map(k => [k, Math.max(...a.map(v => v[k])) - Math.min(...a.map(v => v[k]))]));
      });
    };
    const stable = (v) => v.x < .01 && v.y < .01 && v.zoom < .00001;
    await p.getByRole('button', { name: 'Fit', exact: true }).click();
    await p.waitForTimeout(300);
    let v = await measure(240);
    check('縮小下限で通常ホイールを続けても途中のフレームを含めて揺れない', stable(v), JSON.stringify(v));
    v = await measure(240, true);
    check('縮小下限でCtrlホイールを続けても揺れない', stable(v), JSON.stringify(v));
    await p.getByRole('button', { name: '幅に合わせる', exact: true }).click();
    await p.waitForTimeout(300);
    v = await measure(-240);
    check('縦スクロールの先頭で上へ回しても揺れない', stable(v), JSON.stringify(v));
    await measure(100000);
    v = await measure(240);
    check('縦スクロールの末尾で下へ回しても揺れない', stable(v), JSON.stringify(v));
    // 修飾キーの移動方向は両モード共通。倍率ともう一方の軸を保持する。
    await p.setViewportSize({ width: 1200, height: 1000 });
    await p.waitForTimeout(300);
    for (const direction of ['横フロー', '縦フロー']) {
      await p.getByRole('button', { name: direction, exact: true }).click();
      await p.waitForTimeout(400);
      await p.getByRole('button', { name: '100% で文字を読む', exact: true }).click();
      await p.waitForTimeout(300);
      for (let i = 0; i < 4; i++)
        await p.getByRole('button', { name: '拡大', exact: true }).click();
      await p.waitForTimeout(300);
      const box = await p.locator('.react-flow').boundingBox();
      await p.mouse.move(box.x + box.width * .8, box.y + box.height * .5);
      const before = await p.evaluate(() => window.boxglow.rf.getViewport());
      await p.keyboard.down('Control');
      await p.keyboard.down('Shift');
      try {
        await p.mouse.wheel(0, 240);
        await p.waitForTimeout(400);
        const right = await p.evaluate(() => window.boxglow.rf.getViewport());
        check(direction + ': Ctrl+Shift+下ホイールで右へ進み、倍率と縦位置は維持', right.x < before.x - 10 && Math.abs(right.y - before.y) < .01 && Math.abs(right.zoom - before.zoom) < .00001, JSON.stringify({ before, right }));
        await p.mouse.wheel(0, -240);
        await p.waitForTimeout(400);
        const left = await p.evaluate(() => window.boxglow.rf.getViewport());
        check(direction + ': 上ホイールで左へ戻る', left.x > right.x + 10 && Math.abs(left.y - before.y) < .01 && Math.abs(left.zoom - before.zoom) < .00001);
        await p.keyboard.up('Control');
        await p.mouse.wheel(0, 240);
        await p.waitForTimeout(400);
        const down = await p.evaluate(() => window.boxglow.rf.getViewport());
        check(direction + ': Shift+下ホイールで下へ進み、倍率と横位置は維持', down.y < left.y - 10 && Math.abs(down.x - left.x) < .01 && Math.abs(down.zoom - left.zoom) < .00001);
        await p.mouse.wheel(0, -240);
        await p.waitForTimeout(400);
        const up = await p.evaluate(() => window.boxglow.rf.getViewport());
        check(direction + ': Shift+上ホイールで上へ戻る', up.y > down.y + 10 && Math.abs(up.x - left.x) < .01 && Math.abs(up.zoom - left.zoom) < .00001);
        await p.keyboard.down('Control');
        await p.getByRole('button', { name: 'Fit', exact: true }).click();
        await p.waitForTimeout(300);
        const fit = await p.evaluate(() => window.boxglow.rf.getViewport());
        await p.mouse.move(box.x + box.width * .8, box.y + box.height * .5);
        await p.mouse.wheel(0, 240);
        await p.waitForTimeout(400);
        const limit = await p.evaluate(() => window.boxglow.rf.getViewport());
        check(direction + ': 全体表示の限界では位置・倍率を維持', Math.abs(fit.x - limit.x) < .01 && Math.abs(fit.y - limit.y) < .01 && Math.abs(fit.zoom - limit.zoom) < .00001);
        await p.keyboard.up('Control');
        const shiftLimit = await measure(240);
        check(direction + ': FitでShiftホイールを続けても途中のフレームを含めて揺れない', stable(shiftLimit));
      }
      finally {
        await p.keyboard.up('Shift');
        await p.keyboard.up('Control');
      }
    }
    // macOS の Command (Meta) は Control と同じズーム操作になる。
    await p.getByRole('button', { name: '縦フロー', exact: true }).click();
    await p.getByRole('button', { name: '100% で文字を読む', exact: true }).click();
    await p.waitForTimeout(300);
    const metaBefore = await p.evaluate(() => window.boxglow.rf.getViewport().zoom);
    const metaBox = await p.locator('.react-flow').boundingBox();
    await p.mouse.move(metaBox.x + metaBox.width * .8, metaBox.y + metaBox.height * .5);
    await p.keyboard.down('Meta');
    try {
      await p.mouse.wheel(0, -120);
      await p.waitForTimeout(400);
    }
    finally {
      await p.keyboard.up('Meta');
    }
    check('縦表示でもCmdホイールで拡大できる', await p.evaluate(() => window.boxglow.rf.getViewport().zoom) > metaBefore + .01);
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
