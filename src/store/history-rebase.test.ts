import { expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, removeBlock, toJSON } from "../model/graph";
import { externalHistoryPatch, combineHistoryPatch, applyHistoryPatch, historyPatchMasksChanges } from "./history-rebase";
const fixture = () => { const initial = createProject("P"); const a = addBlock(initial, { parentId: defaultTaskParent(initial), title: "A" }); const b = addBlock(a.project, { parentId: defaultTaskParent(a.project), title: "B" }); return { p: b.project, a: a.blockId, b: b.blockId }; };
it("200更新を1項目の予約へ合成し、更新回数分のデータを保持しない", () => {
  const { p, b } = fixture(); let previous = p; let patch;
  for (let i = 0; i < 200; i++) { const next = { ...previous, blocks: { ...previous.blocks, [b]: { ...previous.blocks[b], title: "R" + i } } }; patch = combineHistoryPatch(patch, externalHistoryPatch(previous, next)); previous = next; }
  expect(JSON.stringify(patch).length).toBeLessThan(1500);
  expect(applyHistoryPatch(p, patch!)!.blocks[b].title).toBe("R199");
});
it("元の値に戻った外部変更も残し、途中で保存した自分の編集を履歴へ混ぜない", () => {
  const { p, a, b } = fixture(); const r1 = structuredClone(p); r1.blocks[b].title = "R1";
  const saved = structuredClone(r1); saved.blocks[a].title = "自分が保存した変更";
  const r2 = structuredClone(saved); r2.blocks[b].title = p.blocks[b].title;
  const patch = combineHistoryPatch(externalHistoryPatch(p, r1), externalHistoryPatch(saved, r2));
  const old = structuredClone(p); old.blocks[b].title = "昔の編集";
  const result = applyHistoryPatch(old, patch)!;
  expect(result.blocks[a].title).toBe("A"); expect(result.blocks[b].title).toBe("B");
});
it("外部が親を消した後、昔の子から親を復元する履歴は拒否する", () => {
  const { p, a } = fixture(); const child = addBlock(p, { parentId: a, title: "Y" });
  const patch = externalHistoryPatch(p, removeBlock(p, a)); const before = toJSON(child.project);
  expect(applyHistoryPatch(child.project, patch)).toBeNull(); expect(toJSON(child.project)).toBe(before);
});
it("メンバーの配列はIDで更新し、無関係なメンバーやログを保持する", () => {
  const { p } = fixture(); p.members = [{ id: "m", name: "M", color: "red" }];
  const remote = structuredClone(p); remote.members[0].name = "N";
  const old = structuredClone(p); old.members.push({ id: "local", name: "Local", color: "blue" });
  const result = applyHistoryPatch(old, externalHistoryPatch(p, remote))!;
  expect(result.members.map(m => m.name)).toEqual(["N", "Local"]);
});

it("履歴に無い既存対象を外部の変更だけで再作成しない", () => {
  const { p, a } = fixture(), old = removeBlock(p, a), remote = structuredClone(p);
  remote.blocks[a].title = "Remote";
  expect(applyHistoryPatch(old, externalHistoryPatch(p, remote))).toBeNull();
});
it("外部の配線が失う端は黙って削除せず矛盾にする", () => {
  const { p, a, b } = fixture(), old = removeBlock(p, a), remote = structuredClone(p);
  const from = Object.values(p.ports).find(v => v.blockId === b)!;
  const to = Object.values(p.ports).find(v => v.blockId === a)!;
  remote.edges.external = { id: "external", from: { portId: from.id, side: "outer" }, to: { portId: to.id, side: "outer" }, kind: "sibling", auto: false };
  expect(applyHistoryPatch(old, externalHistoryPatch(p, remote))).toBeNull();
});
it.each(["position", "artifacts", "decisions", "assigneeIds"] as const)("%sの一部を戻せない場合を識別し、外部だけの変更では通知しない", field => {
  const { p, a } = fixture(); const saved = structuredClone(p), remote = structuredClone(p);
  const local = field === "position" ? {x: 100, y: 0} : ["local"];
  const latest = field === "position" ? {x: 100, y: 300} : ["local", "remote"];
  // 通知判定は項目を不透明な値として扱うため、配列の内容によらず同じ規則。
  Object.assign(saved.blocks[a], {[field]: local}); Object.assign(remote.blocks[a], {[field]: latest});
  const patch = externalHistoryPatch(saved, remote);
  expect(historyPatchMasksChanges(p, patch)).toBe(true);
  expect(historyPatchMasksChanges(saved, patch)).toBe(false);
});

it("Undoの正規化で外部の担当参照を失う段を拒否する", () => {
  const { p, a } = fixture(), saved = structuredClone(p);
  saved.members = [{id: "m1", name: "M1", color: "red"}, {id: "m2", name: "M2", color: "blue"}];
  saved.blocks[a].assigneeIds = ["m1"];
  const remote = structuredClone(saved); remote.blocks[a].assigneeIds.push("m2");
  const patch = externalHistoryPatch(saved,remote);
  expect(applyHistoryPatch(p,patch)).toBeNull();
  expect(applyHistoryPatch(saved,patch)!.blocks[a].assigneeIds).toEqual(["m1","m2"]);
});
it("Undoの正規化で外部の入力グループ参照を失う段を拒否する", () => {
  const { p } = fixture(), saved = structuredClone(p), id = Object.keys(p.ports)[0];
  saved.inputGroups = [{id: "g", name: "G", description: "", position: {x:0,y:0}}];
  const remote = structuredClone(saved); remote.ports[id].groupId = "g";
  const patch = externalHistoryPatch(saved,remote);
  expect(applyHistoryPatch(p,patch)).toBeNull();
  expect(applyHistoryPatch(saved,patch)!.ports[id].groupId).toBe("g");
});

it("C2 L-2: claimsとpolicyの予約では編集を戻せないと通知せず、実際の名前の競合は通知",()=>{
 const {p}=fixture();const base={...p,claimPolicy:{mode:"warn" as const,leaseMinutes:30}},snapshot={...base,claimPolicy:{mode:"off" as const,leaseMinutes:30}};
 const remote={...base,claimPolicy:{mode:"reject" as const,leaseMinutes:30}};
 expect(historyPatchMasksChanges(snapshot,externalHistoryPatch(base,remote))).toBe(false);
 expect(historyPatchMasksChanges({...snapshot,name:"old name"},externalHistoryPatch(base,{...remote,name:"remote"}))).toBe(true);
});
