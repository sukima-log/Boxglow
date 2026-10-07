/**
 * 再検証 (B2): 拡張の新しい応答 (conflictSnapshot・失敗では diskBase を進めない) を模擬し、
 * S-1 の順序、保存処理中に文書が読み直された順序、自動統合後の Undo / Redo、履歴の付け替えの時間を確かめる
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { conflictSnapshot, saveFailureBase } from "../../vscode/src/save";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";

// 模擬の拡張 (extension.ts と同じ規則で diskBase を進める)
const ext = { disk: "", doc: "", version: 1, diskBase: "", dirty: false, saving: false, auto: true };
const sent: Record<string, unknown>[] = [];
let target: EventTarget;
const deliver = (data: unknown) => { target.dispatchEvent(new MessageEvent("message", { data })); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** extension.ts の send(): 文書がディスクと同じなら基準を進めて update を送る */
function send(type: "load" | "update") {
  if (!ext.dirty && !ext.saving && ext.disk === ext.doc) ext.diskBase = ext.doc;
  deliver({ type, text: ext.doc, version: ext.version, name: "boxglow.json" });
}
/** VS Code が文書をディスクから読み直す (保存処理中なら update は送られない) */
function reloadDoc() { ext.doc = ext.disk; ext.version++; if (!ext.saving) send("update"); }
let beforeCheck: (() => void) | null = null;
function handleSave(msg: { requestId: string; text: string; baseText: string; version: number }) {
  setTimeout(() => {
    ext.saving = true;
    try {
      beforeCheck?.(); beforeCheck = null;
      if (ext.disk !== ext.diskBase) throw new Error("conflict");
      if (ext.doc !== msg.text) {
        if (ext.version !== msg.version || ext.doc !== msg.baseText) throw new Error("conflict");
        ext.doc = msg.text; ext.version++;
      }
      ext.disk = ext.doc; ext.diskBase = ext.doc;
      deliver({ type: "saved", requestId: msg.requestId, version: ext.version });
    } catch {
      ext.diskBase = saveFailureBase(ext.diskBase, ext.disk, ext.doc, ext.dirty);
      deliver({ type: "save-error", requestId: msg.requestId, error: "競合しました", conflict: true, ...conflictSnapshot(ext.disk, ext.doc, ext.dirty), version: ext.version });
    } finally { ext.saving = false; }
  }, 1);
}
beforeAll(() => {
  target = new EventTarget();
  const w = target as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => { sent.push(m); if (m.type === "save") handleSave(m as never); if (m.type === "ready") send("load"); } });
  w.location = { search: "" };
  (globalThis as unknown as { window: unknown }).window = w;
  (globalThis as unknown as { confirm: unknown }).confirm = () => true;
});
afterEach(() => { sent.length = 0; });

function plans(n = 0) {
  let p = createProject("検証");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
  for (let i = 0; i < n; i++) { const id = "perf-" + i; p.blocks[id] = { ...p.blocks[a.blockId], id, key: "B" + (1000 + i), title: "X" + i, description: "d".repeat(200) }; }
  return { L: toJSON(p) + "\n", a: a.blockId, b: b.blockId };
}
async function open(L: string) {
  ext.disk = ext.doc = ext.diskBase = L; ext.version += 10; ext.dirty = false;
  const { useProjectStore: store } = await import("./useProjectStore");
  store.setState({ source: "idb" as never, project: null });
  store.getState().openFromVsCode();
  await wait(10);
  return store;
}
const titles = (text: string, a: string, b: string) => { const p = fromJSON(text); return [p.blocks[a].title, p.blocks[b].title]; };

