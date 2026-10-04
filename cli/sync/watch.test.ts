/**
 * 常時の同期 (cli/sync/watch.ts) の試験。時刻は試験の中で進め、tick() を手で呼ぶ (実際には待たない)。
 * ファイル・状態の置き場・HTTP (試験用のサーバー) は実物を使う
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../../src/model/graph";
import type { Project } from "../../src/model/types";
import { syncOnce } from "./client";
import { TestSyncServer } from "./test-server";
import { DEBOUNCE_MS, IDLE_POLL_MS, lockWatch, MAX_WAIT_MS, POLL_MS, SyncWatcher, type WatchEvent } from "./watch";

let server: TestSyncServer;
let root: string;
let clock = 0;
let events: WatchEvent[] = [];
beforeEach(async () => {
  server = new TestSyncServer(); await server.start();
  root = mkdtempSync(join(tmpdir(), "boxglow-watch-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  clock = Date.parse("2026-10-04T12:00:00.000Z"); events = [];
});
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });

/** 計画のファイルを 1 つ作る (ボックス A・B つき) */
function planFile(name: string): { file: string; a: string; b: string } {
  let p = createProject(name);
  const pj = defaultTaskParent(p);
  const a = addBlock(p, { parentId: pj, title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: pj, title: "B" }); p = b.project;
  mkdirSync(join(root, name), { recursive: true });
  const file = join(root, name, "boxglow.json");
  writeFileSync(file, toJSON(fromJSON(toJSON(p))) + "\n");
  return { file, a: a.blockId, b: b.blockId };
}
const read = (file: string): Project => fromJSON(readFileSync(file, "utf8"));
let edits = 0;
/**
 * 計画を編集する。ファイルの更新時刻を、呼ぶたびに必ず違う値にする
 * (見張りは更新時刻と大きさで変更に気づく。試験は一瞬で何度も書くので、時刻が同じにならないようにする)
 */
const edit = (file: string, change: (p: Project) => Project) => {
  writeFileSync(file, toJSON(change(read(file))) + "\n");
  const at = new Date(Date.parse("2026-10-04T00:00:00.000Z") + ++edits * 1000);
  utimesSync(file, at, at);
};
const watcher = () => new SyncWatcher({ server: server.url, now: () => clock, random: () => 0.5, onEvent: (e) => events.push(e) });
/** 時刻を進めてから tick を 1 回行う */
const advance = async (w: SyncWatcher, ms: number) => { clock += ms; await w.tick(); };
/** 別の端末として、サーバー側の計画を書き換える (この端末の状態の置き場は使わない) */
async function remoteEdit(remoteId: string, change: (p: Project) => Project): Promise<void> {
  const saved = process.env.BOXGLOW_CONFIG_DIR;
  process.env.BOXGLOW_CONFIG_DIR = join(root, "other-config");
  try {
    const file = join(root, "other-" + remoteId, "boxglow.json");
    mkdirSync(join(root, "other-" + remoteId), { recursive: true });
    await syncOnce({ file, server: server.url, remoteId });
    edit(file, change);
    expect((await syncOnce({ file, server: server.url })).status).toBe("synced");
  } finally { process.env.BOXGLOW_CONFIG_DIR = saved; }
}

describe("手元の変更をまとめて送る", () => {
  it("変更から 2 秒静かなら送る。それまでは送らない", async () => {
    const { file, a } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    const w = watcher();
    await w.tick();                                            // 最初の 1 回 (見つけた計画を確かめる)
    const puts = server.puts;
    edit(file, (p) => updateBlock(p, a, { title: "A 改" }));
    await advance(w, 500); await advance(w, 1000);
    expect(server.puts).toBe(puts);                            // まだ 2 秒経っていない
    await advance(w, DEBOUNCE_MS);
    expect(server.puts).toBe(puts + 1);
    expect(events.at(-1)).toMatchObject({ kind: "synced", file, pushed: 1 });
  });
  it("変更が 1 秒ごとに続いても、最初の変更から 10 秒以内に送る (送られないまま延び続けない)", async () => {
    const { file, a } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    const w = watcher(); await w.tick();
    const puts = server.puts;
    let sentAt = -1;
    for (let second = 0; second <= 12 && sentAt < 0; second++) {
      edit(file, (p) => updateBlock(p, a, { title: `${second} 秒目` }));
      await advance(w, 1000);
      if (server.puts > puts) sentAt = second + 1;
    }
    expect(sentAt).toBeGreaterThan(0);
    expect(sentAt * 1000).toBeLessThanOrEqual(MAX_WAIT_MS + 1000);
  });
});

