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
    // (トークンと利用者の ID を別の値にする: 試験用サーバーは、発行したトークンなら、その利用者として扱う)
    server.issued.set("tok-secret-value", { account: "test", login: "tester" });
    saveCredentials({ server: server.url, account: "test", login: "tester", token: "tok-secret-value", createdAt: new Date().toISOString() });
    expect(host.status(file)).toMatchObject({ state: "off", credentials: { source: "stored" } });
    host.openFile(file); host.enable(file);
    await settle();
    expect(host.status(file)).toMatchObject({ state: "unbound", owner: "self", file: { enabled: true } });
    // トークンの値は、状態のどこにも出ない (利用者は出る)
    expect(JSON.stringify(host.status(file))).not.toContain("tok-secret-value");
    expect(host.status(file).credentials.account).toMatchObject({ accountId: "test", display: "tester" });
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
  it.each([false, true])("競合の選択IDは対象と鮮度を検証する (共通形式=%s)", async grouped => {
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
    const stale = await host.act(file, grouped
      ? { kind: "resolveGroups", choiceId: local, resolution: { version: 1, token: halted.halt!.review!.token, groups: { [halted.halt!.review!.groups[0].id]: "local" } } }
      : { kind: "choose", choiceId: local });
    expect(server.puts).toBe(puts);
    expect(stale.state).toBe("halted");
    // 今の表示の選択 ID で進める
    const fresh = stale.halt!.choiceIds[(stale.halt!.items.find((i) => i.kind === "choice") as { id: string }).id];
    const done = await host.act(file, grouped
      ? { kind: "resolveGroups", choiceId: fresh, resolution: { version: 1, token: stale.halt!.review!.token, groups: { [stale.halt!.review!.groups[0].id]: "local" } } }
      : { kind: "choose", choiceId: fresh });
    expect(done.state).toBe("synced");
    expect(JSON.parse(server.project(remoteId)!.head!.text).blocks[a].title).toBe("手元 2");
    // 知らない選択 ID は、何もしない
    expect((await host.act(file, { kind: "choose", choiceId: "nope" })).message).toContain("選び直して");
    await host.stop();
  });
});

