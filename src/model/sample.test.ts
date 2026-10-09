/**
 * サンプルプロジェクトが組み立てられ、結線がすべて成功していることの確認
 */
import { describe, expect, it } from "vitest";
import { buildSampleProject } from "./sample";
import { ROOT_ID } from "./types";
import { ancestorsOf, portsOf } from "./graph";
import { branchState } from "./branch";
import { buildEdges, buildNodes } from "../canvas/layout";

describe("サンプルプロジェクト", () => {
  it("例外なく組み立てられ、ノードと線に変換できる", () => {
    const p = buildSampleProject();
    expect(Object.keys(p.blocks).length).toBeGreaterThan(5);
    // 自動で引き上げられた入力 (テストデータ) が最上位の入力に現れる
    const rootIns = portsOf(p, ROOT_ID, "in");
    expect(rootIns.some((q) => q.name === "テストデータ" && q.promotedFrom)).toBe(true);
    // 入力グループは中身があること (空のグループだけが浮いていると、壊れた表示に見える)
    for (const g of p.inputGroups ?? []) {
      expect(rootIns.some((q) => q.groupId === g.id)).toBe(true);
    }
    const nodes = buildNodes(p, { selectedBlockId: null, readonly: false });
    const edges = buildEdges(p, { selectedEdgeId: null });
    // (ボックス - root + Inputs と Outputs + 入力のグループの箱)
    expect(nodes.length).toBe(Object.keys(p.blocks).length - 1 + 2 + (p.inputGroups?.length ?? 0));
    expect(edges.length).toBe(Object.keys(p.edges).length);
    // 表示の形と効果が分かるよう、深い階層・答え済みの分岐 (見送りの道)・未回答の分岐 (分岐待ち)・合流を含む
    const depth = Math.max(...Object.keys(p.blocks).map((id) => ancestorsOf(p, id).length));
    expect(depth).toBeGreaterThanOrEqual(4);
    const branches = branchState(p);
    expect(branches.skipped.size).toBeGreaterThan(0);
    expect(branches.pending.size).toBeGreaterThan(0);
    expect(Object.values(p.ports).some((q) => q.anyOf)).toBe(true);
    // 線の両端のノードが存在する
    const ids = new Set(nodes.map((n) => n.id));
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});
