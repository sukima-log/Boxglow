/**
 * 線の経路探索 (純粋関数): ボックスを避ける直角の線
 *
 * 出す側 (右向きに出る) から受ける側 (左から入る) まで、
 *   Z 型: 右へ → 縦の通路 → 右へ
 *   U 型: 右へ → 縦の通路 → 横の通路 (ボックスの上下の空き) → 縦の通路 → 右へ
 * の候補を作り、「ボックスとの交差 (重い) + 長さ + 曲がりの数」が最小の経路を選ぶ。
 */

import { gridRouteRelaxed } from "./gridRoute";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 親のボックスの縁を表す壁 (ボックスより近づいてよい)。向きを持つ: 左右の壁は x を、上下の壁は y を制約する */
  wall?: "left" | "right" | "top" | "bottom";
}

export type Point = { x: number; y: number };

/** ボックスの縁から線を離す余白 */
const MARGIN = 36;
/** 親のボックスの縁 (壁) から線を離す余白 (ボックスより小さくてよい。ボックスの中の通路を広く使うため) */
export const WALL_MARGIN = 12;
/** 矩形ごとの余白 (壁は小さく) */
export const marginOf = (r: Rect): number => (r.wall ? WALL_MARGIN : MARGIN);
/**
 * 通路がどこにも無いときの予備の余白 (ボックスとボックスの隙間が MARGIN * 2 に満たないとき)。
 * 段違いのボックス (高さの違うボックスが別の列にある) の間は 36px * 2 の通路が取れないことがあり、
 * 通常の余白の候補だけでは「ボックスを貫く候補」しか残らない。詰めた通路は NEAR_PENALTY が付くので、
 * 通常の通路があるときは選ばれず、無いときだけ貫通の代わりに選ばれる
 */
export const SQUEEZE_MARGIN = 12;
/** 出入りの最初の直線の長さ */
const STUB = 40;
/** ボックスを貫く 1 回の罰 (長さに換算)。他のどんな罰 (壁・親の外・近さ・曲がり・遠回り) の合計より大きく、ボックスを貫く経路は最後まで選ばれない */
const CROSS_PENALTY = 10000000;
/** 親の縁 (壁) を越える・親の外に出る 1 回の罰。ボックスを貫くより桁違いに軽い (親の縁ぎりぎりのボックスから出る線は、少し外にはみ出してもボックスは貫かない) */
const WALL_PENALTY = 100000;
/** 曲がり 1 回の罰 */
const BEND_PENALTY = 40;
/** ボックス (や親の縁) に MARGIN より近づく 1 回の罰 (貫くよりは軽いが、回り道より重い) */
const NEAR_PENALTY = 1500;
/** 出入りの線分が自分のボックスを貫いているとみなす内側の幅 (ポートの丸は縁の上にあり、数 px はボックスにかかる) */
const END_INSET = 8;
/** ほかの線と交差する 1 回の罰 (ボックスに近づくより軽く、曲がり・少しの遠回りより重い。交差は読みにくさの元) */
const WIRE_CROSS_PENALTY = 600;

/** 2 本の線分 (水平と垂直) が互いの内側で交差するか (端で触れるだけは数えない) */
function segmentsCross(a0: Point, a1: Point, b0: Point, b1: Point): boolean {
  const aH = Math.abs(a0.y - a1.y) < 0.5;
  const bH = Math.abs(b0.y - b1.y) < 0.5;
  if (aH === bH) return false; // 平行 (重なりは後で束としてずらす)
  const [h0, h1, v0, v1] = aH ? [a0, a1, b0, b1] : [b0, b1, a0, a1];
  const hx0 = Math.min(h0.x, h1.x);
  const hx1 = Math.max(h0.x, h1.x);
  const vy0 = Math.min(v0.y, v1.y);
  const vy1 = Math.max(v0.y, v1.y);
  return v0.x > hx0 + 1 && v0.x < hx1 - 1 && h0.y > vy0 + 1 && h0.y < vy1 - 1;
}

/**
 * 経路がほかの線と交差する回数
 * Input : path, others = ほかの線の折れ線
 * Output: 交差の回数
 */
export function wireCrossings(path: Point[], others: Point[][]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) {
    for (const o of others) {
      for (let j = 1; j < o.length; j++) if (segmentsCross(path[i - 1], path[i], o[j - 1], o[j])) n++;
    }
  }
  return n;
}

