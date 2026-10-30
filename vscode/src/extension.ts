/**
 * Boxglow の VS Code 拡張: boxglow.json をボックスと線の図として開く (カスタムエディタ)。
 * 同梱した Web アプリ (media/) を webview に出し、ファイルの中身はメッセージでやり取りする。
 *   webview -> 拡張: { type: "ready" } (最初の中身をくれ)
 *                    { type: "open-file", path } (成果物・資料のファイルをエディタで開いて。見つからなければ { type: "open-file-error", path } を返す)
 *                    { type: "save", requestId, text, baseText, version } (この中身で保存して。baseText / version = 画面が元にした中身とドキュメントの版)
 *   拡張 -> webview: { type: "load", text, version, name, appVersion, protocol, extensionVersion } / { type: "update", ... } (外 (CLI や AI) でファイルが変わった)
 *                    { type: "saved", requestId, version } (ディスクまで保存できた)
 *                    { type: "save-error", requestId, error, conflict?, text?, version? } (保存できなかった。conflict なら text に最新の中身)
 * 保存は WorkspaceEdit でドキュメントを置き換えてから document.save() (エディタの dirty 状態と整合する)。
 * 保存の要求には必ず requestId 付きで成功か失敗かを返す (画面は応答を待ってから「保存済み」にする)。手順の本体は save.ts
 */
import * as vscode from "vscode";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { saveDocument, diskAccess, conflictSnapshot, saveFailureBase } from "./save";
import { resolveAttachedFile } from "../../cli/attached-file";
import { FileConflict } from "../../cli/file-store";
import { dpapiAvailable } from "../../cli/sync/dpapi";
import { credentialsPath, inspectCredentials, removeCredentials, saveCredentials, withCredentialsLock } from "../../cli/sync/credentials";
import { DEFAULT_SYNC_SERVER } from "../../cli/sync/server-policy";
import { rewriteIndexHtml } from "./html";
import { APP_VERSION, SAVE_PROTOCOL } from "../../src/model/version";
// 保存の失敗の文言を計画の言語 (日本語 / 英語) で出す
import { setLang, t } from "../../src/i18n/core";
import { attachSync } from "./sync";
import { attachRecovery } from "./recovery";

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
  // コマンド: サインインの保存の自己診断 (B187。Windows ローカルの VS Code での確認を、人の操作なしで行う)
  //   この拡張ホスト (Node) で、OS・DPAPI の可否・資格情報の置き場・保存と読み出しの往復 (一時フォルダ、ダミーのトークン)・今の保存の状態を調べ、出力に出す
  context.subscriptions.push(vscode.commands.registerCommand("boxglow.selfCheckSignIn", async () => {
    const lines: string[] = [];
    const ok = (name: string, pass: boolean, detail = "") => lines.push(`${pass ? "OK " : "NG "} ${name}${detail ? " " + detail : ""}`);
    lines.push(`Boxglow sign-in self check  ${new Date().toISOString()}`);
    lines.push(`platform=${process.platform} node=${process.version} vscode=${vscode.version} remote=${vscode.env.remoteName ?? "(local)"}`);
    const win = process.platform === "win32";
    const dpapiOk = dpapiAvailable();
    ok("DPAPI (Windows PowerShell)", win ? dpapiOk : true, win ? (dpapiOk ? "使える" : "使えない: PowerShell を呼べない") : "Windows ではないので不要");
    // 往復: 一時の設定フォルダにダミーを保存 → ファイルに平文が無い (Windows) → 読み出せる → 消す
    const saved = process.env.BOXGLOW_CONFIG_DIR;
    const tmp = mkdtempSync(join(tmpdir(), "boxglow-selfcheck-"));
    process.env.BOXGLOW_CONFIG_DIR = join(tmp, "config");
    try {
      const server = "https://selfcheck.example.test";
      await withCredentialsLock(server, async () => { saveCredentials({ server, account: "acc-selfcheck", login: "selfcheck", token: "bgl_selfcheck_token", createdAt: new Date().toISOString() }); });
      const raw = readFileSync(credentialsPath(server), "utf8");
      ok("保存できる (一時フォルダ)", true, credentialsPath(server));
      if (win) ok("ファイルに平文のトークンが無い (DPAPI の暗号文だけ)", !raw.includes("bgl_selfcheck_token") && raw.includes("\"dpapi\""));
      const back = inspectCredentials(server);
      ok("読み出して復号できる", back.kind === "valid" && back.credentials.token === "bgl_selfcheck_token", back.kind === "valid" ? "" : JSON.stringify(back));
      await withCredentialsLock(server, async () => { removeCredentials(server); });
      ok("消せる", inspectCredentials(server).kind === "absent");
    } catch (e) {
      ok("保存の往復", false, e instanceof Error ? e.message : String(e));
    } finally {
      if (saved === undefined) delete process.env.BOXGLOW_CONFIG_DIR; else process.env.BOXGLOW_CONFIG_DIR = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
    // 今の保存の状態 (本番のサーバー向け): サインイン済みなら誰か。トークンは出さない
    const current = inspectCredentials(DEFAULT_SYNC_SERVER);
    lines.push(`今のサインイン (${DEFAULT_SYNC_SERVER}): ${current.kind === "valid" ? `あり (${current.credentials.login}, ${credentialsPath(DEFAULT_SYNC_SERVER)})` : current.kind === "absent" ? "なし" : `使えない: ${current.reason}`}`);
    const failed = lines.filter((l) => l.startsWith("NG ")).length;
    lines.push(failed === 0 ? "すべて OK" : `${failed} 件 NG`);
    const text = lines.join("\n");
    const channel = vscode.window.createOutputChannel("Boxglow");
    channel.appendLine(text); channel.show(true);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(failed === 0 ? "Boxglow: サインインの保存の自己診断はすべて OK です (結果をクリップボードにコピーしました)" : `Boxglow: 自己診断で ${failed} 件 NG (結果をクリップボードにコピーしました)`);
  }));
}

