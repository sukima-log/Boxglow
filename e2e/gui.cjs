/**
 * 画面の部品の検査: 幅 320 / 390 / 768 / 1280px で上の帯の操作が画面内に収まること、
 * 通常の幅では Undo / Redo が帯に出て (Auto Layout はいつも ⋯ メニュー)、Edit / View の切り替えで帯の形が変わらず、狭い幅では ⋯ メニューに入ること、質問が詳細パネルの先頭に出ること、
 * 別のボックスを選んでも詳細パネルのタブを保つこと、Activity の Resume タブと Claims タブ (受け持ちの一覧)、担当の一覧 (表、左下の切り替えから)、保存の競合で左右を比べて選べること。
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
    await page.getByText('未回答',{exact:true}).waitFor();
    check('詳細パネル: カテゴリと質問が画面内で見つかる',await page.evaluate(()=>{
      const question=document.querySelector('.attention-section').getBoundingClientRect();
      const category=document.querySelector('.category-field').getBoundingClientRect();
      const top=document.querySelector('.app-top').getBoundingClientRect();
      const panel=document.querySelector('.panel.right').getBoundingClientRect();
      return question.bottom<innerHeight-36 && category.top<question.top && category.bottom<innerHeight-36 && panel.top>=top.bottom;
    }));
    check('詳細パネル: 答えていない質問は 1 回だけ出る',await page.locator('.panel.right').getByText('公開先はどれにしますか?',{exact:true}).count()===1);
    await page.getByRole('button',{name:'静的ホスティング',exact:true}).click();
    await page.getByText('AI 未読',{exact:true}).waitFor();
    check('詳細パネル: 回答は AI が確認するまで残る',await page.getByText('静的ホスティング',{exact:true}).isVisible());
    await page.getByRole('button',{name:'その他',exact:true}).click();
    const attention=page.locator('.inspector-attention');
    check('詳細パネル: 別タブでもAI未確認の件数に気づける',await attention.isVisible() && (await attention.innerText()).includes('AI 未読 1') && !(await attention.innerText()).includes('未回答'));
    await attention.click();
    check('詳細パネル: 案内から回答を確認できる',await page.getByText('AI 未読',{exact:true}).isVisible());
    await page.getByRole('button',{name:'その他',exact:true}).click();
    await search.fill('B4');await search.press('Enter');
    check('詳細パネル: 別のボックスを選んでも開いているタブ (More) を保つ',await page.locator('.panel.right .seg__btn').filter({hasText:/^その他$/}).getAttribute('data-on')==='true');
    await page.locator('.summary-chip').click();
    await page.getByRole('button',{name:/^Resume/}).click();
    check('Resume タブ: AI 未確認の回答が残り、サンプルの引き継ぎメモ (バックエンド) が出る',await page.getByText(/ノートの一覧・作成・削除の API まで実装済み/).first().isVisible() && await page.getByText('静的ホスティング',{exact:true}).isVisible());
    // Claims タブ: サンプルの受け持ち 3 件 (2 つのサブエージェントと codex) が、実行 ID と残り時間つきで並ぶ
    await page.getByRole('button',{name:/^Claims/}).click();
    const claimRows=(await page.locator('.claim-list .tree-row').allInnerTexts()).map((x)=>x.replace(/\s+/g,' '));
    check('Claims タブ: 受け持ちが実行 ID・残り時間つきで期限の近い順に並ぶ',claimRows.length===3 && /release-worker/.test(claimRows[0]) && claimRows.every((x)=>/残り \d+ 分/.test(x)) && claimRows.some((x)=>/api-worker/.test(x)) && claimRows.some((x)=>/test-worker/.test(x)),JSON.stringify(claimRows));
    await page.locator('.claim-list .tree-row',{hasText:'api-worker'}).click();await page.waitForTimeout(300);
    check('Claims タブ: 行を押すとそのボックス (バックエンド) が選ばれる',await page.evaluate(()=>{const s=window.boxglow.store.getState();return s.project.blocks[s.selection.blockId]?.title;})==='バックエンド');
    // Top の見出し行: 最終成果物と判断待ちの最初の問いが、倍率に関係なく固定の大きさで出る。問いを押すと Activity が開く
    await page.evaluate(()=>{const s=window.boxglow.store.getState();s.select({});s.setViewScope(null);});await page.waitForTimeout(600); // Top へ
    const strip=await page.locator('.goal-strip').innerText();
    const expectStrip=await page.evaluate(()=>{const s=window.boxglow.store.getState();const p=s.project;const outs=Object.values(p.ports).filter(q=>q.blockId==='root'&&q.direction==='out').map(q=>q.name);const pend=Object.values(p.blocks).flatMap(b=>b.decisions.filter(d=>d.answer===undefined).map(d=>d.question));return {outs,pend};});
    check('Top の見出し行: 最終成果物 (と、あれば判断待ちの問い) が出る',expectStrip.outs.every(o=>strip.includes(o)) && (expectStrip.pend.length===0 || strip.includes(expectStrip.pend[0])),strip+' / '+JSON.stringify(expectStrip));
    if(expectStrip.pend.length){await page.locator('.goal-strip__decision').click();await page.waitForTimeout(300);
    check('Top の見出し行: 問いを押すと Activity が開く',await page.evaluate(()=>window.boxglow.store.getState().selection.timeline===true));}
    await page.evaluate(()=>window.boxglow.store.getState().select({}));await page.waitForTimeout(200);

    // 今どこを作業しているか: Top では作業中を含む大項目に太い枠と「作業中: 題名」の札、タブの中では作業中のボックス自身に枠
    const topWorking=await page.locator('.bg-block.working-below').allInnerTexts();
    check('作業中の強調: Top では作業中を含む大項目に札 (作業中: バックエンド)',topWorking.length===1 && topWorking[0].includes('実装する') && topWorking[0].includes('作業中: バックエンド'),JSON.stringify(topWorking));
    await page.locator('.meta-chip.working-below').click();await page.waitForTimeout(400);
    check('作業中の強調: 札を押すと作業中のボックスが選ばれる',await page.evaluate(()=>{const s=window.boxglow.store.getState();return s.project.blocks[s.selection.blockId]?.title==='バックエンド';}));
    await page.evaluate(()=>{const s=window.boxglow.store.getState();s.select({});const b=Object.values(s.project.blocks).find(x=>x.title==='実装する');s.setViewScope(b.id);});await page.waitForTimeout(1500);
    check('作業中の強調: タブの中では作業中のボックス自身に枠が付き、大項目の札は出ない',await page.locator('.bg-block.working-now').count()===1 && (await page.locator('.bg-block.working-now .bg-block__title').first().innerText())==='バックエンド' && await page.locator('.bg-block.working-below').count()===0);
    await page.evaluate(()=>window.boxglow.store.getState().setViewScope(null));await page.waitForTimeout(800);

    // Activity の検査 (lint) のタブ: 3 組に分かれ、行を押すとボックスが選ばれる。タブの数字は必ず直すの件数
    await page.evaluate(()=>window.boxglow.store.getState().select({timeline:true}));await page.waitForTimeout(300);
    await page.locator('.panel.right .seg__btn',{hasText:'Lint'}).click();await page.waitForTimeout(300);
    const lintGroups=await page.locator('.lint-list [data-severity]').evaluateAll(es=>es.map(e=>e.dataset.severity));
    check('Activity の検査: 組に分かれて並ぶ (サンプルは着手の前に、だけ)',lintGroups.length>=1 && lintGroups.includes('later'));
    const lintCount=(await page.locator('.panel.right .seg__btn',{hasText:'Lint'}).innerText()).replace(/\D/g,'');
    check('Activity の検査: タブの数字は必ず直すの件数 (サンプルは 0)',lintCount==='0' && await page.locator('.lint-list [data-severity="error"]').count()===0);
    const firstRef=await page.locator('.lint-list .tree-row .dec-key').first().innerText();
    await page.locator('.lint-list .tree-row').first().click();await page.waitForTimeout(400);
    check('Activity の検査: 行を押すとそのボックスが選ばれる',await page.evaluate((ref)=>{const s=window.boxglow.store.getState();return s.project.blocks[s.selection.blockId]?.key===ref;},firstRef));
    await page.evaluate(()=>window.boxglow.store.getState().select({}));

    // レビューの記録の状態 (右パネル): 子を持つボックスは分解と着手準備の 2 行。なし → 確認で済 (human) → 子の説明を変えると古い (変わった部分)
    await page.evaluate(()=>{const s=window.boxglow.store.getState();const blk=Object.values(s.project.blocks).find(x=>x.title==='バックエンド');s.select({blockId:blk.id});});await page.waitForTimeout(400);
    await page.locator('.panel.right .seg__btn',{hasText:'状態'}).click();await page.waitForTimeout(200);
    const reviewRows=page.locator('.panel.right .review-state__row');
    check('レビュー: 子を持つボックスには分解と着手準備の 2 行、記録が無ければ「なし」',await reviewRows.count()===2 && (await reviewRows.first().locator('.meta-chip').innerText())==='なし');
    await reviewRows.first().getByRole('button',{name:'確認'}).click();
    await page.locator('.review-state__note input').fill('子の成果で API の実装が作れる');await page.locator('.review-state__note .btn-primary').click();await page.waitForTimeout(400);
    check('レビュー: 確認で記録され「済」になる (human)',(await reviewRows.first().locator('.meta-chip').innerText())==='済' && (await reviewRows.first().innerText()).includes('human'));
    await page.evaluate(()=>{const s=window.boxglow.store.getState();const parent=Object.values(s.project.blocks).find(x=>x.title==='バックエンド');const kid=Object.values(s.project.blocks).find(x=>x.parentId===parent.id);s.apply(p=>({...p,blocks:{...p.blocks,[kid.id]:{...p.blocks[kid.id],description:'処理を変えた'}}}));});await page.waitForTimeout(400);
    check('レビュー: 子の説明を変えると「古い」になり、変わった部分 (子の B 番号) が出る',(await reviewRows.first().locator('.meta-chip').innerText())==='古い' && /変わった: B\d+/.test(await reviewRows.first().innerText()),await reviewRows.first().innerText());
    await page.evaluate(()=>window.boxglow.store.getState().select({}));

    // 担当の一覧 (表、In charge): 左下の表示の切り替えの表の記号 → 自分を決めていないので「全員」(担当の列つき) → さとうに切り替えて未完了 2 件 → 完了済みも表示で 4 件 → 行を押すと表のまま右に詳細が開く → Esc で詳細、もう一度で表を閉じる
    await page.evaluate(()=>window.boxglow.store.getState().select({}));
    await page.locator('.canvas-tools .view-switch__table').first().click();await page.waitForTimeout(300);
    check('担当の一覧: 表を出している間も、左下の同じ切り替えが表示され、表の記号が押された状態',await page.locator('.task-table-view__switch .view-switch__table').getAttribute('aria-pressed')==='true');
    check('担当の一覧: 自分を決めていなければ「全員」で開き、担当の列が出る',await page.locator('.task-table-view select').inputValue()==='__everyone' && await page.locator('.task-table thead').getByRole('button',{name:/^担当/}).count()===1 && await page.locator('.task-table tbody tr').count()===12,String(await page.locator('.task-table tbody tr').count()));
    await page.locator('.task-table-view select').selectOption({label:'さとう'});await page.waitForTimeout(300);
    check('担当の一覧: 1 人を選ぶと担当の列は出ない',await page.locator('.task-table thead').getByRole('button',{name:/^担当/}).count()===0);
    const tableRows=(await page.locator('.task-table tbody tr').allInnerTexts()).map((x)=>x.replace(/\s+/g,' ').trim());
    // さとうの担当: 実装する (期日あり) が先頭、期日の無いものは B 番号の順。中の深い階層の箱 (GitHub OAuth の道) も出る
    check('担当の一覧: さとうの未完了の担当が期日の近い順に並ぶ (期日の無いものは後ろ)',tableRows.length===4 && /^B4 実装する/.test(tableRows[0]) && /^B7 バックエンド/.test(tableRows[1]) && /^B14 GitHub OAuth/.test(tableRows[2]) && /^B16 トークンを保存する .*実装する › バックエンド › GitHub OAuth で実装する/.test(tableRows[3]),JSON.stringify(tableRows));
    await page.locator('.task-table-view__toggle input').first().check();
    check('担当の一覧: 完了済みも表示すると、完了済みの担当も出る',await page.locator('.task-table tbody tr').count()===7);
    // 準備の列: 要具体化 (予定成果物・完了条件が無い) / 待ち n / ✓。「要具体化のみ」で絞れる
    await page.locator('.task-table-view select').selectOption('__everyone');await page.waitForTimeout(300);
    check('担当の一覧: 準備の列に要具体化が出る',await page.locator('.task-table tbody .task-table__unprepared').count()>=1 && await page.locator('.task-table thead').getByRole('button',{name:/^準備/}).count()===1);
    await page.locator('.task-table-view__toggle input').nth(1).check();await page.waitForTimeout(300);
    const onlyRough=await page.locator('.task-table tbody tr').count();
    check('担当の一覧: 「要具体化のみ」で要具体化の行だけになる',onlyRough>=1 && await page.locator('.task-table tbody .task-table__unprepared').count()===onlyRough);
    await page.locator('.task-table-view__toggle input').nth(1).uncheck();await page.locator('.task-table-view select').selectOption({label:'さとう'});await page.waitForTimeout(300);
    // 横の記号を押すと図に戻り、もう一度表の記号で開き直せる
    await page.locator('.task-table-view__switch button[aria-label="横フロー"]').click();await page.waitForTimeout(300);
    check('担当の一覧: 横の記号で図に戻る',await page.locator('.task-table-view').count()===0);
    await page.locator('.canvas-tools .view-switch__table').first().click();await page.waitForTimeout(300);
    await page.locator('.task-table-view select').selectOption({label:'さとう'});
    await page.locator('.task-table-view__toggle input').first().check();
    await page.locator('.task-table tbody tr').filter({has:page.locator('.dec-key',{hasText:/^B7$/})}).click();await page.waitForTimeout(500);
    check('担当の一覧: 行を押すと、表のまま右に詳細が開き、その行に印が付く',await page.locator('.task-table-view').count()===1 && await page.evaluate(()=>{const s=window.boxglow.store.getState();return s.project.blocks[s.selection.blockId]?.title;})==='バックエンド' && await page.locator('.task-table tbody tr[data-selected="true"]').innerText().then((x)=>x.includes('バックエンド')));
    // Esc: 1 回目は詳細だけを閉じ (表は残る)、2 回目で図に戻る
    await page.keyboard.press('Escape');await page.waitForTimeout(300);
    check('担当の一覧: 1 回目の Esc は詳細だけを閉じ、表は残る',await page.locator('.task-table-view').count()===1 && await page.evaluate(()=>window.boxglow.store.getState().selection.blockId)===null);
    await page.keyboard.press('Escape');await page.waitForTimeout(300);
    check('担当の一覧: 2 回目の Esc で図に戻る',await page.locator('.task-table-view').count()===0);
    // 狭い幅: ボックスを選んで開いた詳細パネルは、枠付きの大きな「× 閉じる」で閉じられる (指で押せる 44px 以上)
    await page.evaluate(()=>{const s=window.boxglow.store.getState();const b=Object.values(s.project.blocks).find((x)=>x.title==='設計する');s.select({blockId:b.id});});await page.waitForTimeout(400);
    const closeBox=await page.locator('.panel.right .panel-close').first().boundingBox();
    check('狭い幅 (390px): 詳細パネルの閉じるボタンは「閉じる」と書かれ、44px 以上の大きさ',await page.locator('.panel.right .panel-close__label').first().isVisible() && (await page.locator('.panel.right .panel-close').first().innerText()).includes('閉じる') && closeBox.height>=44 && closeBox.width>=44,JSON.stringify(closeBox));
    await page.locator('.panel.right .panel-close').first().click();await page.waitForTimeout(300);
    check('狭い幅 (390px): 「閉じる」で詳細パネルが閉じる',await page.evaluate(()=>window.boxglow.store.getState().selection.blockId)===null);
    // 大項目のタブの入出力ノードをダブルクリックすると、Top に戻る (通常の幅で確かめる。狭い幅では 1 回目のクリックで開く詳細パネルが図を覆うため)
    await page.setViewportSize({width:1280,height:844});
    await page.evaluate(()=>window.boxglow.store.getState().select({}));
    await page.locator('.canvas-tab',{hasText:'実装する'}).first().click();await page.waitForTimeout(1500);
    await page.getByRole('button',{name:'Fit',exact:true}).click();await page.waitForTimeout(800);
    await page.locator('.react-flow__node-terminal').first().dblclick();await page.waitForTimeout(500);
    check('タブの入出力ノード: ダブルクリックで Top に戻る',await page.evaluate(()=>window.boxglow.store.getState().viewScope)===null);
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
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
