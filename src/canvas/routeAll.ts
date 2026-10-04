/**
 * 同じ階層の線をまとめて経路計算し、縦の通路が重なる線を横にずらす (純粋関数)
 * 1 本ずつ別々に計算すると同じ通路に重なるため、全部の経路が決まってから重なりを解く。
 * 最後に、同じ出力から分岐する線の出だしを 1 本の幹にそろえる (bundleFanout)。
 */
import { bundleFanout } from "./bundleFanout";
import { sourceKey } from "./sharedWires";
import { marginOf, wallsOf, rankRoutes, chooseRoute, SQUEEZE_MARGIN, type Point, type Rect, type RankedRoute } from "./routeEdge";

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
/** ボックスの縁から線を離す余白 (routeEdge と同じ) */


/**
 * すべての線の経路を求める
 * Input : nodes = 見えているノードの絶対位置, edges = 線 (端点の位置つき)
 * Output: 線 id -> 折れ線
 */
export function routeAll(nodes: NodeRect[], edges: EdgeSpec[], opts: { separate?: boolean } = {}): Map<string, Point[]> {
  // JSON の順序やランダム ID に依存せず、近い供給元・行き先から通路を決める。
  edges = [...edges].sort((a,b) => a.s.x-b.s.x || a.s.y-b.s.y || a.t.x-b.t.x || a.t.y-b.t.y || a.id.localeCompare(b.id));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const paths = new Map<string, Point[]>();
  const scopeOf = new Map<string, string>();
  const obstaclesOf = new Map<string, Rect[]>();
  // 線ごとの経路探索の材料 (2 回目の探索でも使う)
  const setup = new Map<string, { obstacles: Rect[]; ends: Rect[]; bounds: Rect | null }>();
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
    setup.set(e.id, { obstacles, ends, bounds });
    if (!obstaclesOf.has(scope)) {
      // ずらすときに避けるボックス: その階層の全部のボックス (端点のボックスも含む) と、親のボックスの内側の縁
      const all = nodes.filter((r) => r.parentId === scope && r.rect.width > 0).map((r) => r.rect);
      if (bounds) all.push(...wallsOf(bounds)); // 親の縁は、縁の外側に置いた壁として表す
      obstaclesOf.set(scope, all);
    }
  }
  // 同じ階層のほかの線 (自分を除く) の経路。交差の少ない候補を選ぶために渡す
  const othersOf = (e: EdgeSpec): Point[][] => {
    const scope = scopeOf.get(e.id);
    const out: Point[][] = [];
    for (const o of edges) {
      if (o.id === e.id || sourceKey(o) === sourceKey(e) || scopeOf.get(o.id) !== scope) continue;
      const p = paths.get(o.id);
      if (p) out.push(p);
    }
    return out;
  };
  // 候補の基本の評価 (ボックス・壁) は線ごとに 1 回だけ (2 回通しの両方で使い回す。候補 x ボックスの総当たりが一番重い)
  const ranked = new Map<string, RankedRoute[]>();
  for (const e of edges) {
    const st = setup.get(e.id)!;
    ranked.set(e.id, rankRoutes(e.s, e.t, st.obstacles, 0, st.ends, st.bounds));
  }
  // 1 回目: 先に決まった線との交差を避けながら順に決める。2 回目・3 回目: 全部の線が決まった状態で、それぞれを選び直す
  // (後から決まった線に横切られた線が、別の通路に逃げられる。3 回通すのは、2 回目の選び直しで動いた線に合わせ直すため)
  // 同じ出力から分岐する線どうしは幹を共有するので、交差・重なりの相手から外している (othersOf)
  for (let pass = 0; pass < 3; pass++) {
    for (const e of edges) {
      paths.set(e.id, chooseRoute(ranked.get(e.id)!, othersOf(e)));
    }
  }
  // 広げた結果、束に入っていなかった別の線の真上に乗ることがあるので、数回繰り返して収束させる
  // (間隔どおりに並んだ束は再び同じ位置に広がるだけなので、繰り返しても崩れない)
  if (opts.separate === false) return paths; // 検査用: 束を広げる前の経路
  // 同じ出力 (同じハンドル位置) から出る線は、出た直後の縦線分を 1 本の幹に重ねる
  const sourceKeyOf = new Map(edges.map((e) => [e.id, `${e.source}|${e.s.x},${e.s.y}`]));
  for (let pass = 0; pass < 4; pass++) {
    separateVerticals(paths, scopeOf, obstaclesOf, sourceKeyOf);
    separateHorizontals(paths, scopeOf, obstaclesOf);
  }
  bundleFanout(paths, edges, nodes, scopeOf);
  return paths;
}