/**
 * ほかの線と同じ通路に重なっている長さを測る
 * 別の出力との重なりは接続に見えるため、幹をそろえる処理 (bundleFanout) が、そろえた結果の良し悪しを比べるのに使う。
 * 経路選び (chooseRoute) の罰には足さない: 足すと交差が大きく増え (自分の計画で 162 → 781)、タブの切り替えも遅くなる。
 * 別々の線の重なりは routeAll の separateVerticals / separateHorizontals が後からずらして解く。
 * Input : path = 調べる折れ線, others = ほかの線の折れ線
 * Output: 重なりの長さの合計 (px)。水平どうし・垂直どうしで、位置の差が 1px 未満の線分が重なる区間を足す
 */
export function wireOverlap(path: Point[], others: Point[][]): number {
  let total = 0;
  for (let i=1;i<path.length;i++) for (const other of others) for (let j=1;j<other.length;j++) {
    const a=path[i-1],b=path[i],c=other[j-1],d=other[j];
    if (a.y===b.y && c.y===d.y && Math.abs(a.y-c.y)<1)
      total+=Math.max(0,Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))-Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x)));
    else if (a.x===b.x && c.x===d.x && Math.abs(a.x-c.x)<1)
      total+=Math.max(0,Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y))-Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y)));
  }
  return total;
}

/** 親のボックスの題名の行の高さ (子はこの下に置かれる。線もこの下を通る) */
export const HEADER_ZONE = 76;

/** 親のボックスの縁を、縁の外側に置いた厚い壁 (矩形) として表す。上の壁は題名の行の分だけ内側まで広げる (題名の裏を線が通らないように) */
export function wallsOf(bounds: Rect): Rect[] {
  const T = 1000;
  return [
    { x: bounds.x - T, y: bounds.y - T, width: T, height: bounds.height + 2 * T, wall: "left" }
  , { x: bounds.x + bounds.width, y: bounds.y - T, width: T, height: bounds.height + 2 * T, wall: "right" }
  , { x: bounds.x - T, y: bounds.y - T, width: bounds.width + 2 * T, height: T + HEADER_ZONE, wall: "top" } // 題名の行まで
  , { x: bounds.x - T, y: bounds.y + bounds.height, width: bounds.width + 2 * T, height: T, wall: "bottom" }
  ];
}

/** 前計算した矩形の境界 (線分との判定を数値の比較だけにする) */
interface Bounds4 { x0: number; y0: number; x1: number; y1: number }
/** 線分 (水平または垂直) が前計算した境界の内側を通るか */
const hits = (ax: number, ay: number, bx: number, by: number, r: Bounds4): boolean => {
  const x0 = ax < bx ? ax : bx;
  const x1 = ax < bx ? bx : ax;
  const y0 = ay < by ? ay : by;
  const y1 = ay < by ? by : ay;
  return x1 >= r.x0 && x0 <= r.x1 && y1 >= r.y0 && y0 <= r.y1;
};
/** 矩形の内側 (縁をかすめるだけは数えない) */
const innerOf = (r: Rect): Bounds4 => ({ x0: r.x + 1, y0: r.y + 1, x1: r.x + r.width - 1, y1: r.y + r.height - 1 });
/** 矩形の余白込み (ボックスは MARGIN、壁は WALL_MARGIN) */
const nearOf = (r: Rect): Bounds4 => { const m = marginOf(r); return { x0: r.x - m + 2, y0: r.y - m + 2, x1: r.x + r.width + m - 2, y1: r.y + r.height + m - 2 }; };
/** 自分のボックスの縁から END_INSET 内側 */
const insetOf = (r: Rect): Bounds4 => ({ x0: r.x + END_INSET + 1, y0: r.y + END_INSET + 1, x1: r.x + r.width - END_INSET - 1, y1: r.y + r.height - END_INSET - 1 });

/** 評価に使う矩形一式 (rankRoutes が 1 回だけ作り、全候補で使い回す) */
interface CostSetup {
  obstacles: { inner: Bounds4; near: Bounds4 }[];
  mids: { inner: Bounds4; near: Bounds4; wall: boolean }[]; // 途中の線分だけが避ける: 自分のボックス + 親の壁 (壁は軽い罰)
  endInsets: Bounds4[]; // 出入りの線分が「反対側から貫く」判定
}
function costSetup(obstacles: Rect[], ends: Rect[], walls: Rect[]): CostSetup {
  const pre = (r: Rect) => ({ inner: innerOf(r), near: nearOf(r), wall: !!r.wall });
  return { obstacles: obstacles.map(pre), mids: [...ends, ...walls].map(pre), endInsets: ends.map(insetOf) };
}

