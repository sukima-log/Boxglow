import { expect, it } from "vitest";
import { actorOf, executionAgent, syncAudienceFor } from "./actor";
it.each(["CLAUDECODE", "CLAUDE_CODE", "CODEX_SANDBOX", "CODEX_THREAD_ID", "CODEX_SESSION_ID"])("%sは継承した人宣言より優先する", key => {
  const env = { [key]: "test", BOXGLOW_ACTOR: "human:hash" };
  expect(syncAudienceFor(undefined, env)).toBe("ai");
  expect(actorOf(undefined, env)).toBe(key.startsWith("CLAUDE") ? "claude-code" : "codex");
  expect(syncAudienceFor("human:hash", env)).toBe("human");
  expect(actorOf("human:hash", env)).toBe("human:hash");
});
it.each(["codex-sub", "claude-code-research", "codex:child", "agent-task"])("%sは環境の印がなくてもAI", name => {
  expect(syncAudienceFor(undefined, {BOXGLOW_ACTOR: name})).toBe("ai");
  expect(actorOf(undefined, {BOXGLOW_ACTOR: name})).toBe(name);
});
it("設定フォルダと通常の記録者名はAIの根拠にしない", () => {
  const env = { CODEX_HOME: "/settings", BOXGLOW_ACTOR: "hash" };
  expect(executionAgent(env)).toBeUndefined(); expect(actorOf(undefined,env)).toBe("hash");
  expect(syncAudienceFor(undefined,env)).toBe("human");
  expect(syncAudienceFor("codex", {})).toBe("ai");
});
