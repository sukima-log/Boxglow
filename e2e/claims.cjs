/** 受け持ちの設定・表示・解除・Undo。サンプルだけを編集する。 */
const {chromium,open,check,result}=require('./lib.cjs');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
 const browser=await chromium.launch();
 try {
  for(const lang of ['ja','en'])for(const theme of ['light','dark']) {
   const {page,errors}=await open(browser,{query:`?demo=1&lang=${lang}&theme=${theme}`,lang});
   await page.clock.install();await page.reload();
   await page.waitForFunction(()=>window.boxglow?.store?.getState().project);
   await page.locator('.project-name').click();await page.locator('.claim-settings summary').click();
   const settings=page.locator('.claim-settings');const mode=settings.locator('select');
   check(`${lang}/${theme}: 既定は無効`,await mode.inputValue()==='off');
   await mode.selectOption('reject');
   check(`${lang}/${theme}: 計画ごとに有効化、期限30分`,await page.evaluate(()=>{const p=window.boxglow.store.getState().project;return p.claimPolicy.mode==='reject'&&p.claimPolicy.leaseMinutes===30;}));
   check(`${lang}/${theme}: 制限を表示`,(await settings.innerText()).includes(lang==='ja'?'同期先の別端末':'remote synced copies'));
   const id=await page.evaluate(()=>{
    const store=window.boxglow.store,s=store.getState(),b=Object.values(s.project.blocks).find(b=>b.key==='B8'),now=Date.now();
    s.apply(p=>({...p,claims:{[b.id]:{actor:'codex',instanceId:'review-session-1',claimId:'review-claim',scope:'block',generation:1,acquiredAt:new Date(now).toISOString(),renewedAt:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString()}}}),{history:false});
    store.getState().focusBlock(b.id,{scope:true});store.getState().select({blockId:b.id});return b.id;
   });
   if(!await page.locator('.tree-panel').count())await page.locator('.tree-toggle').click();
   const row=page.locator(`.tree-row[data-block-id="${id}"]`);
   const node=page.locator(`.react-flow__node[data-id="${id}"]`);
   await row.locator('.claim-mark').waitFor();await node.locator('.claim-mark').waitFor();
   check(`${lang}/${theme}: ツリーはアイコンのみ`,(await row.locator('.claim-mark').innerText()).trim()==='');
   const contrast=await node.locator('.claim-mark').evaluate(el=>{
    const numbers=s=>(s.match(/[\d.]+/g)||[]).map(Number);
    const l=rgb=>rgb.slice(0,3).map(x=>{const c=x/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
    const a=l(numbers(getComputedStyle(el).color)),b=l(numbers(getComputedStyle(el.closest('.bg-block')).backgroundColor));return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
   });
   check(`${lang}/${theme}: 暗いボックスでも札の文字が4.5:1以上`,contrast>=4.5,String(contrast));
   check(`${lang}/${theme}: ボックスで担当名、活動バッジと重複しない`,(await node.locator('.claim-mark').innerText()).includes('codex')&&await node.locator('.meta-chip.activity').count()===0);
   await page.locator('.claim-details summary').click();const details=page.locator('.claim-details');
   check(`${lang}/${theme}: 実行IDと期限を詳細で確認`,(await details.innerText()).includes('review-session-1')&&(await details.innerText()).includes(lang==='ja'?'期限:':'Expires:'));
   await page.evaluate(()=>window.boxglow.rf.fitView({duration:0,padding:0.12}));
   await page.waitForTimeout(200);
   const screenshots=process.env.BOXGLOW_C_SCREENSHOTS;
   if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,`claims-${lang}-${theme}.png`)});}
   check(`${lang}/${theme}: 理由なしで解除できない`,await details.locator('button').isDisabled());
   // Undoの段を作ってから、人が受け持ちを解除する。
   await page.evaluate(id=>window.boxglow.store.getState().apply(p=>({...p,blocks:{...p.blocks,[id]:{...p.blocks[id],title:'Changed for undo'}}})),id);
   await details.locator('input').fill('作業を引き継ぐ');
   check(`${lang}/${theme}: 解除は塗りのボタンで入力欄と区別`,await details.locator('button').evaluate(el=>el.classList.contains('btn-primary')&&getComputedStyle(el).backgroundColor!==getComputedStyle(el.parentElement.querySelector('input')).backgroundColor));
   if(screenshots)await page.screenshot({path:path.join(screenshots,`claims-release-${lang}-${theme}.png`)});
   await details.locator('button').click();
   check(`${lang}/${theme}: 解除で世代が進み理由が残る`,await page.evaluate(id=>{const c=window.boxglow.store.getState().project.claims[id];return c.generation===2&&!!c.releasedAt&&c.releaseReason==='作業を引き継ぐ';},id));
   await page.evaluate(()=>window.boxglow.store.getState().undo());
   check(`${lang}/${theme}: Undoでも解除済みの世代は戻らない`,await page.evaluate(id=>{const c=window.boxglow.store.getState().project.claims[id];return c.generation===2&&!!c.releasedAt;},id));
   check(`${lang}/${theme}: Undo後も解除ログと設定ログが残る`,await page.evaluate(()=>{const log=window.boxglow.store.getState().project.log;return log.some(e=>e.claimEvent==='release')&&log.some(e=>e.claimEvent==='policy');}));
   await page.evaluate(()=>window.boxglow.store.getState().redo());
   check(`${lang}/${theme}: Redoでも解除ログが重複しない`,await page.evaluate(()=>window.boxglow.store.getState().project.log.filter(e=>e.claimEvent==='release').length===1));
   // 表示時計で期限切れに変わり、ファイルの記録は自動で書き換えない。
   await page.evaluate(id=>{const s=window.boxglow.store.getState(),now=Date.now();s.apply(p=>({...p,claims:{[id]:{...p.claims[id],releasedAt:undefined,releaseReason:undefined,renewedAt:new Date(now).toISOString(),expiresAt:new Date(now+1000).toISOString()}}}),{history:false});},id);
   await page.clock.fastForward(20000);
   check(`${lang}/${theme}: 時計の進行で期限切れを表示`,await node.locator('.claim-mark').getAttribute('data-expired')==='true');
   check(`${lang}/${theme}: 実行時エラーなし`,errors.length===0,errors.join(';'));
   await page.context().close();
  }
 }finally{await browser.close();}
 const r=result();console.log(JSON.stringify(r));if(r.failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
