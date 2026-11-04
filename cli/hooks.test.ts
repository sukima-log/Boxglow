/**
 * エージェントの hooks (boxglow hook session-start / stop / pre-tool) の試験
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addBlock, createProject, defaultTaskParent, setActivity } from "../src/model/graph";
import { editsPlanFile, parseHookInput, runHook, unrecordedWork } from "./hooks";
import { compactionsOf } from "./compactions";

// 圧縮の回数は、試験ごとに作業用の場所へ数える (利用者の設定フォルダを触らない)
const tmp = mkdtempSync(join(tmpdir(), "boxglow-hooks-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let serial = 0;
const store = () => join(tmp, `compactions-${serial++}.json`);

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

describe("session-start: 圧縮の後", () => {
  /** セッション s1 で「実装する」を作業中にした計画 (引き継ぎメモを付けるかどうか) */
  function working(handoff?: string) {
    const { p, id } = plan();
    const started0 = setActivity(p, id, "codex", "working", "API を直す");
    const started = { ...started0, blocks: { ...started0.blocks, [id]: { ...started0.blocks[id], activity: { ...started0.blocks[id].activity!, session: "s1" } } } };
    return { id, p: handoff ? { ...started, handoffs: { [id]: { note: handoff, actor: "codex", at: new Date().toISOString() } } } : started };
  }
  it("このセッションで作業中の箱があれば、その箱の作業・引き継ぎ・圧縮の回数だけを入れ、全体の概要は入れない", () => {
    const { p, id } = working("ログイン画面まで確認済み; 次は保存");
    const path = store();
    const r = runHook("session-start", { source: "compact", session_id: "s1" }, p, "codex", { compactions: path });
    expect(r.stdout).toContain("圧縮の後の再開");
    expect(r.stdout).toContain("このセッションの文脈の圧縮: 1 回目");
    expect(r.stdout).toContain("実装する: API を直す");
    expect(r.stdout).toContain("圧縮をまたいだ回数: 1");
    expect(r.stdout).toContain("ログイン画面まで確認済み; 次は保存");
    expect(r.stdout).not.toContain("## 次の候補");
    expect(compactionsOf("s1", path)).toEqual({ session: 1, boxes: { [id]: 1 } });
  });
  it("引き継ぎメモが無ければ残し方を案内し、3 回またいだ箱には分けるよう案内する", () => {
    const { p } = working();
    const path = store();
    const outs = [1, 2, 3].map(() => runHook("session-start", { source: "compact", session_id: "s1" }, p, "codex", { compactions: path }).stdout);
    expect(outs[0]).toContain("引き継ぎメモがまだありません");
    expect(outs[1]).not.toContain("1 つのセッションに収まっていません");
    expect(outs[2]).toContain("圧縮を 3 回またいでいて、1 つのセッションに収まっていません");
  });
  it("作業中の箱が無い・別セッションの作業・開始や再開のときは、今までどおり全体の概要を入れる (圧縮のときだけ数える)", () => {
    const { p } = working();
    const path = store();
    const other = runHook("session-start", { source: "compact", session_id: "s2" }, p, "codex", { compactions: path });
    expect(other.stdout).toContain("## 次の候補");
    expect(compactionsOf("s2", path).session).toBe(1);
    const startup = runHook("session-start", { source: "startup", session_id: "s1" }, p, "codex", { compactions: path });
    expect(startup.stdout).toContain("## 次の候補");
    expect(compactionsOf("s1", path).session).toBe(0);
    // 識別子の無い入力は数えない
    expect(runHook("session-start", { source: "compact" }, p, "codex", { compactions: path }).stdout).toContain("## 次の候補");
  });
});

