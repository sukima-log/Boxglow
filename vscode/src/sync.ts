/**
 * VS Code の拡張から、画面からの同期を使う (設計: docs/private/SYNC_GUI_DESIGN.md 2.5 / 4 章)
 *   - 同期の裏方 (SyncHost) を、拡張の中で動かす (サーバーごとに 1 つ。開いているパネルで共有)
 *   - webview へ { type: "sync-status", status } を送り、{ type: "sync-action", action } を受ける
 *   - 有効にした計画は globalState に持つ (キー = 拡張ホストの識別 + ファイルの URI + サーバー。Settings Sync の対象にしない)
 *   - 受け取りがディスクを書いた後: ドキュメントが dirty なら、受け取った中身を「衝突」として画面へ (未保存の編集は捨てない)。
 *     clean なのに VS Code が追い付かない間は、受け取った中身を確認用 (fromDisk) として画面へ送る (編集用の基準は進めない)
 *   - 退避: 画面にだけある未保存の中身を、保存ダイアログで別のファイルに書く (元のファイルは選べない)。書けたことを確かめてから応答する
 */
import * as vscode from "vscode";
import { existsSync, readFileSync, realpathSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { parseHostAction, SyncHost, type SyncStatus } from "../../cli/sync/host";

/** サーバーごとの裏方 (拡張の中で 1 つずつ) */
const hosts = new Map<string, { host: SyncHost; panels: Map<string, Set<vscode.WebviewPanel>> }>();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };

/** 設定の同期サーバー (空なら、画面からの同期は使わない) */
export function syncServerOf(): string | null {
  const server = String(vscode.workspace.getConfiguration("boxglow").get("sync.server") ?? "").trim();
  return server || null;
}
/** 有効にした計画の記憶のキー (別の Remote 環境の同じパスや、別のサーバーには引き継がない) */
const enabledKey = (uri: vscode.Uri, server: string) => `boxglow.sync.enabled:${vscode.env.remoteName ?? "local"}:${uri.toString()}:${server}`;

/**
 * パネル 1 つを、同期の裏方につなぐ
 * Input : context, document, panel, hooks = { postConflict (受け取った中身を衝突として画面へ), postFromDisk (確認用として画面へ) }
 * Output: 片付けの関数 (パネルを閉じたときに呼ぶ)
 */
