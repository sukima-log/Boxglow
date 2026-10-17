/**
 * ホスト型の MCP: 束ねた bundle (dist 相当) を Node で読み、JSON-RPC の要求を通す。ファイルは触らない
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProject, toJSON } from "../src/model/graph";

let dir: string, mod: { handleMcpRequest: (req: Request, plan: { text: string | null; write: boolean; actor?: string }) => Promise<{ response: Response; text: string | null; changed: boolean }> };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "boxglow-hosted-"));
  await build({ entryPoints: ["cli/hosted.ts"], bundle: true, loader: { ".md": "text" }, platform: "node", format: "esm", target: "es2022", logLevel: "silent"
  , alias: { "node:fs": "./cli/shims/node-fs.ts", "node:os": "./cli/shims/node-os.ts", "node:child_process": "./cli/shims/node-child_process.ts", "node:http": "./cli/shims/node-http.ts" }
  , outfile: join(dir, "hosted.mjs") });
  mod = await import(join(dir, "hosted.mjs"));
}, 120_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** JSON-RPC の要求を作る */
const rpc = (body: unknown) => new Request("https://sync.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) });
const call = async (plan: { text: string | null; write: boolean; actor?: string }, name: string, args: Record<string, unknown> = {}, id = 1) => {
  const r = await mod.handleMcpRequest(rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), plan);
  const body = await r.response.json() as { result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
  return { ...r, body };
};

describe("hosted MCP", () => {
  it("initialize と tools/list に答える (状態を持たない転送)", async () => {
    const plan = { text: toJSON(createProject("ホストの計画")) + "\n", write: true };
    const init = await mod.handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }), plan);
    expect(init.response.status).toBe(200);
    expect(((await init.response.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("boxglow");
    const list = await mod.handleMcpRequest(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), plan);
    const names = ((await list.response.json()) as { result: { tools: { name: string }[] } }).result.tools.map((x) => x.name);
    expect(names).toContain("boxglow_status"); expect(names).toContain("boxglow_add");
  });
  it("読む道具は中身を変えない。書く道具は変わった中身を返す。読み取り専用のトークンでは書く道具を断る", async () => {
    const text = toJSON(createProject("ホストの計画")) + "\n";
    const status = await call({ text, write: false }, "boxglow_status", { brief: true });
    expect(status.body.result?.content[0].text).toContain("ホストの計画");
    expect(status.changed).toBe(false);
    const denied = await call({ text, write: false }, "boxglow_add", { title: "箱", out: "成果物" });
    expect(denied.body.result?.isError).toBe(true);
    expect(denied.body.result?.content[0].text).toContain("読み取り専用");
    expect(denied.changed).toBe(false);
    const added = await call({ text, write: true, actor: "agent-1" }, "boxglow_add", { title: "箱", out: "成果物" });
    expect(added.body.result?.isError).toBeFalsy();
    expect(added.changed).toBe(true);
    expect(added.text).toContain("\"箱\"");
    // ホストでは使えないコマンド
    const serve = await call({ text, write: true }, "boxglow_run", { args: ["serve"] });
    expect(serve.body.result?.isError).toBe(true);
  });
});
