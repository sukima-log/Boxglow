/**
 * 最後の手段の経路探索: 格子 (箱の縁 ± 余白と端点の座標を集めた直交格子) の上で最短路 (Dijkstra) を求める
 *
 * routeEdge の候補 (Z 型 / U 型 / S 型 / 戻る線) は形が決まっているので、箱が入り組んでいると
 * 「通れる隙間はあるのに候補に無い」ことがある。ここでは格子の上で箱 (余白込み) を通らない辺だけをたどるので、
 * 通れる経路があれば必ず見つかる (無ければ null)。曲がりは罰を付けて少なくする。
 * 余白は 36 → 12 → 2 の順に試す (狭い隙間でも、箱を貫くよりは詰めて通す)。
 */
import { HEADER_ZONE, WALL_MARGIN, type Point, type Rect } from "./routeEdge";

/** 曲がり 1 回の罰 (長さに換算) */
const BEND = 40;

/**
 * 線分 (格子の隣り合う 2 点) が矩形 (余白込み) の内側を通るか
 * Input : ax,ay,bx,by = 線分, r = 矩形, m = 余白
 * Output: 内側を通るなら true (縁をかすめるだけは false)
 */
function blocked(ax: number, ay: number, bx: number, by: number, r: Rect, m: number): boolean {
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  return x1 > r.x - m + 0.5 && x0 < r.x + r.width + m - 0.5 && y1 > r.y - m + 0.5 && y0 < r.y + r.height + m - 0.5;
}

/**
 * 格子の上で s から t への経路を求める
 * Input : s, t = 出す側・受ける側のハンドル位置 (箱の縁の上), obstacles = 避ける箱, ends = 自分の箱 (出す側・受ける側),
 *         bounds = 親の箱 (この内側に収める。null なら制限なし), margin = 箱から離す余白
 * Output: 折れ線 (s から t まで)。経路が無ければ null
 */
