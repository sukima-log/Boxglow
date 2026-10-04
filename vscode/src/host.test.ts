/** Run with Code.exe --extensionDevelopmentPath=... --extensionTestsPath=... . */
import * as vscode from "vscode";
import { strict as assert } from "node:assert";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { saveDocument } from "./save";
import { FileConflict, FileBusy, lockFile } from "../../cli/file-store";
import { createProject, toJSON } from "../../src/model/graph";

export async function run() {
  const root = process.env.BOXGLOW_HOST_TEST_DIR;
  if (!root) throw new Error("BOXGLOW_HOST_TEST_DIR required");
  mkdirSync(root, { recursive: true });
  const file = join(root, "boxglow.json");
  const results: string[] = [];
  try {
    const original = toJSON(createProject("Native VS Code save test"));
    writeFileSync(file, original);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const adapter = {
      path: file, text: () => doc.getText(), version: () => doc.version,
      replace: async (text: string) => {
        const edits = new vscode.WorkspaceEdit();
        edits.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text);
        return vscode.workspace.applyEdit(edits);
      },
      save: () => doc.save(),
    };
    const changed = (name: string) => { const p = JSON.parse(original); p.name = name; return JSON.stringify(p); };
    const first = changed("Saved by actual WorkspaceEdit");
    const version = await saveDocument(adapter, { text: first, baseText: original, version: doc.version }, original);
    assert.equal(readFileSync(file, "utf8"), first); assert.equal(doc.isDirty, false); assert.equal(version, doc.version);
    results.push("WorkspaceEdit + document.save: awaited disk contents match, document clean");
    const second = changed("Second acknowledged edit");
    await saveDocument(adapter, { text: second, baseText: first, version }, first);
    assert.equal(readFileSync(file, "utf8"), second);
    results.push("Second save uses the real updated document version");
    const dirty = changed("Unsaved editor change"); const beforeDirty = doc.version;
    await adapter.replace(dirty);
    await assert.rejects(saveDocument(adapter, { text: first, baseText: second, version: beforeDirty }, second), FileConflict);
    assert.equal(doc.getText(), dirty); assert.equal(readFileSync(file, "utf8"), second);
    results.push("Concurrent dirty editor change preserved; stale GUI save rejected");
    await doc.save();
    const unlock = lockFile(file);
    try { await assert.rejects(saveDocument(adapter, { text: second, baseText: dirty, version: doc.version }, dirty), FileBusy); }
    finally { unlock(); }
    results.push("Shared CLI lock rejects VS Code writes");
    const external = changed("External disk change"); writeFileSync(file, external);
    await assert.rejects(saveDocument(adapter, { text: first, baseText: dirty, version: doc.version }, dirty), FileConflict);
    assert.equal(readFileSync(file, "utf8"), external);
    results.push("External disk edits preserved; stale disk base rejected");
    await assert.rejects(saveDocument(adapter, { text: "{}", baseText: external, version: doc.version }, external));
    results.push("Invalid save input rejected without replacing the real document");
    // CRLF のファイル: VS Code は挿入した文字列の改行をドキュメントの改行 (CRLF) に合わせる。画面が送る LF の中身で保存しても競合にならず、続けて保存できること
    const crlfFile = join(root, "boxglow-crlf.json");
    const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");
    const crlfOriginal = crlf(original + "\n");
    writeFileSync(crlfFile, crlfOriginal);
    const crlfDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(crlfFile));
    assert.equal(crlfDoc.eol, vscode.EndOfLine.CRLF);
    const crlfAdapter = {
      path: crlfFile, text: () => crlfDoc.getText(), version: () => crlfDoc.version,
      replace: async (text: string) => {
        const edits = new vscode.WorkspaceEdit();
        edits.replace(crlfDoc.uri, new vscode.Range(0, 0, crlfDoc.lineCount, 0), text);
        return vscode.workspace.applyEdit(edits);
      },
      save: () => crlfDoc.save(),
    };
    // 画面と同じく、複数行の LF の文字列を送る
    const pretty = (name: string) => { const p = JSON.parse(original); p.name = name; return JSON.stringify(p, null, 2) + "\n"; };
    const crlfFirst = pretty("CRLF first save");
    const crlfVersion = await saveDocument(crlfAdapter, { text: crlfFirst, baseText: crlfDoc.getText(), version: crlfDoc.version }, crlfOriginal);
    assert.equal(readFileSync(crlfFile, "utf8"), crlf(crlfFirst)); assert.equal(crlfDoc.isDirty, false);
    await saveDocument(crlfAdapter, { text: pretty("CRLF second save"), baseText: crlfFirst, version: crlfVersion }, crlfDoc.getText());
    assert.equal(JSON.parse(readFileSync(crlfFile, "utf8")).name, "CRLF second save");
    results.push("CRLF document: LF text from the GUI saves without a false conflict, twice in a row");
    const ext = vscode.extensions.getExtension("sukima.boxglow-vscode");
    assert.ok(ext); await ext.activate();
    await vscode.commands.executeCommand("vscode.openWith", doc.uri, "boxglow.editor");
    assert.equal(ext.isActive, true);
    results.push("Packaged extension activates and opens its actual custom editor");
    writeFileSync(join(root, "results.json"), JSON.stringify({ ok: true, vscode: vscode.version, checks: results }, null, 2));
  } catch (error) {
    writeFileSync(join(root, "results.json"), JSON.stringify({ ok: false, vscode: vscode.version, checks: results, error: String(error), stack: (error as Error).stack }, null, 2));
    throw error;
  }
}
