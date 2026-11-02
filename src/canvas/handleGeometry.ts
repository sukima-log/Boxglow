/**
 * ノードの丸 (ハンドル) の位置を、DOM を測らずに計画から求める
 *   箱の部品 (BlockNode) と入出力ノード (TerminalNode) が丸を置く位置と同じ計算をし、丸の中心をノードの左上からの位置で返す。
 *   線の経路計算の入力と、React Flow に渡す丸の位置 (node.handles) に使う。
 *   以前は経路計算の入力を、画面に描いた丸を DOM から測って作っていたため、丸が 1 つ測り直されるたびに全部の線の経路を計算し直していた
 *   (箱が 1000 ある階層で Edit に切り替えると経路計算が 366 回走り、2 分以上かかった。2026-11-03 計測)。
 *
 * 丸の置き方 (index.css と BlockNode / TerminalNode の style と同じ。CSS や部品を変えたらここも合わせる):
 *   - 丸は枠線の内側 (padding の縁) を基準に置かれる (.bg-block / .bg-terminal は position: relative)
 *   - 左の丸: left = -7px、translate(-50%, -50%) → 中心は 枠線の太さ - 7
 *   - 右の丸: right = -7px、translate(50%, -50%) → 中心は 幅 - 枠線の太さ + 7
 *   - 縦表示の丸: left / top を直接指定し、translate(-50%, -50%) → 中心は 枠線の太さ + left / 枠線の太さ + top
 *   - 丸の大きさは 12px (枠線を含む)。大きさは中心に影響しない
 */
import { Position, type NodeHandle } from "@xyflow/react";
import { ancestorsOf, portsOf, rootInputsOf } from "../model/graph";
import { expandedPortRows, isExpanded, taskCardLayout, taskCardPorts } from "../model/size";
import { ROOT_ID, type Port, type Project } from "../model/types";
import { handleId, rowY } from "./layout";
import type { VerticalCard } from "./verticalLayout";
import type { NodeRect } from "./routeAll";

/** 丸の大きさ (index.css の .react-flow__handle。枠線を含む) */
export const HANDLE_SIZE = 12;
/** 左右の丸を枠の外へずらす量 (index.css の .react-flow__handle-left / -right の -7px) */
export const HANDLE_OUTSET = 7;
/** 入出力ノードの枠線の太さ (index.css の .bg-terminal) */
export const TERMINAL_BORDER = 3;

/**
 * 部品が描く大きさ (DOM の offsetWidth / offsetHeight と同じ整数)
 *   ブラウザは大きさを 1/64px 単位で扱ってから整数に丸める。計算の誤差で 278.49999999999994 になった幅は、ブラウザでは 278.5 → 279 になるため、
 *   先に 1/64px 単位にそろえてから丸める (そのまま丸めると 278 になり、右の丸が 1px ずれた)
 * Input : v = 渡した大きさ / Output: 整数
 */
export const domSize = (v: number): number => Math.round(Math.round(v * 64) / 64);

/**
 * 箱の枠線の太さ (px。index.css と同じ: 普通の箱 1px、合流 0、展開中の箱は深さで 4 / 3 / 3 / 2px)
 * Input : p, blockId / Output: 太さ
 */
export function blockBorderW(p: Project, blockId: string): number {
  const depth = Math.min(6, Math.max(1, ancestorsOf(p, blockId).length));
  return isExpanded(p, blockId) ? (depth <= 1 ? 4 : depth <= 3 ? 3 : 2) : p.blocks[blockId]?.merge ? 0 : 1;
}

/**
 * 箱の横表示の丸の行 (BlockNode が丸を置く style.top と同じ)
 * Input : p, blockId, headerH = 見出しの高さ (ノードの data.headerH), viewScope = 開いているタブの箱 (null は Top)
 * Output: ins / outs = 丸を置く入力 / 出力 (並びは BlockNode と同じ), borderW = 枠線の太さ,
 *         top(i, direction, portId) = その丸の style.top (枠線の内側から。中心の高さ = borderW + top)
 */
