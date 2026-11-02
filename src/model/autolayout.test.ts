import { describe, expect, it } from "vitest";
import { layoutScope } from "./autolayout";
import { buildSampleProject } from "./sample";
import { childrenOf, defaultTaskParent } from "./graph";
import { ROOT_ID } from "./types";
import { blockSize } from "./size";

describe("Arrange this level", () => {
  it("separates overlapping siblings without changing nested or unrelated positions", () => {
    const p = buildSampleProject();
    const scope = defaultTaskParent(p);
    const kids = childrenOf(p, scope);
    for (const kid of kids) kid.position = { x: 120, y: 120 };
    const before = structuredClone(p);
    const q = layoutScope(p, scope, { recursive: false });
    expect(p).toEqual(before);
    for (const block of Object.values(p.blocks)) {
      if (block.parentId !== scope) expect(q.blocks[block.id].position).toEqual(block.position);
      expect(q.blocks[block.id].collapsed).toBe(block.collapsed);
    }
    expect(q.edges).toEqual(p.edges);
    expect(q.ports).toEqual(p.ports);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = q.blocks[kids[i].id], b = q.blocks[kids[j].id];
      const sa = blockSize(q, a.id), sb = blockSize(q, b.id);
      expect(a.position.x + sa.width <= b.position.x || b.position.x + sb.width <= a.position.x || a.position.y + sa.height <= b.position.y || b.position.y + sb.height <= a.position.y).toBe(true);
    }
  });

  it("計画全体を並べても元の計画は変わらない (入出力ノード・入力グループ・中の階層の位置も。ポートと線は元と共有する)", () => {
    const p = buildSampleProject();
    p.inputGroups = [...(p.inputGroups ?? []), { id: "g-test", name: "素材", description: "", position: { x: 5, y: 5 } }];
    for (const b of Object.values(p.blocks)) b.position = { x: 120, y: 120 };
    const before = structuredClone(p);
    const q = layoutScope(p, ROOT_ID);
    expect(p).toEqual(before);
    expect(q.ports).toBe(p.ports);
    expect(q.edges).toBe(p.edges);
    expect(q.inputGroups?.find((g) => g.id === "g-test")?.position).not.toEqual({ x: 5, y: 5 });
    expect(Object.values(q.blocks).some((b) => b.position.x !== 120 || b.position.y !== 120)).toBe(true);
  });
});
