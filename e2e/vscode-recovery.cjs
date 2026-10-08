/**
 * 実際の VS Code (Linux。WSLg の画面) で、同期サーバーを設定していないときにも、退避と退避したファイルの取り込みが使えることを確かめる (R49-03)
 * 退避は保存の衝突の帯から使う (同期を使わない人にも出る)。取り込みは ⋯ メニューから
 * 前提・使い方は e2e/vscode-sync.cjs と同じ (node e2e/vscode-recovery.cjs。先に env -u VITE_BASE npm run build:vscode)
 */
const { check, result } = require('./lib.cjs');
const { _electron } = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const CODE = process.env.BOXGLOW_E2E_VSCODE || path.join(os.homedir(), '.cache', 'boxglow-e2e', 'vscode-linux', 'VSCode-linux-x64', 'code');

(async () => {
  // (実機の検査を必須にするときは BOXGLOW_E2E_REQUIRE_VSCODE=1。無ければ失敗にする)
  if (!fs.existsSync(CODE)) {
    if (process.env.BOXGLOW_E2E_REQUIRE_VSCODE === '1') { console.log('NG  VS Code の Linux 版がありません (必須): ' + CODE); process.exit(1); }
    console.log('SKIP VS Code の Linux 版がありません: ' + CODE); process.exit(0);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boxglow-e2e-vscode-rec-'));
  let app = null;
  try {
    // ---- 計画を作る (道具は同期の検査と同じものを使う) ----
    const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
    await esbuild.build({ bundle: true, platform: 'node', format: 'esm', target: 'node18', loader: { '.md': 'text' }, logLevel: 'silent'
    , entryPoints: [path.join(__dirname, 'sync', 'entry-tools.ts')], outfile: path.join(tmp, 'tools.mjs') });
    const tools = await import(path.join(tmp, 'tools.mjs'));
    let p = tools.createProject('退避の検査 (同期なし)');
    p.lang = 'ja';
    const block = tools.addBlock(p, { parentId: tools.defaultTaskParent(p), title: 'A' }); p = block.project;
    const work = path.join(tmp, 'work'); fs.mkdirSync(work);
    const file = path.join(work, 'boxglow.json');
    const L = tools.toJSON(p) + '\n';
    fs.writeFileSync(file, L);
    // ---- VS Code の専用の設定: 同期サーバーは設定しない (既定の空) ----
    const ud = path.join(tmp, 'ud'); fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
    fs.writeFileSync(path.join(ud, 'User', 'settings.json'), JSON.stringify({
      'boxglow.sync.server': '', // 段階D: 未指定は製品既定。同期なしの試験は明示的に無効化する。
      'workbench.editorAssociations': { '**/boxglow.json': 'boxglow.editor' }
    , 'files.simpleDialog.enable': true
    , 'security.workspace.trust.enabled': false, 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'window.restoreWindows': 'none'
    }));
    app = await _electron.launch({
      executablePath: CODE
    , args: [work, file, '--user-data-dir', ud, '--extensions-dir', path.join(tmp, 'exts'), '--extensionDevelopmentPath', path.join(ROOT, 'vscode'), '--disable-workspace-trust', '--skip-release-notes', '--disable-gpu', '--no-sandbox']
    , env: (() => { const env = { ...process.env, BOXGLOW_CONFIG_DIR: path.join(tmp, 'config'), BOXGLOW_TOKEN: '' }; delete env.ELECTRON_RUN_AS_NODE; delete env.VSCODE_IPC_HOOK_CLI; return env; })()
    });
    const win = await app.firstWindow();
    console.log(`環境: VS Code ${await app.evaluate(({ app: a }) => a.getVersion()).catch(() => '?')} (Linux の拡張ホスト、同期サーバーなし)`);
    // (VS Code の最初の案内のダイアログを閉じ続ける)
    const skip = win.getByText('Continue without Signing In', { exact: true });
    const started = win.getByRole('button', { name: 'Get Started', exact: true });
    let watching = true;
    const dismiss = (async () => { while (watching) {
      if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
      if (await started.isVisible().catch(() => false)) await started.click().catch(() => {});
      await win.waitForTimeout(500).catch(() => {});
    } })();
    // Boxglow の webview の中の frame を探す (同期の印は無いので、計画の名前の欄で見分ける)
    let frame = null;
    for (let i = 0; i < 120 && !frame; i++) {
      for (const f of win.frames()) { try { if (await f.evaluate(() => !!window.boxglow?.store.getState().project)) { frame = f; break; } } catch { /* 読み込み中 */ } }
      if (!frame) await win.waitForTimeout(500);
    }
    check('VS Code (同期なし): Boxglow の図が開く', !!frame);
    if (!frame) throw new Error('webview が見つからない');
    await win.waitForTimeout(3000);
    watching = false; await dismiss;
    check('VS Code (同期なし): 同期の印は出ない', (await frame.locator('.sync-chip').count()) === 0);
    // 退避: 拡張が保存先を聞き、書けたら応答する (同期の設定が無くても。以前は応答が無く 120 秒待った)
    await frame.evaluate(() => { window.__evac = window.boxglow.store.getState().evacuate(); });
    await win.locator('.quick-input-widget input').waitFor({ timeout: 10000 });
    await win.waitForTimeout(500);
    await win.keyboard.press('Enter');
    const evacuated = await frame.evaluate(async () => { const ok = await window.__evac; return { ok, path: window.boxglow.store.getState().evacuated?.path ?? null }; });
    check('VS Code (同期なし): 退避の保存先を聞かれ、書ける', evacuated.ok && !!evacuated.path && fs.existsSync(evacuated.path), JSON.stringify(evacuated));
    // 取り込み: ⋯ メニューから (同期の欄が無くても)。退避のファイルは、検査で作る (基準 = 今のファイル、画面の編集 = 題名の変更)
    const copy = path.join(work, 'copy.json');
    const G = tools.toJSON(tools.updateBlock(tools.fromJSON(L), block.blockId, { title: '退避から戻した題名' }));
    fs.writeFileSync(copy, JSON.stringify({ boxglowRecovery: 1, base: L, received: null, gui: { text: G }, editor: null }));
    await frame.locator('button[title="Menu"]').click();
    await frame.getByRole('button', { name: /^(退避した編集を読み込む|Load saved edits)$/ }).click();
    const input = win.locator('.quick-input-widget input');
    await input.waitFor({ timeout: 10000 });
    await input.fill(copy);
    await win.waitForTimeout(500);
    await win.keyboard.press('Enter');
    let restored = false;
    for (let i = 0; i < 40 && !restored; i++) { restored = await frame.evaluate((id) => window.boxglow.store.getState().project.blocks[id].title === '退避から戻した題名', block.blockId); if (!restored) await win.waitForTimeout(250); }
    const held = await frame.evaluate(() => window.boxglow.store.getState().saveHeld);
    check('VS Code (同期なし): ⋯ メニューから退避のファイルを取り込め、Save まで自動保存しない', restored && held);
    await frame.evaluate(() => window.boxglow.store.getState().saveNow());
    let written = false;
    for (let i = 0; i < 40 && !written; i++) { written = JSON.parse(fs.readFileSync(file, 'utf8')).blocks[block.blockId].title === '退避から戻した題名'; if (!written) await win.waitForTimeout(250); }
    check('VS Code (同期なし): Save でファイルに書かれる', written);
  } catch (e) {
    check('VS Code (同期なし): 検査が最後まで動く', false, String(e && e.stack || e).slice(0, 1500));
    try { const dir = process.env.BOXGLOW_E2E_SHOTS || path.join(os.tmpdir(), 'boxglow-e2e-shots'); fs.mkdirSync(dir, { recursive: true }); await (await app.firstWindow()).screenshot({ path: path.join(dir, 'vscode-recovery-failed.png') }); } catch { /* 画面が取れなくても、結果は出す */ }
  } finally {
    await app?.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const { passed, failed } = result();
  console.log(`${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
