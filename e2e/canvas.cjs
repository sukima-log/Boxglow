/**
 * キャンバスの操作の検査 (ライト / ダークの両方): 丸のクリック・ドラッグでの結線、View では結線できないこと、
 * つなげない丸に離しても別の入力が作られないこと、Esc でのキャンセル、「この階層を整列」と Undo、8px の吸着、
 * 選んだ線の両端への移動 (To selection)、Done のボックスの文字のコントラスト、長い題名 (省略せず見出しに収まる)、320px 幅。
 * 実際のマウス操作で確かめる (store の API だけでは、クリックの伝わり方の不具合を見逃すため)。
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const { chromium, open, check, result, idOf } = require('./lib.cjs');
const pause = p => p.waitForTimeout(350);
const snapshot = p => p.evaluate(() => JSON.stringify(window.boxglow.store.getState().project));
async function drag(page, from, to) {
  const a = await from.boundingBox(), b = await to.boundingBox();
  await page.mouse.move(a.x+a.width/2,a.y+a.height/2); await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:20}); await page.mouse.up(); await pause(page);
}
(async () => {
 const browser=await chromium.launch();
 try {
  for (const theme of ['light','dark']) {
   const {page:p,errors}=await open(browser,{query:`?demo=1&lang=ja&theme=${theme}`});
   await p.getByRole('tab',{name:'In Progress 実装する',exact:true}).click(); await pause(p);
   const output=p.locator('.react-flow__handle[title="出力: 画面の実装 (クリックまたはドラッグで接続)"]');
   const backend=await idOf(p,'バックエンド');
   const backendIn=p.getByTestId('rf__node-'+backend).locator('.react-flow__handle.target');
   const beforeView=await snapshot(p);
   await output.click({force:true});await backendIn.click({force:true});
   check(`${theme}: View では結線できない`,beforeView===await snapshot(p) && await p.locator('.canvas-connect-hint').count()===0);
   await p.locator('.mode-toggle').click();
   await p.getByRole('button',{name:'+ Block',exact:true}).click();
   const newId=await idOf(p,'新しいブロック');
   await p.getByRole('button',{name:'入出力 0/1',exact:true}).click();
   await p.getByRole('button',{name:'＋ 入力を追加',exact:true}).click();
   await p.locator('.panel.right button[title="閉じる (Esc)"]').click();
   await p.getByRole('button',{name:'Fit',exact:true}).click();await pause(p);
   const input=p.getByTestId('rf__node-'+newId).locator('.react-flow__handle.target');
   await output.click();
   check(`${theme}: 丸を押すと結線が始まり、詳細パネルは開かない`,await p.locator('.canvas-connect-hint').isVisible() && !await p.locator('.panel.right').isVisible());
   await input.click();await pause(p);
   check(`${theme}: 2 回のクリックでつながり、仮の入力が消える`,await p.evaluate(id=>{
     const s=window.boxglow.store.getState(); const port=Object.values(s.project.ports).find(x=>x.blockId===id&&x.direction==='in');
     return port.name==='画面の実装' && Object.values(s.project.edges).some(e=>e.to.portId===port.id&&!e.auto) && !document.querySelector('.canvas-connect-hint');
   },newId));
   await p.keyboard.press('Control+z');await pause(p);
   check(`${theme}: Undo でつなぐ前の入力に戻る`,await input.getAttribute('title')==='入力: 新しい入力');
   await drag(p,output,input);
   check(`${theme}: ドラッグでも同じ丸どうしがつながる`,await input.getAttribute('title')==='入力: 画面の実装');
   const beforeInvalid=await snapshot(p);
   await drag(p,p.getByTestId('rf__node-'+newId).locator('.react-flow__handle.source'),input);
   check(`${theme}: 同じボックスの中へのドラッグでは、つながらず入力も増えない`,beforeInvalid===await snapshot(p));
   await output.click();await p.keyboard.press('Escape');
   check(`${theme}: Esc でクリックの結線をやめる`,await p.locator('.canvas-connect-hint').count()===0);
   await output.click();await p.locator('.mode-toggle').click();
   check(`${theme}: View に切り替えると結線をやめる`,await p.locator('.canvas-connect-hint').count()===0);
   await p.locator('.mode-toggle').click();
   const beforeArrange=JSON.parse(await snapshot(p));
   const scope=await p.evaluate(()=>window.boxglow.store.getState().viewScope);
   await p.locator('.canvas-tools__settings > summary').click();
   await p.getByRole('button',{name:'この階層を整列',exact:true}).click();await pause(p);
   const afterArrange=JSON.parse(await snapshot(p));
   check(`${theme}: 整列はほかの階層の配置と線を変えない`,Object.values(beforeArrange.blocks).filter(b=>b.parentId!==scope).every(b=>JSON.stringify(b.position)===JSON.stringify(afterArrange.blocks[b.id].position)) && JSON.stringify(beforeArrange.edges)===JSON.stringify(afterArrange.edges));
   await p.keyboard.press('Control+z');await pause(p);
   check(`${theme}: 整列は Undo で戻せる`,JSON.stringify(beforeArrange)===await snapshot(p));
   await p.getByRole('button',{name:'Fit',exact:true}).click();await pause(p);
   await p.locator('.canvas-tools__settings > summary').click();
   await p.getByRole('button',{name:'吸着',exact:true}).click();
   await p.keyboard.press('Escape');
   const title=p.getByTestId('rf__node-'+newId).locator('.bg-block__title');
   const rect=await title.boundingBox();
   await p.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await p.mouse.down();
   await p.mouse.move(rect.x+rect.width/2+37,rect.y+rect.height/2+45,{steps:20});await p.mouse.up();await pause(p);
   const snapped=await p.evaluate(id=>{
     const b=window.boxglow.store.getState().project.blocks[id],n=window.boxglow.rf.getInternalNode(id);
     return {parent:b.parentId,position:b.position,absolute:n.internals.positionAbsolute};
   },newId);
   check(`${theme}: 吸着を入れたドラッグは 8px にそろい、親は変わらない`,snapped.parent===scope&&Math.abs(snapped.absolute.x/8-Math.round(snapped.absolute.x/8))<.01&&Math.abs(snapped.absolute.y/8-Math.round(snapped.absolute.y/8))<.01,JSON.stringify(snapped));
   await p.keyboard.press('Escape');
   await p.getByRole('button',{name:'100% で文字を読む',exact:true}).click();
   check(`${theme}: 文字を読む倍率はちょうど 100%`,await p.evaluate(()=>window.boxglow.rf.getZoom()===1));
   await p.evaluate(id=>{
     const s=window.boxglow.store.getState();const e=Object.values(s.project.edges).find(e=>!e.auto&&s.project.ports[e.to.portId].blockId===id);s.select({edgeId:e.id});
   },newId);await pause(p);
   await p.getByRole('button',{name:'To selection',exact:true}).click();await pause(p);
   check(`${theme}: To selection で線の両端のボックスが画面に入る`,await p.evaluate(()=>{
     const s=window.boxglow.store.getState(),rf=window.boxglow.rf,e=rf.getEdge(s.selection.edgeId),bounds=document.querySelector('.react-flow').getBoundingClientRect(),zoom=rf.getZoom();
     return [e.source,e.target].every(id=>{const n=rf.getInternalNode(id),pt=rf.flowToScreenPosition(n.internals.positionAbsolute);return pt.x>=bounds.left&&pt.y>=bounds.top&&pt.x+n.measured.width*zoom<=bounds.right&&pt.y+n.measured.height*zoom<=bounds.bottom;});
   }));
   await p.keyboard.press('Escape');
   await p.getByRole('button',{name:'Fit',exact:true}).click();await pause(p);
   check(`${theme}: 動きを減らす設定では、選んだ線の動きが止まる`,await (async()=>{
     await p.emulateMedia({reducedMotion:'reduce'});
     return await p.evaluate(()=>{
       const edge=document.querySelector('.react-flow__edge');edge.classList.add('edge-net');
       const ok=getComputedStyle(edge.querySelector('.react-flow__edge-path')).animationName==='none';edge.classList.remove('edge-net');return ok;
     });
   })());
   check(`${theme}: 線の当たり判定は縮小しても細くならない`,await p.locator('.react-flow__edge-interaction').first().getAttribute('vector-effect')==='non-scaling-stroke');
   check(`${theme}: Done のボックスの確定した入力名はコントラスト 4.5:1 以上`,await p.evaluate(()=>{
     const n=document.querySelector('.bg-block.status-white:not(.expanded)'), e=n.querySelector('.bg-block__port.ready');
     const lum=s=>{const v=s.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*v[0]+.7152*v[1]+.0722*v[2];};
     const a=lum(getComputedStyle(n).backgroundColor),b=lum(getComputedStyle(e).color);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;
   }));
   await p.evaluate(id=>window.boxglow.store.getState().apply(p=>{
     const q=structuredClone(p);q.blocks[id].title='AI エージェントとの連携で前の判断を読み返しながら長いタスクを進めるための確認';q.blocks[id].category='fix';return q;
   }),newId);await pause(p);
   await p.evaluate(id=>window.boxglow.store.getState().select({blockId:id}),newId);await pause(p);
   check(`${theme}: 長い題名と常時表示のカテゴリが重ならず見出しに収まる`,await title.evaluate(e=>{
     const r=e.getBoundingClientRect(),h=e.closest('.bg-block__head').getBoundingClientRect(),c=e.closest('.bg-block').querySelector('.bg-block__head .bg-block__cat').getBoundingClientRect();
     // 題名が切れていない (中身の高さ・幅が表示の枠を超えていない) ことも確かめる
     return r.top>=h.top&&r.bottom<=h.bottom+1&&r.left>=c.right&&r.right<=h.right&&c.width>0&&e.scrollHeight<=e.clientHeight+1&&e.scrollWidth<=e.clientWidth+1;
   }));
   const toggle=p.locator(`.topbar button[title="${theme==='dark'?'Light':'Dark'} mode"]`);
   await toggle.click();
   check(`${theme}: テーマの切り替えボタンが表示中のテーマに合っている`,await p.locator('html').getAttribute('data-theme')!==(theme));
   await p.setViewportSize({width:320,height:844});
   check(`${theme}: 操作欄が狭い画面 (320px) に収まる`,await p.locator('.canvas-tools').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&e.scrollWidth<=e.clientWidth+1;}));
   check(`${theme}: 実行時のエラーが無い`,errors.length===0,errors.join(';'));
   await p.context().close();
  }
  {
   // 線の先端の矢印: どの線にも付く (ボックスの入力に入る線にも、出力のノード Outputs へ届く線にも)
   const {page:p}=await open(browser,{query:'?demo=1&lang=ja'});
   await p.waitForFunction(()=>window.boxglow?.store.getState().project);
   const arrows=()=>p.evaluate(()=>[...document.querySelectorAll('.react-flow__edge')].filter(e=>e.getClientRects().length).map(e=>({id:e.getAttribute('data-id')||e.getAttribute('data-testid')||'',arrow:!!e.querySelector('.react-flow__edge-arrow')})));
   await p.waitForFunction(()=>document.querySelectorAll('.react-flow__edge').length>0);
   const all=await arrows();
   check('矢印: 全体の図で、どの線にも先端の矢印がある',all.length>0&&all.every(e=>e.arrow),JSON.stringify(all.filter(e=>!e.arrow)));
   // 大項目のタブ (Inputs / Outputs のノードが出る)
   await p.locator('.tab-strip button').nth(1).click();
   await p.waitForFunction(()=>[...document.querySelectorAll('.react-flow__edge')].some(e=>(e.getAttribute('data-id')||e.getAttribute('data-testid')||'').includes('scope-out')));
   const tab=await arrows();
   const toOutputs=tab.filter(e=>e.id.includes('scope-out'));
   check('矢印: 出力のノード (Outputs) へ届く線にも矢印がある',toOutputs.length>0&&toOutputs.every(e=>e.arrow),JSON.stringify(tab));
   check('矢印: タブの中の、どの線にも矢印がある',tab.every(e=>e.arrow),JSON.stringify(tab.filter(e=>!e.arrow)));
   await p.context().close();
  }
 } finally { await browser.close(); }
 const {passed,failed}=result();console.log(`${passed}/${passed+failed} passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
