/**
 * 再検証 (B4): 拡張の模擬を今の saveFailureBase / conflictSnapshot に合わせ、
 * 保存処理中の読み直し、S-1、遅延した履歴の統合 (複数回の外部更新・失敗時・性能・保持量) を確かめる
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { conflictSnapshot, saveFailureBase } from "../../vscode/src/save";
import { addBlock, createProject, defaultTaskParent, fromJSON, removeBlock, toJSON, updateBlock } from "../model/graph";

const ext = { disk: "", doc: "", version: 1, diskBase: "", dirty: false, saving: false };
const sent: Record<string, unknown>[] = [];
let target: EventTarget;
const deliver = (data: unknown) => { target.dispatchEvent(new MessageEvent("message", { data })); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function send(type: "load" | "update") {
  if (!ext.dirty && !ext.saving && ext.disk === ext.doc) ext.diskBase = ext.doc;
  deliver({ type, text: ext.doc, version: ext.version, name: "boxglow.json" });
}
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
      const snap = conflictSnapshot(ext.disk, ext.doc, ext.dirty);
      ext.diskBase = saveFailureBase(ext.diskBase, ext.disk, ext.doc, ext.dirty);
      deliver({ type: "save-error", requestId: msg.requestId, error: "競合しました", conflict: true, ...snap, version: ext.version });
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
/** 外部 (CLI) がディスクを書き、VS Code が読み直す */
const external = (f: (p: ReturnType<typeof fromJSON>) => ReturnType<typeof fromJSON>) => { ext.disk = toJSON(f(fromJSON(ext.disk))) + "\n"; reloadDoc(); };

