/**
 * 状態と操作結果の回帰検査。サンプルと表示用fixtureだけを使い、同期の通信は既存sync.cjsで検査する。
 * Input: プレビューとPlaywright。Output: 日英・明暗・狭い幅の操作結果。
 */
const { chromium, open, check, result } = require('./lib.cjs');
(async () => {
  const browser = await chromium.launch();
  try {
    for (const lang of ['ja', 'en']) for (const theme of ['light', 'dark']) {
      const {page,errors} = await open(browser,{lang,query:`?demo=1&lang=${lang}&theme=${theme}`});
      page.setDefaultTimeout(10000);
      const ja=lang==='ja'; const prefix=`${lang}/${theme}`;
      await page.setViewportSize({width:420,height:800});
      check(`${prefix}: 横スクロール前から操作メニューに届く`, await page.locator('.topbar-pinned').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
      await page.getByRole('button',{name:'Menu',exact:true}).click();
      await page.locator('.menu-actions').getByRole('button',{name:'+ Block',exact:true}).click();
      await page.waitForSelector('.inspector-body');
      check(`${prefix}: 2回の操作でボックスを追加し詳細を開く`,await page.locator('.inspector-body').isVisible());
      check(`${prefix}: 詳細タブの既存の英語名を保つ`, await page.getByRole('button',{name:'Status',exact:true}).isVisible() && await page.getByRole('button',{name:'More',exact:true}).isVisible());
      await page.locator('.panel.right').getByRole('button',{name:/Done$/}).click();
      check(`${prefix}: 状態変更が選択の表示に出る`, await page.locator('.panel.right').getByRole('button',{name:/Done$/}).evaluate(e=>e.getAttribute('aria-pressed')==='true'));
      // 子を持たないボックスは確認なしで消え (Undo で戻せる。VS Code の webview では confirm が使えない)、復元の案内が出る
      const addedId=await page.evaluate(()=>window.boxglow.store.getState().selection.blockId);
      await page.locator('.inspector-body > div:first-child > .relative > button').click();
      let dialogs=0; page.on('dialog',async d=>{dialogs++;await d.accept();});
      await page.locator('.inspector-body').getByRole('button',{name:'Delete',exact:true}).click();
      check(`${prefix}: 単独ボックスは確認なしで削除され、復元の案内が出る`,dialogs===0 && !await page.evaluate(id=>!!window.boxglow.store.getState().project.blocks[id],addedId) && (await page.locator('.toast').innerText()).includes(ja?'元に戻す':'Undo'));
      await page.getByRole('button',{name:'Menu',exact:true}).click();
      await page.locator('.menu-actions').getByRole('button',{name:'Undo',exact:true}).click();
      check(`${prefix}: 案内した元に戻す操作で削除を復元できる`,await page.evaluate(id=>!!window.boxglow.store.getState().project.blocks[id],addedId));
      // 保存結果はfixtureで切り替え、ローカル保存と同期を混同していないか確認する。
      await page.evaluate(()=>window.boxglow.store.setState({ephemeral:false,source:'idb',fileName:null,saveState:'saving',saveError:null}));
      check(`${prefix}: 保存中を成功扱いしない`,(await page.locator('.save-chip').innerText()).includes('Saving'));
      await page.evaluate(()=>window.boxglow.store.setState({saveState:'unsaved',saveError:'保存失敗fixture'}));
      check(`${prefix}: 保存エラーを色だけに頼らず表示`,(await page.locator('.save-chip').innerText()).includes('Save failed'));
      await page.evaluate(()=>window.boxglow.store.setState({saveState:'saved',saveError:null,selection:{},syncStatus:{
        session:'fixture',seq:1,support:'ok',credentials:{source:'stored',account:{accountId:'test',display:'review-user',signedInWith:'github',billing:{required:true,entitled:true,plan:'personal',status:'active',seats:1,periodEnd:null,checkout:false,portal:false}}},owner:'self',
        file:{path:'review.boxglow.json',enabled:true,binding:{server:'http://127.0.0.1',remoteId:'test'}},state:'unsent',revision:'1',server:'http://127.0.0.1'
      }}));
      check(`${prefix}: 保存済みでも送信待ちは別の状態`,(await page.locator('.save-chip').innerText()).includes('Saved') && (await page.locator('.sync-chip').innerText()).includes(ja?'送信待ち':'Waiting to send'));
      await page.locator('.sync-chip').click();
      check(`${prefix}: 420pxで同期パネルが画面内`,await page.locator('.sync-popover').evaluate(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
      // 操作を保留できるホストfixtureで、押下直後と失敗時の表示を検査する。
      await page.evaluate(()=>{window.__uiCalls=[];window.boxglow.store.setState({syncAct:async a=>{window.__uiCalls.push(a);await new Promise(r=>window.__uiRelease=r);window.boxglow.store.setState({syncStatus:{...window.boxglow.store.getState().syncStatus,state:'offline'}});}});});
      await page.getByRole('button',{name:ja?'今すぐ同期':'Sync now',exact:true}).click();
      check(`${prefix}: 応答前から処理中と無効を示す`,await page.locator('.sync-panel button[aria-busy="true"]').isDisabled());
      await page.evaluate(()=>window.__uiRelease());
      await page.waitForFunction(()=>window.boxglow.store.getState().syncStatus.state==='offline');
      check(`${prefix}: 同期失敗を成功通知にしない`,!(await page.locator('.toast').allTextContents()).join('').includes(ja?'サーバーと最新':'Checked the latest'));
      check(`${prefix}: 同期失敗の対処を示す`,(await page.locator('.sync-panel').innerText()).toLowerCase().includes(ja?'再試行':'retry'));
      await page.evaluate(()=>window.boxglow.store.setState({syncAct:async a=>{window.__uiCalls.push(a);window.boxglow.store.setState({syncStatus:{...window.boxglow.store.getState().syncStatus,seq:window.boxglow.store.getState().syncStatus.seq+1,state:'synced'}});}}));
      await page.getByRole('button',{name:ja?'今すぐ同期':'Sync now',exact:true}).click();
      check(`${prefix}: 同期完了後に確認結果を通知`,(await page.locator('.toast').innerText()).includes(ja?'サーバーと最新':'Checked the latest'));
      check(`${prefix}: 操作の意味はsyncNowのまま`,await page.evaluate(()=>window.__uiCalls.length===2&&window.__uiCalls.every(a=>a.kind==='syncNow')));
      check(`${prefix}: 詳細を開く前から契約プランが分かる`,(await page.locator('.sync-account__plan').innerText()).includes('Personal'));
      await page.evaluate(()=>window.boxglow.store.setState({syncAct:async a=>{window.__uiCalls.push(a);}}));
      await page.getByRole('button',{name:ja?'今すぐ同期':'Sync now',exact:true}).click();
      check(`${prefix}: 応答のない要求を古い同期済みで成功扱いしない`,(await page.locator('.toast').innerText()).includes(ja?'同期を要求しました':'Sync requested'));
      await page.locator('.account-button').click();
      check(`${prefix}: サインアウトは右上のアカウントから 1 回で、何が起きるかはツールチップで分かる`,((await page.locator('.account-menu').getByRole('button',{name:ja?'サインアウト':'Sign out',exact:true}).getAttribute('title'))||'').includes(ja?'手元の計画は残ります':'local plans remain'));
      await page.keyboard.press('Escape');
      // アカウントのメニューを開いた時点で同期パネルは (外側の操作で) 閉じているので、開き直す
      if ((await page.locator('.sync-popover').count()) === 0) await page.locator('.sync-chip').click();
      await page.evaluate(()=>window.boxglow.store.setState({syncStatus:{...window.boxglow.store.getState().syncStatus,state:'unbound',file:{path:'review.json',enabled:false,binding:null},startup:{operationId:'test',stage:'choose'}}}));
      check(`${prefix}: 送る・受け取るの違いを押す前に示す`,(await page.locator('.sync-startup__choices').innerText()).includes(ja?'ほかの端末':'another device') && (await page.locator('.sync-startup__choices').innerText()).includes(ja?'一覧':'list'));
      check(`${prefix}: 同期開始の選択肢は縦並びで折り返せる`,await page.locator('.sync-startup__choices').evaluate(e=>{const a=e.children[0].getBoundingClientRect(),b=e.children[1].getBoundingClientRect();return b.top>=a.bottom&&b.right<=innerWidth;}));
      check(`${prefix}: 画面例外なし`,errors.length===0,errors.join(';'));
      await page.context().close();
    }
  } finally {await browser.close();}
  const r=result();console.log(JSON.stringify(r));if(r.failed)process.exitCode=1;
})().catch(e=>{console.error(e);process.exit(1);});