/**
 * 横の線分 (y, x0..x1) を置ける y の範囲: 横の範囲がかぶるボックスから MARGIN 以上離れた、y を含む隙間
 * Input : y = 今の位置, x0, x1, obstacles
 * Output: [lo, hi]
 */
function freeRangeAtY(y: number, x0: number, x1: number, obstacles: Rect[]): [number, number] {
  // 通常の余白 (ボックスから MARGIN) で範囲を取り、取れなければ詰めた余白 (SQUEEZE_MARGIN) で取り直す
  // (経路探索が「詰めた通路」を選んだ線は、通常の余白では両側から挟まれて範囲が無い。
  //  その線を通常の余白の範囲へ押し出すとボックスの縁の上に乗ってしまうので、詰めた余白で動かせる範囲を求める)
  const rangeWith = (squeeze: boolean): [number, number] => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const o of obstacles) {
      if (o.wall === "left" || o.wall === "right") continue; // 左右の壁は横線分の y を制約しない (親の縁のハンドルから出る線はボックスの外から始まる)
      const m = squeeze && !o.wall ? SQUEEZE_MARGIN : marginOf(o);
      if (o.x + o.width + m < x0 || o.x - m > x1) continue; // 横にかぶらないボックスは関係ない
      const top = o.y - m;
      const bottom = o.y + o.height + m;
      if (bottom <= y) lo = Math.max(lo, bottom);
      else if (top >= y) hi = Math.min(hi, top);
      else if (y - top < bottom - y) hi = Math.min(hi, top);
      else lo = Math.max(lo, bottom);
    }
    return [lo, hi];
  };
  let [lo, hi] = rangeWith(false);
  if (hi < lo) [lo, hi] = rangeWith(true);
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
      // 交差を減らす並べ方 (縦線分と同じ考え方): 前後の縦線分が「両方とも上へ伸びる」線は束の上端、「両方とも下へ」は下端、
      // Z 型は真ん中。U 型どうしは横の範囲が短い方を内側に、Z 型どうしは「左から来る線を上に」(中心 x が左のものを上に)
      const order = ids
        .map((id) => {
          const mine = group.filter((g) => g.edgeId === id);
          const path = paths.get(id)!;
          let side = 0;
          let midX = 0;
          let span = 0;
          let leftUp = false; // Z 型のとき: 左端につながる縦線分が上へ伸びるか (左上から来て右下へ抜ける形)
          for (const g of mine) {
            const before = path[g.idx - 1];
            const after = path[g.idx + 2];
            if (before) side += before.y < g.y ? -1 : 1;
            if (after) side += after.y < g.y ? -1 : 1;
            midX += (g.x0 + g.x1) / 2;
            span += g.x1 - g.x0;
            const leftNeighbor = path[g.idx].x <= path[g.idx + 1].x ? before : after;
            if (leftNeighbor) leftUp = leftNeighbor.y < g.y;
          }
          const mid = midX / Math.max(1, mine.length);
          // Z 型どうしの並び: 「左上から来て右下へ抜ける」線は、左にあるものほど下に置く (右の線の入りの縦線分が、左の線の横線分を横切らない)。
          // 「左下から来て右上へ抜ける」線は逆で、左にあるものほど上に置く
          return { id, side, zOrder: leftUp ? -mid : mid, span };
        })
        .sort((p, q) => p.side - q.side || (p.side < 0 ? p.span - q.span : p.side > 0 ? q.span - p.span : p.zOrder - q.zOrder))
        .map((o) => o.id);
      let lo = -Infinity;
      let hi = Infinity;
      const ownRange = new Map<HSeg, [number, number]>(); // 線分ごとの空き範囲 (束の範囲とは別に、最後に線分ごとに抑える)
      for (const g of group) {
        const [l, h] = freeRangeAtY(g.y, g.x0, g.x1, obstacles);
        ownRange.set(g, [l, h]);
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
        // 範囲の外には出さない (束が範囲より広いときは端で重なる。ボックスの縁に乗るよりまし)
        const y = Math.max(lo, Math.min(hi, center + (k - (order.length - 1) / 2) * sep));
        const path = paths.get(id)!;
        for (const g of group) {
          if (g.edgeId !== id) continue;
          // 線分ごとの空き範囲でも抑える: 束の範囲は束全体の共通部分だが、別の線分の範囲に引きずられて
          // この線分だけがボックス (自分のボックスなど) の中へ入ることがある。自分の範囲が無い (両側から挟まれている) 線分は動かさない
          const [ol, oh] = ownRange.get(g)!;
          const yy = oh < ol ? g.y : Math.max(ol, Math.min(oh, y));
          path[g.idx] = { ...path[g.idx], y: yy };
          path[g.idx + 1] = { ...path[g.idx + 1], y: yy };
        }
      });
    }
  }
}

