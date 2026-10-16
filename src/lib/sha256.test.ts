import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex (ブラウザ用の同期 SHA-256)", () => {
  it("Node の createHash と同じ値 (空・短い・長い・多バイト文字・境界の長さ)", () => {
    const samples = ["", "abc", "a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "日本語の計画 🚀 " + "x".repeat(300), JSON.stringify({ a: 1, b: [1, 2, 3] })];
    for (const s of samples) expect(sha256Hex(s)).toBe(createHash("sha256").update(s).digest("hex"));
  });
  it("5 MiB の文字列でも計算できる", () => {
    const big = "0123456789".repeat(524288);
    expect(sha256Hex(big)).toBe(createHash("sha256").update(big).digest("hex"));
  });
});
