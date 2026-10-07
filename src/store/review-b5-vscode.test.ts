/**
 * 再検証 (B5): 拡張の模擬を今の saveFailureBase / conflictSnapshot に合わせ、
 * 保存処理中の読み直し、S-1、遅延した履歴の統合 (複数回の外部更新・失敗時・性能・保持量) を確かめる
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { conflictSnapshot, saveFailureBase } from "../../vscode/src/save";
import { connectToBlock, addPort, addBlock, createProject, defaultTaskParent, fromJSON, removeBlock, toJSON, updateBlock } from "../model/graph";

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
function plans() {
  let p = createProject("検証");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
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

describe("B5 再検証", () => {
  const st = (store: any, a: string, b: string) => { const p = store.getState().project!; return [p.blocks[a].title, p.blocks[a].description, p.blocks[b].title, p.blocks[b].description].join("/"); };
  it("混在: Undo → 外部 → Redo → 外部 → Undo", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "e1" }));
    store.getState().apply((q) => updateBlock(q, a, { description: "e2" }));
    await wait(900);                                   // 保存済み
    const log = [st(store, a, b)];
    store.getState().undo(); log.push("u " + st(store, a, b));
    external((p) => updateBlock(p, b, { title: "R1" })); await wait(900); log.push("ext1 " + st(store, a, b));
    store.getState().redo(); log.push("r " + st(store, a, b));
    external((p) => updateBlock(p, b, { description: "R2" })); await wait(900); log.push("ext2 " + st(store, a, b));
    store.getState().undo(); log.push("u " + st(store, a, b));
    store.getState().undo(); log.push("u " + st(store, a, b));
    store.getState().redo(); store.getState().redo(); log.push("rr " + st(store, a, b));
    await wait(900); log.push("disk " + titles(ext.disk, a, b).join("/") + " " + fromJSON(ext.disk).blocks[b].description);
    console.log("mix", JSON.stringify(log));
    expect(st(store, a, b)).toBe("e1/e2/R1/R2");
  });
  it("外部が変えて戻した項目・削除して再作成した項目", async () => {
    const { L, a, b } = plans();
    const store = await open(L);
    store.getState().apply((q) => updateBlock(q, a, { title: "e1" }));
    await wait(900);
    external((p) => updateBlock(p, b, { title: "R" })); await wait(300);
    external((p) => updateBlock(p, b, { title: "B" })); await wait(300);
    let cId = "";
    external((p) => { const r = addBlock(p, { parentId: defaultTaskParent(p), title: "C" }); cId = r.blockId; return r.project; }); await wait(300);
    external((p) => removeBlock(p, cId)); await wait(300);
    store.getState().undo();
    const p = store.getState().project!;
    expect(p.blocks[a].title).toBe("A"); expect(p.blocks[b].title).toBe("B"); expect(p.blocks[cId]).toBeUndefined();
  });
  it("複合の項目: 自分が保存した位置 x と相手の位置 y。位置の移動を Undo すると x は戻るか", async () => {
    const { L, a } = plans();
    const store = await open(L);
    const x0 = fromJSON(L).blocks[a].position;
    store.getState().apply((q) => ({ ...q, blocks: { ...q.blocks, [a]: { ...q.blocks[a], position: { x: x0.x + 500, y: x0.y } } } }));   // 自分が x を動かす
    await wait(900);                                                                                   // 保存済み
    external((p) => ({ ...p, blocks: { ...p.blocks, [a]: { ...p.blocks[a], position: { x: p.blocks[a].position.x, y: p.blocks[a].position.y + 300 } } } })); await wait(300); // 相手が y を動かす
    store.getState().undo();
    const pos = store.getState().project!.blocks[a].position;
    console.log("position", JSON.stringify({ x0, after: pos, toast: store.getState().toast }));
    expect(pos.x).toBe(x0.x + 500); // 項目全体を保つ方針。その制限を通知する。
    expect(store.getState().toast).toMatch(/一部.*相手の変更/);
  });
  it("自分が作って保存したボックスを相手が改名 → 作成を Undo", async () => {
    const { L } = plans();
    const store = await open(L);
    let nId = "";
    store.getState().apply((q) => { const r = addBlock(q, { parentId: defaultTaskParent(q), title: "N" }); nId = r.blockId; return r.project; });
    await wait(900);
    const ports = Object.values(fromJSON(ext.disk).ports).filter((x: any) => x.blockId === nId).length;
    external((p) => updateBlock(p, nId, { title: "N renamed" })); await wait(300);
    store.getState().undo();
    const p = store.getState().project!;
    expect(p.blocks[nId].title).toBe("N renamed");
    expect(Object.values(p.ports).filter(x => x.blockId === nId)).toHaveLength(ports);
    expect(store.getState().toast).toMatch(/これより前には戻せません/);
    const disk = ext.disk, saves = sent.filter(m => m.type === "save").length;
    await wait(900); expect(ext.disk).toBe(disk); expect(sent.filter(m => m.type === "save")).toHaveLength(saves);
  });
  it("相手が、自分の作ったボックス N に配線した後で、N の作成を Undo", async () => {
    const { L, a } = plans();
    const store = await open(L);
    let nId = "";
    store.getState().apply((q) => { const r = addBlock(q, { parentId: defaultTaskParent(q), title: "N" }); nId = r.blockId; return r.project; });
    await wait(900);
    external((p) => { const o = addPort(p, { blockId: a, direction: "out", name: "出力" }); const r = connectToBlock(o.project, { portId: o.portId, side: "outer" } as never, nId); if (r.error) console.log("connect error", r.error); return r.project; });
    await wait(300);
    const diskEdges = Object.keys(fromJSON(ext.disk).edges).length;
    const diskBefore = ext.disk, savesBefore = sent.filter(m => m.type === "save").length;
    store.getState().undo();
    await wait(900);
    const p = store.getState().project!;
    expect(p.blocks[nId]).toBeDefined(); expect(Object.keys(p.edges)).toHaveLength(diskEdges);
    expect(ext.disk).toBe(diskBefore); expect(sent.filter(m => m.type === "save")).toHaveLength(savesBefore);
    expect(store.getState().toast).toMatch(/これより前には戻せません/);
    console.log("edge", JSON.stringify({ diskEdgesBefore: diskEdges, hasN: !!p.blocks[nId], edgesAfter: Object.keys(p.edges).length, diskEdgesAfter: Object.keys(fromJSON(ext.disk).edges).length, diskHasN: !!fromJSON(ext.disk).blocks[nId], toast: store.getState().toast, past: store.getState().past.length }));
  });
  it("B3-2: 矛盾する段で通知し、Redo は残る", async () => {
    let p0 = createProject("検証");
    const x = addBlock(p0, { parentId: defaultTaskParent(p0), title: "X" }); p0 = x.project;
    const store = await open(toJSON(p0) + "\n");
    store.getState().apply((q) => updateBlock(q, x.blockId, { description: "d1" }));
    let yId = "";
    store.getState().apply((q) => { const r = addBlock(q, { parentId: x.blockId, title: "Y" }); yId = r.blockId; return r.project; });
    store.getState().apply((q) => removeBlock(q, yId));
    await wait(900);
    store.getState().apply((q) => ({ ...q, name: "名前を変更" }));
    external((q) => removeBlock(q, x.blockId)); await wait(900);
    store.getState().undo(); store.getState().undo();
    const s = store.getState();
    console.log("b32", JSON.stringify({ past: s.past.length, future: s.future.length, toast: s.toast, name: s.project!.name }));
    expect(s.past).toHaveLength(0); expect(s.future).toHaveLength(1);
    s.redo(); expect(store.getState().project!.name).toBe("名前を変更");
  });
});

it.each(["assignment", "input-group"])("B6: 外部の%s参照を失うUndoは拒否し、保存しない", async kind => {
  const { L, a } = plans(); const store = await open(L);
  const id = Object.keys(fromJSON(L).ports)[0];
  store.getState().apply(q => {
    const p = structuredClone(q);
    if (kind === "assignment") {
      p.members = [{id:"m1",name:"M1",color:"red"},{id:"m2",name:"M2",color:"blue"}];
      p.blocks[a].assigneeIds = ["m1"];
    } else p.inputGroups = [{id:"g",name:"G",description:"",position:{x:0,y:0}}];
    return p;
  });
  await wait(900);
  external(p => {
    if (kind === "assignment") p.blocks[a].assigneeIds.push("m2");
    else p.ports[id].groupId = "g";
    return p;
  });
  await wait(100);
  const disk = ext.disk, current = toJSON(store.getState().project!), saves = sent.filter(m => m.type === "save").length;
  store.getState().undo();
  expect(store.getState().toast).toMatch(/これより前には戻せません/);
  expect(toJSON(store.getState().project!)).toBe(current);
  await wait(900);
  expect(ext.disk).toBe(disk); expect(sent.filter(m => m.type === "save")).toHaveLength(saves);
});

it("C2 L-1: 人の解除・設定のログをUndo/Redoとディスクにも保持",async()=>{
 const {L,a}=plans();const store=await open(L);store.getState().setToast(null);
 store.getState().apply(p=>updateBlock(p,a,{title:"own edit"}));await wait(500);
 store.getState().apply(p=>({...p,claimPolicy:{mode:"reject",leaseMinutes:30},log:[...p.log,{id:"claim-policy-event",at:new Date().toISOString(),actor:"human",kind:"note",claimEvent:"policy",message:"設定"},{id:"claim-release-event",at:new Date().toISOString(),actor:"human",kind:"note",claimEvent:"release",message:"解除"}]}),{history:false});
 await wait(500);store.getState().undo();await wait(500);
 expect(store.getState().project!.blocks[a].title).toBe("A");expect(store.getState().project!.claimPolicy!.mode).toBe("reject");
 for(const text of [toJSON(store.getState().project!),ext.disk]){const p=fromJSON(text);expect(p.log.filter(e=>e.claimEvent)).toHaveLength(2);}
 store.getState().redo();await wait(500);expect(fromJSON(ext.disk).log.filter(e=>e.claimEvent)).toHaveLength(2);expect(fromJSON(ext.disk).blocks[a].title).toBe("own edit");
});
it("C2 L-2/L-3: 延長だけは無通知で保存しUndoも誤通知しない、通常編集は通知",async()=>{
 const {L,a,b}=plans();const p=fromJSON(L),at=Date.parse("2026-10-08T00:00:00Z");
 p.claimPolicy={mode:"reject",leaseMinutes:30};p.claims={[a]:{actor:"codex",instanceId:"session",claimId:"claim",scope:"block",generation:1,acquiredAt:new Date(at).toISOString(),renewedAt:new Date(at).toISOString(),expiresAt:new Date(at+1800000).toISOString()}};
 const store=await open(toJSON(p));store.getState().setToast(null);
 store.getState().apply(q=>updateBlock(q,a,{title:"first"}));
 external(q=>({...q,claims:{...q.claims,[a]:{...q.claims![a],renewedAt:new Date(at+300000).toISOString(),expiresAt:new Date(at+2100000).toISOString()}}}));await wait(600);
 expect(store.getState().toast).toBeNull();expect(fromJSON(ext.disk).blocks[a].title).toBe("first");expect(fromJSON(ext.disk).claims![a].renewedAt).toBe(new Date(at+300000).toISOString());
 store.getState().apply(q=>updateBlock(q,a,{description:"second"}));await wait(500);
 external(q=>({...q,claims:{...q.claims,[a]:{...q.claims![a],renewedAt:new Date(at+600000).toISOString(),expiresAt:new Date(at+2400000).toISOString()}}}));
 store.getState().undo();await wait(500);expect(store.getState().toast).toBeNull();
 store.getState().apply(q=>updateBlock(q,a,{description:"third"}));external(q=>updateBlock(q,b,{title:"remote"}));await wait(600);
 expect(store.getState().toast).toBe("両方の変更を統合して保存しました。");expect(fromJSON(ext.disk).blocks[b].title).toBe("remote");
});