describe("boxglow serve --sync (HTTP の口)", () => {
  it("GET /api/sync は状態、POST は許可リストの操作だけ。SSE に sync の出来事が流れる。--sync 無しでは 404", async () => {
    const { startServe } = await import("../serve");
    const { once } = await import("node:events");
    const { file } = planFile("p1");
    signedIn();
    const dist = join(root, "dist"); mkdirSync(dist); writeFileSync(join(dist, "index.html"), "test");
    const serve = startServe({ file, dist, port: 0, open: false, log: () => {}, sync: { server: server.url } });
    try {
      await once(serve, "listening"); const port = (serve.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/api/sync`;
      const first = await (await fetch(url)).json() as SyncStatus;
      expect(first).toMatchObject({ state: "unbound", file: { enabled: true }, credentials: { source: "stored" } });
      expect(JSON.stringify(first)).not.toContain("test-");
      // SSE: つないだ画面に、今の状態がすぐ届く
      const events = await fetch(`http://127.0.0.1:${port}/api/events`);
      const reader = events.body!.getReader();
      let received = "";
      while (!received.includes("event: sync")) { const { value, done } = await reader.read(); if (done) break; received += Buffer.from(value).toString("utf8"); }
      expect(received).toContain("event: sync");
      void reader.cancel();
      // 操作: 知らない種類・形の違う引数は 400。結び付けは synced になる
      const post = (body: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect((await post(JSON.stringify({ kind: "delete-everything" }))).status).toBe(400);
      expect((await post(JSON.stringify({ kind: "choose", choiceId: 42 }))).status).toBe(400);
      expect((await post("not json")).status).toBe(400);
      // 300ブロックの選択は旧4KiB制限を超えるが、形としては受け付ける (未知の選択IDなので実行はしない)。
      const groups = Object.fromEntries(Array.from({ length: 300 }, (_, i) => ["block:internal-" + i, "local"]));
      const large = JSON.stringify({ kind: "resolveGroups", choiceId: "unknown", resolution: { version: 1, token: "t", groups } });
      expect(Buffer.byteLength(large)).toBeGreaterThan(4096);
      expect((await post(large)).status).toBe(200);
      expect((await post(JSON.stringify({ kind: "resolveGroups", choiceId: "unknown", resolution: { version: 2, token: "t", groups } }))).status).toBe(400);
      expect((await post(" ".repeat(256 * 1024 + 1))).status).toBe(413);
      const bound = await (await post(JSON.stringify({ kind: "bind" }))).json() as SyncStatus;
      expect(bound.state).toBe("synced");
      // 別のサイトからは受け付けない
      expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", origin: "https://untrusted.example" }, body: "{}" })).status).toBe(403);
    } finally { serve.close(); }
    // --sync 無し
    const plain = startServe({ file, dist, port: 0, open: false, log: () => {} });
    try {
      await once(plain, "listening"); const port = (plain.address() as { port: number }).port;
      expect((await fetch(`http://127.0.0.1:${port}/api/sync`)).status).toBe(404);
    } finally { plain.close(); }
  });
});

describe("Google でのサインイン (裏方)", () => {
  it("認可の URL が状態に出る。許可されると資格情報が保存される。中止すると発行されたトークンは取り消される", async () => {
    const { file } = planFile("p1");
    const { host } = make();
    host.openFile(file);
    host.signIn("google");
    await settle();
    const during = host.status(file);
    expect(during.signIn).toMatchObject({ provider: "google", url: expect.stringContaining("accounts.google.com") });
    const id = [...server.googleTx.keys()].at(-1)!;
    server.approveGoogle(id, { account: "acc-g", login: "g" });
    await new Promise((r) => setTimeout(r, 50)); await host.tick(); await settle();
    expect(readCredentials(server.url)).toMatchObject({ account: "acc-g" });
    expect(host.status(file).signIn).toBeUndefined();
    expect(JSON.stringify(host.status(file))).not.toContain("tok-");
    // 中止
    await host.act(file, { kind: "signOut" });
    host.signIn("google");
    await settle();
    host.cancelSignIn();
    await new Promise((r) => setTimeout(r, 80));
    expect(readCredentials(server.url)).toBeNull();
    expect(server.googleTx.size).toBe(0);
    await host.stop();
  });
});

describe("レビュー 39 の回帰 (裏方)", () => {
  /** 指定の要求を止めておける通信 (hold() で止め、release() で通す) */
  const gate = () => {
    let held: (() => void) | null = null;
    let armed = false;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => {
      if (armed && String(args[0]).includes("/v1/projects/")) { armed = false; await new Promise<void>((r) => { held = r; }); }
      return fetch(...args);
    }) as typeof fetch;
    return { fetchFn, hold: () => { armed = true; }, release: () => { held?.(); held = null; }, isHeld: () => held !== null };
  };
  const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it("R39-01: 通信を待っている間に止めても、実行中の 1 回が終わるまで所有権を手放さない。終われば別の所有者が取れる", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    const g = gate();
    const { host } = make({ fetch: g.fetchFn });
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    edit(file, (p) => updateBlock(p, a, { title: "編集" }));
    g.hold();
    clock += 100; void host.tick(); clock += 2500;
    const running = host.tick();
    await until(g.isHeld);
    expect(g.isHeld()).toBe(true);
    host.disable(file);
    const stopped = host.stop();
    await new Promise((r) => setTimeout(r, 30));
    // 実行中の間は、別の所有者はロックを取れない
    const early = lockWatch(server.url);
    expect(early.unlock).toBeNull();
    g.release();
    await running; await stopped;
    const later = lockWatch(server.url);
    expect(later.unlock).not.toBeNull();
    later.unlock!();
  });

  it("R39-02: 内容が同じでも、別の実行が状態の世代だけを進めた後は、古い選択で送らない。別のファイルの選択も通さない", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    const { host } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    const remoteId = host.status(file).file!.binding!.remoteId;
    const other = join(root, "other", "boxglow.json"); mkdirSync(join(root, "other"));
    const saved = process.env.BOXGLOW_CONFIG_DIR; process.env.BOXGLOW_CONFIG_DIR = join(root, "other-config");
    await syncOnce({ file: other, server: server.url, remoteId });
    edit(other, (p) => updateBlock(p, a, { title: "別の端末" }));
    await syncOnce({ file: other, server: server.url });
    process.env.BOXGLOW_CONFIG_DIR = saved;
    edit(file, (p) => updateBlock(p, a, { title: "手元" }));
    await host.act(file, { kind: "syncNow" });
    const halted = host.status(file);
    const item = halted.halt!.items.find((i) => i.kind === "choice") as { id: string };
    const choiceId = halted.halt!.choiceIds[item.id];
    // 別の実行が、状態の世代だけを進める (中身は同じ)
    const { StateStore, bindingDir } = await import("./state-store");
    const store = new StateStore(bindingDir(file, server.url));
    const unlock = store.lock()!;
    const current = store.read()!;
    store.write({ ...current, generation: current.generation + 1 }, current.generation);
    unlock();
    const puts = server.puts;
    // 別のファイルを名乗った選択は通らない
    const wrongFile = await host.act(planFile("p9").file, { kind: "choose", choiceId });
    expect(wrongFile.message).toContain("選び直して");
    const r = await host.act(file, { kind: "choose", choiceId });
    expect(server.puts).toBe(puts);
    expect(r.state).toBe("halted");
    expect(r.halt!.reason).toBe("state-changed");
    await host.stop();
  });

  it("R39-03: 同期の応答を待っている間に資格情報が替わったら、その結果を今の成功として表示しない", async () => {
    const { file, a } = planFile("p1");
    signedIn("test");
    const g = gate();
    let synced = false;
    const seenSync = () => synced;
    const { host } = make({ fetch: g.fetchFn });
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    edit(file, (p) => updateBlock(p, a, { title: "編集" }));
    g.hold();
    clock += 100; void host.tick(); clock += 2500;
    const running = host.tick();
    await until(g.isHeld);
    signedIn("other");                          // (別の CLI が、別の利用者でサインインし直した)
    g.release();
    await running;
    const after = host.status(file);
    synced = JSON.parse(server.project(host.status(file).file!.binding!.remoteId)!.head!.text).blocks[a].title === "編集";
    expect(seenSync()).toBe(true);
    expect(after.state).not.toBe("synced");
    await host.stop();
  });

  it("R39-10: 同期できた後で、サーバーがトークンを断るようになったら、同期済みのままにせず、認証の問題として表示する", async () => {
    const { file } = planFile("p1");
    signedIn();
    let deny = false;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => deny && String(args[0]).includes("/v1/projects")
      ? new Response("{}", { status: 401, headers: { "x-boxglow-epoch": "e1" } }) : fetch(...args)) as typeof fetch;
    const { host } = make({ fetch: fetchFn });
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    expect(host.status(file).state).toBe("synced");
    deny = true;
    await advance(host, 40_000);
    expect(host.status(file)).toMatchObject({ state: "problem", problem: { kind: "auth", fix: "credentials" } });
    // 資格情報を直す (別の利用者のものに替える) と、認証の問題は今の世代のものではなくなる
    deny = false;
    signedIn("test2");
    expect(host.status(file).problem?.kind).not.toBe("auth");
    await host.stop();
  });
});

