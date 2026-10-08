/** 製品URLの別表記・専用送り先・後方互換を通信せず検査する。 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_SYNC_SERVER, environmentTokenAllowed, isDefaultSyncServer } from "./server-policy";
import { resolveToken, saveCredentials } from "./credentials";
import { runLogout } from "./login";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "boxglow-token-policy-")); process.env.BOXGLOW_CONFIG_DIR = root; process.env.BOXGLOW_TOKEN = "foreign-test-token"; delete process.env.BOXGLOW_TOKEN_SERVER; });
afterEach(() => { delete process.env.BOXGLOW_TOKEN; delete process.env.BOXGLOW_TOKEN_SERVER; delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });
it.each([DEFAULT_SYNC_SERVER, DEFAULT_SYNC_SERVER + "/", DEFAULT_SYNC_SERVER + ".", "HTTPS://BOXGLOW-SYNC.SUKIMA945.WORKERS.DEV:443/", DEFAULT_SYNC_SERVER + "/other", DEFAULT_SYNC_SERVER + "?q=1"])("製品URL %s は未指定トークンを使わない", server => {
  expect(isDefaultSyncServer(server)).toBe(true);
  expect(environmentTokenAllowed(server)).toBe(false);
  expect(resolveToken(server)?.source).not.toBe("env");
});
it("送り先が一致する専用指定だけで製品サーバーに環境トークンを使える", () => {
  saveCredentials({ server: DEFAULT_SYNC_SERVER, account: "stored", login: "stored", token: "saved-token", createdAt: new Date().toISOString() });
  expect(resolveToken(DEFAULT_SYNC_SERVER)?.source).toBe("file");
  process.env.BOXGLOW_TOKEN_SERVER = "HTTPS://BOXGLOW-SYNC.SUKIMA945.WORKERS.DEV:443/";
  expect(resolveToken(DEFAULT_SYNC_SERVER)?.source).toBe("env");
  for (const scope of ["", "off", "invalid", "https://other.example", DEFAULT_SYNC_SERVER + "/other", DEFAULT_SYNC_SERVER + "?q=1"]) {
    process.env.BOXGLOW_TOKEN_SERVER = scope;
    expect(resolveToken(DEFAULT_SYNC_SERVER)?.source).toBe("file");
  }
});
it("独自サーバーは未指定なら従来互換、専用指定があれば一致を要求する", () => {
  const server = "http://localhost:7777";
  expect(resolveToken(server)?.source).toBe("env");
  process.env.BOXGLOW_TOKEN_SERVER = DEFAULT_SYNC_SERVER;
  expect(resolveToken(server)).toBeNull();
  process.env.BOXGLOW_TOKEN_SERVER = "http://LOCALHOST:7777/";
  expect(resolveToken(server)?.source).toBe("env");
});
it("logoutは実際に使える環境トークンだけ継続使用を案内する", async () => {
  for (const [server, scope, continues] of [[DEFAULT_SYNC_SERVER, undefined, false], [DEFAULT_SYNC_SERVER, DEFAULT_SYNC_SERVER, true], ["http://localhost:7777", undefined, true]] as const) {
    if (scope) process.env.BOXGLOW_TOKEN_SERVER = scope; else delete process.env.BOXGLOW_TOKEN_SERVER;
    const lines: string[] = [];
    await runLogout({ server, out: line => lines.push(line), fetch: async () => { throw new Error("No request expected"); } });
    expect(lines.join("\n").includes("引き続きそのトークンが使われます")).toBe(continues);
  }
});
