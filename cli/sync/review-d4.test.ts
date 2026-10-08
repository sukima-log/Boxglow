/** D4: 不安全なURLへの送信拒否と、Windowsで使える設定案内を検査する。通信は試験用のみ。 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOnce, fetchHeads } from "./client";
import { DEFAULT_SYNC_SERVER, isDefaultSyncServer, environmentTokenAllowed, serverProblem } from "./server-policy";
import { runLogin, runGoogleLogin, runWhoami } from "./login";
import { SyncWatcher, type WatchEvent } from "./watch";
import { TestSyncServer } from "./test-server";
import { bindingDir } from "./state-store";
import { createProject, toJSON } from "../../src/model/graph";
import { setLang } from "../../src/i18n/core";
let root: string;
const originalEnv = { ...process.env };
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boxglow-d4-")); process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  delete process.env.BOXGLOW_TOKEN; delete process.env.BOXGLOW_TOKEN_SERVER; setLang("ja");
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  for (const key of ["BOXGLOW_CONFIG_DIR", "BOXGLOW_TOKEN", "BOXGLOW_TOKEN_SERVER"]) {
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
  }
  rmSync(root, { recursive: true, force: true });
});
it.each(["http://boxglow-sync.sukima945.workers.dev", "http://BOXGLOW-SYNC.SUKIMA945.WORKERS.DEV:443/", "https://boxglow-sync.sukima945.workers.dev../", "https://boxglow-sync.sukima945.workers.dev.../"])("製品の別表記 %s は未指定の環境トークンを使わない", server => {
  expect(isDefaultSyncServer(server)).toBe(true); expect(environmentTokenAllowed(server)).toBe(false);
});
it.each(["http://boxglow-sync.sukima945.workers.dev", "http://custom.example", "http://192.168.1.10", "ftp://custom.example", "not-a-url"])("同期と一覧は通信より前に拒否: %s", async server => {
  const request = vi.fn<typeof fetch>();
  await expect(syncOnce({ server, file: join(root, "missing.json"), token: "test-token", fetch: request })).rejects.toThrow();
  await expect(fetchHeads({ server, token: "test-token", fetch: request })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
it("HTTPは専用トークン先が一致しても拒否、ローカル試験URLは維持", () => {
  const server = "http://custom.example";
  process.env.BOXGLOW_TOKEN_SERVER = server; expect(environmentTokenAllowed(server)).toBe(false);
  for (const url of ["http://localhost:7777", "http://127.0.0.1:7777", "http://[::1]:7777", "https://custom.example"]) expect(serverProblem(url)).toBeNull();
});
it("既存の非localhost HTTP bindingもwatchが通信せず止める", async () => {
  const local = new TestSyncServer(); await local.start();
  try {
    const file = join(root, "plan.json"); writeFileSync(file, toJSON(createProject("watch")));
    await syncOnce({ server: local.url, file });
    const path = join(bindingDir(file, local.url), "state.json");
    const state = JSON.parse(readFileSync(path, "utf8")); state.binding.server = "http://custom.example"; writeFileSync(path, JSON.stringify(state));
    const request = vi.fn<typeof fetch>(), events: WatchEvent[] = [];
    const watch = new SyncWatcher({ server: state.binding.server, token: "test-token", fetch: request, onEvent: event => events.push(event) });
    await watch.tick();
    expect(request).not.toHaveBeenCalled();
    expect(events.some(e => e.kind === "network" && e.message.includes("https"))).toBe(true);
  } finally { await local.stop(); }
});
it.each(["ja", "en"] as const)("Windowsのlogin/google/whoamiは専用送り先も案内 (%s)", async lang => {
  setLang(lang); Object.defineProperty(process, "platform", { value: "win32" });
  const request = vi.fn<typeof fetch>();
  for (const action of [runLogin, runGoogleLogin, runWhoami]) {
    const lines: string[] = [];
    expect(await action({ server: DEFAULT_SYNC_SERVER, out: line => lines.push(line), fetch: request })).toBe(1);
    expect(lines.join("\n")).toContain("BOXGLOW_TOKEN_SERVER=" + DEFAULT_SYNC_SERVER);
  }
  expect(request).not.toHaveBeenCalled();
  process.env.BOXGLOW_TOKEN = "test-token"; process.env.BOXGLOW_TOKEN_SERVER = DEFAULT_SYNC_SERVER;
  const whoami = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ login: "test", account: "test" })));
  expect(await runWhoami({ server: DEFAULT_SYNC_SERVER, out: () => {}, fetch: whoami })).toBe(0);
  expect(whoami.mock.calls[0][1]?.headers).toMatchObject({ authorization: "Bearer test-token" });
});

it("同期と一覧はリダイレクトをたどらず認証情報を別のURLへ送らない", async () => {
  let forwarded = 0;
  const destination = createServer((_req, res) => { forwarded++; res.end("{}"); });
  await new Promise<void>(r => destination.listen(0, "127.0.0.1", r));
  const port = (destination.address() as { port: number }).port;
  const redirect = createServer((_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${port}/elsewhere` }); res.end(); });
  await new Promise<void>(r => redirect.listen(0, "127.0.0.1", r));
  try {
    const server = `http://127.0.0.1:${(redirect.address() as { port: number }).port}`;
    const file = join(root, "redirect.json"); writeFileSync(file, toJSON(createProject("redirect")));
    await expect(fetchHeads({ server, token: "test-token" })).rejects.toThrow();
    await expect(syncOnce({ server, file, token: "test-token" })).rejects.toThrow();
    expect(forwarded).toBe(0);
  } finally {
    await Promise.all([new Promise<void>(r => redirect.close(() => r())), new Promise<void>(r => destination.close(() => r()))]);
  }
});
