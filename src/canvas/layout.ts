/**
 * Project -> React Flow のノード・線への変換 (純粋関数)
 *
 * ブロックの大きさはここで決める (React Flow に幅・高さを渡し、線の付け根がずれないようにする)。
 * ハンドル (ポートの丸) の id は "<in|out>:<ポート id>:<outer|inner>"。
 */
import { MarkerType, type Edge as RFEdge, type Node as RFNode } from "@xyflow/react";
import { ROOT_ID, type Edge, type Endpoint, type Project } from "../model/types";
import { wireNet, inputGroupsOf, isEdgeReady, isHiddenByCollapse, rootInputsOf } from "../model/graph";

export { BLOCK_W, HEADER_H, ROW_H, PAD_BOTTOM, EXPANDED_MIN_W, EXPANDED_PAD, TERMINAL_W, isExpanded, blockSize, terminalHeight, type Size } from "../model/size";
import { blockSize, isExpanded, terminalHeight, TERMINAL_W, HEADER_H, ROW_H, PAD_BOTTOM } from "../model/size";

/** 既定の入力ノードの高さ (グループに入っていない入力だけ) */
function terminalHeightDefault(p: Project): number {
  const n = rootInputsOf(p, null).length;
  return HEADER_H + Math.max(n, 1) * ROW_H + PAD_BOTTOM;
}

/** ポート i 行目のハンドルの縦位置 (箱の上端から) */
export const rowY = (i: number): number => HEADER_H + i * ROW_H + ROW_H / 2;

/** ハンドル id を作る */
export const handleId = (direction: "in" | "out", portId: string, side: Endpoint["side"]): string => `${direction}:${portId}:${side}`;

/** ハンドル id を端点に戻す (形式が違えば null) */
export function parseHandle(id: string | null | undefined): Endpoint | null {
  if (!id) return null;
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const side = parts[2];
  if (side !== "outer" && side !== "inner") return null;
  return { portId: parts[1], side };
}

/** 端点が付くノードの id (最上位のポートは入力/出力ノード) */
export function nodeIdOfPort(p: Project, portId: string): string | null {
  const port = p.ports[portId];
  if (!port) return null;
  if (port.blockId === ROOT_ID) return port.direction === "in" ? (port.groupId ? `root-in:${port.groupId}` : "root-in") : "root-out";
  return port.blockId;
}

/** 入力グループのノードの高さ */
export function groupHeight(p: Project, groupId: string): number {
  const n = rootInputsOf(p, groupId).length;
  return HEADER_H + Math.max(n, 1) * ROW_H + PAD_BOTTOM;
}

/** 線が、選んだ箱 (またはその中の箱) につながっているか */
function touches(p: Project, e: Edge, blockId: string): boolean {
  const fb = p.ports[e.from.portId]?.blockId;
  const tb = p.ports[e.to.portId]?.blockId;
  const within = (id: string | undefined): boolean => {
    let cur: string | null | undefined = id;
    while (cur) {
      if (cur === blockId) return true;
      cur = p.blocks[cur]?.parentId;
    }
    return false;
  };
  return within(fb) || within(tb);
}

/** ブロックの深さ (最上位直下 = 1) */
function depthOf(p: Project, blockId: string): number {
  let d = 0;
  let cur = p.blocks[blockId]?.parentId ?? null;
  while (cur !== null && cur !== ROOT_ID) {
    d++;
    cur = p.blocks[cur]?.parentId ?? null;
  }
  return d;
}

export type BlockNodeData = { blockId: string; dimmed: boolean; mine: boolean; headerH: number; dropTarget?: boolean };
export type TerminalNodeData = { which: "in" | "out"; groupId?: string };
export type BlockRFNode = RFNode<BlockNodeData, "block">;
export type TerminalRFNode = RFNode<TerminalNodeData, "terminal">;
export type AnyRFNode = BlockRFNode | TerminalRFNode;

/**
 * React Flow のノード一覧を作る
 * Input : selection = 選択中のブロック id, readonly, matcher = フィルタ (false を返したブロックは薄く描く)
 * Output: 親が子より先に並んだノード配列 (React Flow の要件)
 */
