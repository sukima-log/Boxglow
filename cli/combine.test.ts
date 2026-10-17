/**
 * boxglow combine / split-file (B154) の試験: ビルド済みの CLI を子プロセスで呼び、ファイルの往復で内容が残ることを確かめる
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "..", "bin", "boxglow.js");
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "boxglow-combine-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const run = (...args: string[]) => execFileSync("node", [CLI, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, BOXGLOW_ACTOR: "human:test" } });
const read = (file: string) => JSON.parse(readFileSync(join(root, file), "utf8")) as { name: string; blocks: Record<string, { title: string; key?: string; kind?: string; parentId: string | null; decisions: unknown[] }>; ports: Record<string, { blockId: string; direction: string; description: string }>; edges: Record<string, { from: { portId: string }; to: { portId: string } }>; members: { name: string }[]; log: { kind: string; message: string }[] };

it("combine: 2 つの計画を 1 つにまとめる (番号が重なっても一意。判断と記録が残る) → split-file で切り出す → またぐ線は最上位ノードになる → combine で戻せる", () => {
  run("init", "--file", "a.json", "--name", "A");
  run("add", "A の箱", "--file", "a.json");
  run("ask", "B1", "どちらにする?", "--options", "X|Y", "--file", "a.json", "--actor", "ai");
  run("init", "--file", "b.json", "--name", "B");
  run("add", "B の箱", "--file", "b.json");
  run("start", "B1", "--file", "b.json", "--actor", "ai");
  // 結合
  const out = run("combine", "a.json", "b.json", "--out", "all.json");
  expect(out).toContain("all.json");
  const all = read("all.json");
  const titles = Object.values(all.blocks).map((b) => b.title);
  expect(titles).toContain("A の箱"); expect(titles).toContain("B の箱");
  const keys = Object.values(all.blocks).map((b) => b.key).filter(Boolean);
  expect(new Set(keys).size).toBe(keys.length);
  expect(Object.values(all.blocks).filter((b) => b.kind === "project").length).toBe(2);
  expect(Object.values(all.blocks).flatMap((b) => b.decisions).length).toBe(1);
  expect(all.log.some((e) => e.kind === "started")).toBe(true);
  expect(all.log.at(-1)?.message).toContain("結合");
  for (const e of Object.values(all.edges)) { expect(all.ports[e.from.portId]).toBeTruthy(); expect(all.ports[e.to.portId]).toBeTruthy(); }
  // 切り出す (B のプロジェクトの箱 = title "B")
  const bBox = Object.entries(all.blocks).find(([, b]) => b.kind === "project" && b.title === "B")![1];
  const out2 = run("split-file", bBox.key!, "--out", "b2.json", "--file", "all.json");
  expect(out2).toContain("b2.json");
  const rest = read("all.json"), b2 = read("b2.json");
  expect(Object.values(rest.blocks).map((b) => b.title)).not.toContain("B の箱");
  expect(Object.values(b2.blocks).map((b) => b.title)).toContain("B の箱");
  expect(b2.name).toBe("B");
  expect(b2.log.some((e) => e.kind === "started")).toBe(true);
  expect(rest.log.some((e) => e.kind === "started")).toBe(false);
  // 単独で開ける (読める) こと: status が動く
  expect(run("status", "--file", "b2.json")).toContain("B の箱");
  expect(run("status", "--file", "all.json")).toContain("A の箱");
  // 戻す
  run("combine", "all.json", "b2.json", "--out", "again.json");
  const again = read("again.json");
  expect(Object.values(again.blocks).map((b) => b.title)).toEqual(expect.arrayContaining(["A の箱", "B の箱"]));
  expect(Object.values(again.blocks).flatMap((b) => b.decisions).length).toBe(1);
  // 上書きは --force が要る
  expect(() => run("combine", "a.json", "b.json", "--out", "all.json")).toThrow();
});
