/**
 * サインイン (cli/sync/login.ts) と、資格情報の置き場 (cli/sync/credentials.ts) の試験。
 * 試験用のサーバー (サインインの手順つき) と、実際のファイルを使う。待ち時間は、差し替えた sleep で進める (実際には待たない)
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON } from "../../src/model/graph";
import { setLang } from "../../src/i18n/core";
import { syncOnce, SyncAuthError } from "./client";
import { runSyncCommand } from "./command";
import { credentialsPath, CredentialsSaveFailed, CredentialsUnsafe, inspectCredentials, modeOf, readCredentials, resolveToken, saveCredentials, withCredentialsLock } from "./credentials";
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
    expect(await runSyncCommand({ actor: "human", file, server: server.url, project: "p1" }, out)).toBe(0);
    expect(server.project("p1", "acc-alice")?.head).toBeTruthy();
  });

  it("logout: サーバー側で取り消してから、手元を消す。その後の同期は、サインインの案内を出す", async () => {
    await login(approve(ALICE));
    const file = plan();
    await runSyncCommand({ actor: "human", file, server: server.url, project: "p1" }, out);
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
    await runSyncCommand({ actor: "human", file, server: server.url, project: "p1" }, out);
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

// ---- Codex のレビュー 23 ----
describe("R23-04: 発行の後の保存の失敗 (権限の確認でも、ふつうのファイル操作でも) では、発行済みのトークンの取り消しを試みる", () => {
  it("トークンが発行された後に、ふつうのファイル操作が失敗しても、そのトークンを取り消す。今までの資格情報は残る", async () => {
    expect(await login(approve(ALICE))).toBe(0);
    const path = credentialsPath(server.url);
    const before = readFileSync(path, "utf8");
    lines = [];
    // 引き換えを待っている間に、置き場のフォルダを書き込めなくする (一時ファイルの作成が EACCES で失敗する)
    const code = await login((n, c) => { if (n === 1) { server.deviceCodes.set(c, ALICE); chmodSync(dirname(path), 0o500); } });
    chmodSync(dirname(path), 0o700);
    expect(code).toBe(1);
    expect(server.issued.has("tok-acc-alice-2")).toBe(true);                // 発行はされた
    expect(server.revoked.has("tok-acc-alice-2")).toBe(true);               // …が、取り消した
    expect(server.revoked.has("tok-acc-alice-1")).toBe(false);              // 今までのトークンは、取り消していない
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(lines.join("\n")).toContain("取り消しました");
  });

  it("取り消しの通信も失敗したら、「取り消した」とは表示しない (まだ有効かもしれない、と伝える)", async () => {
    const path = credentialsPath(server.url);
    let polls = 0;
    // サーバーへの DELETE だけを失敗させる
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      if ((args[1] as RequestInit | undefined)?.method === "DELETE") throw new Error("offline");
      return fetch(...args);
    }) as typeof fetch;
    const code = await runLogin({ server: server.url, out, fetch: flaky, sleep: async () => {
      polls++;
      if (polls === 1) { server.deviceCodes.set([...server.deviceCodes.keys()].at(-1)!, ALICE); chmodSync(dirname(path), 0o500); }
    } });
    chmodSync(dirname(path), 0o700);
    expect(code).toBe(1);
    expect(server.revoked.size).toBe(0);
    const shown = lines.join("\n");
    expect(shown).toContain("まだ有効かもしれません");
    expect(shown).not.toContain("取り消しました。");
  });

  it("置いた後の確認で、ほかの利用者から読める権限だと分かったら、今までの資格情報を戻して、失敗として伝える", async () => {
    const cred = (token: string) => ({ server: server.url, account: "acc-alice", login: "alice", token, createdAt: "2026-10-04T00:00:00.000Z" });
    await withCredentialsLock(server.url, async () => { saveCredentials(cred("old-token")); });
    const path = credentialsPath(server.url);
    let failed: unknown = null;
    await withCredentialsLock(server.url, async () => {
      try { saveCredentials(cred("new-token"), { afterPlace: () => chmodSync(path, 0o644) }); } catch (e) { failed = e; }
    });
    expect(failed).toBeInstanceOf(CredentialsSaveFailed);
    expect(failed).toMatchObject({ restored: true, backup: null, unsafe: true });
    expect(readCredentials(server.url)!.token).toBe("old-token");           // 今までのものが、戻っている
    expect(modeOf(path)).toBe(0o600);
    expect(readdirSync(dirname(path)).filter((f) => f.includes(".prev-") || f.includes(".tmp"))).toEqual([]);
    // 今までの資格情報が無い場合は、置いたファイルを消す (権限の不適切なトークンを、置き場に残さない)
    rmSync(path);
    await withCredentialsLock(server.url, async () => {
      try { saveCredentials(cred("first-token"), { afterPlace: () => chmodSync(path, 0o644) }); } catch (e) { failed = e; }
    });
    expect(failed).toMatchObject({ restored: true, unsafe: true });
    expect(existsSync(path)).toBe(false);
  });

  it("保存に成功した後の、控えの片付けの失敗は、失敗として扱わない (保存は成功。新しい資格情報が使え、控えが残る)", async () => {
    const cred = (token: string) => ({ server: server.url, account: "acc-alice", login: "alice", token, createdAt: "2026-10-04T00:00:00.000Z" });
    await withCredentialsLock(server.url, async () => { saveCredentials(cred("old-token")); });
    const path = credentialsPath(server.url), folder = dirname(path);
    const leftovers = () => readdirSync(folder).filter((f) => f.includes(".prev-"));
    let failed: unknown = null;
    await withCredentialsLock(server.url, async () => {
      // 新しいファイルを置いた直後に、フォルダを書き込めなくする: 最後の確認 (読むだけ) は通り、控えの削除だけが失敗する
      try { saveCredentials(cred("new-token"), { afterPlace: () => chmodSync(folder, 0o500) }); } catch (e) { failed = e; }
      // (この後、ロックを外すのにフォルダへ書くので、ここで権限を戻す。控えが残っていることは、戻す前に確かめる)
      expect(leftovers().length).toBe(1);
      chmodSync(folder, 0o700);
    });
    expect(failed).toBeNull();                                              // 保存は成功として返る
    expect(readCredentials(server.url)!.token).toBe("new-token");           // 新しい資格情報が使える
    expect(leftovers().length).toBe(1);                                     // 控えは残っている (片付けの失敗の分岐を通った)
  });
});

describe("R23-05: 資格情報が「無い」と「在るが、安全に読めない」を分ける", () => {
  it("調べた結果は、無い / 使える / 使えない (理由つき) の 3 つ", async () => {
    expect(inspectCredentials(server.url)).toEqual({ kind: "absent" });
    await login(approve(ALICE));
    expect(inspectCredentials(server.url).kind).toBe("valid");
    const path = credentialsPath(server.url);
    chmodSync(path, 0o644);
    expect(inspectCredentials(server.url)).toMatchObject({ kind: "unusable", path });
    chmodSync(path, 0o600);
    writeFileSync(path, "{ not json");
    expect(inspectCredentials(server.url)).toMatchObject({ kind: "unusable" });
  });

  for (const [name, damage] of [
    ["ほかの利用者から読める権限", (path: string) => chmodSync(path, 0o644)]
  , ["JSON として読めない中身", (path: string) => writeFileSync(path, "{ broken")]
  ] as const) {
    it(`保存済みの資格情報が使えない (${name}) とき、別の利用者の login は、黙って置き換えない。発行もしない`, async () => {
      expect(await login(approve(ALICE))).toBe(0);
      const path = credentialsPath(server.url);
      damage(path);
      const before = readFileSync(path, "utf8");
      lines = [];
      expect(await login(approve(BOB))).toBe(1);
      expect(readFileSync(path, "utf8")).toBe(before);                      // 置き換えていない
      expect(server.issued.size).toBe(1);                                   // 手順も始めていない (新しいトークンは発行されていない)
      expect(lines.join("\n")).toContain(path);
    });
  }

  it("logout: 資格情報が使えない・置き場を確かめられないときは、「サインインしていません」とも「サインアウトしました」とも言わず、失敗として終わる", async () => {
    expect(await login(approve(ALICE))).toBe(0);
    const path = credentialsPath(server.url);
    // 置き場のフォルダが、ほかの利用者から見える
    chmodSync(dirname(path), 0o750);
    lines = [];
    expect(await runLogout({ server: server.url, out })).toBe(1);
    expect(existsSync(path)).toBe(true);
    expect(server.revoked.size).toBe(0);
    let shown = lines.join("\n");
    expect(shown).not.toContain("サインインしていません");
    expect(shown).not.toContain("サインアウトしました");
    chmodSync(dirname(path), 0o700);
    // ファイルが、ほかの利用者から読める
    chmodSync(path, 0o644);
    lines = [];
    expect(await runLogout({ server: server.url, out })).toBe(1);
    expect(existsSync(path)).toBe(true);
    shown = lines.join("\n");
    expect(shown).toContain(path);
    expect(shown).not.toContain("サインインしていません");
    // 直せば、サインアウトできる
    chmodSync(path, 0o600);
    expect(await runLogout({ server: server.url, out })).toBe(0);
    expect([...server.revoked]).toEqual(["tok-acc-alice-1"]);
  });
});

// ---- Codex のレビュー 24 ----
describe("R24-01: 壊れた資格情報のファイルの中身を、画面に出さない", () => {
  for (const [name, content] of [["トークンをそのまま貼ったファイル", "FAKE_SECRET_SENTINEL_tok_1234567890"], ["途中で切れた JSON", '{"token": "FAKE_SECRET_SENTINEL_tok_1234567890", "acc']] as const) {
    it(`${name}: login も logout も、中身を表示せず、通信せずに、終了コード 1。ファイルは残る`, async () => {
      const path = credentialsPath(server.url);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600 });
      const reason = inspectCredentials(server.url);
      expect(reason).toMatchObject({ kind: "unusable" });
      expect(JSON.stringify(reason)).not.toContain("FAKE_SECRET_SENTINEL");
      let calls = 0;
      const counting = (async (...args: Parameters<typeof fetch>) => { calls++; return fetch(...args); }) as typeof fetch;
      expect(await runLogin({ server: server.url, out, fetch: counting, sleep: async () => {} })).toBe(1);
      expect(await runLogout({ server: server.url, out, fetch: counting })).toBe(1);
      expect(calls).toBe(0);
      expect(lines.join("\n")).not.toContain("FAKE_SECRET_SENTINEL");
      expect(lines.join("\n")).toContain(path);                             // どのファイルを確かめればよいかは伝える
      expect(readFileSync(path, "utf8")).toBe(content);
    });
  }
});

describe("配布する入口 (bin/boxglow.js) を、サブプロセスで通す", () => {
  /** CLI を実行する。Output: 終了コードと、出力 (標準出力と標準エラー出力の両方。どちらにもトークンが出ないことを確かめるため) */
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ status: number | null; stdout: string }>((done) => {
    const child = spawn(process.execPath, ["bin/boxglow.js", ...args, "--lang", "ja"]
    , { env: { ...process.env, BOXGLOW_CONFIG_DIR: join(root, "cli-config"), BOXGLOW_SERVER: "", BOXGLOW_TOKEN: "", ...env } });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.on("close", (status) => done({ status, stdout }));
  });

  it("login → whoami → sync → logout。トークンは、どの出力にも出ない", async () => {
    // login は、コードを表示して待つ。その間に、サーバーの側で許可する
    const approving = setInterval(() => { for (const [code, state] of server.deviceCodes) if (state === "pending") server.deviceCodes.set(code, ALICE); }, 100);
    const signedIn = await run(["login", "--server", server.url, "--name", "subprocess-test"]);
    clearInterval(approving);
    expect(signedIn.status).toBe(0);
    expect(signedIn.stdout).toContain("TEST-1");
    expect(signedIn.stdout).toContain("alice (acc-alice)");
    const who = await run(["whoami", "--server", server.url]);
    expect([who.status, who.stdout.includes("alice (acc-alice)")]).toEqual([0, true]);
    // 計画を作って、保存したサインインで同期する
    mkdirSync(join(root, "cli-plan"), { recursive: true });
    const file = join(root, "cli-plan", "boxglow.json");
    writeFileSync(file, toJSON(fromJSON(toJSON(createProject("入口の試験")))) + "\n");
    const synced = await run(["sync", "--server", server.url, "--project", "cli-1", "--file", file, "--actor", "human"]);
    expect(synced.status).toBe(0);
    expect(server.project("cli-1", "acc-alice")?.head).toBeTruthy();
    const out1 = await run(["logout", "--server", server.url]);
    expect(out1.status).toBe(0);
    expect([...server.revoked]).toEqual(["tok-acc-alice-1"]);
    expect((await run(["whoami", "--server", server.url])).status).toBe(1);
    for (const text of [signedIn.stdout, who.stdout, synced.stdout, out1.stdout]) expect(text).not.toContain("tok-acc-alice-1");
    // 知らない指定は、実行せずに断る
    expect((await run(["login", "--server", server.url, "--bogus"])).status).toBe(1);
  }, 60_000);
});