export function buildNodes(
  p: Project
, opts: { selectedBlockId: string | null; readonly: boolean; matcher?: (blockId: string) => boolean; meId?: string | null }
): AnyRFNode[] {
  const nodes: AnyRFNode[] = [];
  nodes.push({
    id: "root-in"
  , type: "terminal"
  , position: p.terminals.in
  , data: { which: "in" }
  , width: TERMINAL_W
  , height: terminalHeightDefault(p)
  , draggable: !opts.readonly
  , selectable: true
  , zIndex: 2    // 最上位の線 (1) より前
  });
  for (const gp of inputGroupsOf(p)) {
    nodes.push({
      id: `root-in:${gp.id}`
    , type: "terminal"
    , position: gp.position
    , data: { which: "in", groupId: gp.id }
    , width: TERMINAL_W
    , height: groupHeight(p, gp.id)
    , draggable: !opts.readonly
    , selectable: true
    , zIndex: 2
    });
  }
  nodes.push({
    id: "root-out"
  , type: "terminal"
  , position: p.terminals.out
  , data: { which: "out" }
  , width: TERMINAL_W
  , height: terminalHeight(p, "out")
  , draggable: !opts.readonly
  , selectable: true
  , zIndex: 2    // 同上 (出力ノード)
  });
  const blocks = Object.values(p.blocks).filter((b) => b.id !== ROOT_ID);
  blocks.sort((a, b) => depthOf(p, a.id) - depthOf(p, b.id));
  for (const b of blocks) {
    const size = blockSize(p, b.id);
    const nested = b.parentId !== null && b.parentId !== ROOT_ID;
    nodes.push({
      id: b.id
    , type: "block"
    , position: b.position
    , parentId: nested ? b.parentId! : undefined
    , data: { blockId: b.id, dimmed: opts.matcher ? !opts.matcher(b.id) : false, mine: !!opts.meId && b.assigneeIds.includes(opts.meId), headerH: size.headerH }
    , width: size.width
    , height: size.height
    , hidden: isHiddenByCollapse(p, b.id)
    , selected: opts.selectedBlockId === b.id
    , draggable: !opts.readonly
    , selectable: true
      // 深さ x 2 (線がその間 (+1) に入る余地を作る)。入れ子の箱は親より大きい値になる
    , zIndex: 2 * depthOf(p, b.id)
    });
  }
  return nodes;
}

/**
 * React Flow の線一覧を作る
 * Input : selectedEdgeId
 * Output: 線の配列 (畳まれて見えない端点を持つ線は hidden)
 */
export function buildEdges(p: Project, opts: { selectedEdgeId: string | null; selectedBlockId?: string | null }): RFEdge[] {
  const edges: RFEdge[] = [];
  // 線を選んだときは、親の縁を越えてつながる線 (同じ信号) をまとめて強調する
  const net = opts.selectedEdgeId ? wireNet(p, opts.selectedEdgeId) : new Set<string>();
  for (const e of Object.values(p.edges)) {
    const fp = p.ports[e.from.portId];
    const tp = p.ports[e.to.portId];
    if (!fp || !tp) continue;
    const source = nodeIdOfPort(p, fp.id);
    const target = nodeIdOfPort(p, tp.id);
    if (!source || !target) continue;
    // 端点が見えるか: ブロックが畳まれた祖先の中にある / inner 面なのに箱が畳まれている
    const endpointVisible = (ep: Endpoint): boolean => {
      const port = p.ports[ep.portId];
      if (!port) return false;
      if (port.blockId === ROOT_ID) return true;
      if (isHiddenByCollapse(p, port.blockId)) return false;
      if (ep.side === "inner" && !isExpanded(p, port.blockId)) return false;
      return true;
    };
    const hidden = !endpointVisible(e.from) || !endpointVisible(e.to);
    // 供給元に成果物がある (または完了している) 線は「用意できた」線として太く描く
    const ready = isEdgeReady(p, e);
    // 重なり順: React Flow は「線の zIndex + 入れ子の箱の z」で決める。箱の z は深さ x 2 (整数) なので、
    // +1 で「同じ階層の箱の上、深い箱の下」に入る (小数は CSS の z-index として無効なので使わない)
    const edgeZ = 1;
    edges.push({
      id: e.id
    , type: "routed"
      // 矢印は「入力に入る線」だけ (親の出力へ上がる線は出ていく線なので付けない)
    , markerEnd: tp.direction === "in" ? { type: MarkerType.ArrowClosed, width: 12, height: 12, color: ready ? "#0d8080" : "#a9afb6" } : undefined
    , source
    , sourceHandle: handleId(fp.direction, fp.id, e.from.side)
    , target
    , targetHandle: handleId(tp.direction, tp.id, e.to.side)
    , hidden
    , selected: opts.selectedEdgeId === e.id
    , data: { net: net.has(e.id) && opts.selectedEdgeId !== e.id }
      // 箱を選んでいるときは、その箱 (と中の箱) につながる線だけ濃くし、ほかは薄くする
    , className: [
        e.auto ? "edge-auto" : ""
      , ready ? "edge-ready" : ""
      , opts.selectedBlockId ? (touches(p, e, opts.selectedBlockId) ? "edge-hot" : "edge-dim") : opts.selectedEdgeId ? (net.has(e.id) ? "edge-net" : "edge-dim") : ""
      ].filter(Boolean).join(" ") || undefined
      // ラベルは、選んだ線と、選んだ箱につながる線だけに出す (全部に出すと重なって読めない)
    , label: opts.selectedEdgeId === e.id || (opts.selectedBlockId && touches(p, e, opts.selectedBlockId)) ? (fp.direction === "out" ? fp.name : tp.name) : undefined
    , labelShowBg: true
    , labelBgPadding: [6, 3]
    , labelBgBorderRadius: 6
    , labelStyle: { fontSize: 11, fill: "var(--text)" }
    , labelBgStyle: { fill: "var(--bg-card)", stroke: "var(--line-soft)", strokeWidth: 1 }
    , zIndex: edgeZ
    });
  }
  return edges;
}