describe("B4 再検証", () => {
  it("前回 N-1: 保存処理の最中の読み直しで止まらない", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "Local" }));
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    beforeCheck = () => { reloadDoc(); };
    store.getState().saveNow();
    await wait(200);
    const s = store.getState();
    console.log("N-1", JSON.stringify({ saves: sent.filter((m) => m.type === "save").length, saveState: s.saveState, err: s.saveError, disk: titles(ext.disk, a, b) }));
    expect(titles(ext.disk, a, b)).toEqual(["Local", "Remote"]);
  });

  it("S-1 保持: 文書が古いまま、2 回目の応答で古い文書を最新と取り違えない", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "Local" }));
    ext.disk = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" })) + "\n";
    store.getState().saveNow(); await wait(50);
    store.getState().saveNow(); await wait(50);   // 利用者が再試行
    const mid = titles(ext.disk, a, b);
    reloadDoc(); await wait(1200);
    console.log("S-1", JSON.stringify({ mid, final: titles(ext.disk, a, b), saveState: store.getState().saveState }));
    expect(mid[1]).toBe("Remote");
    expect(titles(ext.disk, a, b)).toEqual(["Local", "Remote"]);
  });

  it("遅延履歴: 自分の編集 2 段 + 外部更新 3 回 (未保存中と保存済み) のあと Undo/Redo で相手の変更が残る", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "e1" }));
    store.getState().apply((q) => updateBlock(q, a, { description: "e2" }));
    external((p) => updateBlock(p, b, { title: "R1" }));            // 未保存中 → 自動統合
    await wait(900);
    external((p) => updateBlock(p, b, { description: "R2" }));      // 保存済み → 読み直し
    await wait(50);
    external((p) => updateBlock(p, a, { description: "R3" }));      // 自分の e2 と同じ項目を相手が上書き
    await wait(50);
    const st = () => { const p = store.getState().project!; return [p.blocks[a].title, p.blocks[a].description, p.blocks[b].title, p.blocks[b].description].join("/"); };
    const log = [st()];
    store.getState().undo(); log.push("u1 " + st());
    store.getState().undo(); log.push("u2 " + st());
    store.getState().undo(); log.push("u3 " + st() + " past=" + store.getState().past.length);
    store.getState().redo(); log.push("r1 " + st());
    store.getState().redo(); log.push("r2 " + st());
    console.log("multi", JSON.stringify(log));
    const p = store.getState().project!;
    expect([p.blocks[b].title, p.blocks[b].description]).toEqual(["R1", "R2"]);
  });

  it("遅延履歴: 付け替えに失敗する段があると、Undo は何をするか (履歴全体を黙って捨てないか)", async () => {
    let p0 = createProject("検証");
    const x = addBlock(p0, { parentId: defaultTaskParent(p0), title: "X" }); p0 = x.project;
    const L = toJSON(p0) + "\n";
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, x.blockId, { description: "d1" }));             // 段1
    let yId = "";
    store.getState().apply((q) => { const r = addBlock(q, { parentId: x.blockId, title: "Y" }); yId = r.blockId; return r.project; }); // 段2: X の下に Y
    store.getState().apply((q) => removeBlock(q, yId));                                        // 段3: Y を消す
    await wait(900);  // 保存済み
    store.getState().apply((q) => ({ ...q, name: "名前を変更" }));                              // 段4 (未保存)
    external((q) => removeBlock(q, x.blockId));   // 相手が X を削除
    await wait(900);
    const before = store.getState().past.length;
    store.getState().undo();
    const s1 = { pastBefore: before, pastAfter: store.getState().past.length, name: store.getState().project!.name, hasX: !!store.getState().project!.blocks[x.blockId] };
    store.getState().undo();
    const s2 = { pastAfter: store.getState().past.length, hasX: !!store.getState().project!.blocks[x.blockId], hasY: !!store.getState().project!.blocks[yId], toast: store.getState().toast };
    console.log("fail", JSON.stringify({ s1, s2 }));
    expect(s1.pastAfter).toBe(before - 1); expect(s2.pastAfter).toBe(0);
    expect(s2.toast).toMatch(/戻せません|Cannot undo/);
    expect(s2.hasX || s2.hasY).toBe(false);
    expect(store.getState().future).toHaveLength(1); // 戻せた直近の段は残す。
    store.getState().redo(); expect(store.getState().project!.name).toBe("名前を変更");
  });

  it("性能と保持量: 1500 ボックス・履歴 100 段、外部更新 20 回のあと Undo 1 回 / 外部更新 200 回のヒープ", async () => {
    const { L, a, b } = plans(1500);
    const store = await open(L);
    const start = store.getState().project!;
    store.setState({ past: Array.from({length: 100}, (_, i) => ({ ...start, blocks: { ...start.blocks, [a]: { ...start.blocks[a], title: "e" + i } } })),
      project: { ...start, blocks: { ...start.blocks, [a]: { ...start.blocks[a], title: "current" } } }, saveState: "unsaved" });
    store.getState().saveNow(); await wait(300);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); external((q) => updateBlock(q, b, { title: "R" + i })); times.push(performance.now() - t0); await wait(5); }
    const t0 = performance.now();
    store.getState().undo();
    const undoMs = performance.now() - t0;
    const t1 = performance.now();
    store.getState().undo();
    const undo2Ms = performance.now() - t1;
    console.log("perf", JSON.stringify({ updateMsMax: Math.round(Math.max(...times)), undoMs: Math.round(undoMs), undo2Ms: Math.round(undo2Ms), b: store.getState().project!.blocks[b].title, a: store.getState().project!.blocks[a].title }));
    expect(undoMs).toBeLessThan(250); expect(undo2Ms).toBeLessThan(250);
    // GC後の保持量。通常の単体実行ではGCを強制しないため、保持量の合否は専用実行でのみ判定する。
    sent.length = 0;
    (globalThis as { gc?: () => void }).gc?.();
    if (process.env.BOXGLOW_MEMORY_CHECK) expect(typeof (globalThis as { gc?: unknown }).gc).toBe("function");
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 200; i++) { external((q) => updateBlock(q, b, { description: "M" + i })); if (i % 20 === 0) await wait(1); }
    await wait(50);
    (globalThis as { gc?: () => void }).gc?.();
    const h1 = process.memoryUsage().heapUsed;
    const after200 = performance.now(); store.getState().undo(); const undoAfter200Ms = performance.now() - after200;
    console.log("heap", JSON.stringify({ forcedGC: !!process.env.BOXGLOW_MEMORY_CHECK, planKB: Math.round(L.length / 1024), growMB: (h1 - h0) / 1048576, undoAfter200Ms }));
    expect(undoAfter200Ms).toBeLessThan(250);
    if (process.env.BOXGLOW_MEMORY_CHECK) expect(h1 - h0).toBeLessThan(16 * 1048576);
    expect(store.getState().project!.blocks[b].description).toBe("M199");
  }, 600000);
});


it("自己通知のハッシュ計算中に届く最新更新を取りこぼさない", async () => {
  const { L, a, b } = plans(); const store = await open(L);
  const digest = crypto.subtle.digest.bind(crypto.subtle); let calls = 0;
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    const hash = await digest(...args);
    if (++calls === 1) reloadDoc(); // 保存済み本文の自己通知。
    else if (calls === 2) external(q => updateBlock(q, b, { title: "Latest during hash" }));
    return hash;
  });
  try {
    store.getState().apply(q => updateBlock(q, a, { title: "Local" }));
    store.getState().saveNow(); await wait(200);
    expect(titles(ext.disk, a, b)).toEqual(["Local", "Latest during hash"]);
    expect(titles(toJSON(store.getState().project!), a, b)).toEqual(["Local", "Latest during hash"]);
    expect(store.getState().saveState).toBe("saved");
  } finally { spy.mockRestore(); }
});
