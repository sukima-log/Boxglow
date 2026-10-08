/**
 * 画面の部品の検査: 幅 320 / 390 / 768 / 1280px で上の帯の操作が画面内に収まること、
 * 通常の幅では Undo / Redo が帯に出て (Auto Layout はいつも ⋯ メニュー)、Edit / View の切り替えで帯の形が変わらず、狭い幅では ⋯ メニューに入ること、質問が詳細パネルの先頭に出ること、
 * 別のボックスを選んでも詳細パネルのタブを保つこと、Activity の Resume タブ、保存の競合で左右を比べて選べること。
 * 使い方: e2e/run.sh から呼ばれる (PLAYWRIGHT と LD_LIBRARY_PATH は run.sh が設定。プレビューが 4173 番で動いていること)
 */
const fs = require('fs');
const path = require('path');
const { chromium, ROOT, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    const {page,errors} = await open(browser,{query:'?demo=1&lang=ja'});
    const search=page.getByRole('textbox',{name:'ブロックを検索'});
    for (const width of [320,390,768,1280]) {
      await page.setViewportSize({width,height:844});
      check(`上の帯 ${width}px: 検索・メニュー・保存の札が画面内に収まる`, await page.evaluate(()=> {
        const controls=[...document.querySelectorAll('.topbar button,.topbar input,.save-chip')].filter(e=>e.getClientRects().length);
        return controls.every(e=>{const r=e.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth+1;});
      }));
    }
    // Auto Layout はモードに関係なく ⋯ メニューにある (帯に出し入れすると帯の幅が変わり、折り返しが切り替わって揺れるため)
    const inBar=()=>page.evaluate(()=>[...document.querySelectorAll('.topbar-tools > button')].some(e=>e.textContent==='Auto Layout'&&e.getClientRects().length>0));
    check('閲覧時: Auto Layout は帯に出さない',!await inBar());
    await page.locator('.topbar button[title="Menu"]').click();
    check('閲覧時: メニューから Auto Layout に到達できる',await page.getByRole('button',{name:'Auto Layout',exact:true}).isVisible());
    await page.locator('.topbar button[title="Menu"]').click(); // もう一度押してメニューを閉じる
    // Edit / View を切り替えても、帯の高さ・モード札の幅・右端の要素の位置が変わらない (幅 1280 と、折り返しの境目に近い幅で確かめる)
    const barBox=()=>page.evaluate(()=>{const r=(s)=>{const e=document.querySelector(s);if(!e)return null;const b=e.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top),Math.round(b.width),Math.round(b.height)];};return JSON.stringify([r('.topbar'),r('.mode-toggle'),r('.topbar-search'),r('.topbar button[title="Menu"]')]);});
    for (const width of [1280,1100,1000,900]) {
      await page.setViewportSize({width,height:844});await page.waitForTimeout(150);
      const before=await barBox();
      await page.locator('.mode-toggle').click();await page.waitForTimeout(150);
      const after=await barBox();
      await page.locator('.mode-toggle').click();await page.waitForTimeout(150);
      check(`上の帯 ${width}px: Edit / View を切り替えても帯の形が変わらない`,before===after,`${before} / ${after}`);
    }
    await page.setViewportSize({width:1280,height:844});
    await page.locator('.mode-toggle').click();
    // 編集時の通常幅: よく使う編集の操作 (Undo / Redo) は帯に出ていて、Auto Layout は帯に出ない
    check('上の帯 1280px: Undo / Redo が帯に出ていて、Auto Layout はメニューにある',await page.evaluate(()=>{
      const vis=(sel)=>[...document.querySelectorAll(sel)].some(e=>e.getClientRects().length>0);
      return vis('.topbar-tools > button.desktop-action[aria-label="Undo"]') && vis('.topbar-tools > button.desktop-action[aria-label="Redo"]');
    }) && !await inBar());
    check('上の帯 1280px: プロジェクト名と保存先が出ている',await page.locator('.project-name').isVisible() && await page.locator('.save-chip').isVisible());
    await page.setViewportSize({width:390,height:844});
    await search.fill('B5'); await search.press('Enter');
    await page.getByText('回答が必要です',{exact:true}).waitFor();
    check('詳細パネル: カテゴリと質問が画面内で見つかる',await page.evaluate(()=>{
      const question=document.querySelector('.attention-section').getBoundingClientRect();
      const category=document.querySelector('.category-field').getBoundingClientRect();
      const top=document.querySelector('.app-top').getBoundingClientRect();
      const panel=document.querySelector('.panel.right').getBoundingClientRect();
      return question.bottom<innerHeight-36 && category.top<question.top && category.bottom<innerHeight-36 && panel.top>=top.bottom;
    }));
    check('詳細パネル: 答えていない質問は 1 回だけ出る',await page.getByText('公開先はどれにしますか?',{exact:true}).count()===1);
    await page.getByRole('button',{name:'静的ホスティング',exact:true}).click();
    await page.getByText('AI未確認の回答',{exact:true}).waitFor();
    check('詳細パネル: 回答は AI が確認するまで残る',await page.getByText('静的ホスティング',{exact:true}).isVisible());
    await page.getByRole('button',{name:'その他',exact:true}).click();
    const attention=page.locator('.inspector-attention');
    check('詳細パネル: 別タブでもAI未確認の件数に気づける',await attention.isVisible() && (await attention.innerText()).includes('AI未確認 1') && !(await attention.innerText()).includes('回答待ち'));
    await attention.click();
    check('詳細パネル: 案内から回答を確認できる',await page.getByText('AI未確認の回答',{exact:true}).isVisible());
    await page.getByRole('button',{name:'その他',exact:true}).click();
    await search.fill('B4');await search.press('Enter');
    check('詳細パネル: 別のボックスを選んでも開いているタブ (More) を保つ',await page.locator('.panel.right .seg__btn').filter({hasText:/^その他$/}).getAttribute('data-on')==='true');
    await page.locator('.summary-chip').click();
    await page.getByRole('button',{name:/^Resume/}).click();
    check('Resume タブ: AI 未確認の回答が残り、サンプルの引き継ぎメモ (バックエンド) が出る',await page.getByText(/ノートの一覧・作成・削除の API まで実装済み/).first().isVisible() && await page.getByText('静的ホスティング',{exact:true}).isVisible());
    await page.locator('.topbar button[title="Menu"]').click();
    check('狭い幅 (390px): 追加・Auto Layout・Undo / Redo は ⋯ メニューの中にある',await page.locator('.menu-actions').getByRole('button',{name:'+ Block',exact:true}).isVisible() && await page.getByRole('button',{name:'Auto Layout',exact:true}).isVisible() && await page.locator('.menu-actions').getByRole('button',{name:'Undo',exact:true}).isVisible() && await page.locator('.menu-actions').getByRole('button',{name:'Redo',exact:true}).isVisible());
    check('画面: 実行時のエラーが無い',errors.length===0,errors.join(';'));
    await page.context().close();

    // VS Code の中: 拡張からファイルが届かないとき (Windows の窓で WSL のファイルを開き、拡張が読めない場合など)、
    // 黙って空の画面にせず、「届いていない」と出す。VS Code の中では、ブラウザ向けの案内 (サンプル・ブラウザ内の計画の一覧・serve) は出さない
    // (その一覧の計画は、ファイルとは別の、VS Code の中だけのコピーで、開いても boxglow.json には保存されないため)
    const lost=await open(browser,{vscode:true});
    const homeText=await lost.page.locator('.home-dialog').innerText();
    check('VS Code: ブラウザ向けの案内と、ブラウザ内の計画の一覧を出さない',!/ブラウザ|サンプルを試す|serve|コピーして編集/.test(homeText),homeText.slice(0,160));
    await lost.page.waitForFunction(()=>window.boxglow.store.getState().vscodeFile?.state==='timeout',null,{timeout:8000});
    check('VS Code: ファイルが届かないときは、その旨を Home に出す',await lost.page.getByText('VS Code から、ファイルの中身を受け取れていません',{exact:false}).isVisible());
    // 拡張がファイルを直接読み書きできない窓: 計画は表示し、閲覧専用にして理由を帯に出す (保存の要求は送らない)
    const sample=fs.readFileSync(path.join(ROOT,'examples/notes-app/boxglow.json'),'utf8');
    const reason='この窓からは保存できません (閲覧専用)。確認用の理由';
    await lost.page.evaluate(([text,readonlyReason])=>window.postMessage({type:'load',text,version:1,name:'boxglow.json',appVersion:'0.4.2',extensionVersion:'0.3.2',protocol:1,readonlyReason},'*'),[sample,reason]);
    await lost.page.waitForFunction(()=>window.boxglow.store.getState().source==='vscode');
    check('VS Code: 読み書きできない窓では閲覧専用にして理由を出す',await lost.page.getByText(reason,{exact:true}).isVisible() && await lost.page.evaluate(()=>window.boxglow.store.getState().readonly===true && window.boxglow.store.getState().hostNotice===null));
    await lost.page.evaluate(()=>{window.__posted.length=0;window.boxglow.store.getState().apply(p=>({...p,name:'変更してみる'}));});
    await lost.page.waitForTimeout(1500);
    check('VS Code: 閲覧専用の間は、拡張へ保存の要求を送らない',await lost.page.evaluate(()=>window.__posted.filter(m=>m.type==='save').length===0));
    // 読み書きできるようになった (設定を直して開き直した) ら、閲覧専用を外す
    await lost.page.evaluate(text=>window.postMessage({type:'update',text,version:2,name:'boxglow.json',appVersion:'0.4.2',extensionVersion:'0.3.2',protocol:1,readonlyReason:null},'*'),sample);
    await lost.page.waitForFunction(()=>window.boxglow.store.getState().readonly===false,null,{timeout:5000}).catch(()=>{});
    check('VS Code: 読み書きできるようになれば閲覧専用を外す',await lost.page.evaluate(()=>window.boxglow.store.getState().readonly===false && window.boxglow.store.getState().readonlyReason===null));
    await lost.page.context().close();

    const second=await open(browser,{vscode:true,query:'?lang=en',lang:'en'});const p=second.page;
    const original=fs.readFileSync(path.join(ROOT,'examples/notes-app/boxglow.json'),'utf8');
    await p.evaluate(text=>window.postMessage({type:'load',text,version:1,name:'boxglow.json',appVersion:'0.3.0',extensionVersion:'0.2.2',protocol:1},'*'),original);
    await p.waitForFunction(()=>window.boxglow.store.getState().source==='vscode');
    await p.evaluate(()=>{
      window.boxglow.store.getState().apply(p=>({...p,name:'Local title',description:'Local note'}));
      const remote=JSON.parse(JSON.stringify(window.boxglow.store.getState().project));remote.name='Remote title';remote.description='Remote note';
      window.postMessage({type:'update',text:JSON.stringify(remote),version:2,appVersion:'0.3.0',extensionVersion:'0.2.2',protocol:1},'*');
    });
    await p.getByRole('button',{name:/Compare and choose/}).click();
    const dialog=p.getByRole('dialog');
    check('競合: 全部の項目を選ぶまで統合できない',!(await dialog.getByRole('button',{name:'Merge selected values'}).isEnabled()));
    check('競合: 両方の題名が見える',await dialog.getByText('Local title',{exact:true}).isVisible() && await dialog.getByText('Remote title',{exact:true}).isVisible());
    await dialog.getByRole('button', { name: 'Choose by field', exact: true }).click();
    await dialog.locator('.conflict-field').filter({ has: p.getByRole('heading', { name: 'Name', exact: true }) }).getByRole('radio', { name: /^Latest file/ }).check();
    await dialog.locator('.conflict-field').filter({ has: p.getByRole('heading', { name: 'Description', exact: true }) }).getByRole('radio', { name: /^Your edits/ }).check();
    if (process.env.BOXGLOW_B_SCREENSHOTS) {
      fs.mkdirSync(process.env.BOXGLOW_B_SCREENSHOTS, { recursive: true });
      await p.screenshot({ path: path.join(process.env.BOXGLOW_B_SCREENSHOTS, 'save-fields-en.png') });
    }
    await dialog.getByRole('button',{name:'Merge selected values'}).click();
    await p.waitForFunction(()=>window.__posted.some(m=>m.type==='save'));
    const saved=await p.evaluate(()=>window.__posted.find(m=>m.type==='save'));
    const merged=JSON.parse(saved.text);
    check('競合: 保存される JSON が項目ごとの選択どおり',merged.name==='Remote title' && merged.description==='Local note');
    await p.evaluate(m=>window.postMessage({type:'saved',requestId:m.requestId,version:3},'*'),saved);
    await p.waitForFunction(()=>window.boxglow.store.getState().saveState==='saved');
    await p.locator('.version-info summary').click();
    check('バージョン: 拡張の版と保存方式が見える',await p.getByText('0.2.2',{exact:true}).isVisible() && await p.getByText('GUI 1 / Peer 1',{exact:true}).isVisible());
    check('競合の画面: 実行時のエラーが無い',second.errors.length===0,second.errors.join(';'));
    await p.context().close();
  } finally {await browser.close();}
  const {passed,failed}=result();console.log(`${passed}/${passed+failed} passed`);process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
