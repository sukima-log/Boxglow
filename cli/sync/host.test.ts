/**
 * 同期の裏方 (cli/sync/host.ts) の試験: 実際のファイル・設定フォルダ・試験用のサーバーを使い、画面の代わりに状態を読む
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../../src/model/graph";
import type { Project } from "../../src/model/types";
import { syncOnce } from "./client";
import { readCredentials, saveCredentials } from "./credentials";
import { SyncHost, type SyncStatus } from "./host";
import { lockWatch } from "./watch";
import { TestSyncServer } from "./test-server";

let server: TestSyncServer;
let root: string;
let clock = 0;
beforeEach(async () => {
  server = new TestSyncServer(); await server.start();
  root = mkdtempSync(join(tmpdir(), "boxglow-host-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  delete process.env.BOXGLOW_TOKEN;
  clock = Date.parse("2026-10-06T12:00:00.000Z");
});
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; delete process.env.BOXGLOW_TOKEN; rmSync(root, { recursive: true, force: true }); });

const planFile = (name: string) => {
  let p = createProject(name);
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  mkdirSync(join(root, name), { recursive: true });
  const file = join(root, name, "boxglow.json");
  writeFileSync(file, toJSON(fromJSON(toJSON(p))) + "\n");
  return { file, a: a.blockId };
};
const read = (file: string): Project => fromJSON(readFileSync(file, "utf8"));
const edit = (file: string, change: (p: Project) => Project) => writeFileSync(file, toJSON(change(read(file))) + "\n");
/** 保存済みのサインイン (試験用サーバーは、発行していないトークンの文字列を利用者の ID として扱う) */
const signedIn = (account = "test") => saveCredentials({ server: server.url, account, login: account, token: account, createdAt: new Date().toISOString() });
/** 裏方を作る。状態の通知は statuses に貯める */
const make = (extra: Partial<ConstructorParameters<typeof SyncHost>[0]> = {}) => {
  const statuses: SyncStatus[] = [];
  const host = new SyncHost({ server: server.url, now: () => clock, elapsed: () => clock, random: () => 0.5, onStatus: (s) => statuses.push(s), sleep: async () => { clock += 1000; }, ...extra });
  return { host, statuses };
};
/** 時刻を進めて tick (常時の同期の 1 歩) */
const advance = async (host: SyncHost, ms: number) => { clock += ms; await host.tick(); };
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("状態の判定", () => {
  it("Windows で動く裏方は unsupported。資格情報が無ければ signed-out。有効にしていなければ off。結び付いていなければ unbound", async () => {
    const { file } = planFile("p1");
    expect(make({ platform: "win32" }).host.status(file).state).toBe("unsupported");
    const { host } = make({ platform: "linux" });
    expect(host.status(file)).toMatchObject({ state: "signed-out", credentials: { source: "none" }, file: { enabled: false, binding: null } });
    signedIn();
    expect(host.status(file)).toMatchObject({ state: "off", credentials: { source: "stored" } });
    host.openFile(file); host.enable(file);
    await settle();
    expect(host.status(file)).toMatchObject({ state: "unbound", owner: "self", file: { enabled: true } });
    // トークンの値は、状態のどこにも出ない
    expect(JSON.stringify(host.status(file))).not.toContain("test");
    await host.stop();
  });

  it("結び付けて同期すると synced。ディスクが変わると unsent。送ると synced に戻る。セッション ID と通し番号が付く", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    const { host, statuses } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    expect(host.status(file)).toMatchObject({ state: "synced", revision: "e1.1", file: { binding: { remoteId: expect.any(String) } } });
    edit(file, (p) => updateBlock(p, a, { title: "編集" }));
    expect(host.status(file).state).toBe("unsent");
    await advance(host, 100); await advance(host, 2500);
    expect(host.status(file)).toMatchObject({ state: "synced", revision: "e1.2" });
    expect(statuses.every((s) => s.session === host.session)).toBe(true);
    expect(statuses.map((s) => s.seq)).toEqual([...statuses.map((s) => s.seq)].sort((x, y) => x - y));
    await host.stop();
  });

  it("有効にした計画だけを見張る。閉じている結び付け済みの計画は触らない。最後の画面を閉じると所有権を手放す", async () => {
    const p1 = planFile("p1"), p2 = planFile("p2");
    signedIn();
    await syncOnce({ file: p2.file, server: server.url, remoteId: "p2" });
    const requests = { p1: 0, p2: 0 };
    const counting = ((...args: Parameters<typeof fetch>) => { const u = String(args[0]); if (u.includes("/v1/projects/p1")) requests.p1++; if (u.includes("/v1/projects/p2")) requests.p2++; return fetch(...args); }) as typeof fetch;
    const { host } = make({ fetch: counting });
    host.openFile(p1.file); host.enable(p1.file);
    await host.act(p1.file, { kind: "bind" });
    edit(p2.file, (p) => updateBlock(p, p2.a, { title: "p2 の編集" }));
    await advance(host, 100); await advance(host, 2500); await advance(host, 40_000);
    expect(requests.p2).toBe(0);
    expect(JSON.parse(server.project("p2")!.head!.text).blocks[p2.a].title).toBe("A");
    // 最後の画面を閉じる: 所有権を手放す (別の常時の同期が取れる)
    host.closeFile(p1.file);
    await settle();
    expect(host.status(p1.file).owner).toBe("none");
    const lock = lockWatch(server.url);
    expect(lock.unlock).not.toBeNull();
    lock.unlock!();
    await host.stop();
  });

  it("別のプロセス (CLI の --watch) が所有していれば external と表示し、同期しない", async () => {
    const { file } = planFile("p1");
    signedIn();
    const lock = lockWatch(server.url);          // (別のプロセスの代わり)
    try {
      const { host } = make();
      host.openFile(file); host.enable(file);
      await settle();
      expect(host.status(file)).toMatchObject({ state: "external", owner: "external" });
      await host.stop();
    } finally { lock.unlock?.(); }
  });
});

