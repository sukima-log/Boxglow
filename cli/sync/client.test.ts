/**
 * 同期の実行 (cli/sync/client.ts) の試験: 実際のファイル・実際の状態の置き場・実際の HTTP (試験用のサーバー) を使う。
 * 2 つのフォルダを 2 台の端末に見立て (設定フォルダも別々にする)、送受信・統合・途中で落ちた場合の再開・止まる場面を確かめる
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../../src/model/graph";
import type { Project } from "../../src/model/types";
import { recoveryToken, syncOnce, SyncAuthError, SyncNetworkError, type SyncOptions, type SyncResult } from "./client";
import { bindingDir, bindingsOf, StateStore, SyncStateUnreadable } from "./state-store";
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
    // 止まった結果には、選ぶための印と、2 つの続け方それぞれの「選んだ後の結果」が付いている
    if (stopped.status !== "halted" || !stopped.recovery) throw new Error("expected a recovery preview");
    expect(stopped.recovery.token).toBe(recoveryToken(B.store().read()!, createHash("sha256").update(before).digest("hex"), { epoch: "e1", revision: server.project("plan-1")!.head!.revision }));
    expect(stopped.recovery.applied).toMatchObject({ next: "push", localChanges: ["ボックス「A」の title が変わる"], remoteChanges: ["ボックス「B」の description が変わる"] });
    expect(stopped.recovery.notApplied.next).toBe("push");
    expect(await B.sync({ recover: { token: stopped.recovery.token, applied: true } })).toMatchObject({ status: "synced" });
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

describe("人の選択で進める (実際のファイルで)", () => {
  it("競合を、表示した印と向きで決められる。決めた結果が両方の端末に届く", async () => {
    const { A, B, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A の案" })); await A.sync();
    B.edit((p) => updateBlock(p, a, { title: "B の案" }));
    const r = await B.sync();
    if (r.status !== "halted" || r.halt.reason !== "conflicts") throw new Error("expected conflicts");
    expect(await B.sync({ resolution: { token: r.halt.token, prefer: "remote" } })).toMatchObject({ status: "synced" });
    expect(B.project.blocks[a].title).toBe("A の案");
  });
  it("消えた設定を戻す: 手元のファイルに設定だけが戻り、その後は確かめずに同期できる", async () => {
    const { A, B, a } = await twoDevices();
    const withSetting = JSON.parse(readFileSync(A.file, "utf8")); withSetting.futureSetting = { mode: "strict" };
    writeFileSync(A.file, JSON.stringify(withSetting, null, 2) + "\n");
    await A.sync(); await B.sync();
    const dropped = JSON.parse(readFileSync(B.file, "utf8")); delete dropped.futureSetting; dropped.blocks[a].title = "同時の編集";
    writeFileSync(B.file, JSON.stringify(dropped, null, 2) + "\n");
    const r = await B.sync();
    if (r.status !== "halted" || r.halt.reason !== "protected-deletion") throw new Error("expected a halt");
    expect(await B.sync({ restoreDeletion: r.halt.approval })).toMatchObject({ status: "synced", pushed: 1 });
    const after = JSON.parse(readFileSync(B.file, "utf8"));
    expect(after.futureSetting).toEqual({ mode: "strict" });
    expect(after.blocks[a].title).toBe("同時の編集");
  });
  it("初めての結び付けでサーバーの側を採ると、手元を置き換える前に、前の中身を同じフォルダへ退避する", async () => {
    const { A, a } = await twoDevices();
    const C = new Device("c");
    C.write(updateBlock(A.project, a, { title: "C の中身" }));
    const mine = readFileSync(C.file, "utf8");
    const r = await C.sync({ remoteId: "plan-1" });
    if (r.status !== "halted" || r.halt.reason !== "first-link") throw new Error("expected first-link");
    expect(await C.sync({ remoteId: "plan-1", firstLink: { token: r.halt.token, prefer: "remote" } })).toMatchObject({ status: "synced", pulled: 1 });
    expect(readFileSync(C.file, "utf8")).toBe(readFileSync(A.file, "utf8"));
    const backups = readdirSync(join(root, "c")).filter((n) => n.includes(".before-sync-"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(root, "c", backups[0]), "utf8")).toBe(mine);
  });
});

describe("boxglow sync コマンド", () => {
  /**
   * CLI を、この端末の設定フォルダで実行する (非同期。試験用のサーバーが同じプロセスの中で動いているので、同期で待つと応答できない)
   * Output: 終了コードと標準出力
   */
  const run = (d: Device, ...args: string[]) => new Promise<{ status: number | null; stdout: string }>((done) => {
    const child = spawn(process.execPath, ["bin/boxglow.js", "sync", ...args, "--file", d.file, "--lang", "ja"]
    , { env: { ...process.env, BOXGLOW_CONFIG_DIR: d.config, BOXGLOW_SERVER: "", BOXGLOW_TOKEN: "" } });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.on("exit", (status) => done({ status, stdout }));
  });
  it("競合で止まると、終了コード 2 で、項目と、手元 / サーバーに決めるコマンドを表示する。そのコマンドで進められる", async () => {
    const { A, B, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A の案" })); await A.sync();
    B.edit((p) => updateBlock(p, a, { title: "B の案" }));
    const stopped = await run(B);
    expect(stopped.status).toBe(2);
    expect(stopped.stdout).toContain(`blocks.${a}.title`);
    const command = /boxglow sync (--resolve \S+ --prefer local)/.exec(stopped.stdout);
    expect(command).not.toBeNull();
    const done = await run(B, ...command![1].split(" "));
    expect(done.status).toBe(0);
    expect(B.project.blocks[a].title).toBe("B の案");
  }, 30_000);
  it("知らない指定は、黙って 1 回の同期として実行せずに断る", async () => {
    const { A } = await twoDevices();
    const puts = server.puts;
    const r = await run(A, "--push-all");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("--push-all");
    expect(server.puts).toBe(puts);
  }, 30_000);
  it("結び付けの無い計画で、サーバーの指定なしに実行すると、結び付け方を案内して失敗する", async () => {
    const lone = new Device("lone");
    lone.write(fromJSON(toJSON(createProject("まだ結び付けていない"))));
    const r = await run(lone);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("boxglow sync --server");
  }, 30_000);
});

