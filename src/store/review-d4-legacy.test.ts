import { mergeProjects } from "../model/merge";
/** D4: 作成日時の異なる外部計画へ未保存編集を自動保存しない。 */
import { validateProjectText } from "../model/validate-file";
import { it, expect } from "vitest";
import { createProject, fromJSON, toJSON } from "../model/graph";
it("基準にIDが無くても作成日時が異なる計画へ未保存メンバーを自動統合しない", async () => {
  const initial = createProject("local");
  const a = { project: initial };
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
  store.getState().apply(p => ({ ...p, members: [...p.members, { id: "local-member", name: "unsaved member", color: "red" }] }));
  const other = { ...normalized, id: "different-plan", name: "another plan", createdAt: "2000-01-01T00:00:00.000Z" };
  expect(other.id).not.toBe(a.project.id);
  expect(mergeProjects(normalized, store.getState().project!, other, {}, new Date().toISOString()).conflicts.filter(c => !c.automatic)).toHaveLength(0);
  text = toJSON(other); validateProjectText(text); revision++;
  listeners.change.forEach(f => f());
  await new Promise(r => setTimeout(r, 30));
  expect(store.getState().conflict).toBeTruthy();
  expect(store.getState().project?.members.some(m => m.id === "local-member")).toBe(true);
  await new Promise(r => setTimeout(r, 1200));
  expect(puts).toBe(0);
  expect(JSON.parse(text).id).toBe(other.id);
  expect(JSON.parse(text).members.some((m: { id: string }) => m.id === "local-member")).toBe(false);
});
