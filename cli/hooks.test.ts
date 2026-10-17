/**
 * エージェントの hooks (boxglow hook session-start / stop / pre-tool) の試験
 */
import { describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, setActivity } from "../src/model/graph";
import { editsPlanFile, parseHookInput, runHook, unrecordedWork } from "./hooks";

function plan() {
  let p = createProject("試験");
  const r = addBlock(p, { parentId: defaultTaskParent(p), title: "実装する" });
  p = r.project;
  return { p, id: r.blockId };
}

describe("hook の入力", () => {
  it("JSON でなければ空として扱う (フックは失敗させない)", () => {
    expect(parseHookInput("")).toEqual({});
    expect(parseHookInput("not json")).toEqual({});
    expect(parseHookInput('{"stop_hook_active":true}')).toEqual({ stop_hook_active: true });
  });
});

describe("session-start", () => {
  it("計画の再開の概要を文脈として出す。計画が無ければ何も出さない", () => {
    const { p } = plan();
    const r = runHook("session-start", {}, p, "claude-code");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Boxglow");
    expect(r.stdout).toContain("再開");
    expect(runHook("session-start", {}, null, "claude-code").stdout).toBe("");
  });
});

describe("stop", () => {
  it("自分が作業中にした箱に記録が無ければ続行を指示する。記録があれば・2 回目なら何も出さない", () => {
    const { p, id } = plan();
    const started = setActivity(p, id, "claude-code", "working", "着手");
    const r = runHook("stop", {}, started, "claude-code");
    const parsed = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("実装する");
    expect(parsed.reason).toContain("checkpoint");
    // 2 回目 (stop_hook_active) は止めない
    expect(runHook("stop", { stop_hook_active: true }, started, "claude-code").stdout).toBe("");
    // 別の記録者の作業は見ない
    expect(runHook("stop", {}, started, "codex").stdout).toBe("");
    // 引き継ぎメモ (checkpoint) があれば止めない
    const withHandoff = { ...started, handoffs: { [id]: { note: "途中", actor: "claude-code", at: new Date(Date.now() + 1000).toISOString() } } };
    expect(unrecordedWork(withHandoff, "claude-code")).toEqual([]);
    expect(runHook("stop", {}, withHandoff, "claude-code").stdout).toBe("");
    // 作業記録 (log) でもよい。サブエージェント (claude-code-xxx) の記録も自分の分
    const withLog = { ...started, blocks: { ...started.blocks, [id]: { ...started.blocks[id], log: [{ id: "l1", at: new Date(Date.now() + 1000).toISOString(), by: "claude-code-review", text: "確認" }] } } };
    expect(unrecordedWork(withLog, "claude-code")).toEqual([]);
  });
});

describe("pre-tool", () => {
  it("boxglow.json への Edit / Write / apply_patch を止め、ほかは通す", () => {
    expect(editsPlanFile("Edit", { file_path: "/repo/boxglow.json" })).toBe(true);
    expect(editsPlanFile("Write", { file_path: "sub/boxglow.json" })).toBe(true);
    expect(editsPlanFile("Edit", { file_path: "/repo/src/app.ts" })).toBe(false);
    expect(editsPlanFile("Edit", { file_path: "/repo/boxglow.json.bak" })).toBe(false);
    expect(editsPlanFile("apply_patch", { patch: "*** Begin Patch\n*** Update File: boxglow.json\n@@\n*** End Patch" })).toBe(true);
    expect(editsPlanFile("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch" })).toBe(false);
    expect(editsPlanFile("Bash", { command: "cat boxglow.json" })).toBe(false);
    const r = runHook("pre-tool", { tool_name: "Edit", tool_input: { file_path: "boxglow.json" } }, null, "claude-code");
    const parsed = JSON.parse(r.stdout) as { decision: string; hookSpecificOutput: { permissionDecision: string } };
    expect(parsed.decision).toBe("block");
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(runHook("pre-tool", { tool_name: "Edit", tool_input: { file_path: "src/a.ts" } }, null, "claude-code").stdout).toBe("");
  });
});