// ---- Codex のレビュー 11 の反例 (U01〜U09) ----
describe("結び付けを取り違えない", () => {
  it("初めての受け取りが途中で終わっても、計画の ID は結び付けに固定されている。後で同じパスに別の計画を置いても、送らない", async () => {
    const { A } = await twoDevices();
    const C = new Device("c");
    await expect(C.sync({ remoteId: "plan-1", onStep: (kind) => { if (kind === "pull:written") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(await C.sync()).toMatchObject({ status: "synced" });           // 書けていたので、基準を進めるだけ
    expect(C.store().read()!.binding.planId).toBe(A.project.id);
    C.write(fromJSON(toJSON(createProject("別の計画"))));
    const r = await C.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("binding-mismatch");
    expect(server.project("plan-1")!.versions.length).toBe(1);
  });
  it("結び付けた後で、違う --project を指定したら、指定と違う計画へ黙って書かずに止まる", async () => {
    const { A, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    const r = await A.sync({ remoteId: "another-plan" });
    expect(r).toMatchObject({ status: "halted", halt: { reason: "binding-target", bound: "plan-1", requested: "another-plan" } });
    expect(server.project("plan-1")!.versions.length).toBe(1);
    expect(server.project("another-plan")).toBeUndefined();
  });
  it("1 つのファイルを、2 つのサーバーへは結び付けない", async () => {
    const { A } = await twoDevices();
    const second = new TestSyncServer(); const url = await second.start();
    try {
      process.env.BOXGLOW_CONFIG_DIR = A.config;
      const r = await syncOnce({ file: A.file, server: url });
      expect(r).toMatchObject({ status: "halted", halt: { reason: "bound-elsewhere", server: server.url } });
      expect(second.puts).toBe(0);
    } finally { await second.stop(); }
  });
  it("まだ無いファイルを、シンボリックリンクのフォルダ経由で受け取っても、次の実行は同じ結び付けを使う (計画を二重に作らない)", async () => {
    await twoDevices();
    const real = join(root, "real"); mkdirSync(real);
    symlinkSync(real, join(root, "alias"), "dir");
    process.env.BOXGLOW_CONFIG_DIR = join(root, "alias-config");
    const viaAlias = join(root, "alias", "boxglow.json");
    expect(await syncOnce({ file: viaAlias, server: server.url, remoteId: "plan-1" })).toMatchObject({ status: "synced", pulled: 1 });
    expect(await syncOnce({ file: viaAlias, server: server.url })).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
    expect(await syncOnce({ file: join(real, "boxglow.json"), server: server.url })).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
    expect(server.projects.size).toBe(1);
    expect(bindingsOf(viaAlias).bindings.length).toBe(1);
  });
});

describe("復旧の選択は、サーバーを確かめてから", () => {
  /** B が受け取りを書いた直後に落ち、その後で手元が変わって、復旧待ちになった状態を作る */
  const waiting = async () => {
    const { A, B, a, b } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "新" })); await A.sync();
    await expect(B.sync({ onStep: (kind) => { if (kind === "pull:written") throw new Error("crash"); } })).rejects.toThrow("crash");
    B.edit((p) => updateBlock(p, b, { description: "AI の追記" }));
    const stopped = await B.sync();
    if (stopped.status !== "halted" || !stopped.recovery) throw new Error("expected a recovery halt");
    return { A, B, a, token: stopped.recovery.token };
  };
  it("表示のあとでサーバーの履歴の世代が変わったら、前の印で進めない。やりかけの操作は残る", async () => {
    const { B, token } = await waiting();
    server.epoch = "e2";
    const r = await B.sync({ recover: { token, applied: true } });
    expect(r.status).toBe("halted");
    expect(B.store().read()!.pending?.kind).toBe("pull");
  });
  it("表示のあとでサーバーが進んだら、前の印で進めず、新しい印で表示し直す", async () => {
    const { A, B, a, token } = await waiting();
    A.edit((p) => updateBlock(p, a, { title: "さらに変更" })); await A.sync();
    const r = await B.sync({ recover: { token, applied: true } });
    if (r.status !== "halted" || !r.recovery) throw new Error("expected a recovery halt");
    expect(r.recovery.token).not.toBe(token);
    expect(B.store().read()!.pending?.kind).toBe("pull");
    expect(await B.sync({ recover: { token: r.recovery.token, applied: true } })).toMatchObject({ status: "synced" });
  });
});

describe("状態の置き場", () => {
  it("state.json のやりかけの操作が読めない形なら、「同期済み」にせず、読めないと知らせる", async () => {
    const { A } = await twoDevices();
    const path = join(A.store().dir, "state.json");
    const state = JSON.parse(readFileSync(path, "utf8"));
    for (const broken of [{ ...state, pending: { kind: "unexpected", hash: "missing" } }, { ...state, base: { hash: 1 } }, { ...state, generation: "3" }, { ...state, binding: { file: A.file } }]) {
      writeFileSync(path, JSON.stringify(broken));
      await expect(A.sync()).rejects.toBeInstanceOf(SyncStateUnreadable);
    }
    writeFileSync(path, JSON.stringify(state));
    expect(await A.sync()).toMatchObject({ status: "synced" });
  });
  it("結び付けは、各フォルダの state.json から見つける (索引のファイルに頼らない)。読めない状態のフォルダは、無いものとせずに知らせる", async () => {
    const { A } = await twoDevices();
    process.env.BOXGLOW_CONFIG_DIR = A.config;
    expect(bindingsOf(A.file).bindings.map((b) => b.remoteId)).toEqual(["plan-1"]);
    expect(existsSync(join(A.config, "sync", "bindings.json"))).toBe(false);
    writeFileSync(join(A.store().dir, "state.json"), "{ 壊れた");
    process.env.BOXGLOW_CONFIG_DIR = A.config;
    const found = bindingsOf(A.file);
    expect(found.bindings).toEqual([]);
    expect(found.unreadable.length).toBe(1);
  });
  it("壊れた写しが既にあっても、置き直して、返したハッシュの中身を読み戻せる", async () => {
    const { A } = await twoDevices();
    const store = A.store();
    const hash = store.putObject("写しの中身\n");
    writeFileSync(join(store.dir, "objects", hash), "壊れた");
    expect(store.getObject(hash)).toBeNull();
    expect(store.putObject("写しの中身\n")).toBe(hash);
    expect(store.getObject(hash)).toBe("写しの中身\n");
  });
  it("受け取りを書いた後で別の確認で止まったときは、「何も変えていない」とは報告しない (行ったことを数える)", async () => {
    const { A, B, a, b } = await twoDevices();
    const withSetting = JSON.parse(readFileSync(A.file, "utf8")); withSetting.futureSetting = 1;
    writeFileSync(A.file, JSON.stringify(withSetting, null, 2) + "\n");
    await A.sync(); await B.sync();
    A.edit((p) => updateBlock(p, a, { description: "サーバー側の変更" })); await A.sync();
    const local = JSON.parse(readFileSync(B.file, "utf8")); delete local.futureSetting; local.blocks[b].title = "手元の変更";
    writeFileSync(B.file, JSON.stringify(local, null, 2) + "\n");
    const r = await B.sync();
    expect(r).toMatchObject({ status: "halted", halt: { reason: "protected-deletion" }, pulled: 1, pushed: 0 });
    expect(B.project.blocks[a].description).toBe("サーバー側の変更");   // 統合した結果は、手元に書かれている
  });
});

describe("試験用のサーバーの約束", () => {
  const put = (text: string, headers: Record<string, string>) => server.put("contract", text, headers);
  it("同じ中身の送信は版を増やさない (前提の版は確かめる)。世代の指定と、計画としての検査が必須", async () => {
    const { A } = await twoDevices();
    const text = readFileSync(A.file, "utf8");
    const project = () => server.project("contract")!;
    expect(put(text, { "x-boxglow-op": "op1", "x-boxglow-epoch": "e1", "if-none-match": "*" }).status).toBe(201);
    // 同じ中身・正しい前提・新しい操作: 今の版を結果にして、履歴は増やさない
    expect(put(text, { "x-boxglow-op": "op2", "x-boxglow-epoch": "e1", "if-match": '"e1.1"' })).toMatchObject({ status: 200, revision: "e1.1" });
    expect(project().versions.length).toBe(1);
    // 同じ中身でも、前提の版が古ければ断る
    const changed = text.replace("同期の試験", "同期の試験 2");
    expect(put(changed, { "x-boxglow-op": "op3", "x-boxglow-epoch": "e1", "if-match": '"e1.1"' }).status).toBe(200);
    expect(put(changed, { "x-boxglow-op": "op4", "x-boxglow-epoch": "e1", "if-match": '"e1.1"' }).status).toBe(412);
    // 世代の指定が無い・計画として不正な中身は受け付けない
    expect(put(text, { "x-boxglow-op": "op5", "if-match": '"e1.2"' }).status).toBe(428);
    expect(put("{}", { "x-boxglow-op": "op6", "x-boxglow-epoch": "e1", "if-match": '"e1.2"' }).status).toBe(400);
    // 消した計画には、前に受理した操作の送り直しも受け付けない
    project().deleted = true;
    expect(put(text, { "x-boxglow-op": "op1", "x-boxglow-epoch": "e1", "if-none-match": "*" }).status).toBe(410);
  });
});

// 実際に複数のプロセスを同時に動かす (順序は固定していない。何度か繰り返して、変更の取りこぼしと状態の食い違いが無いことを確かめる)
describe("複数のプロセスを同時に動かす", () => {
  /** CLI を非同期に実行する (args[0] がコマンド) */
  const cli = (d: Device, ...args: string[]) => new Promise<number | null>((done) => {
    const child = spawn(process.execPath, ["bin/boxglow.js", ...args, "--file", d.file, "--lang", "ja", "--actor", "human"]
    , { stdio: "ignore", env: { ...process.env, BOXGLOW_CONFIG_DIR: d.config, BOXGLOW_SERVER: "", BOXGLOW_TOKEN: "", BOXGLOW_FILE: "" } });
    child.on("exit", (status) => done(status));
  });
  it("同じ結び付けの sync を 3 つ同時に動かしても、状態は読める形のまま、手元とサーバーがそろう", async () => {
    const { A, B, a } = await twoDevices();
    B.edit((p) => updateBlock(p, a, { title: "B 改" })); await B.sync();
    A.edit((p) => updateBlock(p, a, { description: "A の説明" }));
    const codes = await Promise.all([cli(A, "sync"), cli(A, "sync"), cli(A, "sync")]);
    expect(codes.every((c) => c === 0)).toBe(true);
    await cli(A, "sync");
    const state = A.store().read()!;
    expect(state.pending).toBeNull();
    expect(readFileSync(A.file, "utf8")).toBe(server.project("plan-1")!.head!.text);
    expect(A.project.blocks[a]).toMatchObject({ title: "B 改", description: "A の説明" });
  }, 60_000);
  it("sync の最中に CLI が手元を書き換えることを繰り返しても、どの変更も消えない", async () => {
    const { A, B, a, b } = await twoDevices();
    for (let i = 1; i <= 4; i++) {
      B.edit((p) => updateBlock(p, b, { title: `B の ${i} 回目` })); await B.sync();
      // A では、同期と、CLI での書き込み (進捗の記録) を同時に走らせる
      const codes = await Promise.all([cli(A, "sync"), cli(A, "set", a, "--progress", String(i * 10)), cli(A, "sync")]);
      expect(codes[1]).toBe(0);
    }
    await cli(A, "sync"); await cli(A, "sync");
    await B.sync();
    for (const d of [A, B]) { expect(d.project.blocks[b].title).toBe("B の 4 回目"); expect(d.project.blocks[a].progress).toBe(40); }
    expect(A.store().read()!.pending).toBeNull();
    expect(readFileSync(A.file, "utf8")).toBe(readFileSync(B.file, "utf8"));
  }, 120_000);
  it("同じ設定フォルダで、別々の計画の sync を同時に動かしても、両方の結び付けが残る", async () => {
    const shared = join(root, "shared-config");
    const X = new Device("x"), Y = new Device("y");
    (X as { config: string }).config = shared; (Y as { config: string }).config = shared;
    X.write(fromJSON(toJSON(createProject("計画 X")))); Y.write(fromJSON(toJSON(createProject("計画 Y"))));
    const codes = await Promise.all([cli(X, "sync", "--server", server.url, "--project", "x-plan"), cli(Y, "sync", "--server", server.url, "--project", "y-plan")]);
    expect(codes).toEqual([0, 0]);
    process.env.BOXGLOW_CONFIG_DIR = shared;
    expect(bindingsOf(X.file).bindings.map((b) => b.remoteId)).toEqual(["x-plan"]);
    expect(bindingsOf(Y.file).bindings.map((b) => b.remoteId)).toEqual(["y-plan"]);
  }, 60_000);
});

// ---- Codex のレビュー 12 の反例 (V01〜V06) ----
describe("初回の選択と結び付け", () => {
  /** サーバーに計画 1 つ (ID = id) を置く。中身は題名だけ違う */
  const seed = async (id: string, title: string) => {
    const d = new Device("seed-" + id);
    let p = createProject("初回の選択の試験"); const pj = defaultTaskParent(p); p = addBlock(p, { parentId: pj, title }).project;
    d.write(fromJSON(toJSON(p)));
    expect(await d.sync({ remoteId: id })).toMatchObject({ status: "synced" });
    return d;
  };
  it("ある計画を見て得た選択の印は、別の計画には使えない (見ていない計画を上書きしない)", async () => {
    await seed("seen", "見た計画"); await seed("unseen", "見ていない計画");
    const C = new Device("c"); C.write(fromJSON(toJSON(createProject("手元の計画"))));
    const r = await C.sync({ remoteId: "seen" });
    if (r.status !== "halted" || r.halt.reason !== "first-link") throw new Error("expected first-link");
    const before = server.project("unseen")!.head!.text;
    const wrong = await C.sync({ remoteId: "unseen", firstLink: { token: r.halt.token, prefer: "local" } });
    expect(wrong.status).toBe("halted");
    expect(server.project("unseen")!.head!.text).toBe(before);
  });
  it("選択つきで実行したのに、選択待ちの状態に当たらなかったら (対象の指定が抜けた)、新しい計画を作らずに止まる", async () => {
    await seed("seen", "見た計画");
    const C = new Device("c"); C.write(fromJSON(toJSON(createProject("手元の計画"))));
    const r = await C.sync({ remoteId: "seen" });
    if (r.status !== "halted" || r.halt.reason !== "first-link") throw new Error("expected first-link");
    expect(r.target).toMatchObject({ server: server.url, remoteId: "seen" });   // 表示するコマンドに付ける対象
    const count = server.projects.size;
    const missed = await C.sync({ firstLink: { token: r.halt.token, prefer: "remote" } }); // --project が抜けた
    expect(missed).toMatchObject({ status: "halted", halt: { reason: "choice-not-applied", choice: "firstLink" } });
    expect(server.projects.size).toBe(count);
    expect(fromJSON(readFileSync(C.file, "utf8")).name).toBe("手元の計画");
  });
  it("計画の ID が違う初回の受け取りの途中で、手元が別の計画に書き換えられたら、書かずに、初回の選択に戻る", async () => {
    await seed("seen", "見た計画");
    const C = new Device("c"); C.write(fromJSON(toJSON(createProject("手元の計画"))));
    const r = await C.sync({ remoteId: "seen" });
    if (r.status !== "halted" || r.halt.reason !== "first-link") throw new Error("expected first-link");
    // 受け取ると決めた直後 (手元に書く前) に、手元のファイルが別の計画に書き換えられた → 前提が違うので、書き込みは行われない
    await C.sync({ remoteId: "seen", firstLink: { token: r.halt.token, prefer: "remote" }, onStep: (kind) => {
      if (kind === "pull") C.write(fromJSON(toJSON(createProject("割り込んだ別の計画"))));
    } });
    expect(fromJSON(readFileSync(C.file, "utf8")).name).toBe("割り込んだ別の計画");   // 上書きしていない
    expect(C.store().read()?.binding.pendingPlanId).toBeUndefined();              // 仮の ID は捨てられている
    // 結び付けは成立していないので、今の手元の計画について、改めて初回の選択になる
    const again = await C.sync({ remoteId: "seen" });
    expect(again.status === "halted" && again.halt.reason).toBe("first-link");
  });
  it("受け取りを記録した後・書く前に落ちた場合も、「反映されていない」を選べば、結び付けの ID は元のままで、初回の選択に戻る", async () => {
    await seed("seen", "見た計画");
    const C = new Device("c"); C.write(fromJSON(toJSON(createProject("手元の計画"))));
    const mine = fromJSON(readFileSync(C.file, "utf8")).id;
    const r = await C.sync({ remoteId: "seen" });
    if (r.status !== "halted" || r.halt.reason !== "first-link") throw new Error("expected first-link");
    // 記録の直後に落ちたことにする: 状態の置き場を、受け取りを記録した直後の形にする (書き込みは行われていない)
    const store = C.store(); const unlock = store.lock()!;
    const remoteText = server.project("seen")!.head!.text;
    const hash = store.putObject(remoteText);
    store.write({ version: 1, generation: 1, epoch: "e1", base: null
    , pending: { kind: "pull", hash, expectedLocal: createHash("sha256").update(readFileSync(C.file, "utf8")).digest("hex"), remote: { hash, revision: "e1.1" }, at: new Date().toISOString() }
    , binding: { file: C.file, server: server.url, remoteId: "seen", planId: mine, pendingPlanId: fromJSON(remoteText).id } }, null);
    unlock();
    const stopped = await C.sync();
    if (stopped.status !== "halted" || !stopped.recovery) throw new Error("expected a recovery halt");
    expect(stopped.recovery.notApplied.next).toBe("first-link");           // 見比べの表示と…
    const after = await C.sync({ recover: { token: stopped.recovery.token, applied: false } });
    expect(after.status === "halted" && after.halt.reason).toBe("first-link"); // …実際の動きが一致する
    expect(C.store().read()!.binding).toMatchObject({ planId: mine });
    expect(C.store().read()!.binding.pendingPlanId).toBeUndefined();
    // 「反映済み」を選んだ場合は、書く予定だった計画の ID が確定する (こちらは手元が違うので、次の確認で止まる)
  });
  it("同じファイルを、別々のサーバーへ同時に結び付けようとしても、成立するのは片方だけ", async () => {
    const second = new TestSyncServer(); const url = await second.start();
    try {
      const C = new Device("c"); C.write(fromJSON(toJSON(createProject("手元の計画"))));
      process.env.BOXGLOW_CONFIG_DIR = C.config;
      // 片方の最初の取得を待たせている間に、もう片方を始める
      let release: () => void = () => {};
      const gate = new Promise<void>((done) => { release = done; });
      const slowFetch = (async (...args: Parameters<typeof fetch>) => { await gate; return fetch(...args); }) as typeof fetch;
      const first = syncOnce({ file: C.file, server: server.url, fetch: slowFetch });
      const other = await syncOnce({ file: C.file, server: url });
      expect(other).toEqual({ status: "busy", what: "sync" });              // 同じファイルの同期が動いている間は、進めない
      release();
      expect(await first).toMatchObject({ status: "synced" });
      expect(await syncOnce({ file: C.file, server: url })).toMatchObject({ status: "halted", halt: { reason: "bound-elsewhere" } });
      expect(bindingsOf(C.file).bindings.map((b) => b.server)).toEqual([server.url]);
      expect(second.puts).toBe(0);
    } finally { await second.stop(); }
  });
  it("状態を読めない結び付けがあるときは、別のサーバーを指定しても、新しい結び付けを作らない", async () => {
    const { A } = await twoDevices();
    writeFileSync(join(A.store().dir, "state.json"), "{ 壊れた");
    const second = new TestSyncServer(); const url = await second.start();
    try {
      process.env.BOXGLOW_CONFIG_DIR = A.config;
      const r = await syncOnce({ file: A.file, server: url });
      expect(r).toMatchObject({ status: "halted", halt: { reason: "unreadable-bindings" } });
      expect(second.puts).toBe(0);
    } finally { await second.stop(); }
  });
  it("設定を戻した後で別の理由で止まったときは、「何も変えていない」とは報告しない (手元の編集を数える)", async () => {
    const { A, B, a } = await twoDevices();
    const withSetting = JSON.parse(readFileSync(A.file, "utf8")); withSetting.futureSetting = 1;
    writeFileSync(A.file, JSON.stringify(withSetting, null, 2) + "\n");
    await A.sync(); await B.sync();
    const dropped = JSON.parse(readFileSync(B.file, "utf8")); delete dropped.futureSetting; dropped.blocks[a].title = "B の案";
    writeFileSync(B.file, JSON.stringify(dropped, null, 2) + "\n");
    const r = await B.sync();
    if (r.status !== "halted" || r.halt.reason !== "protected-deletion") throw new Error("expected a halt");
    // 設定を戻す実行の途中で、サーバーが競合する値へ進む
    let moved = false;
    const result = await B.sync({ restoreDeletion: r.halt.approval, onStep: (kind) => {
      if (kind === "edit-local" && !moved) { moved = true; const d = JSON.parse(server.project("plan-1")!.head!.text); d.blocks[a].title = "サーバーの案"; server.put("plan-1", JSON.stringify(d, null, 2) + "\n", { "x-boxglow-op": "race", "x-boxglow-epoch": "e1", "if-match": `"${server.project("plan-1")!.head!.revision}"` }); }
    } });
    expect(result).toMatchObject({ status: "halted", halt: { reason: "conflicts" }, edited: 1, pulled: 0, pushed: 0 });
    expect(JSON.parse(readFileSync(B.file, "utf8")).futureSetting).toBe(1);
  });
});

describe("利用者を確かめられないとき", () => {
  it("サーバーが 401 を返したら、通信の失敗とは別の例外にする (待っても直らないので、案内を分ける)。やりかけの操作は残る", async () => {
    const { A, a } = await twoDevices();
    A.edit((p) => updateBlock(p, a, { title: "A 改" }));
    const denied = (async () => new Response("{}", { status: 401, headers: { "x-boxglow-epoch": "e1" } })) as typeof fetch;
    await expect(A.sync({ fetch: denied })).rejects.toBeInstanceOf(SyncAuthError);
    expect(A.project.blocks[a].title).toBe("A 改");
    expect(await A.sync()).toMatchObject({ status: "synced", pushed: 1 });
  });
});
