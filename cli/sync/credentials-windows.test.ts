/**
 * Windows での資格情報の保存 (B187): DPAPI の偽物と platform の差し替えで、保存 → 読み出し → 置き換え → 削除と、復号できないファイルの扱いを確かめる
 * (本物の DPAPI は Windows でしか動かないので、ここでは可逆な偽物を使う。実機の確認は利用者の Windows で行う)
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDpapi } from "./dpapi";
import { credentialsPath, inspectCredentials, readCredentials, removeCredentials, saveCredentials, withCredentialsLock } from "./credentials";
import { SyncHost } from "./host";

const realPlatform = process.platform;
let root: string;
const SERVER = "https://sync.example.test";
/** 可逆な偽の DPAPI (base64 に印を付けるだけ。別のユーザーの印は復号できない) */
const fake = (user: string) => ({
  protect: (text: string) => user + ":" + Buffer.from(text, "utf8").toString("base64")
, unprotect: (sealed: string) => { if (!sealed.startsWith(user + ":")) throw new Error("not this user"); return Buffer.from(sealed.slice(user.length + 1), "base64").toString("utf8"); }
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "boxglow-win-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  setDpapi(fake("alice"));
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  setDpapi(null);
  delete process.env.BOXGLOW_CONFIG_DIR;
  rmSync(root, { recursive: true, force: true });
});

it("Windows: トークンは DPAPI の暗号文で置き、平文は書かない。読み出しは復号して返す。置き換えと削除もできる", async () => {
  await withCredentialsLock(SERVER, async () => { saveCredentials({ server: SERVER, account: "acc1", login: "alice", token: "bgl_secret_1", createdAt: "2026-10-18T00:00:00.000Z" }); });
  const raw = readFileSync(credentialsPath(SERVER), "utf8");
  expect(raw).not.toContain("bgl_secret_1");
  expect(JSON.parse(raw)).toMatchObject({ server: SERVER, account: "acc1", login: "alice", dpapi: expect.stringMatching(/^alice:/) });
  expect(readCredentials(SERVER)).toMatchObject({ token: "bgl_secret_1", login: "alice" });
  // 置き換え
  await withCredentialsLock(SERVER, async () => { saveCredentials({ server: SERVER, account: "acc1", login: "alice", token: "bgl_secret_2", createdAt: "2026-10-18T00:00:01.000Z" }); });
  expect(readCredentials(SERVER)?.token).toBe("bgl_secret_2");
  // 削除
  await withCredentialsLock(SERVER, async () => { expect(removeCredentials(SERVER)).toBe(true); });
  expect(inspectCredentials(SERVER)).toEqual({ kind: "absent" });
});

it("Windows: 別のユーザー (復号できない) のファイルは使わない。DPAPI が使えない環境では保存しない (ホストの support も unsupported)", async () => {
  await withCredentialsLock(SERVER, async () => { saveCredentials({ server: SERVER, account: "acc1", login: "alice", token: "bgl_secret_1", createdAt: "2026-10-18T00:00:00.000Z" }); });
  setDpapi(fake("bob"));
  const stored = inspectCredentials(SERVER);
  expect(stored.kind).toBe("unusable");
  expect(readCredentials(SERVER)).toBeNull();
  // DPAPI が壊れている
  setDpapi({ protect: () => { throw new Error("no powershell"); }, unprotect: () => { throw new Error("no powershell"); } });
  await expect(withCredentialsLock(SERVER, async () => { saveCredentials({ server: SERVER, account: "acc2", login: "x", token: "t", createdAt: "" }); })).rejects.toThrow();
  const host = new SyncHost({ server: SERVER, onStatus: () => {} });
  expect(host.support).toBe("unsupported-platform");
  await host.stop();
  // 使えるなら ok
  setDpapi(fake("alice"));
  const host2 = new SyncHost({ server: SERVER, onStatus: () => {} });
  expect(host2.support).toBe("ok");
  await host2.stop();
});
