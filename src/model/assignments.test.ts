/**
 * 担当の一覧 (表の行) の確認: 誰の担当か、完了済みの扱い、並び、期日切れ、入力の待ち、判断待ち
 */
import { describe, expect, it } from "vitest";
import { addBlock, addMember, addPort, askDecision, createProject, defaultTaskParent, updateBlock } from "./graph";
import { assignmentRows } from "./assignments";

/** 担当の付いた小さな計画: さとうが A (期日 10/20)・B (期日なし)・C (完了)、たなかが D、E は未担当 */
function fixture() {
  let p = createProject("担当の一覧");
  const sato = addMember(p, "さとう", "#0d8080"); p = sato.project;
  const tanaka = addMember(p, "たなか", "#e8875e"); p = tanaka.project;
  const parent = defaultTaskParent(p);
  const ids: Record<string, string> = {};
  for (const title of ["A", "B", "C", "D", "E"]) { const r = addBlock(p, { parentId: parent, title }); p = r.project; ids[title] = r.blockId; }
  p = updateBlock(p, ids.A, { assigneeIds: [sato.memberId], dueDate: "2026-10-20", estimateHours: 8 });
  p = updateBlock(p, ids.B, { assigneeIds: [sato.memberId] });
  p = updateBlock(p, ids.C, { assigneeIds: [sato.memberId], status: "white", dueDate: "2026-10-01" });
  p = updateBlock(p, ids.D, { assigneeIds: [tanaka.memberId], dueDate: "2026-10-05" });
  return { p, ids, sato: sato.memberId, tanaka: tanaka.memberId };
}

describe("担当の一覧", () => {
  it("メンバーの担当だけを、期日の近い順 (期日なしは後ろ) に出す。完了済みは既定で出さない", () => {
    const { p, sato } = fixture();
    const rows = assignmentRows(p, { memberId: sato }, { today: "2026-10-09" });
    expect(rows.map((r) => r.title)).toEqual(["A", "B"]);
    expect(rows[0]).toMatchObject({ dueDate: "2026-10-20", estimateHours: 8, overdue: false, status: "black" });
  });
  it("完了済みも含める指定では、完了済みも出す。完了済みは期日を過ぎていても期日切れにしない", () => {
    const { p, sato } = fixture();
    const rows = assignmentRows(p, { memberId: sato }, { includeDone: true, today: "2026-10-09" });
    expect(rows.map((r) => r.title)).toEqual(["C", "A", "B"]);
    expect(rows[0]).toMatchObject({ status: "white", overdue: false, progress: 100, missingInputs: [] });
  });
  it("期日を過ぎた未完了は期日切れ。未担当も出せる (プロジェクトのボックスは出さない)", () => {
    const { p, tanaka } = fixture();
    expect(assignmentRows(p, { memberId: tanaka }, { today: "2026-10-09" })[0]).toMatchObject({ title: "D", overdue: true });
    expect(assignmentRows(p, { unassigned: true }, { today: "2026-10-09" }).map((r) => r.title)).toEqual(["E"]);
  });
  it("全員では、担当の有無を問わずすべてのタスクを出し、担当の名前を添える", () => {
    const { p } = fixture();
    const rows = assignmentRows(p, { everyone: true }, { today: "2026-10-09" });
    // 期日の近い順: D (10/05) → A (10/20) → 期日なし (B, E。B 番号の順)。C は完了済みなので出ない
    expect(rows.map((r) => r.title)).toEqual(["D", "A", "B", "E"]);
    expect(rows.map((r) => r.assignees)).toEqual([["たなか"], ["さとう"], ["さとう"], []]);
  });
  it("場所・入力の待ち・判断待ちの数を出す", () => {
    let { p, ids, sato } = fixture();
    // A の中に子を作り、必須の入力 (供給元なし) と未回答の質問を付ける
    const child = addBlock(p, { parentId: ids.A, title: "子" }); p = child.project;
    p = addPort(p, { blockId: child.blockId, direction: "in", name: "仕様" }).project;
    p = askDecision(p, child.blockId, "codex", "どちらにしますか?", ["X", "Y"]).project;
    p = updateBlock(p, child.blockId, { assigneeIds: [sato] });
    const row = assignmentRows(p, { memberId: sato }, { today: "2026-10-09" }).find((r) => r.title === "子")!;
    expect(row.where).toBe("A");
    expect(row.missingInputs).toEqual(["仕様"]);
    expect(row.pendingDecisions).toBe(1);
  });
});
