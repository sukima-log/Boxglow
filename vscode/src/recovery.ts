/**
 * VS Code の拡張: 未保存の編集の退避と、退避したファイルの読み込み (同期の設定の有無にかかわらず、いつも使える。R49-03)
 *   - 退避 (evacuate): 画面の中身・エディタの未保存の中身・統合の基準・受け取った最新の中身を、保存ダイアログで選んだ別のファイルに書く。
 *     書けたことを確かめてから、成功と場所を返す (やめた・書けなかったら失敗を返す。画面は何も変えない)
 *   - 読み込み (load-evacuated): 退避したファイルを選ばせて、画面に「取り込み」として渡す
 *   エディタの未保存の編集を捨てる操作 (読み直し) は、拡張では行わない。対象のファイルを確実に指定して捨てる手段が無いため、
 *   利用者がタブを閉じて (保存しない) 開き直す (R49-01)
 */
import * as vscode from "vscode";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash } from "node:crypto";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const real = (path: string): string => { try { return realpathSync(path); } catch { return path; } };
const lf = (v: string) => v.replace(/\r\n/g, "\n");

/**
 * パネル 1 つに、退避と読み込みの処理をつなぐ
 * Input : document = 開いている計画のドキュメント, panel = その画面
 * Output: 片付けの関数 (パネルを閉じたときに呼ぶ)
 */
export function attachRecovery(document: vscode.TextDocument, panel: vscode.WebviewPanel): () => void {
  const path = real(document.uri.fsPath);

  // ---- エディタの保存済みの中身 (エディタに未保存の編集があるときの、退避の基準) ----
  // エディタに未保存の編集があると、画面はその中身を受け取り、画面の基準もそこへ進む。退避の基準がそれだと、
  // エディタの未保存の編集が「基準からの変更」に見えず、取り込みで失われる (実機の検査で見つけた)。
  // そこで、エディタが clean だった最後の中身 (= 保存済みのディスクの中身) を覚えておき、dirty のときの退避の基準にする。
  // 開いた時点ですでに dirty なら、共通の基準は分からない (ディスクが外から変わっているかもしれない): 推測せず「不明」(null) にする (R49 回答 2)
  let savedText: string | null = document.isDirty ? null : document.getText();
  // (エディタの中身が変わり、clean に見えるとき (ディスクからの読み直し・元に戻す): ディスクと同じと確かめてから覚える。
  //  変更の通知の時点では、最初の 1 文字の編集でも isDirty がまだ false のことがある。実機の検査で見つけた)
  const savedWatch = vscode.workspace.onDidChangeTextDocument((e) => {
    if (e.document !== document || document.isDirty) return;
    try {
      const disk = readFileSync(document.uri.fsPath, "utf8");
      if (lf(disk) === lf(document.getText())) savedText = disk;
    } catch { /* 読めなければ、前の保存済みの中身のまま */ }
  });
  const savedOnSave = vscode.workspace.onDidSaveTextDocument((d) => { if (d === document) savedText = document.getText(); });

  const messages = panel.webview.onDidReceiveMessage(async (msg) => {
    // 退避: 画面の未保存の中身 (とエディタの未保存の中身) を、別のファイルへ書く。書けたことを確かめてから、その中身のハッシュと場所を返す
    //   Input : { requestId, text = 画面の中身, base = 画面が元にした中身, received = 受け取った最新の中身 (無ければ null) }
    //   Output: evacuated { requestId, ok, hash (画面の中身), editorVersion, path, detail (失敗の理由) }
    if (msg?.type === "evacuate" && typeof msg.text === "string" && typeof msg.requestId === "string") {
      const suggested = vscode.Uri.file(`${dirname(document.uri.fsPath)}/${basename(document.uri.fsPath, ".json")}.unsaved-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      const target = await vscode.window.showSaveDialog({ defaultUri: suggested, filters: { JSON: ["json"] }, saveLabel: "退避 / Save a copy" });
      // 復旧用の形式で書く (R39-05): 画面の中身 (G)・統合の基準・受け取った最新の中身 (R)・エディタ側の未保存の中身 (画面と違うときだけ) と、その版
      // エディタの版は、書き出す時点のもの (この後にエディタが編集されたら、画面は「退避済み」ではなくなる)
      const editorVersion = document.version;
      const editorText = document.getText();
      const recovery = {
        boxglowRecovery: 1, savedAt: new Date().toISOString(), file: document.uri.fsPath
      // (基準: エディタに未保存の編集があれば、保存済みの中身 (分からなければ null = 基準なし)。無ければ、画面が元にした中身)
      , base: document.isDirty ? savedText : typeof msg.base === "string" ? msg.base : null
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
    // 退避した編集を読み込む (画面が、退避したときの基準を共通の元にして、今の中身に取り込む)
    //   Input : { } / Output: restore-evacuated { recovery } (選ばなければ何も送らない)
    if (msg?.type === "load-evacuated") {
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] } });
      if (!picked?.[0]) return;
      // (外部のファイル変更の衝突としては扱わない。R39-06)
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

  return () => { messages.dispose(); savedWatch.dispose(); savedOnSave.dispose(); };
}
