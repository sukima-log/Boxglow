/**
 * 常時の同期 (cli/sync/watch.ts) の試験。時刻は試験の中で進め、tick() を手で呼ぶ (実際には待たない)。
 * ファイル・状態の置き場・HTTP (試験用のサーバー) は実物を使う
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../../src/model/graph";
import type { Project } from "../../src/model/types";
import { syncOnce } from "./client";
import { bindingDir, StateStore } from "./state-store";
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
/** 試験では、ふつうの時計 (now) と、待ち時間を測る時計 (elapsed) を、同じ値で進める (別々に動かす試験は、個別に作る) */
const watcher = (extra: Partial<ConstructorParameters<typeof SyncWatcher>[0]> = {}) =>
  new SyncWatcher({ server: server.url, now: () => clock, elapsed: () => clock, random: () => 0.5, onEvent: (e) => events.push(e), ...extra });
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
    const w = watcher({ fetch: (async (...args: Parameters<typeof fetch>) => { if (down) throw new Error("offline"); return fetch(...args); }) as typeof fetch });
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

// ---- Codex のレビュー 13 の反例 (W01〜W09 のうち、常時の同期の分) ----
describe("変更を取りこぼさない", () => {
  it("同期の最後の通信を待っている間に入った編集は、「送った」ことにせず、追加の編集が無くても送る", async () => {
    const { file, a, b } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    // 計画の中身の取得 (GET /v1/projects/p1) の 2 回目 (送った後の確認) の応答を返す直前に、別の編集を入れる
    let gets = 0;
    const w = watcher({ fetch: (async (...args: Parameters<typeof fetch>) => {
      const response = await fetch(...args);
      const method = (args[1] as RequestInit | undefined)?.method ?? "GET";
      if (method === "GET" && String(args[0]).endsWith("/v1/projects/p1") && ++gets === 3) edit(file, (p) => updateBlock(p, b, { title: "通信中の編集" }));
      return response;
    }) as typeof fetch });
    await w.tick();                                            // 最初の確認 (GET 1 回目)
    edit(file, (p) => updateBlock(p, a, { title: "1 回目の編集" }));
    await advance(w, 500); await advance(w, DEBOUNCE_MS);      // 送る (GET 2 回目 → PUT → GET 3 回目の間に、別の編集が入る)
    expect(fromJSON(server.project("p1")!.head!.text).blocks[a].title).toBe("1 回目の編集");
    expect(fromJSON(server.project("p1")!.head!.text).blocks[b].title).toBe("B");
    await advance(w, 500); await advance(w, DEBOUNCE_MS);      // 追加の編集は無い
    expect(fromJSON(server.project("p1")!.head!.text).blocks[b].title).toBe("通信中の編集");
  });
  it("更新時刻も大きさも同じ書き換えは、サーバーを確かめるときの中身の照合で拾って送る", async () => {
    const { file, a } = planFile("p1");
    edit(file, (p) => updateBlock(p, a, { title: "AA" }));
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    const w = watcher(); await w.tick();
    const before = statSync(file);
    writeFileSync(file, readFileSync(file, "utf8").replace('"AA"', '"BB"'));
    utimesSync(file, before.atime, before.mtime);              // 更新時刻を元に戻す (大きさも同じ)
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    await advance(w, 5000);
    expect(fromJSON(server.project("p1")!.head!.text).blocks[a].title).toBe("AA"); // まだ気づいていない
    await advance(w, POLL_MS); await advance(w, DEBOUNCE_MS);
    expect(fromJSON(server.project("p1")!.head!.text).blocks[a].title).toBe("BB");
  });
  it("PC の時計が巻き戻っても、待っていた変更を 2 秒後に送る。操作の記録に残る日時は、ふつうの時計のもの", async () => {
    const { file, a } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    let wall = Date.parse("2026-10-04T12:00:00.000Z");
    const w = watcher({ now: () => wall });
    await w.tick();
    edit(file, (p) => updateBlock(p, a, { title: "巻き戻りの前の編集" }));
    await advance(w, 500);
    wall -= 1_000_000;                                         // ふつうの時計だけが、大きく巻き戻る
    await advance(w, DEBOUNCE_MS);
    expect(fromJSON(server.project("p1")!.head!.text).blocks[a].title).toBe("巻き戻りの前の編集");
  });
});

