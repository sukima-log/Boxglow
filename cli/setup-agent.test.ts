import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupAgent } from "./setup-agent";

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
    expect(settings.permissions.allow).toEqual(["Read"]);
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
