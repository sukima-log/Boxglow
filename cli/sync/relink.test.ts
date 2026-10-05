/**
 * 結び直し (サーバーの履歴の世代が変わった後に、人が見比べて選ぶ) の試験
 * 実際のファイル・実際の状態の置き場・実際の HTTP (試験用のサーバー) を使う。復旧は「世代を変えて、計画を前の中身に戻す / 無くす」で模す
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../../src/model/graph";
import type { Project } from "../../src/model/types";
import { syncOnce, type SyncOptions, type SyncResult } from "./client";
import { bindingDir, StateStore, stateProblem, SyncStateUnreadable } from "./state-store";
import { decide, type SyncInput } from "../../src/sync/engine";
import { runSyncCommand } from "./command";
import { TestSyncServer } from "./test-server";

let server: TestSyncServer;
let root: string;
beforeEach(async () => { server = new TestSyncServer(); await server.start(); root = mkdtempSync(join(tmpdir(), "boxglow-relink-")); });
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** 端末 1 台 (計画のファイルのフォルダと、設定フォルダを別々に持つ) */
class Device {
  readonly file: string;
  readonly config: string;
  constructor(readonly name: string) {
    this.file = join(root, name, "boxglow.json");
    this.config = join(root, name + "-config");
    mkdirSync(join(root, name), { recursive: true });
  }
  async sync(extra: Partial<SyncOptions> = {}): Promise<SyncResult> {
    process.env.BOXGLOW_CONFIG_DIR = this.config;
    return syncOnce({ file: this.file, server: server.url, ...extra });
  }
  store(): StateStore { process.env.BOXGLOW_CONFIG_DIR = this.config; return new StateStore(bindingDir(this.file, server.url)); }
  get text(): string { return readFileSync(this.file, "utf8"); }
  get project(): Project { return fromJSON(this.text); }
  edit(change: (p: Project) => Project) { writeFileSync(this.file, toJSON(change(this.project)) + "\n"); }
  /** 控えのフォルダの一覧 (完了したもの / 途中のもの) */
  backups(): string[] { const dir = join(this.store().dir, "relinks"); return existsSync(dir) ? readdirSync(dir).sort() : []; }
}

/**
 * サーバーを「復旧した」状態にする: 世代を変え、計画を指定の中身に戻す (null なら、計画がまだ無かった時点へ)
 * Input : epoch = 新しい世代, text = 戻す先の中身 (null = 計画が無い)
 */
function restoreServer(epoch: string, text: string | null): void {
  server.epoch = epoch;
  if (text === null) { server.projects.delete("plan-1"); return; }
  const p = server.project("plan-1")!;
  p.head = { revision: `${epoch}.1`, text };
  p.seq = 1; p.ops = new Map(); p.versions = [{ revision: `${epoch}.1`, hash: sha(text) }];
}

/**
 * A が作って送り、B が受け取り、A が版 2 を送った後で、サーバーを版 1 の中身に復旧した状態を作る
 * Output: A (手元 = 版 2 の中身 + まだ送っていない編集), B (手元 = 版 1 の中身), v1 = 復旧先の中身, a = ボックスの id
 */
async function restored(options: { to?: "v1" | "absent"; unsent?: boolean } = {}) {
  let p = createProject("結び直しの試験");
  const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
  const A = new Device("a"), B = new Device("b");
  writeFileSync(A.file, toJSON(fromJSON(toJSON(p))) + "\n");
  expect(await A.sync({ remoteId: "plan-1" })).toMatchObject({ status: "synced", pushed: 1 });
  expect(await B.sync({ remoteId: "plan-1" })).toMatchObject({ status: "synced", pulled: 1 });
  const v1 = server.project("plan-1")!.head!.text;
  A.edit((q) => updateBlock(q, a.blockId, { title: "A 版 2" }));
  expect(await A.sync()).toMatchObject({ status: "synced", pushed: 1 });
  if (options.unsent !== false) A.edit((q) => updateBlock(q, a.blockId, { description: "まだ送っていない編集" }));
  restoreServer("e2", options.to === "absent" ? null : v1);
  return { A, B, v1, a: a.blockId };
}

/** 止まった結果から、結び直しの見比べを取り出す (無ければ試験の失敗) */
function previewOf(r: SyncResult) {
  if (r.status !== "halted" || !r.relink) throw new Error("expected a halt with a relink preview: " + JSON.stringify(r).slice(0, 300));
  return r.relink;
}

