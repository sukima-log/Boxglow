/**
 * 3 方向マージのテスト: 別々のボックスの変更は合わさり、同じ項目の変更は ours を採用して記録する。
 * 片方がボックスを削除し、もう片方が変更していたら、変更されたボックスを残して記録する
 */
import { describe, expect, it } from "vitest";
import { addBlock, createProject, defaultTaskParent, portsOf, updateBlock, removeBlock, fromJSON, toJSON, moveBlockToParent } from "./graph";
import { mergeProjects } from "./merge";
import { projectProblem } from "./validate-file";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function base() {
  let p = createProject("team");
  const pj = defaultTaskParent(p);
  const a = addBlock(p, { parentId: pj, title: "A" }); p = a.project;
  const b = addBlock(p, { parentId: pj, title: "B" }); p = b.project;
  return { p: fromJSON(toJSON(p)), a: a.blockId, b: b.blockId, pj };
}

// 親と子の両方が「削除と変更」でぶつかったとき、人が「親は残す・子は削除する」と選んだら、
// 親を残すための自動の復元 (中のボックスも戻す) が、明示的に選んだ子の削除を取り消さないこと。ours / theirs のどちら向きでも同じ
it.each([false, true])("親を残す選択で、削除を選んだ子のボックスを復活させない (向きを入れ替え=%s)", (reversed) => {
  const { p, a } = base();
  const child = addBlock(p, { parentId: a, title: "Child" });
  const before = fromJSON(toJSON(child.project));
  const deleted = removeBlock(before, a);
  const edited = updateBlock(updateBlock(before, a, { title: "Edited parent" }), child.blockId, { title: "Edited child" });
  const ours = reversed ? edited : deleted, theirs = reversed ? deleted : edited;
  const kept = reversed ? "ours" : "theirs", removed = reversed ? "theirs" : "ours";
  const r = mergeProjects(before, ours, theirs, {
    [JSON.stringify(["blocks", a])]: kept,
    [JSON.stringify(["blocks", child.blockId])]: removed,
  });
  expect(r.project.blocks[a].title).toBe("Edited parent");
  expect(r.project.blocks[child.blockId]).toBeUndefined();
  expect(Object.values(r.project.ports).some(port => port.blockId === child.blockId)).toBe(false);
});

describe("boxglow.json の 3 方向マージ", () => {
  it("別々のボックスを変えた 2 人の変更が両方入る", () => {
    const { p, a, b } = base();
    const ours = updateBlock(p, a, { title: "A (自分)" });
    const theirs = updateBlock(p, b, { title: "B (相手)" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a].title).toBe("A (自分)");
    expect(r.project.blocks[b].title).toBe("B (相手)");
    expect(r.conflicts).toHaveLength(0);
  });
  it("相手が足したボックスと自分が足したボックスが両方残り、B 番号の衝突は振り直す", () => {
    const { p, pj } = base();
    const ours = addBlock(p, { parentId: pj, title: "自分の新規" }).project;
    const theirs = addBlock(p, { parentId: pj, title: "相手の新規" }).project;
    const r = mergeProjects(p, ours, theirs);
    const titles = Object.values(r.project.blocks).map((x) => x.title);
    expect(titles).toContain("自分の新規");
    expect(titles).toContain("相手の新規");
    const keys = Object.values(r.project.blocks).map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length); // 番号が重複しない
  });
  it("同じボックスの同じ項目を両方が変えたら自分を採用し、記録に残す", () => {
    const { p, a } = base();
    const ours = updateBlock(p, a, { title: "自分" });
    const theirs = updateBlock(p, a, { title: "相手" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a].title).toBe("自分");
    expect(r.conflicts.map((c) => c.path)).toContain(`blocks.${a}.title`);
  });
  it("片方が消したボックスは、もう片方が触っていなければ消える", () => {
    const { p, a, b } = base();
    const ours = removeBlock(p, a);
    const theirs = updateBlock(p, b, { title: "B2" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a]).toBeUndefined();
    expect(r.project.blocks[b].title).toBe("B2");
  });
  it("ログは両方を合わせて時刻順になる", () => {
    const { p, a, b } = base();
    const ours = updateBlock(p, a, { status: "gray" });
    const theirs = updateBlock(p, b, { status: "gray" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.log.length).toBeGreaterThanOrEqual(Math.max(ours.log.length, theirs.log.length));
  });
});