describe("レビュー 40 の回帰 (裏方)", () => {
  const until = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

  it("R40-02: 手動の操作 (結び付け) の通信を待っている間に止めても、その操作が終わるまで停止は終わらず、所有権も手放さない", async () => {
    const { file } = planFile("p1");
    signedIn();
    let held: (() => void) | null = null;
    let hold = false;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => {
      if (hold && (args[1] as RequestInit | undefined)?.method === "PUT") { hold = false; await new Promise<void>((r) => { held = r; }); }
      return fetch(...args);
    }) as typeof fetch;
    const { host } = make({ fetch: fetchFn });
    host.openFile(file); host.enable(file);
    await settle();
    hold = true;
    const binding = host.act(file, { kind: "bind" });
    await until(() => held !== null);
    let stopped = false;
    const stopping = host.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    expect(lockWatch(server.url).unlock).toBeNull();
    const puts = server.puts;
    (held as unknown as () => void)();
    await binding; await stopping;
    expect(server.puts).toBe(puts + 1);                 // (始めた送信は、停止の前に終わっている)
    const later = lockWatch(server.url);
    expect(later.unlock).not.toBeNull();
    later.unlock!();
    // 停止の後は、新しい手動の操作を始めない
    const after = server.puts;
    await host.act(file, { kind: "syncNow" });
    expect(server.puts).toBe(after);
  });

  it("R40-05: 資格情報を変えずに認証が直ったら (サーバー側の停止の解除など)、変更が無くても、手動の同期でも、表示が戻る", async () => {
    const { file } = planFile("p1");
    signedIn();
    let deny = false;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => deny && String(args[0]).includes("/v1/projects")
      ? new Response("{}", { status: 401, headers: { "x-boxglow-epoch": "e1" } }) : fetch(...args)) as typeof fetch;
    const { host } = make({ fetch: fetchFn });
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    deny = true;
    await advance(host, 40_000);
    expect(host.status(file).problem?.kind).toBe("auth");
    deny = false;
    // 変更なしの自動の確認で戻る (認証の失敗の後は、間隔を延ばして待つので、十分に進める)
    await advance(host, 120_000);
    expect(host.status(file).state).toBe("synced");
    // 手動の同期でも戻る
    deny = true; await advance(host, 120_000);
    expect(host.status(file).problem?.kind).toBe("auth");
    deny = false;
    await host.act(file, { kind: "syncNow" });
    expect(host.status(file).state).toBe("synced");
    await host.stop();
  });
});