export function blockHandleRows(p: Project, blockId: string, headerH: number, viewScope: string | null) {
  const expanded = isExpanded(p, blockId);
  const ins = expanded ? portsOf(p, blockId, "in") : taskCardPorts(p, blockId, "in");
  const outs = expanded ? portsOf(p, blockId, "out") : taskCardPorts(p, blockId, "out");
  const card = taskCardLayout(p, blockId);
  // 展開中の箱の丸は、枠の内側でつながる中の箱の丸と同じ高さ。タブで開いている箱だけは見出しの下に並べる (BlockNode の alignRows)
  const expandedRows = expanded && viewScope !== blockId ? expandedPortRows(p, blockId) : new Map<string, number>();
  const borderW = blockBorderW(p, blockId);
  const top = (i: number, direction: "in" | "out", portId: string): number => (expanded
    ? expandedRows.get(portId) ?? headerH + i * 26 + 13
    : (direction === "in" ? card.inputs : card.outputs)[i].center) - borderW;
  return { ins, outs, borderW, expanded, top };
}

/** 丸 1 つ分 (中心から左上を求めて React Flow の形にする) */
const place = (id: string, type: "source" | "target", position: Position, cx: number, cy: number): NodeHandle =>
  ({ id, type, position, x: cx - HANDLE_SIZE / 2, y: cy - HANDLE_SIZE / 2, width: HANDLE_SIZE, height: HANDLE_SIZE });

/**
 * 箱の丸の位置 (BlockNode が置く丸と同じ。展開中の箱は内側の丸も)
 * Input : p, blockId, o.width / o.height = ノードの大きさ, o.headerH = 見出しの高さ, o.viewScope = 開いているタブの箱,
 *         o.vertical = 縦表示のカード (ノードの data.vertical。横表示なら省略)
 * Output: NodeHandle の配列 (x / y はノードの左上から、丸の左上)
 */
export function blockHandles(p: Project, blockId: string, o: { width: number; height: number; headerH: number; viewScope: string | null; vertical?: VerticalCard }): NodeHandle[] {
  const rows = blockHandleRows(p, blockId, o.headerH, o.viewScope);
  const bw = rows.borderW;
  const out: NodeHandle[] = [];
  if (o.vertical) {
    // 縦表示: 入力は上、出力は下。展開中は内側の丸も (入力は見出しの下、出力は下の帯の上)
    const v = o.vertical;
    for (const direction of ["in", "out"] as const) {
      const qs = direction === "in" ? rows.ins : rows.outs;
      const layout = direction === "in" ? v.inputs : v.outputs;
      for (const q of qs) {
        for (const side of rows.expanded ? (["outer", "inner"] as const) : (["outer"] as const)) {
          const input = direction === "in", inner = side === "inner";
          const x = layout.find((r) => r.id === q.id)?.x;
          const left = x ?? (o.width - 2 * bw) / 2; // 並びに無い丸は CSS の既定 (left: 50%)
          const top = input ? (inner ? v.inputH + 8 : 0) : o.height - (inner ? v.outputH + 8 : 0);
          out.push(place(handleId(direction, q.id, side), input !== inner ? "target" : "source", input !== inner ? Position.Top : Position.Bottom, bw + left, bw + top));
        }
      }
    }
    return out;
  }
  // 横表示: 入力は左 (外側の丸 = 受け側、内側の丸 = 中へ流す側)、出力は右 (外側の丸 = 出す側、内側の丸 = 中から受ける側)
  const leftX = bw - HANDLE_OUTSET;
  const rightX = o.width - bw + HANDLE_OUTSET;
  rows.ins.forEach((q, i) => {
    const cy = bw + rows.top(i, "in", q.id);
    out.push(place(handleId("in", q.id, "outer"), "target", Position.Left, leftX, cy));
    if (rows.expanded) out.push(place(handleId("in", q.id, "inner"), "source", Position.Right, leftX, cy));
  });
  rows.outs.forEach((q, i) => {
    const cy = bw + rows.top(i, "out", q.id);
    out.push(place(handleId("out", q.id, "outer"), "source", Position.Right, rightX, cy));
    if (rows.expanded) out.push(place(handleId("out", q.id, "inner"), "target", Position.Left, rightX, cy));
  });
  return out;
}

