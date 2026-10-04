import { describe, expect, it } from "vitest";
import { createProject, addBlock, defaultTaskParent, askDecision, answerDecision, ackDecisions, editDecisionAnswer } from "./graph";
import { resumeSummary } from "./resume";

describe("resume overview", () => {
  it("shows the current unread human answer without acknowledging it", () => {
    let p = createProject("resume");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "Ship" }); p = a.project;
    p = askDecision(p, a.blockId, "codex", "Where?", ["A", "B"]).project;
    const id = p.blocks[a.blockId].decisions[0].id;
    p = answerDecision(p, a.blockId, id, "A", "human");
    p = ackDecisions(p, a.blockId, "codex");
    expect(resumeSummary(p).unreadAnswers).toHaveLength(0);
    p = editDecisionAnswer(p, a.blockId, id, "B", "human");
    p.log.push({ id: "unrelated", blockId: a.blockId, kind: "note", actor: "codex", at: "2099-01-01T00:00:00Z", message: "Another question, not an acknowledgement" });
    const snapshot = JSON.stringify(p);
    expect(resumeSummary(p).unreadAnswers[0].answer).toBe("B");
    expect(JSON.stringify(p)).toBe(snapshot);
  });
  it("orders durable handoffs by recency, ignores deleted tasks and empty notes", () => {
    let p = createProject("resume");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    const b = addBlock(p, { parentId: defaultTaskParent(p), title: "B" }); p = b.project;
    p.handoffs = { [a.blockId]: { note: "Next: review", actor: "codex", at: "2026-10-01T00:00:00Z" }, [b.blockId]: { note: "Keep human choice", actor: "human", at: "2026-10-02T00:00:00Z" }, deleted: { note: "obsolete", actor: "codex", at: "2026-10-03T00:00:00Z" } };
    expect(resumeSummary(p).handoffs.map((h) => h.title)).toEqual(["B", "A"]);
    p.handoffs[b.blockId].note = " ";
    expect(resumeSummary(p).handoffs.map((h) => h.title)).toEqual(["A"]);
  });
});
