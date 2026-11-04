/**
 * 文脈の圧縮の回数 (cli/compactions.ts) の試験: セッションと箱ごとに数える・識別子の値を残さない・古いものを捨てる
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compactionsOf, recordCompaction, sessionMark } from "./compactions";

const dir = mkdtempSync(join(tmpdir(), "boxglow-compactions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
/** 試験ごとの置き場所 */
const fresh = () => join(dir, `c-${n++}.json`);

describe("圧縮の回数", () => {
  it("セッションごとと、作業中の箱ごとに数える。数えていないセッションは 0 回", () => {
    const path = fresh();
    expect(compactionsOf("s1", path)).toEqual({ session: 0, boxes: {} });
    expect(recordCompaction("s1", ["a"], path)).toEqual({ session: 1, boxes: { a: 1 } });
    expect(recordCompaction("s1", ["a", "b"], path)).toEqual({ session: 2, boxes: { a: 2, b: 1 } });
    expect(recordCompaction("s2", [], path)).toEqual({ session: 1, boxes: {} });
    expect(compactionsOf("s1", path)).toEqual({ session: 2, boxes: { a: 2, b: 1 } });
    expect(compactionsOf(undefined, path)).toEqual({ session: 0, boxes: {} });
  });
  it("セッションの識別子の値はファイルに残さない (ハッシュの先頭 8 文字だけ)", () => {
    const path = fresh();
    recordCompaction("secret-session-id", ["a"], path);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("secret-session-id");
    expect(text).toContain(sessionMark("secret-session-id"));
  });
  it("30 日より古いセッションは捨てる", () => {
    const path = fresh();
    recordCompaction("old", ["a"], path, new Date("2026-09-01T00:00:00Z"));
    recordCompaction("new", ["b"], path, new Date("2026-11-01T00:00:00Z"));
    expect(compactionsOf("old", path).session).toBe(0);
    expect(compactionsOf("new", path).session).toBe(1);
  });
  it("壊れたファイルは空として扱い、数え直す (作業は止めない)", () => {
    const path = fresh();
    writeFileSync(path, "not json");
    expect(compactionsOf("s1", path)).toEqual({ session: 0, boxes: {} });
    expect(recordCompaction("s1", [], path).session).toBe(1);
  });
});
