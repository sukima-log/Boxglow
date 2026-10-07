/**
 * 保存の信頼性の検査 (VS Code の webview を模して確かめる): 保存の応答が来るまでは「保存中」のままであること、
 * 保存の失敗が画面に出て編集が残ること、保存中に重ねた編集が失われないこと。
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const fs = require('fs');
const path = require('path');
const { chromium, ROOT, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    const {page} = await open(browser,{vscode:true,lang:'en'});
    const original = fs.readFileSync(path.join(ROOT,'examples/notes-app/boxglow.json'),'utf8');
    await page.evaluate(text => window.postMessage({type:'load',text,version:1,name:'boxglow.json'},'*'),original);
    await page.waitForFunction(() => window.boxglow.store.getState().source==='vscode');
    const edit = text => page.evaluate(text => window.boxglow.store.getState().apply(p=>({...p,description:text})),text);
    const nextSave = async n => { await page.waitForFunction(n => window.__posted.filter(m=>m.type==='save').length>=n,n); return page.evaluate(n => window.__posted.filter(m=>m.type==='save')[n-1],n); };
    const reply = m => page.evaluate(m=>window.postMessage(m,'*'),m);
    const state = () => page.evaluate(()=>{const s=window.boxglow.store.getState();return {save:s.saveState,error:s.saveError,conflict:!!s.conflict,description:s.project.description,name:s.project.name};});
    await edit('First edit'); const first=await nextSave(1);
    check('Save: remains Saving until acknowledgement', (await state()).save==='saving');
    await edit('Newer edit during save');
    await reply({type:'saved',requestId:first.requestId,version:2}); const second=await nextSave(2);
    check('Save: old acknowledgement cannot label newer edit Saved', (await state()).save==='saving' && second.text.includes('Newer edit during save'));
    await reply({type:'saved',requestId:'unrelated',version:999});
    check('Save: ignores unrelated acknowledgement', (await state()).save==='saving');
    await reply({type:'save-error',requestId:second.requestId,error:'Disk full'});
    await page.getByRole('button',{name:'Retry saving',exact:true}).waitFor();
    check('Save: failure retains edits and persistent error', (await state()).save==='unsaved' && (await state()).description==='Newer edit during save');
    check('Save: export recovery is visible',await page.getByRole('button',{name:'Export unsaved edits as JSON'}).isVisible());
    check('Save: recovery banner does not overlap canvas',await page.evaluate(()=>document.querySelector('.save-notice').getBoundingClientRect().bottom<=document.querySelector('.app-main').getBoundingClientRect().top+1));
    await page.getByRole('button',{name:'Retry saving',exact:true}).click(); const third=await nextSave(3);
    await reply({type:'saved',requestId:third.requestId,version:3});
    await page.waitForFunction(()=>window.boxglow.store.getState().saveState==='saved');
    check('Save: retry clears error only after success', !(await state()).error);
    const external=JSON.parse(third.text);external.name='CLI changed title';
    await edit('Local unsaved handoff');
    await reply({type:'update',text:JSON.stringify(external),version:4});
    const fourth=await nextSave(4);
    check('Conflict: independent changes merge without confirmation', !(await state()).conflict && (await state()).description==='Local unsaved handoff');
    check('Conflict: automatic merge keeps both sides and uses the latest CAS version',fourth.text.includes('CLI changed title') && fourth.text.includes('Local unsaved handoff') && fourth.version===4 && fourth.baseText===JSON.stringify(external));
    await reply({type:'saved',requestId:fourth.requestId,version:5});
    await page.waitForFunction(()=>window.boxglow.store.getState().saveState==='saved');
    await edit('Timeout must retain me');await nextSave(5);
    await page.waitForFunction(()=>!!window.boxglow.store.getState().saveError,null,{timeout:15000});
    check('Save: missing acknowledgement times out to Unsaved', (await state()).save==='unsaved' && (await state()).description==='Timeout must retain me');
    // A late ACK must not clear the error after the request timed out.
    const fifth=await nextSave(5);await reply({type:'saved',requestId:fifth.requestId,version:6});
    check('Save: late acknowledgement cannot clear timeout', (await state()).save==='unsaved');
    await page.context().close();

    // ---- 手動の更新 (Reload) ----
    {
      const {page} = await open(browser,{vscode:true,lang:'en'});
      await page.evaluate(text => window.postMessage({type:'load',text,version:1,name:'boxglow.json'},'*'),original);
      await page.waitForFunction(() => window.boxglow.store.getState().source==='vscode');
      const reply = m => page.evaluate(m=>window.postMessage(m,'*'),m);
      const readies = () => page.evaluate(()=>window.__posted.filter(m=>m.type==='ready').length);
      const toast = () => page.evaluate(()=>window.boxglow.store.getState().toast);
      const description = () => page.evaluate(()=>window.boxglow.store.getState().project.description);
      const withDescription = text => { const p = JSON.parse(original); p.description = text; return JSON.stringify(p, null, 2) + '\n'; };
      const button = page.getByRole('button',{name:'Reload',exact:true});
      check('Reload: button is shown for a plan connected to a file', await button.isVisible());
      // 押すと、拡張へ読み直しを頼む。新しい中身が届いたら、画面に反映する
      const before = await readies();
      await button.click();
      await page.waitForFunction(n => window.__posted.filter(m=>m.type==='ready').length>n, before);
      check('Reload: asks the host for the current file', (await readies())===before+1);
      check('Reload: button is disabled while waiting', await button.isDisabled());
      await reply({type:'load',text:withDescription('Changed outside'),version:2,name:'boxglow.json'});
      await page.waitForFunction(()=>!window.boxglow.store.getState().reloading);
      check('Reload: shows the latest content', (await description())==='Changed outside' && (await toast())==='Loaded the latest content');
      // 変わっていなければ、そう伝える
      await button.click();
      await reply({type:'load',text:withDescription('Changed outside'),version:2,name:'boxglow.json'});
      await page.waitForFunction(()=>!window.boxglow.store.getState().reloading);
      check('Reload: says so when nothing changed', (await toast())==='Up to date (nothing has changed)');
      // 応答が無ければ、失敗として伝える (押せる状態に戻る)
      await button.click();
      await page.waitForFunction(()=>!window.boxglow.store.getState().reloading,null,{timeout:8000});
      check('Reload: reports a missing response and can be pressed again', String(await toast()).startsWith('Could not load the latest content') && !(await button.isDisabled()));
      // 未保存の編集があるときは、上書きせずに、競合として両方を残す
      await page.evaluate(()=>window.boxglow.store.getState().apply(p=>({...p,description:'My unsaved edit'})));
      await button.click();
      await reply({type:'load',text:withDescription('Changed outside again'),version:3,name:'boxglow.json'});
      await page.waitForFunction(()=>!window.boxglow.store.getState().reloading);
      const s = await page.evaluate(()=>{const s=window.boxglow.store.getState();return {conflict:!!s.conflict,description:s.project.description};});
      check('Reload: unsaved edits are kept as a conflict, not overwritten', s.conflict && s.description==='My unsaved edit');
      await page.context().close();
    }
    {
      // ボタンは、どの計画でも、いつも出ている (サンプルでも、ブラウザ内の計画でも)
      const {page} = await open(browser,{lang:'en',query:'?demo=1'});
      await page.waitForFunction(() => !!window.boxglow.store.getState().project);
      const button = page.getByRole('button',{name:'Reload',exact:true});
      check('Reload: always shown, also for the sample', await button.isVisible());
      await button.click();
      await page.waitForFunction(()=>!window.boxglow.store.getState().reloading && !!window.boxglow.store.getState().toast);
      check('Reload: the sample stays as it is', (await page.evaluate(()=>window.boxglow.store.getState().toast))==='Up to date (nothing has changed)');
      // ブラウザ内の計画: このブラウザの保存先から読み直す (別のタブで変えた内容を取り込む)
      await page.evaluate(()=>window.boxglow.store.getState().copyToMine());
      await page.waitForFunction(()=>{const s=window.boxglow.store.getState();return s.source==='idb' && !s.ephemeral && s.saveState==='saved';});
      check('Reload: shown for a plan kept in the browser', await button.isVisible());
      const id = await page.evaluate(()=>window.boxglow.store.getState().project.id);
      const other = await page.context().newPage();
      await other.goto(page.url().split('?')[0].split('#')[0] + '#p=' + id);
      await other.waitForFunction(() => window.boxglow?.store.getState().project && !window.boxglow.store.getState().ephemeral);
      await other.evaluate(()=>{const s=window.boxglow.store.getState(); s.apply(p=>({...p,description:'Edited in another tab'})); s.saveNow();});
      await other.waitForFunction(()=>window.boxglow.store.getState().saveState==='saved');
      await button.click();
      await page.waitForFunction(()=>!window.boxglow.store.getState().reloading);
      check('Reload: picks up a change saved from another tab', (await page.evaluate(()=>window.boxglow.store.getState().project.description))==='Edited in another tab');
      await page.context().close();
    }
    // ---- VS Code の中: 空のファイル・読めないファイル・届かない場合の案内 ----
    {
      // 空のファイル: 名前を付けると、そのファイルに計画を作る (ブラウザ向けの案内は出ない)
      const {page} = await open(browser,{vscode:true,lang:'en'});
      await page.evaluate(() => window.postMessage({type:'load',text:'\n',version:1,name:'boxglow.json'},'*'));
      await page.getByRole('heading',{name:'This file is still empty'}).waitFor();
      const body = await page.locator('.home-dialog').innerText();
      check('VS Code empty file: asks for a name for this file', body.includes('boxglow.json') && await page.getByPlaceholder('New project name').isVisible());
      check('VS Code: no browser-only guidance (sample, browser plans, serve)', !/browser|Try the sample|serve|Copy and edit/i.test(body), body.slice(0,200));
      check('VS Code empty file: Create is disabled until a name is given', await page.getByRole('button',{name:'Create',exact:true}).isDisabled());
      await page.getByPlaceholder('New project name').fill('My new plan');
      await page.getByRole('button',{name:'Create',exact:true}).click();
      await page.waitForFunction(() => window.__posted.some(m=>m.type==='save'));
      const save = await page.evaluate(() => window.__posted.find(m=>m.type==='save'));
      const st = () => page.evaluate(()=>{const s=window.boxglow.store.getState();return {source:s.source,save:s.saveState,name:s.project&&s.project.name,file:s.fileName,edit:s.editMode};});
      check('VS Code empty file: the new plan is saved to the file (based on the empty content)', save.baseText==='\n' && save.version===1 && JSON.parse(save.text).name==='My new plan');
      check('VS Code empty file: not Saved until the host acknowledges', (await st()).save==='saving' && (await st()).source==='vscode');
      await page.evaluate(m=>window.postMessage(m,'*'),{type:'saved',requestId:save.requestId,version:2});
      await page.waitForFunction(()=>window.boxglow.store.getState().saveState==='saved');
      const done = await st();
      check('VS Code empty file: opens the plan connected to the file', done.source==='vscode' && done.name==='My new plan' && done.file==='boxglow.json' && done.edit===true);
      check('VS Code: the save chip names the file, not the browser', (await page.locator('.save-chip').innerText()).includes('boxglow.json'));
      check('VS Code: no Home button (the editor is bound to one file)', (await page.getByRole('button',{name:'Home',exact:true}).count())===0);
      await page.context().close();
    }
    {
      // 計画として読めない中身: 理由を出す。後から正しい中身が届いたら、開く
      const {page} = await open(browser,{vscode:true,lang:'en'});
      await page.evaluate(() => window.postMessage({type:'load',text:'{ "not": "a plan"',version:1,name:'boxglow.json'},'*'));
      await page.getByRole('heading',{name:'This file cannot be read as a Boxglow plan'}).waitFor();
      const note = page.locator('.home-vscode__note');
      const box = await note.evaluate(e=>({clipped:e.scrollWidth>e.clientWidth+1||e.scrollHeight>e.clientHeight+1,inside:e.getBoundingClientRect().right<=innerWidth}));
      check('VS Code invalid file: the reason is fully visible (not clipped)', (await note.isVisible()) && !box.clipped && box.inside);
      check('VS Code invalid file: no name input, no browser guidance', (await page.getByPlaceholder('New project name').count())===0 && !/Try the sample|Copy and edit/.test(await page.locator('.home-dialog').innerText()));
      await page.evaluate(text => window.postMessage({type:'update',text,version:2,name:'boxglow.json'},'*'),original);
      await page.waitForFunction(() => window.boxglow.store.getState().source==='vscode');
      check('VS Code invalid file: opens once valid content arrives', true);
      await page.context().close();
    }
    {
      // 拡張から何も届かない: 4 秒後に、その旨を出す (見切れない)
      const {page} = await open(browser,{vscode:true,lang:'en'});
      check('VS Code: shows loading while waiting for the host', (await page.locator('.home-dialog').innerText()).includes('Loading the file'));
      await page.getByRole('heading',{name:'The file content has not arrived from VS Code'}).waitFor({timeout:8000});
      const fits = await page.locator('.home-vscode').evaluate(e=>[...e.querySelectorAll('h2,p')].every(x=>x.scrollWidth<=x.clientWidth+1&&x.getBoundingClientRect().right<=innerWidth));
      check('VS Code timeout: the message is fully visible', fits);
      const before = await page.evaluate(()=>window.__posted.filter(m=>m.type==='ready').length);
      await page.getByRole('button',{name:'Load again',exact:true}).click();
      await page.waitForFunction(n=>window.__posted.filter(m=>m.type==='ready').length>n,before);
      check('VS Code timeout: Load again asks the host again', true);
      await page.context().close();
    }
  } finally { await browser.close(); }
  const {passed,failed}=result();console.log(`${passed}/${passed+failed} passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