describe("stop", () => {
  it("このセッションが作業中にした箱に引き継ぎが無ければ続行を指示する。別セッション・識別子無し・2 回目・引き継ぎ済みなら何も出さない", () => {
    const { p, id } = plan();
    const started0 = setActivity(p, id, "claude-code", "working", "着手");
    // セッションの識別子が無い作業 (古い版・別プロセス) は対象にしない (別セッションの作業を引き取らせない。Codex レビュー 30 R30-04)
    expect(runHook("stop", { session_id: "s1" }, started0, "claude-code").stdout).toBe("");
    const started = { ...started0, blocks: { ...started0.blocks, [id]: { ...started0.blocks[id], activity: { ...started0.blocks[id].activity!, session: "s1" } } } };
    const r = runHook("stop", { session_id: "s1" }, started, "claude-code");
    const parsed = JSON.parse(r.stdout) as { decision: string; reason: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("実装する");
    expect(parsed.reason).toContain("checkpoint");
    // 別のセッション・識別子の無い入力・別の記録者は止めない
    expect(runHook("stop", { session_id: "s2" }, started, "claude-code").stdout).toBe("");
    expect(runHook("stop", {}, started, "claude-code").stdout).toBe("");
    expect(runHook("stop", { session_id: "s1" }, started, "codex").stdout).toBe("");
    // Codex の thread-id でも対応付ける
    expect(JSON.parse(runHook("stop", { "thread-id": "s1" }, started, "claude-code").stdout).decision).toBe("block");
    // 2 回目 (stop_hook_active) は止めない
    expect(runHook("stop", { session_id: "s1", stop_hook_active: true }, started, "claude-code").stdout).toBe("");
    // 引き継ぎメモ (checkpoint) があれば止めない
    const withHandoff = { ...started, handoffs: { [id]: { note: "途中", actor: "claude-code", at: new Date(Date.now() + 1000).toISOString() } } };
    expect(unrecordedWork(withHandoff, "claude-code", "s1")).toEqual([]);
    // 記録者は完全一致: サブエージェント (claude-code-review) の作業は親の Stop では見ない (子の session_id は親と同じ。R30b-05)
    const childWork = { ...started, blocks: { ...started.blocks, [id]: { ...started.blocks[id], activity: { ...started.blocks[id].activity!, actor: "claude-code-review" } } } };
    expect(unrecordedWork(childWork, "claude-code", "s1")).toEqual([]);
    // 作業記録 (log) は引き継ぎの代わりにならない (開始直後の 1 行で通らない。R30-06)
    const withLog = { ...started, blocks: { ...started.blocks, [id]: { ...started.blocks[id], log: [{ id: "l1", at: new Date(Date.now() + 1000).toISOString(), by: "claude-code", text: "確認" }] } } };
    expect(unrecordedWork(withLog, "claude-code", "s1")).toHaveLength(1);
  });
});

describe("pre-tool", () => {
  it("boxglow.json への Edit / Write / apply_patch を止め、ほかは通す", () => {
    expect(editsPlanFile("Edit", { file_path: "/repo/boxglow.json" })).toBe(true);
    expect(editsPlanFile("Write", { file_path: "sub/boxglow.json" })).toBe(true);
    expect(editsPlanFile("Edit", { file_path: "/repo/src/app.ts" })).toBe(false);
    expect(editsPlanFile("Edit", { file_path: "/repo/boxglow.json.bak" })).toBe(false);
    // Codex の公式の入力は command (R30-01)。移動先も見る。myboxglow.json は対象にしない
    expect(editsPlanFile("apply_patch", { command: "*** Begin Patch\n*** Update File: boxglow.json\n@@\n-old\n+new\n*** End Patch" })).toBe(true);
    expect(editsPlanFile("apply_patch", { command: "*** Begin Patch\n*** Update File: sub/dir/boxglow.json\n*** End Patch" })).toBe(true);
    expect(editsPlanFile("apply_patch", { command: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: boxglow.json\n*** End Patch" })).toBe(true);
    expect(editsPlanFile("apply_patch", { command: "*** Begin Patch\n*** Update File: myboxglow.json\n*** End Patch" })).toBe(false);
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