describe("結び直し: 止まったときの見比べ", () => {
  it("履歴が変わると、見比べ (違い・選べるもの・印) を添えて止まる。何も書き換えない", async () => {
    const { A } = await restored();
    const before = { text: A.text, state: JSON.stringify(A.store().read()), puts: server.puts };
    const r = await A.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    const preview = previewOf(r);
    expect(preview).toMatchObject({ relation: "differs", options: ["remote", "local"], localChanged: true, pending: null, remoteRevision: "e2.1", baseRevision: "e1.2" });
    expect(preview.differences.join("\n")).toContain("A 版 2");
    expect({ text: A.text, state: JSON.stringify(A.store().read()), puts: server.puts }).toEqual(before);
    expect(A.backups()).toEqual([]);
    // 同じ状態なら、印は同じ。手元を変えると、印が変わる
    expect(previewOf(await A.sync()).token).toBe(preview.token);
    A.edit((q) => ({ ...q, name: "名前を変えた" }));
    expect(previewOf(await A.sync()).token).not.toBe(preview.token);
  });

  it("場合ごとの選べるもの: 同じ中身 / サーバーにだけある / 手元にだけある / どちらにも無い。消されている計画は、結び直しの対象にしない", async () => {
    const { A, B } = await restored({ unsent: false });
    // B は版 1 のまま (復旧先と同じ中身)
    expect(previewOf(await B.sync())).toMatchObject({ relation: "same", options: ["same"], localChanged: false });
    // 手元のファイルが無い
    rmSync(B.file);
    expect(previewOf(await B.sync())).toMatchObject({ relation: "remote-only", options: ["remote"] });
    // サーバーに計画が無い (復旧先の時点では、作られていなかった)
    restoreServer("e3", null);
    expect(previewOf(await A.sync())).toMatchObject({ relation: "local-only", options: ["local"], remoteRevision: null });
    expect(previewOf(await B.sync())).toMatchObject({ relation: "none", options: ["same"] });
    // サーバーで消されている
    server.projects.set("plan-1", { head: null, deleted: true, seq: 0, ops: new Map(), versions: [] });
    const deleted = await A.sync();
    expect(deleted.status === "halted" && [deleted.halt.reason, deleted.relink]).toEqual(["remote-deleted", undefined]);
  });

  it("別の利用者のトークンでは、結び直しを出さない (利用者の違いで止まる)", async () => {
    const { A } = await restored();
    const r = await A.sync({ token: "other" });
    expect(r.status === "halted" && [r.halt.reason, r.relink]).toEqual(["account-mismatch", undefined]);
  });
});

