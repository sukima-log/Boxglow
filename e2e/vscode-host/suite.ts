/**
 * 実際の VS Code (Windows) の拡張ホストの中で動かす確認 (B138)。
 * 何を確かめるか: Windows の窓で WSL のファイル (\\wsl.localhost\... の UNC パス) を扱うときの、拡張の読み込み・保存・ロック。
 *   - VS Code が拡張のアクセスを許可していないとき: 保存できない理由 (diskAccess) が出て、ロックも保存も行わない
 *   - 許可しているとき: 拡張の保存 (saveDocument) が実ファイルまで届く。WSL 側の書き手が残したロックは奪わない。
 *     Windows 側が取ったロックの持ち主の記録に OS (win32) が入る (WSL 側から見て「確かめられない」になる)
 * 使い方: e2e/vscode-host/run.sh から呼ばれる (esbuild で 1 ファイルにまとめ、Windows の一時フォルダへ置いて Code.exe に渡す)。
 * Input : 同じフォルダの config.json = { target = 計画ファイルの UNC パス, phase = "blocked" | "allowed" }
 * Output: 同じフォルダの out/result-<phase>.json = { steps: { 名前: { ok, value | message } } }
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { saveDocument, diskAccess } from "../../vscode/src/save";
import { FileBusy, inspectLock, lockFile } from "../../cli/file-store";
import { setLang } from "../../src/i18n/core";

/** 確認 1 件の結果 */
interface Step { ok: boolean; value?: unknown; message?: string }

export async function run(): Promise<void> {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")) as { target: string; phase: string };
  const steps: Record<string, Step> = {};
  /** 1 件の確認を実行して結果を控える (例外は失敗として記録し、次の確認へ進む) */
  const step = async (name: string, fn: () => unknown) => {
    try { steps[name] = { ok: true, value: await fn() }; } catch (e) { steps[name] = { ok: false, message: `${(e as NodeJS.ErrnoException).code ?? ""} ${(e as Error).message ?? e}`.trim() }; }
  };
  setLang("ja");
  const target = cfg.target;
  const lock = target + ".boxglow-lock";

  await step("環境", () => ({ platform: process.platform, host: os.hostname(), vscode: vscode.version, allowedUNCHosts: vscode.workspace.getConfiguration("security").get("allowedUNCHosts") }));
  // 拡張が実際に登録されていて、図のエディタで開けるか (webview の中身までは、ここからは見えない)
  await step("拡張が有効", () => vscode.extensions.getExtension("sukima.boxglow-vscode")?.packageJSON.version ?? "(見つからない)");
  await step("保存できない理由 (diskAccess)", () => diskAccess(target));

  if (cfg.phase === "blocked") {
    // 許可されていない窓: ロックは取れない (例外になる)。奪うことも、空のロックを残すこともない
    await step("ロックの取得は失敗する", () => { try { lockFile(target)(); return "取得できてしまった"; } catch (e) { return `失敗: ${(e as NodeJS.ErrnoException).code}`; } });
  } else {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    /** 拡張 (extension.ts) と同じ形の、保存先の操作 */
    const adapter = {
      path: doc.uri.fsPath
    , text: () => doc.getText()
    , version: () => doc.version
    , replace: (text: string) => { const edit = new vscode.WorkspaceEdit(); edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text); return vscode.workspace.applyEdit(edit); }
    , save: () => doc.save()
    };
    /** 計画の名前を書き換えた中身を作る (保存できたかを WSL 側から見分けるため) */
    const renamed = (name: string) => { const p = JSON.parse(doc.getText()); p.name = name; return JSON.stringify(p, null, 2) + "\n"; };

    // 1) WSL 側の書き手が残したロック (持ち主は Linux。こちらの番号では生死を確かめられない) があるとき、保存は止まり、ロックは奪わない
    await step("WSL の書き手のロックがあると保存は止まる", async () => {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 4242, host: os.hostname(), at: new Date().toISOString(), token: "wsl-writer", platform: "linux", space: "boot/pid:[1]", start: "1" }));
      const before = doc.getText();
      try {
        await saveDocument(adapter, { text: renamed("奪って保存した"), baseText: before, version: doc.version }, before);
        return "保存できてしまった";
      } catch (e) {
        const status = inspectLock(target);
        return { busy: e instanceof FileBusy, verdict: status?.verdict, reason: status?.reason, owner: status?.owner?.token, diskUnchanged: fs.readFileSync(target, "utf8") === before };
      } finally {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    });
    // 2) ロックが無ければ、拡張の保存が実ファイルまで届く (編集の適用 → 保存 → ディスクの照合)
    await step("拡張の保存が WSL のファイルに届く", async () => {
      const before = doc.getText();
      const version = await saveDocument(adapter, { text: renamed("Windows の窓から保存"), baseText: before, version: doc.version }, before);
      return { version, onDisk: JSON.parse(fs.readFileSync(target, "utf8")).name, lockLeft: fs.existsSync(lock) };
    });
    // 3) 図のエディタとして開ける (拡張の読み込み処理が例外にならない)
    await step("図のエディタで開ける", async () => {
      await vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(target), "boxglow.editor");
      await new Promise((r) => setTimeout(r, 3000));
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { viewType?: string } | undefined;
      return input?.viewType ?? "(不明)";
    });
    // 4) Windows 側がロックを取ったまま終了した状態を残す (このあと WSL 側の CLI が「確かめられない」として奪わないことを確かめる)
    await step("Windows 側のロックを残す", () => {
      lockFile(target); // 解放しない
      return JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
    });
  }
  fs.mkdirSync(path.join(__dirname, "out"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "out", `result-${cfg.phase}.json`), JSON.stringify({ steps }, null, 2));
}