describe("レビュー 41 の回帰 (裏方)", () => {
  it("R41-04: サインアウトの失効の要求を待つ間に、有効化・今すぐ同期を送っても、新しい同期は始まらない。終わった後に見張りは残らない", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    let held: (() => void) | null = null;
    let hold = false;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => {
      if (hold && (args[1] as RequestInit | undefined)?.method === "DELETE") { hold = false; await new Promise<void>((r) => { held = r; }); }
      return fetch(...args);
    }) as typeof fetch;
    const { host } = make({ fetch: fetchFn });
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    hold = true;
    const signingOut = host.act(file, { kind: "signOut" });
    for (let i = 0; i < 200 && held === null; i++) await new Promise((r) => setTimeout(r, 5));
    expect(held).not.toBeNull();
    edit(file, (p) => updateBlock(p, a, { title: "サインアウト中の編集" }));
    const puts = server.puts;
    await host.act(file, { kind: "enable" });
    await host.act(file, { kind: "syncNow" });
    await advance(host, 3000);
    expect(server.puts).toBe(puts);
    expect(host.status(file).owner).not.toBe("self");
    (held as unknown as () => void)();
    await signingOut;
    expect(host.status(file)).toMatchObject({ state: "signed-out", owner: "none", file: { enabled: false } });
    const lock = lockWatch(server.url);
    expect(lock.unlock).not.toBeNull();
    lock.unlock!();
  });
});

describe("レビュー 42 の回帰 (裏方)", () => {
  it("R42-01: サインアウトを 2 回重ねても、先の失効が終わるまで同期は再開しない。2 回目は同じ完了を待つ", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    let held: (() => void) | null = null;
    let hold = false;
    const fetchFn = (async (...args: Parameters<typeof fetch>) => {
      if (hold && (args[1] as RequestInit | undefined)?.method === "DELETE") { hold = false; await new Promise<void>((r) => { held = r; }); }
      return fetch(...args);
    }) as typeof fetch;
    const { host } = make({ fetch: fetchFn });
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    hold = true;
    let firstDone = false;
    const first = host.act(file, { kind: "signOut" }).then(() => { firstDone = true; });
    for (let i = 0; i < 200 && held === null; i++) await new Promise((r) => setTimeout(r, 5));
    let secondDone = false;
    const second = host.act(file, { kind: "signOut" }).then(() => { secondDone = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect([firstDone, secondDone]).toEqual([false, false]);
    edit(file, (p) => updateBlock(p, a, { title: "サインアウト中の編集" }));
    const puts = server.puts;
    await host.act(file, { kind: "enable" });
    void host.act(file, { kind: "syncNow" });
    await advance(host, 3000);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.puts).toBe(puts);
    expect(host.status(file).owner).not.toBe("self");
    (held as unknown as () => void)();
    await first; await second;
    expect(host.status(file)).toMatchObject({ state: "signed-out", owner: "none", file: { enabled: false } });
    const lock = lockWatch(server.url);
    expect(lock.unlock).not.toBeNull();
    lock.unlock!();
  });
});