describe("結び直し: 選んで続ける", () => {
  it("A. サーバーを採る: 手元を控えてから置き換え、基準は復旧先の版。古い基準と古い世代は使わない", async () => {
    const { A, v1 } = await restored();
    const mine = A.text;
    const preview = previewOf(await A.sync());
    const r = await A.sync({ relink: { token: preview.token, prefer: "remote" } });
    expect(r).toMatchObject({ status: "synced", pulled: 1, pushed: 0, revision: "e2.1" });
    expect(A.text).toBe(v1);
    expect(A.store().read()).toMatchObject({ version: 1, epoch: "e2", base: { revision: "e2.1", hash: sha(v1) }, pending: null });
    expect(A.store().read()!.relink).toBeUndefined();
    // 手元の前の中身は、同じフォルダの控えと、状態のフォルダの控えの両方に残る
    expect(readFileSync(`${A.file}.before-sync-${sha(mine).slice(0, 8)}.json`, "utf8")).toBe(mine);
    const [backup] = A.backups();
    const dir = join(A.store().dir, "relinks", backup);
    expect(r.status === "synced" && r.relinkBackup).toBe(dir);
    expect(readFileSync(join(dir, "local.json"), "utf8")).toBe(mine);
    expect(readFileSync(join(dir, "remote.json"), "utf8")).toBe(v1);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).toMatchObject({ epoch: "e1", base: { revision: "e1.2" } });
    expect(JSON.parse(readFileSync(join(dir, "base.json"), "utf8")).blocks).toBeDefined();
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))).toMatchObject({
      complete: true, choice: "remote", previousEpoch: "e1", remote: { kind: "present", epoch: "e2", revision: "e2.1" }, localHash: sha(mine), base: { revision: "e1.2", saved: true }, pending: null
    });
    // その後は、ふつうの同期に戻る
    expect(await A.sync()).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
  });

  it("B. 手元を採る: サーバーの今の版を前提に送る。手元は変えない。別の端末は、その後で見比べ直す", async () => {
    const { A, B, a } = await restored();
    const mine = A.text;
    const preview = previewOf(await A.sync());
    const r = await A.sync({ relink: { token: preview.token, prefer: "local" } });
    expect(r).toMatchObject({ status: "synced", pulled: 0, pushed: 1, revision: "e2.2" });
    expect(A.text).toBe(mine);
    expect(server.project("plan-1")!.head!.text).toBe(mine);
    expect(A.store().read()).toMatchObject({ version: 1, epoch: "e2", base: { revision: "e2.2" }, pending: null });
    // B (版 1 のまま) は、A が送った後の中身と見比べることになる。選ぶまで、手元もサーバーも変わらない
    const other = previewOf(await B.sync());
    expect(other).toMatchObject({ relation: "differs", remoteRevision: "e2.2" });
    expect(await B.sync({ relink: { token: other.token, prefer: "remote" } })).toMatchObject({ status: "synced", pulled: 1 });
    expect(B.project.blocks[a].title).toBe("A 版 2");
  });

  it("同じ中身: 選択なしの --relink で、取得した中身から基準を作り直す。サーバーに無い計画は、手元を採ると新しく送る", async () => {
    const { A, B } = await restored({ unsent: false });
    const same = previewOf(await B.sync());
    const puts = server.puts;
    expect(await B.sync({ relink: { token: same.token } })).toMatchObject({ status: "synced", pulled: 0, pushed: 0, revision: "e2.1" });
    expect(server.puts).toBe(puts);
    expect(B.store().read()).toMatchObject({ version: 1, epoch: "e2", base: { revision: "e2.1" } });
    // サーバーに計画が無い: 選ぶまでは送らない。選ぶと、新しく作る
    restoreServer("e3", null);
    const absent = previewOf(await A.sync());
    expect(server.project("plan-1")).toBeUndefined();
    expect(await A.sync({ relink: { token: absent.token } })).toMatchObject({ status: "synced", pushed: 1, revision: "e3.1" });
    expect(server.project("plan-1")!.head!.text).toBe(A.text);
  });

  it("印が合わない・選べないものを選んだ・2 つあるのに選ばなかった: 何もしない (控えも作らない)", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    const before = { text: A.text, state: JSON.stringify(A.store().read()), puts: server.puts };
    for (const relink of [{ token: "0000000000000000", prefer: "local" as const }, { token: preview.token }]) {
      const r = await A.sync({ relink });
      expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    }
    // 表示のあとでサーバーが進んだ (別の端末が先に選んだ): 前の印では進まない
    restoreServer("e2", A.text.replace("A 版 2", "別の端末の中身"));
    const late = await A.sync({ relink: { token: preview.token, prefer: "local" } });
    expect(late.status === "halted" && late.halt.reason).toBe("history-changed");
    expect(previewOf(late).token).not.toBe(preview.token);
    expect({ text: A.text, state: JSON.stringify(A.store().read()) }).toEqual({ text: before.text, state: before.state });
    expect(server.puts).toBe(before.puts);
    expect(A.backups()).toEqual([]);
    // 履歴が変わっていない計画に --relink を付けても、ふつうの同期として進めない
    const { B } = { B: new Device("c") };
    writeFileSync(B.file, toJSON(createProject("別の計画")) + "\n");
    await B.sync({ remoteId: "plan-2" });
    const misuse = await B.sync({ relink: { token: preview.token } });
    expect(misuse.status === "halted" && misuse.halt).toEqual({ reason: "choice-not-applied", choice: "relink" });
  });
});

