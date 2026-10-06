/**
 * 退避した編集の取り込みの試験 (レビュー 39 の R39-05 / 06 / 07 の回帰)
 */
import { describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";
import { editorCaughtUp, mergeRecovery, readRecovery } from "./recovery";

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

describe("退避した編集の取り込み", () => {
  it("R39-06: 開き直した最新 R に、退避した画面の編集 G を取り込む。受け取った側の変更 (説明) も残る", () => {
    const { L, R, G, a } = fixture();
    const recovery = readRecovery({ boxglowRecovery: 1, base: L, received: R, gui: { text: G }, editor: null })!;
    const result = mergeRecovery(recovery, fromJSON(R));
    if ("error" in result) throw new Error(result.error);
    expect(result.project.blocks[a].title).toBe("画面の題名");
    expect(result.project.blocks[a].description).toBe("受け取った説明");
    expect(result.conflicts).toEqual([]);
  });

  it("R39-05: エディタ側の独立した編集 E も取り込む (G・E・基準・R がすべて違う場合)", () => {
    const { L, R, G, E, a, b } = fixture();
    const recovery = readRecovery({ boxglowRecovery: 1, base: L, received: R, gui: { text: G }, editor: { text: E, version: 7 } })!;
    const result = mergeRecovery(recovery, fromJSON(R));
    if ("error" in result) throw new Error(result.error);
    expect(result.project.blocks[a].title).toBe("画面の題名");
    expect(result.project.blocks[a].description).toBe("受け取った説明");
    expect(result.project.blocks[b].title).toBe("エディタの題名");
  });

  it("両側で同じ項目を別の値にしていたら、退避した編集の値を採り、その項目を知らせる。形の違うファイルは読まない", () => {
    const { L, G, a } = fixture();
    const R2 = toJSON(updateBlock(fromJSON(L), a, { title: "受け取った題名" }));
    const result = mergeRecovery(readRecovery({ boxglowRecovery: 1, base: L, received: R2, gui: { text: G }, editor: null })!, fromJSON(R2));
    if ("error" in result) throw new Error(result.error);
    expect(result.project.blocks[a].title).toBe("画面の題名");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(readRecovery({ gui: { text: G } })).toBeNull();
    expect(readRecovery(null)).toBeNull();
  });

  it("R39-07: エディタ待ちは、届いた中身が受け取った最新と同じときだけ解ける (古い版の中身では解けない)", () => {
    const { L, R } = fixture();
    expect(editorCaughtUp(R, L)).toBe(false);
    expect(editorCaughtUp(R, R)).toBe(true);
    expect(editorCaughtUp(null, R)).toBe(false);
  });
});
