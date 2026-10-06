/**
 * 退避した編集の取り込みの試験 (レビュー 39〜42 の回帰)
 * 取り込みは段ごと (画面の退避 → エディタの退避) の 2 者の統合で、競合の選択は統合の仕組みにそのまま渡す
 */
import { describe, expect, it } from "vitest";
import { addBlock, addMember, addPort, createProject, defaultTaskParent, fromJSON, removeBlock, toJSON, updateBlock } from "../model/graph";
import type { Project } from "../model/types";
import { applyRestore, editorCaughtUp, prepareRestore, readRecovery, type Recovery, type RestoreStep } from "./recovery";

/** 基準 L・受け取った最新 R (説明を変えた)・画面の編集 G (題名を変えた)・エディタ側の編集 E (別のボックスの題名を変えた) */
function fixture() {
  let p = createProject("退避の試験");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
  const L = toJSON(p);
  const R = toJSON(updateBlock(fromJSON(L), a.blockId, { description: "受け取った説明" }));
  const G = toJSON(updateBlock(fromJSON(L), a.blockId, { title: "画面の題名" }));
  const E = toJSON(updateBlock(fromJSON(L), b.blockId, { title: "エディタの題名" }));
  return { L, R, G, E, a: a.blockId, b: b.blockId };
}
const rec = (base: string, gui: string, editor: string | null = null) => readRecovery({ boxglowRecovery: 1, base, received: null, gui: { text: gui }, editor: editor ? { text: editor, version: 7 } : null })!;
/** 段を 1 つ進める (競合は picks で選ぶ。指定の無い競合は current) */
function step(r: Recovery, current: Project, s: RestoreStep, choose: (c: { path: string; current: unknown; saved: unknown }) => "current" | "saved" = () => "current") {
  const prepared = prepareRestore(r, current, s);
  if ("error" in prepared) throw new Error(prepared.error);
  const result = applyRestore(r, current, s, Object.fromEntries(prepared.conflicts.map((c) => [c.id, choose(c)])));
  if ("error" in result) throw new Error(result.error);
  return { project: result.project, conflicts: prepared.conflicts };
}

