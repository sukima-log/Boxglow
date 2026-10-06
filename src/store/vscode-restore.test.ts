/**
 * VS Code の中の store の試験 (Node で、最小の window と、拡張の代わりの postMessage を用意して、本物の store を動かす)
 * 退避した編集の取り込みの、表示の鮮度 (R41-01) と、保存の境界 (R41-03) を確かめる
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";

/** 拡張に送られたもの (保存の要求など) */
const sent: { type: string; requestId?: string; text?: string }[] = [];
let target: EventTarget;
beforeAll(() => {
  target = new EventTarget();
  const w = target as unknown as Record<string, unknown>;
  w.acquireVsCodeApi = () => ({ postMessage: (m: { type: string }) => { sent.push(m); }, getState: () => undefined, setState: () => {} });
  w.location = { search: "" };
  (globalThis as unknown as { window: unknown }).window = w;
  (globalThis as unknown as { confirm: unknown }).confirm = () => true;
});
afterEach(() => { sent.length = 0; });
/** 拡張からのメッセージを届ける */
const deliver = (data: unknown) => { target.dispatchEvent(new MessageEvent("message", { data })); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ドキュメントの版 (試験をまたいで増やす。店は古い版の load / update を捨てるので) */
let version = 100;

/** 基準 L、今の中身 R (= 開き直した最新)、退避した画面の編集 G */
function plans() {
  let p = createProject("店の試験");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
  const L = toJSON(p);
  return { L, a: a.blockId, b: b.blockId };
}
const recovery = (base: string, gui: string) => ({ boxglowRecovery: 1, base, received: null, gui: { text: gui }, editor: null });

async function openStore(text: string) {
  const { useProjectStore } = await import("./useProjectStore");
  const store = useProjectStore;
  // (前の試験の計画を残さない: VS Code の外として始め、load で置き換える)
  store.setState({ source: "idb" as never, project: null, restorePending: null });
  store.getState().openFromVsCode();
  deliver({ type: "load", text, version: ++version, name: "boxglow.json" });
  await wait(10);
  return store;
}

describe("退避した編集の取り込み (VS Code の store)", () => {
  it("R41-01: 欄を開いた後で今の中身が変わったら、古い選択では取り込まず、今の値で選び直させる", async () => {
    const { L, a } = plans();
    const R1 = toJSON(updateBlock(fromJSON(L), a, { title: "R1" }));
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));
    const store = await openStore(R1);
    const result = store.getState().restoreEvacuated(recovery(L, G));
    expect(result).toEqual({ applied: false, conflicts: 1 });
    const shown = store.getState().restorePending!;
    expect(shown.conflicts[0]).toMatchObject({ current: "R1", saved: "GUI" });
    // 選ぶ間に、外からの更新で R2 になる
    const R2 = toJSON(updateBlock(fromJSON(L), a, { title: "R2" }));
    deliver({ type: "update", text: R2, version: ++version, name: "boxglow.json" });
    await wait(10);
    expect(store.getState().project!.blocks[a].title).toBe("R2");
    const message = store.getState().applyRestorePicks({ [shown.conflicts[0].id]: "saved" });
    expect(message).toContain("選び直して");
    expect(store.getState().project!.blocks[a].title).toBe("R2");
    // 欄は今の値で作り直されている
    expect(store.getState().restorePending!.conflicts[0]).toMatchObject({ current: "R2", saved: "GUI" });
    store.getState().cancelRestore();
  });

  it("R41-03: 取り込んだ後は、保存の予約や進行中の保存の続きで送らない。Save を押したときだけ送る", async () => {
    const { L, a, b } = plans();
    const store = await openStore(L);
    // 通常の編集で、保存を予約する (まだ送られていない)
    store.getState().apply((p) => updateBlock(p, b, { title: "通常の編集" }));
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));
    expect(store.getState().restoreEvacuated(recovery(L, G))).toEqual({ applied: true, conflicts: 0 });
    await wait(600);
    expect(sent.filter((m) => m.type === "save")).toEqual([]);
    expect(store.getState().saveState).toBe("unsaved");
    // 取り消せる
    expect(store.getState().past.length).toBeGreaterThan(0);
    // Save で送る (取り込んだ中身と、通常の編集の両方が入る)
    store.getState().saveNow();
    await wait(10);
    const saves = sent.filter((m) => m.type === "save");
    expect(saves.length).toBe(1);
    expect(fromJSON(saves[0].text!).blocks[a].title).toBe("GUI");
    expect(fromJSON(saves[0].text!).blocks[b].title).toBe("通常の編集");
  });

  it("R41-03: 保存の応答を待つ間に取り込んでも、その保存が終わった後に、取り込んだ中身を続けて送らない", async () => {
    const { L, a, b } = plans();
    const store = await openStore(L);
    store.getState().apply((p) => updateBlock(p, b, { title: "通常の編集" }));
    store.getState().saveNow();
    await wait(10);
    const first = sent.filter((m) => m.type === "save");
    expect(first.length).toBe(1);
    // 応答を待つ間に取り込む
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));
    expect(store.getState().restoreEvacuated(recovery(L, G))).toEqual({ applied: true, conflicts: 0 });
    // 前の保存が終わる
    deliver({ type: "saved", requestId: first[0].requestId, version: ++version });
    await wait(600);
    expect(sent.filter((m) => m.type === "save").length).toBe(1);
    expect(store.getState().saveState).toBe("unsaved");
    expect(store.getState().project!.blocks[a].title).toBe("GUI");
  });
});