describe("サーバーの変更を確かめる", () => {
  it("計画が 2 つあっても、確認は一覧の 1 回の要求で済ませ、進んだ計画だけを受け取る", async () => {
    const one = planFile("p1"), two = planFile("p2");
    await syncOnce({ file: one.file, server: server.url, remoteId: "p1" });
    await syncOnce({ file: two.file, server: server.url, remoteId: "p2" });
    const w = watcher(); await w.tick();
    expect(w.files().sort()).toEqual([one.file, two.file].sort());
    await remoteEdit("p2", (p) => updateBlock(p, two.b, { title: "別の端末が変えた" }));
    const lists = server.lists;
    await advance(w, POLL_MS / 2);
    expect(server.lists).toBe(lists);                          // まだ確かめる時刻ではない
    expect(read(two.file).blocks[two.b].title).toBe("B");
    await advance(w, POLL_MS);
    expect(server.lists).toBe(lists + 1);                      // 2 つの計画を、1 回で確かめた
    expect(read(two.file).blocks[two.b].title).toBe("別の端末が変えた");
    expect(events.filter((e) => e.kind === "synced").map((e) => e.kind === "synced" && e.file)).toEqual([two.file]);
  });
  it("変化が無い状態が続いたら、確かめる間隔を 60 秒に延ばす。変化があれば 30 秒に戻す", async () => {
    const { file, b } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    const w = watcher(); await w.tick();
    for (let i = 0; i < 12; i++) await advance(w, POLL_MS + 1000);
    await advance(w, IDLE_POLL_MS);                            // (確かめる時刻をそろえる)
    const lists = server.lists;
    await advance(w, POLL_MS + 1000);
    expect(server.lists).toBe(lists);                          // 30 秒では確かめなくなった
    await advance(w, POLL_MS + 1000);
    expect(server.lists).toBe(lists + 1);                      // 60 秒で確かめる
    await remoteEdit("p1", (p) => updateBlock(p, b, { title: "変化" }));
    await advance(w, IDLE_POLL_MS + 1000);                     // 変化を見つける
    const after = server.lists;
    await advance(w, POLL_MS + 1000);
    expect(server.lists).toBe(after + 1);                      // 30 秒に戻った
  });
  it("常時の同期を始めた後で結び付けた計画も、受け持つ", async () => {
    const one = planFile("p1");
    await syncOnce({ file: one.file, server: server.url, remoteId: "p1" });
    const w = watcher(); await w.tick();
    const two = planFile("p2");
    await syncOnce({ file: two.file, server: server.url, remoteId: "p2" });
    await advance(w, 1000);
    expect(w.files().sort()).toEqual([one.file, two.file].sort());
  });
});

describe("止まった計画・通信できないとき", () => {
  it("競合で止まった計画は、1 回だけ知らせ、手元かサーバーが変わるまで繰り返し試さない。ほかの計画は続ける", async () => {
    const one = planFile("p1"), two = planFile("p2");
    await syncOnce({ file: one.file, server: server.url, remoteId: "p1" });
    await syncOnce({ file: two.file, server: server.url, remoteId: "p2" });
    const w = watcher(); await w.tick();
    await remoteEdit("p1", (p) => updateBlock(p, one.a, { title: "サーバーの案" }));
    edit(one.file, (p) => updateBlock(p, one.a, { title: "手元の案" }));
    await advance(w, POLL_MS + 1000);
    expect(events.filter((e) => e.kind === "halted").length).toBe(1);
    for (let i = 0; i < 5; i++) await advance(w, POLL_MS + 1000);
    expect(events.filter((e) => e.kind === "halted").length).toBe(1);   // 繰り返し知らせない
    // ほかの計画は、止まった計画に関係なく送られる
    edit(two.file, (p) => updateBlock(p, two.a, { title: "p2 の変更" }));
    await advance(w, 500); await advance(w, DEBOUNCE_MS);
    expect(events.some((e) => e.kind === "synced" && e.file === two.file)).toBe(true);
    // 手元を直す (サーバーと同じ値にする) と、もう一度試して、そろう
    edit(one.file, (p) => updateBlock(p, one.a, { title: "サーバーの案" }));
    await advance(w, 500); await advance(w, DEBOUNCE_MS);
    expect(events.some((e) => e.kind === "synced" && e.file === one.file)).toBe(true);
  });
  it("通信できないときは、間隔を延ばしながらやり直し、戻ったら送る (変更は失わない)", async () => {
    const { file, a } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    let down = true;
    const w = new SyncWatcher({ server: server.url, now: () => clock, random: () => 0.5, onEvent: (e) => events.push(e)
    , fetch: (async (...args: Parameters<typeof fetch>) => { if (down) throw new Error("offline"); return fetch(...args); }) as typeof fetch });
    await w.tick();
    expect(events.at(-1)).toMatchObject({ kind: "network", retryInMs: 5000 });
    edit(file, (p) => updateBlock(p, a, { title: "通信できない間の編集" }));
    await advance(w, 6000);
    expect(events.at(-1)).toMatchObject({ kind: "network", retryInMs: 10000 });
    down = false;
    await advance(w, 11_000);
    await advance(w, DEBOUNCE_MS);
    expect(fromJSON(server.project("p1")!.head!.text).blocks[a].title).toBe("通信できない間の編集");
  });
  it("同じ端末・同じサーバーの常時の同期は 1 つだけ (2 つ目はロックを取れない)。終われば、次が取れる", () => {
    const first = lockWatch(server.url);
    expect(first.unlock).not.toBeNull();
    expect(lockWatch(server.url).unlock).toBeNull();
    // 別のサーバーの常時の同期は、別に動かせる
    const other = lockWatch("http://127.0.0.1:1");
    expect(other.unlock).not.toBeNull();
    other.unlock!(); first.unlock!();
    const again = lockWatch(server.url);
    expect(again.unlock).not.toBeNull();
    again.unlock!();
  });
});
