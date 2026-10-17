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
    // 履歴: 「サーバーの計画を管理」→ 履歴 → 1 つ前の版 (2 台目が改名) に戻す → 確認 → 画面が戻り、サーバーに新しい版として送られる
    await page.getByRole('button', { name: /^履歴/ }).click();
    await page.locator('.sync-version-row').nth(1).waitFor({ timeout: 10000 });
    const versionRows = await page.locator('.sync-version-row').count();
    check('ブラウザ同期: 履歴に 3 つの版が出る (置いた・2 台目・ブラウザ)', versionRows === 3, String(versionRows));
    await page.locator('.sync-version-row').nth(1).getByRole('button', { name: 'この版に戻す…', exact: true }).click();
    await page.locator('.sync-lifecycle__confirm').waitFor({ timeout: 10000 });
    check('ブラウザ同期: 戻す前の確認に計画名が出る', ((await page.locator('.sync-lifecycle__confirm').textContent()) ?? '').includes('2 台目が改名'));
    await page.getByRole('button', { name: 'この版に戻す', exact: true }).click();
    await page.waitForFunction(() => window.boxglow.store.getState().project?.name === '2 台目が改名', null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 });
    const reverted = server.project(remoteId, 'acc-browser');
    check('ブラウザ同期: 戻した中身が新しい版としてサーバーに届き、履歴は消えない', reverted.versions.length === 4 && JSON.parse(reverted.head.text).name === '2 台目が改名', String(reverted.versions.length));
    // 共有リンク: 作る → URL が出る → 別のブラウザ (サインインなし) でその URL を開くと閲覧専用で開く。失効すると開けない
    await page.getByRole('button', { name: /^共有リンク/ }).click();
    await page.getByRole('button', { name: 'リンクを作る', exact: true }).click();
    await page.locator('.sync-shares__url').waitFor({ timeout: 10000 });
    const shareUrl = await page.locator('.sync-shares__url').inputValue();
    check('ブラウザ同期: 共有リンクの URL が出る (boxglow.app の #share= と、試験サーバーの server=)', /^https:\/\/boxglow\.app\/#share=bgs_/.test(shareUrl) && shareUrl.includes('&server='));
    const viewer = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const viewerPage = await viewer.newPage();
    await viewerPage.goto(base + shareUrl.slice(shareUrl.indexOf('#')) + '&lang=ja');
    await viewerPage.waitForFunction(() => !!window.boxglow && !!window.boxglow.store.getState().project, null, { timeout: 20000 });
    check('ブラウザ同期: 共有リンクで開くと、閲覧専用で計画が出る', await viewerPage.evaluate(() => { const s = window.boxglow.store.getState(); return s.project?.name === '2 台目が改名' && s.readonly === true && s.ephemeral === true; }));
    check('ブラウザ同期: 共有リンクの画面には同期の印が無い', (await viewerPage.locator('.sync-chip').count()) === 0);
    await viewer.close();
    await page.locator('.sync-share-row').first().getByRole('button', { name: '失効', exact: true }).click();
    await viewerPage.waitForTimeout(0).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.sync-share-row')?.getAttribute('data-off') === 'true', null, { timeout: 10000 });
    const revokedRead = await page.evaluate(async (u) => (await fetch(u)).status, server.url + '/v1/shares/' + decodeURIComponent(shareUrl.match(/share=([^&]+)/)[1]));
    check('ブラウザ同期: 失効した共有リンクは読めない', revokedRead === 404);
    await page.getByRole('button', { name: /^履歴/ }).click(); // 行をもう一度押して閉じる
    // AI エージェントの接続: 右上のアカウントのメニュー → 「AI エージェントの接続」 → 「Claude Code に接続」 → ブラウザ版は 3 手順 (設定ファイルのダウンロード → 置く → 開き直す) → 失効
    await page.locator('.account-button').click();
    await page.locator('.account-menu').getByRole('button', { name: /^AI エージェントの接続/ }).click();
    await page.locator('.agent-tokens').waitFor({ timeout: 10000 });
    check('ブラウザ同期: 接続はボタン 1 つ (トークンの名前を聞かない)', (await page.locator('.agent-tokens input[type="text"]').count()) === 0 && (await page.locator('.agent-tokens').getByRole('button', { name: 'Codex に接続', exact: true }).count()) === 1);
    await page.locator('.agent-tokens').getByRole('button', { name: 'Claude Code に接続', exact: true }).click();
    await page.locator('.agent-connect').waitFor({ timeout: 10000 });
    const connectText = (await page.locator('.agent-connect').textContent()) ?? '';
    check('ブラウザ同期: ブラウザ版は 3 手順 (ダウンロード・置く場所・開き直す) を出し、トークンの値は見せない', /あと [23] 手順/.test(connectText) && connectText.includes('フォルダ') && connectText.includes('開き直す') && !connectText.includes('bga_'));
    // フォルダ選択 (File System Access API) を、メモリ上の偽物に差し替える (.gitignore はある前提)
    await page.evaluate(() => {
      const files = { '.gitignore': 'node_modules\n' };
      window.__fsFiles = files;
      const handle = (name) => ({ kind: 'file', name, getFile: async () => ({ text: async () => files[name] }), createWritable: async () => ({ write: async (t) => { files[name] = t; }, close: async () => {} }) });
      window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'myproject', getFileHandle: async (name, opts) => { if (!(name in files)) { if (!opts?.create) throw new DOMException('no', 'NotFoundError'); files[name] = ''; } return handle(name); } });
    });
    await page.locator('.agent-connect').getByRole('button', { name: 'フォルダを選んで設定を書く', exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('.agent-connect')?.textContent ?? '').includes('設定を書きました'), null, { timeout: 10000 });
    const written = await page.evaluate(() => window.__fsFiles);
    const mcpWritten = JSON.parse(written['.mcp.json']);
    check('ブラウザ同期: 選んだフォルダの .mcp.json に MCP の URL とトークンが書かれ、.gitignore にも足される', mcpWritten.mcpServers.boxglow.url === server.url + '/mcp' && /^Bearer bga_acc[0-9a-f]{32}\./.test(mcpWritten.mcpServers.boxglow.headers.Authorization) && written['.gitignore'].includes('\n.mcp.json\n'));
    check('ブラウザ同期: 書いた後は「接続しました」とフォルダ名が出る', ((await page.locator('.agent-connect').textContent()) ?? '').includes('myproject/.mcp.json'));
    check('ブラウザ同期: トークンの一覧には値が無く、名前と読み書きと計画の ID が出る', !((await page.locator('.agent-tokens__row').first().textContent()) ?? '').includes('bga_') && ((await page.locator('.agent-tokens__row').first().textContent()) ?? '').includes('claude-code') && ((await page.locator('.agent-tokens__row').first().textContent()) ?? '').includes('読み書き'));
    await page.locator('.agent-tokens__row').first().getByRole('button', { name: '失効', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.agent-tokens__row')?.getAttribute('data-off') === 'true', null, { timeout: 10000 });
    check('ブラウザ同期: トークンを失効させると一覧で失効になる', [...server.agentTokens.values()][0]?.revoked === true);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    // ---- チーム (B81): 作る → 招待リンク → 別のブラウザの人が #join= で参加 → チームに置いた計画を受け取って編集 → 届く → 閲覧に落とすと書けない ----
    await page.locator('.account-button').click();
    await page.locator('.account-menu').getByRole('button', { name: /^ワークスペース/ }).click();
    await page.locator('.teams').waitFor({ timeout: 10000 });
    await page.locator('.teams').getByLabel('ワークスペースの名前').fill('開発');
    await page.locator('.teams').getByRole('button', { name: 'ワークスペースを作る', exact: true }).click();
    await page.locator('.teams__detail').waitFor({ timeout: 10000 });
    check('チーム: 作ると一覧と詳細に出る (管理)', ((await page.locator('.teams').textContent()) ?? '').includes('開発') && ((await page.locator('.teams__detail').textContent()) ?? '').includes('管理'));
    const teamId = [...server.teams.keys()][0];
    await page.locator('.teams__detail').getByRole('button', { name: '招待リンクを作る', exact: true }).click();
    await page.locator('.teams__detail .agent-tokens__secret').waitFor({ timeout: 10000 });
    const inviteUrl = (await page.locator('.teams__detail .agent-tokens__secret').textContent()) ?? '';
    const inviteToken = /join=(bgi_[A-Za-z0-9_.-]+)/.exec(inviteUrl)?.[1];
    check('チーム: 招待リンクの URL が出る', !!inviteToken && inviteUrl.startsWith('https://boxglow.app/#join='), inviteUrl);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    // a: 新しい計画を「開発」に置く (置く先の選択)。終わったら元の個人の計画に戻す (後続の検査はその計画を使う)
    const personalPid = await page.evaluate(() => window.boxglow.store.getState().project?.id);
    await page.evaluate(() => window.boxglow.store.getState().newProject('チームの計画'));
    await page.waitForFunction(() => window.boxglow.store.getState().project?.name === 'チームの計画');
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'unbound', null, { timeout: 15000 });
    await page.locator('.sync-chip').click();
    await page.locator('.sync-startup__team select').waitFor({ timeout: 10000 });
    await page.locator('.sync-startup__team select').selectOption(teamId);
    await page.getByRole('button', { name: 'この計画を新しくサーバーに置く', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 30000 });
    const teamRemoteId = await page.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding?.remoteId);
    check('チーム: 置く先にチームを選ぶと、計画はチームの名前空間に入り、結び付けにチームが付く', !!server.project(teamRemoteId, teamId)?.head && (await page.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding?.team?.name)) === '開発');
    check('チーム: 同期パネルにワークスペース名が出る', ((await page.locator('.sync-popover').textContent()) ?? '').includes('ワークスペース: 開発'));
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    // b: 招待リンクを開く → サインイン → 参加
    const context3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page3 = await context3.newPage();
    await page3.goto(url + '#join=' + inviteToken);
    await page3.waitForFunction(() => !!window.boxglow);
    await page3.locator('.join-dialog').waitFor({ timeout: 15000 });
    check('チーム: 招待リンクを開くと参加の画面が出て、先にサインインを求める', ((await page3.locator('.join-dialog').textContent()) ?? '').includes('サインイン'));
    await page3.locator('.join-dialog').getByRole('button', { name: 'GitHub でサインイン', exact: true }).click();
    await page3.locator('.sync-panel__code').first().waitFor({ timeout: 15000 });
    server.deviceCodes.set([...server.deviceCodes.keys()].at(-1), { account: 'acc-member', login: 'member-user' });
    await page3.locator('.join-dialog').getByRole('button', { name: '参加する', exact: true }).waitFor({ timeout: 30000 });
    check('チーム: サインインするとチーム名と役割つきで参加を聞く', ((await page3.locator('.join-dialog').textContent()) ?? '').includes('「開発」') && ((await page3.locator('.join-dialog').textContent()) ?? '').includes('編集'));
    await page3.locator('.join-dialog').getByRole('button', { name: '参加する', exact: true }).click();
    await page3.waitForFunction(() => (document.querySelector('.join-dialog')?.textContent ?? '').includes('参加しました'), null, { timeout: 10000 });
    check('チーム: 参加するとサーバーのメンバーに入る', server.teams.get(teamId)?.members.get('acc-member')?.role === 'editor');
    await page3.locator('.join-dialog').getByRole('button', { name: '閉じる', exact: true }).click();
    // b: Home の「受け取る元」でチームを選んで受け取る
    await page3.locator('.home-receive select').waitFor({ timeout: 15000 });
    await page3.locator('.home-receive select').selectOption(teamId);
    await page3.locator('.home-receive').getByRole('button', { name: 'サーバーの計画を受け取る', exact: true }).click();
    await page3.locator('.home-receive .sync-project-row').first().waitFor({ timeout: 20000 });
    check('チーム: 受け取る元にチームを選ぶと、チームの計画が一覧に出る', ((await page3.locator('.home-receive').textContent()) ?? '').includes('チームの計画'), JSON.stringify(await page3.evaluate(() => { const s = window.boxglow.store.getState().syncStatus; return { startup: s?.startup && { stage: s.startup.stage, team: s.startup.team, teams: s.startup.teams, n: s.startup.projects?.length }, file: s?.file?.path }; })));
    await page3.locator('.home-receive .sync-project-row').first().click();
    await page3.waitForFunction(() => window.boxglow.store.getState().project?.name === 'チームの計画', null, { timeout: 20000 });
    await page3.waitForFunction(() => ['synced', 'halted', 'problem', 'offline'].includes(document.querySelector('.sync-chip')?.getAttribute('data-state') ?? ''), null, { timeout: 30000 });
    check('チーム: 受け取った計画はチームに結び付き同期済み', (await page3.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding?.team?.name)) === '開発' && (await page3.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding?.remoteId)) === teamRemoteId, 'teamRemoteId=' + teamRemoteId + ' teamSpace=' + JSON.stringify([...(server.accounts.get(teamId)?.keys() ?? [])]) + ' ' + JSON.stringify(await page3.evaluate(() => { const s = window.boxglow.store.getState().syncStatus; return { file: s?.file, state: s?.state, halt: s?.halt && { reason: s.halt.reason, text: s.halt.text }, problem: s?.problem, message: s?.message }; })));
    // b が編集 → a に届く
    await page3.evaluate(() => window.boxglow.store.getState().apply((p) => ({ ...p, name: 'チームで改名' })));
    // (サーバーのチームの計画に、b の編集が届くまで待つ。画面の印だけでは「編集前から同期済み」と区別できない)
    for (let i = 0; i < 100 && !(server.project(teamRemoteId, teamId)?.head?.text ?? '').includes('チームで改名'); i++) await page3.waitForTimeout(500);
    check('チーム: 2 人目の編集がサーバーのチームの計画に届く', (server.project(teamRemoteId, teamId)?.head?.text ?? '').includes('チームで改名'), JSON.stringify(await page3.evaluate(() => { const s = window.boxglow.store.getState(); return { state: s.syncStatus?.state, message: s.syncStatus?.message, problem: s.syncStatus?.problem, halt: s.syncStatus?.halt?.reason, save: s.saveState, name: s.project?.name, file: s.syncStatus?.file?.path, pid: s.project?.id }; })) + ' server=' + JSON.parse(server.project(teamRemoteId, teamId)?.head?.text ?? '{}').name + ' personal=' + JSON.parse(server.project(teamRemoteId, 'acc-member')?.head?.text ?? '{}').name + ' puts=' + server.puts + ' versions=' + (server.project(teamRemoteId, teamId)?.versions?.length ?? 0));
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 });
    await page.locator('.sync-chip').click();
    await page.getByRole('button', { name: '今すぐ同期', exact: true }).click();
    await page.waitForFunction(() => window.boxglow.store.getState().project?.name === 'チームで改名', null, { timeout: 30000 });
    check('チーム: 2 人目の編集が 1 人目に届く', true);
    // a が b を閲覧に落とす → b は書けない
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.locator('.account-button').click();
    await page.locator('.account-menu').getByRole('button', { name: /^ワークスペース/ }).click();
    await page.locator('.teams__row').first().click();
    await page.locator('.teams__detail').waitFor({ timeout: 10000 });
    await page.locator('.teams__member').filter({ hasText: 'member-user' }).locator('select').selectOption('viewer');
    for (let i = 0; i < 40 && server.teams.get(teamId)?.members.get('acc-member')?.role !== 'viewer'; i++) await page.waitForTimeout(250);
    check('チーム: 管理者が役割を閲覧に変えられる', server.teams.get(teamId)?.members.get('acc-member')?.role === 'viewer', JSON.stringify(await page.evaluate(() => { const tm = window.boxglow.store.getState().syncStatus?.teams; return { error: tm?.error, busy: tm?.busy, members: tm?.open?.members?.map((m) => [m.login, m.role]) }; })) + ' server=' + server.teams.get(teamId)?.members.get('acc-member')?.role);
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page3.evaluate(() => window.boxglow.store.getState().apply((p) => ({ ...p, name: '閲覧なのに' })));
    await page3.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 10000 }).catch(() => {});
    await page3.locator('.sync-chip').click();
    await page3.getByRole('button', { name: '今すぐ同期', exact: true }).click();
    await page3.waitForFunction(() => ['problem', 'halted', 'offline', 'signed-out'].includes(document.querySelector('.sync-chip')?.getAttribute('data-state') ?? ''), null, { timeout: 30000 });
    check('チーム: 閲覧の人は同期で書けない (問題として画面に出る)', server.project(teamRemoteId, teamId) && JSON.parse(server.project(teamRemoteId, teamId).head.text).name === 'チームで改名');
    await context3.close();
    // a の画面を元の個人の計画に戻す
    await page.evaluate((id) => window.boxglow.store.getState().openProject(id), personalPid);
    await page.waitForFunction((id) => window.boxglow.store.getState().project?.id === id, personalPid, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 30000 });
    await page.evaluate(() => window.boxglow.store.getState().apply((p) => ({ ...p, name: 'ブラウザで改名' })));
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 });
    await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 10000 }).catch(() => {});
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
    check('ブラウザ同期: 別のブラウザの Home からサインインして受け取ると、その計画が開く', await page2.evaluate(() => window.boxglow.store.getState().project?.name === 'ブラウザで改名'), 'opened=' + (await page2.evaluate(() => window.boxglow.store.getState().project?.name)) + ' personal=' + JSON.stringify([...(server.accounts.get('acc-browser')?.entries() ?? [])].map(([id, p]) => [id, JSON.parse(p.head?.text ?? '{}').name])));
    await page2.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 });
    check('ブラウザ同期: 受け取った計画は同期が有効で「同期済み」', (await page2.locator('.sync-chip').getAttribute('data-state')) === 'synced');
    // 止める → 札が灰色の「停止中」(disabled) → 再開 → 同期済み → その他の「やめる」→ 結び付けが消えて「未接続」(unbound)
    await page2.locator('.sync-chip').click();
    await page2.getByRole('button', { name: '同期を止める', exact: true }).click();
    await page2.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'disabled', null, { timeout: 15000 }).catch(() => {});
    check('ブラウザ同期: 「同期を止める」で札が「停止中」(disabled) になり、問題の赤ではない', (await page2.locator('.sync-chip').getAttribute('data-state')) === 'disabled' && (await page2.locator('.sync-chip').getAttribute('class')).includes('tone-quiet'));
    await page2.getByRole('button', { name: '同期を再開する', exact: true }).click();
    await page2.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 20000 }).catch(() => {});
    check('ブラウザ同期: 「同期を再開する」で同期済みに戻る', (await page2.locator('.sync-chip').getAttribute('data-state')) === 'synced');
    await page2.locator('.sync-panel__details > summary').click();
    await page2.getByRole('button', { name: 'この計画の同期をやめる (サーバーの控えは残す)', exact: true }).click();
    await page2.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'unbound', null, { timeout: 15000 }).catch(() => {});
    check('ブラウザ同期: 「やめる」で結び付けが消えて未接続になり、サーバーの計画は残る', (await page2.locator('.sync-chip').getAttribute('data-state')) === 'unbound' && !!server.project(remoteId, 'acc-browser')?.head && (await page2.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding)) === null);
    await page2.keyboard.press('Escape');
    // Home に戻ると、サインイン中の利用者とサインアウトが出て、サインアウトできる
    await page2.evaluate(() => window.boxglow.store.getState().closeProject());
    await page2.locator('.home-receive__who').waitFor({ timeout: 10000 });
    check('ブラウザ同期: Home にサインイン中の利用者が出る', (await page2.locator('.home-receive__who').textContent()).includes('browser-user'));
    await page2.locator('.home-receive__who').getByRole('button', { name: 'サインアウト', exact: true }).click();
    await page2.waitForFunction(() => document.querySelector('.home-receive__who') === null, null, { timeout: 10000 });
    check('ブラウザ同期: Home からサインアウトできる', await page2.evaluate(() => window.boxglow.store.getState().syncStatus?.credentials.source === 'none'));
    await context2.close();
    // サインアウト: 印が「未サインイン」、サーバーでトークンが失効
    // サインアウトは右上のアカウントのメニューから
    await page.locator('.account-button').click();
    await page.locator('.account-menu').getByRole('button', { name: 'サインアウト', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'signed-out', null, { timeout: 15000 });
    check('ブラウザ同期: サインアウトで「未サインイン」に戻り、トークンが失効する', server.revoked.has(token));
    // アカウントの削除: もう一度サインインしてから、詳細の「アカウントを削除…」→ 確認 → サーバーが受け付け、トークンが全部失効し、未サインインに戻る
    // (右上のアカウントのメニューからサインインし直す。メニューは開いたままなので、終わったら Escape で閉じてから開き直す)
    await page.locator('.account-button').click(); // サインアウトでメニューは閉じているので開き直す
    await page.locator('.account-menu').getByRole('button', { name: 'GitHub でサインイン', exact: true }).click();
    await page.locator('.sync-panel__code').waitFor({ timeout: 15000 });
    server.deviceCodes.set([...server.deviceCodes.keys()].at(-1), { account: 'acc-browser', login: 'browser-user' });
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'synced', null, { timeout: 30000 });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    await page.locator('.account-button').click();
    await page.locator('.account-menu').getByRole('button', { name: 'アカウントを削除…', exact: true }).click();
    const confirmBox = page.locator('.sync-panel__confirm-delete'); await confirmBox.waitFor({ timeout: 5000 });
    check('ブラウザ同期: アカウントの削除は欄の中の確認で 30 日の猶予を説明する', ((await confirmBox.textContent()) ?? '').includes('30 日'));
    await confirmBox.getByRole('button', { name: 'やめる', exact: true }).click();
    check('ブラウザ同期: 「やめる」で削除されない', !server.deletedAccounts.has('acc-browser') && (await page.locator('.sync-panel__confirm-delete').count()) === 0);
    await page.locator('.account-menu').getByRole('button', { name: 'アカウントを削除…', exact: true }).click();
    await page.locator('.sync-panel__confirm-delete').getByRole('button', { name: 'アカウントを削除する', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'signed-out', null, { timeout: 15000 });
    check('ブラウザ同期: 削除をサーバーが受け付け、その利用者のトークンが全部失効する', server.deletedAccounts.has('acc-browser') && [...server.issued].filter(([, u]) => u.account === 'acc-browser').every(([tok]) => server.revoked.has(tok)));
    await page.locator('.sync-chip').click();
    check('ブラウザ同期: 削除の受け付けと消える日が画面に出る', (await page.locator('.sync-panel').textContent()).includes('アカウントの削除を受け付けました'));
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
