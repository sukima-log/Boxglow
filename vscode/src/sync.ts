/**
 * VS Code の拡張から、画面からの同期を使う (設計: docs/private/SYNC_GUI_DESIGN.md 2.5 / 4 章)
 *   - 同期の裏方 (SyncHost) を、拡張の中で動かす (サーバーごとに 1 つ。開いているパネルで共有)
 *   - webview へ { type: "sync-status", status } を送り、{ type: "sync-action", action } を受ける
 *   - 有効にした計画は globalState に持つ (キー = 拡張ホストの識別 + ファイルの URI + サーバー。Settings Sync の対象にしない)
 *   - 受け取りがディスクを書いた後: ドキュメントが dirty なら、受け取った中身を「衝突」として画面へ (未保存の編集は捨てない)。
 *     clean なのに VS Code が追い付かない間は、受け取った中身を確認用 (fromDisk) として画面へ送る (編集用の基準は進めない)
 *   (退避・退避したファイルの読み込みは recovery.ts。同期の設定が無くても使う)
 */
import * as vscode from "vscode";
import { existsSync, readFileSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { parseHostAction, SyncHost, type SyncStatus } from "../../cli/sync/host";

/** サーバーごとの裏方 (拡張の中で 1 つずつ) */
const hosts = new Map<string, { host: SyncHost; panels: Map<string, Set<vscode.WebviewPanel>> }>();
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
    messages.dispose();
    watcher?.close(); clearTimeout(timer);
    panels.get(path)?.delete(panel);
    if ((panels.get(path)?.size ?? 0) === 0) { panels.delete(path); host.closeFile(path); }
    if (panels.size === 0) { void host.stop(); hosts.delete(server); }
  };
}
