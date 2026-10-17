import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAgentSetup, setupAgent } from "./setup-agent";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const fixture = () => { const root = mkdtempSync(join(tmpdir(), "boxglow-setup-")); dirs.push(root); return { root, agent: "all", snippet: "Intro\n---\nShared instructions\n---", skill: "---\nname: boxglow\n---\nanswer --by claude-code" }; };

describe("agent setup", () => {
  it("installs Codex instructions and skill without Claude configuration", () => {
    const opts = { ...fixture(), agent: "codex" };
    writeFileSync(join(opts.root, "AGENTS.md"), "User instructions\n");
    setupAgent(opts);
    expect(readFileSync(join(opts.root, "AGENTS.md"), "utf8")).toContain("User instructions");
    expect(readFileSync(join(opts.root, ".agents/skills/boxglow/SKILL.md"), "utf8")).toContain("--by codex");
    expect(existsSync(join(opts.root, ".claude"))).toBe(false);
    expect(existsSync(join(opts.root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(opts.root, ".mcp.json"))).toBe(false);
    expect(setupAgent(opts)).toHaveLength(1); // no changes
    expect(readFileSync(join(opts.root, "AGENTS.md"), "utf8").match(/boxglow:begin/g)).toHaveLength(1);
  });
  it("keeps other hooks, MCP servers and instructions on repeated setup", () => {
    const opts = fixture();
    mkdirSync(join(opts.root, ".claude"));
    writeFileSync(join(opts.root, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }));
    writeFileSync(join(opts.root, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "other" }, boxglow: { command: "custom-boxglow" } } }));
    setupAgent(opts); setupAgent(opts);
    const settings = JSON.parse(readFileSync(join(opts.root, ".claude/settings.json"), "utf8"));
    expect(settings.permissions.allow).toContain("Read");   // 既存の許可は残し、Boxglow の CLI の許可が足される
    expect(settings.permissions.allow).toContain("Bash(npx boxglow *)");
    expect(settings.hooks.SessionStart).toHaveLength(2);
    const mcp = JSON.parse(readFileSync(join(opts.root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.boxglow.command).toBe("custom-boxglow");
    expect(mcp.mcpServers.other.command).toBe("other");
  });
  it.each([".mcp.json", ".claude/settings.json"])("leaves every file untouched when %s is malformed", (name) => {
    const opts = fixture();
    mkdirSync(join(opts.root, ".claude"));
    writeFileSync(join(opts.root, name), "{broken");
    expect(() => setupAgent(opts)).toThrow();
    expect(readFileSync(join(opts.root, name), "utf8")).toBe("{broken");
    expect(existsSync(join(opts.root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(opts.root, ".agents"))).toBe(false);
  });
  it("rejects unmatched instruction markers without overwriting instructions", () => {
    const opts = fixture();
    writeFileSync(join(opts.root, "AGENTS.md"), "My rules\n<!-- boxglow:begin -->");
    expect(() => setupAgent(opts)).toThrow(/boxglow:begin/);
    expect(readFileSync(join(opts.root, "AGENTS.md"), "utf8")).toBe("My rules\n<!-- boxglow:begin -->");
  });
  it("supports Claude-only setup and rejects an unknown target", () => {
    const opts = { ...fixture(), agent: "claude-code" };
    setupAgent(opts);
    expect(existsSync(join(opts.root, ".agents"))).toBe(false);
    expect(existsSync(join(opts.root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(opts.root, "CLAUDE.md"))).toBe(true);
    expect(() => setupAgent({ ...opts, agent: "typo" })).toThrow(/--agent/);
  });
});

it("生成する両エージェントの指示に明示actorを付け、再実行で増やさない", () => {
  const root = mkdtempSync(join(tmpdir(), "boxglow-identity-"));
  try {
    setupAgent({root, agent: "all", snippet: "---\nInstructions\n---", skill: "Skill"});
    expect(readFileSync(join(root,"AGENTS.md"),"utf8")).toContain("--actor codex");
    expect(readFileSync(join(root,"CLAUDE.md"),"utf8")).toContain("--actor claude-code");
    expect(setupAgent({root,agent:"all",snippet:"---\nInstructions\n---",skill:"Skill"})).toHaveLength(1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

describe("hooks・サブエージェント・Codex の設定 (利用者が仕組みを知らなくても全部入る)", () => {
  it("Claude Code: 3 つの hooks、CLI の許可、.mcp.json の自動承認、レビュー用のサブエージェントが入り、古い SessionStart (npx boxglow status) は置き換わる", () => {
    const opts = { ...fixture(), agent: "claude-code" };
    mkdirSync(join(opts.root, ".claude"));
    writeFileSync(join(opts.root, ".claude/settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "npx boxglow status" }] }] } }));
    setupAgent(opts);
    const settings = JSON.parse(readFileSync(join(opts.root, ".claude/settings.json"), "utf8"));
    const all = JSON.stringify(settings.hooks);
    expect(all).not.toContain('"npx boxglow status"');
    for (const e of ["session-start", "stop", "pre-tool"]) expect(all).toContain(`npx boxglow hook ${e} --actor claude-code`);
    expect(settings.hooks.SessionStart[0].matcher).toContain("compact");
    expect(settings.hooks.PreToolUse[0].matcher).toContain("Edit");
    expect(settings.enableAllProjectMcpServers).toBeUndefined();   // ほかの MCP サーバの承認方針は変えない (R30-03)
    expect(settings.enabledMcpjsonServers).toEqual(["boxglow"]);
    expect(readFileSync(join(opts.root, ".claude/agents/boxglow-review.md"), "utf8")).toContain("name: boxglow-review");
    expect(JSON.parse(readFileSync(join(opts.root, ".mcp.json"), "utf8")).mcpServers.boxglow.args).toContain("--actor");
    // もう一度実行しても増えない
    expect(setupAgent(opts)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(opts.root, ".claude/settings.json"), "utf8")).hooks.Stop).toHaveLength(1);
    expect(checkAgentSetup(opts.root, "claude-code").filter((l) => /^(OK|NG)/.test(l)).every((l) => l.startsWith("OK"))).toBe(true);
  });
  it("Codex: .codex/config.toml の MCP、.codex/hooks.json、openai.yaml、レビュー用のサブエージェントが入り、既存の config.toml は残る", () => {
    const opts = { ...fixture(), agent: "codex" };
    mkdirSync(join(opts.root, ".codex"));
    writeFileSync(join(opts.root, ".codex/config.toml"), 'model = "x"\n');
    setupAgent(opts);
    const toml = readFileSync(join(opts.root, ".codex/config.toml"), "utf8");
    expect(toml.startsWith('model = "x"')).toBe(true);
    expect(toml).toContain("[mcp_servers.boxglow]");
    const hooks = JSON.parse(readFileSync(join(opts.root, ".codex/hooks.json"), "utf8"));
    expect(JSON.stringify(hooks.hooks)).toContain("npx boxglow hook stop --actor codex");
    expect(hooks.hooks.PreToolUse[0].matcher).toContain("apply_patch");
    expect(readFileSync(join(opts.root, ".agents/skills/boxglow/agents/openai.yaml"), "utf8")).toContain("value: boxglow");
    expect(readFileSync(join(opts.root, ".codex/agents/boxglow-review.toml"), "utf8")).toContain('name = "boxglow-review"');
    expect(setupAgent(opts)).toHaveLength(1);
    expect(toml).toBe(readFileSync(join(opts.root, ".codex/config.toml"), "utf8"));
    expect(checkAgentSetup(opts.root, "codex").filter((l) => /^(OK|NG)/.test(l)).every((l) => l.startsWith("OK"))).toBe(true);
    expect(checkAgentSetup(opts.root, "claude-code").some((l) => l.startsWith("NG"))).toBe(true);
  });
  it("Codex: 引用符付きの [mcp_servers.\"boxglow\"] も同じ表と見なして足さない。壊れた TOML なら何も書かない (R30-02)", () => {
    const quoted = { ...fixture(), agent: "codex" };
    mkdirSync(join(quoted.root, ".codex"));
    writeFileSync(join(quoted.root, ".codex/config.toml"), '[mcp_servers."boxglow"]\ncommand = "custom-boxglow"\n');
    setupAgent(quoted);
    expect(readFileSync(join(quoted.root, ".codex/config.toml"), "utf8")).toBe('[mcp_servers."boxglow"]\ncommand = "custom-boxglow"\n');
    expect(checkAgentSetup(quoted.root, "codex").some((l) => l.startsWith("OK .codex/config.toml"))).toBe(true);
    const broken = { ...fixture(), agent: "codex" };
    mkdirSync(join(broken.root, ".codex"));
    writeFileSync(join(broken.root, ".codex/config.toml"), "model =\n");
    expect(() => setupAgent(broken)).toThrow();
    expect(existsSync(join(broken.root, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(broken.root, ".codex/hooks.json"))).toBe(false);
    // mcp_servers がインラインの表だと、追記で二重定義になるので止める
    const inline = { ...fixture(), agent: "codex" };
    mkdirSync(join(inline.root, ".codex"));
    writeFileSync(join(inline.root, ".codex/config.toml"), 'mcp_servers = { other = { command = "x" } }\n');
    expect(() => setupAgent(inline)).toThrow();
  });
  it("--check は hooks の構造 (イベントと matcher) を見る", () => {
    const opts = { ...fixture(), agent: "claude-code" };
    setupAgent(opts);
    const path = join(opts.root, ".claude/settings.json");
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.hooks.PreToolUse[0].matcher = "^NeverThisTool$";
    writeFileSync(path, JSON.stringify(settings));
    expect(checkAgentSetup(opts.root, "claude-code").some((l) => l.startsWith("NG .claude/settings.json (hooks"))).toBe(true);
  });
});
