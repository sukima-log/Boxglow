/**
 * 画面からの同期の検査 (boxglow serve --sync): 画面でサインイン → サーバーに置く → 2 台目の変更を受け取る → 競合を画面で選ぶ → サインアウト
 * 試験用の同期サーバー (cli/sync/test-server.ts) と 2 台目の端末は、この検査のプロセスで動かす。1 台目 (serve --sync) は子プロセスで、設定フォルダを分ける。
 * 画面は、相対パスで組み立てた dist (一時フォルダ) を serve が配信する (プレビュー用の /apps/boxglow/ の組み立てとは別)
 * 使い方: e2e/run.sh から呼ばれる
 */
const { chromium, check, result } = require('./lib.cjs');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boxglow-e2e-sync-'));
  let child = null, browser = null, server = null;
  try {
    // ---- 組み立て: 画面 (相対パス)、serve の入口、検査の道具 ----
    const dist = path.join(tmp, 'dist');
    execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], { cwd: ROOT, env: { ...process.env, VITE_BASE: './' }, stdio: 'ignore' });
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    const common = { bundle: true, platform: 'node', format: 'esm', target: 'node18', loader: { '.md': 'text' }, logLevel: 'silent' };  // (一時フォルダに置くので、外部の依存も中に束ねる)
    await esbuild.build({ ...common, entryPoints: [path.join(__dirname, 'sync', 'entry-serve.ts')], outfile: path.join(tmp, 'serve.mjs') });
    await esbuild.build({ ...common, entryPoints: [path.join(__dirname, 'sync', 'entry-tools.ts')], outfile: path.join(tmp, 'tools.mjs') });
    const tools = await import(path.join(tmp, 'tools.mjs'));

    // ---- 同期サーバーと、計画のファイル (1 台目) ----
    server = new tools.TestSyncServer(); await server.start();
    let p = tools.createProject('同期の画面の検査');
    const block = tools.addBlock(p, { parentId: tools.defaultTaskParent(p), title: 'A' }); p = block.project;
    const fileA = path.join(tmp, 'a', 'boxglow.json'); fs.mkdirSync(path.dirname(fileA));
    fs.writeFileSync(fileA, tools.toJSON(p) + '\n');
    const configA = path.join(tmp, 'config-a'), configB = path.join(tmp, 'config-b');
    // (ポートは serve に選ばせ、出力から読む。決め打ちの番号は、残っている別のプロセスとぶつかることがある)
    child = spawn(process.execPath, [path.join(tmp, 'serve.mjs'), fileA, dist, '0', server.url], { env: { ...process.env, BOXGLOW_CONFIG_DIR: configA, BOXGLOW_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    // (serve の出力は、失敗したときの手がかりに残す)
    let serveLog = '';
    child.stdout.on('data', (d) => { serveLog += d; }); child.stderr.on('data', (d) => { serveLog += d; });
    process.on('exit', () => { if (result().failed) console.log('--- serve の出力 ---\n' + serveLog.slice(-3000)); });
    let port = 0;
    for (let i = 0; i < 80 && !port; i++) { port = Number(/localhost:(\d+)\//.exec(serveLog)?.[1] ?? 0); if (!port) await new Promise((r) => setTimeout(r, 250)); }
    if (!port) throw new Error('serve が起動しない');
    const base = `http://localhost:${port}/`;
    const status = async () => (await fetch(base + 'api/sync')).json();

    // ---- 画面 ----
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base + '?serve=1&lang=ja');
    const chip = page.locator('.sync-chip');
    await chip.waitFor();
    const chipText = async (text) => { try { await page.waitForFunction((t) => document.querySelector('.sync-chip')?.textContent?.includes(t), text, { timeout: 15000 }); return true; } catch { return false; } };
    check('同期: サインインしていない間は、印が「未サインイン」', await chipText('未サインイン'));

    // サインイン: 欄の GitHub のボタン → コードが出る → (サーバー側で許可) → 印が「未接続」
    await chip.click();
    await page.getByRole('button', { name: 'GitHub でサインイン', exact: true }).click();
    const code = page.locator('.sync-panel__code');
    await code.waitFor({ timeout: 10000 });
    check('同期: サインインのコードが欄に出る', /^TEST-/.test((await code.textContent()) ?? ''));
    const deviceCode = [...server.deviceCodes.keys()].at(-1);
    server.deviceCodes.set(deviceCode, { account: 'acc-e2e', login: 'e2e-user' });
    check('同期: 許可されると、印が「未接続」(サインイン済み・まだサーバーに置いていない)', await chipText('未接続'));
    check('同期: 欄にサインインした利用者が出る', await page.locator('.sync-panel__who').textContent({ timeout: 10000 }).then((t) => (t ?? '').length > 0).catch(() => false));
    check('同期: 画面の状態にトークンが出ない', !JSON.stringify(await status()).includes('tok-'));

    // サーバーに置く → 同期済み
    await page.getByRole('button', { name: 'サーバーに置く', exact: true }).click();
    check('同期: 「サーバーに置く」で、印が「同期済み」', await chipText('同期済み'));
    const remoteId = (await status()).file.binding.remoteId;
    check('同期: サーバーに計画ができる', !!server.project(remoteId, 'acc-e2e')?.head);

    // 2 台目が受け取り、題名を変えて送る → 1 台目の「今すぐ同期」で受け取る
    const token = [...server.issued.keys()].at(-1);
    const fileB = path.join(tmp, 'b', 'boxglow.json'); fs.mkdirSync(path.dirname(fileB));
    process.env.BOXGLOW_CONFIG_DIR = configB;
    await tools.syncOnce({ file: fileB, server: server.url, remoteId, token });
    fs.writeFileSync(fileB, tools.toJSON(tools.updateBlock(tools.fromJSON(fs.readFileSync(fileB, 'utf8')), block.blockId, { title: '2 台目の題名' })) + '\n');
    const pushed = await tools.syncOnce({ file: fileB, server: server.url, token });
    check('同期: 2 台目が送れる', pushed.status === 'synced' && pushed.pushed === 1);
    await page.getByRole('button', { name: '今すぐ同期', exact: true }).click();
    const titleOf = () => page.evaluate((id) => window.boxglow.store.getState().project.blocks[id].title, block.blockId);
    let received = false;
    for (let i = 0; i < 40 && !received; i++) { received = (await titleOf()) === '2 台目の題名'; if (!received) await page.waitForTimeout(250); }
    check('同期: 1 台目の画面に、2 台目の変更が届く', received);
    check('同期: 受け取った後も「同期済み」', await chipText('同期済み'));

    // 競合: 2 台目と 1 台目が同じ題名を別の値に → 1 台目が止まり、欄で選んで進む
    fs.writeFileSync(fileB, tools.toJSON(tools.updateBlock(tools.fromJSON(fs.readFileSync(fileB, 'utf8')), block.blockId, { title: '2 台目の案' })) + '\n');
    await tools.syncOnce({ file: fileB, server: server.url, token });
    await page.evaluate((id) => { const s = window.boxglow.store.getState(); s.apply((p) => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], title: '1 台目の案' } } })); s.saveNow(); }, block.blockId);
    await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 10000 });
    await page.getByRole('button', { name: '今すぐ同期', exact: true }).click();
    check('同期: 同じ項目を両方で変えると、印が「確認」', await chipText('確認'));
    const choose = page.getByRole('button', { name: '手元の値に決める', exact: true });
    check('同期: 欄に、手元 / サーバーの値に決めるボタンが出る', await choose.isVisible({ timeout: 5000 }).catch(() => false) && await page.getByRole('button', { name: 'サーバーの値に決める', exact: true }).isVisible());
    await choose.click();
    check('同期: 選ぶと「同期済み」に戻る', await chipText('同期済み'));
    const head = JSON.parse(server.project(remoteId, 'acc-e2e').head.text);
    check('同期: サーバーの題名は、選んだ手元の値', head.blocks[block.blockId].title === '1 台目の案');

    // サインアウト → 未サインイン、資格情報が消える
    await page.getByRole('button', { name: 'サインアウト', exact: true }).click();
    check('同期: サインアウトで、印が「未サインイン」', await chipText('未サインイン'));
    check('同期: サインアウトで、トークンがサーバー側で取り消される', server.revoked.has(token));
    const shot = path.join(process.env.BOXGLOW_E2E_SHOTS || path.join(os.tmpdir(), 'boxglow-e2e-shots'), 'sync-panel.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
    check('同期: 実行エラーなし', errors.length === 0, errors.join(' | '));
  } catch (e) {
    check('同期: 検査が最後まで動く', false, String(e && e.stack || e));
  } finally {
    await browser?.close();
    child?.kill();
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { passed, failed } = result();
  console.log(`${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
