/**
 * 退避した編集の取り込みの試験 (レビュー 39 の R39-05 / 06 / 07、レビュー 40 の R40-03 / 04 / 06 の回帰)
 */
import { describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";
import { applyRestore, editorCaughtUp, prepareRestore, readRecovery } from "./recovery";

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
const rec = (base: string, gui: string, editor: string | null = null, received: string | null = null) => readRecovery({ boxglowRecovery: 1, base, received, gui: { text: gui }, editor: editor ? { text: editor, version: 7 } : null })!;

describe("退避した編集の取り込み", () => {
  it("R39-06: 開き直した最新 R に、退避した画面の編集 G を取り込む。受け取った側の変更 (説明) も残る。競合が無ければ選ばずに取り込める", () => {
    const { L, R, G, a } = fixture();
    expect(prepareRestore(rec(L, G), fromJSON(R))).toEqual({ conflicts: [] });
    const result = applyRestore(rec(L, G), fromJSON(R), {});
    if ("error" in result) throw new Error(result.error);
    expect(result.project.blocks[a].title).toBe("画面の題名");
    expect(result.project.blocks[a].description).toBe("受け取った説明");
  });

  it("R39-05: エディタ側の独立した編集 E も取り込む (G・E・基準・R がすべて違う場合)", () => {
    const { L, R, G, E, a, b } = fixture();
    const result = applyRestore(rec(L, G, E), fromJSON(R), {});
    if ("error" in result) throw new Error(result.error);
    expect(result.project.blocks[a].title).toBe("画面の題名");
    expect(result.project.blocks[a].description).toBe("受け取った説明");
    expect(result.project.blocks[b].title).toBe("エディタの題名");
  });

  it("R40-03: 同じ項目を今・画面・エディタが違う値にしていたら、3 つの値を競合として示し、選ぶまで取り込まない。選んだ値になる", () => {
    const { L, a } = fixture();
    const R = toJSON(updateBlock(fromJSON(L), a, { title: "今の題名" }));
    const G = toJSON(updateBlock(fromJSON(L), a, { title: "画面の題名" }));
    const E = toJSON(updateBlock(fromJSON(L), a, { title: "エディタの題名" }));
    const prepared = prepareRestore(rec(L, G, E), fromJSON(R));
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.conflicts).toEqual([expect.objectContaining({ current: "今の題名", gui: "画面の題名", editor: "エディタの題名" })]);
    const id = prepared.conflicts[0].id;
    expect(applyRestore(rec(L, G, E), fromJSON(R), {})).toEqual({ error: "unresolved" });
    for (const [pick, title] of [["current", "今の題名"], ["gui", "画面の題名"], ["editor", "エディタの題名"]] as const) {
      const result = applyRestore(rec(L, G, E), fromJSON(R), { [id]: pick });
      if ("error" in result) throw new Error(result.error);
      expect(result.project.blocks[a].title).toBe(title);
    }
  });

  it("R40-04: 個別には正しい親の変更どうしで循環ができる組み合わせは、取り込まない", () => {
    const { L, a, b } = fixture();
    const G = toJSON(updateBlock(fromJSON(L), a, {}));
    const g = fromJSON(L); g.blocks[a].parentId = b;           // 画面: A を B の子に
    const r = fromJSON(L); r.blocks[b].parentId = a;           // 今: B を A の子に
    void G;
    const result = applyRestore(rec(L, toJSON(g)), r, {});
    expect("error" in result && result.error.startsWith("invalid:")).toBe(true);
  });

  it("R40-06: 別の計画の退避は取り込まない。同じ計画なら、場所 (パス) に関係なく取り込める", () => {
    const { L, R, G } = fixture();
    const other = toJSON(createProject("別の計画"));
    expect(prepareRestore(rec(L, other), fromJSON(R))).toEqual({ error: "different-plan" });
    expect(prepareRestore(rec(L, G, other), fromJSON(R))).toEqual({ error: "different-plan" });
    expect("conflicts" in prepareRestore(rec(L, G), fromJSON(R))).toBe(true);
    expect(readRecovery({ gui: { text: G } })).toBeNull();
  });

  it("R39-07: エディタ待ちは、届いた中身が受け取った最新と同じときだけ解ける (古い版の中身では解けない)", () => {
    const { L, R } = fixture();
    expect(editorCaughtUp(R, L)).toBe(false);
    expect(editorCaughtUp(R, R)).toBe(true);
    expect(editorCaughtUp(null, R)).toBe(false);
  });
});
