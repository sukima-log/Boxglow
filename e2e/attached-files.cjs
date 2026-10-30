/**
 * 成果物・資料・Notes のリンクに書かれた手元のファイルを開く (利用者の要望 2026-10-31)
 *   - VS Code の中 (webview を真似る): 名前を押すと拡張へ { type: "open-file", path } を送る。見つからない返事で通知を出す。
 *     Notes のリンクは Ctrl + クリックで同じく送る
 *   - ブラウザで直接開いた計画: パスをコピーして通知する
 * 使い方: node e2e/attached-files.cjs (run.sh から。preview は 4173 番)
 */
const { chromium, open, check, result } = require('./lib.cjs');

/** 計画: 最上位の入力「シナリオ」に Doc/scenario.md、箱「抽出」の Notes に docs/spec.md へのリンク */
function plan() {
  const id = (s) => s;
  return {
    schema: 'boxglow', schemaVersion: 1, id: 'p', name: '開く検査', lang: 'ja', createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z',
    terminals: { in: { x: 0, y: 100 }, out: { x: 900, y: 100 } },
    blocks: {
      root: { id: 'root', parentId: null, title: 'root', description: '', status: 'black', position: { x: 0, y: 0 }, collapsed: false, assigneeIds: [], decisions: [] },
      pj: { id: 'pj', parentId: 'root', kind: 'project', title: '開く検査', description: '', status: 'black', position: { x: 260, y: 40 }, collapsed: false, assigneeIds: [], decisions: [] },
      b1: { id: 'b1', parentId: 'pj', title: '抽出', description: '詳しくは [仕様](docs/spec.md) と [サイト](https://example.com)', status: 'black', position: { x: 80, y: 120 }, collapsed: false, assigneeIds: [], decisions: [] },
    },
    ports: {
      rin: { id: 'rin', blockId: 'root', direction: 'in', name: 'シナリオ', description: '', required: true, artifacts: [{ id: 'a1', title: 'scenario.md', url: '', kind: 'file', note: '', path: 'Doc/scenario.md' }] },
      pin: { id: 'pin', blockId: 'pj', direction: 'in', name: 'シナリオ', description: '', required: true, artifacts: [] },
      bin: { id: 'bin', blockId: 'b1', direction: 'in', name: 'シナリオ', description: '', required: true, artifacts: [] },
      bout: { id: 'bout', blockId: 'b1', direction: 'out', name: '登場人物', description: '', required: true, artifacts: [] },
    },
    edges: {
      e1: { id: 'e1', from: { portId: 'rin', side: 'inner' }, to: { portId: 'pin', side: 'outer' }, kind: 'sibling', auto: false },
      e2: { id: 'e2', from: { portId: 'pin', side: 'inner' }, to: { portId: 'bin', side: 'outer' }, kind: 'sibling', auto: false },
    },
    members: [], log: [],
  };
}

