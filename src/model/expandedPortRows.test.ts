import { describe, expect, it } from "vitest";
import { addBlock, connectToBlock, createProject, portsOf, projectBlocks } from "./graph";
import { blockSize, expandedPortRows, ROW_H, taskCardLayout } from "./size";
import type { Project } from "./types";

/** 箱の位置を直接書き換える (テスト用。親の座標系) */
function at(p: Project, id: string, x: number, y: number): Project {
  const q = structuredClone(p);
  q.blocks[id].position = { x, y };
  return q;
}

describe("展開中のボックスの丸の高さ (expandedPortRows)", () => {
  /** 親「デザイン」の中に 3 つの箱 (上・中・下)。中と下の出力を外の箱「統合」へつなぐ */
  const build = () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const parent = addBlock(p, { parentId: pj, title: "デザイン" }); p = parent.project;
    const a = addBlock(p, { parentId: parent.blockId, title: "上", outputName: "顔" }); p = a.project;
    const b = addBlock(p, { parentId: parent.blockId, title: "中", outputName: "体形" }); p = b.project;
    const c = addBlock(p, { parentId: parent.blockId, title: "下", outputName: "髪型" }); p = c.project;
    p = at(p, a.blockId, 40, 100); p = at(p, b.blockId, 40, 400); p = at(p, c.blockId, 40, 700);
    const fin = addBlock(p, { parentId: pj, title: "統合" }); p = fin.project;
    // 下 → 統合、中 → 統合 の順につなぐ (ポートの並びは下・中の順になる)
    for (const id of [c.blockId, b.blockId]) p = connectToBlock(p, { portId: portsOf(p, id, "out")[0].id, side: "outer" }, fin.blockId).project;
    p = structuredClone(p); p.blocks[parent.blockId].collapsed = false; // 展開して描く
    return { p, parent: parent.blockId, a: a.blockId, b: b.blockId, c: c.blockId };
  };
  it("出力の丸は、線を出している中の箱の出力と同じ高さに並ぶ (見出しの下に詰めない)", () => {
    const { p, parent, b, c } = build();
    const rows = expandedPortRows(p, parent);
    const yOf = (child: string) => p.blocks[child].position.y + taskCardLayout(p, child).outputs[0].center;
    for (const child of [b, c]) {
      const relay = portsOf(p, parent, "out").find((x) => x.name === portsOf(p, child, "out")[0].name)!;
      expect(rows.get(relay.id)).toBe(yOf(child));
    }
  });
  it("高さの近い丸は 1 行以上離し、見出しの下から枠の下までに収める", () => {
    let { p, parent, b, c } = build();
    p = at(p, c, 300, 400); // 中と下を同じ高さに
    void b;
    const rows = [...expandedPortRows(p, parent).values()].sort((x, y) => x - y);
    const size = blockSize(p, parent);
    for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1]).toBeGreaterThanOrEqual(ROW_H);
    expect(rows[0]).toBeGreaterThanOrEqual(size.headerH + ROW_H / 2);
    expect(rows.at(-1)!).toBeLessThanOrEqual(size.height - ROW_H / 2);
  });
  it("展開していない箱は空", () => {
    const { p, a } = build();
    expect(expandedPortRows(p, a).size).toBe(0);
  });
});