/**
 * 入出力ノードに並ぶポート (TerminalNode と同じ)
 * Input : p, data = ノードの data (which / groupId / scopeId) / Output: ポートの配列
 */
export function terminalPorts(p: Project, data: { which: "in" | "out"; groupId?: string; scopeId?: string }): Port[] {
  if (data.scopeId) return portsOf(p, data.scopeId, data.which);
  return data.which === "in" ? rootInputsOf(p, data.groupId ?? null) : portsOf(p, ROOT_ID, "out");
}

/**
 * 入出力ノードの丸の位置 (TerminalNode が置く丸と同じ。入力ノードは右、出力ノードは左。縦表示は下 / 上)
 * Input : p, data = ノードの data, o.width / o.height = ノードの大きさ
 * Output: NodeHandle の配列
 */
export function terminalHandles(p: Project, data: { which: "in" | "out"; groupId?: string; scopeId?: string; vertical?: VerticalCard }, o: { width: number; height: number }): NodeHandle[] {
  const b = TERMINAL_BORDER;
  const which = data.which;
  return terminalPorts(p, data).map((q, i) => {
    const id = handleId(which, q.id, "inner");
    const type = which === "in" ? "source" : "target";
    if (data.vertical) {
      const x = (which === "in" ? data.vertical.outputs : data.vertical.inputs).find((r) => r.id === q.id)?.x;
      const left = x ?? (o.width - 2 * b) / 2;
      return place(id, type, which === "in" ? Position.Bottom : Position.Top, b + left, b + (which === "in" ? o.height : 0));
    }
    return place(id, type, which === "in" ? Position.Right : Position.Left, which === "in" ? o.width - b + HANDLE_OUTSET : b - HANDLE_OUTSET, b + rowY(i));
  });
}

/**
 * 図のノード 1 つの丸の位置 (箱・入出力ノード。どちらでもなければ丸なし)
 * Input : p = 表示用の計画 (箱の部品が描く計画と同じ), n = 図のノード (位置・大きさ・data が決まったもの), viewScope = 開いているタブの箱
 * Output: NodeHandle の配列
 */
export function nodeHandles(p: Project, n: { type?: string; width?: number; height?: number; data: Record<string, unknown> }, viewScope: string | null): NodeHandle[] {
  // 部品は React Flow が測った大きさ (DOM の offsetWidth / offsetHeight = 整数に丸めた値) で自分を描くので、丸もその大きさを基準に置かれる
  const width = domSize(n.width ?? 0), height = domSize(n.height ?? 0);
  const d = n.data as { blockId?: string; headerH?: number; vertical?: VerticalCard; which?: "in" | "out"; groupId?: string; scopeId?: string };
  if (n.type === "block" && d.blockId) return blockHandles(p, d.blockId, { width, height, headerH: d.headerH ?? 44, viewScope, vertical: d.vertical });
  if (n.type === "terminal" && d.which) return terminalHandles(p, { which: d.which, groupId: d.groupId, scopeId: d.scopeId, vertical: d.vertical }, { width, height });
  return [];
}

/**
 * 図のノードの絶対位置・大きさと丸の中心を 1 つの文字列にする (線の経路計算・表示範囲の計算の入力)
 *   DOM を測らず、ノードに載せた位置・大きさ・丸 (node.handles) から作る。以前の DOM から測った文字列 (selectGeometry) と同じ形・同じ丸め。
 *   大きさは部品が描く大きさ (整数に丸めた値。React Flow が DOM で測る offsetWidth と同じ)
 * Input : nodes = 図のノード (React Flow に渡している並び。ドラッグ中の位置を含む)
 * Output: "N\tid\t親\tx\ty\t幅\t高さ" と "H\tid\t丸の id\tx\ty" の行
 */
