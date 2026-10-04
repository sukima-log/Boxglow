/**
 * 同期の実行 (cli/sync/client.ts) の試験: 実際のファイル・実際の状態の置き場・実際の HTTP (試験用のサーバー) を使う。
 * 2 つのフォルダを 2 台の端末に見立て (設定フォルダも別々にする)、送受信・統合・途中で落ちた場合の再開・止まる場面を確かめる
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../../src/model/graph";
import type { Project } from "../../src/model/types";
import { recoveryToken, syncOnce, SyncNetworkError, type SyncOptions, type SyncResult } from "./client";
import { bindingDir, StateStore } from "./state-store";
import { TestSyncServer } from "./test-server";

let server: TestSyncServer;
let root: string;
beforeEach(async () => { server = new TestSyncServer(); await server.start(); root = mkdtempSync(join(tmpdir(), "boxglow-sync-")); });
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });

/** 端末 1 台: 計画のファイルのフォルダと、設定フォルダ (同期の状態の置き場) を別々に持つ */
class Device {
  readonly file: string;
  readonly config: string;
  constructor(readonly name: string) {
    this.file = join(root, name, "boxglow.json");
    this.config = join(root, name + "-config");
    mkdirSync(join(root, name), { recursive: true });
  }
  /** この端末として同期する (設定フォルダを、この端末のものに切り替えてから実行する) */
  async sync(extra: Partial<SyncOptions> = {}): Promise<SyncResult> {
    process.env.BOXGLOW_CONFIG_DIR = this.config;
    return syncOnce({ file: this.file, server: server.url, ...extra });
  }
  /** 同期の状態の置き場 (試験の確認用) */
  store(): StateStore { process.env.BOXGLOW_CONFIG_DIR = this.config; return new StateStore(bindingDir(this.file, server.url)); }
  get project(): Project { return fromJSON(readFileSync(this.file, "utf8")); }
  write(p: Project) { writeFileSync(this.file, toJSON(p) + "\n"); }
  edit(change: (p: Project) => Project) { this.write(change(this.project)); }
}

/** A が計画を作って送り、B が同じ計画を受け取った状態を作る */
async function twoDevices() {
  let p = createProject("同期の試験");
  const pj = defaultTaskParent(p);
  const a = addBlock(p, { parentId: pj, title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: pj, title: "B" }); p = b.project;
  const A = new Device("a"), B = new Device("b");
  A.write(fromJSON(toJSON(p)));
  const first = await A.sync({ remoteId: "plan-1" });
  expect(first).toMatchObject({ status: "synced", pushed: 1 });
  expect(await B.sync({ remoteId: "plan-1" })).toMatchObject({ status: "synced", pulled: 1 });
  expect(readFileSync(B.file, "utf8")).toBe(readFileSync(A.file, "utf8"));
  return { A, B, a: a.blockId, b: b.blockId };
}

