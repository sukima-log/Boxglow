import { afterAll, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addBlock, createProject, defaultTaskParent, portsOf, toJSON } from "../src/model/graph";

let dir: string;
let entry: string;
beforeAll(async () => {
  // Keep the temporary bundle under node_modules so its external SDK imports resolve.
  const cache = resolve("node_modules/.cache"); mkdirSync(cache, { recursive: true });
  dir = mkdtempSync(join(cache, "boxglow-mcp-")); entry = join(dir, "cli.mjs");
  await build({ entryPoints: ["cli/main.ts"], bundle: true, loader: { ".md": "text" }, platform: "node", format: "esm", target: "node18", external: ["@modelcontextprotocol/sdk", "zod"], outfile: entry });
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

it("reports failed validation as an MCP error, recovers, and honors the server actor", async () => {
  let p = createProject("MCP fixture"); p.lang = "en";
  const block = addBlock(p, { parentId: defaultTaskParent(p), title: "Task" }); p = block.project;
  const file = join(dir, "plan.json");
  const valid = toJSON(p);
  for (const port of portsOf(p, block.blockId, "out")) delete p.ports[port.id];
  writeFileSync(file, toJSON(p));
  const client = new Client({ name: "boxglow-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "mcp", "--file", file, "--actor", "codex"], stderr: "pipe" });
  try {
    await client.connect(transport);
    const failed = await client.callTool({ name: "boxglow_validate", arguments: {} });
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("output");
    writeFileSync(file, valid);
    const ok = await client.callTool({ name: "boxglow_validate", arguments: {} });
    expect(ok.isError).not.toBe(true);
    const status = await client.callTool({ name: "boxglow_status", arguments: { brief: true } });
    expect(status.isError).not.toBe(true);
    expect(JSON.stringify(status.content)).toContain("Hierarchy omitted");
    await client.callTool({ name: "boxglow_start", arguments: { block: "Task", note: "MCP test" } });
    expect(JSON.parse(readFileSync(file, "utf8")).blocks[block.blockId].activity.actor).toBe("codex");
    const guarded = JSON.parse(readFileSync(file,"utf8")); guarded.contextGuard = true; writeFileSync(file, JSON.stringify(guarded));
    const missing = await client.callTool({name:"boxglow_start",arguments:{block:"Task"}}); expect(missing.isError).toBe(true);
    const context = await client.callTool({name:"boxglow_context",arguments:{block:"Task"}});
    const receipt = JSON.parse((context.content as {text:string}[])[0].text);
    const started = await client.callTool({name:"boxglow_start",arguments:{block:"Task",contextToken:receipt.contextToken}}); expect(started.isError).not.toBe(true);
    const checkpoint = await client.callTool({name:"boxglow_checkpoint",arguments:{block:"Task",note:"Resume from this note",contextToken:receipt.contextToken}}); expect(checkpoint.isError).not.toBe(true);
    const stale = await client.callTool({name:"boxglow_set",arguments:{block:"Task",title:"Must not apply",contextToken:receipt.contextToken}}); expect(stale.isError).toBe(true);
    expect(JSON.parse(readFileSync(file,"utf8")).blocks[block.blockId].title).toBe("Task");
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "boxglow_status")?.annotations?.readOnlyHint).toBe(true);
  } finally {
    await client.close();
  }
}, 15000);
