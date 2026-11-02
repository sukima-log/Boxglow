/**
 * 重なりの解消の入口 (overlaps.ts) と、箱の大きさの使い回し (memoBlockSize / 画面用の索引) の確認
 *   索引・使い回しを使っても、使わずに求めたときと同じ大きさ・同じ位置になること。箱が 1000 を超える計画でも編集 1 回の解消がすぐ終わること
 */
import { afterEach, describe, expect, it } from "vitest";
import { addBlock, addPort, childrenOf, connect, createProject, moveBlock, portsOf, projectBlocks, resolveAllOverlaps, resolveChangedOverlaps, toJSON, updateBlock, withMoveIndex, withViewIndex } from "./graph";
import { blockSize, memoBlockSize, taskCardLayout } from "./size";
import { resolveEditOverlaps, resolveShownOverlaps } from "./overlaps";
import { buildSampleProject } from "./sample";
import { setLang } from "../i18n/core";
import type { Project } from "./types";

afterEach(() => setLang("ja"));

/** 全部の箱の大きさ (比べる項目だけ) */
const sizes = (p: Project, size: (p: Project, id: string) => { width: number; height: number; headerH: number }) =>
  Object.keys(p.blocks).filter((id) => id !== "root").map((id) => { const s = size(p, id); return [id, s.width, s.height, s.headerH]; });

/** 全部の箱を開いた計画 (開いた箱の大きさは中の箱を全部たどって求める) */
const openAll = (p: Project): Project => ({ ...p, blocks: Object.fromEntries(Object.entries(p.blocks).map(([id, b]) => [id, { ...b, collapsed: false }])) });

/**
 * 大きな計画: 大項目 12 個 x 中の箱 3 個 x その中の箱 30 個 (約 1100 個)。中の箱は 1 列に線でつなぐ
 *   Output: { p, leaf = 一番深い箱の 1 つ }
 */
function bigPlan() {
  let p = createProject("大きな計画");
  const pj = projectBlocks(p)[0].id;
  const base = structuredClone(p.blocks[pj]);
  let leaf = "";
  for (let m = 0; m < 12; m++) {
    const major = `m${m}`;
    p.blocks[major] = { ...structuredClone(base), id: major, parentId: pj, kind: undefined, key: `M${m}`, title: `大項目${m}`, decisions: [], activity: null, status: "black", collapsed: false, position: { x: m * 900, y: 0 } };
    for (let g = 0; g < 3; g++) {
      const group = `${major}g${g}`;
      p.blocks[group] = { ...structuredClone(p.blocks[major]), id: group, parentId: major, key: `G${m}_${g}`, title: `組${m}-${g}`, position: { x: 40, y: 80 + g * 2000 } };
      let prev = "";
      for (let i = 0; i < 30; i++) {
        const id = `${group}b${i}`, inId = `${id}-in`, outId = `${id}-out`;
        p.blocks[id] = { ...structuredClone(p.blocks[group]), id, parentId: group, key: `B${m}_${g}_${i}`, title: `箱${m}-${g}-${i}`, position: { x: 40 + (i % 5) * 300, y: 80 + Math.floor(i / 5) * 260 } };
        p.ports[inId] = { id: inId, blockId: id, direction: "in", name: `材料${i}`, description: "", required: true, artifacts: [] };
        p.ports[outId] = { id: outId, blockId: id, direction: "out", name: `成果${i}`, description: "", required: true, artifacts: [] };
        if (prev) p.edges[`e${id}`] = { id: `e${id}`, from: { portId: prev, side: "outer" }, to: { portId: inId, side: "outer" }, kind: "sibling", auto: false };
        prev = outId; leaf = id;
      }
    }
  }
  return { p, leaf };
}

