/**
 * 丸の位置の計算 (handleGeometry.ts) の確認
 *   画面の丸と一致することは、画面で全部の丸を測って突き合わせる検査で確かめる。ここでは計算の決まりを確かめる
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, createProject, portsOf, projectBlocks, updateBlock } from "../model/graph";
import { blockSize, taskCardLayout } from "../model/size";
import { blockBorderW, blockHandles, boundsOfRects, domSize, HANDLE_OUTSET, HANDLE_SIZE, modelGeometry, modelRects, nodeHandles, parseGeometry, TERMINAL_BORDER, terminalHandles } from "./handleGeometry";
import { handleId, rowY } from "./layout";

/** 計画: プロジェクトの中に、入力 2 つ・出力 1 つの箱と、中に箱を持つ箱 */
function fixture() {
  let p = createProject("t");
  const pj = projectBlocks(p)[0].id;
  const a = addBlock(p, { parentId: pj, title: "画面を作る", position: { x: 40, y: 40 } }); p = a.project;
  for (const name of ["仕様", "とても長い名前の素材の入力"]) p = addPort(p, { blockId: a.blockId, direction: "in", name }).project;
  const parent = addBlock(p, { parentId: pj, title: "親", position: { x: 600, y: 40 } }); p = parent.project;
  p = addBlock(p, { parentId: parent.blockId, title: "子", position: { x: 40, y: 120 } }).project;
  p = updateBlock(p, parent.blockId, { collapsed: false }); // 中の箱を描く (展開した箱)
  return { p, pj, a: a.blockId, parent: parent.blockId };
}
/** 丸の中心 */
const center = (h: { x: number; y: number; width?: number; height?: number }) => [h.x + (h.width ?? 0) / 2, h.y + (h.height ?? 0) / 2];