describe("2 つのフォルダの同期", () => {
  it("作って送る → もう 1 台が受け取る → 別々のボックスの変更は統合されて両方に届く", async () => {
    const { A, B, a, b } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    B.edit((p) => updateBlock(p, b, { title: "B 改" }));
    expect(await A.sync()).toMatchObject({ status: "synced", pushed: 1, pulled: 0 });
    expect(await B.sync()).toMatchObject({ status: "synced", pulled: 1, pushed: 1 });
    expect(await A.sync()).toMatchObject({ status: "synced", pulled: 1, pushed: 0 });
    for (const d of [A, B]) { expect(d.project.blocks[a].title).toBe("A 改"); expect(d.project.blocks[b].title).toBe("B 改"); }
    // 変わっていなければ、何も送らない・書かない
    const puts = server.puts;
    expect(await A.sync()).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
    expect(server.puts).toBe(puts);
  });
  it("同じ項目を別の値にしたら、止まる。手元のファイルもサーバーも変えない", async () => {
    const { A, B, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A の案" })); await A.sync();
    B.edit((p) => updateBlock(p, a, { title: "B の案" }));
    const before = readFileSync(B.file, "utf8"), head = server.project("plan-1")!.head!.revision;
    const r = await B.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("conflicts");
    expect(readFileSync(B.file, "utf8")).toBe(before);
    expect(server.project("plan-1")!.head!.revision).toBe(head);
  });
  it("受け取りの最中に AI が手元を書き換えても、どちらの変更も消えない (手元の書き込みの前提が違えば、やり直して統合する)", async () => {
    const { A, B, a, b } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" })); await A.sync();
    let interrupted = false;
    const r = await B.sync({ onStep: (kind) => {
      // 受け取ると決めた直後 (手元に書く前) に、AI が CLI で別のボックスを書いた
      if (kind === "pull" && !interrupted) { interrupted = true; B.edit((p) => updateBlock(p, b, { title: "AI が書いた" })); }
    } });
    expect(r).toMatchObject({ status: "synced" });
    expect(B.project.blocks[a].title).toBe("A 改");
    expect(B.project.blocks[b].title).toBe("AI が書いた");
    await A.sync();
    expect(A.project.blocks[b].title).toBe("AI が書いた");
  });
  it("同じ結び付けの同期は 1 つだけ動く (もう 1 つは待たずに busy を返す)", async () => {
    const { A } = await twoDevices();
    const unlock = A.store().lock()!;
    try { expect(await A.sync()).toEqual({ status: "busy", what: "sync" }); } finally { unlock(); }
    expect(await A.sync()).toMatchObject({ status: "synced" });
  });
});

describe("途中で失敗したときの再開", () => {
  // サーバーは受理したが、応答が届かなかった。その間に別の端末が取り消した。再開しても、取り消しを上書きしない
  it("送信の応答を失っても、同じ操作を送り直して受理を確かめる。別の端末の取り消しを上書きしない", async () => {
    const { A, B, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" }));
    server.dropNextPutResponse = true;
    await expect(A.sync()).rejects.toBeInstanceOf(SyncNetworkError);
    expect(A.store().read()!.pending?.kind).toBe("push");                 // 操作は残っている
    await B.sync();
    expect(B.project.blocks[a].title).toBe("新");                         // サーバーには届いていた
    B.edit((p) => updateBlock(p, a, { title: "A" })); await B.sync();      // B が意図して元に戻した
    const versions = server.project("plan-1")!.versions.length;
    expect(await A.sync()).toMatchObject({ status: "synced", pulled: 1 });
    expect(A.project.blocks[a].title).toBe("A");
    expect(server.project("plan-1")!.versions.length).toBe(versions);     // 「新」を送り直して版を増やしていない
    expect(A.store().read()!.pending).toBeNull();
  });
  it("サーバーが応答した直後・状態を進める前に落ちても、次の実行で続きから進む", async () => {
    const { A, B, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    await expect(A.sync({ onStep: (kind) => { if (kind === "push:sent") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(await A.sync()).toMatchObject({ status: "synced" });
    await B.sync();
    expect(B.project.blocks[a].title).toBe("A 改");
    expect(server.project("plan-1")!.versions.length).toBe(2);
  });
  // 受け取りを手元に書いた直後に落ちた → AI が別の項目を変えた → サーバーで取り消された → 再開
  it("受け取りを書いた直後に落ち、その後で手元が変わっていたら、止まって人に確かめる。「反映済み」を選べば、取り消しも AI の編集も残る", async () => {
    const { A, B, a, b } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" })); await A.sync();
    await expect(B.sync({ onStep: (kind) => { if (kind === "pull:written") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(B.project.blocks[a].title).toBe("新");                          // 手元には書けていた
    B.edit((p) => updateBlock(p, b, { description: "AI の追記" }));
    A.edit((p) => updateBlock(p, a, { title: "A" })); await A.sync();
    const stopped = await B.sync();
    expect(stopped.status === "halted" && stopped.halt.reason).toBe("recover-pull");
    const before = readFileSync(B.file, "utf8");
    // 古い印 (表示のあとで手元が変わった場合に当たる) では進まない
    expect((await B.sync({ recover: { token: "old-token", applied: true } })).status).toBe("halted");
    expect(readFileSync(B.file, "utf8")).toBe(before);
    const state = B.store().read()!;
    const token = recoveryToken(state, createHash("sha256").update(before).digest("hex"));
    expect(await B.sync({ recover: { token, applied: true } })).toMatchObject({ status: "synced" });
    await A.sync();
    for (const d of [A, B]) { expect(d.project.blocks[a].title).toBe("A"); expect(d.project.blocks[b].description).toBe("AI の追記"); }
  });
  it("受け取りを書いた直後に落ち、手元がそのままなら、次の実行は確かめずに基準を進めるだけ", async () => {
    const { A, B, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" })); await A.sync();
    await expect(B.sync({ onStep: (kind) => { if (kind === "pull:written") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(await B.sync()).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
    expect(B.store().read()!.base).toEqual(A.store().read()!.base);
  });
});

describe("確かめてから進む場面", () => {
  it("基準に在った設定が手元で消えていたら、送らずに止まる。承認の印を付ければ送る", async () => {
    const { A, B } = await twoDevices();
    const withSetting = JSON.parse(readFileSync(A.file, "utf8")); withSetting.futureSetting = { mode: "strict" };
    writeFileSync(A.file, JSON.stringify(withSetting, null, 2) + "\n");
    await A.sync(); await B.sync();
    expect(JSON.parse(readFileSync(B.file, "utf8")).futureSetting).toEqual({ mode: "strict" }); // 知らない項目も、受け取った文字列のまま届く
    const dropped = JSON.parse(readFileSync(B.file, "utf8")); delete dropped.futureSetting;
    writeFileSync(B.file, JSON.stringify(dropped, null, 2) + "\n");
    const versions = server.project("plan-1")!.versions.length;
    const r = await B.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("protected-deletion");
    expect(server.project("plan-1")!.versions.length).toBe(versions);
    if (r.status !== "halted" || r.halt.reason !== "protected-deletion") return;
    expect(r.halt.keys).toEqual(["futureSetting"]);
    expect(await B.sync({ approvedDeletion: r.halt.approval })).toMatchObject({ status: "synced", pushed: 1 });
    await A.sync();
    expect(JSON.parse(readFileSync(A.file, "utf8")).futureSetting).toBeUndefined();
  });
  it("サーバーの履歴の世代が変わったら (バックアップからの復旧)、送りの操作を捨てずに止まる", async () => {
    const { A, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    server.epoch = "e2";
    const r = await A.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    expect(A.project.blocks[a].title).toBe("A 改");
  });
  it("同じパスに別の計画 (ID が違う) が置かれていたら、同期しない", async () => {
    const { A } = await twoDevices();
    A.write(fromJSON(toJSON(createProject("別の計画"))));
    const r = await A.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("binding-mismatch");
    expect(server.project("plan-1")!.versions.length).toBe(1);
  });
  it("初めて結び付けるときに、手元とサーバーに違う中身があれば、自動では統合しない", async () => {
    const { A, a } = await twoDevices();
    const C = new Device("c");
    C.write(updateBlock(A.project, a, { title: "C の中身" }));
    const r = await C.sync({ remoteId: "plan-1" });
    expect(r.status === "halted" && r.halt.reason).toBe("first-link");
    expect(existsSync(C.file)).toBe(true);
  });
});
