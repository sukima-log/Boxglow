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