/**
 * 経路の評価 (小さいほど良い)
 * Input : path, st = costSetup で前計算した矩形 (obstacles = 避けるボックス, mids = 出す側・受ける側のボックスと親の縁 (最初と最後の線分以外では避ける))
 * Output: 長さ + 貫く回数 * CROSS_PENALTY + 近づく回数 * NEAR_PENALTY + 曲がり * BEND_PENALTY
 */
function cost(path: Point[], st: CostSetup): number {
  let len = 0;
  let crosses = 0;
  let wallCrosses = 0;
  let nears = 0;
  const last = path.length - 1;
  for (let i = 1; i <= last; i++) {
    const a = path[i - 1];
    const b = path[i];
    len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (const o of st.obstacles) {
      if (hits(a.x, a.y, b.x, b.y, o.inner)) crosses++;
      else if (hits(a.x, a.y, b.x, b.y, o.near)) nears++; // 貫かなくても、縁をかすめるのは避ける
    }
    // 途中の線分が自分のボックス (出す側・受ける側) や親の縁の近くを通るのも避ける (出入りの線分はボックスに接するので除く)
    if (i > 1 && i < last) {
      for (const o of st.mids) {
        if (hits(a.x, a.y, b.x, b.y, o.inner)) { if (o.wall) wallCrosses++; else crosses++; }
        else if (hits(a.x, a.y, b.x, b.y, o.near)) nears++;
      }
    } else {
      // 出入りの線分も、自分のボックスを「反対側から貫いて」ポートに届くのは禁止 (横の通路がポートと同じ高さになると、
      // 縦の線分が消えて、出入りの線分がボックスの上を横切る形になる)。ポートは縁の上にあるので、縁から少し内側を貫くときだけ数える
      for (const o of st.endInsets) if (hits(a.x, a.y, b.x, b.y, o)) crosses++;
    }
  }
  return len + crosses * CROSS_PENALTY + wallCrosses * WALL_PENALTY + nears * NEAR_PENALTY + (path.length - 2) * BEND_PENALTY;
}

/** 連続する同じ点・直線上の点を取り除く */
function simplify(path: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of path) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1);
    else i++;
  }
  return out;
}

/**
 * 区間 [lo, hi] の中で、障害物 (余白込み) が占めていない隙間の中心と両端を候補にする
 * 両端 = ボックスから MARGIN ちょうどの位置。中心だけだと広い隙間で無駄に遠回りするため
 */
function freeCenters(lo: number, hi: number, intervals: [number, number][]): number[] {
  if (hi < lo) return [];
  const sorted = intervals.filter(([a, b]) => b >= lo && a <= hi).sort((p, q) => p[0] - q[0]);
  const out: number[] = [];
  let cur = lo;
  for (const [a, b] of sorted) {
    if (a > cur) out.push((cur + a) / 2, cur, a);
    cur = Math.max(cur, b);
  }
  if (cur < hi) out.push((cur + hi) / 2, cur, hi);
  if (out.length === 0) out.push((lo + hi) / 2);
  return out;
}

/**
 * 経路を求める
 * Input : s = 出す側のハンドル位置, t = 受ける側のハンドル位置, obstacles = 避けるボックス, lane = 同じボックスに集まる線をずらす量 (px)
 * Output: 折れ線の頂点 (s から t まで)
 */
/**
 * 出入りの直線をどこまで伸ばせるか: 同じ高さの真横 (dir = 1 右 / -1 左) にあるボックスの手前 (4px) まで。ボックスが無ければ max
 * Input : from = ハンドル位置, dir, rects = 避けるボックス, max = 直線の長さの上限
 * Output: 直線の長さ (4 以上)
 */
export function freeStub(from: Point, dir: 1 | -1, rects: Rect[], max = STUB): number {
  let d = max;
  for (const o of rects) {
    if (from.y < o.y - 1 || from.y > o.y + o.height + 1) continue; // 高さがかぶらないボックスは関係ない
    if (dir > 0 && o.x >= from.x) d = Math.min(d, o.x - from.x - 4);
    if (dir < 0 && o.x + o.width <= from.x) d = Math.min(d, from.x - (o.x + o.width) - 4);
  }
  return Math.max(4, d);
}