export function gridRoute(s: Point, t: Point, obstacles: Rect[], ends: Rect[], bounds: Rect | null, margin: number, stubS = 40, stubT = 40): Point[] | null {
  // 出入りの直線: ポートから少し離れた点を格子の始点・終点にする (自分の箱の余白の外に出る。真横に箱があれば routeEdge が短い stub を渡す)
  // 親の縁ぎりぎりの箱では、始点・終点を親の内側に収める (routeEdge と同じ)
  const a = { x: bounds ? Math.min(s.x + stubS, Math.max(s.x + 4, bounds.x + bounds.width - WALL_MARGIN)) : s.x + stubS, y: s.y };
  const b = { x: bounds ? Math.max(t.x - stubT, Math.min(t.x - 4, bounds.x + WALL_MARGIN)) : t.x - stubT, y: t.y };
  // 格子の座標: 箱の縁 ± 余白、親の内側の縁、始点・終点
  const xs = new Set<number>([a.x, b.x]);
  const ys = new Set<number>([a.y, b.y]);
  for (const o of [...obstacles, ...ends]) {
    xs.add(o.x - margin); xs.add(o.x + o.width + margin);
    ys.add(o.y - margin); ys.add(o.y + o.height + margin);
  }
  let lo = { x: -Infinity, y: -Infinity };
  let hi = { x: Infinity, y: Infinity };
  if (bounds) {
    lo = { x: bounds.x + WALL_MARGIN, y: bounds.y + HEADER_ZONE + WALL_MARGIN };
    hi = { x: bounds.x + bounds.width - WALL_MARGIN, y: bounds.y + bounds.height - WALL_MARGIN };
    xs.add(lo.x); xs.add(hi.x); ys.add(lo.y); ys.add(hi.y);
  }
  const inRange = (v: number, l: number, h: number) => v >= l - 0.5 && v <= h + 0.5;
  const X = [...xs].filter((v) => inRange(v, Math.min(lo.x, a.x, b.x), Math.max(hi.x, a.x, b.x))).sort((p, q) => p - q);
  const Y = [...ys].filter((v) => inRange(v, Math.min(lo.y, a.y, b.y), Math.max(hi.y, a.y, b.y))).sort((p, q) => p - q);
  const nx = X.length;
  const ny = Y.length;
  const ix = (v: number) => X.indexOf(v);
  const iy = (v: number) => Y.indexOf(v);
  const sx = ix(a.x), sy = iy(a.y), tx = ix(b.x), ty = iy(b.y);
  if (sx < 0 || sy < 0 || tx < 0 || ty < 0) return null;
  // 自分の箱は余白なし (ポートが縁の上にあり、始点・終点は余白の外)。始点・終点が親の外 (親の縁のポート) でも通れるように、親の外側の判定は格子の範囲で行う
  const rects: { r: Rect; m: number }[] = [...obstacles.map((r) => ({ r, m: margin })), ...ends.map((r) => ({ r, m: 0 }))];
  const passable = (x0: number, y0: number, x1: number, y1: number): boolean => {
    for (const { r, m } of rects) if (blocked(x0, y0, x1, y1, r, m)) return false;
    return true;
  };
  // 状態 = (格子点, 向き)。向きは 0: 横 1: 縦 (曲がりの罰のため)
  const N = nx * ny * 2;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const key = (x: number, y: number, d: number) => (y * nx + x) * 2 + d;
  // 単純な二分ヒープ
  const heap: number[] = [];
  const hd: number[] = [];
  const push = (k: number, d: number) => { heap.push(k); hd.push(d); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= hd[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; [hd[p], hd[i]] = [hd[i], hd[p]]; i = p; } };
  const pop = (): number => { const top = heap[0]; const lk = heap.pop()!; const ld = hd.pop()!; if (heap.length > 0) { heap[0] = lk; hd[0] = ld; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && hd[l] < hd[m]) m = l; if (r < heap.length && hd[r] < hd[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; [hd[m], hd[i]] = [hd[i], hd[m]]; i = m; } } return top; };
  for (const d of [0, 1]) { dist[key(sx, sy, d)] = 0; push(key(sx, sy, d), 0); }
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1]];
  let goal = -1;
  while (heap.length > 0) {
    const k = pop();
    const d0 = dist[k];
    const dir = k % 2;
    const cell = (k - dir) / 2;
    const x = cell % nx;
    const y = (cell - x) / nx;
    if (x === tx && y === ty) { goal = k; break; }
    for (const [dx, dy, nd] of dirs) {
      const x2 = x + dx, y2 = y + dy;
      if (x2 < 0 || x2 >= nx || y2 < 0 || y2 >= ny) continue;
      if (!passable(X[x], Y[y], X[x2], Y[y2])) continue;
      const step = Math.abs(X[x2] - X[x]) + Math.abs(Y[y2] - Y[y]);
      const nk = key(x2, y2, nd);
      const nd0 = d0 + step + (nd !== dir ? BEND : 0);
      if (nd0 < dist[nk]) { dist[nk] = nd0; prev[nk] = k; push(nk, nd0); }
    }
  }
  if (goal < 0) return null;
  // 経路を戻しながら点列にする (同じ点の重複と直線上の点は取り除く)
  const pts: Point[] = [];
  for (let k = goal; k >= 0; k = prev[k]) {
    const dir = k % 2; const cell = (k - dir) / 2; const x = cell % nx; const y = (cell - x) / nx;
    const q = { x: X[x], y: Y[y] };
    if (pts.length === 0 || pts[0].x !== q.x || pts[0].y !== q.y) pts.unshift(q);
    if (k === key(sx, sy, 0) || k === key(sx, sy, 1)) break;
  }
  const out: Point[] = [s, ...pts, t];
  for (let i = 1; i < out.length - 1; ) {
    const p0 = out[i - 1], p1 = out[i], p2 = out[i + 1];
    if ((p0.x === p1.x && p1.x === p2.x) || (p0.y === p1.y && p1.y === p2.y)) out.splice(i, 1);
    else i++;
  }
  return out;
}

/**
 * 余白を 36 → 12 → 2 の順に緩めて格子の経路を探す
 * Input : gridRoute と同じ (margin を除く)
 * Output: 折れ線、または null (どの余白でも通れない)
 */
export function gridRouteRelaxed(s: Point, t: Point, obstacles: Rect[], ends: Rect[], bounds: Rect | null, stubS = 40, stubT = 40): Point[] | null {
  for (const m of [36, 12, 2]) {
    const r = gridRoute(s, t, obstacles, ends, bounds, m, stubS, stubT);
    if (r) return r;
  }
  return null;
}