describe("実機の VS Code で見つけた不具合の回帰 (裏方)", () => {
  it("サインインの途中は「未サインイン」のまま (「オフ」に見せない)。資格情報が無い間は、有効にしても結び付けても、要求を送らない", async () => {
    const { file } = planFile("p1");
    const { host } = make();
    host.openFile(file);
    host.signIn("github");
    await settle();
    expect(host.status(file)).toMatchObject({ state: "signed-out", signIn: { provider: "github" } });
    const puts = server.puts;
    host.enable(file);
    await host.act(file, { kind: "bind" });
    await advance(host, 3000);
    expect(server.puts).toBe(puts);
    expect(host.status(file).state).toBe("signed-out");
    host.cancelSignIn();
    await host.stop();
  });
});

describe("レビュー 46 の回帰 (裏方)", () => {
  it("R46-01: 利用者の確認も、https か手元の http にだけトークンを送る (環境変数のトークンでも)", async () => {
    const { file } = planFile("p1");
    let calls = 0;
    const stub = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
    process.env.BOXGLOW_TOKEN = "env-secret-token";
    const statuses: SyncStatus[] = [];
    const host = new SyncHost({ server: "http://sync.example.com", fetch: stub, onStatus: (s) => statuses.push(s) });
    host.openFile(file);
    await settle();
    expect(calls).toBe(0);
    expect(JSON.stringify(host.status(file))).not.toContain("env-secret-token");
    // 手元の http (試験用サーバー) には送る
    const local = make({ fetch: ((...args: Parameters<typeof fetch>) => { calls++; return fetch(...args); }) as typeof fetch });
    local.host.openFile(file);
    await local.host.act(file,{kind:"beginSync"});
    await settle();
    expect(calls).toBeGreaterThan(0);
    await host.stop(); await local.host.stop();
  });

  it("R46-02: 別の CLI がサインアウトしたら (資格情報のファイルが消えた)、操作しなくても画面に「未サインイン」が届く。同期の要求は送らない。再びサインインすると戻る", async () => {
    const { file } = planFile("p1");
    signedIn();
    const { host, statuses } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    await settle();
    expect(statuses.at(-1)?.state).toBe("synced");
    const { credentialsPath } = await import("./credentials");
    rmSync(credentialsPath(server.url));
    const puts = server.puts;
    await advance(host, 1000); await settle();
    expect(statuses.at(-1)?.state).toBe("signed-out");
    await advance(host, 40_000);
    expect(server.puts).toBe(puts);
    signedIn();
    await advance(host, 1000); await advance(host, 40_000); await settle();
    expect(statuses.at(-1)?.state).toBe("synced");
    await host.stop();
  });
});

describe("一時停止中の表示", () => {
  it("一時停止中でも、手動の同期で止まったこと (競合) は見せる。それ以外は「一時停止」", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    const { host } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    await host.act(file, { kind: "pause" });
    expect(host.status(file).state).toBe("paused");
    // 別の端末が同じ題名を変え、手元も変えて、手動で同期する
    const remoteId = host.status(file).file!.binding!.remoteId;
    const other = join(root, "other", "boxglow.json"); mkdirSync(join(root, "other"));
    const saved = process.env.BOXGLOW_CONFIG_DIR; process.env.BOXGLOW_CONFIG_DIR = join(root, "other-config");
    await syncOnce({ file: other, server: server.url, remoteId });
    edit(other, (p) => updateBlock(p, a, { title: "別の端末" }));
    await syncOnce({ file: other, server: server.url });
    process.env.BOXGLOW_CONFIG_DIR = saved;
    edit(file, (p) => updateBlock(p, a, { title: "手元" }));
    await host.act(file, { kind: "syncNow" });
    expect(host.status(file).state).toBe("halted");
    await host.stop();
  });

  it("R47-01: 結び付け済みの計画を新しい裏方で開き、最初の同期の前に一時停止しても「同期中」にならない。再開すると同期する", async () => {
    const { file } = planFile("p1");
    signedIn();
    // 1 つ目の裏方で結び付けて、終える
    const first = make();
    first.host.openFile(file); first.host.enable(file);
    await first.host.act(file, { kind: "bind" });
    await first.host.stop();
    // 2 つ目の裏方 (結果をまだ持たない) で開き直し、tick の前に一時停止する
    const { host, statuses } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "pause" });
    expect(host.status(file).state).toBe("paused");
    await advance(host, 40_000); await settle();
    expect(host.status(file).state).toBe("paused");
    await host.act(file, { kind: "resume" });
    await advance(host, 1000); await advance(host, 40_000); await settle();
    expect(statuses.at(-1)?.state).toBe("synced");
    await host.stop();
  });

  it("R47-02: 一時停止中に別の CLI がサインアウト・サインインしても、画面に知らせる。再開までは同期の要求を送らない", async () => {
    const { file, a } = planFile("p1");
    signedIn();
    const { host, statuses } = make();
    host.openFile(file); host.enable(file);
    await host.act(file, { kind: "bind" });
    await settle();
    await host.act(file, { kind: "pause" });
    const { credentialsPath } = await import("./credentials");
    rmSync(credentialsPath(server.url));
    const count = statuses.length;
    await advance(host, 1000); await settle();
    expect(statuses.length).toBeGreaterThan(count);
    expect(statuses.at(-1)?.state).toBe("signed-out");
    // 再びサインイン: 表示は戻るが、一時停止中なので手元の変更は送らない
    edit(file, (p) => updateBlock(p, a, { title: "一時停止中の変更" }));
    const puts = server.puts;
    signedIn();
    await advance(host, 1000); await advance(host, 40_000); await settle();
    expect(statuses.at(-1)?.state).not.toBe("signed-out");
    expect(server.puts).toBe(puts);
    // 再開すると送る
    await host.act(file, { kind: "resume" });
    await advance(host, 1000); await advance(host, 40_000); await settle();
    expect(server.puts).toBeGreaterThan(puts);
    expect(statuses.at(-1)?.state).toBe("synced");
    await host.stop();
  });
});

