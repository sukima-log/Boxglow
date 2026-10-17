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

describe("Codex の config.toml の併合 (見出しの揺れと壊れた形。Codex レビュー 29 R29-01)", () => {
  const T2 = "bga_new.z";
  it("コメント付き・引用符付き・空白付きの見出しも同じ表として置き換え、2 つ目を足さない", () => {
    for (const header of ["[mcp_servers.boxglow] # 接続先", '[mcp_servers."boxglow"]', "[ mcp_servers . 'boxglow' ]  # x"]) {
      const before = `model = "x"\n\n${header}\nurl = "https://old/mcp"\nhttp_headers = { Authorization = "Bearer old" }\n\n[mcp_servers.other]\ncommand = "y"\n`;
      const out = mergeCodexConfig(before, S, T2);
      expect(out.match(/boxglow/g)?.length, header).toBe(1);
      expect(out).not.toContain("old");
      expect(out).toContain(`[mcp_servers.other]\ncommand = "y"`);
    }
  });
  it("もう一度つなぎ直しても表は 1 つのまま (冪等)", () => {
    const once = mergeCodexConfig("model = \"x\"\n", S, T);
    const twice = mergeCodexConfig(once, S, T2);
    expect(twice.match(/\[mcp_servers\.boxglow\]/g)?.length).toBe(1);
    expect(twice).toContain(T2); expect(twice).not.toContain(T);
  });
  it("boxglow の子の表 ([mcp_servers.boxglow.http_headers]) も一緒に置き換える", () => {
    const before = `[mcp_servers.boxglow]\nurl = "https://old/mcp"\n\n[mcp_servers.boxglow.http_headers]\nAuthorization = "Bearer old"\n\n[mcp_servers.other]\ncommand = "y"\n`;
    const out = mergeCodexConfig(before, S, T2);
    expect(out).not.toContain("boxglow.http_headers"); expect(out).not.toContain("old");
    expect(out).toContain(`[mcp_servers.other]\ncommand = "y"`);
  });
  it("複数行の文字列の中に書かれた見出しは表として扱わない (文字列を壊さず、本物の表を 1 つ足す)", () => {
    const q3 = '"""';
    const before = `developer_instructions = ${q3}\nUse this example:\n[mcp_servers.boxglow]\nurl = "https://example.invalid/mcp"\n${q3}\n\n[projects."/work"]\ntrust_level = "trusted"\n`;
    const out = mergeCodexConfig(before, S, T);
    expect(out.startsWith(before.trimEnd())).toBe(true);                    // 元の中身はそのまま
    expect(out.split(q3).length - 1).toBe(2);                               // 文字列は閉じたまま
    expect(out.endsWith(`[mcp_servers.boxglow]\nurl = "https://sync.example/mcp"\nhttp_headers = { Authorization = "Bearer bga_x.y" }\n`)).toBe(true);
    // もう一度つなぎ直しても、文字列の中の例は触らず、本物の表だけ置き換わる
    const again = mergeCodexConfig(out, S, "bga_new.z");
    expect(again.split(q3).length - 1).toBe(2); expect(again).toContain("bga_new.z"); expect(again).not.toContain("bga_x.y");
  });
  it("ルートの値 (mcp_servers = { ... } / mcp_servers.boxglow.url = ...) や、エスケープ付きの見出しは、書き戻さずに例外", () => {
    expect(() => mergeCodexConfig(`mcp_servers = { boxglow = { url = "https://old.invalid/mcp" } }\n`, S, T)).toThrow(/top level/);
    expect(() => mergeCodexConfig(`mcp_servers.boxglow.url = "https://old.invalid/mcp"\n`, S, T)).toThrow(/top level/);
    expect(() => mergeCodexConfig(`[mcp_servers."box\\u0067low"]\nurl = "https://old.invalid/mcp"\n`, S, T)).toThrow(/escaped/);
    // 別の表の中の mcp_servers = ... は、その表のキーなので関係ない
    expect(mergeCodexConfig(`[profiles.a]\nmcp_servers = "x"\n`, S, T)).toContain("[mcp_servers.boxglow]");
  });
  it("同じ表が 2 つある / [mcp_servers] の中にインラインで書いてあるときは、書き戻さずに例外", () => {
    expect(() => mergeCodexConfig(`[mcp_servers.boxglow]\nurl = "a"\n[mcp_servers.boxglow]\nurl = "b"\n`, S, T)).toThrow(/more than once/);
    expect(() => mergeCodexConfig(`[mcp_servers]\nboxglow = { url = "a" }\n`, S, T)).toThrow(/inline/);
    // [mcp_servers] の中でも、別のサーバーのインラインなら足せる
    expect(mergeCodexConfig(`[mcp_servers]\nother = { command = "y" }\n`, S, T)).toContain("[mcp_servers.boxglow]");
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