describe("箱の大きさの使い回し", () => {
  it("畳んだ箱の大きさは、入出力の並び (線の相手の上下の順) によらず taskCardLayout と同じ", () => {
    let p = createProject("t");
    const pj = projectBlocks(p)[0].id;
    const a = addBlock(p, { parentId: pj, title: "上", position: { x: 0, y: 0 } }); p = a.project;
    const b = addBlock(p, { parentId: pj, title: "下", position: { x: 0, y: 400 } }); p = b.project;
    const c = addBlock(p, { parentId: pj, title: "とても長い名前の入力を 2 つ受け取る箱", position: { x: 600, y: 200 } }); p = c.project;
    // 下の箱からの線を 1 つ目の入力に、上の箱からの線を 2 つ目の入力につなぐ (表示では並びが入れ替わる)
    const i1 = addPort(p, { blockId: c.blockId, direction: "in", name: "下から来るとても長い名前の材料" }); p = i1.project;
    const i2 = addPort(p, { blockId: c.blockId, direction: "in", name: "上から" }); p = i2.project;
    p = connect(p, { portId: portsOf(p, b.blockId, "out")[0].id, side: "outer" }, { portId: i1.portId, side: "outer" }).project;
    p = connect(p, { portId: portsOf(p, a.blockId, "out")[0].id, side: "outer" }, { portId: i2.portId, side: "outer" }).project;
    const card = taskCardLayout(p, c.blockId);
    expect(card.inputs.map((r) => r.id)).toEqual([i2.portId, i1.portId]); // 並びは入れ替わっている
    const s = blockSize(p, c.blockId);
    expect([s.width, s.height, s.headerH]).toEqual([card.width, card.height, card.headerH]);
  });

  it("memoBlockSize と画面用の索引の中の blockSize は、使い回さずに求めた大きさと同じ (畳んだ計画・全部開いた計画)", () => {
    for (const p of [buildSampleProject(), openAll(buildSampleProject())]) {
      const plain = sizes(p, blockSize);
      expect(sizes(p, memoBlockSize())).toEqual(plain);
      expect(withViewIndex(p, () => sizes(p, blockSize))).toEqual(plain);
    }
  });

  it("画面用の索引に覚えた大きさは言語ごと (英語に切り替えると英語の幅で求め直す)", () => {
    // 開いた箱の幅・題名の行数は、題名の横のカテゴリの札の文字の幅で変わる (「評価」と "Evaluate")。
    // 中の箱を 1 つだけ置いた箱で、日本語と英語で大きさが変わる題名の長さを探して使う
    const make = (title: string) => {
      let p = createProject("t");
      const box = addBlock(p, { parentId: projectBlocks(p)[0].id, title, position: { x: 0, y: 0 } }); p = box.project;
      p = addBlock(p, { parentId: box.blockId, title: "中", position: { x: 16, y: 120 } }).project;
      return updateBlock(p, box.blockId, { category: "evaluate", collapsed: false });
    };
    const differs = (p: Project) => { setLang("ja"); const ja = sizes(p, blockSize); setLang("en"); const en = sizes(p, blockSize); setLang("ja"); return JSON.stringify(ja) !== JSON.stringify(en); };
    const p = Array.from({ length: 40 }, (_, n) => make("題".repeat(n + 1))).find(differs)!;
    expect(p).toBeDefined();
    const ja = withViewIndex(p, () => sizes(p, blockSize));
    setLang("en");
    const en = withViewIndex(p, () => sizes(p, blockSize));
    expect(en).toEqual(sizes(p, blockSize));
    expect(en).not.toEqual(ja);
  });
});

describe("位置だけを変える処理向けの索引 (withMoveIndex)", () => {
  it("途中で箱を差し替えた計画でも、子を今の箱 (動かした位置) で、索引なしと同じ並びで返す", () => {
    const p = openAll(buildSampleProject());
    const parent = Object.values(p.blocks).find((b) => childrenOf(p, b.id).length > 1)!.id;
    const kid = childrenOf(p, parent)[0];
    const moved: Project = { ...p, blocks: { ...p.blocks, [kid.id]: { ...kid, position: { x: kid.position.x + 999, y: kid.position.y } } } };
    const expected = childrenOf(moved, parent);
    withMoveIndex(p, () => {
      expect(childrenOf(moved, parent)).toEqual(expected);
      expect(childrenOf(moved, parent).find((b) => b.id === kid.id)?.position.x).toBe(kid.position.x + 999);
    });
  });

  it("変更前と変更後の 2 つの計画の索引を同時に使っても、それぞれ正しく引ける", () => {
    const before = buildSampleProject();
    const block = Object.values(before.blocks).find((b) => portsOf(before, b.id).length > 0 && b.parentId)!;
    const after = addPort(before, { blockId: block.id, direction: "in", name: "追加した入力" }).project;
    withViewIndex(before, () => withMoveIndex(after, () => {
      expect(portsOf(after, block.id).length).toBe(portsOf(before, block.id).length + 1);
      expect(portsOf(before, block.id).map((q) => q.id)).toEqual(Object.values(before.ports).filter((q) => q.blockId === block.id).map((q) => q.id));
    }));
  });
});

describe("重なりの解消の入口", () => {
  it("編集の確定・表示用の計画とも、索引なしで求めた結果と同じ位置になる", () => {
    const p = openAll(buildSampleProject());
    const ids = Object.keys(p.blocks).filter((id) => id !== "root" && p.blocks[id].parentId !== "root");
    for (const id of ids.slice(0, 12)) {
      const b = p.blocks[id];
      for (const after of [
        updateBlock(p, id, { title: b.title + " を足して長くした題名の続き" })
      , moveBlock(p, id, { x: b.position.x + 120, y: b.position.y + 40 })
      , addPort(p, { blockId: id, direction: "in", name: "とても長い名前の新しい入力" }).project
      ]) {
        expect(toJSON(resolveEditOverlaps(p, after))).toBe(toJSON(resolveChangedOverlaps(p, after, blockSize)));
      }
    }
    expect(toJSON(resolveShownOverlaps(p))).toBe(toJSON(resolveAllOverlaps(p, blockSize)));
  });

  it("箱が 1000 を超える計画でも、編集 1 回の重なりの解消がすぐ終わる (2026-11-02 に 4 秒かかっていた)", () => {
    const { p, leaf } = bigPlan();
    expect(Object.keys(p.blocks).length).toBeGreaterThan(1000);
    const after = updateBlock(p, leaf, { title: p.blocks[leaf].title + " を足して長くした題名" });
    const started = performance.now();
    const fast = resolveEditOverlaps(p, after);
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(1500);
    expect(toJSON(fast)).toBe(toJSON(resolveChangedOverlaps(p, after, blockSize)));
  }, 60_000);
});