describe("結び直し: レビュー 32 の指摘", () => {
  /** 何も変わっていないこと (送信・手元・状態・控え) を確かめるための、今の様子 */
  const snapshot = (d: Device) => ({ puts: server.puts, text: existsSync(d.file) ? d.text : null, state: JSON.stringify(d.store().read()), backups: d.backups().join(",") });

  it("R32-01: 選べないものを指定したら、選べるものに読み替えずに止まる (手元にだけある + remote / サーバーにだけある + local / 同じ中身 + どちらか)", async () => {
    // 手元にだけある (サーバーに計画が無い) のに、サーバーを採ると指定した: 手元を送らない
    const { A, B } = await restored({ to: "absent" });
    const localOnly = previewOf(await A.sync());
    expect(localOnly.options).toEqual(["local"]);
    let before = snapshot(A);
    const wrong = await A.sync({ relink: { token: localOnly.token, prefer: "remote" } });
    expect(wrong.status === "halted" && wrong.halt.reason).toBe("history-changed");
    expect(snapshot(A)).toEqual(before);
    expect(server.project("plan-1")).toBeUndefined();
    // 指定を省くか、選べるものを指定すれば進む
    expect(await A.sync({ relink: { token: localOnly.token, prefer: "local" } })).toMatchObject({ status: "synced", pushed: 1 });
    // サーバーにだけある (手元のファイルが無い) のに、手元を採ると指定した: 手元に書かない
    rmSync(B.file);
    const remoteOnly = previewOf(await B.sync());
    expect(remoteOnly.options).toEqual(["remote"]);
    before = snapshot(B);
    const wrong2 = await B.sync({ relink: { token: remoteOnly.token, prefer: "local" } });
    expect(wrong2.status === "halted" && wrong2.halt.reason).toBe("history-changed");
    expect(snapshot(B)).toEqual(before);
    expect(await B.sync({ relink: { token: remoteOnly.token } })).toMatchObject({ status: "synced", pulled: 1 });
    // 同じ中身のときは、どちらを採るかの指定は受け付けない (指定なしでだけ進む)
    restoreServer("e3", B.text);
    const same = previewOf(await B.sync());
    expect(same.options).toEqual(["same"]);
    before = snapshot(B);
    for (const prefer of ["local", "remote"] as const) {
      const r = await B.sync({ relink: { token: same.token, prefer } });
      expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    }
    expect(snapshot(B)).toEqual(before);
    expect(await B.sync({ relink: { token: same.token } })).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
  });

  it("R32-04: 送る直前に履歴が変わったら、送らずに、今の内容との見比べで止まる (「消されている」とは表示しない)。古い操作は新しい世代へ送らない", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    const text = A.text;
    // 取得の後、送信の直前に、もう一度復旧された (計画は在る)
    const r = await A.sync({ relink: { token: preview.token, prefer: "local" }, onStep: (kind) => { if (kind === "push" && server.epoch === "e2") restoreServer("e3", server.project("plan-1")!.head!.text); } });
    expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    const next = previewOf(r);
    expect(next).toMatchObject({ relation: "differs", pending: "push", remoteRevision: "e3.1" });
    expect(server.project("plan-1")!.head!.revision).toBe("e3.1");
    expect(A.text).toBe(text);
    // 表示: 見比べと、新しい印のコマンド。「消されています」は出ない
    process.env.BOXGLOW_CONFIG_DIR = A.config;
    const lines: string[] = [];
    expect(await runSyncCommand({ file: A.file }, (line) => lines.push(line))).toBe(2);
    expect(lines.join("\n")).toContain(`--relink ${next.token} --prefer local`);
    expect(lines.join("\n")).not.toContain("消されています");
    // 新しい見比べから、結び直せる (残っていた送信は、控えに写るだけ)
    expect(await A.sync({ relink: { token: next.token, prefer: "local" } })).toMatchObject({ status: "synced", pushed: 1, revision: "e3.2" });
    expect(server.project("plan-1")!.head!.text).toBe(text);
  });

  it("R32-04: 断られた送信の確定の問い合わせの間に履歴が変わった場合も、今の内容との見比べで止まる", async () => {
    const { A } = await restored({ unsent: false });
    const preview = previewOf(await A.sync());
    expect(await A.sync({ relink: { token: preview.token, prefer: "local" } })).toMatchObject({ status: "synced" });
    // ふつうの送信が 413 で断られた状態を作る
    A.edit((q) => ({ ...q, name: "大きすぎる編集" }));
    const refuse = (async (...args: Parameters<typeof fetch>) =>
      (args[1] as RequestInit | undefined)?.method === "PUT" ? new Response("{}", { status: 413, headers: { "x-boxglow-epoch": "e2" } }) : fetch(...args)) as typeof fetch;
    await expect(A.sync({ fetch: refuse })).rejects.toThrow();
    expect(A.store().read()!.pending).toMatchObject({ kind: "push", rejected: { status: 413 } });
    // 次の実行: 取得は e2 のまま答え、確定の問い合わせの直前に e3 へ変わる
    let moved = false;
    const settleLate = (async (...args: Parameters<typeof fetch>) => {
      if (!moved && String(args[0]).includes("/settle")) { moved = true; restoreServer("e3", server.project("plan-1")!.head!.text); }
      return fetch(...args);
    }) as typeof fetch;
    const r = await A.sync({ fetch: settleLate });
    expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    expect(previewOf(r)).toMatchObject({ pending: "push", remoteRevision: "e3.1" });
    expect(A.store().read()!.pending?.kind).toBe("push");
  });

  it("控えを置けなかったら、状態を変えない。途中の控え (.partial) は、完了した控えと区別できる", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    const at = new Date("2026-10-05T10:00:00.000Z");
    const name = `2026-10-05T10-00-00-000Z-${preview.token}`;
    // 改名先に、空でないフォルダを置いておく (最後の改名だけが失敗する)
    const relinks = join(A.store().dir, "relinks");
    mkdirSync(join(relinks, name), { recursive: true });
    writeFileSync(join(relinks, name, "occupied"), "x");
    const before = { puts: server.puts, text: A.text, state: JSON.stringify(A.store().read()) };
    await expect(A.sync({ relink: { token: preview.token, prefer: "remote" }, now: () => at })).rejects.toThrow();
    expect({ puts: server.puts, text: A.text, state: JSON.stringify(A.store().read()) }).toEqual(before);
    // 途中の控えは .partial の名前で残り、中身は書けている。完了の印 (manifest の complete) も、改名の前に書いてある
    expect(A.backups()).toEqual([name, `${name}.partial`]);
    expect(readFileSync(join(relinks, `${name}.partial`, "local.json"), "utf8")).toBe(A.text);
    // 控えのフォルダそのものを作れない場合 (relinks がファイル)
    rmSync(relinks, { recursive: true });
    writeFileSync(relinks, "not a folder");
    await expect(A.sync({ relink: { token: preview.token, prefer: "remote" } })).rejects.toThrow();
    expect({ puts: server.puts, text: A.text, state: JSON.stringify(A.store().read()) }).toEqual(before);
    // 直せば、同じ印で進める
    rmSync(relinks);
    expect(await A.sync({ relink: { token: preview.token, prefer: "remote" } })).toMatchObject({ status: "synced", pulled: 1 });
  });

  it("R33-01: 同期の結果には、ロックの中で確かめた状態の世代番号が入る (止まった・そろった・譲った、のどれでも)", async () => {
    const { A } = await restored();
    const halted = await A.sync() as { stateGeneration?: number };
    expect(halted.stateGeneration).toBe(A.store().read()!.generation);
    const preview = previewOf(await A.sync());
    const synced = await A.sync({ relink: { token: preview.token, prefer: "remote" } }) as { stateGeneration?: number };
    expect(synced.stateGeneration).toBe(A.store().read()!.generation);
  });

  it("途中から再開して終えた実行も、前の実行が置いた控えの場所を結果に入れる", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    await expect(A.sync({ relink: { token: preview.token, prefer: "remote" }, onStep: (kind) => { if (kind === "relink:started") throw new Error("crash"); } })).rejects.toThrow("crash");
    const r = await A.sync();
    expect(r.status === "synced" && r.relinkBackup).toBe(join(A.store().dir, "relinks", A.backups()[0]));
  });
});

