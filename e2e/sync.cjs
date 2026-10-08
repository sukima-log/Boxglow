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
  let child = null, childD = null, browser = null, server = null;
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
    const other = tools.addBlock(p, { parentId: tools.defaultTaskParent(p), title: 'B' }); p = other.project;
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
    const chipText = async (text) => { try { await page.waitForFunction((t) => document.querySelector('.sync-chip')?.getAttribute('data-state') === t, ({ '未サインイン': 'signed-out', '未接続': 'unbound', '同期済み': 'synced', '確認': 'halted', '接続なし': 'disconnected' })[text], { timeout: 15000 }); return true; } catch { return false; } };
    check('同期: サインインしていない間は、印が「未サインイン」', await chipText('未サインイン'));

    // サインイン: 欄の GitHub のボタン → コードが出る → (サーバー側で許可) → 印が「未接続」
    await chip.click();
    check('同期D: 起動だけでは有効化しない', !(await status()).file.enabled);
    await page.getByRole('button', {name:'同期を始める',exact:true}).click();
    check('同期D: 開始前に送り先を表示', (await page.locator('.sync-startup').textContent()).includes(server.url));
    check('同期D3: 詳細欄を1つに集約', await page.locator('.sync-panel summary').filter({hasText:/^(接続の詳細|詳細と設定)$/}).count() === 1);
    if(process.env.BOXGLOW_E2E_SHOTS){fs.mkdirSync(process.env.BOXGLOW_E2E_SHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.BOXGLOW_E2E_SHOTS,'serve-start.png')});}
    await page.getByRole('button', {name:'この計画を新しくサーバーに置く',exact:true}).click();
    await page.getByRole('button', { name: 'GitHub でサインイン', exact: true }).click();
    const code = page.locator('.sync-panel__code');
    await code.waitFor({ timeout: 10000 });
    check('同期: サインインのコードが欄に出る', /^TEST-/.test((await code.textContent()) ?? ''));
    // 認可ページの実接続はしない。クリック時のコピー失敗と公開URLだけを検査する。
    await page.evaluate(()=>{window.open=(...args)=>{window.__authOpen=args;return null;};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('clipboard denied');}}});});
    await page.getByRole('button',{name:'コードをコピーして許可のページを開く',exact:true}).click();
    await page.getByText('コピーできませんでした。下のコードを入力してください。',{exact:true}).waitFor();
    check('同期D: コピー不可でもコードが残り、認可ページを開く操作を保つ',await code.isVisible()&&await page.evaluate(()=>window.__authOpen[0]==='https://github.com/login/device'));
    const deviceCode = [...server.deviceCodes.keys()].at(-1);
    server.deviceCodes.set(deviceCode, { account: 'acc-e2e', login: 'e2e-user' });
    check('同期D: 許可後は選んだ新規配置まで続き、同期済みになる', await chipText('同期済み'));
    check('同期: 欄にサインインした利用者が出る', await page.locator('.sync-panel__who').textContent({ timeout: 10000 }).then((t) => (t ?? '').length > 0).catch(() => false));
    check('同期: 画面の状態にトークンが出ない', !JSON.stringify(await status()).includes('tok-'));

    // サーバーに置く → 同期済み

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

    await fetch(base + 'api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'pause' }) });
    const page2 = await (await browser.newContext()).newPage();
    await page2.goto(base + '?serve=1&lang=ja');
    await page2.waitForFunction(() => window.boxglow?.store.getState().project);
    let releasePut, seenPut;
    const held = new Promise(resolve => { releasePut = resolve; });
    const arrived = new Promise(resolve => { seenPut = resolve; });
    let once = false;
    await page.route('**/api/project', async route => {
      if (route.request().method() === 'PUT' && !once) { once = true; seenPut(); await held; }
      await route.continue();
    });
    await page.evaluate(id => { const s = window.boxglow.store.getState(); s.apply(p => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], description: 'Browser A' } } })); s.saveNow(); }, block.blockId);
    await arrived;
    await page2.evaluate(id => { const s = window.boxglow.store.getState(); s.apply(p => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], description: 'Browser B' } } })); s.saveNow(); }, other.blockId);
    await page2.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
    // 通知が先に到着した最悪の順序を固定する (以前は412の同じ版を再競合と誤認して止まった)。
    await page.waitForTimeout(300);
    check('保存: PUT応答待ちの通知では基準を進めない', await page.evaluate(id => window.boxglow.store.getState().project.blocks[id].description !== 'Browser B', other.blockId));
    releasePut();
    await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
    const savedBoth = JSON.parse(fs.readFileSync(fileA, 'utf8'));
    check('保存: 2画面の別ブロック編集をCASで自動統合し、確認を出さない', savedBoth.blocks[block.blockId].description === 'Browser A' && savedBoth.blocks[other.blockId].description === 'Browser B' && await page.evaluate(() => !window.boxglow.store.getState().conflict));
    await page.unroute('**/api/project');
    // 今度は書き込み済みのPUTの応答だけ止め、その上で別画面が元へ戻す。
    // 成功応答の本文を共通基準にできないと、その「戻す」が消える。
    let releaseAck, acceptedPut;
    const ackHeld = new Promise(resolve => { releaseAck = resolve; });
    const accepted = new Promise(resolve => { acceptedPut = resolve; });
    let ackOnce = false;
    await page.route('**/api/project', async route => {
      if (route.request().method() === 'PUT' && !ackOnce) {
        ackOnce = true;
        const response = await route.fetch();
        acceptedPut(); await ackHeld;
        await route.fulfill({ response }); return;
      }
      await route.continue();
    });
    await page.evaluate(id => { const s = window.boxglow.store.getState(); s.apply(p => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], description: 'Temporary X' } } })); s.saveNow(); }, block.blockId);
    await accepted;
    await page2.waitForFunction(id => window.boxglow.store.getState().project.blocks[id].description === 'Temporary X', block.blockId);
    await page2.evaluate(id => { const s = window.boxglow.store.getState(); s.apply(p => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], description: 'Browser A' } } })); s.saveNow(); }, block.blockId);
    await page2.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
    await page.waitForTimeout(300); releaseAck();
    await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
    check('保存: 成功応答前に届いた他者の取り消しを消さない', JSON.parse(fs.readFileSync(fileA, 'utf8')).blocks[block.blockId].description === 'Browser A');
    await page.unroute('**/api/project'); await page2.context().close();

    // 競合: 2 台目と 1 台目が同じ題名を別の値に → 1 台目が止まり、欄で選んで進む (準備の間は常駐の同期を止める。途中で自動の受け取りが入ると、競合にならないことがある)
    await fetch(base + 'api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'pause' }) });
    fs.writeFileSync(fileB, tools.toJSON(tools.updateBlock(tools.updateBlock(tools.fromJSON(fs.readFileSync(fileB, 'utf8')), block.blockId, { title: '2 台目の案' }), other.blockId, { title: 'B remote' })) + '\n');
    await tools.syncOnce({ file: fileB, server: server.url, token });
    await page.evaluate(([id, other]) => { const s = window.boxglow.store.getState(); s.apply((p) => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], title: '1 台目の案' }, [other]: { ...p.blocks[other], title: 'B local' } } })); s.saveNow(); }, [block.blockId, other.blockId]);
    try { await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 10000 }); }
    catch (e) { throw new Error('保存が終わらない: ' + JSON.stringify(await page.evaluate(() => { const s = window.boxglow.store.getState(); return { saveState: s.saveState, saveError: s.saveError, conflict: !!s.conflict }; }))); }
    await page.getByRole('button', { name: '今すぐ同期', exact: true }).click();
    check('同期: 同じ項目を両方で変えると、印が「確認」', await chipText('確認'));
    const groups = page.locator('.conflict-group');
    await groups.first().waitFor();
    check('同期: ブロック別の比較が2つあり、初期選択なし', await groups.count() === 2 && await page.getByRole('button', { name: '選択した内容で統合', exact: true }).isDisabled());
    await groups.filter({ hasText: '1 台目の案' }).locator('.conflict-group__picks input').first().check();
    check('同期: 1つだけ選んでも送れない', await page.getByRole('button', { name: '選択した内容で統合', exact: true }).isDisabled());
    await groups.filter({ hasText: 'B local' }).locator('.conflict-group__picks input').last().check();
    if (process.env.BOXGLOW_B_SCREENSHOTS) {
      fs.mkdirSync(process.env.BOXGLOW_B_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'serve-groups-ja.png') });
      await page.setViewportSize({ width: 430, height: 900 });
      await page.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'serve-groups-narrow.png') });
      check('同期: 狭い画面でも比較が横にはみ出さない', await page.locator('.sync-panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole('button', { name: '選択した内容で統合', exact: true }).click();
    await fetch(base + 'api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'resume' }) });
    check('同期: 選ぶと「同期済み」に戻る', await chipText('同期済み'));
    const head = JSON.parse(server.project(remoteId, 'acc-e2e').head.text);
    check('同期: グループごとに別の側を採用', head.blocks[block.blockId].title === '1 台目の案' && head.blocks[other.blockId].title === 'B remote');

    // serve との接続が切れたら、印は古い「同期済み」ではなく「接続なし」。同じポートで起動し直すと戻る (作者の手動確認で見つけた)
    child.kill();
    await new Promise((r) => child.once('exit', r));
    let lost = false;
    try { await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'disconnected', null, { timeout: 15000 }); lost = true; } catch { lost = false; }
    check('同期: serve が止まると、印が「接続なし」になる (古い「同期済み」を出さない)', lost && await chipText('接続なし'));
    child = spawn(process.execPath, [path.join(tmp, 'serve.mjs'), fileA, dist, String(port), server.url], { env: { ...process.env, BOXGLOW_CONFIG_DIR: configA, BOXGLOW_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => { serveLog += d; }); child.stderr.on('data', (d) => { serveLog += d; });
    let back = false;
    try { await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 30000 }); back = true; } catch { back = false; }
    check('同期: serve を起動し直すと、印が「同期済み」に戻る', back);

    // 段階D: 2台目の通常起動 → 自分の一覧 → 保存先選択 → 受信 → 再開。
    const fileD = path.join(tmp,'device-d','boxglow.json'); fs.mkdirSync(path.dirname(fileD));
    const localD = tools.toJSON(tools.createProject('2台目の手元')); fs.writeFileSync(fileD,localD);
    childD = spawn(process.execPath,[path.join(tmp,'serve.mjs'),fileD,dist,'0',server.url],{env:{...process.env,BOXGLOW_CONFIG_DIR:path.join(tmp,'config-d'),BOXGLOW_TOKEN:token},stdio:['ignore','pipe','pipe']});
    let logD='';childD.stdout.on('data',d=>{logD+=d;});childD.stderr.on('data',d=>{logD+=d;});
    let portD=0; for(let i=0;i<80&&!portD;i++){portD=Number(/localhost:(\d+)\//.exec(logD)?.[1]??0);if(!portD)await page.waitForTimeout(100);}
    if(!portD)throw new Error('second serve failed: '+logD);
    const pageD=await browser.newPage({viewport:{width:1280,height:900}});
    await pageD.goto(`http://localhost:${portD}/?serve=1&lang=ja`);
    await pageD.locator('.sync-chip').click();
    await pageD.getByRole('button',{name:'同期を始める',exact:true}).click();
    await pageD.getByRole('button',{name:'サーバーの計画を開く',exact:true}).click();
    await pageD.locator('.sync-project-row').first().waitFor();
    check('同期D: 2台目の一覧に計画名が出る', (await pageD.locator('.sync-project-row').first().textContent()).includes('同期の画面の検査'));
    check('同期D2: 未連携の計画は新しいファイルが既定', await pageD.getByRole('radio',{name:'新しいファイル',exact:true}).isChecked());
    check('同期D3: 新規保存先には比較の説明を出さない', !(await pageD.locator('.sync-startup').textContent()).includes('手元と内容が違う場合'));
    await pageD.getByRole('radio',{name:/^今開いているファイル/}).check();
    check('同期D3: 現在のファイルには比較を案内', (await pageD.locator('.sync-startup').textContent()).includes('手元と内容が違う場合'));
    await pageD.getByRole('radio',{name:'新しいファイル',exact:true}).check();
    await pageD.getByRole('textbox',{name:'保存ファイル名',exact:true}).fill('../unsafe.json');
    await pageD.locator('.sync-project-row').first().click();
    await pageD.getByRole('alert').filter({hasText:'保存ファイル名を確認'}).waitFor();
    check('同期D2: 不正なファイル名を日本語で案内', (await pageD.locator('.sync-startup').textContent()).includes('保存ファイル名を確認'));
    await pageD.getByRole('button',{name:'再読み込み',exact:true}).click();
    await pageD.locator('.sync-project-row').first().waitFor();
    await pageD.getByRole('radio',{name:'新しいファイル',exact:true}).check();
    await pageD.getByRole('textbox',{name:'保存ファイル名',exact:true}).fill('received.boxglow.json');
    if(process.env.BOXGLOW_E2E_SHOTS)await pageD.screenshot({path:path.join(process.env.BOXGLOW_E2E_SHOTS,'serve-project-list.png')});
    await pageD.locator('.sync-project-row').first().click();
    const openSaved=pageD.getByRole('link',{name:'保存した計画を開く',exact:true});await openSaved.waitFor();
    check('同期D: 元の計画を変えずに別の保存先へ開く', fs.readFileSync(fileD,'utf8')===localD&&JSON.parse(fs.readFileSync(path.join(path.dirname(fileD),'received.boxglow.json'),'utf8')).id===p.id);
    const savedUrl=await openSaved.getAttribute('href'); await pageD.goto(savedUrl+'&lang=ja');
    await pageD.waitForFunction(()=>window.boxglow?.store.getState().syncStatus?.file?.enabled);
    await pageD.reload();await pageD.waitForFunction(()=>window.boxglow?.store.getState().syncStatus?.file?.enabled);
    check('同期D: 開き直しても操作なしで同じ結び付けを再開', await pageD.evaluate(id=>window.boxglow.store.getState().syncStatus?.file?.binding?.remoteId===id,remoteId));
    await pageD.close(); childD.kill(); childD=null;

    // サインアウト → 未サインイン、資格情報が消える
    await page.locator('.sync-panel__details > summary').click();
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
    child?.kill(); childD?.kill();
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { passed, failed } = result();
  console.log(`${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
