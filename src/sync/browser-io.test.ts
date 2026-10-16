/**
 * ブラウザの入出力 (browserSyncIO) で、同期の本体 (runSync) が Node と同じ場面を通ることの試験
 * IndexedDB は fake-indexeddb、サーバーは試験用の同期サーバー (cli/sync/test-server.ts)、2 台目は Node の syncOnce
 */
import "fake-indexeddb/auto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestSyncServer } from "../../cli/sync/test-server";
import { syncOnce } from "../../cli/sync/client";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON } from "../model/graph";
import { saveProject, loadProject } from "../lib/storage";
import { browserSyncIO, resetBrowserSyncStores } from "./browser-io";
import { runSync } from "./run";

let server: TestSyncServer, root: string;
beforeEach(async () => {
  server = new TestSyncServer(); await server.start();
  root = mkdtempSync(join(tmpdir(), "boxglow-browser-io-"));
  process.env.BOXGLOW_CONFIG_DIR = join(root, "config");
  resetBrowserSyncStores();
});
afterEach(async () => { await server.stop(); delete process.env.BOXGLOW_CONFIG_DIR; rmSync(root, { recursive: true, force: true }); });

describe("browserSyncIO + runSync", () => {
  it("ブラウザ内の計画を新しくサーバーに置き、Node の 2 台目が受け取る。2 台目の変更をブラウザが受け取る (基準が進み、保存される)", async () => {
    let p = createProject("ブラウザの計画");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    await saveProject(p);
    const io = browserSyncIO(p.id, server.url);
    // 初めての結び付け: サーバーに無いので送る
    const first = await runSync({ server: server.url, remoteId: "plan-b", token: "tok-user" }, io);
    expect(first).toMatchObject({ status: "synced", pushed: 1, pulled: 0 });
    expect(server.project("plan-b", "tok-user")?.head).toBeTruthy();
    // 2 台目 (Node) が受け取って編集して送る
    const file = join(root, "d", "boxglow.json"); mkdirSync(join(root, "d"));
    expect(await syncOnce({ file, server: server.url, remoteId: "plan-b", token: "tok-user" })).toMatchObject({ status: "synced", pulled: 1 });
    const edited = fromJSON(readFileSync(file, "utf8"));
    writeFileSync(file, toJSON({ ...edited, blocks: { ...edited.blocks, [a.blockId]: { ...edited.blocks[a.blockId], title: "A (2 台目)" } } }) + "\n");
    expect(await syncOnce({ file, server: server.url, remoteId: "plan-b", token: "tok-user" })).toMatchObject({ status: "synced", pushed: 1 });
    // ブラウザが受け取る
    const second = await runSync({ server: server.url, token: "tok-user" }, io);
    expect(second).toMatchObject({ status: "synced", pulled: 1 });
    expect((await loadProject(p.id))?.blocks[a.blockId].title).toBe("A (2 台目)");
    // 何も変わっていなければ noop
    expect(await runSync({ server: server.url, token: "tok-user" }, io)).toMatchObject({ status: "synced", pulled: 0, pushed: 0 });
    // 状態が保存されている (再読み込み後も同じ結び付け)
    const again = browserSyncIO(p.id, server.url);
    expect((await again.readState())?.binding.remoteId).toBe("plan-b");
    expect((await again.bindings()).bindings.map((b) => b.remoteId)).toEqual(["plan-b"]);
  });

  it("両方で同じ項目を変えると、競合で止まる (confirm 待ち)。手元の変更は保存されたまま", async () => {
    let p = createProject("競合");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    await saveProject(p);
    const io = browserSyncIO(p.id, server.url);
    expect(await runSync({ server: server.url, remoteId: "plan-c", token: "tok-user" }, io)).toMatchObject({ status: "synced", pushed: 1 });
    const file = join(root, "e", "boxglow.json"); mkdirSync(join(root, "e"));
    expect(await syncOnce({ file, server: server.url, remoteId: "plan-c", token: "tok-user" })).toMatchObject({ status: "synced", pulled: 1 });
    const other = fromJSON(readFileSync(file, "utf8"));
    writeFileSync(file, toJSON({ ...other, blocks: { ...other.blocks, [a.blockId]: { ...other.blocks[a.blockId], title: "Node の案" } } }) + "\n");
    expect(await syncOnce({ file, server: server.url, remoteId: "plan-c", token: "tok-user" })).toMatchObject({ status: "synced", pushed: 1 });
    const mine = (await loadProject(p.id))!;
    await saveProject({ ...mine, blocks: { ...mine.blocks, [a.blockId]: { ...mine.blocks[a.blockId], title: "ブラウザの案" } } });
    const halted = await runSync({ server: server.url, token: "tok-user" }, io);
    expect(halted.status).toBe("halted");
    expect(halted.status === "halted" && halted.halt.reason).toBe("conflicts");
    expect((await loadProject(p.id))?.blocks[a.blockId].title).toBe("ブラウザの案");
  });

  it("状態のロック: 同じ結び付けの同期は 1 つだけ (2 つ目は busy)。書き込みの世代の照合", async () => {
    const p = createProject("ロック");
    await saveProject(p);
    const io = browserSyncIO(p.id, server.url);
    const release = await io.lockState();
    expect(release).toBeTruthy();
    expect(await runSync({ server: server.url, remoteId: "plan-l", token: "tok-user" }, io)).toMatchObject({ status: "busy", what: "sync" });
    release!();
    expect(await runSync({ server: server.url, remoteId: "plan-l", token: "tok-user" }, io)).toMatchObject({ status: "synced" });
    const state = (await io.readState())!;
    await expect(io.writeState({ ...state, generation: state.generation + 1 }, state.generation + 5)).rejects.toThrow();
    await io.writeState({ ...state, generation: state.generation + 1 }, state.generation);
    expect((await io.readState())?.generation).toBe(state.generation + 1);
  });
});
