/**
 * Boxglow の VS Code 拡張: boxglow.json を箱と線の図として開く (カスタムエディタ)。
 * 同梱した Web アプリ (media/) を webview に出し、ファイルの中身はメッセージでやり取りする。
 *   webview -> 拡張: { type: "ready" } (最初の中身をくれ) / { type: "save", text } (この中身で保存して)
 *   拡張 -> webview: { type: "load", text, name } / { type: "update", text, name } (外 (CLI や AI) でファイルが変わった)
 * 保存は WorkspaceEdit でドキュメントを置き換えてから document.save() (エディタの dirty 状態と整合する)
 */
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { rewriteIndexHtml } from "./html";

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

    let lastSent = "";
    let lastSaved = "";
    const send = (type: "load" | "update") => {
      const text = document.getText();
      if (type === "update" && (text === lastSent || text === lastSaved)) return; // 自分が送った / 書いた中身
      lastSent = text;
      void panel.webview.postMessage({ type, text, name: basename(document.uri.fsPath) });
    };
    const sub = vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.toString() === document.uri.toString()) send("update"); });
    panel.webview.onDidReceiveMessage(async (msg: { type?: string; text?: string }) => {
      if (msg?.type === "ready") { send("load"); return; }
      if (msg?.type === "save" && typeof msg.text === "string") {
        if (msg.text === document.getText()) return;
        lastSaved = msg.text;
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), msg.text);
        await vscode.workspace.applyEdit(edit);
        await document.save();
      }
    });
    panel.onDidDispose(() => sub.dispose());
  }
}
