/** 採用UIの意味と操作を検査。表示切替が計画や接続点を変更しないことも確認する。 */
const fs=require('fs'),os=require('os'),path=require('path');
const {chromium,open,check,result}=require('./lib.cjs');
const out=process.env.BOXGLOW_E2E_SHOTS||path.join(os.tmpdir(),'boxglow-e2e-shots');
fs.mkdirSync(out,{recursive:true});
const settle=p=>p.waitForTimeout(400);
const core=async(p,id)=>p.locator(`.react-flow__edge[data-id="${id}"]`).evaluate(e=>({
 stroke:getComputedStyle(e.querySelector('.react-flow__edge-path')).stroke,
 dash:getComputedStyle(e.querySelector('.react-flow__edge-path')).strokeDasharray,
 arrow:getComputedStyle(e.querySelector('.react-flow__edge-arrow')).fill,
 // 詳細欄の開閉で経路を再配置すると、共通幹の丸を描く担当edgeが変わる。数ではなく状態色を検査する。
 junctionsMatch:[...e.querySelectorAll('.react-flow__edge-junction')].every(q=>getComputedStyle(q).fill===getComputedStyle(e.querySelector('.react-flow__edge-path')).stroke)
}));
const geometry=p=>p.evaluate(()=>window.boxglow.rf.getNodes().map(n=>[n.id,n.position,n.measured]).sort((a,b)=>a[0].localeCompare(b[0])));
(async()=>{
 const browser=await chromium.launch();
 try {
  for(const theme of ['light','dark']) {
   const {page:p,errors}=await open(browser,{query:`?demo=1&lang=ja&theme=${theme}`});
   await p.getByRole('tab',{name:'In Progress 実装する',exact:true}).click();await settle(p);
   const original=await p.evaluate(()=>JSON.stringify(window.boxglow.store.getState().project));
   for(const ready of [true,false]) {
    await p.evaluate(()=>window.boxglow.store.getState().select({}));await settle(p);
    const id=await p.locator(ready?'.react-flow__edge.edge-ready':'.react-flow__edge:not(.edge-ready)').first().getAttribute('data-id');
    const before=await core(p,id);
    await p.evaluate(id=>window.boxglow.store.getState().select({edgeId:id}),id);await settle(p);
    const after=await core(p,id);
    check(`${theme} ${ready?'確定':'未確定'}: 選択で芯・矢印・分岐の色と線種は変わらない`,before.junctionsMatch&&after.junctionsMatch&&JSON.stringify(before)===JSON.stringify(after),JSON.stringify({before,after}));
    check(`${theme} ${ready?'確定':'未確定'}: 状態を線種でも区別する`,ready?after.dash==='none':after.dash!=='none');
    await p.locator(`.react-flow__edge[data-id="${id}"]`).focus();
    check(`${theme} ${ready?'確定':'未確定'}: キーボードフォーカスでも状態色を維持`,JSON.stringify(before)===JSON.stringify(await core(p,id)));
    check(`${theme} ${ready?'確定':'未確定'}: 状態と根拠が詳細欄に出る`,await p.locator('.wire-state').textContent()===(ready?'確定済み':'入力待ち')&&(await p.locator('.wire-reason').textContent()).length>10);
    check(`${theme} ${ready?'確定':'未確定'}: 選択輪郭が接続元から接続先まで続く`,await p.locator(`.react-flow__edge[data-id="${id}"]`).evaluate(e=>{
      const halo=e.querySelector('.react-flow__edge-halo'),hit=e.querySelector('.react-flow__edge-interaction');
      return !!halo&&halo.getTotalLength()>hit.getTotalLength()&&getComputedStyle(halo).stroke!==getComputedStyle(e.querySelector('.react-flow__edge-path')).stroke;
    }));
   }
   await p.evaluate(async()=>{window.boxglow.store.getState().select({});await window.boxglow.rf.zoomTo(1);});await settle(p);
   const normal=await geometry(p);
   await p.evaluate(()=>window.boxglow.rf.zoomTo(.5));await settle(p);
   check(`${theme}: 俯瞰でもノードの寸法と位置は同じ`,JSON.stringify(normal)===JSON.stringify(await geometry(p)));
   check(`${theme}: 俯瞰は入出力文字を抑え、接続点は残す`,await p.evaluate(()=>{
     const b=document.querySelector('.bg-block.is-overview:not(.expanded)');
     return getComputedStyle(b.querySelector('.bg-block__ports')).visibility==='hidden'&&getComputedStyle(b.querySelector('.react-flow__handle')).visibility==='visible';
   }));
   await p.screenshot({path:path.join(out,`design-overview-${theme}.png`)});
   const block=await p.locator('.react-flow__node-block').filter({has:p.locator('.bg-block:not(.expanded)')}).first().getAttribute('data-id');
   await p.evaluate(id=>window.boxglow.store.getState().select({blockId:id}),block);await settle(p);
   check(`${theme}: 俯瞰でも選ぶと入出力とIDを読める`,await p.locator('.bg-block.selected').evaluate(b=>getComputedStyle(b.querySelector('.bg-block__ports')).visibility==='visible'&&getComputedStyle(b.querySelector('.bg-block__key')).display!=='none'));
   await p.evaluate(()=>window.boxglow.store.getState().select({}));
   await p.locator('.mode-toggle').click();await settle(p);
   check(`${theme}: 編集時は俯瞰倍率でも入出力を表示`,await p.locator('.bg-block.is-overview').count()===0);
   check(`${theme}: 表示・選択・モード切替は計画データを変えない`,original===await p.evaluate(()=>JSON.stringify(window.boxglow.store.getState().project)));
   await p.locator('.mode-toggle').click();
   // activity が未設定の判断待ちも見落とさない。変更は検査用サンプル内のみ。
   await p.evaluate(id=>window.boxglow.store.getState().apply(p=>{const q=structuredClone(p);delete q.blocks[id].activity;q.blocks[id].decisions=[{id:'design-pending',question:'公開先を選ぶ',options:['A','B'],createdAt:new Date().toISOString()}];return q;}),block);await settle(p);
   check(`${theme}: 活動記録なしでも判断待ちを表示`,await p.locator(`[data-id="${block}"] .meta-chip.needs_decision`).textContent()==='判断待ち 1');
   await p.getByRole('button',{name:'100% で文字を読む',exact:true}).click();await settle(p);
   await p.screenshot({path:path.join(out,`design-normal-${theme}.png`)});
   await p.evaluate(id=>window.boxglow.store.getState().apply(p=>{const q=structuredClone(p);q.blocks[id].title='AI エージェントとの連携で前の判断を読み返しながら長いタスクを進めるための確認'.repeat(3);return q;}),block);
   await p.evaluate(()=>window.boxglow.rf.zoomTo(.5));await settle(p);
   check(`${theme}: 俯瞰でも長い題名が状態行にはみ出さない`,await p.locator(`[data-id="${block}"] .bg-block__title`).evaluate(e=>{const r=e.getBoundingClientRect(),h=e.closest('.bg-block__head').getBoundingClientRect();return r.top>=h.top&&r.bottom<=h.bottom+1&&e.scrollHeight<=e.clientHeight+1;}));
   check(`${theme}: 実行エラーなし`,errors.length===0,errors.join('|'));
   await p.context().close();
  }
 }finally{await browser.close();}
 const {passed,failed}=result();console.log(`${passed}/${passed+failed} passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