/**
 * 縦の線分 (x, y0..y1) を置ける x の範囲: 縦の範囲がかぶるボックスから MARGIN 以上離れた、x を含む隙間
 * Input : x = 今の位置, y0, y1, obstacles
 * Output: [lo, hi]
 */
function freeRangeAt(x: number, y0: number, y1: number, obstacles: Rect[]): [number, number] {
  // 通常の余白で範囲を取り、取れなければ詰めた余白で取り直す (freeRangeAtY と同じ考え方)
  const rangeWith = (squeeze: boolean): [number, number] => {
    let lo = -Infinity;
    let hi = Infinity;
    for (const o of obstacles) {
      if (o.wall === "top" || o.wall === "bottom") continue; // 上下の壁は縦線分の x を制約しない
      const m = squeeze && !o.wall ? SQUEEZE_MARGIN : marginOf(o); // 壁はボックスより近づいてよい
      if (o.y + o.height + m < y0 || o.y - m > y1) continue; // 縦にかぶらないボックスは関係ない
      const left = o.x - m;
      const right = o.x + o.width + m;
      if (right <= x) lo = Math.max(lo, right);
      else if (left >= x) hi = Math.min(hi, left);
      else if (x - left < right - x) hi = Math.min(hi, left); // 余白の中 (左寄り): 左へ押し出す
      else lo = Math.max(lo, right); // 余白の中 (右寄り。親の縁のすぐ内側など): 右へ押し出す
    }
    return [lo, hi];
  };
  let [lo, hi] = rangeWith(false);
  if (hi < lo) [lo, hi] = rangeWith(true);
  if (hi < lo) return [x, x]; // 両側から挟まれて置けない: 動かさない
  return [lo, hi];
}

interface VSeg {
  edgeId: string;
  idx: number; // path[idx] と path[idx+1] が縦の線分
  x: number;
  y0: number;
  y1: number;
  /** 束の中で「1 本」として数える単位。普通は線の id。同じ出力から出た直後の縦線分 (幹) は出力ごとに同じ値にして重ねる */
  bus: string;
}

/**
 * 同じ階層で、同じ通路 (x が近い) にあり、縦の範囲が重なる線分を見つけて横にずらす
 * 同じ線の中の縦線分はずらしても形が保たれる (隣の横線分の端点が一緒に動く)
 */
