/**
 * AI エージェントの接続 (src/sync/agent.ts) の試験: 設定ファイルの併合と .gitignore
 */
import { describe, expect, it } from "vitest";
import { gitignoreWithMcpJson, mergeMcpJson, parseAgentTokens } from "./agent";
import { mergeCodexConfig } from "./codex-config";
import { parse as parseToml } from "smol-toml";

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
  it("コメントの中の 3 つ引用符や # を含む文字列に惑わされず、別の表を消さない (Codex レビュー 29c R29c-01)", () => {
    const q3 = '"""';
    const before = `[mcp_servers.boxglow]\nurl = "https://old.invalid/mcp"\n# example delimiter: ${q3}\n[mcp_servers.other]\ncommand = "must-keep"\n# end example: ${q3}\n[projects."/work"]\ntrust_level = "trusted"\n`;
    const out = mergeCodexConfig(before, S, T);
    expect(out).toContain(`[mcp_servers.other]\ncommand = "must-keep"`);
    expect(out).toContain(`[projects."/work"]\ntrust_level = "trusted"`);
    expect(out).not.toContain("old.invalid");
    expect(out.match(/^\[mcp_servers\.boxglow\]/gm)?.length).toBe(1);
    // 文字列の中の # と、値の後ろのコメントに区切りがある形
    const tricky = `[mcp_servers.boxglow]\nurl = "https://old.invalid/mcp" # ${q3} not a string\nnote = "has # hash and [mcp_servers.fake] inside"\n[mcp_servers.other]\ncommand = "keep"\n`;
    const out2 = mergeCodexConfig(tricky, S, T);
    expect(out2).toContain(`[mcp_servers.other]\ncommand = "keep"`);
    expect(out2).not.toContain("old.invalid"); expect(out2).not.toContain("fake");
    // エスケープした引用符を含む基本文字列の後ろの見出しも、正しく表として読む
    const esc = `[mcp_servers.boxglow]\nurl = "https://old.invalid/mcp"\nlabel = "say \\"hi\\" # not comment"\n[mcp_servers.other]\ncommand = "keep"\n`;
    expect(mergeCodexConfig(esc, S, T)).toContain(`[mcp_servers.other]\ncommand = "keep"`);
  });
  it("引用符付きのキー (\"mcp_servers\" = ... / 'mcp_servers' / [mcp_servers] の \"boxglow\" / \"mcp_servers\".boxglow.url) も拒む (Codex レビュー 29d R29d-01)", () => {
    expect(() => mergeCodexConfig(`"mcp_servers" = { boxglow = { url = "https://old.invalid/mcp" } }\n`, S, T)).toThrow(/top level/);
    expect(() => mergeCodexConfig(`'mcp_servers' = { boxglow = { url = "https://old.invalid/mcp" } }\n`, S, T)).toThrow(/top level/);
    expect(() => mergeCodexConfig(`[mcp_servers]\n"boxglow" = { url = "https://old.invalid/mcp" }\n`, S, T)).toThrow(/inline/);
    expect(() => mergeCodexConfig(`"mcp_servers".boxglow.url = "https://old.invalid/mcp"\n`, S, T)).toThrow(/top level/);
  });
  it("引用符の中に ] や . を含む見出し ([projects.\"/work/[demo]\"]) を表として読み、消さない (Codex レビュー 29d R29d-02)", () => {
    const before = `[mcp_servers.boxglow]\nurl = "https://old.invalid/mcp"\n\n[projects."/work/[demo]"]\ntrust_level = "trusted"\n\n[projects."a.b"]\ntrust_level = "untrusted"\n`;
    const out = mergeCodexConfig(before, S, T);
    expect(out).toContain(`[projects."/work/[demo]"]\ntrust_level = "trusted"`);
    expect(out).toContain(`[projects."a.b"]\ntrust_level = "untrusted"`);
    expect(out).not.toContain("old.invalid");
    const doc = parseToml(out) as { projects: Record<string, { trust_level: string }>; mcp_servers: { boxglow: { url: string } } };
    expect(doc.projects["/work/[demo]"].trust_level).toBe("trusted");
    expect(doc.mcp_servers.boxglow.url).toBe("https://sync.example/mcp");
  });
  it("成功した結果は TOML として読め、Boxglow 以外の値は前後で同じ (独立したパーサーで確認)", () => {
    const before = `model = "x"\n[profiles.a]\nmcp_servers = "x"\n[mcp_servers.other]\ncommand = "y"\nargs = ["[a]", "# b"]\n[mcp_servers.boxglow]\nurl = "https://old.invalid/mcp"\n[projects."/w"]\ntrust_level = "trusted"\n`;
    const out = mergeCodexConfig(before, S, T);
    const strip = (d: Record<string, unknown>) => { const s = { ...(d.mcp_servers as Record<string, unknown>) }; delete s.boxglow; return JSON.stringify({ ...d, mcp_servers: s }); };
    expect(strip(parseToml(out) as Record<string, unknown>)).toBe(strip(parseToml(before) as Record<string, unknown>));
    expect((parseToml(out) as { mcp_servers: { boxglow: { url: string; http_headers: { Authorization: string } } } }).mcp_servers.boxglow).toEqual({ url: "https://sync.example/mcp", http_headers: { Authorization: "Bearer bga_x.y" } });
    // 読めない設定は書き戻さない
    expect(() => mergeCodexConfig(`model = \n`, S, T)).toThrow(/parsed/);
  });
  it("同じ表が 2 つある / [mcp_servers] の中にインラインで書いてあるときは、書き戻さずに例外", () => {
    expect(() => mergeCodexConfig(`[mcp_servers.boxglow]\nurl = "a"\n[mcp_servers.boxglow]\nurl = "b"\n`, S, T)).toThrow(/more than once|parsed/);
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