/** 基本の評価 (ボックス・壁・親の外) で並べた候補。交差の評価 (routeAll の 2 回通し) で使い回す */
export interface RankedRoute {
  path: Point[];
  base: number;
}

/**
 * 経路の候補を作り、基本の評価 (ほかの線との交差を除く) が安い順に並べる
 * Input : routeEdge と同じ (others を除く)
 * Output: 候補 (同じ折れ線は 1 つにまとめる)。routeAll は 1 本につき 1 回だけこれを呼び、交差の評価は chooseRoute で何度でも行う
 */
export function rankRoutes(s: Point, t: Point, obstacles: Rect[], lane = 0, ends: Rect[] = [], bounds: Rect | null = null): RankedRoute[] {
  // 出入りの直線: 近いときは短くする (受ける側が右にあるのに「戻る線」扱いにならないように)
  const dx = t.x - s.x;
  const stub = dx > 0 ? Math.max(4, Math.min(STUB, dx / 2 - 2)) : STUB;
  // 出た直後 (入る直前) の真横にボックスがあるときは、直線をその手前までに縮める (詰めた配置で、出た直後の直線が隣のボックスを貫かないように)
  const stubS = Math.min(stub, freeStub(s, 1, obstacles));
  const stubT = Math.min(stub, freeStub(t, -1, obstacles));
  let x1 = s.x + stubS + lane;
  let x2 = t.x - stubT - lane;
  // 親の縁ぎりぎりのボックスから出る (入る) 線は、出入りの直線を親の内側に収める (外にはみ出すと壁の罰が付き、ボックスを貫く候補と競ってしまう)
  if (bounds) {
    x1 = Math.min(x1, Math.max(s.x + 4, bounds.x + bounds.width - WALL_MARGIN));
    x2 = Math.max(x2, Math.min(t.x - 4, bounds.x + WALL_MARGIN));
  }
  if (dx > 0 && x1 > x2) {
    x1 = (s.x + t.x) / 2;
    x2 = x1;
  }
  const candidates: Point[][] = [];

  // 縦の通路の候補 (障害物の x 区間の隙間)。通常の余白と、詰めた余白 (予備) の 2 通り
  const xIntervals: [number, number][] = obstacles.map((o) => [o.x - MARGIN, o.x + o.width + MARGIN]);
  const xIntervalsTight: [number, number][] = obstacles.map((o) => [o.x - SQUEEZE_MARGIN, o.x + o.width + SQUEEZE_MARGIN]);
  /** 区間の隙間の候補 (通常の余白 → 詰めた余白の順。詰めた方は近づく罰が付くので、通常の通路が無いときだけ選ばれる) */
  const freeXs = (lo: number, hi: number): number[] => [...freeCenters(lo, hi, xIntervals), ...freeCenters(lo, hi, xIntervalsTight)];
  // 横の通路の候補 (障害物の y 区間の隙間。x の範囲を限定して集める)
  const yIntervalsIn = (xa: number, xb: number, m: number): [number, number][] =>
    obstacles.filter((o) => o.x + o.width + m >= Math.min(xa, xb) && o.x - m <= Math.max(xa, xb)).map((o) => [o.y - m, o.y + o.height + m]);

  if (x1 <= x2) {
    // Z 型: 縦の通路 xm を隙間から選ぶ (真ん中も必ず候補に)。線ごとのずらし (lane) を通路に足して重なりを避ける
    for (const base of [x1, x2, (x1 + x2) / 2, ...freeXs(x1, x2)]) {
      const xm = Math.max(x1, Math.min(x2, base + lane));
      candidates.push([s, { x: xm, y: s.y }, { x: xm, y: t.y }, t]);
    }
  }
  // U 型 / S 型: 出た直後と入る直前の縦の通路と、横の通路 yl を組み合わせる
  const xa = x1;
  const xb = x2;
  // 横の通路は、自分のボックス (出す側・受ける側) の上も避ける (通路の x 範囲にかかるときだけ。出入りの直線で離れていれば関係ない)
  const xlo = Math.min(xa, xb);
  const xhi = Math.max(xa, xb);
  const ysWith = (m: number): [number, number][] => [
    ...yIntervalsIn(xlo, xhi, m)
  , ...ends.filter((o) => o.x + o.width + m >= xlo && o.x - m <= xhi).map((o): [number, number] => [o.y - m, o.y + o.height + m])
  ];
  const ys = ysWith(MARGIN);
  const ysTight = ysWith(SQUEEZE_MARGIN);
  const allY = [...obstacles, ...ends].flatMap((o) => [o.y - MARGIN, o.y + o.height + MARGIN]);
  let lo = Math.min(s.y, t.y, ...allY) - 40;
  let hi = Math.max(s.y, t.y, ...allY) + 40;
  // 親のボックスの中の線は、ボックスの内側に収める (横の通路の候補をボックスの内側に限る)
  if (bounds) {
    lo = Math.max(lo, bounds.y + HEADER_ZONE + WALL_MARGIN); // 題名の行の下から
    hi = Math.min(hi, bounds.y + bounds.height - WALL_MARGIN);
    if (hi < lo) hi = lo;
  }
  // 横の通路: 通常の余白の隙間 → 詰めた余白の隙間 (予備) → 上下の端
  const lanes = [...new Set([...freeCenters(lo, hi, ys), ...freeCenters(lo, hi, ysTight), lo, hi])];
  // 縦の通路も複数候補にする (出た直後 / 入る直前に幅の広いボックスがかかると、固定の通路では回り道も横切ってしまう)
  const xs = x1 <= x2 ? [...new Set([x1, x2, ...freeXs(x1, x2)])].filter((x) => x >= x1 && x <= x2) : [xa];
  for (const yl of lanes) {
    for (const xv of xs) {
      candidates.push([s, { x: xv, y: s.y }, { x: xv, y: yl }, { x: xb, y: yl }, { x: xb, y: t.y }, t]); // 出た直後の縦の通路を変える
      candidates.push([s, { x: xa, y: s.y }, { x: xa, y: yl }, { x: xv, y: yl }, { x: xv, y: t.y }, t]); // 入る直前の縦の通路を変える
    }
  }
  // 受ける側が左にある (戻る線) ときは、出た直後に縦へ下り (上り)、横の通路を戻り、受ける直前に縦へ。
  // 下りる縦の通路は「出た直後 (x1)」だけでなく、その右側の隙間も候補にする (真下にボックスがあると x1 では貫いてしまう)。
  // 上がる縦の通路も同じく「入る直前 (x2)」とその左側の隙間を候補にする
  if (x1 > x2) {
    const all = [...obstacles, ...ends];
    const xRight = Math.max(x1, ...all.map((o) => o.x + o.width + MARGIN)) + 40;
    const xLeft = Math.min(x2, ...all.map((o) => o.x - MARGIN)) - 40;
    const nearest = (xs: number[], ref: number, n: number): number[] => [...new Set(xs)].sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref)).slice(0, n);
    const dropXs = nearest([x1, ...freeXs(x1, xRight).filter((x) => x >= x1)], x1, 10);
    const riseXs = nearest([x2, ...freeXs(xLeft, x2).filter((x) => x <= x2)], x2, 10);
    for (const yl of lanes) {
      for (const xd of dropXs) {
        for (const xr of riseXs) {
          candidates.push([s, { x: xd, y: s.y }, { x: xd, y: yl }, { x: xr, y: yl }, { x: xr, y: t.y }, t]);
        }
      }
    }
  }

  const walls = bounds ? wallsOf(bounds) : [];
  const st = costSetup(obstacles, ends, walls);
  // 評価は 2 段階: まずボックス・壁・親の外に出る罰 (基本の評価) を全候補で求め、安い順に並べる。
  // ほかの線との交差 (候補 x 線 x 線分の総当たりで一番重い) は、基本の評価がそれまでの最良の合計を下回る候補にだけ足す。
  // 交差の罰は 0 以上なので、基本の評価が最良の合計以上の候補はもう勝てない (打ち切っても結果は同じ)。
  // 同じ折れ線になる候補は 1 回だけ評価する
  const inside = bounds ? (pt: Point) => pt.x >= bounds.x - 1 && pt.x <= bounds.x + bounds.width + 1 && pt.y >= bounds.y - 1 && pt.y <= bounds.y + bounds.height + 1 : null;
  const seen = new Set<string>();
  const ranked: { path: Point[]; base: number; order: number }[] = [];
  for (const c of candidates) {
    const path = simplify(c);
    const key = path.map((q) => `${q.x},${q.y}`).join(";");
    if (seen.has(key)) continue;
    seen.add(key);
    let k = cost(path, st);
    // 親のボックスの外に出る線分には罰 (中の線が外へ出て戻らないように)
    if (inside) {
      for (let i = 1; i < path.length; i++) if (!inside(path[i - 1]) || !inside(path[i])) k += WALL_PENALTY;
    }
    ranked.push({ path, base: k, order: ranked.length });
  }
  ranked.sort((a, b) => a.base - b.base || a.order - b.order);
  // 最後の手段: 決まった形の候補が全部どこかのボックスを貫くときは、格子の上の最短路で「貫かない経路」を探して先頭に置く
  // (通れる隙間があれば必ず見つかる。見つかった経路はボックスを貫かないので、基本の評価は CROSS_PENALTY 未満になる)
  if (ranked.length === 0 || ranked[0].base >= CROSS_PENALTY) {
    const g = gridRouteRelaxed(s, t, obstacles, ends, bounds, stubS, stubT);
    if (g) {
      let k = cost(g, st);
      if (inside) for (let i = 1; i < g.length; i++) if (!inside(g[i - 1]) || !inside(g[i])) k += WALL_PENALTY;
      ranked.unshift({ path: g, base: k, order: -1 });
      ranked.sort((a, b) => a.base - b.base || a.order - b.order);
    }
  }
  return ranked.map((r) => ({ path: r.path, base: r.base }));
}

