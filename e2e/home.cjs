/**
 * Home 画面の検査: 390px と 1280px で、最初の案内 (サンプルを試す) と「自分の計画で始める」の引き出しの中の操作が使えること、
 * 引き出しは初回 (保存済みの計画が無い) だけ閉じていて、保存済みの計画があれば最初から開いていること、
 * 流れ図などの余計な文言が無いこと、日本語変換中の Enter で計画が作られないこと (変換の確定を送信と取り違えない)。
 * 使い方: e2e/run.sh から呼ばれる (Playwright の用意は checks.cjs と同じ)
 */
const { chromium, BASE, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    for (const width of [390, 1280]) {
      // 幅ごとに新しいコンテキスト (= 保存済みの計画が無い初回の状態) で開く
      const context = await browser.newContext({ locale: 'en-US', viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e)));
      await page.goto(BASE + '?lang=en');
      await page.getByRole('button', { name: 'Try the sample', exact: true }).waitFor();
      check(`Home ${width}px: 初回は自分の計画の操作 (引き出し) が閉じている`, !await page.getByText('npx boxglow serve --open', {exact:true}).isVisible());
      check(`Home ${width}px: 流れ図と「登録不要」の文言が無い`, await page.locator('.home-flow').count() === 0 && await page.getByText('No sign-up', { exact: false }).count() === 0);
      await page.locator('.home-disclosure > summary').click();
      await page.getByRole('heading', { name: 'Open a file', exact: true }).waitFor();
      check(`Home ${width}px: リポジトリのファイルとブラウザ内の計画の違いが書かれている`, await page.getByText('They do not automatically sync', { exact: false }).isVisible());
      check(`Home ${width}px: serve のコマンドとコピーのボタンが英語で出る`, await page.getByText('npx boxglow serve --open', {exact:true}).isVisible() && await page.getByRole('button', { name: 'Copy', exact: true }).isVisible());
      check(`Home ${width}px: ダイアログが横にはみ出さない`, await page.locator('.home-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
      check(`Home ${width}px: 名前が空のときは Create を押せない`, !await page.getByRole('button', { name: 'Create', exact: true }).isEnabled());
      const name = page.getByRole('textbox', { name: 'New project name', exact: true });
      await name.fill('日本語の計画');
      // 日本語変換の確定の Enter (isComposing / keyCode 229) では作らない
      await name.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
      check(`Home ${width}px: 日本語変換の確定の Enter では計画を作らない`, await page.getByRole('heading', { name: 'Create a new plan' }).isVisible());
      await name.press('Enter');
      await page.locator('.app-top header').waitFor();
      check(`Home ${width}px: 通常の Enter で計画を作り、保存先 (ブラウザ内) が帯に出る`, (await page.locator('.save-chip').innerText()).includes('Browser:'));
      await page.getByRole('button', { name: 'Home', exact: true }).click();
      const saved = page.locator('.home-project-open');
      await saved.waitFor();
      // 2 回目以降 (保存済みの計画がある): 引き出しは最初から開いていて、操作がそのまま見える
      check(`Home ${width}px: 保存済みの計画があれば、自分の計画の操作が最初から見える`, await page.getByRole('button', { name: 'Copy and edit', exact: true }).isVisible() && await page.getByRole('button', { name: 'Create', exact: true }).isVisible() && await page.getByText('npx boxglow serve --open', {exact:true}).isVisible());
      // 既にあるファイルを開く入口は「ファイルを開く」の 1 か所 (AI 向けの見出しの下に隠れていない)。見出しに AI の言葉を使わない
      check(`Home ${width}px: ファイルを開く入口が、AI に関係ない見出しの下にある`, await page.getByRole('heading', { name: 'Open a file', exact: true }).isVisible()
        && !/AI AGENT|repository plan/i.test(await page.locator('.home-section--shared').locator('h2, .label').allInnerTexts().then(t => t.join(' '))));
      check(`Home ${width}px: 開いた状態でもダイアログが横にはみ出さない`, await page.locator('.home-dialog').evaluate(el => el.scrollWidth <= el.clientWidth));
      await saved.focus();
      await page.keyboard.press('Enter');
      await page.locator('.app-top header').waitFor();
      check(`Home ${width}px: 保存済みの計画をキーボードで開ける`, (await page.locator('.save-chip').innerText()).includes('Browser:'));
      check(`Home ${width}px: ブラウザのエラーが無い`, errors.length === 0, errors.join(' | '));
      await context.close();
    }

    // ---- 計画のテンプレート (B153): 登録 → Home の「新しい計画を作る」で選べる → 構造だけ (進捗なし) の新しい計画 → 消せる ----
    {
      const context = await browser.newContext({ locale: 'ja-JP', viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.goto(BASE + '?lang=ja');
      await page.waitForFunction(() => !!window.boxglow);
      // 計画を作って、箱を 1 つ進めてから登録
      await page.evaluate(() => window.boxglow.store.getState().newProject('元の計画'));
      await page.waitForFunction(() => window.boxglow.store.getState().project?.name === '元の計画');
      await page.evaluate(() => { const s = window.boxglow.store.getState(); s.apply((p) => { const id = Object.keys(p.blocks).find((k) => p.blocks[k].kind !== 'project'); return { ...p, description: '説明', blocks: { ...p.blocks, [id]: { ...p.blocks[id], title: '進めた箱', status: 'gray' } } }; }); });
      await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
      await page.evaluate(() => window.boxglow.store.getState().registerTemplate('元の計画'));
      await page.waitForFunction(() => window.boxglow.store.getState().planTemplates.length === 1);
      check('テンプレート: 登録すると一覧に入る (名前 = 計画名)', (await page.evaluate(() => window.boxglow.store.getState().planTemplates[0].name)) === '元の計画');
      // Home へ戻って選んで作る
      await page.evaluate(() => window.boxglow.store.getState().closeProject());
      await page.evaluate(() => { const d = document.querySelector('.home-disclosure'); if (d && !d.open) d.open = true; });   // 保存済みの計画があると最初から開いている
      await page.locator('.home-templates select').waitFor({ timeout: 10000 });
      await page.locator('.home-templates select').selectOption('元の計画');
      await page.locator('#home-project-name').fill('テンプレートから');
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await page.waitForFunction(() => window.boxglow.store.getState().project?.name === 'テンプレートから');
      const made = await page.evaluate(() => { const p = window.boxglow.store.getState().project; const bs = Object.values(p.blocks).filter((b) => b.kind !== 'project'); return { titles: bs.map((b) => b.title), statuses: bs.map((b) => b.status), description: p.description, logs: p.log.length }; });
      check('テンプレート: 作った計画は構造 (題名・説明) を引き継ぎ、進捗は白紙', made.titles.includes('進めた箱') && made.statuses.every((x) => x === 'black') && made.description === '説明' && made.logs === 0, JSON.stringify(made));
      // 消す
      await page.evaluate(() => window.boxglow.store.getState().closeProject());
      await page.evaluate(() => { const d = document.querySelector('.home-disclosure'); if (d && !d.open) d.open = true; });
      await page.locator('.home-templates select').selectOption('元の計画');
      await page.getByRole('button', { name: 'テンプレート「元の計画」を消す', exact: true }).click();
      await page.waitForFunction(() => window.boxglow.store.getState().planTemplates.length === 0);
      check('テンプレート: Home から消せる (消すと選択肢が出ない)', (await page.locator('.home-templates').count()) === 0);
      await context.close();
    }

    // ---- PWA (B152): マニフェストと sw.js が配信され、試験環境 (127.0.0.1) では Service Worker を登録しない ----
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await context.newPage();
      await page.goto(BASE + '?lang=ja');
      await page.waitForFunction(() => !!window.boxglow);
      const pwa = await page.evaluate(async (base) => {
        const link = document.querySelector('link[rel="manifest"]');
        const manifest = link ? await (await fetch(link.href)).json().catch(() => null) : null;
        const sw = await fetch(base + 'sw.js').then((r) => r.ok ? r.text() : '').catch(() => '');
        return { manifest: manifest?.display, icons: manifest?.icons?.length ?? 0, sw: sw.includes('boxglow-') && !sw.includes('__BUILD__'), registered: !!navigator.serviceWorker?.controller };
      }, BASE);
      check('PWA: マニフェスト (standalone・アイコン 2 つ) と sw.js (版入り) が配信される', pwa.manifest === 'standalone' && pwa.icons === 2 && pwa.sw, JSON.stringify(pwa));
      check('PWA: 試験環境では Service Worker を登録しない', pwa.registered === false);
      await context.close();
    }
  } finally { await browser.close(); }
  const { passed, failed } = result(); console.log(`\n${passed}/${passed + failed} passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