describe("退避した編集の取り込み", () => {
  it("R39-06: 開き直した最新 R に、退避した画面の編集 G を取り込む。受け取った側の変更 (説明) も残る", () => {
    const { L, R, G, a } = fixture();
    expect(prepareRestore(rec(L, G), fromJSON(R), "gui")).toEqual({ conflicts: [] });
    const { project } = step(rec(L, G), fromJSON(R), "gui");
    expect(project.blocks[a].title).toBe("画面の題名");
    expect(project.blocks[a].description).toBe("受け取った説明");
  });

  it("R39-05: エディタ側の独立した編集 E も、次の段で取り込む (G・E・基準・R がすべて違う場合)", () => {
    const { L, R, G, E, a, b } = fixture();
    const first = step(rec(L, G, E), fromJSON(R), "gui").project;
    const { project } = step(rec(L, G, E), first, "editor");
    expect(project.blocks[a].title).toBe("画面の題名");
    expect(project.blocks[a].description).toBe("受け取った説明");
    expect(project.blocks[b].title).toBe("エディタの題名");
  });

  it("R40-03 / R41-02: 同じ項目の競合は、各段の 2 つの実際の値から選び、選んだ値になる (今が基準のままでも)", () => {
    const { L, a } = fixture();
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "GUI" }));
    const E = toJSON(updateBlock(fromJSON(L), a, { title: "EDITOR" }));
    // 今が基準のまま: 画面の段は競合しない (画面の値を取り込む)。エディタの段で「今の値 = GUI」と「EDITOR」から選ぶ
    expect(prepareRestore(rec(L, G, E), fromJSON(L), "gui")).toEqual({ conflicts: [] });
    const first = step(rec(L, G, E), fromJSON(L), "gui").project;
    const prepared = prepareRestore(rec(L, G, E), first, "editor");
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.conflicts).toEqual([expect.objectContaining({ current: "GUI", saved: "EDITOR" })]);
    expect(applyRestore(rec(L, G, E), first, "editor", {})).toEqual({ error: "unresolved" });
    expect(step(rec(L, G, E), first, "editor", () => "current").project.blocks[a].title).toBe("GUI");
    expect(step(rec(L, G, E), first, "editor", () => "saved").project.blocks[a].title).toBe("EDITOR");
    // 今も違う値なら、画面の段で「今の値」と「画面の値」から選べる (今の値を残せる)
    const now = updateBlock(fromJSON(L), a, { title: "CURRENT" });
    const kept = step(rec(L, G), now, "gui", () => "current");
    expect(kept.conflicts).toEqual([expect.objectContaining({ current: "CURRENT", saved: "GUI" })]);
    expect(kept.project.blocks[a].title).toBe("CURRENT");
  });

  it("R42-02: ID 付きの配列 (メンバー) の競合も、実際の値を示し、選んだ値になる", () => {
    let p = createProject("メンバーの試験");
    const m = addMember(p, "BASE MEMBER", "#123456"); p = m.project;
    const L = toJSON(p);
    const withName = (name: string) => { const q = fromJSON(L); q.members.find((x) => x.id === m.memberId)!.name = name; return q; };
    const G = toJSON(withName("GUI MEMBER"));
    const now = withName("CURRENT MEMBER");
    const kept = step(rec(L, G), now, "gui", () => "current");
    expect(kept.conflicts.length).toBe(1);
    expect(kept.conflicts[0]).toMatchObject({ current: "CURRENT MEMBER", saved: "GUI MEMBER" });
    expect(kept.project.members.find((x) => x.id === m.memberId)!.name).toBe("CURRENT MEMBER");
    expect(step(rec(L, G), now, "gui", () => "saved").project.members.find((x) => x.id === m.memberId)!.name).toBe("GUI MEMBER");
  });

  it("R42-03: 削除と変更の競合は、ボックス全体の 1 つの選択になり、子の項目の選択と重ならない", () => {
    const { L, a } = fixture();
    const G = toJSON(removeBlock(fromJSON(L), a));                       // 画面: A を消した
    const now = updateBlock(fromJSON(L), a, { title: "CURRENT" });        // 今: A の題名を変えた
    const prepared = prepareRestore(rec(L, G), now, "gui");
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.conflicts.map((c) => c.path).filter((path) => path.includes(a))).toHaveLength(1);
    expect(step(rec(L, G), now, "gui", () => "current").project.blocks[a].title).toBe("CURRENT");
    expect(step(rec(L, G), now, "gui", () => "saved").project.blocks[a]).toBeUndefined();
  });

  it("R42-04: 説明を選び直すと、その版の更新日時も付く", () => {
    const { L, a } = fixture();
    const g = updateBlock(fromJSON(L), a, { description: "GUI" }); g.blocks[a].descriptionUpdatedAt = "2026-10-03T00:00:00.000Z";
    const now = updateBlock(fromJSON(L), a, { description: "CURRENT" }); now.blocks[a].descriptionUpdatedAt = "2026-10-02T00:00:00.000Z";
    const kept = step(rec(L, toJSON(g)), now, "gui", () => "current").project.blocks[a];
    expect([kept.description, kept.descriptionUpdatedAt]).toEqual(["CURRENT", "2026-10-02T00:00:00.000Z"]);
    const taken = step(rec(L, toJSON(g)), now, "gui", () => "saved").project.blocks[a];
    expect([taken.description, taken.descriptionUpdatedAt]).toEqual(["GUI", "2026-10-03T00:00:00.000Z"]);
  });

  it("R42-05: 入出力を持つボックスの削除を選ぶと、入出力も一緒に消えて取り込める。残すを選ぶと、入出力も残る", () => {
    let p = createProject("入出力の試験");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    const port = addPort(p, { blockId: a.blockId, direction: "out", name: "出力 X" }); p = port.project;
    const L = toJSON(p);
    const G = toJSON(removeBlock(fromJSON(L), a.blockId));
    const now = updateBlock(fromJSON(L), a.blockId, { title: "CURRENT" });
    const removed = step(rec(L, G), now, "gui", () => "saved").project;
    expect(removed.blocks[a.blockId]).toBeUndefined();
    expect(removed.ports[port.portId]).toBeUndefined();
    const kept = step(rec(L, G), now, "gui", () => "current").project;
    expect(kept.blocks[a.blockId].title).toBe("CURRENT");
    expect(kept.ports[port.portId]).toBeDefined();
  });

  it("R40-04: 個別には正しい親の変更どうしで循環ができる組み合わせは、取り込まない", () => {
    const { L, a, b } = fixture();
    const g = fromJSON(L); g.blocks[a].parentId = b;
    const r = fromJSON(L); r.blocks[b].parentId = a;
    const result = applyRestore(rec(L, toJSON(g)), r, "gui", {});
    expect("error" in result && result.error.startsWith("invalid:")).toBe(true);
  });

  it("R40-06: 別の計画の退避は取り込まない。同じ計画なら、場所 (パス) に関係なく取り込める", () => {
    const { L, R, G } = fixture();
    const other = toJSON(createProject("別の計画"));
    expect(prepareRestore(rec(L, other), fromJSON(R), "gui")).toEqual({ error: "different-plan" });
    expect(prepareRestore(rec(L, G, other), fromJSON(R), "gui")).toEqual({ error: "different-plan" });
    expect("conflicts" in prepareRestore(rec(L, G), fromJSON(R), "gui")).toBe(true);
    expect(prepareRestore(rec(L, G), fromJSON(R), "editor")).toEqual({ error: "no-step" });
    expect(readRecovery({ gui: { text: G } })).toBeNull();
  });

  it("R39-07: エディタ待ちは、届いた中身が受け取った最新と同じときだけ解ける", () => {
    const { L, R } = fixture();
    expect(editorCaughtUp(R, L)).toBe(false);
    expect(editorCaughtUp(R, R)).toBe(true);
    expect(editorCaughtUp(null, R)).toBe(false);
  });
});