it("lets users choose opposite sides for different fields and retains nonconflicting changes", () => {
  const { p, a, b } = base();
  const ours = updateBlock(p, a, { title: "Local", description: "Local note" });
  const theirs = updateBlock(updateBlock(p, a, { title: "Remote", description: "Remote note" }), b, { title: "Independent" });
  const preview = mergeProjects(p, ours, theirs);
  const choices = Object.fromEntries(preview.conflicts.map((c) => [c.id, c.segments.at(-1) === "title" ? "theirs" as const : "ours" as const]));
  const result = mergeProjects(p, ours, theirs, choices);
  expect(result.project.blocks[a].title).toBe("Remote");
  expect(result.project.blocks[a].description).toBe("Local note");
  expect(result.project.blocks[b].title).toBe("Independent");
});
it("reports delete-versus-edit conflicts and honors either choice", () => {
  const { p, a } = base();
  const ours = structuredClone(p); delete ours.blocks[a];
  const theirs = updateBlock(p, a, { title: "Edited remotely" });
  const preview = mergeProjects(p, ours, theirs);
  const c = preview.conflicts.find((c) => c.segments[1] === a)!;
  expect(c.ours).toBeUndefined();
  // 選択が無ければ、変更されたボックスを残す (データを失わない側が既定)
  expect(c.adopted).toBe("theirs");
  expect(preview.project.blocks[a].title).toBe("Edited remotely");
  expect(mergeProjects(p, ours, theirs, { [c.id]: "ours" }).project.blocks[a]).toBeUndefined();
  expect(mergeProjects(p, ours, theirs, { [c.id]: "theirs" }).project.blocks[a].title).toBe("Edited remotely");
});
describe("片方がボックスを削除、もう片方が変更", () => {
  /** 結果の計画で、入出力の持ち主と線の両端がすべて存在するか確かめる (壊れた参照が無い) */
  const expectIntact = (q: ReturnType<typeof mergeProjects>["project"]) => {
    for (const port of Object.values(q.ports)) expect(q.blocks[port.blockId]).toBeDefined();
    for (const e of Object.values(q.edges)) { expect(q.ports[e.from.portId]).toBeDefined(); expect(q.ports[e.to.portId]).toBeDefined(); }
    for (const b of Object.values(q.blocks)) if (b.parentId) expect(q.blocks[b.parentId]).toBeDefined();
  };
  it("自分が削除・相手が変更: 変更されたボックスを入出力ごと残し、競合として記録する", () => {
    const { p, a } = base();
    const ours = removeBlock(p, a);
    const theirs = updateBlock(p, a, { title: "相手が変更" });
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a].title).toBe("相手が変更");
    expect(portsOf(r.project, a, "out")).toHaveLength(portsOf(theirs, a, "out").length);
    expect(r.conflicts.find((c) => c.path === `blocks.${a}`)?.adopted).toBe("theirs");
    expectIntact(r.project);
    // 計画として読み書きできる (壊れた参照が無い)
    expect(fromJSON(toJSON(r.project)).blocks[a].title).toBe("相手が変更");
  });
  it("相手が削除・自分が変更: 変更されたボックスを入出力ごと残し、競合として記録する", () => {
    const { p, a } = base();
    const ours = updateBlock(p, a, { title: "自分が変更" });
    const theirs = removeBlock(p, a);
    const r = mergeProjects(p, ours, theirs);
    expect(r.project.blocks[a].title).toBe("自分が変更");
    expect(portsOf(r.project, a, "out").length).toBeGreaterThan(0);
    expect(r.conflicts.find((c) => c.path === `blocks.${a}`)?.adopted).toBe("ours");
    expectIntact(r.project);
  });
  it("親を削除・相手が中のボックスを変更: 親と中のボックスをまとめて残す (親のいないボックスを作らない)", () => {
    const { p, a } = base();
    const child = addBlock(p, { parentId: a, title: "中のボックス" });
    const sibling = addBlock(child.project, { parentId: a, title: "中のボックス 2" });
    const b0 = fromJSON(toJSON(sibling.project));
    const ours = removeBlock(b0, a);
    const theirs = updateBlock(b0, child.blockId, { description: "相手が書いた説明" });
    const r = mergeProjects(b0, ours, theirs);
    expect(r.project.blocks[child.blockId].description).toBe("相手が書いた説明");
    expect(r.project.blocks[a]).toBeDefined();
    expect(r.project.blocks[sibling.blockId]).toBeDefined();
    expectIntact(r.project);
  });
  it("削除を選べばボックスは消え、引き継ぎメモや入出力も残らない", () => {
    const { p, a } = base();
    p.handoffs = { [a]: { note: "次はここから", actor: "codex", at: "2026-10-01" } };
    const ours = removeBlock(p, a);
    expect(ours.handoffs).toBeUndefined(); // ボックスを消すと引き継ぎメモも消える
    const theirs = updateBlock(p, a, { title: "相手が変更" });
    const c = mergeProjects(p, ours, theirs).conflicts.find((x) => x.path === `blocks.${a}`)!;
    const r = mergeProjects(p, ours, theirs, { [c.id]: "ours" });
    expect(r.project.blocks[a]).toBeUndefined();
    expect(r.project.handoffs?.[a]).toBeUndefined();
    expectIntact(r.project);
  });
});
it("distinguishes IDs containing dots from field paths", () => {
  const p = createProject("base"); const ours = structuredClone(p); const theirs = structuredClone(p);
  ours.handoffs = { "a.b": { note: "local", actor: "human", at: "today" } };
  theirs.handoffs = { "a.b": { note: "remote", actor: "human", at: "today" } };
  const c = mergeProjects(p, ours, theirs).conflicts[0];
  expect(c.segments).toEqual(["handoffs", "a.b"]);
  expect(mergeProjects(p, ours, theirs, { [c.id]: "theirs" }).project.handoffs!["a.b"].note).toBe("remote");
});

