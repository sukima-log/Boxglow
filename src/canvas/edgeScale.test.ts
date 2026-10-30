import { describe, expect, it } from "vitest";
import { edgeScale } from "./edgeScale";

describe("線の太さの倍率 (edgeScale)", () => {
  it("100% 以上では 1 (今の太さのまま)", () => {
    expect(edgeScale(1)).toBe(1);
    expect(edgeScale(2)).toBe(1);
  });
  it("縮小するほど太くなり、上限は 3 倍", () => {
    expect(edgeScale(0.5)).toBe(1.5);
    expect(edgeScale(0.25)).toBe(2.3);
    expect(edgeScale(0.05)).toBe(3);
    expect(edgeScale(0.5)).toBeLessThan(edgeScale(0.25));
  });
});