describe("B2 再検証", () => {
  it("S-1: 文書が後から読み直されれば、自動で両方が保存される", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "Local" }));
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    store.getState().saveNow();
    await wait(50);
    const mid = { saves: sent.filter((m) => m.type === "save").length, disk: titles(ext.disk, a, b), behind: !!store.getState().editorBehind, conflict: !!store.getState().conflict };
    reloadDoc();
    await wait(1500);
    const s = store.getState();
    console.log("S-1", JSON.stringify({ mid, disk: titles(ext.disk, a, b), saveState: s.saveState, err: s.saveError, conflict: !!s.conflict }));
    expect(titles(ext.disk, a, b)).toEqual(["Local", "Remote"]);
  });

  it("新: 保存処理の最中に VS Code が文書を読み直した (update は送られない) とき、止まり続けないか", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "Local" }));
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    beforeCheck = () => { reloadDoc(); };   // saving 中の読み直し
    store.getState().saveNow();
    await wait(100);
    const first = { saves: sent.filter((m) => m.type === "save").length, err: store.getState().saveError, conflict: !!store.getState().conflict, behind: !!store.getState().editorBehind };
    expect(first.saves).toBe(2);
    expect(titles(ext.disk, a, b)).toEqual(["Local", "Remote"]);
    expect(store.getState().saveState).toBe("saved");
    // 利用者が「保存を再試行」を押す
    store.getState().saveNow(); await wait(100);
    store.getState().saveNow(); await wait(100);
    const s = store.getState();
    console.log("reload-during-save", JSON.stringify({ first, saves: sent.filter((m) => m.type === "save").length, saveState: s.saveState, err: s.saveError, disk: titles(ext.disk, a, b), extDiskBaseIsL: ext.diskBase === L }));
    expect(s.saveState).toBe("saved");
  });

  it("S-4: 2 段の編集のあと自動統合、Undo 2 回・Redo 2 回で相手の変更が残るか", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "e1" }));
    store.getState().apply((q) => updateBlock(q, a, { description: "e2" }));
    // ディスクと文書が同時に変わる (読み直し済み)。保存は update の自動統合で進む
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    reloadDoc();
    await wait(900);
    const st = () => { const p = store.getState().project!; return [p.blocks[a].title, p.blocks[a].description, p.blocks[b].title].join("/"); };
    const log: string[] = [st() + " disk=" + titles(ext.disk, a, b).join("/")];
    store.getState().undo(); log.push("undo1 " + st());
    store.getState().undo(); log.push("undo2 " + st());
    store.getState().redo(); log.push("redo1 " + st());
    store.getState().redo(); log.push("redo2 " + st());
    await wait(900);
    log.push("disk=" + titles(ext.disk, a, b).join("/") + " " + store.getState().saveState);
    console.log("S-4", JSON.stringify(log));
    expect(store.getState().project!.blocks[b].title).toBe("Remote");
  });

  it("S-4: Undo で未来に積んだ版 (Redo) にも相手の変更が入るか", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "e1" }));
    store.getState().apply((q) => updateBlock(q, a, { title: "e2" }));
    store.getState().undo();   // 未来に e2
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    reloadDoc();
    await wait(900);
    store.getState().redo();
    const p = store.getState().project!;
    console.log("S-4 redo", p.blocks[a].title, p.blocks[b].title, "past", store.getState().past.length);
    expect([p.blocks[a].title, p.blocks[b].title]).toEqual(["e2", "Remote"]);
  });

  it.each([[300, 0], [300, 100], [1500, 0], [1500, 100]])("性能: ボックス %i・履歴 %i 段で、自動統合 1 回にかかる時間", async (n, h) => {
    const { L, a, b } = plans(n);
    const store = await open(L);
    // 実測するのは通知の統合。履歴作成時の配置調整は計測と分離する。
    const start = store.getState().project!;
    const past = Array.from({ length: h }, (_, i) => ({ ...start, blocks: { ...start.blocks, [a]: { ...start.blocks[a], title: "e" + i } } }));
    store.setState({ past, project: { ...start, blocks: { ...start.blocks, [a]: { ...start.blocks[a], title: "current" } } }, saveState: "unsaved" });
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    const t0 = performance.now();
    reloadDoc();
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(250); // CIの揺れを許容。実測はログに残す。
    expect(store.getState().project!.blocks[b].title).toBe("Remote");
    console.log("perf", JSON.stringify({ bytes: L.length, ms: Math.round(ms), past: store.getState().past.length, merged: store.getState().project!.blocks[b].title }));
  }, 60000);
});

it("保存済みの外部読み込みと連続した外部統合も、Undo/Redoで取り消さない", async () => {
  const { L, a, b } = plans();
  const store = await open(L);
  store.getState().apply(p => updateBlock(p, a, { title: "Local" }));
  store.getState().saveNow(); await wait(40);
  expect(store.getState().saveState).toBe("saved");
  ext.disk = toJSON(updateBlock(fromJSON(ext.disk), b, { title: "Remote1" })) + "\n";
  reloadDoc();
  ext.disk = toJSON(updateBlock(fromJSON(ext.disk), b, { description: "Remote2" })) + "\n";
  reloadDoc();
  expect(store.getState().past).toHaveLength(1); // 外部更新自体は履歴に足さない。
  store.getState().undo();
  let p = store.getState().project!;
  expect([p.blocks[a].title, p.blocks[b].title, p.blocks[b].description]).toEqual(["A", "Remote1", "Remote2"]);
  store.getState().redo();
  p = store.getState().project!;
  expect([p.blocks[a].title, p.blocks[b].title, p.blocks[b].description]).toEqual(["Local", "Remote1", "Remote2"]);
});