/**
 * 並べた候補から、ほかの線との交差も含めて一番安いものを選ぶ
 * Input : ranked = rankRoutes の結果, others = 同じ階層のほかの線の経路
 * Output: 折れ線
 */
export function chooseRoute(ranked: RankedRoute[], others: Point[][]): Point[] {
  let best = ranked[0]?.path ?? [];
  let bestCost = Infinity;
  for (const r of ranked) {
    if (r.base >= bestCost) break; // これ以降は交差の罰を足しても最良を超えない
    // ほかの線との交差 (同じ階層で先に決まった線)。ボックスを貫く・近づくより軽いが、遠回りより重い
    const k = others.length > 0 ? r.base + wireCrossings(r.path, others) * WIRE_CROSS_PENALTY : r.base;
    if (k < bestCost) {
      bestCost = k;
      best = r.path;
    }
  }
  return best;
}

/**
 * 経路を求める
 * Input : s = 出す側のハンドル位置, t = 受ける側のハンドル位置, obstacles = 避けるボックス, lane = 同じボックスに集まる線をずらす量 (px),
 *         ends = 出す側・受ける側のボックス, bounds = 親のボックス, others = 同じ階層のほかの線の経路 (交差を減らす)
 * Output: 折れ線の頂点 (s から t まで)
 */
