/**
 * サインイン (cli/sync/login.ts) と、資格情報の置き場 (cli/sync/credentials.ts) の試験。
 * 試験用のサーバー (サインインの手順つき) と、実際のファイルを使う。待ち時間は、差し替えた sleep で進める (実際には待たない)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON } from "../../src/model/graph";
import { setLang } from "../../src/i18n/core";
import { syncOnce, SyncAuthError } from "./client";
import { runSyncCommand } from "./command";
import { credentialsPath, CredentialsUnsafe, modeOf, readCredentials, resolveToken, saveCredentials, withCredentialsLock } from "./credentials";
import { runLogin, runLogout, runWhoami, serverProblem } from "./login";
import { TestSyncServer } from "./test-server";

let server: TestSyncServer, root: string, lines: string[];
const out = (text: string) => { lines.push(text); };
beforeEach(async () => {
  server = new TestSyncServer(); await server.start();
  root = mkdtempSync(join(tmpdir(), "boxglow-login-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  delete process.env.BOXGLOW_TOKEN;
  setLang("ja"); lines = [];
});
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; delete process.env.BOXGLOW_TOKEN; rmSync(root, { recursive: true, force: true }); });

/**
 * サインインする。onPoll = 引き換えを試す前に呼ぶ (n 回目。ここで、サーバーの側の状態を「許可された」などに変える)
 */
function login(onPoll: (n: number, code: string) => void, name = "test-pc") {
  let polls = 0;
  return runLogin({ server: server.url, out, deviceName: name, sleep: async () => { polls++; onPoll(polls, [...server.deviceCodes.keys()].at(-1)!); } });
}
const approve = (user: { account: string; login: string }, at = 1) => (n: number, code: string) => { if (n === at) server.deviceCodes.set(code, user); };
const ALICE = { account: "acc-alice", login: "alice" }, BOB = { account: "acc-bob", login: "bob" };

describe("boxglow login", () => {
  it("コードを表示し、許可されるまで待って、資格情報を保存する (本人だけが読める)。トークンは表示しない", async () => {
    expect(await login(approve(ALICE, 3))).toBe(0);
    const saved = readCredentials(server.url)!;
    expect(saved).toMatchObject({ server: server.url, account: "acc-alice", login: "alice", token: "tok-acc-alice-1" });
    expect(modeOf(credentialsPath(server.url))).toBe(0o600);
    expect(modeOf(dirname(credentialsPath(server.url)))).toBe(0o700);
    const shown = lines.join("\n");
    expect(shown).toContain("TEST-1");
    expect(shown).toContain("https://github.com/login/device");
    expect(shown).toContain("alice");
    expect(shown).not.toContain(saved.token);
    // 控え・一時ファイルは残っていない
    expect(readdirSync(dirname(credentialsPath(server.url))).filter((f) => f.includes(".tmp") || f.includes(".prev-"))).toEqual([]);
  });

  it("間隔を延ばす指示 (slow_down) と、まだ (pending) を挟んでも、許可されれば進む。拒否・招待なしは、保存せずに終わる", async () => {
    expect(await login((n, code) => { server.deviceCodes.set(code, n === 1 ? "slow_down" : n === 2 ? "pending" : ALICE); })).toBe(0);
    await runLogout({ server: server.url, out });
    expect(await login((_n, code) => server.deviceCodes.set(code, "denied"))).toBe(1);
    expect(await login((_n, code) => server.deviceCodes.set(code, "not-invited"))).toBe(1);
    expect(lines.join("\n")).toContain("https://example.test/waitlist");
    expect(readCredentials(server.url)).toBeNull();
    expect(server.issued.size).toBe(1);                                   // 拒否・招待なしでは、トークンは発行されていない
  });

  it("同じ利用者のサインインし直しは、置き換える。保存に成功してから、古いトークンを取り消す", async () => {
    expect(await login(approve(ALICE))).toBe(0);
    expect(await login(approve(ALICE))).toBe(0);
    expect(readCredentials(server.url)!.token).toBe("tok-acc-alice-2");
    expect([...server.revoked]).toEqual(["tok-acc-alice-1"]);
  });

  it("別の利用者でのサインインは、黙って置き換えない。今回のトークンは取り消し、今までの資格情報は残る", async () => {
    expect(await login(approve(ALICE))).toBe(0);
    expect(await login(approve(BOB))).toBe(1);
    expect(readCredentials(server.url)).toMatchObject({ account: "acc-alice", token: "tok-acc-alice-1" });
    expect([...server.revoked]).toEqual(["tok-acc-bob-2"]);
    expect(lines.join("\n")).toContain("boxglow logout");
  });

  it("置き場が本人だけのものでなければ、秘密を書かない。今回のトークンは取り消す", async () => {
    const folder = dirname(credentialsPath(server.url));
    mkdirSync(folder, { recursive: true }); chmodSync(folder, 0o755);
    expect(await login(approve(ALICE))).toBe(1);
    expect(existsSync(credentialsPath(server.url))).toBe(false);
    expect(readdirSync(folder).filter((f) => f.endsWith(".json") || f.includes(".tmp"))).toEqual([]);
    expect(server.issued.size).toBe(0);                                   // 置き場を確かめてから始めるので、発行もしていない
    expect(lines.join("\n")).toContain("BOXGLOW_TOKEN");
  });

  it("https でないサーバー (手元の localhost 以外) には、サインインしない", async () => {
    expect(serverProblem("https://sync.example.com")).toBeNull();
    expect(serverProblem("http://127.0.0.1:8787")).toBeNull();
    expect(serverProblem("http://sync.example.com")).not.toBeNull();
    expect(await runLogin({ server: "http://sync.example.com", out, sleep: async () => {} })).toBe(1);
  });

  it("ほかの login が動いている間は、待たずに終わる", async () => {
    await withCredentialsLock(server.url, async () => {
      expect(await login(approve(ALICE))).toBe(1);
    });
    expect(server.issued.size).toBe(0);
    expect(await login(approve(ALICE))).toBe(0);
  });
});

