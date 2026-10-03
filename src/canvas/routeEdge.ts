/**
 * 線の経路探索 (純粋関数): 箱を避ける直角の線
 *
 * 出す側 (右向きに出る) から受ける側 (左から入る) まで、
 *   Z 型: 右へ → 縦の通路 → 右へ
 *   U 型: 右へ → 縦の通路 → 横の通路 (箱の上下の空き) → 縦の通路 → 右へ
 * の候補を作り、「箱との交差 (重い) + 長さ + 曲がりの数」が最小の経路を選ぶ。
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 親の箱の縁を表す壁 (箱より近づいてよい)。向きを持つ: 左右の壁は x を、上下の壁は y を制約する */
  wall?: "left" | "right" | "top" | "bottom";
}

export type Point = { x: number; y: number };

/** 箱の縁から線を離す余白 */
const MARGIN = 36;
/** 親の箱の縁 (壁) から線を離す余白 (箱より小さくてよい。箱の中の通路を広く使うため) */
export const WALL_MARGIN = 12;
/** 矩形ごとの余白 (壁は小さく) */
export const marginOf = (r: Rect): number => (r.wall ? WALL_MARGIN : MARGIN);
/**
 * 通路がどこにも無いときの予備の余白 (箱と箱の隙間が MARGIN * 2 に満たないとき)。
 * 段違いの箱 (高さの違う箱が別の列にある) の間は 36px * 2 の通路が取れないことがあり、
 * 通常の余白の候補だけでは「箱を貫く候補」しか残らない。詰めた通路は NEAR_PENALTY が付くので、
 * 通常の通路があるときは選ばれず、無いときだけ貫通の代わりに選ばれる
 */
export const SQUEEZE_MARGIN = 12;
/** 出入りの最初の直線の長さ */
const STUB = 40;
/** 交差 1 回の罰 (長さに換算)。大きな図でも、どんなに遠回りしても箱を横切らない方を選ぶ大きさ */
const CROSS_PENALTY = 100000;
/** 曲がり 1 回の罰 */
const BEND_PENALTY = 40;
/** 箱 (や親の縁) に MARGIN より近づく 1 回の罰 (貫くよりは軽いが、回り道より重い) */
const NEAR_PENALTY = 1500;
/** 出入りの線分が自分の箱を貫いているとみなす内側の幅 (ポートの丸は縁の上にあり、数 px は箱にかかる) */
const END_INSET = 8;
/** ほかの線と交差する 1 回の罰 (箱に近づくより軽く、曲がり・少しの遠回りより重い。交差は読みにくさの元) */
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
function wireCrossings(path: Point[], others: Point[][]): number {
  let n = 0;
  for (let i = 1; i < path.length; i++) {
    for (const o of others) {
      for (let j = 1; j < o.length; j++) if (segmentsCross(path[i - 1], path[i], o[j - 1], o[j])) n++;
    }
  }
  return n;
}

/** 線分が矩形から余白 (箱は MARGIN、壁は WALL_MARGIN) 以内を通るか */
function segmentNear(a: Point, b: Point, r: Rect): boolean {
  const m = marginOf(r);
  return segmentHits(a, b, { x: r.x - m + 1, y: r.y - m + 1, width: r.width + 2 * m - 2, height: r.height + 2 * m - 2 });
}

/** 親の箱の題名の行の高さ (子はこの下に置かれる。線もこの下を通る) */
export const HEADER_ZONE = 76;

/** 親の箱の縁を、縁の外側に置いた厚い壁 (矩形) として表す。上の壁は題名の行の分だけ内側まで広げる (題名の裏を線が通らないように) */
export function wallsOf(bounds: Rect): Rect[] {
  const T = 1000;
  return [
    { x: bounds.x - T, y: bounds.y - T, width: T, height: bounds.height + 2 * T, wall: "left" }
  , { x: bounds.x + bounds.width, y: bounds.y - T, width: T, height: bounds.height + 2 * T, wall: "right" }
  , { x: bounds.x - T, y: bounds.y - T, width: bounds.width + 2 * T, height: T + HEADER_ZONE, wall: "top" } // 題名の行まで
  , { x: bounds.x - T, y: bounds.y + bounds.height, width: bounds.width + 2 * T, height: T, wall: "bottom" }
  ];
}

/** 線分 (水平または垂直) が矩形の内側を通るか */
function segmentHits(a: Point, b: Point, r: Rect): boolean {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  // 矩形を少し縮めて、縁をかすめるだけなら交差とみなさない
  const rx0 = r.x + 1;
  const ry0 = r.y + 1;
  const rx1 = r.x + r.width - 1;
  const ry1 = r.y + r.height - 1;
  return x1 >= rx0 && x0 <= rx1 && y1 >= ry0 && y0 <= ry1;
}

/**
 * 経路の評価 (小さいほど良い)
 * Input : path, obstacles = 避ける箱, ends = 出す側・受ける側の箱 (最初と最後の線分以外では避ける), walls = 親の箱の縁 (最初と最後の線分以外では近づかない)
 * Output: 長さ + 貫く回数 * CROSS_PENALTY + 近づく回数 * NEAR_PENALTY + 曲がり * BEND_PENALTY
 */
