/** 縦の閲覧用配置。保存座標やモデルの寸法には触れない。 */
import type { Project } from "../model/types";
import { ROOT_ID } from "../model/types";
import { portsOf, rootInputsOf } from "../model/graph";
import { isExpanded, MERGE_W, taskCardLayout, taskCardPorts, textWidth } from "../model/size";
import type { AnyRFNode } from "./layout";
import { readingColumns } from "../model/readingLayout";
import { routeAll, type NodeRect, type EdgeSpec } from "./routeAll";

export interface VerticalCard {
  inputH: number;
  outputH: number;
  inputStart: number;
  inputs: {
    id: string;
    x: number;
  }[];
  outputs: {
    id: string;
    x: number;
  }[];
}

/** 工程の上下間隔、外側の余白、折り返し時の行幅、並行する箱の間隔 */
const GAP = 128, SIDE = 64, ROW_WIDTH = 1120, COLUMN_GAP = 96;
/** Input: ポート名の一覧。Output: 長い名前も読める入出力帯の高さ */
const bandHeight = (names: string[]) => names.length ? Math.max(72, ...names.map(n => 40 + Math.ceil(textWidth(n, 14) / 112) * 20)) : 0;
/** Input: ポート ID と帯の幅・開始位置。Output: 等間隔の接続点の横位置 */
const positions = (ids: string[], width: number, start = 16) => ids.map((id, i) => ({ id, x: start + (width - start - 16) * (i + .5) / ids.length }));
/**
 * 子から親の順にカードの大きさを決め、依存する工程を上から下へ並べる。
 * Input: 横表示のノード、表示用計画、表示範囲、並行工程を折り返すか (既定 false)
 * Output: 上下ポートを持つノードのコピー。保存座標には書き戻さない
 */
