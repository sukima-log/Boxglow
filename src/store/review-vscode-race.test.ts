import { conflictSnapshot } from "../../vscode/src/save";
/**
 * 検証: VS Code の拡張 (extension.ts + save.ts と同じ判定) を模擬し、
 * 「ディスクだけ外から変わり、ドキュメントがまだ読み直されていない」間の自動統合で、外の変更が落ちないかを確かめる
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";

// 模擬の拡張の状態
const ext = { disk: "", doc: "", version: 1, diskBase: "", saving: false };
const sent: Record<string, unknown>[] = [];
let target: EventTarget;
const deliver = (data: unknown) => { target.dispatchEvent(new MessageEvent("message", { data })); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 入力: webview からの save 要求。出力: なし (save.ts / extension.ts と同じ判定で応答を返す) */
function handleSave(msg: { requestId: string; text: string; baseText: string; version: number }) {
  setTimeout(() => {
    try {
      if (ext.disk !== ext.diskBase) throw new Error("conflict");
      if (ext.doc !== msg.text) {
        if (ext.version !== msg.version || ext.doc !== msg.baseText) throw new Error("conflict");
        ext.doc = msg.text; ext.version++;
      }
      ext.disk = ext.doc; ext.diskBase = ext.doc;
      deliver({ type: "saved", requestId: msg.requestId, version: ext.version });
    } catch {
      const disk = ext.disk;
      deliver({ type: "save-error", requestId: msg.requestId, error: "x", conflict: true, ...conflictSnapshot(disk, ext.doc, false), version: ext.version });
    }
  }, 1);
}

beforeAll(() => {
  target = new EventTarget();
  const w = target as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => { sent.push(m); if (m.type === "save") handleSave(m as never); } });
  w.location = { search: "" };
  (globalThis as unknown as { window: unknown }).window = w;
  (globalThis as unknown as { confirm: unknown }).confirm = () => true;
});

describe("VS Code: ディスクだけ先に変わった間の自動統合", () => {
  it("外の変更 (b の題名) と画面の編集 (a の題名) の両方がディスクに残るか", async () => {
    let p = createProject("検証");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
    const L = toJSON(p) + "\n";
    ext.disk = ext.doc = ext.diskBase = L; ext.version = 5;
    const { useProjectStore: store } = await import("./useProjectStore");
    store.getState().openFromVsCode();
    deliver({ type: "load", text: L, version: ext.version, name: "boxglow.json" });
    await wait(10);
    // 画面で a を編集
    store.getState().apply((q) => updateBlock(q, a.blockId, { title: "Local" }));
    // CLI がディスクだけ書き換えた (VS Code はまだドキュメントを読み直していない)
    ext.disk = toJSON(updateBlock(fromJSON(L), b.blockId, { title: "Remote" })) + "\n";
    store.getState().saveNow();
    await wait(200);
    const s = store.getState();
    const disk = fromJSON(ext.disk);
    console.log(JSON.stringify({ saves: sent.filter((m) => m.type === "save").length, saveState: s.saveState, saveError: s.saveError, toast: s.toast, conflict: !!s.conflict,
      diskA: disk.blocks[a.blockId].title, diskB: disk.blocks[b.blockId].title, screenB: s.project!.blocks[b.blockId].title }));
    expect(disk.blocks[a.blockId].title).toBe("A");
    expect(s.project!.blocks[a.blockId].title).toBe("Local");
    expect(s.editorBehind).not.toBeNull();
    expect(sent.filter(m => m.type === "save")).toHaveLength(1);
    // 文書が追い付くまでは保存を止める。読み直した後に明示的に選んで両方を残す。
    ext.doc = ext.disk; ext.diskBase = ext.disk; ext.version++;
    deliver({ type: "update", text: ext.doc, version: ext.version });
    await wait(20);
    store.getState().saveNow();
    await wait(100);
    expect(fromJSON(ext.disk).blocks[a.blockId].title).toBe("Local");
    expect(fromJSON(ext.disk).blocks[b.blockId].title).toBe("Remote");
    // 外の変更が残っていること (ここが落ちれば、黙って上書きしている)
    expect(disk.blocks[b.blockId].title).toBe("Remote");
  });
});