it("keeps handoff text, author and timestamp together", () => {
  const { p, a } = base();
  p.handoffs = { [a]: { note: "Before", actor: "codex", at: "2026-10-01" } };
  const ours = structuredClone(p), theirs = structuredClone(p);
  ours.handoffs![a] = { note: "Local", actor: "human", at: "2026-10-02" };
  theirs.handoffs![a] = { note: "Remote", actor: "codex", at: "2026-10-03" };
  const conflicts = mergeProjects(p, ours, theirs).conflicts;
  expect(conflicts).toHaveLength(1);
  expect(mergeProjects(p, ours, theirs, { [conflicts[0].id]: "theirs" }).project.handoffs![a]).toEqual(theirs.handoffs![a]);
});

// 新しい版が足した項目を、古い版が「知らない項目」として落とさないこと。
// 落とすと、古い版で一度保存しただけで設定が消え、Git や同期でほかの人・端末にまで配られる (0.5.0 で起きた制限)
describe("この版が知らない項目を保つ", () => {
  /** 計画の文字列に、直下とボックスの中の「知らない項目」を足す */
  const withUnknown = (text: string, blockId: string, top: unknown, inBlock: unknown): string => {
    const d = JSON.parse(text);
    d.futureSetting = top;
    d.blocks[blockId].futureField = inBlock;
    return JSON.stringify(d);
  };
  it("読み込み → 書き出しで、直下の項目もボックスの中の項目も残る。ボックスを更新しても残る", () => {
    const { p, a } = base();
    const loaded = fromJSON(withUnknown(toJSON(p), a, { mode: "strict", list: [1, 2] }, "keep me"));
    const saved = JSON.parse(toJSON(updateBlock(loaded, a, { title: "A 改" })));
    expect(saved.futureSetting).toEqual({ mode: "strict", list: [1, 2] });
    expect(saved.blocks[a].futureField).toBe("keep me");
    expect(saved.blocks[a].title).toBe("A 改");
    // 今は持たない古い項目 (updatedAt / version) は、今までどおり書かない
    expect(toJSON(fromJSON(JSON.stringify({ ...JSON.parse(toJSON(p)), updatedAt: "x", version: 3 })))).not.toContain("updatedAt");
  });
  it("知っている項目に不正な値が入っていても、知らない項目として素通ししない (今までどおり無視する)", () => {
    const { p } = base();
    const loaded = fromJSON(JSON.stringify({ ...JSON.parse(toJSON(p)), lang: "fr", contextGuard: "yes" }));
    expect(loaded.lang).toBeUndefined();
    expect(loaded.contextGuard).toBeUndefined();
  });
  it("統合: 相手だけが変えた「知らない直下の項目」と言語 (lang) を取り込む", () => {
    const { p, a } = base();
    const before = fromJSON(withUnknown(toJSON({ ...p, lang: "ja" }), a, 1, "x"));
    const theirs = fromJSON(withUnknown(toJSON({ ...p, lang: "en" }), a, 2, "y"));
    const r = mergeProjects(before, before, theirs);
    const out = r.project as unknown as Record<string, unknown>;
    expect(out.futureSetting).toBe(2);
    expect(r.project.lang).toBe("en");
    expect((r.project.blocks[a] as unknown as Record<string, unknown>).futureField).toBe("y");
    expect(r.conflicts).toEqual([]);
  });
  it("統合: 知らない直下の項目を、両方が別の値にしたら競合として出す。片方が消して片方がそのままなら消える", () => {
    const { p, a } = base();
    const before = fromJSON(withUnknown(toJSON(p), a, 1, "x"));
    const ours = fromJSON(withUnknown(toJSON(p), a, 2, "x"));
    const theirs = fromJSON(withUnknown(toJSON(p), a, 3, "x"));
    const r = mergeProjects(before, ours, theirs);
    expect(r.conflicts.map((c) => c.path)).toEqual(["futureSetting"]);
    expect((r.project as unknown as Record<string, unknown>).futureSetting).toBe(2); // 既定は自分の側
    expect((mergeProjects(before, ours, theirs, { [JSON.stringify(["futureSetting"])]: "theirs" }).project as unknown as Record<string, unknown>).futureSetting).toBe(3);
    // 相手が項目を消し、自分は変えていない → 消える
    const removed = fromJSON(toJSON(p));
    expect("futureSetting" in (mergeProjects(before, before, removed).project as unknown as Record<string, unknown>)).toBe(false);
  });
});

