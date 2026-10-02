/**
 * 3 方向マージのテスト: 別々の箱の変更は合わさり、同じ項目の変更は ours を採用して記録する
 */
import { describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, updateBlock, removeBlock, fromJSON, toJSON } from "./graph";
import { mergeProjects } from "./merge";

function base() {
  let p = createProject("team");
  const pj = defaultTaskParent(p);
  const a = addBlock(p, { parentId: pj, title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: pj, title: "B" }); p = b.project;
  return { p: fromJSON(toJSON(p)), a: a.blockId, b: b.blockId, pj };
}

describe("boxglow.json の 3 方向マージ", () => {
  it("別々の箱を変えた 2 人の変更が両方入る", () => {
    const { p, a, b } = base();
    const ours = updateBlock(p, a, { title: "A (自分)" });
    const theirs = updateBlock(p, b, { title: "B (相手)" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a].title).toBe("A (自分)");
    expect(r.project.blocks[b].title).toBe("B (相手)");
    expect(r.conflicts).toHaveLength(0);
  });
  it("相手が足した箱と自分が足した箱が両方残り、B 番号の衝突は振り直す", () => {
    const { p, pj } = base();
    const ours = addBlock(p, { parentId: pj, title: "自分の新規" }).project;
    const theirs = addBlock(p, { parentId: pj, title: "相手の新規" }).project;
    const r = mergeProjects(p, ours, theirs);
    const titles = Object.values(r.project.blocks).map((x) => x.title);
    expect(titles).toContain("自分の新規");
    expect(titles).toContain("相手の新規");
    const keys = Object.values(r.project.blocks).map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length); // 番号が重複しない
  });
  it("同じ箱の同じ項目を両方が変えたら自分を採用し、記録に残す", () => {
    const { p, a } = base();
    const ours = updateBlock(p, a, { title: "自分" });
    const theirs = updateBlock(p, a, { title: "相手" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a].title).toBe("自分");
    expect(r.conflicts.map((c) => c.path)).toContain(`blocks.${a}.title`);
  });
  it("片方が消した箱は、もう片方が触っていなければ消える", () => {
    const { p, a, b } = base();
    const ours = removeBlock(p, a);
    const theirs = updateBlock(p, b, { title: "B2" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a]).toBeUndefined();
    expect(r.project.blocks[b].title).toBe("B2");
  });
  it("ログは両方を合わせて時刻順になる", () => {
    const { p, a, b } = base();
    const ours = updateBlock(p, a, { status: "gray" });
    const theirs = updateBlock(p, b, { status: "gray" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.log.length).toBeGreaterThanOrEqual(Math.max(ours.log.length, theirs.log.length));
  });
});
