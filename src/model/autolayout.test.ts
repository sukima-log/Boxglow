import { describe, expect, it } from "vitest";
import { layoutScope } from "./autolayout";
import { buildSampleProject } from "./sample";
import { childrenOf, defaultTaskParent } from "./graph";
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
});