/** 段階D: 開始時の明示操作、一覧、既存比較、再試行を実ファイルで確かめる。 */
describe("同期の開始", () => {
  it("資格情報があっても起動だけでは通信しない。重複クリックと再起動で計画が増えない", async () => {
    const { file } = planFile("start");
    signedIn();
    let requests = 0;
    const { host } = make({ fetch: ((...args: Parameters<typeof fetch>) => { requests++; return fetch(...args); }) as typeof fetch });
    host.openFile(file);
    await settle();
    expect(requests).toBe(0);
    expect(host.status(file).file?.enabled).toBe(false);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await Promise.all([1, 2].map(() => host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "new" })));
    expect(host.status(file).state).toBe("synced");
    const id = host.status(file).file!.binding!.remoteId;
    await host.stop();
    const next = make().host;
    next.openFile(file);
    const retry = (await next.act(file, { kind: "beginSync" })).startup!;
    await next.act(file, { kind: "continueStart", operationId: retry.operationId, intent: "new" });
    expect(next.status(file).file?.binding?.remoteId).toBe(id);
    expect(await (await fetch(server.url + "/v1/projects", { headers: { authorization: "Bearer test" } })).json()).toHaveLength(1);
    await next.stop();
  });
  it("サインイン前の意図と取消は計画を作らない。古い操作IDは使えない", async () => {
    const { file } = planFile("cancel");
    const { host } = make();
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    expect((await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "new" })).startup?.stage).toBe("signin");
    await host.act(file, { kind: "cancelBegin" });
    signedIn();
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "new" });
    expect(host.status(file).file?.binding).toBeNull();
    expect(host.status(file).file?.enabled).toBe(false);
    await host.stop();
  });
  it("一覧は自分のメタデータだけでページングする。別ファイルに開き元を変更しない", async () => {
    signedIn();
    for (let i = 0; i < 21; i++) {
      const { file } = planFile("plan" + i);
      await syncOnce({ file, server: server.url, remoteId: "plan" + String(i).padStart(2, "0"), token: "test" });
    }
    const foreign = planFile("foreign");
    await syncOnce({ file: foreign.file, server: server.url, remoteId: "foreign", token: "other" });
    const { file } = planFile("destination");
    const original = readFileSync(file, "utf8");
    const target = join(root, "destination", "opened.json");
    let opened = "";
    const { host } = make({ chooseDestination: async () => target, onOpened: async (path) => { opened = path; } });
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    let status = await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    expect(status.startup?.projects).toHaveLength(20);
    expect(JSON.stringify(status.startup)).not.toContain("blocks");
    expect(JSON.stringify(status.startup)).not.toContain("foreign");
    const cursor = status.startup!.nextCursor!;
    status = await host.act(file, { kind: "listProjects", operationId: op.operationId, cursor });
    expect(status.startup?.projects?.map(p => p.id)).toEqual(["plan20"]);
    expect(status.startup?.nextCursor).toBeNull();
    status = await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "plan20", destination: "new" });
    expect(status.startup?.stage).toBe("opened");
    expect(opened).toBe(target);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(read(target).name).toBe("plan20");
    await host.stop();
  });
  it("既存ファイルとの差異は比較で止まり、不存在や他アカウントのIDを新規作成しない", async () => {
    signedIn();
    const source = planFile("remote");
    await syncOnce({ file: source.file, server: server.url, remoteId: "existing", token: "test" });
    const { file } = planFile("local");
    const original = readFileSync(file, "utf8");
    const { host } = make();
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    expect((await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "missing" })).startup?.error).toBeTruthy();
    expect(server.project("missing")).toBeUndefined();
    const status = await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "existing" });
    expect(status.state).toBe("halted");
    expect(status.halt?.reason).toBe("first-link");
    expect(readFileSync(file, "utf8")).toBe(original);
    await host.stop();
  });
  it("旧サーバーの配列はID入力へ戻り、資格情報が変わった一覧の選択は拒否する", async () => {
    signedIn();
    const { file } = planFile("legacy");
    const { host } = make({ fetch: ((input: string | URL | Request, init?: RequestInit) => String(input).includes("/v1/projects?") ? Promise.resolve(Response.json([])) : fetch(input, init)) as typeof fetch });
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    let status = await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    expect(status.startup?.unsupported).toBe(true);
    signedIn("different");
    status = await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "x" });
    expect(status.startup?.error).toBeTruthy();
    expect(status.file?.binding).toBeNull();
    await host.stop();
  });
  it("新しい保存先に既存ファイルを選んでも上書きしない。保存ダイアログ取消も書かない", async () => {
    signedIn();
    const { file } = planFile("source");
    const target = planFile("occupied").file;
    const before = readFileSync(target, "utf8");
    let chosen: string | null = target;
    const { host } = make({ chooseDestination: async () => chosen });
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "x", destination: "new" });
    expect(readFileSync(target, "utf8")).toBe(before);
    chosen = null;
    expect((await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "x", destination: "new" })).startup?.stage).toBe("list");
    expect(host.status(file).file?.binding).toBeNull();
    await host.stop();
  });
});
/** 遅い応答と認可の失敗は、次の開始へ混ぜない。 */
describe("開始処理の中断と再試行", () => {
  it("新規送信の応答消失後にホストを再起動しても同じリモートIDへ再開する", async () => {
    signedIn();
    const { file } = planFile("lost-response");
    const host = make().host;
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    server.dropNextPutResponse = true;
    const failed = await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "new" });
    const id = failed.file?.binding?.remoteId;
    expect(id).toBeTruthy();
    expect(server.projects.size).toBe(1);
    await host.stop();
    const next = make().host;
    next.openFile(file);
    next.enable(file);
    await next.act(file, { kind: "syncNow" });
    expect(next.status(file).file?.binding?.remoteId).toBe(id);
    expect(next.status(file).state).toBe("synced");
    expect(server.projects.size).toBe(1);
    await next.stop();
  });
  it("一覧取得中の資格情報変更で古い名前とカーソルを破棄する", async () => {
    signedIn();
    const { file } = planFile("late-list");
    let release!: (r: Response) => void;
    const delayed = new Promise<Response>(r => { release = r; });
    const host = make({ fetch: ((input: string | URL | Request, init?: RequestInit) => String(input).includes("/v1/projects?") ? delayed : fetch(input, init)) as typeof fetch }).host;
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    const pending = host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    signedIn("other");
    release(Response.json({ projects: [{ id: "old", name: "古いアカウントの名前", revision: "e1.1", bytes: 10, updatedAt: null }], nextCursor: "old" }));
    const status = await pending;
    expect(status.startup?.projects).toEqual([]);
    expect(status.startup?.nextCursor).toBeNull();
    expect(status.startup?.error).toBeTruthy();
    await host.stop();
  });
  it.each(["denied", "cancel"])("新規配置の認可が%sなら計画を作らない", async (mode) => {
    const { file } = planFile("auth-" + mode);
    const host = make().host;
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "new" });
    host.signIn("github");
    await settle();
    const code = [...server.deviceCodes.keys()].at(-1)!;
    if (mode === "cancel") {
      host.cancelSignIn();
      server.deviceCodes.set(code, { account: "test", login: "test" });
    }
    else
      server.deviceCodes.set(code, "denied");
    await new Promise(r => setTimeout(r, 80));
    expect(readCredentials(server.url)).toBeNull();
    expect(server.projects.size).toBe(0);
    expect(host.status(file).file?.enabled).toBe(false);
    await host.stop();
  });
  it("不正な送り先へ開始してもトークンを送らない", async () => {
    process.env.BOXGLOW_TOKEN = "secret";
    const { file } = planFile("unsafe");
    let calls = 0;
    const host = make({ server: "http://not-local.example", fetch: (async () => { calls++; return Response.json({}); }) as typeof fetch }).host;
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "new" });
    expect(calls).toBe(0);
    expect(host.status(file).startup?.error).toBeTruthy();
    await host.stop();
  });
});

