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
      check(`Home ${width}px: 通常の Enter で計画を作り、保存先 (ブラウザ内) が帯に出る`, await page.locator('.save-chip__file').innerText() === 'Browser');
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
      check(`Home ${width}px: 保存済みの計画をキーボードで開ける`, await page.locator('.save-chip__file').innerText() === 'Browser');
      check(`Home ${width}px: ブラウザのエラーが無い`, errors.length === 0, errors.join(' | '));
      await context.close();
    }
  } finally { await browser.close(); }
  const { passed, failed } = result(); console.log(`\n${passed}/${passed + failed} passed`);
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