describe("結び直し: 古い操作が残っている場合 (R31-01)", () => {
  it("途中の送信が残っている: 送り直さない。控えに写して、選んだ中身を新しい操作として送る", async () => {
    const { A } = await restored({ unsent: false });
    // 世代 e1 のうちに、送信の途中で落ちた状態を作り直す (世代を戻して送信 → 応答の前に落とす → 復旧)
    restoreServer("e1", server.project("plan-1")!.head!.text);
    server.project("plan-1")!.head!.revision = "e1.2"; server.project("plan-1")!.seq = 2;
    A.edit((q) => ({ ...q, name: "送信の途中だった編集" }));
    await expect(A.sync({ onStep: (kind) => { if (kind === "push:sent") throw new Error("crash"); } })).rejects.toThrow("crash");
    const old = A.store().read()!.pending!;
    expect(old.kind).toBe("push");
    A.edit((q) => ({ ...q, name: "その後の編集" }));
    restoreServer("e2", server.project("plan-1")!.versions.length ? server.project("plan-1")!.head!.text.replace("送信の途中だった編集", "復旧先") : "");
    const puts = server.puts;
    const preview = previewOf(await A.sync());
    expect(preview.pending).toBe("push");
    expect(server.puts).toBe(puts);
    const r = await A.sync({ relink: { token: preview.token, prefer: "local" } });
    expect(r).toMatchObject({ status: "synced", pushed: 1 });
    // 送ったのは、今の手元 (古い送信の中身ではない)。操作の ID も新しい
    expect(server.project("plan-1")!.head!.text).toBe(A.text);
    expect([...server.project("plan-1")!.ops.keys()]).not.toContain((old as { opId: string }).opId);
    const dir = join(A.store().dir, "relinks", A.backups()[0]);
    expect(readFileSync(join(dir, "pending-content.json"), "utf8")).toContain("送信の途中だった編集");
    expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).pending).toMatchObject({ kind: "push", saved: true });
  });

  it("書けたか分からない受け取りが残っている: 受け取りの再開は求めず、結び直しへ進める。古い受け取りの中身は、基準にも手元にも使わない", async () => {
    const { A, B, a } = await restored({ unsent: false });
    // 世代 e1 に戻して、B が版 2 を受け取る途中で落ち、その後で B の手元が変わった状態を作る
    restoreServer("e1", A.text);
    server.project("plan-1")!.head!.revision = "e1.2"; server.project("plan-1")!.seq = 2;
    await expect(B.sync({ onStep: (kind) => { if (kind === "pull:recorded") throw new Error("crash"); } })).rejects.toThrow("crash");
    B.edit((q) => updateBlock(q, a, { description: "受け取りの後に書いたかもしれない編集" }));
    expect((await B.sync()).status === "halted").toBe(true);                       // (世代が同じ間は、受け取りの再開の確認)
    expect(B.store().read()!.pending?.kind).toBe("pull");
    const v0 = B.text.replace("受け取りの後に書いたかもしれない編集", "復旧先の中身");
    restoreServer("e2", v0);
    const r = await B.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("history-changed");
    const preview = previewOf(r);
    expect(preview).toMatchObject({ pending: "pull", relation: "differs" });
    const mine = B.text;
    expect(await B.sync({ relink: { token: preview.token, prefer: "local" } })).toMatchObject({ status: "synced", pushed: 1 });
    expect(B.text).toBe(mine);
    const state = B.store().read()!;
    expect(state).toMatchObject({ version: 1, epoch: "e2", pending: null });
    expect(state.binding.pendingPlanId).toBeUndefined();
    const dir = join(B.store().dir, "relinks", B.backups()[0]);
    expect(readFileSync(join(dir, "pending-content.json"), "utf8")).toContain("A 版 2");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).pending.kind).toBe("pull");
  });
});