export function attachSync(context: vscode.ExtensionContext, document: vscode.TextDocument, panel: vscode.WebviewPanel
, hooks: { postConflict: (text: string) => void; postFromDisk: (text: string) => void }): () => void {
  const server = syncServerOf();
  if (!server) return () => {};
  const path = real(document.uri.fsPath);
  let entry = hosts.get(server);
  if (!entry) {
    const panels = new Map<string, Set<vscode.WebviewPanel>>();
    const host = new SyncHost({ server, deviceName: `vscode-${vscode.env.machineId.slice(0, 8)}`, onStatus: (status) => {
      const target = status.file?.path;
      if (!target) return;
      for (const p of panels.get(target) ?? []) void p.webview.postMessage({ type: "sync-status", status });
    } });
    entry = { host, panels };
    hosts.set(server, entry);
  }
  const { host, panels } = entry;
  // (裏方の開く・閉じるは、そのファイルの最初の画面と最後の画面でだけ呼ぶ。画面ごとに呼ぶと、閉じた後も参照数が残る。R39-04)
  if (!panels.has(path)) { panels.set(path, new Set()); host.openFile(path); }
  panels.get(path)!.add(panel);
  if (context.globalState.get<boolean>(enabledKey(document.uri, server))) host.enable(path);

  // ---- エディタの保存済みの中身 (退避の基準に使う) ----
  // エディタに未保存の編集があると、画面はその中身を受け取り、画面の基準もそこへ進む。退避の基準がそれだと、
  // エディタの未保存の編集が「基準からの変更」に見えず、取り込みで失われる (実機の検査で見つけた)。
  // そこで、エディタが clean だった最後の中身 (= 保存済みのディスクの中身) を覚えておき、dirty のときの退避の基準にする
  let savedText: string | null = null;
  if (!document.isDirty) savedText = document.getText();
  else { try { savedText = readFileSync(document.uri.fsPath, "utf8"); } catch { savedText = null; } }
  // (エディタの中身が変わり、clean に見えるとき (ディスクからの読み直し・元に戻す): ディスクと同じと確かめてから覚える。
  //  変更の通知の時点では、最初の 1 文字の編集でも isDirty がまだ false のことがある。実機の検査で見つけた)
  const savedWatch = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document !== document || document.isDirty) return;
    try {
      const disk = readFileSync(document.uri.fsPath, "utf8");
      if (disk.replace(/\r\n/g, "\n") === document.getText().replace(/\r\n/g, "\n")) savedText = disk;
    } catch { /* 読めなければ、前の保存済みの中身のまま */ }
  });
  const savedOnSave = vscode.workspace.onDidSaveTextDocument((d) => { if (d === document) savedText = document.getText(); });

  // ---- 画面からの操作 ----
  const messages = panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "sync-action") {
      const action = parseHostAction(JSON.stringify(msg.action ?? null));
      if (!action) return;
      if (action.kind === "enable") await context.globalState.update(enabledKey(document.uri, server), true);
      if (action.kind === "disable") await context.globalState.update(enabledKey(document.uri, server), undefined);
      const status = await host.act(path, action);
      void panel.webview.postMessage({ type: "sync-status", status });
      return;
    }
    // 画面が読み込みを終えた (ready) / 状態を求めた: 今の状態を送る。最初の状態は、画面が受け取れる前に送ってしまうことがあるため (実機の VS Code で見つけた)
    if (msg?.type === "ready" || msg?.type === "sync-status-request") { void panel.webview.postMessage({ type: "sync-status", status: host.status(path) }); return; }
    // 退避: 画面にだけある未保存の中身を、別のファイルへ書く。書けたことを確かめてから、その中身のハッシュと場所を返す
    if (msg?.type === "evacuate" && typeof msg.text === "string" && typeof msg.requestId === "string") {
      const suggested = vscode.Uri.file(`${dirname(document.uri.fsPath)}/${basename(document.uri.fsPath, ".json")}.unsaved-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      const target = await vscode.window.showSaveDialog({ defaultUri: suggested, filters: { JSON: ["json"] }, saveLabel: "退避 / Save a copy" });
      // 復旧用の形式で書く (R39-05): 画面の中身 (G)・統合の基準・受け取った最新の中身 (R)・エディタ側の未保存の中身 (画面と違うときだけ) と、その版
      // エディタの版は、書き出す時点のもの (この後にエディタが編集されたら、画面は「退避済み」ではなくなる)
      const editorVersion = document.version;
      const editorText = document.getText();
      const lf = (v: string) => v.replace(/\r\n/g, "\n");
      const recovery = {
        boxglowRecovery: 1, savedAt: new Date().toISOString(), file: document.uri.fsPath
      // (基準: エディタに未保存の編集があれば、保存済みの中身。無ければ、画面が元にした中身)
      , base: document.isDirty && savedText !== null ? savedText : typeof msg.base === "string" ? msg.base : null
      , received: typeof msg.received === "string" ? msg.received : null
      , gui: { text: msg.text, hash: sha(msg.text) }
      , editor: document.isDirty && lf(editorText) !== lf(msg.text) ? { text: editorText, version: editorVersion, hash: sha(editorText) } : null
      };
      const body = JSON.stringify(recovery, null, 2) + "\n";
      const reply = (ok: boolean, detail: string, at?: string) => panel.webview.postMessage({ type: "evacuated", requestId: msg.requestId, ok, hash: sha(msg.text), editorVersion, path: at, detail });
      if (!target) { void reply(false, "cancelled"); return; }
      // 元のファイル (とその実体) には書かない
      if (real(target.fsPath) === path) { void reply(false, "same-file"); return; }
      try {
        writeFileSync(target.fsPath, body, "utf8");
        if (readFileSync(target.fsPath, "utf8") !== body) { void reply(false, "verify-failed"); return; }
        void reply(true, "", target.fsPath);
      } catch (e) { void reply(false, e instanceof Error ? e.message : String(e)); }
      return;
    }
    // 最新のファイルを開く (保存の衝突で、画面が退避を済ませた後に頼む): エディタの未保存の編集を捨てて、ディスクの中身を読み直す。
    //   Input : { requestId, editorVersion = 退避したときのエディタの版 }
    //   Output: opened-latest { ok, text (読み直したエディタの中身), version, detail (断った理由) }
    //   退避した後にエディタが編集されていたら (版が違う)、その編集は退避に入っていないので、読み直さない。
    //   保存ではなく読み直し (revert) にする: 保存すると、VS Code が「ディスクの方が新しい」と断る。待つ間に受け取った新しい中身を古い中身で上書きするおそれもある
    if (msg?.type === "open-latest" && typeof msg.requestId === "string") {
      const reply = (ok: boolean, detail: string) => panel.webview.postMessage({ type: "opened-latest", requestId: msg.requestId, ok, detail, ...(ok ? { text: document.getText(), version: document.version } : {}) });
      if (typeof msg.editorVersion !== "number" || document.version !== msg.editorVersion) { void reply(false, "editor-changed"); return; }
      try {
        await vscode.commands.executeCommand("workbench.action.files.revert", document.uri);
      } catch (e) { void reply(false, e instanceof Error ? e.message : String(e)); return; }
      // 読み直せたことを確かめる (未保存の印が消え、エディタの中身がディスクと同じ)
      let disk = "";
      try { disk = readFileSync(document.uri.fsPath, "utf8"); } catch { /* 読めなければ、下で失敗として返す */ }
      const lf = (v: string) => v.replace(/\r\n/g, "\n");
      if (document.isDirty || lf(document.getText()) !== lf(disk)) { void reply(false, "revert-failed"); return; }
      void reply(true, "");
      return;
    }
    // 退避した編集を読み込む (画面が衝突として見比べる)
    if (msg?.type === "load-evacuated") {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] } });
      if (!picked?.[0]) return;
      // 画面が、退避したときの基準を共通の元にして、今の中身に取り込む (外部のファイル変更の衝突としては扱わない。R39-06)
      try {
        const text = readFileSync(picked[0].fsPath, "utf8");
        let recovery: unknown;
        try { recovery = JSON.parse(text); } catch { recovery = null; }
        // (前の版で退避した、計画そのもののファイル: 基準なしの退避として扱う)
        if (!recovery || typeof recovery !== "object" || (recovery as { boxglowRecovery?: unknown }).boxglowRecovery !== 1) recovery = { boxglowRecovery: 1, base: null, received: null, gui: { text }, editor: null };
        void panel.webview.postMessage({ type: "restore-evacuated", recovery });
      } catch (e) { void vscode.window.showErrorMessage(String(e)); }
      return;
    }
  });

  // ---- 受け取りがディスクを書いた後の扱い ----
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onDiskChanged = () => {
    if (!existsSync(document.uri.fsPath)) return;
    let disk: string;
    try { disk = readFileSync(document.uri.fsPath, "utf8"); } catch { return; }
    const lf = (v: string) => v.replace(/\r\n/g, "\n");
    if (lf(disk) === lf(document.getText())) return;            // VS Code が追い付いた (ふつうの update の経路で届く)
    if (document.isDirty) { hooks.postConflict(disk); return; } // 未保存の編集は捨てず、受け取った中身を衝突として見せる
    // clean なのに追い付いていない: 少し待ってから、ディスク・エディタ・dirty を見直して決める (待ち時間は表示の時機だけ。正しさは見直しで決める。R39-07)
    setTimeout(() => {
      let now: string;
      try { now = readFileSync(document.uri.fsPath, "utf8"); } catch { return; }
      if (lf(now) === lf(document.getText())) return;                // 追い付いた (ふつうの update で届く)
      if (document.isDirty) { hooks.postConflict(now); return; }      // 待つ間にエディタが編集された: 衝突として両方を保持する
      hooks.postFromDisk(now);
    }, 1500);
  };
  try {
    watcher = watch(dirname(document.uri.fsPath), (_ev, name) => {
      if (name && String(name) !== basename(document.uri.fsPath)) return;
      clearTimeout(timer);
      timer = setTimeout(onDiskChanged, 200);
    });
  } catch { /* 監視できない環境では、受け取りは手動の更新で拾う */ }

  // 最初の状態を送る
  void panel.webview.postMessage({ type: "sync-status", status: host.status(path) });

  return () => {
    messages.dispose(); savedWatch.dispose(); savedOnSave.dispose();
    watcher?.close(); clearTimeout(timer);
    panels.get(path)?.delete(panel);
    if ((panels.get(path)?.size ?? 0) === 0) { panels.delete(path); host.closeFile(path); }
    if (panels.size === 0) { void host.stop(); hosts.delete(server); }
  };
}