export function modelGeometry(nodes: { id: string; parentId?: string; position: { x: number; y: number }; width?: number; height?: number; hidden?: boolean; measured?: { width?: number; height?: number }; handles?: NodeHandle[] }[]): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const abs = new Map<string, { x: number; y: number }>();
  // 絶対位置 = 自分の位置 + 親の絶対位置 (React Flow の positionAbsolute と同じ。nodeOrigin は左上)
  const absOf = (id: string, guard = 0): { x: number; y: number } => {
    const hit = abs.get(id);
    if (hit) return hit;
    const n = byId.get(id);
    if (!n) return { x: 0, y: 0 };
    const parent = n.parentId && guard < 64 ? absOf(n.parentId, guard + 1) : { x: 0, y: 0 };
    const a = { x: parent.x + n.position.x, y: parent.y + n.position.y };
    abs.set(id, a);
    return a;
  };
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.hidden) continue;
    const a = absOf(n.id);
    const w = domSize(n.width ?? n.measured?.width ?? 0);
    const h = domSize(n.height ?? n.measured?.height ?? 0);
    lines.push(`N\t${n.id}\t${n.parentId ?? ""}\t${Math.round(a.x)}\t${Math.round(a.y)}\t${w}\t${h}`);
    for (const hd of n.handles ?? []) lines.push(`H\t${n.id}\t${hd.id ?? ""}\t${Math.round(a.x + hd.x + (hd.width ?? 0) / 2)}\t${Math.round(a.y + hd.y + (hd.height ?? 0) / 2)}`);
  }
  return lines.join("\n");
}

/**
 * modelGeometry の文字列を戻す
 * Input : sig / Output: nodeRects = ノードの絶対位置と大きさ (並びは文字列の順), handles = "ノード id|丸の id" -> 丸の中心
 */
export function parseGeometry(sig: string): { nodeRects: NodeRect[]; handles: Map<string, { x: number; y: number }> } {
  const nodeRects: NodeRect[] = [];
  const handles = new Map<string, { x: number; y: number }>();
  for (const line of sig.split("\n")) {
    if (!line) continue;
    const f = line.split("\t");
    if (f[0] === "N") nodeRects.push({ id: f[1], parentId: f[2], rect: { x: Number(f[3]), y: Number(f[4]), width: Number(f[5]), height: Number(f[6]) } });
    else if (f[0] === "H") handles.set(`${f[1]}|${f[2]}`, { x: Number(f[3]), y: Number(f[4]) });
  }
  return { nodeRects, handles };
}

/** ノードの矩形 (絶対位置と、部品が描く大きさ) */
export interface ModelRect { id: string; x: number; y: number; width: number; height: number }

/**
 * 図のノードの矩形を求める (表示範囲の計算用。React Flow の getNodesBounds / positionAbsolute と同じ値: 位置は小数のまま、大きさは部品が描く整数)
 * Input : nodes = 図のノード, ids = 対象のノード (省略は見えている全部) / Output: 矩形の配列 (隠れているノードは含めない)
 */
export function modelRects(nodes: { id: string; parentId?: string; position: { x: number; y: number }; width?: number; height?: number; hidden?: boolean; measured?: { width?: number; height?: number } }[], ids?: string[]): ModelRect[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const absOf = (id: string, guard = 0): { x: number; y: number } => {
    const n = byId.get(id);
    if (!n) return { x: 0, y: 0 };
    const parent = n.parentId && guard < 64 ? absOf(n.parentId, guard + 1) : { x: 0, y: 0 };
    return { x: parent.x + n.position.x, y: parent.y + n.position.y };
  };
  const want = ids ? new Set(ids) : null;
  return nodes.filter((n) => !n.hidden && (!want || want.has(n.id))).map((n) => {
    const a = absOf(n.id);
    return { id: n.id, x: a.x, y: a.y, width: domSize(n.width ?? n.measured?.width ?? 0), height: domSize(n.height ?? n.measured?.height ?? 0) };
  });
}

/** 矩形の集まりを囲む矩形 (無ければ null) */
export function boundsOfRects(rects: ModelRect[]): { x: number; y: number; width: number; height: number } | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.width); y1 = Math.max(y1, r.y + r.height); }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