describe("結び直し: 途中で止まった場合 (R31-02 / R31-03)", () => {
  /** 状態を置き換えた直後 (受け取り・送りの前) に落とす */
  const crashAfterStart = async (d: Device, prefer?: "local" | "remote") => {
    const preview = previewOf(await d.sync());
    await expect(d.sync({ relink: { token: preview.token, prefer }, onStep: (kind) => { if (kind === "relink:started") throw new Error("crash"); } })).rejects.toThrow("crash");
    const state = d.store().read()!;
    expect(state).toMatchObject({ version: 2, epoch: null, base: null, pending: null });
    return state.relink!;
  };

  it("控えの途中で落ちたら、状態は元のまま。途中の控えは、完了した控えと区別できる", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    const state = JSON.stringify(A.store().read());
    await expect(A.sync({ relink: { token: preview.token, prefer: "local" }, onStep: (kind) => { if (kind === "relink:backup") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(JSON.stringify(A.store().read())).toBe(state);
    expect(previewOf(await A.sync()).token).toBe(preview.token);
  });

  it("置き換えの直後に落ちても、手元とサーバーが選んだときのままなら、次の同期が選んだとおりに続ける (もう一度は聞かない)", async () => {
    const { A, v1 } = await restored();
    const record = await crashAfterStart(A, "remote");
    expect(record).toMatchObject({ choice: "remote", remote: { kind: "present", epoch: "e2", revision: "e2.1", hash: sha(v1) } });
    expect(await A.sync()).toMatchObject({ status: "synced", pulled: 1 });
    expect(A.text).toBe(v1);
    expect(A.store().read()).toMatchObject({ version: 1, epoch: "e2", base: { revision: "e2.1" } });
  });

  it("置き換えの後で手元が変わった・消えた: 選んだ内容を使わず、送りも書き込みもしないで止まる", async () => {
    const { A } = await restored();
    await crashAfterStart(A, "local");
    A.edit((q) => ({ ...q, name: "選んだ後の編集" }));
    const puts = server.puts, text = A.text;
    const r = await A.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("relink-stale");
    expect([server.puts, A.text]).toEqual([puts, text]);
    // 今の内容で選び直せる (前の記録は、新しい記録に置き換わる)
    const again = previewOf(r);
    expect(await A.sync({ relink: { token: again.token, prefer: "local" } })).toMatchObject({ status: "synced", pushed: 1 });
    expect(server.project("plan-1")!.head!.text).toBe(text);
    // 手元が消えた場合
    const B = (await restoredSecond()).A;
    await crashAfterStart(B, "local");
    rmSync(B.file);
    const gone = await B.sync();
    expect(gone.status === "halted" && gone.halt.reason).toBe("relink-stale");
    expect(existsSync(B.file)).toBe(false);
  });

  it("置き換えの後でサーバーが変わった: 「サーバーを採る」を選んだのに、手元を新しく送ることはしない (R31-03)", async () => {
    const { A } = await restored();
    await crashAfterStart(A, "remote");
    // もう一度復旧されて、計画が無くなった (基準なし・サーバーに無し・手元にあり = 初めての結び付けなら、自動で送る形)
    restoreServer("e3", null);
    const text = A.text;
    const r = await A.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("relink-stale");
    expect(server.project("plan-1")).toBeUndefined();
    expect(A.text).toBe(text);
    expect(previewOf(r)).toMatchObject({ relation: "local-only", options: ["local"] });
  });

  it("サーバーに無い計画への「手元を採る」: 世代だけが変わっても、前の選択を流用しない (R31-02)。消された場合も送らない", async () => {
    const { A } = await restored({ to: "absent" });
    const record = await crashAfterStart(A);
    expect(record).toMatchObject({ choice: "local", remote: { kind: "absent", epoch: "e2", revision: null, hash: null } });
    // 同じ「計画が無い」でも、別の世代 (版もハッシュも null のまま)
    restoreServer("e3", null);
    const r = await A.sync();
    expect(r.status === "halted" && r.halt.reason).toBe("relink-stale");
    expect(server.project("plan-1")).toBeUndefined();
    // 消されている計画には、送らない
    server.projects.set("plan-1", { head: null, deleted: true, seq: 0, ops: new Map(), versions: [] });
    const deleted = await A.sync();
    expect(deleted.status === "halted" && deleted.halt.reason).toBe("remote-deleted");
    expect(server.project("plan-1")!.head).toBeNull();
  });

  it("選んだ送信が、前提の版の違いで断られたら、同じ選択で新しい版へ送り直さない", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    const text = A.text;
    // 送る直前に、別の端末がサーバーを進めた
    const r = await A.sync({ relink: { token: preview.token, prefer: "local" }, onStep: (kind) => {
      if (kind === "push" && server.project("plan-1")!.head!.revision === "e2.1") {
        // (別の端末の送信で、版が e2.2 に進んだことにする)
        restoreServer("e2", text.replace("A 版 2", "別の端末"));
        server.project("plan-1")!.head!.revision = "e2.2"; server.project("plan-1")!.seq = 2;
      }
    } });
    expect(r.status === "halted" && r.halt.reason).toBe("relink-stale");
    expect(server.project("plan-1")!.head!.text).toContain("別の端末");
    expect(A.text).toBe(text);
    expect(A.store().read()).toMatchObject({ version: 2, pending: null, base: null, relink: { spent: true } });
  });

  it("受け取りの書き込みの途中・送信の応答を失った場合は、既にある再開の手順で続く", async () => {
    const { A, v1 } = await restored();
    const preview = previewOf(await A.sync());
    await expect(A.sync({ relink: { token: preview.token, prefer: "remote" }, onStep: (kind) => { if (kind === "pull:written") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(A.store().read()).toMatchObject({ version: 2, epoch: "e2", pending: { kind: "pull" } });
    // 手元は書けていた: 次の同期が、基準を進めて終える
    expect(await A.sync()).toMatchObject({ status: "synced" });
    expect(A.text).toBe(v1);
    expect(A.store().read()).toMatchObject({ version: 1, base: { revision: "e2.1" } });
    // 送信の応答を失った場合: 同じ操作 ID で送り直して、受理を確かめる (版を二重に増やさない)
    const B = (await restoredSecond()).A;
    const other = previewOf(await B.sync());
    await expect(B.sync({ relink: { token: other.token, prefer: "local" }, onStep: (kind) => { if (kind === "push:sent") throw new Error("crash"); } })).rejects.toThrow("crash");
    expect(B.store().read()).toMatchObject({ version: 2, epoch: "e2", pending: { kind: "push" } });
    expect(await B.sync()).toMatchObject({ status: "synced", pushed: 1, revision: "e2.2" });
    expect(B.store().read()).toMatchObject({ version: 1 });
  });

  /** 2 つ目の組 (別のフォルダ・別のサーバーの計画) を作る: 1 つの試験の中で、別の経路も確かめるため */
  async function restoredSecond() {
    const save = root;
    root = mkdtempSync(join(save, "second-"));
    server.projects.delete("plan-1");
    server.epoch = "e1";
    try { return await restored(); } finally { root = save; }
  }
});

describe("結び直し: 状態の形式 (R31-04)", () => {
  it("結び直しの途中の状態は、形式の版が 2。前の版の Boxglow の読み方 (版 1 だけを読む) では、読めない状態として止まる", async () => {
    const { A } = await restored();
    const preview = previewOf(await A.sync());
    await expect(A.sync({ relink: { token: preview.token, prefer: "remote" }, onStep: (kind) => { if (kind === "relink:started") throw new Error("crash"); } })).rejects.toThrow("crash");
    const raw = JSON.parse(readFileSync(join(A.store().dir, "state.json"), "utf8"));
    expect(raw.version).toBe(2);
    // 前の版の検査 (版が 1 でなければ読まない) を、そのまま当てる
    const oldReader = (value: { version: unknown }) => (value.version !== 1 ? "unknown version" : null);
    expect(oldReader(raw)).toBe("unknown version");
    // 版と中身が合わないものは、今の版でも読まない (記録だけを足した版 1・記録の無い版 2)
    expect(stateProblem({ ...raw, version: 1 })).toBe("relink version");
    const { relink: _dropped, ...withoutRecord } = raw;
    expect(stateProblem(withoutRecord)).toBe("relink version");
    expect(stateProblem({ ...raw, relink: { ...raw.relink, remote: { kind: "absent", epoch: "e2", revision: "e2.1", hash: null } } })).toBe("relink remote");
    writeFileSync(join(A.store().dir, "state.json"), JSON.stringify({ ...raw, version: 1 }));
    expect(() => A.store().read()).toThrow(SyncStateUnreadable);
  });

  it("前の版の判断 (結び直しの記録を知らない) に、記録つきの状態を渡すと送ってしまう形でも、今の判断は止まる", () => {
    // 基準なし・操作なし・サーバーに計画なし・手元に計画あり。記録は「サーバーを採る」(別の世代で選んだもの)
    const text = toJSON(createProject("判断の試験"));
    const input: SyncInput = {
      state: { generation: 3, epoch: null, base: null, pending: null, relink: { choice: "remote", remote: { kind: "present", epoch: "e2", revision: "e2.1", hash: "x" }, localHash: sha(text), backup: "b", at: "2026-10-05T00:00:00.000Z" } }
    , local: { hash: sha(text), text }, remote: { kind: "absent", epoch: "e3" }, baseText: null, now: new Date(), hashOf: sha, bindingId: "binding"
    };
    expect(decide(input)).toEqual({ kind: "halt", halt: { reason: "relink-stale" } });
    // 記録が無ければ、今までどおり「初めての結び付け」として送る (新しい結び付けの既定の動きは変えていない)
    const { relink: _none, ...fresh } = input.state;
    expect(decide({ ...input, state: fresh }).kind).toBe("push");
  });
});

describe("結び直し: コマンドの表示", () => {
  it("止まると、違いと、印つきのコマンド (A / B) を表示する。選ぶと、控えの場所を表示して同期する", async () => {
    const { A } = await restored();
    process.env.BOXGLOW_CONFIG_DIR = A.config;
    const lines: string[] = [];
    expect(await runSyncCommand({ file: A.file }, (line) => lines.push(line))).toBe(2);
    const shown = lines.join("\n");
    expect(shown).toContain("サーバーの履歴が、前回そろえたときから変わっています");
    expect(shown).toContain("--prefer remote");
    expect(shown).toContain("--prefer local");
    const token = /--relink ([0-9a-f]{16})/.exec(shown)![1];
    // 2 つ選べるのに、どちらを採るかを付けなかった: 何もしない
    const none: string[] = [];
    expect(await runSyncCommand({ file: A.file, relink: token }, (line) => none.push(line))).toBe(2);
    const done: string[] = [];
    expect(await runSyncCommand({ file: A.file, relink: token, prefer: "local" }, (line) => done.push(line))).toBe(0);
    expect(done.join("\n")).toContain(join(A.store().dir, "relinks"));
    expect(server.project("plan-1")!.head!.text).toBe(A.text);
  });
});