function separateVerticals(paths: Map<string, Point[]>, scopeOf: Map<string, string>, obstaclesOf: Map<string, Rect[]>, sourceKeyOf: Map<string, string>): void {
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
        // 同じ出力から出た直後の縦線分 (幹) は 1 本に重ねる: 同じ信号が 8 本に分かれて 6px 間隔で並ぶと潰れて読めない。
        // 幹を 1 本にし、それぞれの通路 (横線分) へ分岐する所で初めて分かれる (回路図のバスと同じ読み方)
        const bus = i === 1 ? `src:${sourceKeyOf.get(edgeId) ?? edgeId}` : edgeId;
        const list = byScope.get(scope) ?? [];
        list.push({ edgeId, idx: i, x: a.x, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), bus });
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
        if (segs[i].bus === segs[j].bus) continue; // 同じ線 (または同じ幹) の線分どうしは広げない
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
      // 同じ線 (または同じ幹) の線分が複数あれば 1 つにまとめて数える
      const ids = [...new Set(group.map((g) => g.bus))];
      if (ids.length < 2) {
        // 幹だけの束: 全部を同じ x にそろえる (経路探索で別の x になっていても重ねる)
        if (ids.length === 1 && ids[0].startsWith("src:")) {
          const x = group.reduce((acc, g) => acc + g.x, 0) / group.length;
          for (const g of group) { const path = paths.get(g.edgeId)!; path[g.idx] = { ...path[g.idx], x }; path[g.idx + 1] = { ...path[g.idx + 1], x }; }
        }
        continue;
      }
      const baseX = group.reduce((acc, g) => acc + g.x, 0) / group.length;
      // 交差を減らす並べ方: 縦線分の前後の横線分が「両方とも左へ伸びる」線 (左へ戻る U 型) は束の左端、
      // 「両方とも右へ伸びる」線 (右へ戻る U 型) は右端、片方ずつ (Z 型) は真ん中。
      // U 型どうしは入れ子になるので、縦の範囲が短い方を内側 (左へ戻る線は左、右へ戻る線は右) に。
      // Z 型どうしは「上から来る線を左に」(線分の中心 y が上のものを左に)
      const order = ids
        .map((id) => {
          const mine = group.filter((g) => g.bus === id);
          let side = 0;
          let midY = 0;
          let span = 0;
          let topLeft = false; // Z 型のとき: 上端につながる横線分が左へ伸びるか (左上から来て右下へ下りる形)
          for (const g of mine) {
            const path = paths.get(g.edgeId)!;
            const before = path[g.idx - 1];
            const after = path[g.idx + 2];
            if (before) side += before.x < g.x ? -1 : 1;
            if (after) side += after.x < g.x ? -1 : 1;
            midY += (g.y0 + g.y1) / 2;
            span += g.y1 - g.y0;
            const topNeighbor = path[g.idx].y <= path[g.idx + 1].y ? before : after;
            if (topNeighbor) topLeft = topNeighbor.x < g.x;
          }
          const mid = midY / Math.max(1, mine.length);
          // Z 型どうしの並び: 「左上から来て右下へ下りる」線は、上にあるものほど右に置く (下の線の横線分が、上の線の縦線分を横切らない)。
          // 「左下から来て右上へ上がる」線は逆で、上にあるものほど左に置く。以前は向きを見ずに「上の線を左」にしていて、下りる束が互いに交差していた
          return { id, side, zOrder: topLeft ? -mid : mid, span };
        })
        .sort((p, q) => p.side - q.side || (p.side < 0 ? p.span - q.span : p.side > 0 ? q.span - p.span : p.zOrder - q.zOrder))
        .map((o) => o.id);
      // 束全体が置ける範囲: 各線分の空き範囲の共通部分 (ボックスから MARGIN 以上離れる)
      let lo = -Infinity;
      let hi = Infinity;
      const ownRange = new Map<VSeg, [number, number]>(); // 線分ごとの空き範囲 (束の範囲とは別に、最後に線分ごとに抑える)
      for (const g of group) {
        const [l, h] = freeRangeAt(g.x, g.y0, g.y1, obstacles);
        ownRange.set(g, [l, h]);
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
        // 範囲の外には出さない (束が範囲より広いときは端で重なる。ボックスの縁に乗るよりまし)
        const x = Math.max(lo, Math.min(hi, center + (k - (order.length - 1) / 2) * sep));
        for (const g of group) {
          if (g.bus !== id) continue;
          const path = paths.get(g.edgeId)!;
          // 線分ごとの空き範囲でも抑える (横線分と同じ理由)
          const [ol, oh] = ownRange.get(g)!;
          const xx = oh < ol ? g.x : Math.max(ol, Math.min(oh, x));
          path[g.idx] = { ...path[g.idx], x: xx };
          path[g.idx + 1] = { ...path[g.idx + 1], x: xx };
        }
      });
    }
  }
}
