/** 段階B再レビュー: 削除側を選んでも保護される追加を、実際の比較画面と保存要求で確かめる。 */
const fs = require('fs');
const path = require('path');
const { chromium, ROOT, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    for (const lang of ['ja', 'en']) {
      const { page, errors } = await open(browser, { vscode: true, query: '?lang=' + lang, lang });
      await page.setViewportSize({ width: 1280, height: 900 });
      const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/notes-app/boxglow.json'), 'utf8'));
      const project = Object.values(sample.blocks).find(b => b.kind === 'project');
      const template = Object.values(sample.blocks).find(b => b.kind !== 'project' && b.id !== 'root');
      const box = (id, parentId, title, key) => ({ ...template, id, parentId, title, key, description: '', assigneeIds: [], artifacts: [], decisions: [], activity: null, position: { x: 80, y: 80 } });
      const base = { ...sample, name: '削除と追加の比較', blocks: {
        root: sample.blocks.root, [project.id]: project,
        P: box('P', project.id, '公開準備', 'B700'), C: box('C', 'P', '既存の確認作業', 'B701'),
      }, ports: {}, edges: {}, handoffs: {}, log: [] };
      delete base.focusBlockId;
      const local = structuredClone(base), remote = structuredClone(base);
      local.blocks.C.title = '更新した確認作業';
      local.blocks.N = box('N', 'P', '追加した検証', 'B702');
      delete remote.blocks.P; delete remote.blocks.C;
      await page.evaluate(text => window.postMessage({ type: 'load', text, version: 1, name: 'boxglow.json' }, '*'), JSON.stringify(base));
      await page.waitForFunction(() => window.boxglow.store.getState().source === 'vscode');
      await page.evaluate(([local, remote]) => {
        window.boxglow.store.getState().apply(() => local);
        window.postMessage({ type: 'update', text: JSON.stringify(remote), version: 2 }, '*');
      }, [local, remote]);
      await page.getByRole('button', { name: /変更を比較して選ぶ|Compare and choose/ }).click();
      const dialog = page.getByRole('dialog');
      const text = await dialog.innerText();
      check(`${lang}: 実結果の削除数1を表示`, lang === 'ja' ? text.includes('相手側をグループ全体に採用すると削除: 1 ボックス') : text.includes('entire group deletes 1 blocks'));
      const retained = dialog.locator('.conflict-group__warning').filter({ hasText: /追加保護|protect additions/ });
      check(`${lang}: 残る親と追加を名前で表示`, (await retained.innerText()).includes('公開準備') && (await retained.innerText()).includes('追加した検証'));
      await dialog.locator('.conflict-group__picks input').last().check();
      if (process.env.BOXGLOW_B_SCREENSHOTS) {
        fs.mkdirSync(process.env.BOXGLOW_B_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'deletion-impact-' + lang + '.png') });
      }
      await dialog.getByRole('button', { name: /^(選択した内容で統合|Merge selected values)$/ }).click();
      await page.waitForFunction(() => window.__posted.some(m => m.type === 'save'));
      const saved = await page.evaluate(() => window.__posted.find(m => m.type === 'save'));
      const merged = JSON.parse(saved.text);
      check(`${lang}: 表示どおり子1つを削除し、親と追加を残す`, !merged.blocks.C && !!merged.blocks.P && !!merged.blocks.N);
      check(`${lang}: 実行エラーなし`, errors.length === 0, errors.join(';'));
      await page.evaluate(requestId => window.postMessage({ type: 'saved', requestId, version: 3 }, '*'), saved.requestId);
      await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
      await page.evaluate(() => window.boxglow.store.getState().openFromVsCode());
      // B3: 内部のカテゴリキーや真偽値ではなく、両言語の人向けラベルで比べる。
      const labelBase = structuredClone(base);
      delete labelBase.blocks.P.collapsed;
      labelBase.blocks.P.category = 'other';
      labelBase.blocks.P.status = 'black';
      const labelLocal = structuredClone(labelBase), labelRemote = structuredClone(labelBase);
      Object.assign(labelLocal.blocks.P, { category: 'design', collapsed: true, status: 'gray' });
      Object.assign(labelRemote.blocks.P, { category: 'build', collapsed: false, status: 'white' });
      await page.evaluate(text => window.postMessage({ type: 'load', text, version: 10, name: 'boxglow.json' }, '*'), JSON.stringify(labelBase));
      await page.waitForTimeout(100);
      await page.evaluate(([local, remote]) => {
        window.boxglow.store.getState().apply(() => local);
        window.postMessage({ type: 'update', text: JSON.stringify(remote), version: 11 }, '*');
      }, [labelLocal, labelRemote]);
      await page.getByRole('button', { name: /変更を比較して選ぶ|Compare and choose/ }).click();
      const labelText = await dialog.innerText();
      check(`${lang}: カテゴリを人向けの語で表示`, lang === 'ja' ? labelText.includes('設計') && labelText.includes('実装') : /design/i.test(labelText) && /build/i.test(labelText));
      check(`${lang}: 折りたたみを人向けの語で表示`, lang === 'ja' ? labelText.includes('折りたたみ済み') && labelText.includes('展開済み') : labelText.includes('Collapsed') && labelText.includes('Expanded'));
      check(`${lang}: 状態を人向けの語で表示`, lang === 'ja' ? labelText.includes('作業中') && labelText.includes('完了') : labelText.includes('Working') && labelText.includes('Done'));
      if (process.env.BOXGLOW_B_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'comparison-labels-' + lang + '.png') });
      await page.keyboard.press('Escape');
      // 前の未保存の比較を引き継がず、新しいVS Code文書として試験を始める。
      await page.evaluate(() => { window.boxglow.store.setState({ source: 'idb', project: null, saveState: 'none' }); window.boxglow.store.getState().openFromVsCode(); });
      const memberBase = structuredClone(base);
      memberBase.members = [{ id: 'member-m', name: 'Member M', color: '#0f766e' }];
      const memberLocal = structuredClone(memberBase), memberRemote = structuredClone(memberBase);
      memberLocal.members = []; memberLocal.blocks.P.title = '手元の公開準備';
      memberRemote.members[0].name = 'Member M updated'; memberRemote.blocks.P.title = '相手の公開準備';
      memberRemote.blocks.P.assigneeIds = ['member-m'];
      await page.evaluate(text => { window.__posted.length = 0; window.postMessage({ type: 'load', text, version: 20, name: 'boxglow.json' }, '*'); }, JSON.stringify(memberBase));
      await page.waitForTimeout(100);
      await page.evaluate(([local, remote]) => {
        window.boxglow.store.getState().apply(() => local);
        window.postMessage({ type: 'update', text: JSON.stringify(remote), version: 21 }, '*');
      }, [memberLocal, memberRemote]);
      await page.getByRole('button', { name: /変更を比較して選ぶ|Compare and choose/ }).click();
      const warning = dialog.locator('.conflict-group__warning').filter({ hasText: /担当が外れる|remove assignments/ });
      check(`${lang}: 担当解除の上限1を比較に表示`, (await warning.innerText()).includes('1'));
      const settings = dialog.locator('.conflict-group').filter({ has: page.locator('legend').filter({ hasText: /計画の設定|Project settings/ }) });
      const task = dialog.locator('.conflict-group').filter({ has: page.locator('legend').filter({ hasText: 'B700' }) });
      await settings.locator('.conflict-group__picks input').first().check();
      await task.locator('.conflict-group__picks input').last().check();
      if (process.env.BOXGLOW_B_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'assignment-removal-' + lang + '.png') });
      await dialog.getByRole('button', { name: /^(選択した内容で統合|Merge selected values)$/ }).click();
      await page.waitForFunction(() => window.__posted.some(m => m.type === 'save'));
      const memberSaved = await page.evaluate(() => window.__posted.find(m => m.type === 'save'));
      const memberResult = JSON.parse(memberSaved.text);
      check(`${lang}: 設定は削除、ボックスは相手を残す`, memberResult.members.length === 0 && memberResult.blocks.P.title === '相手の公開準備' && memberResult.blocks.P.assigneeIds.length === 0);
      check(`${lang}: 保存する計画に担当解除ログ`, memberResult.log.some(e => e.id.startsWith('merge:unassign:') && e.message.includes('Member M') && e.message.includes('相手の公開準備')));
      await page.evaluate(requestId => window.postMessage({ type: 'saved', requestId, version: 22 }, '*'), memberSaved.requestId);
      await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
      check(`${lang}: 担当解除後も実行エラーなし`, errors.length === 0, errors.join(';'));
      // B5: 保存済みの作成を外部が改名/配線した後では、Undoを止め、保存もしない。
      for (const [index, mode] of ['rename', 'wire', 'position', 'assignment', 'input-group'].entries()) {
        const version = 30 + index * 10;
        await page.evaluate(() => { window.boxglow.store.setState({ source: 'idb', project: null, saveState: 'none' }); window.boxglow.store.getState().openFromVsCode(); });
        const caseBase = structuredClone(base);
        if (mode === 'input-group') caseBase.ports.gi = { id: 'gi', blockId: 'root', direction: 'in', name: '入力', description: '', required: true, artifacts: [] };
        const own = structuredClone(caseBase);
        if (mode === 'position') own.blocks.P.position.x += 500;
        else if (mode === 'assignment') {
          own.members = [{id:'m1',name:'M1',color:'red'}, {id:'m2',name:'M2',color:'blue'}]; own.blocks.P.assigneeIds = ['m1'];
        } else if (mode === 'input-group') own.inputGroups = [{id:'g',name:'G',description:'',position:{x:0,y:0}}];
        else {
          own.blocks.N = box('N', 'P', '作成したボックス', 'B702');
          own.ports.no = { id: 'no', blockId: 'N', direction: 'out', name: '成果物', description: '', required: true, artifacts: [] };
        }
        await page.evaluate(([text, version]) => { window.__posted.length = 0; window.postMessage({ type: 'load', text, version, name: 'boxglow.json' }, '*'); }, [JSON.stringify(caseBase), version]);
        await page.waitForTimeout(100);
        await page.evaluate(own => window.boxglow.store.getState().apply(() => own), own);
        await page.waitForFunction(() => window.__posted.some(m => m.type === 'save'));
        const ownSave = await page.evaluate(() => window.__posted.find(m => m.type === 'save'));
        await page.evaluate(([requestId, version]) => window.postMessage({ type: 'saved', requestId, version }, '*'), [ownSave.requestId, version + 1]);
        await page.waitForFunction(() => window.boxglow.store.getState().saveState === 'saved');
        const theirs = JSON.parse(ownSave.text);
        if (mode === 'rename') theirs.blocks.N.title = '相手が改名';
        else if (mode === 'position') theirs.blocks.P.position.y += 300;
        else if (mode === 'assignment') theirs.blocks.P.assigneeIds.push('m2');
        else if (mode === 'input-group') theirs.ports.gi.groupId = 'g';
        else {
          theirs.ports.co = { id: 'co', blockId: 'C', direction: 'out', name: '確認', description: '', required: true, artifacts: [] };
          theirs.ports.ni = { id: 'ni', blockId: 'N', direction: 'in', name: '確認', description: '', required: true, artifacts: [] };
          theirs.edges.cn = { id: 'cn', kind: 'sibling', auto: false, from: { portId: 'co', side: 'outer' }, to: { portId: 'ni', side: 'outer' } };
        }
        await page.evaluate(([text, version]) => window.postMessage({ type: 'update', text, version }, '*'), [JSON.stringify(theirs), version + 2]);
        await page.waitForTimeout(100);
        await page.evaluate(() => { window.__posted.length = 0; window.boxglow.store.getState().undo(); });
        const notice = page.locator('.toast');
        await notice.waitFor({ state: 'visible' });
        const noticeText = await notice.innerText();
        check(`${lang}: ${mode} Undo通知`, mode === 'position' ? /一部は相手|Some changes/.test(noticeText) : /これより前には戻せません|Cannot undo/.test(noticeText));
        const kept = await page.evaluate(() => window.boxglow.store.getState().project);
        check(`${lang}: ${mode} 相手の変更と構造を保持`, mode === 'position'
          ? kept.blocks.P.position.x === theirs.blocks.P.position.x && kept.blocks.P.position.y === theirs.blocks.P.position.y
          : mode === 'assignment' ? JSON.stringify(kept.members) === JSON.stringify(theirs.members) && JSON.stringify(kept.blocks.P.assigneeIds) === JSON.stringify(theirs.blocks.P.assigneeIds)
          : mode === 'input-group' ? JSON.stringify(kept.inputGroups) === JSON.stringify(theirs.inputGroups) && kept.ports.gi.groupId === 'g'
          : kept.blocks.N.title === theirs.blocks.N.title && JSON.stringify(kept.ports) === JSON.stringify(theirs.ports) && JSON.stringify(kept.edges) === JSON.stringify(theirs.edges));
        if (process.env.BOXGLOW_B_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'undo-' + mode + '-' + lang + '.png') });
        await page.waitForTimeout(800);
        if (mode !== 'position') check(`${lang}: ${mode} 拒否したUndoを保存しない`, await page.evaluate(() => !window.__posted.some(m => m.type === 'save')));
      }
      check(`${lang}: Undo確認後も実行エラーなし`, errors.length === 0, errors.join(';'));
      await page.context().close();
    }
  } finally { await browser.close(); }
  const r = result(); console.log(`${r.passed}/${r.passed + r.failed} passed`);
  process.exitCode = r.failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
