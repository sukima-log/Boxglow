/**
 * 同じ階層の線をまとめて経路計算し、縦の通路が重なる線を横にずらす (純粋関数)
 * 1 本ずつ別々に計算すると同じ通路に重なるため、全部の経路が決まってから重なりを解く。
 */
import { marginOf, wallsOf, routeEdge, type Point, type Rect } from "./routeEdge";

export interface NodeRect {
  id: string;
  parentId: string;
  rect: Rect;
}

export interface EdgeSpec {
  id: string;
  source: string;
  target: string;
  s: Point;
  t: Point;
}

/** 縦の線分どうしをずらす間隔 (最小) */
const SEP = 16;
/** 束の広がりの上限 (片側) */
const SPREAD_MAX = 96;
/** 同じ通路とみなす x の近さ */
const NEAR = 16; // 間隔 (SEP) より近い線は同じ束として広げる (6 だと 8〜15px ずれた線が重なって見えたまま残る)
/** 箱の縁から線を離す余白 (routeEdge と同じ) */


/**
 * すべての線の経路を求める
 * Input : nodes = 見えているノードの絶対位置, edges = 線 (端点の位置つき)
 * Output: 線 id -> 折れ線
 */
export function routeAll(nodes: NodeRect[], edges: EdgeSpec[]): Map<string, Point[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map<string, Point[]>();
  const scopeOf = new Map<string, string>();
  const obstaclesOf = new Map<string, Rect[]>();
  for (const e of edges) {
    const sNode = byId.get(e.source);
    const tNode = byId.get(e.target);
    const scope = sNode && tNode ? (tNode.parentId === e.source ? tNode.parentId : sNode.parentId === e.target ? sNode.parentId : sNode.parentId) : "";
    scopeOf.set(e.id, scope);
    const obstacles = nodes.filter((r) => r.id !== e.source && r.id !== e.target && r.parentId === scope && r.rect.width > 0).map((r) => r.rect);
    const parentSide = sNode && tNode ? (tNode.parentId === e.source ? e.source : sNode.parentId === e.target ? e.target : null) : null;
    const ends = [sNode, tNode].filter((n) => n && n.id !== parentSide && n.rect.width > 0).map((n) => n!.rect);
    const scopeNode = scope ? byId.get(scope) : undefined;
    const bounds = scopeNode && scopeNode.rect.width > 0 ? scopeNode.rect : null;
    paths.set(e.id, routeEdge(e.s, e.t, obstacles, 0, ends, bounds));
    if (!obstaclesOf.has(scope)) {
      // ずらすときに避ける箱: その階層の全部の箱 (端点の箱も含む) と、親の箱の内側の縁
      const all = nodes.filter((r) => r.parentId === scope && r.rect.width > 0).map((r) => r.rect);
      if (bounds) all.push(...wallsOf(bounds)); // 親の縁は、縁の外側に置いた壁として表す
      obstaclesOf.set(scope, all);
    }
  }
  // 広げた結果、束に入っていなかった別の線の真上に乗ることがあるので、数回繰り返して収束させる
  // (間隔どおりに並んだ束は再び同じ位置に広がるだけなので、繰り返しても崩れない)
  for (let pass = 0; pass < 4; pass++) {
    separateVerticals(paths, scopeOf, obstaclesOf);
    separateHorizontals(paths, scopeOf, obstaclesOf);
  }
  return paths;
}

/**
 * 横の線分 (y, x0..x1) を置ける y の範囲: 横の範囲がかぶる箱から MARGIN 以上離れた、y を含む隙間
 * Input : y = 今の位置, x0, x1, obstacles
 * Output: [lo, hi]
 */
function freeRangeAtY(y: number, x0: number, x1: number, obstacles: Rect[]): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (const o of obstacles) {
    if (o.wall === "left" || o.wall === "right") continue; // 左右の壁は横線分の y を制約しない (親の縁のハンドルから出る線は箱の外から始まる)
    const m = marginOf(o);
    if (o.x + o.width + m < x0 || o.x - m > x1) continue; // 横にかぶらない箱は関係ない
    const top = o.y - m;
    const bottom = o.y + o.height + m;
    if (bottom <= y) lo = Math.max(lo, bottom);
    else if (top >= y) hi = Math.min(hi, top);
    else if (y - top < bottom - y) hi = Math.min(hi, top);
    else lo = Math.max(lo, bottom);
  }
  if (hi < lo) return [y, y];
  return [lo, hi];
}

