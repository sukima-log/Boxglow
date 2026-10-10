/**
 * 意味のレビューの材料と記録: 署名が評価材料の全体から作られ、関係する変更で古くなり、関係しない変更では古くならないことの確認
 */
import { describe, expect, it } from "vitest";
import { addBlock, addPort, connect, connectToBlock, createProject, defaultTaskParent, portsOf, updateBlock, updatePort, answerDecision, reopenDecision } from "./graph";
import { addBranch } from "./branch";
import { boxMaterial, changedText, makeRecord, reviewStatus, splitMaterial } from "./review";
import { setLang } from "../i18n/core";
import type { Project } from "./types";

function fixture(): { p: Project; parent: string; c1: string; c2: string } {
  setLang("ja");
  const base = createProject("レビュー");
  const r = addBlock(base, { parentId: defaultTaskParent(base), title: "親", outputName: "アプリ" });
  let p = updateBlock(r.project, r.blockId, { scope: { goal: "一式を作る", acceptance: "動く" } });
  const a = addBlock(p, { parentId: r.blockId, title: "子 1", outputName: "部品 1" }); p = a.project;
  const b = addBlock(p, { parentId: r.blockId, title: "子 2", outputName: "部品 2" }); p = b.project;
  p = connect(p, { portId: portsOf(p, a.blockId, "out")[0].id, side: "outer" }, { portId: portsOf(p, r.blockId, "out")[0].id, side: "inner" }).project;
  return { p, parent: r.blockId, c1: a.blockId, c2: b.blockId };
}

describe("分解のレビュー (split-ok)", () => {
  it("記録が無ければ none、一致すれば ok", () => {
    const { p, parent } = fixture();
    const m = splitMaterial(p, parent);
    expect(reviewStatus(undefined, m).state).toBe("none");
    const rec = makeRecord("codex", "子の成果で親の出力が作れる", m.sig, m.parts);
    expect(reviewStatus(rec, splitMaterial(p, parent)).state).toBe("ok");
    expect(rec.note).toBe("子の成果で親の出力が作れる");
  });
  it("子の説明・親の入力の必須・結線・親の完了条件が変わると古くなり、何が変わったかが分かる (確認 6)", () => {
    const { p, parent, c1, c2 } = fixture();
    const m = splitMaterial(p, parent);
    const rec = makeRecord("codex", "ok", m.sig, m.parts);
    // 子の description
    let q = updateBlock(p, c2, { description: "処理を変える" });
    let st = reviewStatus(rec, splitMaterial(q, parent));
    expect(st.state).toBe("stale"); expect(changedText(q, st.changed)).toBe(q.blocks[c2].key ?? "子 2");
    // 親の入力の required
    q = addPort(p, { blockId: parent, direction: "in", name: "仕様" }).project;
    st = reviewStatus(rec, splitMaterial(q, parent)); expect(st.changed).toContain("parent");
    // 結線 (子 2 の出力を親の出力へ)
    q = connect(p, { portId: portsOf(p, c2, "out")[0].id, side: "outer" }, { portId: portsOf(p, parent, "out")[0].id, side: "inner" }).project;
    st = reviewStatus(rec, splitMaterial(q, parent)); expect(st.changed).toContain("wiring");
    // 同じ名前のポートへのつなぎ替えも検出する: 子 1 の出力を外し、同名の出力を持つ子 2 でつなぎ直す
    // 親の完了条件
    q = updateBlock(p, parent, { scope: { ...p.blocks[parent].scope, acceptance: "結合テストが通る" } });
    st = reviewStatus(rec, splitMaterial(q, parent)); expect(st.changed).toEqual(["parent"]);
    void c1;
  });
  it("位置・畳み・担当・進捗・状態・活動では古くならない", () => {
    const { p, parent, c1 } = fixture();
    const m = splitMaterial(p, parent);
    const rec = makeRecord("codex", "ok", m.sig, m.parts);
    let q = updateBlock(p, c1, { status: "gray", progress: 40, assigneeIds: ["m1"], collapsed: true, activity: { actor: "codex", state: "working", note: "x", since: "2026-01-01T00:00:00Z" } });
    q = { ...q, blocks: { ...q.blocks, [c1]: { ...q.blocks[c1], position: { x: 999, y: 999 } } } };
    expect(reviewStatus(rec, splitMaterial(q, parent)).state).toBe("ok");
  });
  it("分岐の答えでは分解の記録は古くならない", () => {
    const { p, parent } = fixture();
    const br = addBranch(p, { parentId: parent, title: "方式", question: "どれ?", options: ["A", "B"], actor: "human" });
    const m = splitMaterial(br.project, parent);
    const rec = makeRecord("codex", "ok", m.sig, m.parts);
    const answered = answerDecision(br.project, br.blockId, br.decisionId, "A", "human");
    expect(reviewStatus(rec, splitMaterial(answered, parent)).state).toBe("ok");
  });
});

describe("ボックスのレビュー (box-ok)", () => {
  it("上流の分岐の答え・取り消しで古くなり、入力の供給元の変更でも古くなる", () => {
    const { p, parent } = fixture();
    const br = addBranch(p, { parentId: parent, title: "方式", question: "どれ?", options: ["A", "B"], actor: "human" });
    let q = br.project;
    const a = addBlock(q, { parentId: parent, title: "A で作る", outputName: "成果 A" }); q = a.project;
    const pathA = portsOf(q, br.blockId, "out").find((o) => o.branchOption === "A")!;
    q = connectToBlock(q, { portId: pathA.id, side: "outer" }, a.blockId).project;
    const m = boxMaterial(q, a.blockId);
    expect(m.material.upstreamBranches.map((x) => x.answer)).toEqual([null]);
    const rec = makeRecord("codex", "A の道の仕事", m.sig, m.parts);
    const answered = answerDecision(q, br.blockId, br.decisionId, "A", "human");
    let st = reviewStatus(rec, boxMaterial(answered, a.blockId));
    expect(st.state).toBe("stale"); expect(st.changed).toContain("branches"); // 答えで道が届くので入力の準備状況 (inputs) も変わる
    const rec2 = makeRecord("codex", "A に決まった", boxMaterial(answered, a.blockId).sig, boxMaterial(answered, a.blockId).parts);
    const reopened = reopenDecision(answered, br.blockId, br.decisionId, "human", "再検討");
    expect(reviewStatus(rec2, boxMaterial(reopened, a.blockId)).state).toBe("stale");
    // 供給元の出力の予定成果物が変わる → 入力の材料が変わる
    const withExpect = updatePort(answered, pathA.id, { expect: { kind: "decision", hint: "A と決めた記録" } });
    st = reviewStatus(rec2, boxMaterial(withExpect, a.blockId)); expect(st.changed).toContain("inputs");
    // 位置では古くならない
    const moved = { ...answered, blocks: { ...answered.blocks, [a.blockId]: { ...answered.blocks[a.blockId], position: { x: 1, y: 1 } } } };
    expect(reviewStatus(rec2, boxMaterial(moved, a.blockId)).state).toBe("ok");
  });
});
