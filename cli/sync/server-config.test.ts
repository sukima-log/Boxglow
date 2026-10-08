/** 既定値・明示無効・結び付け・有効化の記憶。通信先はlocalhostだけ。 */
import { beforeEach, afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SYNC_SERVER, selectSyncServer, syncServerFor, syncWasEnabled, rememberSync } from "./server-config";
import { syncOnce } from "./client";
import { TestSyncServer } from "./test-server";
import { createProject, toJSON } from "../../src/model/graph";
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "boxglow-server-config-")); process.env.BOXGLOW_CONFIG_DIR = join(root, "config"); delete process.env.BOXGLOW_SERVER; });
afterEach(() => { delete process.env.BOXGLOW_CONFIG_DIR; delete process.env.BOXGLOW_SERVER; rmSync(root, { recursive: true, force: true }); });
it("未指定だけ製品既定。明示設定は環境変数より優先し、空/off/nullは無効", () => {
  expect(syncServerFor()).toBe(DEFAULT_SYNC_SERVER);
  process.env.BOXGLOW_SERVER = "http://localhost:7777";
  expect(syncServerFor()).toBe("http://localhost:7777");
  for (const value of ["", "off", null])
    expect(syncServerFor(undefined, value)).toBeNull();
  expect(syncServerFor(undefined, "http://localhost:8888/")).toBe("http://localhost:8888");
});
it("通常起動は既存の結び付けを優先。有効と無効と未指定を区別して保存", async () => {
  const file = join(root, "boxglow.json");
  writeFileSync(file, toJSON(createProject("test")));
  const server = new TestSyncServer();
  await server.start();
  try {
    await syncOnce({ file, server: server.url, token: "test" });
    process.env.BOXGLOW_SERVER = "";
    expect(selectSyncServer(file)).toMatchObject({ server: server.url, source: "binding", allowEnvironmentToken: true });
    expect(syncWasEnabled(file, server.url)).toBeUndefined();
    rememberSync(file, server.url, true);
    expect(syncWasEnabled(file, server.url)).toBe(true);
    rememberSync(file, server.url, false);
    expect(syncWasEnabled(file, server.url)).toBe(false);
    expect(syncWasEnabled(file, DEFAULT_SYNC_SERVER)).toBeUndefined();
  }
  finally {
    await server.stop();
  }
});

it("空の環境変数は未指定で、選択根拠とトークン許可を維持する", () => {
  process.env.BOXGLOW_SERVER = "";
  expect(selectSyncServer()).toEqual({ server: DEFAULT_SYNC_SERVER, source: "default", allowEnvironmentToken: false });
  expect(selectSyncServer(undefined, DEFAULT_SYNC_SERVER)).toMatchObject({ source: "explicit", allowEnvironmentToken: false });
  process.env.BOXGLOW_SERVER = "off";
  expect(selectSyncServer().server).toBeNull();
});
it("有効化の記憶は本人だけが読める権限で保存する", () => {
  const file = join(root, "boxglow.json");
  rememberSync(file, DEFAULT_SYNC_SERVER, true);
  const dir = join(root, "config", "sync-enabled");
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, readdirSync(dir)[0])).mode & 0o777).toBe(0o600);
});