/** D2: 別の送り先・計画・開始操作へ権限や取消を流用しない。 */
describe("段階Dレビューの回帰", () => {
  it("既定の入口は環境トークンを無視し、保存済み利用者は通信なしで表示する", async () => {
    const { file } = planFile("credentials-scope");
    signedIn("stored-user");
    process.env.BOXGLOW_TOKEN = "foreign-secret";
    const sent: string[] = [];
    const host = make({ allowEnvironmentToken: false, fetch: (async (input, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return fetch(input, init);
    }) as typeof fetch }).host;
    host.openFile(file);
    await settle();
    expect(sent).toEqual([]);
    expect(host.status(file).credentials).toMatchObject({ source: "stored", account: { display: "stored-user" } });
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every(h => h === "Bearer stored-user")).toBe(true);
    await host.stop();
  });
  it("現在のファイルも新しい保存先としては拒否し、日本語の理由を出す", async () => {
    signedIn();
    const { file } = planFile("same-target");
    const before = readFileSync(file, "utf8");
    const host = make({ chooseDestination: async () => file }).host;
    host.openFile(file);
    const op = (await host.act(file, { kind: "beginSync" })).startup!;
    await host.act(file, { kind: "continueStart", operationId: op.operationId, intent: "existing" });
    const status = await host.act(file, { kind: "openProject", operationId: op.operationId, projectId: "x", destination: "new" });
    expect(status.startup?.error).toContain("既にファイル");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(status.file?.binding).toBeNull();
    await host.stop();
  });
  it("一方の開始を取り消しても、もう一方の開始とその認可は保持する", async () => {
    const a = planFile("cancel-a").file, b = planFile("cancel-b").file;
    const host = make({ sleep: async () => new Promise(r => setTimeout(r, 20)) }).host;
    host.openFile(a); host.openFile(b);
    const oa = (await host.act(a, { kind: "beginSync" })).startup!;
    const ob = (await host.act(b, { kind: "beginSync" })).startup!;
    await host.act(a, { kind: "continueStart", operationId: oa.operationId, intent: "existing" });
    await host.act(b, { kind: "continueStart", operationId: ob.operationId, intent: "existing" });
    await host.act(b, { kind: "signIn", provider: "github" });
    await settle();
    await host.act(a, { kind: "cancelBegin" });
    expect(host.status(a).startup).toBeUndefined();
    expect(host.status(b).startup?.operationId).toBe(ob.operationId);
    const code = [...server.deviceCodes.keys()].at(-1)!;
    server.deviceCodes.set(code, { account: "test", login: "test" });
    for (let i = 0; i < 100 && host.status(b).startup?.stage !== "list"; i++) await settle();
    expect(readCredentials(server.url)?.account).toBe("test");
    expect(host.status(b).startup?.stage).toBe("list");
    await host.stop();
  });
  it("有効化の記憶は同期成功後だけ保存し、失敗では保存しない", async () => {
    signedIn();
    const { file } = planFile("remember-after-success");
    const remembered: boolean[] = [];
    let fail = true;
    const host = make({ onEnabled: (_, enabled) => remembered.push(enabled), fetch: (async (input, init) => {
      if (fail) throw new Error("offline");
      return fetch(input, init);
    }) as typeof fetch }).host;
    host.openFile(file); host.enable(file);
    expect(remembered).toEqual([]);
    await host.act(file, { kind: "bind" });
    expect(remembered).toEqual([]);
    fail = false;
    await host.act(file, { kind: "syncNow" });
    expect(remembered).toEqual([true]);
    host.disable(file);
    expect(remembered).toEqual([true, false]);
    await host.stop();
  });
});
