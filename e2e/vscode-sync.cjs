/**
 * 実際の VS Code (Linux。WSLg の画面) の中で、画面からの同期を通しで確かめる (拡張ホストが Linux の場合 = 段階 1 の対象)
 * VS Code を Playwright の Electron の操作で起動し、Boxglow の webview の中を押して、サインイン → この計画を同期する → サーバーに置く →
 * 2 台目の変更の受け取り → 競合の解決 → サインアウト、を確かめる。拡張は開発中の vscode/ をそのまま読み込む (専用の設定・拡張フォルダ)
 * 前提: VS Code の Linux 版を ~/.cache/boxglow-e2e/vscode-linux/VSCode-linux-x64/ に展開 (無ければ、この検査は飛ばす)。PLAYWRIGHT は run.sh と同じ
 * 使い方: node e2e/vscode-sync.cjs (先に env -u VITE_BASE npm run build:vscode)
 */
const { check, result } = require('./lib.cjs');
const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CODE = process.env.BOXGLOW_E2E_VSCODE || path.join(os.homedir(), '.cache', 'boxglow-e2e', 'vscode-linux', 'VSCode-linux-x64', 'code');

(async () => {
  // (段階の完了の判定などで、実機の検査を必須にするときは BOXGLOW_E2E_REQUIRE_VSCODE=1。無ければ失敗にする。SKIP を成功と数えない)
  if (!fs.existsSync(CODE)) {
    if (process.env.BOXGLOW_E2E_REQUIRE_VSCODE === '1') { console.log('NG  VS Code の Linux 版がありません (必須): ' + CODE); process.exit(1); }
    console.log('SKIP VS Code の Linux 版がありません: ' + CODE); process.exit(0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boxglow-e2e-vscode-'));
  let app = null, server = null;
  try {
    // ---- 検査の道具 (試験用の同期サーバー・2 台目の同期・計画を作る) ----
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    await esbuild.build({ bundle: true, platform: 'node', format: 'esm', target: 'node18', loader: { '.md': 'text' }, logLevel: 'silent'
    , entryPoints: [path.join(__dirname, 'sync', 'entry-tools.ts')], outfile: path.join(tmp, 'tools.mjs') });
    const tools = await import(path.join(tmp, 'tools.mjs'));
    server = new tools.TestSyncServer(); await server.start();
    let p = tools.createProject('VS Code の同期の検査');
    p.lang = 'ja';   // (画面の文言を日本語にそろえる。計画に言語が無いと、VS Code の表示言語に従う)
    const block = tools.addBlock(p, { parentId: tools.defaultTaskParent(p), title: 'A' }); p = block.project;
    const other = tools.addBlock(p, { parentId: tools.defaultTaskParent(p), title: 'B' }); p = other.project;
    const work = path.join(tmp, 'work'); fs.mkdirSync(work);
    const fileA = path.join(work, 'boxglow.json');
    fs.writeFileSync(fileA, tools.toJSON(p) + '\n');
    // ---- VS Code の専用の設定 (同期サーバー・boxglow.json を図で開く) ----
    const ud = path.join(tmp, 'ud'); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
      'boxglow.sync.server': server.url, 'workbench.editorAssociations': { '**/boxglow.json': 'boxglow.editor' }
    // (保存先・読み込む先の選択を、VS Code の簡易ダイアログにする。OS のダイアログは検査から操作できないため)
    , 'files.simpleDialog.enable': true
    // (保存しますか などの確認を、VS Code の画面の中のダイアログにする。OS のダイアログは検査から押せないため)
    , 'window.dialogStyle': 'custom'
    , 'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none'
    }));
    // (検査で使うコマンドのキー: エディタの分割・テキストエディターで開き直す。コマンドパレットに打つより確か)
    fs.writeFileSync(path.join(ud, 'User', 'keybindings.json'), JSON.stringify([
      { key: 'ctrl+alt+shift+1', command: 'workbench.action.splitEditorRight' }
    , { key: 'ctrl+alt+shift+2', command: 'workbench.action.reopenTextEditor' }
    , { key: 'ctrl+alt+shift+3', command: 'workbench.action.closeAllEditors' }
    ]));
    const configA = path.join(tmp, 'config-a'), configB = path.join(tmp, 'config-b');
    app = await _electron.launch({
      executablePath: CODE
    , args: [work, fileA, '--user-data-dir', ud, '--extensions-dir', path.join(tmp, 'exts'), '--extensionDevelopmentPath', path.join(ROOT, 'vscode'), '--disable-workspace-trust', '--skip-release-notes', '--disable-gpu', '--no-sandbox']
    // (ELECTRON_RUN_AS_NODE が残っていると、VS Code が Node として動いてしまう。VS Code の中から検査を動かすときに起きる)
    , env: (() => { const env = { ...process.env, BOXGLOW_CONFIG_DIR: configA, BOXGLOW_TOKEN: '' }; delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI; return env; })()
    });
    const win = await app.firstWindow();
    // (検査した環境を記録する)
    console.log(`環境: VS Code ${await app.evaluate(({ app: a }) => a.getVersion()).catch(() => '?')} (Linux の拡張ホスト), Playwright ${require(path.join(path.dirname(require.resolve(process.env.PLAYWRIGHT || 'playwright')), 'package.json')).version}, ${os.release()}`);
    // (VS Code の最初の案内のダイアログが出たら閉じる。図の操作を覆うため)
    // (出るまでに時間がかかることがあるので、図を探す間も見張って閉じる)
    const skip = win.getByText('Continue without Signing In', { exact: true });
    let watching = true;
    // (2 ページ目 = 色の選びの「Get Started」もある。どちらも先へ進めて閉じる)
    const started = win.getByRole('button', { name: 'Get Started', exact: true });
    const onboarding = async () => (await skip.isVisible().catch(() => false)) || (await started.isVisible().catch(() => false));
    const dismiss = (async () => { while (watching) {
      if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
      if (await started.isVisible().catch(() => false)) await started.click().catch(() => {});
      await win.waitForTimeout(500).catch(() => {});
    } })();
    // Boxglow の webview の中の frame を探す (VS Code の webview は入れ子の iframe)
    const findFrame = async () => {
      for (let i = 0; i < 120; i++) {
        for (const f of win.frames()) { try { if (await f.locator('.sync-chip').count()) return f; } catch { /* まだ読み込み中 */ } }
        await win.waitForTimeout(500);
      }
      return null;
    };
    const frame = await findFrame();
    if (!frame) {
      // (手がかり: 画面と、frame の一覧)
      const dir = process.env.BOXGLOW_E2E_SHOTS || path.join(os.tmpdir(), 'boxglow-e2e-shots'); fs.mkdirSync(dir, { recursive: true });
      await win.screenshot({ path: path.join(dir, 'vscode-sync-failed.png') }).catch(() => {});
      for (const f of win.frames()) console.log('frame:', f.url().slice(0, 150), await f.locator('.save-chip, .project-name, body').count().catch(() => -1));
    }
    check('VS Code: Boxglow の図が開き、同期の印が出る', !!frame);
    if (!frame) throw new Error('webview が見つからない');
    if (process.env.DEBUG_VSCODE_SYNC) {
      console.log('chip:', await frame.locator('.sync-chip').textContent(), 'lang:', await frame.evaluate(() => document.documentElement.lang));
      await win.screenshot({ path: path.join(os.tmpdir(), 'boxglow-e2e-shots', 'vscode-sync-debug.png') });
    }
    // (画面の言語は VS Code の表示言語に従うので、印は data-state で、ボタンは日本語・英語のどちらの名前でも探す)
    const STATE = { '未サインイン': 'signed-out', 'オフ': 'off', '未接続': 'unbound', '同期済み': 'synced', '確認': 'halted' };
    const chipText = async (text) => { try { await frame.waitForFunction((s) => document.querySelector('.sync-chip')?.getAttribute('data-state') === s, STATE[text], { timeout: 20000 }); return true; } catch { return false; } };
    const NAMES = { '手元の編集を退避': 'Save a copy of my edits', '両方の変更を統合': 'Merge both versions', '手元を退避して最新のファイルを開く': 'Export mine and open the latest file', '退避した編集を読み込む': 'Load saved edits', 'GitHub でサインイン': 'Sign in with GitHub', 'サーバーに置く': 'Put on the server', '今すぐ同期': 'Sync now', '手元の値に決める': 'Use the local value', 'サインアウト': 'Sign out' };
    const button = (ja) => frame.getByRole('button', { name: new RegExp(`^(${ja}|${NAMES[ja]})$`) });
    // 案内のダイアログが出て閉じるまで待つ (出なければ 20 秒で先へ)
    for (let i = 0; i < 40 && !(await onboarding()); i++) await win.waitForTimeout(500);
    for (let i = 0; i < 30 && (await onboarding()); i++) await win.waitForTimeout(500);
    watching = false; await dismiss;
    check('VS Code: サインインしていない間は「未サインイン」', await chipText('未サインイン'));
    await frame.locator('.tree-toggle').click();
    check('VS Code: 独立ツリーを開ける', await frame.locator('.tree-panel').isVisible());
    await frame.locator('.tree-toggle').click();
    await frame.locator('.sync-chip').click();
    await button('GitHub でサインイン').click();
    await frame.locator('.sync-panel__code').waitFor({ timeout: 15000 });
    check('VS Code: サインインのコードが出る', /^TEST-/.test((await frame.locator('.sync-panel__code').textContent()) ?? ''));
    server.deviceCodes.set([...server.deviceCodes.keys()].at(-1), { account: 'acc-vscode', login: 'vscode-user' });
    check('VS Code: 許可されると「オフ」(この計画はまだ同期していない)', await chipText('オフ'));
    // この計画を同期する (有効化) → サーバーに置く
    // (チェックの表示は、裏方からの状態で変わる。押した後は、印の状態で確かめる)
    await frame.getByRole('button', { name: /^(この計画を同期する|Sync this plan)$/ }).click();
    check('VS Code: 有効にすると「未接続」', await chipText('未接続'));
    await button('サーバーに置く').click();
    check('VS Code: サーバーに置くと「同期済み」', await chipText('同期済み'));
    const remoteId = await frame.evaluate(() => window.boxglow.store.getState().syncStatus?.file?.binding?.remoteId);
    check('VS Code: サーバーに計画ができる', !!remoteId && !!server.project(remoteId, 'acc-vscode')?.head);
    // 2 台目が送る → 今すぐ同期 → 図に届く
    const token = [...server.issued.keys()].at(-1);
    const fileB = path.join(tmp, 'b', 'boxglow.json'); fs.mkdirSync(path.dirname(fileB));
    process.env.BOXGLOW_CONFIG_DIR = configB;
    await tools.syncOnce({ file: fileB, server: server.url, remoteId, token });
    fs.writeFileSync(fileB, tools.toJSON(tools.updateBlock(tools.fromJSON(fs.readFileSync(fileB, 'utf8')), block.blockId, { title: '2 台目の題名' })) + '\n');
    await tools.syncOnce({ file: fileB, server: server.url, token });
    await button('今すぐ同期').click();
    const titleOf = () => frame.evaluate((id) => window.boxglow.store.getState().project.blocks[id].title, block.blockId);
    let received = false;
    for (let i = 0; i < 60 && !received; i++) { received = (await titleOf()) === '2 台目の題名'; if (!received) await win.waitForTimeout(250); }
    check('VS Code: 2 台目の変更が図に届く (エディタが読み直し、画面に update が来る)', received);
    check('VS Code: ディスクのファイルも 2 台目の題名', JSON.parse(fs.readFileSync(fileA, 'utf8')).blocks[block.blockId].title === '2 台目の題名');
    // 競合 → 欄で解決 (準備の間は常駐の同期を止める。途中で自動の受け取りが入ると、競合にならないことがある)
    await frame.evaluate(() => window.boxglow.store.getState().syncAct({ kind: 'pause' }));
    fs.writeFileSync(fileB, tools.toJSON(tools.updateBlock(tools.updateBlock(tools.fromJSON(fs.readFileSync(fileB, 'utf8')), block.blockId, { title: '2 台目の案' }), other.blockId, { title: 'B remote' })) + '\n');
    await tools.syncOnce({ file: fileB, server: server.url, token });
    await frame.evaluate(([id, other]) => { const s = window.boxglow.store.getState(); s.apply((p) => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], title: 'VS Code の案' }, [other]: { ...p.blocks[other], title: 'B local' } } })); s.saveNow(); }, [block.blockId, other.blockId]);
    await frame.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 15000 });
    await button('今すぐ同期').click();
    check('VS Code: 競合で「確認」', await chipText('確認'));
    const groups = frame.locator('.conflict-group');
    await groups.first().waitFor();
    const submit = frame.getByRole('button', { name: /^(選択した内容で統合|Merge selected values)$/ });
    check('VS Code: ブロック別の比較が2つあり、初期選択なし', await groups.count() === 2 && await submit.isDisabled());
    await groups.filter({ hasText: 'VS Code の案' }).locator('.conflict-group__picks input').first().check();
    check('VS Code: 1グループだけでは送らない', await submit.isDisabled());
    await groups.filter({ hasText: 'B local' }).locator('.conflict-group__picks input').last().check();
    if (process.env.BOXGLOW_B_SCREENSHOTS) {
      fs.mkdirSync(process.env.BOXGLOW_B_SCREENSHOTS, { recursive: true });
      await win.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'vscode-groups.png') });
    }
    await submit.click();
    await frame.evaluate(() => window.boxglow.store.getState().syncAct({ kind: 'resume' }));
    check('VS Code: 選ぶと「同期済み」', await chipText('同期済み'));
    const selected = JSON.parse(server.project(remoteId, 'acc-vscode').head.text);
    check('VS Code: グループごとに別の側を採用', selected.blocks[block.blockId].title === 'VS Code の案' && selected.blocks[other.blockId].title === 'B remote');
    // GUIだけの未保存変更とディスクの独立変更。実拡張からのupdate/CAS失敗を通して自動保存まで確かめる。
    await frame.evaluate(() => window.boxglow.store.getState().syncAct({ kind: 'pause' }));
    await frame.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
    const diskBefore = tools.fromJSON(fs.readFileSync(fileA, 'utf8'));
    await frame.evaluate(id => { window.boxglow.store.getState().apply(p => ({ ...p, blocks: { ...p.blocks, [id]: { ...p.blocks[id], description: 'GUI independent' } } })); }, block.blockId);
    fs.writeFileSync(fileA, tools.toJSON(tools.updateBlock(diskBefore, other.blockId, { description: 'Disk independent' })) + '\n');
    await frame.waitForFunction(([a, b]) => { const s = window.boxglow.store.getState(); return s.saveState === 'saved' && s.project.blocks[a].description === 'GUI independent' && s.project.blocks[b].description === 'Disk independent'; }, [block.blockId, other.blockId], { timeout: 20000 });
    const autoSaved = JSON.parse(fs.readFileSync(fileA, 'utf8'));
    check('VS Code: 競合ゼロのGUIとディスク変更を自動統合して保存', autoSaved.blocks[block.blockId].description === 'GUI independent' && autoSaved.blocks[other.blockId].description === 'Disk independent');
    await frame.evaluate(() => window.boxglow.store.getState().syncAct({ kind: 'resume' }));
    // ---- 保存の衝突: エディタ (TextDocument) に未保存の編集があるときに受け取る → 退避 → 最新を開く → 取り込む → Save → 同期 ----
    // (エディタを分割し、片方をテキストエディターにして、計画の名前の末尾に文字を足す。保存はしない)
    // (キーが webview の中に吸われないよう、先に作業中のタブを押して VS Code 本体にフォーカスを移してから、コマンドのキーを押す)
    const command = async (key) => {
      await win.locator('.editor-group-container.active .tab.active').first().click();
      await win.keyboard.press(key);
      await win.waitForTimeout(1500);
    };
    await command('Control+Alt+Shift+1');
    await command('Control+Alt+Shift+2');
    // (テキストエディターの 4 行目 = 計画の名前。行末の「",」の前に文字を足す)
    const textEditor = win.locator('.editor-group-container.active .monaco-editor .view-lines').first();
    await textEditor.waitFor({ timeout: 10000 });
    await textEditor.click();
    await win.keyboard.press('Control+Home');
    for (let i = 0; i < 3; i++) await win.keyboard.press('ArrowDown');
    await win.keyboard.press('End'); await win.keyboard.press('ArrowLeft'); await win.keyboard.press('ArrowLeft');
    await win.keyboard.type('_EDITOR', { delay: 20 });
    // (図を探し直す: 分割で webview が作り直されることがある)
    const frame2 = (await findFrame()) ?? frame;
    const nameOf = () => frame2.evaluate(() => window.boxglow.store.getState().project.name);
    let editorSeen = false;
    for (let i = 0; i < 40 && !editorSeen; i++) { editorSeen = (await nameOf()).endsWith('_EDITOR'); if (!editorSeen) await win.waitForTimeout(250); }
    check('VS Code: エディタの未保存の編集が図に届く', editorSeen);
    check('VS Code: エディタの編集はディスクに書かれていない', !JSON.parse(fs.readFileSync(fileA, 'utf8')).name.endsWith('_EDITOR'));
    // 2 台目が送り、今すぐ同期 → ディスクが変わる → エディタは dirty なので衝突
    // (2 台目は、先に競合の解決の結果を受け取ってから変える。受け取らずに変えると、2 台目のほうが競合で止まる)
    await tools.syncOnce({ file: fileB, server: server.url, token });
    fs.writeFileSync(fileB, tools.toJSON(tools.updateBlock(tools.fromJSON(fs.readFileSync(fileB, 'utf8')), block.blockId, { title: '衝突中に届いた題名' })) + '\n');
    await tools.syncOnce({ file: fileB, server: server.url, token });
    await frame2.evaluate(() => window.boxglow.store.getState().syncAct({ kind: 'syncNow' }));
    let conflicted = false;
    for (let i = 0; i < 60 && !conflicted; i++) { conflicted = await frame2.evaluate(() => window.boxglow.store.getState().conflict !== null); if (!conflicted) await win.waitForTimeout(250); }
    if (!conflicted) console.log('debug:', JSON.stringify({ disk: JSON.parse(fs.readFileSync(fileA, 'utf8')).blocks[block.blockId].title, sync: await frame2.evaluate(() => { const s = window.boxglow.store.getState(); return { state: s.syncStatus?.state, msg: s.syncStatus?.message, saveError: s.saveError, behind: !!s.editorBehind, title: s.project.blocks[Object.keys(s.project.blocks).at(-1)].title }; }), frames: win.frames().length }));
    check('VS Code: エディタが dirty のまま受け取ると、保存の衝突の帯が出る', conflicted);
    const button2 = (ja) => frame2.getByRole('button', { name: new RegExp(`^(${ja}|${NAMES[ja]})$`) });
    // (同期の欄が開いていると帯に重なるので、閉じておく)
    if (await frame2.locator('.sync-panel').isVisible().catch(() => false)) await frame2.locator('.sync-chip').click();
    // (エディタに未保存の編集があるときは、帯で統合・置き換えをさせない。退避だけ。R49-01 / R49-02)
    check('VS Code: この衝突では「両方の変更を統合」「最新のファイルを開く」を出さない', (await button2('両方の変更を統合').count()) === 0 && (await button2('手元を退避して最新のファイルを開く').count()) === 0);
    // 退避の保存先の選択をやめる → 何も変わらない
    await button2('手元の編集を退避').click();
    await win.locator('.quick-input-widget input').waitFor({ timeout: 10000 });
    await win.waitForTimeout(500);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(1500);
    const afterCancel = await frame2.evaluate(() => { const s = window.boxglow.store.getState(); return { conflict: s.conflict !== null, name: s.project.name, evacuated: s.evacuated }; });
    check('VS Code: 退避をやめると、衝突も図の編集もそのまま', afterCancel.conflict && afterCancel.name.endsWith('_EDITOR') && afterCancel.evacuated === null, JSON.stringify(afterCancel));
    // 退避する (示された場所のまま保存) → 帯に「退避済み」と開き直しの案内。画面もエディタもそのまま
    const copiesBefore = fs.readdirSync(work).filter((f) => f.includes('.unsaved-'));
    await button2('手元の編集を退避').click();
    await win.locator('.quick-input-widget input').waitFor({ timeout: 10000 });
    await win.waitForTimeout(500);
    await win.keyboard.press('Enter');
    let saved = false;
    for (let i = 0; i < 40 && !saved; i++) { saved = /\.unsaved-/.test((await frame2.locator('.save-notice').first().textContent().catch(() => '')) ?? ''); if (!saved) await win.waitForTimeout(250); }
    const afterCopy = await frame2.evaluate(() => { const s = window.boxglow.store.getState(); return { conflict: s.conflict !== null, name: s.project.name }; });
    check('VS Code: 退避すると、帯に退避済みと開き直しの案内が出る (画面は変えない)', saved && afterCopy.conflict && afterCopy.name.endsWith('_EDITOR'), JSON.stringify(afterCopy));
    const copies = fs.readdirSync(work).filter((f) => f.includes('.unsaved-') && !copiesBefore.includes(f));
    const copy = copies.length === 1 ? JSON.parse(fs.readFileSync(path.join(work, copies[0]), 'utf8')) : null;
    check('VS Code: 退避のファイルに、図の編集・保存済みの基準・受け取った中身が入る', !!copy && copy.boxglowRecovery === 1 && JSON.parse(copy.gui.text).name.endsWith('_EDITOR') && !!copy.base && !JSON.parse(copy.base).name.endsWith('_EDITOR') && JSON.parse(copy.received).blocks[block.blockId].title === '衝突中に届いた題名', copies.join(','));
    check('VS Code: ディスクは受け取った中身のまま (退避で上書きしない)', JSON.parse(fs.readFileSync(fileA, 'utf8')).blocks[block.blockId].title === '衝突中に届いた題名');
    // タブを全部閉じる (保存しない) → 開き直す
    await command('Control+Alt+Shift+3');
    const dontSave = win.getByRole('button', { name: /^(Don't Save|保存しない)$/ });
    await dontSave.waitFor({ timeout: 10000 });
    await dontSave.click();
    await win.waitForTimeout(1000);
    await win.getByRole('treeitem', { name: /boxglow\.json/ }).first().click();
    await win.waitForTimeout(1500);
    const frame3 = await findFrame();
    const reopened = frame3 ? await frame3.evaluate((id) => { const s = window.boxglow.store.getState(); return { name: s.project?.name, title: s.project?.blocks[id]?.title, conflict: s.conflict !== null }; }, block.blockId) : null;
    check('VS Code: 開き直すと、受け取った中身になる (エディタの編集は外れる)', !!reopened && !reopened.name.endsWith('_EDITOR') && reopened.title === '衝突中に届いた題名' && !reopened.conflict, JSON.stringify(reopened));
    if (!frame3) throw new Error('開き直した webview が見つからない');
    // ⋯ メニューの「退避した編集を読み込む」→ 取り込み → Save → 同期 (同期の欄を使わない入口。R49-03)
    await frame3.locator('button[title="Menu"]').click();
    await frame3.getByRole('button', { name: /^(退避した編集を読み込む|Load saved edits)$/ }).click();
    const input = win.locator('.quick-input-widget input');
    await input.waitFor({ timeout: 10000 });
    await input.fill(path.join(work, copies[0] ?? 'missing.json'));
    await win.waitForTimeout(500);
    await win.keyboard.press('Enter');
    const nameOf3 = () => frame3.evaluate(() => window.boxglow.store.getState().project.name);
    let restored = false;
    for (let i = 0; i < 40 && !restored; i++) { restored = (await nameOf3()).endsWith('_EDITOR'); if (!restored) await win.waitForTimeout(250); }
    const merged = await frame3.evaluate((id) => { const s = window.boxglow.store.getState(); return { name: s.project.name, title: s.project.blocks[id].title, held: s.saveHeld, pending: s.restorePending !== null, step: s.restorePending?.step, conflicts: s.restorePending?.conflicts.map((c) => ({ path: c.path, current: c.current, saved: c.saved })) }; }, block.blockId);
    check('VS Code: 取り込むと、退避した編集と届いた題名の両方が入り、自動保存は止まる', restored && merged.title === '衝突中に届いた題名' && merged.held && !merged.pending, JSON.stringify(merged));
    const frame2b = frame3;
    await frame2b.evaluate(() => window.boxglow.store.getState().saveNow());
    await frame2b.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved', null, { timeout: 15000 });
    await frame2b.evaluate(() => window.boxglow.store.getState().syncAct({ kind: 'syncNow' }));
    let pushed = false;
    for (let i = 0; i < 60 && !pushed; i++) { const head = JSON.parse(server.project(remoteId, 'acc-vscode').head.text); pushed = head.name.endsWith('_EDITOR') && head.blocks[block.blockId].title === '衝突中に届いた題名'; if (!pushed) await win.waitForTimeout(250); }
    check('VS Code: Save と同期で、サーバーに両方の変更が届く', pushed);
    // サインアウト (開き直した画面から)
    if (!(await frame3.locator('.sync-panel').isVisible().catch(() => false))) await frame3.locator('.sync-chip').click();
    await frame3.locator('.sync-panel__details > summary').click();
    await frame3.getByRole('button', { name: /^(サインアウト|Sign out)$/ }).click();
    let signedOut = false;
    try { await frame3.waitForFunction(() => document.querySelector('.sync-chip')?.getAttribute('data-state') === 'signed-out', null, { timeout: 20000 }); signedOut = true; } catch { signedOut = false; }
    check('VS Code: サインアウトで「未サインイン」', signedOut);
    check('VS Code: トークンがサーバー側で取り消される', server.revoked.has(token));
    const shot = path.join(process.env.BOXGLOW_E2E_SHOTS || path.join(os.tmpdir(), 'boxglow-e2e-shots'), 'vscode-sync.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await win.screenshot({ path: shot });
  } catch (e) {
    check('VS Code: 検査が最後まで動く', false, String(e && e.stack || e).slice(0, 1500));
    // (手がかりの画面)
    try { const dir = process.env.BOXGLOW_E2E_SHOTS || path.join(os.tmpdir(), 'boxglow-e2e-shots'); fs.mkdirSync(dir, { recursive: true }); await (await app.firstWindow()).screenshot({ path: path.join(dir, 'vscode-sync-failed.png') }); } catch { /* 画面が取れなくても、結果は出す */ }
  } finally {
    await app?.close().catch(() => {});
    await server?.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { passed, failed } = result();
  console.log(`${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