(async () => {
  const browser = await chromium.launch();
  // ---- VS Code の中 ----
  {
    const { page, errors } = await open(browser, { vscode: true, query: '?lang=ja' });
    await page.evaluate((text) => window.postMessage({ type: 'load', text, version: 1, name: 'boxglow.json' }, '*'), JSON.stringify(plan()));
    await page.waitForTimeout(1500);
    const loaded = await page.evaluate(() => !!window.boxglow.store.getState().project?.blocks?.b1);
    check('VS Code: 計画を読み込める', loaded);
    await page.evaluate(() => window.boxglow.store.getState().select({ terminal: 'in' }));
    await page.waitForTimeout(600);
    const btn = page.locator('.artifact-open', { hasText: 'scenario.md' }).first();
    check('VS Code: 資料の名前が「開く」ボタンになり、エディタで開くと分かる', (await btn.count()) === 1 && (await btn.getAttribute('title')).includes('エディタで開く'));
    await page.evaluate(() => { window.__posted.length = 0; });
    await btn.click();
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => window.__posted.filter((m) => m.type === 'open-file'));
    check('VS Code: 押すと拡張へ open-file (パスつき) を送る', sent.length === 1 && sent[0].path === 'Doc/scenario.md', JSON.stringify(sent));
    await page.evaluate(() => window.postMessage({ type: 'open-file-error', path: 'Doc/scenario.md' }, '*'));
    await page.waitForTimeout(300);
    check('VS Code: 見つからない返事で通知を出す', ((await page.evaluate(() => window.boxglow.store.getState().toast)) || '').includes('Doc/scenario.md'));
    // 箱の入力のカード (供給元の成果物) からも開ける (利用者の指摘 2026-10-31: 入力している側から開けなかった)
    await page.evaluate(() => window.boxglow.store.getState().select({ blockId: 'b1', panelTab: 'io' }));
    await page.waitForTimeout(800);
    const fromInput = page.locator('.artifact-open', { hasText: 'scenario.md' }).first();
    await page.evaluate(() => { window.__posted.length = 0; });
    const inputBtn = (await fromInput.count()) === 1;
    if (inputBtn) await fromInput.click();
    await page.waitForTimeout(200);
    const sentFromInput = await page.evaluate(() => window.__posted.filter((m) => m.type === 'open-file'));
    check('VS Code: 箱の入力のカード (供給元の資料) からも open-file を送る', inputBtn && sentFromInput.length === 1 && sentFromInput[0].path === 'Doc/scenario.md', JSON.stringify(sentFromInput));
    // Notes のリンク: Ctrl + クリックで開く (ふつうのクリックでは送らない)
    await page.evaluate(() => window.boxglow.store.getState().select({ blockId: 'b1', panelTab: 'log' }));
    await page.waitForTimeout(800);
    const link = page.locator('.live-md .cm-md-link', { hasText: '仕様' }).first();
    const hasLink = (await link.count()) === 1;
    check('VS Code: Notes にリンクが出る', hasLink, String(await page.locator('.live-md').count()));
    if (hasLink) {
      await page.evaluate(() => { window.__posted.length = 0; });
      await link.click();
      await page.waitForTimeout(200);
      const plain = await page.evaluate(() => window.__posted.filter((m) => m.type === 'open-file').length);
      await link.click({ modifiers: ['Control'] });
      await page.waitForTimeout(200);
      const ctrl = await page.evaluate(() => window.__posted.filter((m) => m.type === 'open-file'));
      check('VS Code: Notes のリンクは Ctrl + クリックで open-file を送る (ふつうのクリックでは送らない)', plain === 0 && ctrl.length === 1 && ctrl[0].path === 'docs/spec.md', JSON.stringify(ctrl));
    }
    // 画像の置き場 (asset-base) も届く (以前は load / update 以外を無視する行の後ろにあり、VS Code の中で届いていなかった)
    await page.evaluate(() => window.postMessage({ type: 'asset-base', base: 'https://file+.vscode-resource.example/plan/boxglow.assets/' }, '*'));
    await page.waitForTimeout(200);
    check('VS Code: 画像の置き場 (asset-base) の知らせを受け取る', (await page.evaluate(() => window.boxglow.store.getState().assetBase)) === 'https://file+.vscode-resource.example/plan/boxglow.assets/');
    check('VS Code: コンソールにエラーが無い', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.context().close();
  }
  // ---- ブラウザで直接開いた計画: パスをコピーする ----
  {
    const { page } = await open(browser, { query: '?lang=ja' });
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async (text) => { await window.boxglow.store.getState().importJSON(text); }, JSON.stringify(plan()));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.boxglow.store.getState().select({ terminal: 'in' }));
    await page.waitForTimeout(600);
    const btn = page.locator('.artifact-open', { hasText: 'scenario.md' }).first();
    check('ブラウザ: 資料の名前はパスのコピーになると分かる', (await btn.getAttribute('title') || '').includes('パスをコピー'));
    await btn.click();
    await page.waitForTimeout(400);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('ブラウザ: 押すとパスをコピーして知らせる', clip === 'Doc/scenario.md' && ((await page.evaluate(() => window.boxglow.store.getState().toast)) || '').includes('コピー'), clip);
    await page.context().close();
  }
  await browser.close();
  const r = result();
  console.log(`${r.passed}/${r.passed + r.failed} passed`);
  process.exit(r.failed ? 1 : 0);
})();
