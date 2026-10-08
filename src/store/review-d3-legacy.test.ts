/** D3: 基準にIDが無い古い計画は、外部の最初のID付与を別計画と誤判定しない。 */
import { validateProjectText } from "../model/validate-file";
import { it, expect } from "vitest";
import { addBlock, createProject, defaultTaskParent, fromJSON, toJSON, updateBlock } from "../model/graph";
it("古い計画への最初のID付与でも、競合しない編集を自動統合する", async () => {
  const initial = createProject("local");
  const a = addBlock(initial, { title: "A", parentId: defaultTaskParent(initial) });
  const normalized = fromJSON(toJSON(a.project));
  const legacy = JSON.parse(toJSON(normalized)); delete legacy.id;
  let text = JSON.stringify(legacy), revision = 1, puts = 0;
  const listeners: Record<string, (() => void)[]> = {};
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { baseURI: "http://x/" }; g.location = { search: "", href: "http://x/" }; g.window = globalThis;
  g.confirm = () => true; g.history = { replaceState() {} };
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.EventSource = class { addEventListener(k: string, f: () => void) { (listeners[k] ??= []).push(f); } close() {} };
  g.fetch = async (url: string, init?: RequestInit) => {
    if (!String(url).endsWith("api/project")) return new Response("{}", { status: 404 });
    if (init?.method === "PUT") { puts++; text = String(init.body); revision++; return new Response("", { headers: { etag: `"${revision}"` } }); }
    return new Response(text, { headers: { etag: `"${revision}"` } });
  };
  const { useProjectStore: store } = await import("./useProjectStore");
  expect(await store.getState().openFromServer()).toBe(true);
  store.getState().apply(p => updateBlock(p, a.blockId, { title: "unsaved edit" }));
  const other = { ...normalized, id: "first-assigned-id", name: "externally renamed" };
  expect(other.id).not.toBe(a.project.id);
  text = toJSON(other); validateProjectText(text); revision++;
  listeners.change.forEach(f => f());
  await new Promise(r => setTimeout(r, 30));
  expect(store.getState().conflict).toBeNull();
  expect(store.getState().project?.name).toBe("externally renamed");
  expect(store.getState().project?.blocks[a.blockId].title).toBe("unsaved edit");
  await new Promise(r => setTimeout(r, 1200));
  expect(puts).toBeGreaterThan(0);
  expect(store.getState().project?.id).toBe(other.id);
  store.getState().undo();
  expect(store.getState().project?.id).toBe(other.id);
  expect(store.getState().toast).toBeNull();
  expect(JSON.parse(text).blocks[a.blockId].title).toBe("unsaved edit");
});