interface HSeg {
  edgeId: string;
  idx: number; // path[idx] と path[idx+1] が横の線分
  y: number;
  x0: number;
  x1: number;
}

/**
 * 同じ階層で、同じ通路 (y が近い) にあり、横の範囲が重なる線分を上下にずらす (separateVerticals の横版)
 * 出入りの最初と最後の線分 (ハンドルに付く) は動かさない
 */
function separateHorizontals(paths: Map<string, Point[]>, scopeOf: Map<string, string>, obstaclesOf: Map<string, Rect[]>): void {
  const byScope = new Map<string, HSeg[]>();
  for (const [edgeId, path] of paths) {
    const scope = scopeOf.get(edgeId) ?? "";
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) >= 2) {
        if (i === 0 || i + 1 === path.length - 1) continue;
        const list = byScope.get(scope) ?? [];
        list.push({ edgeId, idx: i, y: a.y, x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x) });
        byScope.set(scope, list);
      }
    }
  }
  for (const [scope, segs] of byScope) {
    const obstacles = obstaclesOf.get(scope) ?? [];
    segs.sort((p, q) => p.y - q.y);
    const parent = segs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[j].y - segs[i].y > NEAR) break;
        if (segs[i].edgeId === segs[j].edgeId) continue;
        const overlap = Math.min(segs[i].x1, segs[j].x1) - Math.max(segs[i].x0, segs[j].x0);
        if (overlap > 0) parent[find(j)] = find(i);
      }
    }
    const groups = new Map<number, HSeg[]>();
    for (let i = 0; i < segs.length; i++) {
      const g = find(i);
      const list = groups.get(g) ?? [];
      list.push(segs[i]);
      groups.set(g, list);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ids = [...new Set(group.map((g) => g.edgeId))];
      if (ids.length < 2) continue;
      const baseY = group.reduce((acc, g) => acc + g.y, 0) / group.length;
      // 左から来る線を上に、右へ行く線を下に (交差を減らす): 線分の中心 x で並べる
      const order = ids
        .map((id) => ({ id, mid: group.filter((g) => g.edgeId === id).reduce((acc, g) => acc + (g.x0 + g.x1) / 2, 0) }))
        .sort((p, q) => p.mid - q.mid)
        .map((o) => o.id);
      let lo = -Infinity;
      let hi = Infinity;
      for (const g of group) {
        const [l, h] = freeRangeAtY(g.y, g.x0, g.x1, obstacles);
        lo = Math.max(lo, l);
        hi = Math.min(hi, h);
      }
      const room = Number.isFinite(lo) && Number.isFinite(hi) ? Math.max(0, hi - lo) : SPREAD_MAX * 2;
      const sep = Math.max(6, Math.min(SEP, Math.min(SPREAD_MAX * 2, room) / Math.max(1, order.length - 1)));
      let center = baseY;
      const half = ((order.length - 1) / 2) * sep;
      if (Number.isFinite(lo) && center - half < lo) center = lo + half;
      if (Number.isFinite(hi) && center + half > hi) center = hi - half;
      order.forEach((id, k) => {
        const y = center + (k - (order.length - 1) / 2) * sep;
        const path = paths.get(id)!;
        for (const g of group) {
          if (g.edgeId !== id) continue;
          path[g.idx] = { ...path[g.idx], y };
          path[g.idx + 1] = { ...path[g.idx + 1], y };
        }
      });
    }
  }
}

/**
 * 縦の線分 (x, y0..y1) を置ける x の範囲: 縦の範囲がかぶる箱から MARGIN 以上離れた、x を含む隙間
 * Input : x = 今の位置, y0, y1, obstacles
 * Output: [lo, hi]
 */
function freeRangeAt(x: number, y0: number, y1: number, obstacles: Rect[]): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (const o of obstacles) {
    if (o.wall === "top" || o.wall === "bottom") continue; // 上下の壁は縦線分の x を制約しない
    const m = marginOf(o); // 壁は箱より近づいてよい
    if (o.y + o.height + m < y0 || o.y - m > y1) continue; // 縦にかぶらない箱は関係ない
    const left = o.x - m;
    const right = o.x + o.width + m;
    if (right <= x) lo = Math.max(lo, right);
    else if (left >= x) hi = Math.min(hi, left);
    else if (x - left < right - x) hi = Math.min(hi, left); // 余白の中 (左寄り): 左へ押し出す
    else lo = Math.max(lo, right); // 余白の中 (右寄り。親の縁のすぐ内側など): 右へ押し出す
  }
  if (hi < lo) return [x, x]; // 両側から挟まれて置けない: 動かさない
  return [lo, hi];
}

