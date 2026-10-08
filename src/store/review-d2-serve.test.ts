/** D2: 他の画面が別計画へ置き換えた通知を、未保存の計画へ自動統合しない。 */
import { it, expect } from "vitest";
import { addBlock, createProject, toJSON, updateBlock } from "../model/graph";
it("外部の計画IDが変わったら編集を保留し、自動PUTしない", async () => {
  const a = addBlock(createProject("local"), { title: "A", parentId: "root" });
  let text = toJSON(a.project), revision = 1, puts = 0;
  const listeners: Record<string, (() => void)[]> = {};
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { baseURI: "http://x/" }; g.location = { search: "", href: "http://x/" }; g.window = globalThis;
  g.confirm = () => true; g.history = { replaceState() {} };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.EventSource = class { addEventListener(k: string, f: () => void) { (listeners[k] ??= []).push(f); } close() {} };
  g.fetch = async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("api/project")) return new Response("{}", { status: 404 });
    if (init?.method === "PUT") { puts++; return new Response("", { status: 412 }); }
    return new Response(text, { headers: { etag: `"${revision}"` } });
  };
  const { useProjectStore: store } = await import("./useProjectStore");
  expect(await store.getState().openFromServer()).toBe(true);
  store.getState().apply(p => updateBlock(p, a.blockId, { title: "unsaved edit" }));
  const other = createProject("other plan");
  expect(other.id).not.toBe(a.project.id);
  text = toJSON(other); revision++;
  listeners.change.forEach(f => f());
  await new Promise(r => setTimeout(r, 30));
  expect(store.getState().conflict).toBeTruthy();
  expect(store.getState().project?.id).toBe(a.project.id);
  expect(store.getState().project?.blocks[a.blockId].title).toBe("unsaved edit");
  await new Promise(r => setTimeout(r, 1200));
  expect(puts).toBe(0);
});
