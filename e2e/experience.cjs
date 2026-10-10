/**
 * 使い始めの体験の検査 (ライト / ダーク): 最初の画面に出す操作と隠す操作、同じ出力の線の幹が 1 回だけ描かれること、
 * ボックスの見た目 (状態 = 面の明暗・枠・記号と文字、選択 = 外側の輪郭) と線の太さ (確定 4px / 未確定 2px)、
 * ミニマップの出し方、質問への回答が残ること、Home の最初の案内。
 * 撮影は確認用で、リポジトリには書き出さない: OS の一時フォルダ (<tmp>/boxglow-e2e-shots。環境変数 BOXGLOW_E2E_SHOTS で変えられる) に出す。
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const fs=require('fs'),os=require('os'),path=require('path');
const {chromium,open,check,result}=require('./lib.cjs');
// 撮影の出力先 (docs/screenshots に書くと、検査を回すたびに追跡対象の画像が変わってしまう)
const out=process.env.BOXGLOW_E2E_SHOTS||path.join(os.tmpdir(),'boxglow-e2e-shots');fs.mkdirSync(out,{recursive:true});
const settle=p=>p.waitForTimeout(500);
(async()=>{
 const browser=await chromium.launch();
 try {
  for(const theme of ['light','dark']) {
   const {page:p,errors}=await open(browser,{query:`?demo=1&lang=ja&theme=${theme}`});
   await p.setViewportSize({width:1120,height:720});
   await p.getByRole('tab',{name:'In Progress 実装する',exact:true}).click();await settle(p);
   check(`${theme}: 最初の画面はミニマップを隠し、Auto Layout は帯に出さない (いつも ⋯ メニュー)`,!await p.getByRole('button',{name:'ミニマップ',exact:true}).isVisible() && await p.locator('.react-flow__minimap').count()===0 && !await p.locator('.topbar-tools > button.desktop-action').filter({hasText:/^Auto Layout$/}).isVisible());
   // ボックスと線の見た目 (縮小しても状態と線の種類が見分けられる約束): 計算後のスタイルで確かめる
   const look=await p.evaluate(()=>{
     const css=(sel,prop,pseudo)=>{const e=document.querySelector(sel);return e?getComputedStyle(e,pseudo)[prop]:null;};
     const lum=s=>{const v=(s||'').match(/[\d.]+/g)?.slice(0,3).map(Number)??[0,0,0];return (.2126*v[0]+.7152*v[1]+.0722*v[2])/255;};
     return {
       marks:['black','gray','white'].map(s=>document.querySelector(`.bg-block.status-${s}:not(.expanded) .status-icon`)?.getAttribute('aria-label')),
       heads:['black','gray','white'].map(s=>css(`.bg-block.status-${s}:not(.expanded) > .bg-block__head`,'backgroundColor')),
       meta:['black','gray','white'].map(s=>css(`.bg-block.status-${s}:not(.expanded) > .bg-block__meta`,'backgroundColor')),
       icons:['black','gray','white'].map(s=>document.querySelector(`.bg-block.status-${s}:not(.expanded) .status-icon`)?.innerHTML),
       active:lum(css('.bg-block.status-gray:not(.expanded)','backgroundColor')), activeStripe:css('.bg-block.status-gray:not(.expanded) > .bg-block__head','boxShadow'), doneBorder:css('.bg-block.status-white:not(.expanded)','borderTopStyle'), black:lum(css('.bg-block.status-black:not(.expanded)','backgroundColor')), white:lum(css('.bg-block.status-white:not(.expanded)','backgroundColor')),
       hatch:css('.bg-block.status-gray:not(.expanded)','backgroundImage'), parentHatch:css('.bg-block.status-gray.expanded','backgroundImage'), blackBorder:css('.bg-block.status-black:not(.expanded)','borderTopStyle'),
       cat:css('.bg-block.has-cat:not(.status-gray)','display','::before'), stripe:css('.bg-block.status-gray:not(.expanded)','display','::before'),
       ready:css('.react-flow__edge.edge-ready .react-flow__edge-path','strokeWidth'), pending:css('.react-flow__edge:not(.edge-ready) .react-flow__edge-path','strokeWidth'),
       progress:css('.bg-block__progress > span','backgroundColor'), primary:getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()
     };
   });
   // 採用済み B案: 状態は青灰・ティール・白い見出しで区別し、入出力の面は控えめにする。
   const expectedHeads=theme==='dark'?['rgb(48, 62, 76)','rgb(37, 220, 191)','rgb(228, 240, 245)']:['rgb(213, 224, 235)','rgb(37, 220, 191)','rgb(246, 251, 253)'];
   check(`${theme}: B案のNew・In Progress・Doneを見出しの3色で区別`,look.heads.every((c,i)=>c===expectedHeads[i])&&look.meta.every((c,i)=>c===look.heads[i]),JSON.stringify(look.heads));
   check(`${theme}: 色だけに頼らず3種類の状態記号と文字を維持し、入出力面は静かに保つ`,look.icons.every(Boolean)&&new Set(look.icons).size===3&&look.marks.join('|')==='New|In Progress|Done'&&(theme==='light'?look.white>.95:look.white<.3),JSON.stringify(look.marks));
   check(`${theme}: 面全体への斜線は使わず状態の記号と文字も残す`,look.hatch==='none'&&look.parentHatch==='none'&&look.marks.join('|')==='New|In Progress|Done',JSON.stringify([look.hatch,look.parentHatch,look.marks]));
   check(`${theme}: カテゴリ帯と上端の斜線帯を重ねない`,(look.cat===null||look.cat==='none')&&(look.stripe===null||look.stripe==='none'||look.stripe==='normal'),JSON.stringify([look.cat,look.stripe]));
   check(`${theme}: 進捗バーは作業中を示すティール`,look.progress===null||(()=>{const v=look.progress.match(/\d+/g).slice(0,3).map(Number);const h=look.primary.slice(1);return v.every((c,i)=>c===parseInt(h.slice(i*2,i*2+2),16));})(),JSON.stringify(look.progress));
   check(`${theme}: 線の太さは確定 4px / 未確定 2px`,(look.ready===null||look.ready==='4px')&&(look.pending===null||look.pending==='2px'),JSON.stringify([look.ready,look.pending]));
   check(`${theme}: 同じ出力の分岐点に丸が出る`,await p.locator('.react-flow__edge-junction').count()>0);
   check(`${theme}: 同じ出力の幹は 1 回だけ描く`,await p.evaluate(()=>{
    const es=window.boxglow.rf.getEdges().filter(e=>!e.hidden&&e.data?.shared);
    const groups=new Map();for(const e of es){const key=e.source+'|'+e.sourceHandle;const list=groups.get(key)||[];list.push(e);groups.set(key,list);}
    return [...groups.values()].filter(g=>g.length>1).every(g=>{
     const start=g[0].data.path[0];return g.flatMap(e=>e.data.shared.parts).filter(p=>p[0]?.x===start.x&&p[0]?.y===start.y).length===1;
    });
   }));
   await p.screenshot({path:path.join(out,`experience-${theme}.png`)});
   await p.setViewportSize({width:1120,height:900});
   const scope=await p.evaluate(()=>window.boxglow.store.getState().viewScope);
   await p.evaluate(id=>window.boxglow.rf.fitView({nodes:[{id}],padding:.1,maxZoom:1}),scope);await settle(p);
   await p.getByTestId('rf__node-'+scope).screenshot({path:path.join(out,`experience-detail-${theme}.png`)});
   await p.setViewportSize({width:1120,height:720});
   // ボックスを選ぶと判断待ちとは別の輪郭が付く
   await p.locator('.react-flow__node-block .bg-block:not(.expanded) .bg-block__title').first().click();await settle(p);
   check(`${theme}: 選んだボックスは状態と独立した輪郭`,await p.evaluate(()=>{const e=document.querySelector('.bg-block.selected'),h=getComputedStyle(document.documentElement).getPropertyValue('--selection').trim().slice(1),rgb=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16));return getComputedStyle(e).boxShadow.includes('rgb('+rgb.join(', ')+')');}));
   await p.screenshot({path:path.join(out,`experience-selected-${theme}.png`)});
   await p.keyboard.press('Escape');await settle(p);
   await p.getByRole('button',{name:'Fit',exact:true}).click();await settle(p);
   await p.locator('.canvas-tools__settings > summary').click();
   await p.getByRole('button',{name:'ミニマップ',exact:true}).click();
   check(`${theme}: ミニマップは View の引き出しから出せる`,await p.locator('.react-flow__minimap').count()===1);
   await p.keyboard.press('Escape');
   check(`${theme}: Esc で引き出しが閉じる`,!await p.locator('.canvas-tools__settings').getAttribute('open'));
   await p.locator('.canvas-tools__settings > summary').click();
   await p.getByRole('button',{name:'ミニマップ',exact:true}).click();
   await p.keyboard.press('Escape');
   if(theme==='light') {
    await p.getByRole('tab',{name:'In Progress 公開する',exact:true}).click();await settle(p); // (公開するは中に箱を持つので作業中)
    await p.locator('.react-flow__node-block .bg-block__title').filter({hasText:/^公開する$/}).click();
    await p.getByRole('heading',{name:'未回答',exact:true}).waitFor();await settle(p);
    await p.screenshot({path:path.join(out,'experience-decision.png')});
    await p.getByRole('button',{name:'静的ホスティング',exact:true}).click();
    await p.getByRole('heading',{name:'AI 未読',exact:true}).waitFor();await settle(p);
    await p.screenshot({path:path.join(out,'experience-answer.png')});
    check('回答は AI が確認するまで残る (候補も見える)',await p.getByText('候補:',{exact:false}).isVisible());
    await p.getByRole('button',{name:'Home',exact:true}).click();await settle(p);
    await p.screenshot({path:path.join(out,'experience-home.png')});
    check('Home: 初回は「サンプルを試す」だけが主役で、自分の計画の操作は引き出しの中',await p.getByRole('button',{name:'サンプルを試す',exact:true}).isVisible() && !await p.getByText('npx boxglow serve --open',{exact:true}).isVisible());
   }
   check(`${theme}: 実行時のエラーが無い`,errors.length===0,errors.join('|'));
   if(theme==='dark') {
    await p.setViewportSize({width:390,height:844});
    await p.locator('.canvas-tools__settings > summary').click();
    await p.getByRole('button',{name:'ミニマップ',exact:true}).click();await p.keyboard.press('Escape');
    check('390px: 出したミニマップが操作欄に重ならない',await p.evaluate(()=>{
      const m=document.querySelector('.react-flow__minimap').getBoundingClientRect(),c=document.querySelector('.canvas-tools').getBoundingClientRect();
      return m.width>0&&m.right<=innerWidth&&m.bottom<c.top;
    }));
   }
   await p.context().close();
  }
 } finally {await browser.close();}
 const {passed,failed}=result();console.log(`${passed}/${passed+failed} passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