interface VSeg {
  edgeId: string;
  idx: number; // path[idx] と path[idx+1] が縦の線分
  x: number;
  y0: number;
  y1: number;
}

/**
 * 同じ階層で、同じ通路 (x が近い) にあり、縦の範囲が重なる線分を見つけて横にずらす
 * 同じ線の中の縦線分はずらしても形が保たれる (隣の横線分の端点が一緒に動く)
 */
function separateVerticals(paths: Map<string, Point[]>, scopeOf: Map<string, string>, obstaclesOf: Map<string, Rect[]>): void {
  // 階層ごとに縦の線分を集める
  const byScope = new Map<string, VSeg[]>();
  for (const [edgeId, path] of paths) {
    const scope = scopeOf.get(edgeId) ?? "";
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= 2) {
        // 出入りの最初と最後の線分 (ハンドルに付く) は動かさない
        if (i === 0 || i + 1 === path.length - 1) continue;
        const list = byScope.get(scope) ?? [];
        list.push({ edgeId, idx: i, x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) });
        byScope.set(scope, list);
      }
    }
  }
  for (const [scope, segs] of byScope) {
    const obstacles = obstaclesOf.get(scope) ?? [];
    // x が近く縦の範囲が重なるものを同じ束にする (連結成分)
    segs.sort((p, q) => p.x - q.x);
    const parent = segs.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[j].x - segs[i].x > NEAR) break;
        if (segs[i].edgeId === segs[j].edgeId) continue;
        const overlap = Math.min(segs[i].y1, segs[j].y1) - Math.max(segs[i].y0, segs[j].y0);
        if (overlap > 0) parent[find(j)] = find(i);
      }
    }
    const groups = new Map<number, VSeg[]>();
    for (let i = 0; i < segs.length; i++) {
      const g = find(i);
      const list = groups.get(g) ?? [];
      list.push(segs[i]);
      groups.set(g, list);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // 同じ線の線分が複数あれば 1 つにまとめて数える
      const ids = [...new Set(group.map((g) => g.edgeId))];
      if (ids.length < 2) continue;
      const baseX = group.reduce((acc, g) => acc + g.x, 0) / group.length;
      // 上から来る線を左に、下へ行く線を右に (交差を減らす): 線分の中心 y で並べる
      const order = ids
        .map((id) => ({ id, mid: group.filter((g) => g.edgeId === id).reduce((acc, g) => acc + (g.y0 + g.y1) / 2, 0) }))
        .sort((p, q) => p.mid - q.mid)
        .map((o) => o.id);
      // 束全体が置ける範囲: 各線分の空き範囲の共通部分 (箱から MARGIN 以上離れる)
      let lo = -Infinity;
      let hi = Infinity;
      for (const g of group) {
        const [l, h] = freeRangeAt(g.x, g.y0, g.y1, obstacles);
        lo = Math.max(lo, l);
        hi = Math.min(hi, h);
      }
      const room = Number.isFinite(lo) && Number.isFinite(hi) ? Math.max(0, hi - lo) : SPREAD_MAX * 2;
      // 本数が多いほど間隔を少し詰め、束全体が通路 (と空き範囲) からはみ出さないようにする
      const sep = Math.max(6, Math.min(SEP, (Math.min(SPREAD_MAX * 2, room)) / Math.max(1, order.length - 1)));
      let center = baseX;
      const half = ((order.length - 1) / 2) * sep;
      if (Number.isFinite(lo) && center - half < lo) center = lo + half;
      if (Number.isFinite(hi) && center + half > hi) center = hi - half;
      order.forEach((id, k) => {
        const x = center + (k - (order.length - 1) / 2) * sep;
        const path = paths.get(id)!;
        for (const g of group) {
          if (g.edgeId !== id) continue;
          path[g.idx] = { ...path[g.idx], x };
          path[g.idx + 1] = { ...path[g.idx + 1], x };
        }
      });
    }
  }
}
