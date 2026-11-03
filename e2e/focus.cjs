/**
 * 箱を探して寄る操作の検査: Ctrl+F で検索欄へ移ること、検索で選んだ箱へ寄ること (題名が読めない倍率のときだけ倍率を変える)、
 * 右パネルの注目ボタンで箱全体が見える領域にきれいに収まる位置へ寄ること (倍率は箱の大きさで決まり、100% に決め打ちしない)、
 * 寄った箱のまわりに輪が出ること。
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const { chromium, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    const { page: p, errors } = await open(browser, { query: '?demo=1&lang=ja' });
    // 画面を小さめにして、サンプルの全体表示が題名の読めない倍率 (0.45 未満) になるようにする (大きい画面ではサンプル全体でも読める倍率に収まる)
    await p.setViewportSize({ width: 900, height: 700 });
    await p.waitForSelector('.react-flow__node-block');
    await p.waitForTimeout(600);
    const search = p.getByRole('textbox', { name: 'ブロックを検索' });
    // 検索欄へ移るのは押した直後の次の処理 (setTimeout) なので、少し待ってから確かめる
    const isSearchFocused = async () => { await p.waitForTimeout(100); return p.evaluate(() => document.activeElement?.classList.contains('search-box')); };
    // 画面が落ち着くまで待つ (寄る動き 0.45 秒と、選んだ箱の右パネルが開くのを待つ)
    const settle = () => p.waitForTimeout(1000);
    /** 箱が見える領域 (右パネルを除く) に収まっているか、収まり具合 (箱の幅と高さの、領域に対する割合の大きいほう) と倍率 */
    const fitOf = (id) => p.evaluate((id) => {
      const c = document.querySelector('.react-flow').getBoundingClientRect();
      const panel = document.querySelector('.panel.right:not(.hidden-panel)');
      const pr = panel && panel.getClientRects().length ? panel.getBoundingClientRect() : null;
      const right = pr && pr.left < c.right ? pr.left : c.right;
      const n = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`).getBoundingClientRect();
      const inside = n.left >= c.left - 1 && n.right <= right + 1 && n.top >= c.top - 1 && n.bottom <= c.bottom + 1;
      return { inside, fill: Math.max(n.width / (right - c.left), n.height / c.height), zoom: window.boxglow.rf.getViewport().zoom };
    }, id);
    // サンプルの中の、中に箱を持たない箱 (葉) と、中に箱を持つ組
    const { leaf, group } = await p.evaluate(() => {
      const pj = window.boxglow.store.getState().project; const bs = Object.values(pj.blocks);
      const kids = (id) => bs.filter((b) => b.parentId === id).length;
      const shown = new Set(window.boxglow.rf.getNodes().filter((n) => !n.hidden).map((n) => n.id));
      const leaf = bs.find((b) => b.kind !== 'project' && kids(b.id) === 0 && shown.has(b.id));
      // 組: 中を開いて描いている箱 (サンプルの Top ではプロジェクトの箱)
      const group = bs.find((b) => kids(b.id) >= 2 && !b.collapsed && shown.has(b.id));
      return { leaf: { id: leaf.id, key: leaf.key }, group: group ? { id: group.id, key: group.key } : null };
    });
    /** 倍率だけ変える (中央を保つ) */
    const zoomTo = (zoom) => p.evaluate((zoom) => { const rf = window.boxglow.rf; const v = rf.getViewport(); const el = document.querySelector('.react-flow').getBoundingClientRect(); const cx = el.width / 2, cy = el.height / 2; const k = zoom / v.zoom; rf.setViewport({ x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, zoom }); }, zoom);

    // 1. Ctrl+F: 図の上から検索欄へ
    await p.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await p.keyboard.press('Control+f');
    check('Ctrl+F: 図の上から検索欄へ移る', await isSearchFocused());
    await p.keyboard.press('Escape');

    // 2. 題名が読めない倍率 (全体表示) で検索して選ぶ: 箱全体が収まる位置まで寄る。寄った箱のまわりに輪が出る
    await p.evaluate(() => { const s = window.boxglow.store.getState(); s.select({}); });
    await p.getByRole('button', { name: 'Fit', exact: true }).click(); await p.waitForTimeout(400);
    const fitZoom = await p.evaluate(() => window.boxglow.rf.getViewport().zoom);
    check('前提: 全体表示が題名の読めない倍率になっている', fitZoom < 0.45, String(fitZoom));
    await p.keyboard.press('Control+f'); await p.waitForTimeout(100);
    await search.fill(leaf.key); await p.waitForTimeout(200);
    await search.press('Enter');
    await p.waitForTimeout(500);
    check('検索: 寄った箱のまわりに輪が出る', await p.locator(`.react-flow__node[data-id="${leaf.id}"] .bg-block__ping`).count() === 1);
    await settle();
    let f = await fitOf(leaf.id);
    check('検索: 読めない倍率から選ぶと、箱全体が見える領域に収まるまで寄る', f.inside && f.zoom > 0.45, JSON.stringify(f));
    check('検索: 寄った箱が見える領域のおおよそ 3/4 まで大きく映る (余白をとって収める。小さい箱は拡大の上限まで)', (f.fill > 0.6 && f.fill < 0.9) || Math.abs(f.zoom - 2) < .001, JSON.stringify(f));

    // 3. 読める倍率 (1) で検索: 倍率は変えない (見えていれば動かさない)
    await p.evaluate(() => window.boxglow.store.getState().select({}));
    await zoomTo(1); await p.waitForTimeout(300);
    await p.keyboard.press('Control+f'); await p.waitForTimeout(100);
    await search.fill(leaf.key); await p.waitForTimeout(200);
    await search.press('Enter'); await settle();
    f = await fitOf(leaf.id);
    check('検索: 読める倍率のときは倍率を変えない', Math.abs(f.zoom - 1) < .001, JSON.stringify(f));

    // 4. 右パネルの入力欄で文字を打っている途中の Ctrl+F: 検索欄へ移る。検索欄でもう一度押すと入っている文字を全部選ぶ
    await p.locator('.panel.right input.input').first().click();
    await p.keyboard.press('Control+f');
    check('Ctrl+F: 右パネルの入力中でも検索欄へ移る', await isSearchFocused());
    await p.keyboard.type('abc');
    await p.keyboard.press('Control+f'); await p.waitForTimeout(100);
    check('Ctrl+F: 検索欄でもう一度押すと、入っている文字を全部選ぶ', await p.evaluate(() => { const s = document.activeElement; return s.value === 'abc' && s.selectionStart === 0 && s.selectionEnd === 3; }));
    await p.keyboard.press('Escape');

    // 5. 注目ボタン: 組 (中に箱を持つ大きい箱) を選んで押すと、箱全体がきれいに収まる位置と倍率へ寄る (100% に決め打ちしない)
    if (group) {
      await p.evaluate((id) => window.boxglow.store.getState().select({ blockId: id }), group.id);
      await p.getByRole('button', { name: 'Fit', exact: true }).click(); await p.waitForTimeout(300);
      await zoomTo(0.15); await p.waitForTimeout(300);
      await p.locator('.inspector-focus').click(); await settle();
      f = await fitOf(group.id);
      check('注目ボタン: 組の全体が見える領域に収まる', f.inside, JSON.stringify(f));
      check('注目ボタン: 余白をとって大きく映す (領域のおおよそ 3/4)', (f.fill > 0.6 && f.fill < 0.9) || Math.abs(f.zoom - 2) < .001, JSON.stringify(f));
      check('注目ボタン: 倍率は箱の大きさで決まる (100% に決め打ちしない)', Math.abs(f.zoom - 1) > .01, JSON.stringify(f));
    } else check('サンプルに中に箱を持つ組がある', false);
    // 葉で注目ボタン: 小さい箱は拡大する (100% を超えてよい)
    await p.evaluate((id) => window.boxglow.store.getState().select({ blockId: id }), leaf.id);
    await zoomTo(0.15); await p.waitForTimeout(300);
    await p.locator('.inspector-focus').click(); await settle();
    f = await fitOf(leaf.id);
    check('注目ボタン: 小さい箱は 100% を超えて拡大してでも大きく映す', f.inside && f.zoom > 1, JSON.stringify(f));

    check('コンソールにエラーが無い', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
    const r = result();
    console.log(r);
    if (r.failed) process.exitCode = 1;
  }
})();
