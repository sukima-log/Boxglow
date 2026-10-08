/** D3: 実CLI/MCPとVS Codeアダプターで送り先×入口の表を検査する。製品URLはビルド時にlocalhostへ置換。 */
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createProject, toJSON } from "../../src/model/graph";
import { saveCredentials } from "./credentials";
import { syncOnce } from "./client";
import { DEFAULT_SYNC_SERVER } from "./server-policy";
import { TestSyncServer } from "./test-server";

type Route = "flag" | "environment" | "binding" | "fallback" | "advice";
type Surface = "whoami" | "sync" | "watch" | "serve" | "mcp" | "vscode";
const routes: Route[] = ["flag", "environment", "binding", "fallback", "advice"];
const cliSurfaces: Surface[] = ["whoami", "sync", "watch", "serve"];
const cases: [string, Route, Surface, boolean][] = [];
for (const route of routes) for (const surface of cliSurfaces) cases.push(["product", route, surface, false]);
for (const route of ["environment", "binding", "fallback"] as Route[]) cases.push(["product", route, "mcp", false]);
for (const route of routes.filter(r => r !== "advice")) cases.push(["product", route, "vscode", false]);
for (const route of ["flag", "environment", "binding"] as Route[]) {
  for (const surface of cliSurfaces) cases.push(["custom", route, surface, false]);
  cases.push(["custom", route, "vscode", false]);
  if (route !== "flag") cases.push(["custom", route, "mcp", false]);
}
for (const surface of [...cliSurfaces, "mcp", "vscode"] as Surface[]) cases.push(["product", "binding", surface, true]);
let root: string, cli: string, vscodeBundle: string, product: TestSyncServer, custom: TestSyncServer;
let received: string[] = [], config: string, file: string;
const originalEnv = { ...process.env };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** 試験サーバーが受け取ったAuthorizationだけを、既知の試験値として検査する。 */
async function recorder() {
  const server = new TestSyncServer();
  const target = server as unknown as { handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> };
  const handle = target.handle.bind(server);
  target.handle = (req, res) => { received.push(req.headers.authorization ?? ""); return handle(req, res); };
  server.issued.set("stored-test-token", { account: "test", login: "stored" });
  server.issued.set("environment-test-token", { account: "test", login: "environment" });
  await server.start();
  return server;
}
beforeAll(async () => {
  mkdirSync(resolve("node_modules/.cache"), { recursive: true });
  root = mkdtempSync(resolve("node_modules/.cache/auth-routing-"));
  product = await recorder(); custom = await recorder();
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist", "index.html"), "test");
  const result = await build({ entryPoints: ["cli/main.ts"], bundle: true, write: false, platform: "node", format: "esm", loader: { ".md": "text" }, external: ["@modelcontextprotocol/sdk", "zod"] });
  cli = join(root, "bin", "cli.mjs"); writeFileSync(cli, result.outputFiles[0].text.replaceAll(DEFAULT_SYNC_SERVER, product.url));
  const extension = await build({ entryPoints: ["vscode/src/sync.ts"], bundle: true, write: false, platform: "node", format: "cjs", plugins: [{ name: "vscode-test-api", setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test-api" }));
    b.onLoad({ filter: /.*/, namespace: "test-api" }, () => ({ contents: "const api=globalThis.__d3Vscode; export const workspace=api.workspace, Uri=api.Uri, env=api.env, window=api.window, commands=api.commands;", loader: "js" }));
  } }] });
  vscodeBundle = extension.outputFiles[0].text.replaceAll(DEFAULT_SYNC_SERVER, product.url);
});
afterAll(async () => { await product.stop(); await custom.stop(); rmSync(root, { recursive: true, force: true }); });
beforeEach(() => {
  const dir = mkdtempSync(join(root, "case-")); config = join(dir, "config"); file = join(dir, "boxglow.json");
  process.env.BOXGLOW_CONFIG_DIR = config;
  process.env.BOXGLOW_TOKEN = "environment-test-token";
  for (const key of ["BOXGLOW_SERVER", "BOXGLOW_TOKEN_SERVER", "BOXGLOW_ACTOR", "CODEX_THREAD_ID", "CLAUDECODE"]) delete process.env[key];
  writeFileSync(file, toJSON(createProject("routing")));
});
afterEach(() => { for (const key of ["BOXGLOW_CONFIG_DIR", "BOXGLOW_TOKEN", "BOXGLOW_SERVER", "BOXGLOW_TOKEN_SERVER", "BOXGLOW_ACTOR", "CODEX_THREAD_ID", "CLAUDECODE"]) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } });
/** CLIの出力を受け取り、常駐する場合は開始を確認してから止める。 */
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise(r => child.once("exit", r)); child.kill(); await done;
}
async function run(args: string[]) {
  try { return (await promisify(execFile)(process.execPath, [cli, ...args, "--file", file], { cwd: resolve(file, ".."), env: process.env })).stdout; }
  catch (e) { const result = e as { stdout: string; code: number }; if (![1, 2].includes(result.code)) throw e; return result.stdout; }
}
async function persistent(args: string[], surface: Surface, expectedSource: string) {
  const child = spawn(process.execPath, [cli, ...args, "--file", file], { cwd: resolve(file, ".."), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    const output = await new Promise<string>((ok, fail) => {
      let text = ""; const timer = setTimeout(() => fail(new Error("startup timeout: " + text)), 7000);
      child.stdout!.on("data", d => { text += d; if (surface === "watch" ? text.includes("常時の同期を始めました") : /http:\/\/localhost:\d+/.test(text)) { clearTimeout(timer); ok(text); } });
      child.once("exit", () => { clearTimeout(timer); fail(new Error("early exit: " + text)); });
    });
    if (surface === "serve") {
      const url = output.match(/http:\/\/localhost:\d+/)![0];
      const state = await (await fetch(url + "/api/sync")).json();
      expect(state.credentials.source).toBe(expectedSource);
      await fetch(url + "/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "bind" }) });
    } else await sleep(1100);
  } finally { await stop(child); }
}
it.each(cases)("%s / %s / %s / token scope=%s", async (kind, route, surface, scoped) => {
  const server = kind === "product" ? product : custom;
  saveCredentials({ server: server.url, account: "test", login: "stored", token: "stored-test-token", createdAt: new Date().toISOString() });
  if (route === "binding" || surface === "mcp" && route !== "fallback") await syncOnce({ file, server: server.url, remoteId: "plan-" + config.split("/").at(-2), token: "stored-test-token" });
  if (route === "environment") process.env.BOXGLOW_SERVER = server.url;
  if (scoped) process.env.BOXGLOW_TOKEN_SERVER = server.url + "/";
  const expected = kind === "custom" || scoped ? "environment-test-token" : "stored-test-token";
  let flags = route === "flag" ? ["--server", server.url + "/"] : [];
  received = [];
  if (route === "advice") {
    const advice = await run(["sync"]);
    const line = advice.split("\n").find(l => l.startsWith("boxglow sync "))!;
    expect(line).toContain("--server " + server.url);
    // 表示されたコマンドをシェルで実行せず、引用された引数として読み直す。
    const tokens = line.match(/"(?:[^"\\]|\\.)*"|[^ ]+/g)!.slice(2).map(v => v.startsWith('"') ? JSON.parse(v) : v);
    await run(["sync", ...tokens]);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every(value => value === "Bearer " + expected)).toBe(true);
    received = [];
    flags = ["--server", server.url];
  }
  if (surface === "mcp") {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: resolve(file, ".."), env: process.env as Record<string, string>, stderr: "pipe" });
    const client = new Client({ name: "D3-test", version: "1" });
    try { await client.connect(transport); await client.callTool({ name: "boxglow_sync", arguments: {} }); } finally { await client.close(); }
  } else if (surface === "vscode") {
    let receive!: (message: unknown) => Promise<void>;
    const statuses: any[] = [];
    (globalThis as any).__d3Vscode = { workspace: { getConfiguration: () => ({ inspect: () => ({ globalValue: route === "flag" ? server.url + "/" : undefined }) }) }, Uri: { file: (path: string) => ({ fsPath: path, scheme: "file", toString: () => path }) }, env: { machineId: "test", remoteName: "wsl" }, window: {}, commands: {} };
    const module = { exports: {} as any };
    new Function("require", "module", "exports", vscodeBundle)(createRequire(import.meta.url), module, module.exports);
    const dispose = module.exports.attachSync({ globalState: { get: () => route === "binding", update: async () => {} } }, { uri: (globalThis as any).__d3Vscode.Uri.file(file), isDirty: false, getText: () => "" }, { webview: { onDidReceiveMessage: (f: typeof receive) => { receive = f; return { dispose() {} }; }, postMessage: async (value: unknown) => { statuses.push(value); } } }, { postConflict() {}, postFromDisk() {} });
    try { await receive({ type: "sync-action", action: { kind: "bind" } }); expect(statuses.at(-1).status.credentials.source).toBe(expected === "stored-test-token" ? "stored" : "env"); }
    finally { dispose(); await sleep(20); delete (globalThis as any).__d3Vscode; }
  } else if (surface === "serve") await persistent(["serve", "--sync", "--port", "0", ...flags], surface, expected === "stored-test-token" ? "stored" : "env");
  else if (surface === "watch") await persistent(["sync", "--watch", "--actor", "human", ...flags], surface, "");
  else await run([surface, ...(surface === "sync" ? ["--actor", "human"] : []), ...flags]);
  if (surface === "mcp" && route === "fallback") expect(received).toEqual([]);
  else { expect(received.length).toBeGreaterThan(0); expect(received.every(value => value === "Bearer " + expected), JSON.stringify(received)).toBe(true); }
}, 15000);
