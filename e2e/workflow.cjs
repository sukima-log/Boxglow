/**
 * 着手候補・範囲・鮮度の画面検査。ブラウザ内のサンプルだけを編集し、開発計画は変更しない。
 * Input: e2e/run.sh のプレビューと Playwright / Output: 日本語の検査結果。
 */
const {chromium,open,check,result}=require('./lib.cjs');
(async()=>{
  const browser=await chromium.launch();
  try {
    for(const theme of ['light','dark']) {
      const {page,errors}=await open(browser,{query:'?demo=1&lang=ja&theme='+theme});
      await page.waitForFunction(()=>window.boxglow?.store?.getState().project);
      // 公開のサンプルに、今回追加した任意項目を持たせる。
      await page.evaluate(()=>{
        const s=window.boxglow.store.getState();
        s.apply(original=>{
          const p=structuredClone(original), boxes=Object.values(p.blocks);
          const b=key=>boxes.find(x=>x.key===key);
          // (サンプルには、受け持ちと詰まりの例も入っている。この検査は候補の並べ方を見るので、それらを外して始める)
          delete p.claims;delete p.claimPolicy;for(const x of boxes) if(x.activity?.state==='blocked') x.activity=null;
          p.focusBlockId=b('B4').id;
          b('B6').status='black';
          b('B5').activity=null;b('B5').decisions=[];
          b('B8').scope={goal:'APIを接続する',nonGoals:'課金は扱わない',acceptance:'結合テスト成功',consult:'API仕様の変更'};
          b('B2').description='未コミット。レビュー待ち';
          b('B2').descriptionUpdatedAt='2026-10-01T00:00:00Z';
          b('B2').statusChangedAt='2026-10-02T00:00:00Z';
          p.handoffs={[b('B2').id]:{note:'以前の公開状況',actor:'codex',at:'2026-10-01T00:00:00Z'}};
          p.workflowPolicy={startWithoutInputs:'reject',doneWithoutArtifacts:'reject'};
          return p;
        });
      });
      await page.locator('.summary-chip').click();await page.getByRole('button',{name:/^Next/}).click();
      const next=page.locator('.next-candidates');
      check(theme+' Next: 今回の範囲を先に、着手できる・入力待ちを分ける',(await next.innerText()).includes('今回の範囲 · 着手できる')&&(await next.innerText()).includes('今回の範囲 · 入力待ち'));
      check(theme+' Next: 不足する入力名を一覧に表示する',(await next.innerText()).includes('API の実装')&&(await next.innerText()).includes('テストデータ'));
      const headings=await next.locator('h3').allTextContents();
      check(theme+' Next: 将来の候補は別の組で後ろに出す',headings.at(-1).startsWith('その他の候補'));
      await next.getByRole('button',{name:/B8/}).click();
      const scope=page.locator('.work-scope');
      check(theme+' 範囲: 記入済みでも本文は既定で畳む',await scope.isVisible()&&(await scope.locator('details').getAttribute('open'))===null);
      await scope.locator('summary').click();
      check(theme+' 範囲: 4項目の内容を読める',(await scope.innerText()).includes('課金は扱わない')&&(await scope.innerText()).includes('API仕様の変更'));
      await page.screenshot({path:'/tmp/boxglow-scope-'+theme+'.png'});
      await page.locator('.panel.right button[title="その他"]').click();
      await page.getByRole('button',{name:'作業範囲を編集',exact:true}).click();
      const goal=page.getByLabel('今回達成すること',{exact:true});await goal.fill('APIと画面の接続');await goal.blur();
      await page.waitForFunction(()=>Object.values(window.boxglow.store.getState().project.blocks).find(b=>b.key==='B8').scope.goal==='APIと画面の接続');
      check(theme+' 範囲: 人が詳細パネルで編集し保存できる',true);
      await page.getByRole('button',{name:'閉じる',exact:true}).click();
      await page.locator('.panel.right button[title^="Done:"]').click();
      check(theme+' 人の操作: rejectでも成果物なしのDoneを拒否しない',await page.evaluate(()=>Object.values(window.boxglow.store.getState().project.blocks).find(b=>b.key==='B8').status==='white'));
      const search=page.getByRole('textbox',{name:'ブロックを検索'});
      await search.fill('B3');await search.press('Enter');
      check(theme+' 範囲: 内容がないボックスには新しい欄を出さない',await page.locator('.work-scope').count()===0);
      await search.fill('B2');await search.press('Enter');
      check(theme+' 鮮度: Done後も古い説明を消さず見直しを促す',await page.locator('.description-reminder').isVisible());
      await page.getByRole('button',{name:'その他',exact:true}).click();
      check(theme+' 鮮度: 説明の記録日時と状態変更より前という表示がある',(await page.locator('.panel.right').innerText()).includes('2026-10-01')&&(await page.locator('.panel.right').innerText()).includes('状態の変更より前'));
      await page.locator('.summary-chip').click();await page.getByRole('button',{name:/^Resume/}).click();
      check(theme+' Resume: 完了した引き継ぎは本文を隠し件数だけ出す',await page.getByRole('button',{name:'完了済みの引き継ぎ (1)',exact:true}).isVisible()&&await page.getByText('以前の公開状況',{exact:true}).count()===0);
      await page.getByRole('button',{name:'完了済みの引き継ぎ (1)',exact:true}).click();
      check(theme+' Resume: 明示的に展開すると本文と鮮度が読める',await page.getByText('以前の公開状況',{exact:true}).isVisible()&&(await page.locator('.resume-card').innerText()).includes('状態の変更より前'));
      check(theme+' 画面: 実行時エラーなし',errors.length===0,errors.join(';'));
      await page.context().close();
    }
    const {page,errors}=await open(browser,{query:'?demo=1&lang=en',lang:'en'});
    await page.locator('.project-name').click();await page.locator('.workflow-settings summary').click();
    const settings=page.locator('.workflow-settings');
    check('英語: 計画設定の既定はWarnで、新しい文言は英語',await settings.getByLabel('Start with missing inputs',{exact:true}).inputValue()==='warn'&&(await settings.innerText()).includes('Human actions are never rejected'));
    await settings.getByLabel('Finish without artifacts',{exact:true}).selectOption('reject');
    check('英語: 計画ごとの拒否を画面から選べる',await page.evaluate(()=>window.boxglow.store.getState().project.workflowPolicy.doneWithoutArtifacts==='reject'));
    check('英語: 実行時エラーなし',errors.length===0,errors.join(';'));await page.context().close();
  } finally {await browser.close();}
  const r=result();console.log(JSON.stringify(r));if(r.failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
