/**
 * 入力: run.sh のローカル preview とデモ計画。出力: check/result による成否と、失敗時の終了コード 1。
 * 前半はブラウザ操作でツリーの選択・管理・Undo を検査する。モデルの値も読み、見た目だけの成功を避ける。
 * 後半は同期状態の表示用データをストアへ渡す。通信の検査ではなく、5 群の表示と狭い幅を確認する。
 * 実際の送受信・競合・資格情報は sync.cjs / vscode-sync.cjs とローカル試験サーバーが担当する。
 */
const { chromium, open, check, result } = require("./lib.cjs");
/** 入力: 上記のローカル環境。出力: Promise<void>。途中で失敗しても finally で起動したブラウザを閉じる。 */
(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const { page, errors } = await open(browser, { query: "?demo=1&lang=ja" });
    await page.locator(".tree-toggle").click();
    check("Tree: 専用ボタンで開く", await page.locator(".tree-panel").isVisible());
    // 一度開いた後に再読込し、同じブラウザの記憶から復元されることを確認する。
    await page.reload();
    await page.waitForSelector(".tree-panel");
    check("Tree: 開いた状態を記憶する", (await page.locator(".tree-toggle").getAttribute("aria-pressed")) === "true");
    // デモの ID は生成されるため固定値に依存しない。内部 ID・階層・題名だけを検査側へ取り出す。
    const ids = await page.evaluate(() => {
      const p = window.boxglow.store.getState().project;
      return Object.values(p.blocks)
        .filter((b) => b.id !== "root")
        .map((b) => ({ id: b.id, title: b.title, parentId: b.parentId, kind: b.kind }));
    });
    const parent = ids.find((b) => b.kind === "project");
    /** 入力: 内部 ID (string)。出力: 対応するツリー行の Playwright Locator。毎回現在の DOM を参照する。 */
    const row = (id) => page.locator(`.tree-row[data-block-id="${id}"]`);
    check("Tree: 開閉ボタンは文字のないアイコン", !(await page.locator(".tree-toggle").textContent()).trim());
    // 実際に矢印キーを送り、展開とフォーカスの移動を区別する。DOM の activeElement で判定する。
    await page.getByRole("button", { name: "すべて折りたたむ", exact: true }).click();
    check("Tree: 全体を1回で畳める", (await page.locator(".tree-row").count()) === 1);
    await row(parent.id).focus();
    await page.keyboard.press("ArrowRight");
    check("Tree: 右キーで子を開く", (await page.locator(".tree-row").count()) > 1);
    await page.keyboard.press("ArrowDown");
    check(
      "Tree: 下キーで次の行へ移る",
      (await page.evaluate(() => document.activeElement?.getAttribute("data-block-id"))) !== parent.id,
    );
    await page.keyboard.press("ArrowLeft");
    check(
      "Tree: 左キーで親へ戻る",
      (await page.evaluate(() => document.activeElement?.getAttribute("data-block-id"))) === parent.id,
    );
    await page.keyboard.press("ArrowLeft");
    check("Tree: 左キーで親を畳む", (await page.locator(".tree-row").count()) === 1);
    await page.getByRole("button", { name: "すべて展開", exact: true }).click();
    check("Tree: 全体を1回で開ける", (await page.locator(".tree-row").count()) === ids.length);
    check(
      "Tree: 階層線と1行の高さ",
      await row(ids.find((b) => b.parentId === parent.id).id).evaluate(
        (el) =>
          el.getBoundingClientRect().height <= 30 && el.querySelector(".tree-guides").getBoundingClientRect().width > 0,
      ),
    );
    await row(parent.id).focus();
    await page.keyboard.press("Shift+F10");
    check("Tree: キーボードから管理操作を開く", await page.locator(".tree-actions").isVisible());
    await page.keyboard.press("Escape");
    check(
      "Tree: 操作を閉じると元の行へ戻る",
      (await page.evaluate(() => document.activeElement?.getAttribute("data-block-id"))) === parent.id,
    );
    // Escape で入力欄を外すと blur も起きる。取り消した文字列が誤って保存されないことを確認する。
    await page.keyboard.press("F2");
    await page.locator(".tree-title-input").fill("Cancelled rename");
    await page.keyboard.press("Escape");
    check(
      "Tree: F2の改名をEscapeで取り消せる",
      (await page.evaluate((id) => window.boxglow.store.getState().project.blocks[id].title, parent.id)) ===
        parent.title,
    );
    await row(parent.id).locator(".tree-row__menu").click();
    // 以下は同じデモ内で子・兄弟を作り、管理操作の前後をモデルと照合する。
    await page.getByRole("button", { name: "子を追加", exact: true }).click();
    const input = page.locator(".tree-title-input");
    await input.fill("Tree E2E");
    await input.press("Enter");
    const child = await page.evaluate(
      () => Object.values(window.boxglow.store.getState().project.blocks).find((b) => b.title === "Tree E2E").id,
    );
    check("Tree: 追加して名前を編集する", (await row(child).getAttribute("data-selected")) === "true");
    check(
      "Tree: 図にも同じ選択を伝える",
      await page.evaluate((id) => window.boxglow.store.getState().selection.blockId === id, child),
    );
    await row(child).locator(".tree-row__menu").click();
    await page.getByRole("button", { name: "兄弟を追加", exact: true }).click();
    await input.fill("Tree sibling");
    await input.press("Enter");
    const sibling = await page.evaluate(
      () => Object.values(window.boxglow.store.getState().project.blocks).find((b) => b.title === "Tree sibling").id,
    );
    check(
      "Tree: 兄弟を追加する",
      await page.evaluate(({ id, parent }) => window.boxglow.store.getState().project.blocks[id].parentId === parent, {
        id: sibling,
        parent: parent.id,
      }),
    );
    await row(child).locator(".tree-row__menu").click();
    await page.getByRole("button", { name: "親を変更", exact: true }).click();
    await page.getByLabel("移動先", { exact: true }).selectOption(sibling);
    await page.getByRole("button", { name: "移動", exact: true }).click();
    check(
      "Tree: 親を変更する",
      await page.evaluate(({ id, parent }) => window.boxglow.store.getState().project.blocks[id].parentId === parent, {
        id: child,
        parent: sibling,
      }),
    );
    await row(child).locator(".tree-row__menu").click();
    await page.locator(".tree-actions").getByRole("button", { name: "Done", exact: true }).click();
    check(
      "Tree: 状態を変える",
      await page.evaluate((id) => window.boxglow.store.getState().project.blocks[id].status === "white", child),
    );
    await page.locator(".tree-actions").getByLabel("閉じる", { exact: true }).click();
    await row(sibling).locator(".tree-branch").click();
    check("Tree: 枝を畳む", (await row(child).count()) === 0);
    // 図の該当階層を開いて実際にクリックする。ツリー側で閉じた枝が開くことを確認する。
    await page.evaluate((id) => {
      const s = window.boxglow.store.getState();
      s.select({});
      s.setViewScope(id);
    }, sibling);
    await page.locator(`.react-flow__node[data-id="${child}"] .bg-block__title`).click();
    await row(child).waitFor();
    check("Tree: 図の選択で祖先が開く", (await row(child).getAttribute("data-selected")) === "true");
    await row(sibling).locator(".tree-row__menu").click();
    // 削除確認は取消と承認の両方を通す。対象はこの試験で作った兄弟と子だけ。
    page.once("dialog", (d) => d.dismiss());
    await page.locator(".tree-actions").getByRole("button", { name: "削除", exact: true }).click();
    check("Tree: 削除を取消できる", (await row(child).count()) === 1);
    page.once("dialog", (d) => d.accept());
    await page.locator(".tree-actions").getByRole("button", { name: "削除", exact: true }).click();
    check(
      "Tree: 子も含めて削除する",
      await page.evaluate(
        (ids) => ids.every((id) => !window.boxglow.store.getState().project.blocks[id]),
        [child, sibling],
      ),
    );
    // ツリーにフォーカスがある状態でも、Ctrl+Z が上位の Undo に届くことを検査する。
    await page.locator(".tree-panel__head button").first().focus();
    await page.keyboard.press("Control+z");
    check("Tree: 削除をUndoで戻す", (await row(child).count()) === 1);
    await page.getByTitle("絞り込み / メンバー / 部品", { exact: true }).click();
    check(
      "Tree: オプションと独立して開く",
      (await page.locator(".drawer").isVisible()) && (await page.locator(".tree-panel").isVisible()),
    );
    // 状態が一致する子へたどれるよう、親自身が不一致でも祖先の行が残ることを確認する。
    const beforeFilter = await page.locator(".tree-row").count();
    await page.locator(".drawer .chip").filter({ hasText: "Done" }).click();
    check(
      "Tree: 状態フィルタで絞り込み親を残す",
      (await page.locator(".tree-row").count()) < beforeFilter && (await row(parent.id).count()) === 1,
    );
    await page.locator(".drawer .chip").filter({ hasText: "Done" }).click();
    await page.locator('.drawer .panel-close').first().click();
    // 大きな計画はモデルの形を保った表示用データを渡し、一覧を開く時間を測る。
    await page.locator(".tree-toggle").click();
    await page.evaluate(() => {
      const s = window.boxglow.store.getState();
      const p = structuredClone(s.project);
      const parent = Object.values(p.blocks).find((b) => b.kind === "project");
      const sample = Object.values(p.blocks).find((b) => b.id !== "root" && b.kind !== "project");
      for (let n = 0; n < 500; n++)
        p.blocks["tree-bench-" + n] = {
          ...sample,
          id: "tree-bench-" + n,
          key: "T" + n,
          title: "Task " + n,
          parentId: sample.id,
          position: { x: 0, y: n * 100 },
          decisions: [],
          activity: null,
        };
      s.openProjectObject(p, true);
    });
    // 描画時間だけを測るため、試験データの生成と計画の差し替えは計測開始前に終える。
    const start = Date.now();
    await page.locator(".tree-toggle").click();
    await page.locator(".tree-row").last().waitFor();
    check("Tree: 500件の一覧を3秒以内に開く", Date.now() - start < 3000, String(Date.now() - start) + " ms");
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 850 });
      check(
        "Tree: " + width + "pxに収まる",
        await page.locator(".tree-panel").evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth;
        }),
      );
    }
    await page.evaluate(() => window.boxglow.store.getState().setMode({ readonly: true }));
    check("Tree: 閲覧専用では編集操作なし", (await page.locator(".tree-row__menu").count()) === 0);
    check("Tree: 画面エラーなし", errors.length === 0, errors.join("\n"));
    await page.close();
    // 翻訳で文字幅が変わっても、12 状態が同じ 5 群にまとまり、画面外にはみ出さないことを確認する。
    for (const lang of ["ja", "en"])
      for (const width of [1280, 320, 390]) {
        const { page } = await open(browser, { query: `?demo=1&lang=${lang}` });
        await page.setViewportSize({ width, height: 850 });
        const states = [
          "synced",
          "unsent",
          "syncing",
          "halted",
          "problem",
          "offline",
          "paused",
          "external",
          "unsupported",
          "off",
          "signed-out",
          "unbound",
        ];
        const labels = new Set();
        for (const state of states) {
          // 通信を起こさない固定状態。サインイン用の秘密・実際のアカウント・結び付けは渡さない。
          await page.evaluate(
            (state) =>
              window.boxglow.store.setState({
                syncLost: false,
                syncStatus: {
                  session: "test",
                  seq: 1,
                  state,
                  support: state === "unsupported" ? "unsupported-platform" : "ok",
                  owner: "self",
                  credentials: { source: "none" },
                  file: null,
                  revision: null,
                },
              }),
            state,
          );
          labels.add(await page.locator(".sync-chip").textContent());
          if ((await page.locator(".sync-chip").getAttribute("aria-expanded")) !== "true")
            await page.locator(".sync-chip").click();
          const fits = await page.locator(".sync-panel").evaluate((el) => {
            const r = el.getBoundingClientRect();
            return r.left >= 0 && r.right <= innerWidth + 1;
          });
          if (!fits) throw new Error(`sync overflow: ${state}/${lang}/${width}`);
        }
        check(`Sync: 12状態を5表示に整理し収まる ${lang}/${width}`, labels.size === 5);
        await page.keyboard.press("Escape");
        check(`Sync: Escapeで閉じる ${lang}/${width}`, (await page.locator(".sync-panel").count()) === 0);
        await page.close();
      }
  } finally {
    await browser.close();
  }
  console.log("Tree / Sync UI:", result());
  if (result().failed) process.exitCode = 1;
  // 非同期の例外も検査失敗としてプロセスへ伝える。表示だけして成功終了にはしない。
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