describe("サインインとサインアウト", () => {
  it("サインインを始めるとコードが状態に出る。許可されると資格情報が保存され、利用者が状態に出る。トークンは出ない", async () => {
    const { file } = planFile("p1");
    const { host } = make();
    host.openFile(file);
    host.signIn("github");
    await settle();
    const during = host.status(file);
    expect(during.signIn).toMatchObject({ provider: "github", userCode: expect.stringMatching(/^TEST-/), verificationUrl: "https://github.com/login/device" });
    // サーバー側で許可する
    const code = [...server.deviceCodes.keys()].at(-1)!;
    server.deviceCodes.set(code, { account: "acc-alice", login: "alice" });
    await new Promise((r) => setTimeout(r, 50));
    await host.tick(); await settle();
    expect(readCredentials(server.url)).toMatchObject({ account: "acc-alice", login: "alice" });
    const after = host.status(file);
    expect(after.credentials.source).toBe("stored");
    expect(after.signIn).toBeUndefined();
    expect(JSON.stringify(after)).not.toContain("tok-");
    await host.stop();
  });

  it("サインインの途中で中止すると、遅れて許可されても保存しない (発行されたトークンは取り消す)", async () => {
    const { file } = planFile("p1");
    const { host } = make();
    host.openFile(file);
    host.signIn("github");
    await settle();
    host.cancelSignIn();
    const code = [...server.deviceCodes.keys()].at(-1)!;
    server.deviceCodes.set(code, { account: "acc-alice", login: "alice" });
    await new Promise((r) => setTimeout(r, 80));
    expect(readCredentials(server.url)).toBeNull();
    expect(host.status(file).signIn).toBeUndefined();
    expect([...server.issued.keys()].every((tok) => server.revoked.has(tok))).toBe(true);
    await host.stop();
  });

  it("サインアウト: 見張りを止めて所有権を手放し、保存済みの資格情報を消す。環境変数のトークンは対象外で、状態に残る", async () => {
    const { file } = planFile("p1");
    signedIn();
    const { host } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    await host.act(file, { kind: "signOut" });
    expect(readCredentials(server.url)).toBeNull();
    expect(host.status(file)).toMatchObject({ state: "signed-out", owner: "none", file: { enabled: false } });
    process.env.BOXGLOW_TOKEN = "env-user";
    expect(host.status(file)).toMatchObject({ state: "off", credentials: { source: "env" } });
    await host.stop();
  });

  it("別の CLI の login / logout (資格情報ファイルの変化) を、次の同期から使う。古い資格情報で同期した結果を synced とみなさない", async () => {
    const { file } = planFile("p1");
    signedIn("test");
    const { host } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    expect(host.status(file).state).toBe("synced");
    // 別の CLI が、別の利用者でサインインし直した
    signedIn("other");
    expect(host.status(file).state).toBe("unsent");
    await host.act(file, { kind: "syncNow" });
    // 別の利用者の計画は置き換えない (利用者の違いで止まる)
    expect(host.status(file)).toMatchObject({ state: "halted", halt: { reason: "account-mismatch", fix: "credentials" } });
    await host.stop();
  });
});

describe("確認が要る場面の選択", () => {
  it("競合で止まると選べる操作が出る。選択 ID で進められる。表示したときから状態が変わった選択は断る", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    const { host } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    // 別の端末が同じ項目を変え、手元も変える
    const other = join(root, "other", "boxglow.json"); mkdirSync(join(root, "other"));
    const remoteId = host.status(file).file!.binding!.remoteId;
    const saved = process.env.BOXGLOW_CONFIG_DIR; process.env.BOXGLOW_CONFIG_DIR = join(root, "other-config");
    await syncOnce({ file: other, server: server.url, remoteId });
    edit(other, (p) => updateBlock(p, a, { title: "別の端末" }));
    await syncOnce({ file: other, server: server.url });
    process.env.BOXGLOW_CONFIG_DIR = saved;
    edit(file, (p) => updateBlock(p, a, { title: "手元" }));
    await host.act(file, { kind: "syncNow" });
    const halted = host.status(file);
    expect(halted.state).toBe("halted");
    expect(halted.halt!.reason).toBe("conflicts");
    const choices = halted.halt!.items.filter((i) => i.kind === "choice") as Extract<SyncStatus["halt"], object>["items"][number][];
    expect(choices.map((c) => (c as { label: string }).label)).toEqual(["手元の値に決める", "サーバーの値に決める"]);
    const local = halted.halt!.choiceIds[(choices[0] as { id: string }).id];
    // 表示したときから手元が変わった → 同じ選択 ID では進めない (印が合わず、同期は止まったまま。何も送らない)
    const puts = server.puts;
    edit(file, (p) => updateBlock(p, a, { title: "手元 2" }));
    const stale = await host.act(file, { kind: "choose", choiceId: local });
    expect(server.puts).toBe(puts);
    expect(stale.state).toBe("halted");
    // 今の表示の選択 ID で進める
    const fresh = stale.halt!.choiceIds[(stale.halt!.items.find((i) => i.kind === "choice") as { id: string }).id];
    const done = await host.act(file, { kind: "choose", choiceId: fresh });
    expect(done.state).toBe("synced");
    expect(JSON.parse(server.project(remoteId)!.head!.text).blocks[a].title).toBe("手元 2");
    // 知らない選択 ID は、何もしない
    expect((await host.act(file, { kind: "choose", choiceId: "nope" })).message).toContain("選び直して");
    await host.stop();
  });
});
