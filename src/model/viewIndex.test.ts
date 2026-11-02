/**
 * 画面用の索引 (withViewIndex) の確認
 *   索引ありでも、索引なしで全件を走査したときと同じ結果 (同じ並び) を返すこと。
 *   索引を使っている間に編集の処理 (複製を書き換える) が走っても、編集後の計画は索引を使わずに正しく引けること
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, childrenOf, connect, createProject, disconnect, incomingEdges, outgoingEdges, portsOf, projectBlocks, removePort, withViewIndex } from "./graph";
import type { Project } from "./types";

/** 計画: 大項目の中に 3 つの箱を並べ、線で 1 列につなぐ */
function fixture() {
  let p = createProject("t");
  const pj = projectBlocks(p)[0].id;
  const ids: string[] = [];
  for (const title of ["甲", "乙", "丙"]) { const r = addBlock(p, { parentId: pj, title, outputName: `${title}の成果` }); p = r.project; ids.push(r.blockId); }
  for (let i = 1; i < ids.length; i++) {
    const inPort = addPort(p, { blockId: ids[i], direction: "in", name: "材料" }); p = inPort.project;
    p = connect(p, { portId: portsOf(p, ids[i - 1], "out")[0].id, side: "outer" }, { portId: inPort.portId, side: "outer" }).project;
  }
  return { p, pj, ids };
}

/** 計画の参照の結果を全部集める (ポート・子・入ってくる線・出ていく線) */
function lookups(p: Project) {
  return {
    ports: Object.keys(p.blocks).map((id) => [portsOf(p, id).map((q) => q.id), portsOf(p, id, "in").map((q) => q.id), portsOf(p, id, "out").map((q) => q.id), childrenOf(p, id).map((b) => b.id)])
  , edges: Object.keys(p.ports).flatMap((id) => (["outer", "inner"] as const).map((side) => [incomingEdges(p, { portId: id, side }).map((e) => e.id), outgoingEdges(p, { portId: id, side }).map((e) => e.id)]))
  };
}

describe("画面用の索引", () => {
  it("索引ありでも、索引なしと同じ結果を同じ並びで返す", () => {
    const { p } = fixture();
    expect(withViewIndex(p, () => lookups(p))).toEqual(lookups(p));
  });

  it("返した一覧を呼び出し側で書き換えても、索引は壊れない", () => {
    const { p, ids } = fixture();
    withViewIndex(p, () => {
      portsOf(p, ids[1]).length = 0;
      incomingEdges(p, { portId: portsOf(p, ids[1], "in")[0].id, side: "outer" }).length = 0;
    });
    expect(withViewIndex(p, () => lookups(p))).toEqual(lookups(p));
  });

  it("索引を使っている間に編集の処理が走っても、編集後の計画は正しく引ける (別のオブジェクトなので索引を使わない)", () => {
    const { p, ids } = fixture();
    const edge = incomingEdges(p, { portId: portsOf(p, ids[1], "in")[0].id, side: "outer" })[0];
    withViewIndex(p, () => {
      const cut = disconnect(p, edge.id);
      expect(Object.keys(cut.edges)).not.toContain(edge.id);
      expect(lookups(cut)).toEqual(withViewIndex(cut, () => lookups(cut)));
      const removed = removePort(p, portsOf(p, ids[2], "in")[0].id);
      expect(portsOf(removed, ids[2], "in")).toHaveLength(0);
      // 元の計画は変わらず、索引からも同じに引ける
      expect(incomingEdges(p, edge.to).map((e) => e.id)).toEqual([edge.id]);
    });
  });

  it("入れ子にしても、抜けた後は外側の索引 (または索引なし) に戻る", () => {
    const a = fixture().p, b = fixture().p;
    const inner = withViewIndex(a, () => { withViewIndex(b, () => lookups(b)); return lookups(a); });
    expect(inner).toEqual(lookups(a));
  });
});
