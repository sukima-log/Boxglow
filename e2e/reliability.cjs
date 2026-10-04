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
    await page.getByRole('button',{name:'Merge both versions',exact:true}).waitFor();
    check('Conflict: incoming update retains local edits', (await state()).conflict && (await state()).description==='Local unsaved handoff');
    await page.getByRole('button',{name:'Merge both versions',exact:true}).click();const fourth=await nextSave(4);
    check('Conflict: explicit merge keeps both sides',fourth.text.includes('CLI changed title') && fourth.text.includes('Local unsaved handoff'));
    await reply({type:'saved',requestId:fourth.requestId,version:5});
    await page.waitForFunction(()=>window.boxglow.store.getState().saveState==='saved');
    await edit('Timeout must retain me');await nextSave(5);
    await page.waitForFunction(()=>!!window.boxglow.store.getState().saveError,null,{timeout:15000});
    check('Save: missing acknowledgement times out to Unsaved', (await state()).save==='unsaved' && (await state()).description==='Timeout must retain me');
    // A late ACK must not clear the error after the request timed out.
    const fifth=await nextSave(5);await reply({type:'saved',requestId:fifth.requestId,version:6});
    check('Save: late acknowledgement cannot clear timeout', (await state()).save==='unsaved');
    await page.context().close();
  } finally { await browser.close(); }
  const {passed,failed}=result();console.log(`${passed}/${passed+failed} passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
