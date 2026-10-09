/**
 * 自動整列: 同じ階層のブロックを依存関係 (出力 -> 入力の線) で層に分け、重ならないように並べる
 * CLI が作った図 (位置の情報が無い) や、ごちゃついた図を一発で読める形にする。
 */
import { ROOT_ID, type Project } from "./types";
import { CHILD_PADDING, childTop, childrenOf, outgoingEdges, portsOf } from "./graph";
import { blockSize, TERMINAL_W, terminalHeight } from "./size";

/** 層と層の間 (横) */
const GAP_X = 144; // ボックスの横の間隔: 線の通路 (縁から 36px x 2 + 束の広がり) が収まる最小に近い値 (8px 単位)
/** ブロックとブロックの間 (縦) */
const GAP_Y = 96; // 縦に積んだボックスの間 (線が縁から 36px 離れて 2 本通る)
/** 1 行の幅の上限。直列の長い鎖はこれを超えたら次の行に折り返す (横 1 列の細長い帯になるのを防ぐ) */
const MAX_ROW_W = 3000;

/** 閲覧配置で使う通路幅・箱の間隔・親内余白・工程見出しの予約高さ */
const READING_GAP_X = 96;
const READING_GAP_Y = 64;
const READING_INSET_X = 88;
const READING_HEADER_SPACE = 56;
const READING_CHANNEL_REDUCTION = 48;
const COLUMN_LABEL_SPACE = 40;

export interface LayoutColumn {
  x: number;
  y: number;
  width: number;
  ids: string[];
  index: number;
}

/**
 * 1 つの階層を整列する (子の階層は先に整列して大きさを確定させる)
 * Input : scopeId = 階層のブロック id (ROOT_ID なら最上位),
 *         options.recursive = false なら子の階層の中は並べ直さない (画面の「この階層を整列」用。既定は下の階層も整列する)
 *         options.presentation = 閲覧用の直列配置 (横へ折り返さず依存順を維持)
 *         options.columns = 各工程の位置を受け取る配列 (指定時だけ追記)
 * Output: 位置を更新した Project (元は変更しない)
 */
