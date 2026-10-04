/**
 * Boxglow の VS Code 拡張: boxglow.json をボックスと線の図として開く (カスタムエディタ)。
 * 同梱した Web アプリ (media/) を webview に出し、ファイルの中身はメッセージでやり取りする。
 *   webview -> 拡張: { type: "ready" } (最初の中身をくれ)
 *                    { type: "save", requestId, text, baseText, version } (この中身で保存して。baseText / version = 画面が元にした中身とドキュメントの版)
 *   拡張 -> webview: { type: "load", text, version, name, appVersion, protocol, extensionVersion } / { type: "update", ... } (外 (CLI や AI) でファイルが変わった)
 *                    { type: "saved", requestId, version } (ディスクまで保存できた)
 *                    { type: "save-error", requestId, error, conflict?, text?, version? } (保存できなかった。conflict なら text に最新の中身)
 * 保存は WorkspaceEdit でドキュメントを置き換えてから document.save() (エディタの dirty 状態と整合する)。
 * 保存の要求には必ず requestId 付きで成功か失敗かを返す (画面は応答を待ってから「保存済み」にする)。手順の本体は save.ts
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { saveDocument } from "./save";
import { FileConflict } from "../../cli/file-store";
import { rewriteIndexHtml } from "./html";
import { APP_VERSION, SAVE_PROTOCOL } from "../../src/model/version";
// 保存の失敗の文言を計画の言語 (日本語 / 英語) で出す
import { setLang, t } from "../../src/i18n/core";

/**
 * 計画の言語を調べる (保存の失敗の文言を、CLI と同じく計画の言語で出すため)
 * Input : text = 計画の中身 (JSON の文字列)
 * Output: "en" か "ja" (lang が無い古い計画や、読めない中身は "ja")
 */
function langOf(text: string): "ja" | "en" {
  try { return (JSON.parse(text) as { lang?: unknown }).lang === "en" ? "en" : "ja"; } catch { return "ja"; }
}

const VIEW_TYPE = "boxglow.editor";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new BoxglowEditorProvider(context);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true }));
  // コマンド: 今開いている (または作業フォルダの) boxglow.json を図で開く
  context.subscriptions.push(vscode.commands.registerCommand("boxglow.open", async (uri?: vscode.Uri) => {
    let target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target || basename(target.fsPath) !== "boxglow.json") {
      const found = await vscode.workspace.findFiles("**/boxglow.json", "**/node_modules/**", 1);
      target = found[0];
    }
    if (!target) { void vscode.window.showInformationMessage("boxglow.json が見つかりません (npx boxglow init で作れます)"); return; }
    await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
  }));
}

export function deactivate(): void { /* 何もしない */ }

class BoxglowEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const html = readFileSync(join(this.context.extensionPath, "media", "index.html"), "utf8");
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    panel.webview.html = rewriteIndexHtml(html, (rel) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, rel)).toString(), panel.webview.cspSource, nonce);

    // 拡張が最後に確かめたディスクの中身 (保存のとき、ディスクがここから変わっていたら競合にする)
    let diskBase = document.isDirty ? readFileSync(document.uri.fsPath, "utf8") : document.getText();
    // 保存の処理中か (処理中は自分の編集による update を送らず、次の保存の要求も断る)
    let saving = false;
    const send = (type: "load" | "update") => {
      // ドキュメントがディスクと同じ (外の変更を VS Code が読み直した後など) なら、照合の基準を今の中身に進める
      if (!document.isDirty && !saving && readFileSync(document.uri.fsPath, "utf8") === document.getText()) diskBase = document.getText();
      void panel.webview.postMessage({
        type
      , appVersion: APP_VERSION
      , protocol: SAVE_PROTOCOL
      , extensionVersion: this.context.extension.packageJSON.version
      , text: document.getText()
      , version: document.version
      , name: basename(document.uri.fsPath)
      });
    };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === document.uri.toString() && !saving) send("update"); });
    const messages = panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "ready") { send("load"); return; }
      // 形の合わない要求は無視する (応答に使う requestId が無いものを含む)
      if (msg?.type !== "save" || typeof msg.requestId !== "string" || typeof msg.text !== "string" || typeof msg.baseText !== "string" || !Number.isInteger(msg.version)) return;
      // 失敗の文言は計画の言語で出す
      setLang(langOf(msg.text));
      if (saving) { void panel.webview.postMessage({ type: "save-error", requestId: msg.requestId, error: t("保存の処理中です。もう一度やり直してください") }); return; }
      saving = true;
      try {
        const version = await saveDocument(
          {
            path: document.uri.fsPath
          , text: () => document.getText()
          , version: () => document.version
          , replace: (text) => { const edit = new vscode.WorkspaceEdit(); edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), text); return vscode.workspace.applyEdit(edit); }
          , save: () => document.save()
          }
        , msg       // request: webview からの保存の要求
        , diskBase  // diskBase: 最後に確かめたディスクの中身
        );
        // ディスクまで保存できた。照合の基準を進めて、成功の応答を返す
        // (基準は実際に保存されたドキュメントの中身にする。CRLF のファイルでは、画面が送った LF の文字列と改行が違うため)
        diskBase = document.getText();
        void panel.webview.postMessage({ type: "saved", requestId: msg.requestId, version });
      } catch (e) {
        const conflict = e instanceof FileConflict;
        // CLI の書き込みは VS Code のファイル監視より先に起きることがある。そのときはディスクの中身を最新として返す
        let disk = diskBase;
        try { disk = readFileSync(document.uri.fsPath, "utf8"); } catch { /* ファイルが消されていても、失敗の応答は必ず返す */ }
        // 改行だけの違い (CRLF のファイル) は「ディスクが変わった」とみなさない
        const lf = (value: string) => value.replace(/\r\n/g, "\n");
        const text = lf(disk) !== lf(diskBase) ? disk : document.getText();
        void panel.webview.postMessage({ type: "save-error", requestId: msg.requestId, error: e instanceof Error ? e.message : String(e), conflict, text, version: document.version });
        if (conflict) diskBase = disk;
      } finally { saving = false; }
    });
    panel.onDidDispose(() => { sub.dispose(); messages.dispose(); });
  }
}
