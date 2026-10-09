import { expect, it } from "vitest";
import { addBlock, addPort, fromJSON, createProject, defaultTaskParent, resolveChangedOverlaps, updateBlock } from "./graph";
import { blockSize } from "./size";
import daw from "../../examples/logic-daw/boxglow.json";
import type { Project } from "./types";

it("編集対象だけを押し出し、既存の兄弟と原本の位置を保持する", () => {
  let p = createProject("layout");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A", position: { x: 120, y: 96 } });
  const b = addBlock(a.project, { parentId: defaultTaskParent(p), title: "B", position: { x: 120, y: 700 } });
  p = b.project;
  const original = JSON.stringify(p);
  const next = structuredClone(p);
  next.blocks[b.blockId].position.y = 100;
  const fixed = resolveChangedOverlaps(p, next, blockSize);
  expect(fixed.blocks[a.blockId].position).toEqual(p.blocks[a.blockId].position);
  expect(fixed.blocks[b.blockId].position.y).toBeGreaterThan(100);
  expect(JSON.stringify(p)).toBe(original);
});

it("期日・課題・テンプレート・活動の変更で旧配置を整列し直さない", () => {
  let p = createProject("legacy");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A", position: { x: 120, y: 96 } });
  const b = addBlock(a.project, { parentId: defaultTaskParent(p), title: "B", position: { x: 120, y: 288 } });
  p = b.project;
  const next = updateBlock(p, a.blockId, { dueDate: "2026-12-01" });
  const fixed = resolveChangedOverlaps(p, next, blockSize);
  expect(Object.values(fixed.blocks).map(b => b.position)).toEqual(Object.values(p.blocks).map(b => b.position));
});

/** レビューで報告された旧DAWのB6/B7と、B6内の子の配置を再現する。 */
function legacyDaw() {
  const p = fromJSON(JSON.stringify(daw));
  const id = (key: string) => Object.values(p.blocks).find(b => b.key === key)!.id;
  for (const [key, x, y] of [["B6", 120, 76], ["B7", 120, 574], ["B8", 120, 76], ["B9", 634.2, 76], ["B10", 1166.55, 76]] as const) {
    p.blocks[id(key)].position = { x, y };
    p.blocks[id(key)].collapsed = false;
  }
  return { p, id };
}

it("B9へ入力を足して親B6が拡大しても、B6を固定しB7を下へ押す", () => {
  const { p, id } = legacyDaw();
  let next = p;
  for (const name of ["とても長い名前の追加入力の仕様と検証条件", "追加入力2", "追加入力3", "追加入力4"]) {
    next = addPort(next, { blockId: id("B9"), direction: "in", name }).project;
  }
  const original = JSON.stringify(p);
  const fixed = resolveChangedOverlaps(p, next, blockSize);
  expect(blockSize(fixed, id("B6")).height).toBeGreaterThan(blockSize(p, id("B6")).height);
  expect(fixed.blocks[id("B6")].position).toEqual(p.blocks[id("B6")].position);
  expect(fixed.blocks[id("B7")].position.x).toBe(p.blocks[id("B7")].position.x);
  expect(fixed.blocks[id("B7")].position.y).toBeGreaterThan(p.blocks[id("B7")].position.y);
  expect(fixed.blocks[id("B7")].position.y).toBeGreaterThanOrEqual(fixed.blocks[id("B6")].position.y + blockSize(fixed, id("B6")).height + 96);
  expect(JSON.stringify(p)).toBe(original);
});

it("EditでB6を展開しても上下を入れ替えず、B7を下へ押す", () => {
  const { p, id } = legacyDaw();
  p.blocks[id("B6")].collapsed = true;
  p.blocks[id("B7")].position.y = 464;
  const next = updateBlock(p, id("B6"), { collapsed: false });
  const fixed = resolveChangedOverlaps(p, next, blockSize);
  expect(fixed.blocks[id("B6")].position).toEqual(p.blocks[id("B6")].position);
  expect(fixed.blocks[id("B7")].position).toEqual({ x: 120, y: 668 });
});

/** 等間隔の箱。独立した形状で押し出しの連鎖と、64個を超える走査を検査する。 */
function column(count: number) {
  const p = createProject("column");
  const parentId = defaultTaskParent(p);
  const template = p.blocks[parentId];
  for (let i = 0; i < count; i++) {
    const id = `box-${i}`;
    p.blocks[id] = { ...template, id, parentId, kind: "task", title: id, position: { x: 120, y: 96 + i * 196 }, collapsed: true };
  }
  return p;
}
const fixedSize = (p: Project, id: string) => ({ width: 1000, height: p.blocks[id].title === "grown" ? 200 : 100 });

it("拡大による押し出しが80個へ連鎖しても、順序と間隔を維持する", () => {
  const p = column(80);
  const next = updateBlock(p, "box-0", { title: "grown" });
  const fixed = resolveChangedOverlaps(p, next, fixedSize);
  expect(fixed.blocks["box-0"].position).toEqual(p.blocks["box-0"].position);
  for (let i = 1; i < 80; i++) {
    const prev = fixed.blocks[`box-${i - 1}`], current = fixed.blocks[`box-${i}`];
    expect(current.position.x).toBe(120);
    expect(current.position.y).toBe(prev.position.y + fixedSize(fixed, prev.id).height + 96);
  }
});

it("移動した箱が64個を超える兄弟を避けても、最後に重なりを残さない", () => {
  const p = column(80);
  const next = structuredClone(p);
  next.blocks["box-79"].position = { x: 120, y: 96 };
  const fixed = resolveChangedOverlaps(p, next, fixedSize);
  expect(fixed.blocks["box-79"].position.y).toBe(96 + 79 * 196);
  for (let i = 0; i < 79; i++) expect(fixed.blocks[`box-${i}`].position).toEqual(p.blocks[`box-${i}`].position);
});

it("幅が増えた箱の右だけを押し、遠い旧重なりはそのまま残す", () => {
  const p = column(4);
  p.blocks["box-1"].position = { x: 316, y: 96 };
  p.blocks["box-2"].position = { x: 2000, y: 2000 };
  p.blocks["box-3"].position = { x: 2000, y: 2000 };
  const size = (q: Project, id: string) => ({ width: q.blocks[id].title === "grown" ? 200 : 100, height: 1000 });
  const fixed = resolveChangedOverlaps(p, updateBlock(p, "box-0", { title: "grown" }), size);
  expect(fixed.blocks["box-0"].position).toEqual(p.blocks["box-0"].position);
  expect(fixed.blocks["box-1"].position).toEqual({ x: 416, y: 96 });
  expect(fixed.blocks["box-2"].position).toEqual(p.blocks["box-2"].position);
  expect(fixed.blocks["box-3"].position).toEqual(p.blocks["box-3"].position);
});