export function layoutScope(p: Project, scopeId: string, options: {
  recursive?: boolean;
  presentation?: boolean;
  columns?: LayoutColumn[];
} = {}): Project {
  let q = structuredClone(p);
  const kids = childrenOf(q, scopeId);
  if (kids.length === 0) return q;
  // 下の階層から先に
  for (const k of kids) if (options.recursive !== false && childrenOf(q, k.id).length > 0) q = layoutScope(q, k.id);

  // 層: 同じ階層の線 (sibling) をたどった最長経路
  const ids = kids.map((k) => k.id);
  const succ = new Map<string, string[]>();
  for (const id of ids) {
    const next = new Set<string>();
    for (const port of portsOf(q, id, "out")) {
      for (const e of outgoingEdges(q, { portId: port.id, side: "outer" })) {
        if (e.kind !== "sibling") continue;
        const to = q.ports[e.to.portId]?.blockId;
        if (to && ids.includes(to)) next.add(to);
      }
    }
    succ.set(id, [...next]);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0; // 循環は結線時に弾いているが念のため
    visiting.add(id);
    let d = 0;
    for (const prev of ids) if (succ.get(prev)!.includes(id)) d = Math.max(d, depth(prev) + 1);
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);

  // 層の中の並び: 前の層のつながり先の平均位置 (重心) で並べ、線の交差を減らす。2 回なでる
  const maxLayer = Math.max(...ids.map((id) => layer.get(id)!));
  const order = new Map<string, number>();
  const initial = [...kids].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  initial.forEach((k, i) => order.set(k.id, i));
  const pred = new Map<string, string[]>();
  for (const id of ids) pred.set(id, ids.filter((prev) => succ.get(prev)!.includes(id)));
  for (let pass = 0; pass < 2; pass++) {
    for (let L = 1; L <= maxLayer; L++) {
      const members = ids.filter((id) => layer.get(id) === L);
      const bary = new Map<string, number>();
      for (const id of members) {
        const ps = pred.get(id)!;
        bary.set(id, ps.length === 0 ? order.get(id)! : ps.reduce((acc, q) => acc + order.get(q)!, 0) / ps.length);
      }
      members.sort((a, b) => bary.get(a)! - bary.get(b)! || order.get(a)! - order.get(b)!);
      members.forEach((id, i) => order.set(id, i));
    }
    // 逆向き (後ろの層の重心で前の層を並べ直す)
    for (let L = maxLayer - 1; L >= 0; L--) {
      const members = ids.filter((id) => layer.get(id) === L);
      const bary = new Map<string, number>();
      for (const id of members) {
        const ss = succ.get(id)!;
        bary.set(id, ss.length === 0 ? order.get(id)! : ss.reduce((acc, q) => acc + order.get(q)!, 0) / ss.length);
      }
      members.sort((a, b) => bary.get(a)! - bary.get(b)! || order.get(a)! - order.get(b)!);
      members.forEach((id, i) => order.set(id, i));
    }
  }
  // 層と層の隙間を通る線の本数 (隙間 g = 層 g と層 g+1 の間)。本数が多いほど隙間を広げ、線が 16px 間隔で並べるようにする
  const crossing = new Array<number>(Math.max(1, maxLayer)).fill(0);
  for (const id of ids) {
    for (const nxt of succ.get(id)!) {
      const a = layer.get(id)!;
      const b = layer.get(nxt)!;
      for (let g = Math.min(a, b); g < Math.max(a, b); g++) crossing[g]++;
    }
  }
  // 通路の幅: 縁から 36px x 2 + 線の間隔 16px x (本数 - 1) + 余裕 16px。最低は GAP_X
  const gapAfter = (L: number): number => Math.max(GAP_X, 72 + 16 * Math.max(0, (crossing[L] ?? 0) - 1) + 16);
  const compact = !!options.presentation;
  const horizontalGap = compact ? READING_GAP_X : GAP_X;
  const verticalGap = compact ? READING_GAP_Y : GAP_Y;
  const startX = scopeId === ROOT_ID ? TERMINAL_W + horizontalGap : compact ? READING_INSET_X : CHILD_PADDING.left;
  const startY = scopeId === ROOT_ID ? 40 : childTop(q, scopeId) + (compact ? READING_HEADER_SPACE : 0);
  let x = startX;
  let rowTop = startY;
  let maxBottom = startY;
  const columns = Array.from({ length: maxLayer + 1 }, (_, L) => {
    const members = kids.filter(k => layer.get(k.id) === L).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    const sizes = members.map(m => blockSize(q, m.id));
    return { L, members, sizes, width: Math.max(0, ...sizes.map(s => s.width)), height: sizes.reduce((h, s) => h + s.height, 0) + verticalGap * Math.max(0, members.length - 1) };
  });
  // 閲覧時は接続の前後関係を必ず左→右に保つ。長い鎖でも左端へ折り返さない。
  const rowLimit = compact ? Infinity : MAX_ROW_W;
  for (let from = 0; from < columns.length;) {
    let to = from, rowWidth = 0;
    while (to < columns.length) {
      const col = columns[to];
      const gap = to === from ? 0 : (compact ? Math.max(horizontalGap, gapAfter(to - 1) - READING_CHANNEL_REDUCTION) : gapAfter(to - 1));
      if (to > from && rowWidth + gap + col.width > rowLimit)
        break;
      rowWidth += gap + col.width;
      to++;
    }
    const rowHeight = Math.max(...columns.slice(from, to).map(c => c.height));
    x = startX;
    for (let j = from; j < to; j++) {
      const col = columns[j];
      let y = rowTop + (compact ? Math.round((rowHeight - col.height) / 16) * 8 : 0);
      options.columns?.push({ x, y: rowTop - COLUMN_LABEL_SPACE, width: col.width, ids: col.members.map(m => m.id), index: col.L });
      col.members.forEach((m, i) => { q.blocks[m.id].position = { x, y }; y += col.sizes[i].height + verticalGap; });
      x += col.width + (compact ? Math.max(horizontalGap, gapAfter(col.L) - READING_CHANNEL_REDUCTION) : gapAfter(col.L));
    }
    maxBottom = Math.max(maxBottom, rowTop + rowHeight);
    rowTop = maxBottom + verticalGap * 2 + (compact ? COLUMN_LABEL_SPACE : 0);
    from = to;
  }
  // 最上位なら入力/出力ノードも両端に置く
  if (scopeId === ROOT_ID) {
    const midY = Math.max(startY, (startY + maxBottom) / 2 - terminalHeight(q, "in") / 2);
    q.terminals.in = { x: 0, y: midY };
    // 入力グループは既定の入力ノードの下に積む
    let gy = midY + terminalHeight(q, "in") + GAP_Y;
    for (const gp of q.inputGroups ?? []) {
      gp.position = { x: 0, y: gy };
      gy += 44 + Math.max(1, Object.values(q.ports).filter((x) => x.blockId === ROOT_ID && x.groupId === gp.id).length) * 26 + 12 + GAP_Y;
    }
    q.terminals.out = { x: x, y: Math.max(startY, (startY + maxBottom) / 2 - terminalHeight(q, "out") / 2) };
  }
  return q;
}

/** 全体を整列する */
export function layoutAll(p: Project): Project {
  return layoutScope(p, ROOT_ID);
}

/**
 * 新しいブロックを置く位置: その階層の一番下 (重ならない)
 * Input : parentId
 * Output: 位置
 */
export function nextFreePosition(p: Project, parentId: string): { x: number; y: number } {
  const kids = childrenOf(p, parentId);
  const startX = parentId === ROOT_ID ? TERMINAL_W + GAP_X : CHILD_PADDING.left;
  const startY = parentId === ROOT_ID ? 40 : childTop(p, parentId);
  if (kids.length === 0) return { x: startX, y: startY };
  let bottom = startY;
  let leftmost = Infinity;
  for (const k of kids) {
    const s = blockSize(p, k.id);
    bottom = Math.max(bottom, k.position.y + s.height);
    leftmost = Math.min(leftmost, k.position.x);
  }
  return { x: Math.max(startX, leftmost), y: bottom + GAP_Y };
}