export function routeEdge(s: Point, t: Point, obstacles: Rect[], lane = 0, ends: Rect[] = [], bounds: Rect | null = null, others: Point[][] = []): Point[] {
  return chooseRoute(rankRoutes(s, t, obstacles, lane, ends, bounds), others);
}

/**
 * 折れ線を角丸の SVG パスにする
 * Input : path = 頂点列, radius = 角の丸み,
 *         junctions = 丸めない角 (同じ出力の分岐点。丸めると幹と枝の間にすき間ができる)
 * Output: d 属性の文字列
 */
export function toRoundedPath(path: Point[], radius = 10, junctions: Point[] = []): string {
  if (path.length === 0) return "";
  if (path.length === 1) return `M ${path[0].x} ${path[0].y}`;
  let d = `M ${path[0].x} ${path[0].y}`;
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    const next = path[i + 1];
    const r = Math.min(junctions.some((p) => Math.abs(p.x - cur.x) < .01 && Math.abs(p.y - cur.y) < .01) ? 0 : radius, Math.abs(cur.x - prev.x) / 2 + Math.abs(cur.y - prev.y) / 2, Math.abs(next.x - cur.x) / 2 + Math.abs(next.y - cur.y) / 2);
    if (r === 0) { d += ` L ${cur.x} ${cur.y}`; continue; }
    // 曲がる手前まで直線、角は 2 次ベジェで丸める
    const inX = cur.x - Math.sign(cur.x - prev.x) * r;
    const inY = cur.y - Math.sign(cur.y - prev.y) * r;
    const outX = cur.x + Math.sign(next.x - cur.x) * r;
    const outY = cur.y + Math.sign(next.y - cur.y) * r;
    d += ` L ${inX} ${inY} Q ${cur.x} ${cur.y} ${outX} ${outY}`;
  }
  const last = path[path.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
