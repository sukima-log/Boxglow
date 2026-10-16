/**
 * ブラウザだけの画面 (boxglow.app 相当) の同期の検査: 裏方なしで、サインイン (Cookie のセッション) → 新しくサーバーに置く → 2 台目の変更を受け取る
 * → 編集が送られる → サインアウト → 別のブラウザで Home からサーバーの計画を受け取る
 * 画面は相対パスで組み立てた dist を 127.0.0.1 の静的サーバーで配信し、試験用の同期サーバーも 127.0.0.1 で動かす (同じサイトなので SameSite=Strict の Cookie が送られる)
 * 使い方: e2e/run.sh から呼ばれる
 */
const { chromium, check, result } = require('./lib.cjs');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boxglow-e2e-browser-sync-'));
  let browser = null, server = null, web = null;
  try {
    const dist = path.join(tmp, 'dist');
    execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, VITE_BASE: './' }, stdio: 'ignore' });
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    await esbuild.build({ bundle: true, platform: 'node', format: 'esm', target: 'node18', loader: { '.md': 'text' }, logLevel: 'silent', entryPoints: [path.join(__dirname, 'sync', 'entry-tools.ts')], outfile: path.join(tmp, 'tools.mjs') });
    const tools = await import(path.join(tmp, 'tools.mjs'));
    server = new tools.TestSyncServer(); await server.start();
    // 静的サーバー (dist を配信。index.html は /)
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };
    web = http.createServer((req, res) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.join(dist, p === '/' ? 'index.html' : p);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(file));
    });
    await new Promise((r) => web.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${web.address().port}/`;
    const url = `${base}?server=${encodeURIComponent(server.url)}&lang=ja`;

    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => !!window.boxglow);
    // 新しい計画を作る (ブラウザ内の計画) → 上のバーの同期の印 → 同期を始める → 新しくサーバーに置く → サインイン (GitHub のコード)
    await page.evaluate(() => window.boxglow.store.getState().newProject('ブラウザの計画'));
    await page.waitForFunction(() => !!window.boxglow.store.getState().project);
    const chip = page.locator('.sync-chip');
    await chip.waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'signed-out', null, { timeout: 15000 });
    check('ブラウザ同期: 裏方なしでも同期の印が出て、サインインしていない', (await chip.getAttribute('data-state')) === 'signed-out');
    await chip.click();
    await page.getByRole('button', { name: '同期を始める', exact: true }).click();
    await page.getByRole('button', { name: 'この計画を新しくサーバーに置く', exact: true }).click();
    await page.getByRole('button', { name: 'GitHub でサインイン', exact: true }).click();
    const code = page.locator('.sync-panel__code'); await code.waitFor({ timeout: 15000 });
    check('ブラウザ同期: サインインのコードが出る', /^TEST-/.test((await code.textContent()) ?? ''));
    const deviceCode = [...server.deviceCodes.keys()].at(-1);
    server.deviceCodes.set(deviceCode, { account: 'acc-browser', login: 'browser-user' });
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 30000 });
    const remoteId = await page.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding?.remoteId);
    check('ブラウザ同期: 許可されると Cookie のセッションになり、計画がサーバーに置かれて「同期済み」', !!remoteId && !!server.project(remoteId, 'acc-browser')?.head);
    check('ブラウザ同期: トークンは画面に残らない (Cookie は HttpOnly、localStorage / IndexedDB に無い)', !(await page.evaluate(() => document.cookie)).includes('bgl_session') && !(await page.evaluate(() => JSON.stringify(localStorage))).includes('tok-'));
    check('ブラウザ同期: 欄にサインインした利用者と手段が出る', (await page.locator('.sync-panel').textContent()).includes('browser-user'));
    // 2 台目 (Node) が受け取って変更して送る → ブラウザが受け取る (今すぐ同期)
    const token = [...server.issued.keys()].at(-1);
    const fileB = path.join(tmp, 'b', 'boxglow.json'); fs.mkdirSync(path.dirname(fileB));
    const pulled = await tools.syncOnce({ file: fileB, server: server.url, remoteId, token });
    check('ブラウザ同期: 2 台目がサーバーから受け取れる', pulled.status === 'synced' && pulled.pulled === 1);
    const other = tools.fromJSON(fs.readFileSync(fileB, 'utf8'));
    fs.writeFileSync(fileB, tools.toJSON({ ...other, name: '2 台目が改名' }) + '\n');
    const pushed = await tools.syncOnce({ file: fileB, server: server.url, remoteId, token });
    check('ブラウザ同期: 2 台目が送れる', pushed.status === 'synced' && pushed.pushed === 1);
    await page.getByRole('button', { name: '今すぐ同期', exact: true }).click();
    await page.waitForFunction(() => window.boxglow.store.getState().project?.name === '2 台目が改名', null, { timeout: 20000 });
    check('ブラウザ同期: 受け取った変更が画面に反映される', await page.evaluate(() => window.boxglow.store.getState().project?.name === '2 台目が改名'));
    // ブラウザで編集 → 保存の直後に送られる
    await page.evaluate(() => window.boxglow.store.getState().apply((p) => ({ ...p, name: 'ブラウザで改名' })));
    await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 });
    const head = server.project(remoteId, 'acc-browser')?.head;
    const headName = head ? JSON.parse(head.text).name : null;
    check('ブラウザ同期: 画面の編集がサーバーに届く', headName === 'ブラウザで改名', JSON.stringify(Object.keys(head ?? {})));
    // 別のブラウザ (新しいコンテキスト = 空の保存先) で、Home からサーバーの計画を受け取る
    const context2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page2 = await context2.newPage();
    await page2.goto(url);
    await page2.getByRole('button', { name: 'サーバーの計画を受け取る', exact: true }).waitFor({ timeout: 15000 });
    await page2.getByRole('button', { name: 'サーバーの計画を受け取る', exact: true }).click();
    await page2.getByRole('button', { name: 'GitHub でサインイン', exact: true }).click();
    await page2.locator('.sync-panel__code, .home-receive .sync-panel__code').first().waitFor({ timeout: 15000 });
    server.deviceCodes.set([...server.deviceCodes.keys()].at(-1), { account: 'acc-browser', login: 'browser-user' });
    await page2.locator('.sync-project-row').first().waitFor({ timeout: 30000 });
    await page2.locator('.sync-project-row').first().click();
    await page2.waitForFunction(() => !!window.boxglow.store.getState().project && window.boxglow.store.getState().source === 'idb', null, { timeout: 20000 });
    check('ブラウザ同期: 別のブラウザの Home からサインインして受け取ると、その計画が開く', await page2.evaluate(() => window.boxglow.store.getState().project?.name === 'ブラウザで改名'));
    await page2.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 });
    check('ブラウザ同期: 受け取った計画は同期が有効で「同期済み」', (await page2.locator('.sync-chip').getAttribute('data-state')) === 'synced');
    await context2.close();
    // サインアウト: 印が「未サインイン」、サーバーでトークンが失効
    await page.locator('.sync-panel__details > summary').click();
    await page.getByRole('button', { name: 'サインアウト', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'signed-out', null, { timeout: 15000 });
    check('ブラウザ同期: サインアウトで「未サインイン」に戻り、トークンが失効する', server.revoked.has(token));
    check('ブラウザ同期: 実行エラーなし', errors.length === 0, errors.join('\n'));
  } catch (e) {
    check('ブラウザ同期: 例外なし', false, String(e && e.stack || e));
  } finally {
    if (browser) await browser.close();
    if (server) await server.stop();
    if (web) web.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  result();
})();
