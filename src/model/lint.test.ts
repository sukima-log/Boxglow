/**
 * 計画の検査 (lint): 必ず直す (error) と見直し候補 (review) を分けて出すことの確認
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, connect, connectToBlock, createProject, defaultTaskParent, portsOf, updateBlock, updatePort } from "./graph";
import { addBranch, addMerge } from "./branch";
import { lint, lintCounts } from "./lint";
import { setLang } from "../i18n/core";
import type { Project } from "./types";

function base(): { p: Project; parentId: string } {
  setLang("ja");
  const p = createProject("検査");
  return { p, parentId: defaultTaskParent(p) };
}
const kinds = (p: Project, rootId?: string) => lint(p, rootId).map((x) => `${x.severity}:${x.kind}`);
const prepared = (p: Project, id: string): Project => {
  let q = p;
  for (const o of portsOf(q, id, "out")) q = updatePort(q, o.id, { expect: { kind: "file", hint: "src/x.ts" } });
  return updateBlock(q, id, { scope: { acceptance: "テストが通ること" } });
};

describe("lint", () => {
  it("予定成果物・完了条件の欠落は error、出力の未接続は review", () => {
    const { p, parentId } = base();
    const r = addBlock(p, { parentId, title: "実装", outputName: "コード" });
    const ks = kinds(r.project, r.blockId);
    expect(ks).toContain("error:missing-expect");
    expect(ks).toContain("error:missing-acceptance");
    expect(ks).toContain("review:dangling-output");
    expect(kinds(prepared(r.project, r.blockId), r.blockId).filter((k) => k.startsWith("error"))).toEqual([]);
  });
  it("形だけの記入は review (拒否しない)", () => {
    const { p, parentId } = base();
    const r = addBlock(p, { parentId, title: "実装", outputName: "コード" });
    let q = updatePort(r.project, portsOf(r.project, r.blockId, "out")[0].id, { expect: { kind: "dir", hint: "src/" } });
    q = updateBlock(q, r.blockId, { scope: { acceptance: "動く" } });
    const ks = kinds(q, r.blockId);
    expect(ks.filter((k) => k.startsWith("error"))).toEqual([]);
    expect(ks).toContain("review:broad-expect");
    expect(ks).toContain("review:thin-acceptance");
  });
  it("子が 1 個の親、親出力の担当未定、兄弟の同じ予定成果物", () => {
    const { p, parentId } = base();
    const parent = addBlock(p, { parentId, title: "親", outputName: "アプリ" });
    const c1 = addBlock(parent.project, { parentId: parent.blockId, title: "子 1", outputName: "部品" });
    expect(kinds(c1.project, parent.blockId)).toContain("review:single-child");
    expect(kinds(c1.project, parent.blockId)).toContain("error:undecided-output");
    let q = c1.project;
    const c2 = addBlock(q, { parentId: parent.blockId, title: "子 2", outputName: "部品 2" });
    q = c2.project;
    q = updatePort(q, portsOf(q, c1.blockId, "out")[0].id, { expect: { kind: "file", hint: "src/a.ts" } });
    q = updatePort(q, portsOf(q, c2.blockId, "out")[0].id, { expect: { kind: "file", hint: "src/a.ts" } });
    const ks = kinds(q, parent.blockId);
    expect(ks).not.toContain("review:single-child");
    expect(ks).toContain("review:duplicate-expect");
    // 子の出力を親の出力につなぐと担当は子になり、未定は消える
    const c = connect(q, { portId: portsOf(q, c1.blockId, "out")[0].id, side: "outer" }, { portId: portsOf(q, parent.blockId, "out")[0].id, side: "inner" });
    expect(kinds(c.project, parent.blockId)).not.toContain("error:undecided-output");
  });
  it("完了済みと見送りのボックスは検査しない", () => {
    const { p, parentId } = base();
    const r = addBlock(p, { parentId, title: "済み", outputName: "コード" });
    const done = updateBlock(r.project, r.blockId, { status: "white" });
    expect(lint(done, r.blockId)).toEqual([]);
  });
  it("分岐: 道の先が無い (review)、合流の入力が 1 本 (review)、排他の道の両方を必須にしている (error)", () => {
    const { p, parentId } = base();
    const br = addBranch(p, { parentId, title: "方式", question: "どれ?", options: ["A", "B"], actor: "human" });
    let q = br.project;
    expect(kinds(q, br.blockId).filter((k) => k === "review:branch-empty-path")).toHaveLength(2);
    const a = addBlock(q, { parentId, title: "A で作る", outputName: "成果 A" }); q = a.project;
    const b = addBlock(q, { parentId, title: "B で作る", outputName: "成果 B" }); q = b.project;
    const outs = portsOf(q, br.blockId, "out");
    q = connectToBlock(q, { portId: outs.find((o) => o.branchOption === "A")!.id, side: "outer" }, a.blockId).project;
    q = connectToBlock(q, { portId: outs.find((o) => o.branchOption === "B")!.id, side: "outer" }, b.blockId).project;
    expect(kinds(q, br.blockId)).not.toContain("review:branch-empty-path");
    // 両方の成果を 1 つのボックスが必須の入力にする → error
    const both = addBlock(q, { parentId, title: "まとめる", outputName: "まとめ" }); q = both.project;
    q = connectToBlock(q, { portId: portsOf(q, a.blockId, "out")[0].id, side: "outer" }, both.blockId).project;
    q = connectToBlock(q, { portId: portsOf(q, b.blockId, "out")[0].id, side: "outer" }, both.blockId).project;
    expect(kinds(q, both.blockId)).toContain("error:branch-exclusive-and");
    // 合流を挟めば消える。合流の入力が 1 本の間は review
    const m = addMerge(q, { parentId, actor: "human" }); q = m.project;
    const mIn = addPort(q, { blockId: m.blockId, direction: "in", name: "成果" }); q = mIn.project;
    q = connect(q, { portId: portsOf(q, a.blockId, "out")[0].id, side: "outer" }, { portId: mIn.portId, side: "outer" }).project;
    expect(kinds(q, m.blockId)).toContain("review:merge-single-input");
    const mIn2 = addPort(q, { blockId: m.blockId, direction: "in", name: "成果 B" }); q = mIn2.project;
    q = connect(q, { portId: portsOf(q, b.blockId, "out")[0].id, side: "outer" }, { portId: mIn2.portId, side: "outer" }).project;
    expect(kinds(q, m.blockId)).not.toContain("review:merge-single-input");
    const after = addBlock(q, { parentId, title: "合流の先", outputName: "完成" }); q = after.project;
    q = connectToBlock(q, { portId: portsOf(q, m.blockId, "out")[0].id, side: "outer" }, after.blockId).project;
    expect(kinds(q, after.blockId)).not.toContain("error:branch-exclusive-and");
    // 件数の要約
    const c = lintCounts(lint(q));
    expect(c.errors).toBeGreaterThan(0);
    expect(c.reviews).toBeGreaterThan(0);
  });
});
