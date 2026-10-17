/**
 * 本物の DPAPI (Windows PowerShell) を使った保存の経路の試験 (B187)
 *   WSL からでも Windows の powershell.exe を呼べるので、ここで本物の暗号化 / 復号と、Windows としての保存・読み出しを通す。
 *   powershell.exe が無い環境 (Linux だけ・CI) では飛ばす
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dpapi, dpapiAvailable, setDpapi } from "./dpapi";
import { credentialsPath, inspectCredentials, readCredentials, saveCredentials, withCredentialsLock } from "./credentials";
import { SyncHost } from "./host";

const hasPowerShell = (() => { try { execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { stdio: "ignore", timeout: 15_000 }); return true; } catch { return false; } })();
const realPlatform = process.platform;
let root: string;
const SERVER = "https://sync.example.test";

describe.skipIf(!hasPowerShell)("Windows の DPAPI (本物の PowerShell)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "boxglow-dpapi-"));
    process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    setDpapi(null);
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
    delete process.env.BOXGLOW_CONFIG_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("暗号化 → 復号が往復し、暗号文は平文を含まない (日本語・絵文字も)", () => {
    const text = "bgl_acc0123.secret 日本語 🎉";
    const sealed = dpapi.protect(text);
    expect(sealed).not.toContain("bgl_");
    expect(sealed.length).toBeGreaterThan(40);
    expect(dpapi.unprotect(sealed)).toBe(text);
    expect(dpapiAvailable("win32")).toBe(true);
  });

  it("Windows として保存すると、ファイルに平文のトークンが無く、読み出しは復号して返す。ホストの support は ok", async () => {
    await withCredentialsLock(SERVER, async () => { saveCredentials({ server: SERVER, account: "acc1", login: "alice", token: "bgl_real_secret", createdAt: "2026-10-18T00:00:00.000Z" }); });
    const raw = readFileSync(credentialsPath(SERVER), "utf8");
    expect(raw).not.toContain("bgl_real_secret");
    expect(JSON.parse(raw).dpapi).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(readCredentials(SERVER)).toMatchObject({ token: "bgl_real_secret", login: "alice" });
    expect(inspectCredentials(SERVER).kind).toBe("valid");
    const host = new SyncHost({ server: SERVER, onStatus: () => {} });
    expect(host.support).toBe("ok");
    await host.stop();
  });
});