describe("止まった計画と、読めない状態", () => {
  it("手元がそのままでも、サーバーが進んで選択肢と印が変わったら、もう一度知らせる。同じ内容は繰り返さない", async () => {
    const { file, a } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    const w = watcher(); await w.tick();
    await remoteEdit("p1", (p) => updateBlock(p, a, { title: "サーバーの案 1" }));
    edit(file, (p) => updateBlock(p, a, { title: "手元の案" }));
    await advance(w, POLL_MS + 1000);
    const halts = () => events.filter((e) => e.kind === "halted").map((e) => e.kind === "halted" && e.result.halt.reason === "conflicts" ? e.result.halt.token : "?");
    expect(halts().length).toBe(1);
    await remoteEdit("p1", (p) => updateBlock(p, a, { title: "サーバーの案 2" }));
    await advance(w, POLL_MS + 1000);
    expect(halts().length).toBe(2);
    expect(halts()[1]).not.toBe(halts()[0]);                   // 新しい印
    for (let i = 0; i < 3; i++) await advance(w, POLL_MS + 1000);
    expect(halts().length).toBe(2);
  });
  it("見張っている計画の状態が読めなくなったら、黙って外さずに 1 回知らせる。ほかの計画は続け、直ったら再開する", async () => {
    const one = planFile("p1"), two = planFile("p2");
    await syncOnce({ file: one.file, server: server.url, remoteId: "p1" });
    await syncOnce({ file: two.file, server: server.url, remoteId: "p2" });
    const w = watcher(); await w.tick();
    const statePath = join(bindingDir(one.file, server.url), "state.json");
    const good = readFileSync(statePath, "utf8");
    writeFileSync(statePath, "{ 壊れた");
    await advance(w, 1000); await advance(w, 1000);
    const errors = () => events.filter((e) => e.kind === "error" && e.file === one.file).length;
    expect(errors()).toBe(1);
    expect(w.files().sort()).toEqual([one.file, two.file].sort());
    edit(two.file, (p) => updateBlock(p, two.a, { title: "p2 は続く" }));
    await advance(w, 500); await advance(w, DEBOUNCE_MS);
    expect(fromJSON(server.project("p2")!.head!.text).blocks[two.a].title).toBe("p2 は続く");
    // 直す → 再開して、止まっている間の変更も送る
    edit(one.file, (p) => updateBlock(p, one.a, { title: "直った後に送る" }));
    writeFileSync(statePath, good);
    await advance(w, 1000); await advance(w, DEBOUNCE_MS);
    expect(fromJSON(server.project("p1")!.head!.text).blocks[one.a].title).toBe("直った後に送る");
    expect(errors()).toBe(1);
  });
});

describe("通信の本文の失敗・読み取りの量", () => {
  it("一覧の本文が読めない・形が合わないときも、常時の同期は止まらず、通信の失敗としてやり直す", async () => {
    const { file, a } = planFile("p1");
    await syncOnce({ file, server: server.url, remoteId: "p1" });
    const bad: (string | null)[] = ["{ not json", JSON.stringify({ not: "a list" }), JSON.stringify([{ id: "p1", revision: 3, deleted: false }])];
    const w = watcher({ fetch: (async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).endsWith("/v1/projects") && bad.length > 0) return new Response(bad.shift(), { status: 200, headers: { "x-boxglow-epoch": "e1" } });
      return fetch(...args);
    }) as typeof fetch });
    await expect(w.tick()).resolves.toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: "network", retryInMs: 5000 });
    await advance(w, 6000); await advance(w, 11_000);           // 残りの 2 つの壊れた応答
    expect(events.filter((e) => e.kind === "network").length).toBe(3);
    edit(file, (p) => updateBlock(p, a, { title: "回復した後に送る" }));
    await advance(w, 21_000); await advance(w, DEBOUNCE_MS);
    expect(fromJSON(server.project("p1")!.head!.text).blocks[a].title).toBe("回復した後に送る");
  });
  it("変化の無い確認では、状態の読み取りは計画の数に比例する (計画の数の 2 乗にならない)", async () => {
    const count = (n: number) => async () => {
      for (let i = 0; i < n; i++) { const p = planFile(`q${n}-${i}`); await syncOnce({ file: p.file, server: server.url, remoteId: `q${n}-${i}` }); }
      const w = watcher(); await w.tick();
      const spy = vi.spyOn(StateStore.prototype, "read");
      await advance(w, POLL_MS + 1000);
      const reads = spy.mock.calls.length; spy.mockRestore();
      return reads;
    };
    const five = await count(5)();
    process.env.BOXGLOW_CONFIG_DIR = join(root, "config-10");
    const ten = await count(10)();
    expect(five).toBeLessThanOrEqual(5 * 2);
    expect(ten).toBeLessThanOrEqual(10 * 2);
  });
});
