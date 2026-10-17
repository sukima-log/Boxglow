/**
 * AI エージェントの接続 (src/sync/agent.ts) の試験: 設定ファイルの併合と .gitignore
 */
import { describe, expect, it } from "vitest";
import { gitignoreWithMcpJson, mergeCodexConfig, mergeMcpJson, parseAgentTokens } from "./agent";

const S = "https://sync.example";
const T = "bga_x.y";

describe(".mcp.json の併合", () => {
  it("無ければ boxglow だけの設定を作る", () => {
    const j = JSON.parse(mergeMcpJson(null, S, T));
    expect(j).toEqual({ mcpServers: { boxglow: { type: "http", url: "https://sync.example/mcp", headers: { Authorization: "Bearer bga_x.y" } } } });
  });
  it("ほかのサーバーと既存の boxglow (stdio) があれば、boxglow だけ置き換えて残りは残す", () => {
    const before = JSON.stringify({ mcpServers: { other: { command: "x" }, boxglow: { command: "npx", args: ["-y", "boxglow", "mcp"] } }, extra: 1 });
    const j = JSON.parse(mergeMcpJson(before, S, T));
    expect(j.extra).toBe(1);
    expect(j.mcpServers.other).toEqual({ command: "x" });
    expect(j.mcpServers.boxglow.type).toBe("http");
  });
  it("オブジェクトでなければ例外", () => {
    expect(() => mergeMcpJson("[]", S, T)).toThrow();
    expect(() => mergeMcpJson("{\"mcpServers\": 1}", S, T)).toThrow();
  });
});

describe("Codex の config.toml の併合", () => {
  it("無ければ表を書く。あれば末尾に空行を挟んで足す", () => {
    expect(mergeCodexConfig(null, S, T)).toBe(`[mcp_servers.boxglow]\nurl = "https://sync.example/mcp"\nhttp_headers = { Authorization = "Bearer bga_x.y" }\n`);
    const out = mergeCodexConfig("model = \"x\"\n", S, T);
    expect(out).toBe(`model = "x"\n\n[mcp_servers.boxglow]\nurl = "https://sync.example/mcp"\nhttp_headers = { Authorization = "Bearer bga_x.y" }\n`);
  });
  it("既にある boxglow の表だけを差し替え、前後の表は残す", () => {
    const before = `model = "x"\n\n[mcp_servers.boxglow]\nurl = "https://old/mcp"\nhttp_headers = { Authorization = "Bearer old" }\n\n[mcp_servers.other]\ncommand = "y"\n`;
    const out = mergeCodexConfig(before, S, T);
    expect(out).toContain(`url = "https://sync.example/mcp"`);
    expect(out).not.toContain("old");
    expect(out).toContain(`[mcp_servers.other]\ncommand = "y"`);
    expect(out.startsWith(`model = "x"`)).toBe(true);
  });
});

describe(".gitignore", () => {
  it("無ければ足し、あれば触らない", () => {
    expect(gitignoreWithMcpJson("node_modules\n")).toBe("node_modules\n# Claude Code の MCP 設定 (Boxglow のトークンを含む)\n.mcp.json\n");
    expect(gitignoreWithMcpJson("")).toBe("# Claude Code の MCP 設定 (Boxglow のトークンを含む)\n.mcp.json\n");
    expect(gitignoreWithMcpJson("a\n.mcp.json\n")).toBeNull();
    expect(gitignoreWithMcpJson("/.mcp.json")).toBeNull();
  });
});

describe("一覧の検証", () => {
  it("形が違えば例外", () => { expect(() => parseAgentTokens({})).toThrow(); expect(() => parseAgentTokens({ tokens: [{ id: 1 }] })).toThrow(); });
});
