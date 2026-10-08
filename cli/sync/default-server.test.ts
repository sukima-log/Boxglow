/** D2: CLIの製品既定URLだけをローカル受信器へ差し替え、実際の起動経路を検証する。 */
import { it, expect } from "vitest";
import { buildSync } from "esbuild";
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProject, toJSON } from "../../src/model/graph";
import { saveCredentials } from "./credentials";
import { startServe } from "../serve";
import { TestSyncServer } from "./test-server";
import { syncOnce } from "./client";
import { DEFAULT_SYNC_SERVER } from "./server-config";

it("既定フォールバックではwhoami/sync/serveに環境トークンを渡さず、serve --syncも入口だけ", async () => {
  const root = mkdtempSync(join(tmpdir(), "boxglow-default-cli-"));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  const received: (string | undefined)[] = [];
  const recorder = createServer((req, res) => { received.push(req.headers.authorization); res.writeHead(401); res.end("{}"); });
  await new Promise<void>(r => recorder.listen(0, "127.0.0.1", r));
  const address = recorder.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  const bundle = buildSync({ entryPoints: [resolve("cli/main.ts")], bundle: true, write: false, platform: "node", format: "esm", loader: { ".md": "text" }, external: ["@modelcontextprotocol/sdk", "zod"] }).outputFiles[0].text;
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "index.html"), "test");
  const cli = join(root, "bin", "boxglow.mjs");
  writeFileSync(cli, bundle.replaceAll(DEFAULT_SYNC_SERVER, url));
  const file = join(root, "boxglow.json");
  writeFileSync(file, toJSON(createProject("default isolation")));
  const config = join(root, "config");
  const env = { ...process.env, BOXGLOW_CONFIG_DIR: config, BOXGLOW_SERVER: "", BOXGLOW_TOKEN: "foreign-test-token", BOXGLOW_ACTOR: "", CODEX_THREAD_ID: "" };
  const run = async (args: string[]) => { try { return (await promisify(execFile)(process.execPath, [cli, ...args, "--file", file], { cwd: root, env })).stdout; } catch (e) { return (e as { stdout: string }).stdout; } };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    expect(await run(["whoami"])).toContain("サインインしていません");
    expect(received).toEqual([]);
    await run(["sync", "--actor", "human"]);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every(value => !value?.includes("foreign-test-token"))).toBe(true);
    const advice = await run(["sync", "--server", ""]);
    expect(advice).toContain("--server " + url);
    expect(advice).toContain("製品既定");
    // 前のsyncが結び付け用の途中状態を作っても、serveは未連携の別ファイルで試す。
    const fresh = join(root, "fresh.json");
    writeFileSync(fresh, toJSON(createProject("fresh")));
    const previousConfig = process.env.BOXGLOW_CONFIG_DIR;
    process.env.BOXGLOW_CONFIG_DIR = config;
    try { saveCredentials({ server: url, account: "stored-account", login: "stored-user", token: "stored-token", createdAt: new Date().toISOString() }); }
    finally { if (previousConfig === undefined) delete process.env.BOXGLOW_CONFIG_DIR; else process.env.BOXGLOW_CONFIG_DIR = previousConfig; }
    const count = received.length;
    child = spawn(process.execPath, [cli, "serve", "--file", fresh, "--port", "0", "--sync"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const childRef = child;
    const origin = await new Promise<string>((ok, fail) => {
      let text = "";
      const timer = setTimeout(() => fail(new Error("serve did not start")), 5000);
      childRef.stdout!.on("data", data => { text += data; const match = text.match(/http:\/\/localhost:\d+/); if (match) { clearTimeout(timer); ok(match[0]); } });
      childRef.once("error", fail);
    });
    const status = await (await fetch(origin + "/api/sync")).json();
    await new Promise(r => setTimeout(r, 1100));
    expect(status.file.enabled).toBe(false);
    expect(status.credentials.source).toBe("stored");
    expect(status.credentials.account.display).toBe("stored-user");
    expect(received.length).toBe(count);
    expect(readdirSync(config, { recursive: true }).map(String).some(p => p.startsWith("sync-enabled"))).toBe(false);
  } finally {
    if (child && child.exitCode === null) { const stopped = new Promise(r => child!.once("exit", r)); child.kill(); await stopped; }
    await new Promise<void>(r => recorder.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

/** 新規保存を人が選んだ後は、同じサインインのまま子画面で同期を再開する。 */
it("既定の入口から別ファイルを開くと、環境トークンを使わずに子画面の同期を再開する", async () => {
  const root = mkdtempSync(join(tmpdir(), "boxglow-child-sync-"));
  const previous = { config: process.env.BOXGLOW_CONFIG_DIR, token: process.env.BOXGLOW_TOKEN };
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  process.env.BOXGLOW_TOKEN = "foreign-token";
  const remote = new TestSyncServer();
  await remote.start();
  const serverFile = join(root, "remote-source.json"), file = join(root, "local.json");
  writeFileSync(serverFile, toJSON(createProject("remote plan")));
  writeFileSync(file, toJSON(createProject("local plan")));
  const dist = join(root, "dist"); mkdirSync(dist); writeFileSync(join(dist, "index.html"), "test");
  let local: ReturnType<typeof startServe> | undefined;
  try {
    remote.issued.set("test", { account: "test", login: "tester" });
    saveCredentials({ server: remote.url, account: "test", login: "tester", token: "test", createdAt: new Date().toISOString() });
    await syncOnce({ file: serverFile, server: remote.url, remoteId: "plan", token: "test" });
    local = startServe({ file, port: 0, dist, open: false, log: () => {}, sync: { server: remote.url, allowEnvironmentToken: false, autoEnable: false, restoreEnabled: false } });
    await new Promise<void>(r => local!.once("listening", r));
    const url = `http://127.0.0.1:${(local.address() as { port: number }).port}`;
    const act = async (action: object) => (await fetch(url + "/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action) })).json();
    const op = (await act({ kind: "beginSync" })).startup;
    await act({ kind: "continueStart", operationId: op.operationId, intent: "existing" });
    const opened = await act({ kind: "openProject", operationId: op.operationId, projectId: "plan", destination: "new", name: "received.json" });
    expect(opened.startup.stage).toBe("opened");
    const child = await (await fetch(new URL("/api/sync", opened.startup.opened.url))).json();
    expect(child.file.enabled).toBe(true);
    expect(child.credentials.source).toBe("stored");
    expect(child.credentials.account.display).toBe("tester");
    expect(child.file.binding.remoteId).toBe("plan");
  } finally {
    if (local) { local.closeAllConnections(); await new Promise<void>(r => local!.close(() => r())); }
    await new Promise(r => setTimeout(r, 30));
    await remote.stop();
    if (previous.config === undefined) delete process.env.BOXGLOW_CONFIG_DIR; else process.env.BOXGLOW_CONFIG_DIR = previous.config;
    if (previous.token === undefined) delete process.env.BOXGLOW_TOKEN; else process.env.BOXGLOW_TOKEN = previous.token;
    rmSync(root, { recursive: true, force: true });
  }
});
