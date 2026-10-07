/**
 * 検証: serve を fetch / EventSource の模擬で動かし、
 * 自分の PUT が既にサーバーで成功した後 (応答はまだ) に、他者がその上に変更し、その通知が先に届いた場合の統合の基準を確かめる
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";

// 模擬サーバーの状態
const server = { text: "", rev: 1 };
let holdPut: Promise<void> | null = null;
const listeners: Record<string, (() => void)[]> = {};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(() => {
  (globalThis as unknown as Record<string, unknown>).document = { baseURI: "http://x/" };
  (globalThis as unknown as Record<string, unknown>).location = { search: "", href: "http://x/" }; (globalThis as unknown as Record<string, unknown>).window = globalThis;
  (globalThis as unknown as Record<string, unknown>).confirm = () => true;
  (globalThis as unknown as Record<string, unknown>).history = { replaceState() {} };
  (globalThis as unknown as Record<string, unknown>).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  (globalThis as unknown as Record<string, unknown>).EventSource = class { constructor() {} addEventListener(k: string, f: () => void) { (listeners[k] ??= []).push(f); } close() {} };
  (globalThis as unknown as Record<string, unknown>).fetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const hdr = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null, has: (k: string) => k.toLowerCase() in h });
    if (!String(url).endsWith("api/project")) return { ok: false, status: 404, headers: hdr({}), text: async () => "", json: async () => ({}) };
    if (init?.method === "PUT") {
      // サーバー側の書き込みは即座に行い、応答だけを遅らせる
      if (init.headers!["if-match"] !== `"${server.rev}"`) return { ok: false, status: 412, headers: hdr({}), text: async () => "" };
      server.text = init.body!; server.rev++;
      const etag = `"${server.rev}"`;
      if (holdPut) await holdPut;
      return { ok: true, status: 200, headers: hdr({ etag }), text: async () => "" };
    }
    const etag = `"${server.rev}"`, text = server.text;
    return { ok: true, status: 200, headers: hdr({ etag }), text: async () => text };
  };
});

describe("serve: 保存の応答待ちに届いた通知の統合の基準", () => {
  it("自分の保存で a を X にした直後、他者が a を A に戻した。その戻しが黙って消えないか", async () => {
    let p = createProject("検証");
    const a = addBlock(p, { parentId: defaultTaskParent(p), title: "A" }); p = a.project;
    const B = toJSON(p) + "\n";
    server.text = B; server.rev = 1;
    const { useProjectStore: store } = await import("./useProjectStore");
    expect(await store.getState().openFromServer()).toBe(true);
    // 画面で a を X にして保存 (サーバーには書かれるが、応答を止める)
    let release!: () => void; holdPut = new Promise((r) => { release = r; });
    store.getState().apply((q) => updateBlock(q, a.blockId, { title: "X" }));
    store.getState().saveNow();
    await wait(10);
    expect(fromJSON(server.text).blocks[a.blockId].title).toBe("X");
    // 他者 (CLI) が、X を見たうえで A に戻す
    server.text = toJSON(updateBlock(fromJSON(server.text), a.blockId, { title: "A" })) + "\n"; server.rev++;
    // その通知が、自分の PUT の応答より先に届く
    listeners.change.forEach((f) => f());
    await wait(20);
    holdPut = null; release();
    await wait(100);
    const s = store.getState();
    console.log(JSON.stringify({ server: fromJSON(server.text).blocks[a.blockId].title, screen: s.project!.blocks[a.blockId].title, saveState: s.saveState, conflict: !!s.conflict, toast: s.toast, err: s.saveError }));
    // 正しい共通の基準は X (自分の書いた版) なので、他者の「A に戻す」が残るべき
    expect(fromJSON(server.text).blocks[a.blockId].title).toBe("A");
  });
});
