/**
 * キャンバスのタブ (表示範囲 scope) でのノード・線の絞り込みの確認
 * - 範囲のボックスの中だけが出る。最上位の入力・出力ノードは出ず、代わりに範囲のボックスの入力/出力ノード (scope-in / scope-out) が出る
 * - 範囲のボックスは「上の階層のボックス」として絶対座標に置かれ、動かせない。中のボックスはそのボックスを親にする。入力/出力ノードはボックスの外 (最上位)
 * - 範囲の外とつながる線は hidden になり、入力/出力ノードとボックスの外側の面とをつなぐ線が合成される
 */
import { describe, expect, it } from "vitest";
import { buildSampleProject } from "../model/sample";
import { childrenOf, defaultTaskParent, portsOf } from "../model/graph";
import { buildEdges, buildNodes, SCOPE_IN, SCOPE_OUT } from "./layout";

describe("表示範囲 (大項目のタブ)", () => {
  const p = buildSampleProject();
  const parent = defaultTaskParent(p);
  const majors = childrenOf(p, parent);
  const scope = majors.find((b) => childrenOf(p, b.id).length > 0) ?? majors[0];

  it("中のボックスと範囲の入力/出力ノードだけが出て、最上位の入力・出力ノードは出ない", () => {
    const nodes = buildNodes(p, { selectedBlockId: null, readonly: false, scope: scope.id });
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.has("root-in")).toBe(false);
    expect(ids.has("root-out")).toBe(false);
    const tin = nodes.find((n) => n.id === SCOPE_IN)!;
    const tout = nodes.find((n) => n.id === SCOPE_OUT)!;
    expect(tin.type).toBe("terminal");
    expect(tout.type).toBe("terminal");
    expect(tin.parentId).toBeUndefined(); // ボックスの外 (最上位) に置く
    expect((tin.data as { scopeId?: string }).scopeId).toBe(scope.id);
    expect(ids.has(scope.id)).toBe(true);
    for (const kid of childrenOf(p, scope.id)) expect(ids.has(kid.id)).toBe(true);
    for (const other of majors) if (other.id !== scope.id) expect(ids.has(other.id)).toBe(false);
  });

  it("範囲のボックスは上の階層のボックスとして絶対座標に置かれ、動かせない", () => {
    const nodes = buildNodes(p, { selectedBlockId: null, readonly: false, scope: scope.id });
    const n = nodes.find((x) => x.id === scope.id)!;
    expect(n.type).toBe("block");
    expect(n.parentId).toBeUndefined();
    expect(n.draggable).toBe(false);
    // 絶対座標 = 自分の位置 + 祖先 (最上位を除く) の位置
    let x = scope.position.x;
    let y = scope.position.y;
    let cur = scope.parentId;
    while (cur && p.blocks[cur] && p.blocks[cur].parentId !== null) { x += p.blocks[cur].position.x; y += p.blocks[cur].position.y; cur = p.blocks[cur].parentId; }
    expect(n.position).toEqual({ x, y });
    // 中のボックスは親の座標系のまま
    const kid = childrenOf(p, scope.id)[0];
    if (kid) expect(nodes.find((x) => x.id === kid.id)!.parentId).toBe(scope.id);
  });

  it("範囲の外とつながる線は hidden、中だけの線は見える", () => {
    const nodes = buildNodes(p, { selectedBlockId: null, readonly: false, scope: scope.id });
    const ids = new Set(nodes.map((n) => n.id));
    const edges = buildEdges(p, { selectedEdgeId: null, scope: scope.id });
    for (const e of edges) {
      if (!ids.has(e.source) || !ids.has(e.target)) expect(e.hidden).toBe(true);
    }
    // 範囲のボックスの外側の面につながる本物の線 (兄弟・親との線) は hidden
    for (const e of edges) {
      const edge = p.edges[e.id];
      if (!edge) continue;
      const fromScope = p.ports[edge.from.portId].blockId === scope.id;
      const toScope = p.ports[edge.to.portId].blockId === scope.id;
      if ((fromScope && edge.from.side === "outer") || (toScope && edge.to.side === "outer")) expect(e.hidden).toBe(true);
    }
    // 合成した線: 入力ノード -> ボックスの外側の入力、ボックスの外側の出力 -> 出力ノード (ポートの数だけ)
    const synthIn = edges.filter((e) => e.source === SCOPE_IN);
    const synthOut = edges.filter((e) => e.target === SCOPE_OUT);
    expect(synthIn.length).toBe(portsOf(p, scope.id, "in").length);
    expect(synthOut.length).toBe(portsOf(p, scope.id, "out").length);
    for (const e of synthIn) { expect(e.target).toBe(scope.id); expect(e.targetHandle?.endsWith(":outer")).toBe(true); }
    for (const e of synthOut) { expect(e.source).toBe(scope.id); expect(e.sourceHandle?.endsWith(":outer")).toBe(true); }
    // Top (scope 無し) では入力・出力ノードが出る
    const all = buildNodes(p, { selectedBlockId: null, readonly: false, scope: null });
    expect(all.some((n) => n.type === "terminal")).toBe(true);
  });
});