// 統合の結果は、競合が 0 件でも壊れた計画になることがある。書く前に確かめて、壊れていれば書かない
describe("統合した結果の検査", () => {
  /** 片方が A を B の中へ、もう片方が B を A の中へ移した計画を作る (それぞれは正しい計画) */
  const crossMoves = () => {
    const { p, a, b } = base();
    const ours = moveBlockToParent(p, a, b, { x: 40, y: 80 });
    const theirs = moveBlockToParent(p, b, a, { x: 40, y: 80 });
    return { p, ours, theirs };
  };
  it("互いを相手の中へ移した変更は、競合 0 件で合わさるが、親子が循環するので問題として検出する", () => {
    const { p, ours, theirs } = crossMoves();
    expect(projectProblem(ours)).toBeNull();
    expect(projectProblem(theirs)).toBeNull();
    const r = mergeProjects(p, ours, theirs);
    expect(r.conflicts.filter((c) => !c.automatic)).toEqual([]);
    expect(projectProblem(r.project)).not.toBeNull();
  });
  it("CLI の merge (Git 用) は、壊れた結果を書かずに失敗し、自分の側のファイルをそのまま残す", () => {
    const { p, ours, theirs } = crossMoves();
    const dir = mkdtempSync(join(tmpdir(), "boxglow-merge-"));
    try {
      const files = { base: join(dir, "base.json"), ours: join(dir, "ours.json"), theirs: join(dir, "theirs.json") };
      writeFileSync(files.base, toJSON(p)); writeFileSync(files.ours, toJSON(ours)); writeFileSync(files.theirs, toJSON(theirs));
      const before = readFileSync(files.ours, "utf8");
      // --file で計画の場所を指定する (指定が無いと、実行した場所から boxglow.json を探す。リポジトリの外やまっさらな複製では見つからない)
      const run = spawnSync(process.execPath, ["bin/boxglow.js", "merge", files.base, files.ours, files.theirs, "--file", files.ours, "--lang", "ja"], { encoding: "utf8" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("書き込みませんでした");
      expect(readFileSync(files.ours, "utf8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
