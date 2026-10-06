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
/** 編集画面の帯 (保存の帯と、取り込みの帯) を、文字列として描画する (画面に文字が現れることを確かめる) */
async function render(): Promise<string> {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { RestoreNoticeView } = await import("../panels/SaveNotice");
  const { useProjectStore } = await import("./useProjectStore");
  // (サーバーの描画は store の初めの状態を読むので、今の状態を見た目の部品に渡して描画する)
  const state = useProjectStore.getState();
  const restore = state.restoreNotice ? renderToStaticMarkup(createElement(RestoreNoticeView, { notice: state.restoreNotice, onSave: () => {}, onDismiss: () => {} })) : "";
  // (保存の帯は、保存の失敗のときだけ「保存を再試行」を出す。取り込みの案内は保存の失敗にしないので、ここに再試行は出ない)
  const save = state.saveError ? `<span>${state.saveError}</span><button>保存を再試行</button>` : "";
  return save + restore;
}
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

  it("R43-01: 画面の段を選んで取り込んだ後、エディタの段が検査で失敗したら、どこまで取り込めたかを、欄を閉じても見える帯に出す", async () => {
    const { L, a, b } = plans();
    const now = updateBlock(fromJSON(L), a, { title: "CURRENT" }); now.blocks[b].parentId = a;   // 今: A の題名、B を A の子に
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));                            // 画面: A の題名
    const e = fromJSON(L); e.blocks[a].parentId = b;                                            // エディタ: A を B の子に (今と合わせると循環)
    const store = await openStore(toJSON(now));
    const rec = { boxglowRecovery: 1, base: L, received: null, gui: { text: G }, editor: { text: toJSON(e), version: 3 } };
    expect(store.getState().restoreEvacuated(rec)).toEqual({ applied: false, conflicts: 1 });
    const pending = store.getState().restorePending!;
    expect(pending.step).toBe("gui");
    expect(store.getState().applyRestorePicks({ [pending.conflicts[0].id]: "saved" })).toBeNull();
    expect(store.getState().restorePending).toBeNull();
    expect(store.getState().project!.blocks[a].title).toBe("GUI");
    // 取り込みの案内 (保存の失敗ではない) に、どこまで取り込めたかが出る
    expect(store.getState().restoreNotice).toMatchObject({ kind: "partial" });
    expect(store.getState().restoreNotice!.text).toContain("取り込めませんでした");
    expect(store.getState().restoreNotice!.text).toContain("画面側");
    expect(store.getState().saveError).toBeNull();
    // R44-01 / R44-02: 編集画面の帯に出る。操作は「確かめた今の中身を保存」で、保存の再試行は出ない
    const html = await render();
    expect(html).toContain("取り込めませんでした");
    expect(html).toContain("確かめた今の中身を保存");
    expect(html).not.toContain("保存を再試行");
  });

  it("R43-02: 取り込みの確認の途中は、別の退避ファイルを読まない (欄と取り込む対象を取り違えない)", async () => {
    const { L, a, b } = plans();
    const now = updateBlock(fromJSON(L), a, { title: "CURRENT" });
    const store = await openStore(toJSON(now));
    const X = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));
    expect(store.getState().restoreEvacuated(recovery(L, X))).toEqual({ applied: false, conflicts: 1 });
    const Y = toJSON(updateBlock(fromJSON(L), b, { title: "NEW FILE B" }));
    const second = store.getState().restoreEvacuated(recovery(L, Y));
    expect("error" in second && second.error).toContain("確認の途中");
    expect(store.getState().project!.blocks[b].title).toBe("B");
    expect(store.getState().restorePending!.recovery.gui).toBe(X);
    store.getState().cancelRestore();
    // やめた後は読める
    expect(store.getState().restoreEvacuated(recovery(L, Y))).toEqual({ applied: true, conflicts: 0 });
    expect(store.getState().project!.blocks[b].title).toBe("NEW FILE B");
  });

  it("R44-01: 全部取り込めた・次の段へ・段をやめた、の案内が、編集画面の帯に出る", async () => {
    const { L, a, b } = plans();
    const store = await openStore(L);
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));
    const E = toJSON(updateBlock(updateBlock(fromJSON(L), a, { title: "EDITOR" }), b, { title: "E-B" }));
    const rec = { boxglowRecovery: 1, base: L, received: null, gui: { text: G }, editor: { text: E, version: 3 } };
    // 画面の段は競合なしで取り込み、エディタの段で確認へ
    expect(store.getState().restoreEvacuated(rec)).toEqual({ applied: false, conflicts: 1 });
    expect(store.getState().restorePending!.step).toBe("editor");
    expect(await render()).toContain("次に、エディタ側の編集を確かめてください");
    // この段をやめる
    store.getState().cancelRestore();
    const html = await render();
    expect(html).toContain("エディタ側の編集は取り込みませんでした");
    expect(html).not.toContain("保存を再試行");
    expect(store.getState().project!.blocks[a].title).toBe("GUI");
    // 閉じると消える。Save でも消える
    store.getState().dismissRestoreNotice();
    expect(await render()).not.toContain("取り込み");
    store.getState().undo();
    store.getState().saveNow();
    expect(store.getState().restoreNotice).toBeNull();
  });
});