describe("資格情報の置き場", () => {
  const cred = (token: string, account = "acc-alice") => ({ server: server.url, account, login: "alice", token, createdAt: "2026-10-04T00:00:00.000Z" });

  it("置き場のフォルダが、後からほかの利用者に見える権限になっていたら、保存を始めない。今までの資格情報は残る", async () => {
    await withCredentialsLock(server.url, async () => { saveCredentials(cred("old-token")); });
    const path = credentialsPath(server.url);
    chmodSync(dirname(path), 0o750);
    await withCredentialsLock(server.url, async () => { throw new Error("unreachable"); }).catch((e) => expect(e).toBeInstanceOf(CredentialsUnsafe));
    chmodSync(dirname(path), 0o700);
    expect(readCredentials(server.url)!.token).toBe("old-token");
  });

  it("ほかの利用者から読める置き場・リンクの置き場・別のサーバーの資格情報は、読まない (トークンを送らない)", async () => {
    await withCredentialsLock(server.url, async () => { saveCredentials(cred("secret-token")); });
    const path = credentialsPath(server.url);
    chmodSync(path, 0o644);
    expect(readCredentials(server.url)).toBeNull();
    chmodSync(path, 0o600);
    expect(readCredentials(server.url)!.token).toBe("secret-token");
    // 別のサーバーの置き場に、このサーバー向けでない中身が置かれていても、使わない
    const other = "https://other.example.com";
    writeFileSync(credentialsPath(other), readFileSync(path, "utf8"), { mode: 0o600 });
    expect(readCredentials(other)).toBeNull();
    // リンクは追わない
    rmSync(credentialsPath(other));
    symlinkSync(path, credentialsPath(other));
    expect(readCredentials(other)).toBeNull();
  });

  it("トークンは、環境変数 BOXGLOW_TOKEN が保存済みのサインインより優先", async () => {
    expect(resolveToken(server.url)).toBeNull();
    await withCredentialsLock(server.url, async () => { saveCredentials(cred("saved")); });
    expect(resolveToken(server.url)).toMatchObject({ token: "saved", source: "file" });
    process.env.BOXGLOW_TOKEN = "from-env";
    expect(resolveToken(server.url)).toEqual({ token: "from-env", source: "env" });
  });
});