export function verticalNodes(base: AnyRFNode[], p: Project, scope: string | null, wrap = false): AnyRFNode[] {
  const nodes = base.map(n => ({ ...n, position: { ...n.position }, data: { ...n.data } })) as AnyRFNode[];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const blocks = nodes.filter(n => n.type === "block" && !n.hidden);
  /** Input: 親 ID・開始高さ。Output: 子を配置した領域の寸法。nodes のコピーだけを変更する */
  const place = (parent: string, top: number): {
    width: number;
    height: number;
  } => {
    const children = blocks.filter(n => (n.parentId ?? ROOT_ID) === parent);
    const cols = readingColumns(p, parent);
    const groups = cols.length ? cols.map(c => c.ids.map(id => byId.get(id)!).filter(n => n && !n.hidden)) : [children];
    const rows: AnyRFNode[][] = [];
    for (const group of groups) {
      let row: AnyRFNode[] = [], width = 0;
      for (const n of group) {
        if (wrap && row.length && width + COLUMN_GAP + n.width! > ROW_WIDTH) {
          rows.push(row);
          row = [];
          width = 0;
        }
        width += (row.length ? COLUMN_GAP : 0) + n.width!;
        row.push(n);
      }
      if (row.length)
        rows.push(row);
    }
    const rowWidth = (row: AnyRFNode[]) => row.reduce((w, n) => w + n.width!, 0) + COLUMN_GAP * Math.max(0, row.length - 1);
    const width = Math.max(320, ...rows.map(rowWidth));
    let y = top;
    for (const row of rows) {
      let x = SIDE + (width - rowWidth(row)) / 2;
      for (const n of row) {
        n.position = { x, y };
        x += n.width! + COLUMN_GAP;
      }
      y += Math.max(...row.map(n => n.height!)) + GAP;
    }
    return { width: width + SIDE * 2, height: rows.length ? y - GAP : top };
  };
  // 子の大きさを確定してから親を包む (元の配列は親→子)。
  for (const n of [...blocks].reverse()) {
    if (n.type !== "block") continue;
    const expanded = isExpanded(p, n.id);
    const ins = expanded ? portsOf(p, n.id, "in") : taskCardPorts(p, n.id, "in");
    const outs = expanded ? portsOf(p, n.id, "out") : taskCardPorts(p, n.id, "out");
    // 合流のボックス: 小さな部品のまま。入力は上の辺に等間隔、出力は下の先端の中央 (名前の帯は持たない)
    if (p.blocks[n.id]?.merge) {
      const w = Math.max(MERGE_W, 24 + 40 * ins.length);
      n.width = w;
      n.height = 96;
      n.data.headerH = 0;
      n.data.vertical = { inputH: 0, outputH: 0, inputStart: 0, inputs: positions(ins.map(q => q.id), w, 16), outputs: outs.map(q => ({ id: q.id, x: w / 2 })) };
      continue;
    }
    const inputH = bandHeight(ins.map(q => q.name)), outputH = bandHeight(outs.map(q => q.name));
    const card = taskCardLayout(p, n.id);
    const headH = card.headerH;
    let width = Math.max(320, 32 + 144 * Math.max(ins.length, outs.length));
    let height = inputH + headH + outputH;
    let inputStart = 16;
    if (expanded) {
      const size = place(n.id, Math.max(headH, inputH) + COLUMN_GAP);
      width = Math.max(size.width, 352 + 144 * ins.length, 32 + 144 * outs.length);
      // 親の見出しは左、入力帯は上の右側。配線が題名を横切らない。
      inputStart = 336;
      height = size.height + GAP + outputH;
      for (const child of blocks.filter(q => q.parentId === n.id))
        child.position.x += (width - size.width) / 2;
    }
    n.width = width;
    n.height = height;
    n.data.headerH = headH;
    n.data.vertical = { inputH, outputH, inputStart, inputs: positions(ins.map(q => q.id), width, expanded ? inputStart + 16 : inputStart), outputs: positions(outs.map(q => q.id), width) };
  }
  // 外部の入出力ノードも上下に置く。
  const terminals = nodes.filter(n => n.type === 'terminal');
  for (const n of terminals) {
    if (n.type !== 'terminal') continue;
    const qs = n.data.scopeId ? portsOf(p, n.data.scopeId, n.data.which) : n.data.which === 'in' ? rootInputsOf(p, n.data.groupId ?? null) : portsOf(p, ROOT_ID, 'out');
    n.width = Math.max(320, 32 + 144 * qs.length);
    n.height = 40 + Math.max(48, bandHeight(qs.map(q => q.name)));
    const ps = positions(qs.map(q => q.id), n.width);
    n.data.vertical = { inputH: 0, outputH: 0, inputStart: 16, inputs: n.data.which === 'out' ? ps : [], outputs: n.data.which === 'in' ? ps : [] };
  }
  const inputs = terminals.filter(n => n.data.which === 'in');
  const outputs = terminals.filter(n => n.data.which === 'out');
  const terminalsWidth = inputs.reduce((w, n) => w + n.width! + 64, 0) - 64;
  const top = Math.max(0, ...inputs.map(n => n.height!)) + GAP;
  let size: {
    width: number;
    height: number;
  };
  if (scope && byId.has(scope)) {
    const n = byId.get(scope)!;
    n.position = { x: SIDE, y: top };
    size = { width: n.width! + SIDE * 2, height: top + n.height! };
  }
  else
    size = place(ROOT_ID, top);
  const width = Math.max(size.width, terminalsWidth, ...outputs.map(n => n.width!));
  for (const n of blocks.filter(n => !n.parentId))
    n.position.x += (width - size.width) / 2;
  let x = (width - terminalsWidth) / 2;
  for (const n of inputs) {
    n.position = { x, y: 0 };
    x += n.width! + 64;
  }
  for (const n of outputs)
    n.position = { x: (width - n.width!) / 2, y: size.height + GAP };
  return nodes;
}

/**
 * 横方向の検証済みルーターへ座標を転置して渡す。分岐や選択の描画は共用。
 * Input: ノード矩形と接続端点。Output: 元の座標系へ戻した配線経路の Map
 */
export function routeVertical(nodes: NodeRect[], edges: EdgeSpec[]) {
  const swap = (q: {
    x: number;
    y: number;
  }) => ({ x: q.y, y: q.x });
  const paths = routeAll(nodes.map(n => ({ ...n, rect: { x: n.rect.y, y: n.rect.x, width: n.rect.height, height: n.rect.width } })), edges.map(e => ({ ...e, s: swap(e.s), t: swap(e.t) })));
  return new Map([...paths].map(([id, points]) => [id, points.map(swap)]));
}
