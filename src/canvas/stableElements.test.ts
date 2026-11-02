/**
 * 図の部品の使い回し (stableElements.ts) の確認
 *   中身が同じ部品は前のオブジェクトを返し、変わった部品は新しいオブジェクトを返す。React Flow が書き込む項目 (測った大きさ) は比べない
 */
import { describe, expect, it } from "vitest";
import { reuseUnchanged, sameContent, sameElement } from "./stableElements";

/** React Flow のノードに似た部品 */
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "block", position: { x: 0, y: 0 }, data: { blockId: id, dimmed: false }, width: 256, height: 120, selected: false, ...extra });

describe("図の部品の使い回し", () => {
  it("中身の比較: 配列・入れ子のオブジェクトも中身で比べ、関数は同じものだけ同じ", () => {
    expect(sameContent({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameContent({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(sameContent({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    const f = () => 0;
    expect(sameContent({ f }, { f })).toBe(true);
    expect(sameContent({ f }, { f: () => 0 })).toBe(false);
  });

  it("React Flow が書き込む項目 (測った大きさ・ドラッグ中) は比べない", () => {
    expect(sameElement({ ...node("a"), measured: { width: 256, height: 120 }, dragging: false }, node("a"))).toBe(true);
    expect(sameElement(node("a"), node("a", { selected: true }))).toBe(false);
  });

  it("全部同じなら前の一覧そのものを返し、測り直す対象は無い", () => {
    const prev = [node("a"), node("b")];
    const r = reuseUnchanged(prev, [node("a"), node("b")]);
    expect(r.items).toBe(prev);
    expect(r.changed).toEqual([]);
  });

  it("変わった部品だけ新しいオブジェクトにし、ほかは前のオブジェクトを使う。大きさが同じなら測った大きさを引き継ぐ", () => {
    const measured = { width: 256, height: 120 };
    const prev = [{ ...node("a"), measured }, { ...node("b"), measured }, { ...node("c"), measured }];
    const r = reuseUnchanged(prev, [node("a"), node("b", { selected: true }), node("c", { width: 300 }), node("d")], { carryMeasured: true });
    expect(r.items[0]).toBe(prev[0]);
    expect(r.items[1]).not.toBe(prev[1]);
    expect(r.items[1]).toMatchObject({ selected: true, measured }); // 大きさが同じ: 測った大きさを引き継ぐ
    expect((r.items[2] as { measured?: unknown }).measured).toBeUndefined(); // 大きさが変わった: 測り直す (React Flow が測る)
    expect(r.items[3]).toEqual(node("d")); // 新しい部品
    expect(r.changed).toEqual(["b", "c"]);
  });

  it("並びが変わったときも、中身が同じ部品は前のオブジェクトを使う (一覧は新しい並びで返す)", () => {
    const prev = [node("a"), node("b")];
    const r = reuseUnchanged(prev, [node("b"), node("a")]);
    expect(r.items).not.toBe(prev);
    expect(r.items[0]).toBe(prev[1]);
    expect(r.items[1]).toBe(prev[0]);
  });

  it("alwaysChanged の部品は、中身が同じでも作り直したものを使い、測り直す対象にする", () => {
    const prev = [node("t", { type: "terminal" })];
    const r = reuseUnchanged(prev, [node("t", { type: "terminal" })], { alwaysChanged: (n) => n.type === "terminal" });
    expect(r.items[0]).not.toBe(prev[0]);
    expect(r.changed).toEqual(["t"]);
  });
});
