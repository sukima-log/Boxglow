import { describe, expect, it } from "vitest";
import { addBlock, canSuggestWhite, connectToBlock, createArtifact, createProject, finishBlock, hasDraftOnly, isInputReady, markDraftInputs, missingRequiredInputs, portsOf, projectBlocks, setStatus, updatePort, waitingFor } from "./graph";
import type { Project } from "./types";

// 作成中 (作りかけ) の資料: 出力に付けても使う側は待ち、使う側の入力が acceptDraft なら着手できる。完了で確定になる (利用者の指摘 2026-10-31)
describe("作成中の資料 (draft) と、作成中で着手可 (acceptDraft)", () => {
  /** デザイン (出力: 体形) → モデリング (入力: 体形) */
  const build = () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const design = addBlock(p, { parentId: pj, title: "体形デザイン", outputName: "体形" }); p = design.project;
    const model = addBlock(p, { parentId: pj, title: "胴体のモデリング", outputName: "胴体" }); p = model.project;
    p = connectToBlock(p, { portId: portsOf(p, design.blockId, "out")[0].id, side: "outer" }, model.blockId).project;
    const out = portsOf(p, design.blockId, "out")[0];
    const input = portsOf(p, model.blockId, "in")[0];
    return { p, design: design.blockId, model: model.blockId, out, input };
  };
  const attachDraft = (p: Project, portId: string) => { const a = createArtifact("body.png", "docs/body.png"); a.draft = true; return updatePort(p, portId, { artifacts: [...p.ports[portId].artifacts, a] }); };

  it("作成中の資料を出力に付けても、使う側の入力はそろわない (待ちのまま、作成中ありと分かる)", () => {
    const { p: p0, out, input, model, design } = build();
    const p = attachDraft(p0, out.id);
    expect(isInputReady(p, input.id)).toBe(false);
    expect(hasDraftOnly(p, input.id)).toBe(true);
    expect(missingRequiredInputs(p, model).map((x) => x.name)).toEqual(["体形"]);
    expect(markDraftInputs(p, model, waitingFor(p, model))[0]).toContain("作成中あり");
    expect(canSuggestWhite(p, design)).toBe(false); // 作成中だけでは完了を勧めない
  });
  it("使う側の入力を acceptDraft にすると、作成中の資料でそろう", () => {
    const { p: p0, out, input, model } = build();
    let p = attachDraft(p0, out.id);
    p = updatePort(p, input.id, { acceptDraft: true });
    expect(isInputReady(p, input.id)).toBe(true);
    expect(missingRequiredInputs(p, model)).toHaveLength(0);
  });
  it("作った箱を完了にすると、作成中の資料は確定になり、使う側の入力がそろう", () => {
    const { p: p0, out, input, design } = build();
    let p = attachDraft(p0, out.id);
    p = finishBlock(p, design, "codex").project;
    expect(p.ports[out.id].artifacts.every((a) => !a.draft)).toBe(true);
    expect(isInputReady(p, input.id)).toBe(true);
    // 状態を Done に切り替えた場合も同じ
    let q = attachDraft(p0, out.id);
    q = setStatus(q, design, "white", "human");
    expect(q.ports[out.id].artifacts.every((a) => !a.draft)).toBe(true);
  });
});
