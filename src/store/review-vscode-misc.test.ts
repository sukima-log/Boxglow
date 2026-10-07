/**
 * 検証: VS Code の store で (1) 検証に通らない最新の中身を保存の衝突で受け取ったとき、(2) 連続編集で 8 回の上限、(3) 自動統合後の Undo
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock, removeBlock } from "../model/graph";

const sent: Record<string, unknown>[] = [];
let target: EventTarget;
const deliver = (data: unknown) => { target.dispatchEvent(new MessageEvent("message", { data })); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let version = 10;
beforeAll(() => {
  target = new EventTarget();
  const w = target as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: (m: Record<string, unknown>) => { sent.push(m); } });
  w.location = { search: "" };
  (globalThis as unknown as { window: unknown }).window = w;
  (globalThis as unknown as { confirm: unknown }).confirm = () => true;
});
afterEach(() => { sent.length = 0; });
function plans() {
  let p = createProject("検証");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
  return { L: toJSON(p), a: a.blockId, b: b.blockId };
}
async function open(text: string) {
  const { useProjectStore: store } = await import("./useProjectStore");
  store.setState({ source: "idb" as never, project: null });
  store.getState().openFromVsCode();
  deliver({ type: "load", text, version: ++version, name: "boxglow.json" });
  await wait(10);
  return store;
}
const lastSave = () => sent.filter((m) => m.type === "save").at(-1)!;

describe("検証", () => {
  it("(1) fromJSON は読めるが validateProjectText が拒む最新 (schemaVersion 4) で保存が止まったままにならないか", async () => {
    const { L, a } = plans();
    const store = await open(L);
    store.getState().apply((p) => updateBlock(p, a, { title: "Local" }));
    store.getState().saveNow();
    const first = lastSave();
    const remote = JSON.stringify({ ...JSON.parse(L), schemaVersion: 4 });
    let thrown: unknown = null;
    try { deliver({ type: "save-error", requestId: first.requestId, conflict: true, text: remote, version: ++version }); } catch (e) { thrown = e; }
    await wait(30);
    const s = store.getState();
    console.log("(1)", JSON.stringify({ thrown: String(thrown), saveState: s.saveState, saveError: s.saveError, conflict: !!s.conflict }));
    // 以後の編集が送られるか
    const before = sent.filter((m) => m.type === "save").length;
    store.getState().apply((p) => updateBlock(p, a, { title: "Local2" }));
    store.getState().saveNow();
    await wait(10);
    console.log("(1) 以後の保存要求の数", sent.filter((m) => m.type === "save").length - before);
    expect(s.saveState).not.toBe("saving");
  }, 15000);

  it("(2) 保存の応答のたびに次の編集が入っていると、8 回で誤ったエラーになるか", async () => {
    const { L, a } = plans();
    const store = await open(L);
    store.getState().apply((p) => updateBlock(p, a, { title: "e0" }));
    store.getState().saveNow();
    for (let i = 1; i <= 9; i++) {
      const req = lastSave();
      store.getState().apply((p) => updateBlock(p, a, { title: "e" + i }));
      deliver({ type: "saved", requestId: req.requestId, version: ++version });
      await wait(5);
    }
    const s = store.getState();
    console.log("(2)", JSON.stringify({ saveState: s.saveState, saveError: s.saveError, saves: sent.filter((m) => m.type === "save").length }));
    expect(s.saveError).toBeNull();
    expect(fromJSON(String(lastSave().text)).blocks[a].title).toBe("e9");
    deliver({ type: "saved", requestId: lastSave().requestId, version: ++version });
    await wait(10);
    expect(store.getState().saveState).toBe("saved");
  });

  it("(3) 自動統合の直後の Undo は、相手の変更を戻して保存するか", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((p) => updateBlock(p, a, { title: "Local" }));
    store.getState().saveNow();
    const first = lastSave();
    const remote = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" }));
    deliver({ type: "save-error", requestId: first.requestId, conflict: true, text: remote, version: ++version });
    await wait(10);
    deliver({ type: "saved", requestId: lastSave().requestId, version: ++version });
    await wait(10);
    store.getState().undo();
    await wait(700);
    const req = lastSave();
    const p = fromJSON(String(req.text));
    expect(p.blocks[a].title).toBe("A");
    expect(p.blocks[b].title).toBe("Remote");
    deliver({ type: "saved", requestId: req.requestId, version: ++version });
    await wait(10);
    store.getState().redo();
    expect(store.getState().project!.blocks[a].title).toBe("Local");
    expect(store.getState().project!.blocks[b].title).toBe("Remote");
  });
});

// 自動保存禁止の境界は通知からも守る。holdSaveは実際の退避取り込みで設定する。
it.each(["held", "behind", "readonly"])("競合ゼロでも %s なら送らない", async kind => {
  const { L, a, b } = plans();
  const store = await open(L);
  const gui = toJSON(updateBlock(fromJSON(L), a, { title: "Local" }));
  if (kind === "held") store.getState().restoreEvacuated({ boxglowRecovery: 1, base: L, received: null, gui: { text: gui }, editor: null });
  else store.getState().apply(p => updateBlock(p, a, { title: "Local" }));
  const remote = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" }));
  if (kind === "behind") deliver({ type: "update", fromDisk: true, text: remote, version: ++version });
  if (kind === "readonly") store.setState({ readonly: true });
  deliver({ type: "save-error", requestId: "", conflict: true, text: remote, version: ++version });
  await wait(600);
  expect(sent.filter(m => m.type === "save")).toHaveLength(0);
  expect(store.getState().conflict).not.toBeNull();
  expect(store.getState().project!.blocks[b].title).toBe("B");
  store.setState({ readonly: false });
});

it("自動統合の保存が失敗した後は、関係ない保存で統合通知を出さない", async () => {
  const { L, a, b } = plans();
  const store = await open(L);
  store.setState({ toast: null });
  store.getState().apply(p => updateBlock(p, a, { title: "Local" }));
  store.getState().saveNow();
  const remote = toJSON(updateBlock(fromJSON(L), b, { title: "Remote" }));
  deliver({ type: "save-error", requestId: lastSave().requestId, conflict: true, text: remote, version: ++version });
  await wait(10);
  deliver({ type: "save-error", requestId: lastSave().requestId, error: "disk error" });
  await wait(10);
  store.getState().apply(p => updateBlock(p, a, { title: "Later" }));
  store.getState().saveNow();
  deliver({ type: "saved", requestId: lastSave().requestId, version: ++version });
  await wait(10);
  expect(store.getState().saveState).toBe("saved");
  expect(store.getState().toast).toBeNull();
});

it("複数段のUndoでも、履歴にだけある子から外部削除した親を復元しない", async () => {
  const { L, a, b } = plans();
  const store = await open(L);
  const old = addBlock(fromJSON(L), { parentId: a, title: "昔の子" }).project;
  // 配置の自動調整を混ぜず、タイトル編集だけの履歴を用意する。
  store.setState({ past: [old, fromJSON(L), updateBlock(fromJSON(L), b, { title: "Local1" })] });
  store.setState({ project: updateBlock(fromJSON(L), b, { title: "Local2" }), saveState: "unsaved" });
  const remote = toJSON(removeBlock(fromJSON(L), a));
  deliver({ type: "update", text: remote, version: ++version });
  await wait(10);
  expect(store.getState().project!.blocks[a]).toBeUndefined();
  // 履歴は使う段で統合する。画面へ出す前に外部削除の保護を検証する。
  store.getState().undo();
  expect(store.getState().project!.blocks[b].title).toBe("Local1");
  store.getState().undo();
  expect(store.getState().project!.blocks[b].title).toBe("B");
  expect(store.getState().project!.blocks[a]).toBeUndefined();
  store.getState().undo(); // 昔の子から削除した親を復元する段は使わず、それ以前を破棄する。
  expect(store.getState().past).toHaveLength(0);
  expect(store.getState().project!.blocks[a]).toBeUndefined();
  store.getState().saveNow();
  deliver({ type: "saved", requestId: lastSave().requestId, version: ++version });
  await wait(10);
});
