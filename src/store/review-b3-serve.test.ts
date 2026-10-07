/**
 * 再検証 (B2): 同じ保存ループの 1 回目の PUT の「自分の書き込みの通知」が、2 回目の PUT の応答待ちに届いたとき、
 * 保留した古い自分の版を「相手の変更」として統合し、2 回目の編集を戻してしまわないか
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";

const server = { text: "", rev: 1 };
let gate: Promise<void> | null = null;   // 2 回目の PUT は、書き込みの前で止める
let puts = 0;
const listeners: Record<string, (() => void)[]> = {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { baseURI: "http://x/" }; g.location = { search: "", href: "http://x/" }; g.window = globalThis;
  g.confirm = () => true; g.history = { replaceState() {} };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.EventSource = class { addEventListener(k: string, f: () => void) { (listeners[k] ??= []).push(f); } close() {} };
  g.fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const hdr = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null, has: (k: string) => k.toLowerCase() in h });
    if (!String(url).endsWith("api/project")) return { ok: false, status: 404, headers: hdr({}), text: async () => "", json: async () => ({}) };
    if (init?.method === "PUT") {
      puts++; { const q = fromJSON(init.body!); const id = Object.keys(q.blocks).find(k => k !== "root" && /^(A|P1|P2)$/.test(q.blocks[k].title)); console.log("PUT", puts, id && q.blocks[id].title, "if-match", init.headers!["if-match"], "rev", server.rev, "screen", (globalThis as any).__s?.().project.blocks[id!]?.title, "past", (globalThis as any).__s?.().past.map((x: any) => x.blocks[id!]?.title).join(",")); }
      if (puts === 2 && gate) await gate;   // 大きな計画の検証・書き込みに時間がかかる
      if (init.headers!["if-match"] !== `"${server.rev}"`) return { ok: false, status: 412, headers: hdr({}), text: async () => "" };
      server.text = init.body!; server.rev++;
      return { ok: true, status: 200, headers: hdr({ etag: `"${server.rev}"` }), text: async () => "" };
    }
    const etag = `"${server.rev}"`, text = server.text; console.log("GET rev", server.rev);
    return { ok: true, status: 200, headers: hdr({ etag }), text: async () => text };
  };
});

describe("serve: 自分の 1 回目の書き込みの通知が、2 回目の保存中に届く", () => {
  it("2 回目の編集が残るか", async () => {
    let p = createProject("検証");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    server.text = toJSON(p) + "\n"; server.rev = 1;
    const { useProjectStore: store } = await import("./useProjectStore");
    expect(await store.getState().openFromServer()).toBe(true); (globalThis as any).__s = store.getState;
    let release!: () => void; gate = new Promise((r) => { release = r; });
    // 1 回目の保存: a=P1
    store.getState().apply((q) => updateBlock(q, a.blockId, { title: "P1" }));
    store.getState().saveNow();
    // 1 回目の応答を待つ間に、続けて a=P2 と編集 (ループが続けて 2 回目を送る)
    store.getState().apply((q) => updateBlock(q, a.blockId, { title: "P2" }));
    await wait(20);
    expect(fromJSON(server.text).blocks[a.blockId].title).toBe("P1");
    // 1 回目の書き込みの通知 (80ms 後) → GET は、まだ 2 回目が書かれていないので P1 を返す
    listeners.change.forEach((f) => f());
    await wait(20);
    const changes: string[] = [];
    const unsubscribe = store.subscribe(s => changes.push(s.project!.blocks[a.blockId].title));
    release();
    await wait(200);
    unsubscribe();
    expect(changes).not.toContain("P1");
    expect(puts).toBe(2);
    expect(store.getState().toast).toBeNull();
    store.getState().undo();
    expect(store.getState().project!.blocks[a.blockId].title).toBe("P1");
    store.getState().redo();
    const s = store.getState();
    console.log(JSON.stringify({ puts, server: fromJSON(server.text).blocks[a.blockId].title, screen: s.project!.blocks[a.blockId].title, saveState: s.saveState, conflict: !!s.conflict, toast: s.toast }));
    expect(s.project!.blocks[a.blockId].title).toBe("P2");
    expect(fromJSON(server.text).blocks[a.blockId].title).toBe("P2");
  });
});