export function deactivate(): void { /* 何もしない */ }

class BoxglowEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    // メモの画像の置き場 (計画のファイルの隣の boxglow.assets/)。webview から読めるように許可し、URI を画面へ渡す
    const assetsDir = vscode.Uri.joinPath(document.uri, "..", "boxglow.assets");
    panel.webview.options = { enableScripts: true, localResourceRoots: [media, assetsDir] };
    const html = readFileSync(join(this.context.extensionPath, "media", "index.html"), "utf8");
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    panel.webview.html = rewriteIndexHtml(html, (rel) => panel.webview.asWebviewUri(vscode.Uri.joinPath(media, rel)).toString(), panel.webview.cspSource, nonce);

    // 拡張が最後に確かめたディスクの中身 (保存のとき、ディスクがここから変わっていたら競合にする)
    /**
     * ディスクの中身を読む。読めない場所 (VS Code が拡張のアクセスを許可していない UNC パスなど) では null
     * (読めないことを理由に、画面へ計画を送るのをやめない。送らないと画面が空になり、利用者がファイルと無関係のコピーを開いてしまう)
     */
    const readDisk = (): string | null => { try { return readFileSync(document.uri.fsPath, "utf8"); } catch { return null; } };
    let diskBase = document.isDirty ? readDisk() ?? document.getText() : document.getText();
    // 保存の処理中か (処理中は自分の編集による update を送らず、次の保存の要求も断る)
    let saving = false;
    const send = (type: "load" | "update") => {
      // ドキュメントがディスクと同じ (外の変更を VS Code が読み直した後など) なら、照合の基準を今の中身に進める
      if (!document.isDirty && !saving && readDisk() === document.getText()) diskBase = document.getText();
      // 計画の言語で、保存できない理由を作る
      setLang(langOf(document.getText()));
      void panel.webview.postMessage({
        type
        // 拡張がファイルを直接読み書きできない窓では、閲覧専用にして理由を見せる (null なら保存できる)
      , readonlyReason: diskAccess(document.uri.fsPath)
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
      // 成果物・資料・Notes のリンクに書かれた手元のファイルを、図の横の列のエディタで開く (計画のフォルダとリポジトリの一番上を基準に探す)。
      // 見つからなければ画面に知らせる (利用者の要望 2026-10-31: 紐づいたファイルを自分で探すのが手間)
      if (msg?.type === "open-file") {
        const path = typeof msg.path === "string" ? msg.path : "";
        const found = document.uri.scheme === "file" ? resolveAttachedFile(document.uri.fsPath, path) : null;
        if (!found) { void panel.webview.postMessage({ type: "open-file-error", path }); return; }
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(found), { preview: false, viewColumn: vscode.ViewColumn.Beside });
        return;
      }
      if (msg?.type === "ready") { send("load"); void panel.webview.postMessage({ type: "asset-base", base: panel.webview.asWebviewUri(assetsDir).toString() + "/" }); return; }
      // メモに貼り付けた画像を boxglow.assets/ に保存する (名前は 1 段のファイル名だけ。同じ名前は上書きしない)
      if (msg?.type === "save-asset") {
        const name = typeof msg.name === "string" ? msg.name : "";
        const reply = (path: string | null, error?: string) => { void panel.webview.postMessage({ type: "asset-saved", requestId: msg.requestId, path, error }); };
        if (!/^[^/\\]+$/.test(name) || name.startsWith(".") || !/\.(png|jpe?g|gif|webp|svg)$/i.test(name) || typeof msg.base64 !== "string") { reply(null, t("この名前の画像は扱えません: {name}", { name })); return; }
        try {
          const dir = assetsDir.fsPath;
          const target = join(dir, name);
          if (existsSync(target)) { reply(null, t("同じ名前の画像があります: {name}", { name })); return; }
          mkdirSync(dir, { recursive: true });
          writeFileSync(target, Buffer.from(msg.base64, "base64"));
          reply(`boxglow.assets/${name}`);
        } catch (e) { reply(null, e instanceof Error ? e.message : String(e)); }
        return;
      }
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
        const snapshot = conflictSnapshot(disk, document.getText(), document.isDirty);
        // 保存中にファイル監視が読み直した場合、send() は省略される。
        // 未保存編集がなく文書とディスクが一致すると確認できた時だけ基準も追い付かせる。
        diskBase = saveFailureBase(diskBase, disk, document.getText(), document.isDirty);
        const error = diskAccess(document.uri.fsPath) ?? (e instanceof Error ? e.message : String(e));
        void panel.webview.postMessage({ type: "save-error", requestId: msg.requestId, error, conflict, ...snapshot, version: document.version });
        // 古い文書や未保存編集では、失敗応答を返しても基準は進めない。
      } finally { saving = false; }
    });
    // 退避と、退避したファイルの読み込み (同期の設定が無くても使う。保存の衝突の帯から使う。R49-03)
    const detachRecovery = attachRecovery(document, panel);
    // 画面からの同期 (設定 boxglow.sync.server があるときだけ)
    const detachSync = attachSync(this.context, document, panel, {
      // 受け取った中身を衝突として画面へ (画面の未保存の編集と、受け取った中身の両方を保持する)。
      // エディタに未保存の編集がある (editorDirty): 画面の基準がエディタの未保存の中身まで進んでいるので、画面での統合はさせず、退避へ案内する (R49-02)
      postConflict: (text) => { void panel.webview.postMessage({ type: "save-error", requestId: "", error: t("同期で受け取った中身があります。手元の編集と見比べてください"), conflict: true, editorDirty: true, text, version: document.version }); }
      // VS Code が追い付いていない間の、確認用の中身 (編集用の基準は進めない)
    , postFromDisk: (text) => { void panel.webview.postMessage({ type: "update", fromDisk: true, text, version: document.version, name: basename(document.uri.fsPath), appVersion: APP_VERSION, protocol: SAVE_PROTOCOL, extensionVersion: this.context.extension.packageJSON.version, readonlyReason: diskAccess(document.uri.fsPath) }); }
    });
    panel.onDidDispose(() => { sub.dispose(); messages.dispose(); detachRecovery(); detachSync(); });
  }
}
