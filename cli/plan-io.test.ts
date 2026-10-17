/**
 * 計画の入出力の層: メモリ版で CLI の処理が動くこと (ホスト型の MCP の土台)。ファイルを一切触らない
 */
import { describe, expect, it } from "vitest";
import { runCli } from "./main";
import { memoryPlanIO, withPlanIO } from "./plan-io";
import { fromJSON } from "../src/model/graph";

describe("memoryPlanIO + runCli", () => {
  it("init → add → status → done を、メモリの中身だけで通せる。版の照合も効く", () => {
    const io = memoryPlanIO(null);
    const run = (argv: string[]) => withPlanIO(io, () => runCli(argv));
    expect(run(["init", "--name", "メモリの計画", "--lang", "ja"])).toContain("作成");
    expect(fromJSON(io.current()!).name).toBe("メモリの計画");
    const added = run(["add", "最初の箱", "--out", "成果物 A"]);
    expect(added).toMatch(/B\d+/);
    const id = /B\d+/.exec(added)![0];
    expect(run(["status", "--brief"])).toContain("最初の箱");
    expect(run(["log", id, "進めた"])).toBeTruthy();
    const plan = fromJSON(io.current()!);
    expect(Object.values(plan.blocks).some((b) => b.title === "最初の箱")).toBe(true);
    // 古い版を前提にした書き込みは断られる (ファイル版と同じ規則)
    const before = io.current()!;
    expect(() => io.commit("/boxglow/boxglow.json", before + " ", '"stale"')).toThrow();
    expect(io.current()).toBe(before);
  });
  it("ファイルの無い状態で読むと、ファイル版と同じ案内で失敗する", () => {
    const io = memoryPlanIO(null);
    expect(() => withPlanIO(io, () => runCli(["status"]))).toThrow(/boxglow\.json/);
  });
});