describe("logout / whoami / 同期での利用", () => {
  /** 計画のファイルを 1 つ作る */
  function plan(): string {
    let p = createProject("サインインの試験");
    p = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }).project;
    mkdirSync(join(root, "plan"), { recursive: true });
    const file = join(root, "plan", "boxglow.json");
    writeFileSync(file, toJSON(fromJSON(toJSON(p))) + "\n");
    return file;
  }

  it("サインインすると、boxglow sync は保存済みのトークンで同期する。結び付けの利用者は、サーバーが確かめた利用者", async () => {
    await login(approve(ALICE));
    const file = plan();
    expect(await runSyncCommand({ file, server: server.url, project: "p1" }, out)).toBe(0);
    expect(server.project("p1", "acc-alice")?.head).toBeTruthy();
  });

  it("logout: サーバー側で取り消してから、手元を消す。その後の同期は、サインインの案内を出す", async () => {
    await login(approve(ALICE));
    const file = plan();
    await runSyncCommand({ file, server: server.url, project: "p1" }, out);
    expect(await runLogout({ server: server.url, out })).toBe(0);
    expect(readCredentials(server.url)).toBeNull();
    expect([...server.revoked]).toEqual(["tok-acc-alice-1"]);
    // サインインしていない状態の同期: 試験用のサーバーは、トークン無しを別の利用者 ("test") として扱うので、結び付けの利用者と合わずに止まる
    lines = [];
    expect(await runSyncCommand({ file }, out)).toBe(2);
    expect(await runLogout({ server: server.url, out })).toBe(0);         // もう一度実行しても、失敗しない
  });

  it("logout: 通信できないときは、手元だけを消したと表示する (「取り消した」とは表示しない)。環境変数は取り消さないと表示する", async () => {
    await login(approve(ALICE));
    process.env.BOXGLOW_TOKEN = "from-env";
    lines = [];
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await runLogout({ server: server.url, out, fetch: down })).toBe(0);
    expect(readCredentials(server.url)).toBeNull();
    expect(server.revoked.size).toBe(0);
    const shown = lines.join("\n");
    expect(shown).toContain("取り消せていません");
    expect(shown).not.toContain("サインアウトしました");
    expect(shown).toContain("BOXGLOW_TOKEN");
  });

  it("取り消されたトークンでの同期は、使ったトークンの出どころに合わせて、直し方を案内する", async () => {
    await login(approve(ALICE));
    const file = plan();
    await runSyncCommand({ file, server: server.url, project: "p1" }, out);
    server.revoked.add("tok-acc-alice-1");
    await expect(syncOnce({ file, server: server.url, token: "tok-acc-alice-1" })).rejects.toBeInstanceOf(SyncAuthError);
    lines = [];
    expect(await runSyncCommand({ file }, out)).toBe(1);
    expect(lines.join("\n")).toContain("boxglow login");
    // 環境変数のトークンが無効な場合は、環境変数を直すように案内する (login をやり直しても直らない)
    process.env.BOXGLOW_TOKEN = "tok-acc-alice-1";
    lines = [];
    expect(await runSyncCommand({ file }, out)).toBe(1);
    expect(lines.join("\n")).toContain("BOXGLOW_TOKEN");
    expect(lines.join("\n")).not.toContain("boxglow login をやり直して");
  });

  it("whoami: 利用者・トークンの出どころ・計画の数・保存量を出す。サインインしていなければ案内する", async () => {
    expect(await runWhoami({ server: server.url, out })).toBe(1);
    await login(approve(ALICE));
    lines = [];
    expect(await runWhoami({ server: server.url, out })).toBe(0);
    const shown = lines.join("\n");
    expect(shown).toContain("alice (acc-alice)");
    expect(shown).toContain("1.5 MB / 200.0 MB");
    expect(shown).not.toContain("tok-acc-alice-1");
  });
});