function cost(path: Point[], obstacles: Rect[], ends: Rect[] = [], walls: Rect[] = []): number {
  let len = 0;
  let crosses = 0;
  let nears = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    len += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    for (const o of obstacles) {
      if (segmentHits(a, b, o)) crosses++;
      else if (segmentNear(a, b, o)) nears++; // 貫かなくても、縁をかすめるのは避ける
    }
    // 途中の線分が自分の箱 (出す側・受ける側) や親の縁の近くを通るのも避ける (出入りの線分は箱に接するので除く)
    if (i > 1 && i < path.length - 1) {
      for (const o of [...ends, ...walls]) {
        if (segmentHits(a, b, o)) crosses++;
        else if (segmentNear(a, b, o)) nears++;
      }
    } else {
      // 出入りの線分も、自分の箱を「反対側から貫いて」ポートに届くのは禁止 (横の通路がポートと同じ高さになると、
      // 縦の線分が消えて、出入りの線分が箱の上を横切る形になる)。ポートは縁の上にあるので、縁から少し内側を貫くときだけ数える
      for (const o of ends) {
        if (segmentHits(a, b, { x: o.x + END_INSET, y: o.y + END_INSET, width: o.width - 2 * END_INSET, height: o.height - 2 * END_INSET })) crosses++;
      }
    }
  }
  return len + crosses * CROSS_PENALTY + nears * NEAR_PENALTY + (path.length - 2) * BEND_PENALTY;
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
 * 両端 = 箱から MARGIN ちょうどの位置。中心だけだと広い隙間で無駄に遠回りするため
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
 * Input : s = 出す側のハンドル位置, t = 受ける側のハンドル位置, obstacles = 避ける箱, lane = 同じ箱に集まる線をずらす量 (px)
 * Output: 折れ線の頂点 (s から t まで)
 */
export function routeEdge(s: Point, t: Point, obstacles: Rect[], lane = 0, ends: Rect[] = [], bounds: Rect | null = null, others: Point[][] = []): Point[] {
  // 出入りの直線: 近いときは短くする (受ける側が右にあるのに「戻る線」扱いにならないように)
  const dx = t.x - s.x;
  const stub = dx > 0 ? Math.max(4, Math.min(STUB, dx / 2 - 2)) : STUB;
  let x1 = s.x + stub + lane;
  let x2 = t.x - stub - lane;
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
  // 横の通路は、自分の箱 (出す側・受ける側) の上も避ける (通路の x 範囲にかかるときだけ。出入りの直線で離れていれば関係ない)
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
  // 親の箱の中の線は、箱の内側に収める (横の通路の候補を箱の内側に限る)
  if (bounds) {
    lo = Math.max(lo, bounds.y + HEADER_ZONE + WALL_MARGIN); // 題名の行の下から
    hi = Math.min(hi, bounds.y + bounds.height - WALL_MARGIN);
    if (hi < lo) hi = lo;
  }
  // 横の通路: 通常の余白の隙間 → 詰めた余白の隙間 (予備) → 上下の端
  const lanes = [...new Set([...freeCenters(lo, hi, ys), ...freeCenters(lo, hi, ysTight), lo, hi])];
  // 縦の通路も複数候補にする (出た直後 / 入る直前に幅の広い箱がかかると、固定の通路では回り道も横切ってしまう)
  const xs = x1 <= x2 ? [...new Set([x1, x2, ...freeXs(x1, x2)])].filter((x) => x >= x1 && x <= x2) : [xa];
  for (const yl of lanes) {
    for (const xv of xs) {
      candidates.push([s, { x: xv, y: s.y }, { x: xv, y: yl }, { x: xb, y: yl }, { x: xb, y: t.y }, t]); // 出た直後の縦の通路を変える
      candidates.push([s, { x: xa, y: s.y }, { x: xa, y: yl }, { x: xv, y: yl }, { x: xv, y: t.y }, t]); // 入る直前の縦の通路を変える
    }
  }
  // 受ける側が左にある (戻る線) ときは、出た直後に縦へ下り (上り)、横の通路を戻り、受ける直前に縦へ。
  // 下りる縦の通路は「出た直後 (x1)」だけでなく、その右側の隙間も候補にする (真下に箱があると x1 では貫いてしまう)。
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
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const path = simplify(c);
    let k = cost(path, obstacles, ends, walls);
    // ほかの線との交差 (同じ階層で先に決まった線)。箱を貫く・近づくより軽いが、遠回りより重い
    if (others.length > 0) k += wireCrossings(path, others) * WIRE_CROSS_PENALTY;
    // 親の箱の外に出る線分には罰 (中の線が外へ出て戻らないように)
    if (bounds) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1];
        const q = path[i];
        const inside = (pt: Point) => pt.x >= bounds.x - 1 && pt.x <= bounds.x + bounds.width + 1 && pt.y >= bounds.y - 1 && pt.y <= bounds.y + bounds.height + 1;
        if (!inside(a) || !inside(q)) k += CROSS_PENALTY;
      }
    }
    if (k < bestCost) {
      bestCost = k;
      best = path;
    }
  }
  return simplify(best);
}

/**
 * 折れ線を角丸の SVG パスにする
 * Input : path = 頂点列, radius = 角の丸み
 * Output: d 属性の文字列
 */
export function toRoundedPath(path: Point[], radius = 10): string {
  if (path.length === 0) return "";
  if (path.length === 1) return `M ${path[0].x} ${path[0].y}`;
  let d = `M ${path[0].x} ${path[0].y}`;
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    const next = path[i + 1];
    const r = Math.min(radius, Math.abs(cur.x - prev.x) / 2 + Math.abs(cur.y - prev.y) / 2, Math.abs(next.x - cur.x) / 2 + Math.abs(next.y - cur.y) / 2);
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