describe("丸の位置の計算", () => {
  it("大きさの丸めはブラウザと同じ (1/64px にそろえてから整数に)", () => {
    expect(domSize(278.49999999999994)).toBe(279);
    expect(domSize(278.4)).toBe(278);
    expect(domSize(278.6)).toBe(279);
    expect(domSize(300)).toBe(300);
  });

  it("畳んだ箱: 入力は左の外 (枠線 - 7)、出力は右の外 (幅 - 枠線 + 7)、高さはカードの行の中央", () => {
    const { p, a } = fixture();
    const size = blockSize(p, a);
    const width = domSize(size.width), height = domSize(size.height);
    const hs = blockHandles(p, a, { width, height, headerH: size.headerH, viewScope: null });
    const card = taskCardLayout(p, a);
    const bw = blockBorderW(p, a);
    expect(bw).toBe(1);
    const ins = portsOf(p, a, "in"), outs = portsOf(p, a, "out");
    expect(hs).toHaveLength(ins.length + outs.length); // 畳んだ箱に内側の丸は無い
    for (const h of hs) expect([h.width, h.height]).toEqual([HANDLE_SIZE, HANDLE_SIZE]);
    card.inputs.forEach((row) => {
      const h = hs.find((x) => x.id === handleId("in", row.id, "outer"))!;
      expect(h.type).toBe("target");
      expect(center(h)).toEqual([bw - HANDLE_OUTSET, row.center]);
    });
    card.outputs.forEach((row) => {
      const h = hs.find((x) => x.id === handleId("out", row.id, "outer"))!;
      expect(h.type).toBe("source");
      expect(center(h)).toEqual([width - bw + HANDLE_OUTSET, row.center]);
    });
  });

  it("展開した箱は内側の丸も、外側の丸と同じ位置に置く (向きは逆)", () => {
    const { p, parent } = fixture();
    expect(blockBorderW(p, parent)).toBeGreaterThan(1); // 展開した箱は枠線が太い
    const size = blockSize(p, parent);
    const hs = blockHandles(p, parent, { width: domSize(size.width), height: domSize(size.height), headerH: size.headerH, viewScope: null });
    for (const q of portsOf(p, parent)) {
      const outer = hs.find((x) => x.id === handleId(q.direction, q.id, "outer"))!;
      const inner = hs.find((x) => x.id === handleId(q.direction, q.id, "inner"))!;
      expect(center(inner)).toEqual(center(outer));
      expect(inner.type).not.toBe(outer.type);
    }
  });

  it("入出力ノード: 入力ノードの丸は右 (幅 - 枠線 + 7)、出力ノードの丸は左 (枠線 - 7)。高さは行の中央", () => {
    const { p } = fixture();
    const outs = terminalHandles(p, { which: "out" }, { width: 200, height: 200 });
    expect(outs.length).toBe(portsOf(p, "root", "out").length);
    outs.forEach((h, i) => { expect(h.type).toBe("target"); expect(center(h)).toEqual([TERMINAL_BORDER - HANDLE_OUTSET, TERMINAL_BORDER + rowY(i)]); });
    const p2 = addPort(p, { blockId: "root", direction: "in", name: "素材" }).project;
    const ins = terminalHandles(p2, { which: "in" }, { width: 200, height: 120 });
    expect(ins.length).toBeGreaterThan(0);
    ins.forEach((h, i) => { expect(h.type).toBe("source"); expect(center(h)).toEqual([200 - TERMINAL_BORDER + HANDLE_OUTSET, TERMINAL_BORDER + rowY(i)]); });
  });

  it("ノードの丸 (nodeHandles) は、箱は blockHandles、入出力ノードは terminalHandles、ほかは丸なし", () => {
    const { p, a } = fixture();
    const size = blockSize(p, a);
    expect(nodeHandles(p, { type: "block", width: size.width, height: size.height, data: { blockId: a, headerH: size.headerH } }, null))
      .toEqual(blockHandles(p, a, { width: domSize(size.width), height: domSize(size.height), headerH: size.headerH, viewScope: null }));
    expect(nodeHandles(p, { type: "terminal", width: 200, height: 100, data: { which: "out" } }, null)).toEqual(terminalHandles(p, { which: "out" }, { width: 200, height: 100 }));
    expect(nodeHandles(p, { type: "other", data: {} }, null)).toEqual([]);
  });

  it("位置の文字列: 子の位置は親の位置を足した絶対位置。大きさは部品が描く整数。丸は中心を丸める。読み戻せる", () => {
    const nodes = [
      { id: "P", position: { x: 10.4, y: 20 }, width: 400.6, height: 300, handles: [{ id: "h", type: "source" as const, position: "right" as never, x: 394, y: 44, width: 12, height: 12 }] }
    , { id: "C", parentId: "P", position: { x: 30, y: 40.6 }, width: 100, height: 50 }
    , { id: "H", position: { x: 0, y: 0 }, width: 10, height: 10, hidden: true }
    ];
    const sig = modelGeometry(nodes);
    const g = parseGeometry(sig);
    expect(g.nodeRects).toEqual([
      { id: "P", parentId: "", rect: { x: 10, y: 20, width: 401, height: 300 } }
    , { id: "C", parentId: "P", rect: { x: 40, y: 61, width: 100, height: 50 } }
    ]);
    expect(g.handles.get("P|h")).toEqual({ x: Math.round(10.4 + 400), y: 70 });
    // 表示範囲用の矩形: 位置は小数のまま、大きさは整数。隠れたノードは含めない
    expect(modelRects(nodes).map((r) => r.id)).toEqual(["P", "C"]);
    expect(modelRects(nodes, ["C"])).toEqual([{ id: "C", x: 40.4, y: 60.6, width: 100, height: 50 }]);
    expect(boundsOfRects(modelRects(nodes))).toEqual({ x: 10.4, y: 20, width: 401, height: 300 });
    expect(boundsOfRects([])).toBeNull();
  });
});
