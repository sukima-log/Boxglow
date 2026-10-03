/**
 * 無作為な配置で「線が箱を貫かない」ことを確かめる (性質テスト)
 * 親の箱の中に大きさの違う箱を無作為に置き (隙間は 24px 以上。詰めた配置も含む)、無作為に結線して routeAll で経路を求め、
 * どの線分も両端以外の箱の内側を通らないこと、両端の箱も反対側から貫かないことを調べる
 */
import { describe, expect, it } from "vitest";
import { routeAll, type EdgeSpec, type NodeRect } from "./routeAll";
import type { Point, Rect } from "./routeEdge";

/** 決定的な疑似乱数 (再現できるように) */
function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0xffffffff; };
}

/** 線分が矩形の内側 (inset だけ縮めた) を通るか */
function hits(a: Point, b: Point, r: Rect, inset: number): boolean {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return x1 > r.x + inset && x0 < r.x + r.width - inset && y1 > r.y + inset && y0 < r.y + r.height - inset;
}

/** 1 回分の無作為な配置と結線を作る */
function makeCase(seed: number, gapMin: number): { nodes: NodeRect[]; edges: EdgeSpec[]; parent: Rect } {
  const rand = rng(seed);
  const parent: Rect = { x: 100, y: 100, width: 1800 + Math.floor(rand() * 1200), height: 1200 + Math.floor(rand() * 900) };
  const boxes: Rect[] = [];
  const count = 6 + Math.floor(rand() * 14);
  for (let tries = 0; boxes.length < count && tries < 400; tries++) {
    const w = 200 + Math.floor(rand() * 320);
    const h = 80 + Math.floor(rand() * 180);
    const x = parent.x + 24 + Math.floor(rand() * (parent.width - w - 48));
    const y = parent.y + 90 + Math.floor(rand() * (parent.height - h - 120));
    const r = { x, y, width: w, height: h };
    const ok = boxes.every((o) => r.x >= o.x + o.width + gapMin || r.x + r.width + gapMin <= o.x || r.y >= o.y + o.height + gapMin || r.y + r.height + gapMin <= o.y);
    if (ok) boxes.push(r);
  }
  const nodes: NodeRect[] = [{ id: "P", parentId: "", rect: parent }, ...boxes.map((rect, i) => ({ id: `B${i}`, parentId: "P", rect }))];
  const edges: EdgeSpec[] = [];
  const n = boxes.length;
  const edgeCount = Math.min(n * 2, 24);
  for (let i = 0; i < edgeCount; i++) {
    const si = Math.floor(rand() * n);
    let ti = Math.floor(rand() * n);
    if (ti === si) ti = (ti + 1) % n;
    const sr = boxes[si], tr = boxes[ti];
    // 出力は右の縁、入力は左の縁 (ポートの行はいくつかのうちから無作為)
    const s = { x: sr.x + sr.width, y: sr.y + 60 + Math.floor(rand() * Math.max(1, sr.height - 80)) };
    const t = { x: tr.x, y: tr.y + 60 + Math.floor(rand() * Math.max(1, tr.height - 80)) };
    edges.push({ id: `E${i}`, source: `B${si}`, target: `B${ti}`, s, t });
  }
  return { nodes, edges, parent };
}

describe("無作為な配置でも線は箱を貫かない", () => {
  for (const [label, gapMin] of [["通常の間隔 (96px 以上)", 96], ["詰めた間隔 (24px 以上)", 24]] as const) {
    it(label, { timeout: 120000 }, () => { // 300 通りの経路計算は CI の遅い環境でも数十秒かかることがある (既定の 5 秒では足りない)
      const failures: string[] = [];
      let total = 0;
      for (let seed = 1; seed <= 150; seed++) {
        const { nodes, edges } = makeCase(seed * 7919 + gapMin, gapMin);
        const paths = routeAll(nodes, edges);
        const rectOf = new Map(nodes.map((n) => [n.id, n.rect]));
        for (const e of edges) {
          const path = paths.get(e.id)!;
          expect(path.length).toBeGreaterThanOrEqual(2);
          total++;
          for (let i = 1; i < path.length; i++) {
            for (const n of nodes) {
              if (n.id === "P") continue;
              const own = n.id === e.source || n.id === e.target;
              if (hits(path[i - 1], path[i], rectOf.get(n.id)!, own ? 8 : 1)) {
                failures.push(`seed ${seed}: ${e.id} (${e.source} -> ${e.target}) が ${n.id} を貫通 (seg ${i})`);
                break;
              }
            }
          }
        }
      }
      expect(failures, failures.slice(0, 10).join("\n")).toEqual([]);
      expect(total).toBeGreaterThan(1500);
    });
  }
});
