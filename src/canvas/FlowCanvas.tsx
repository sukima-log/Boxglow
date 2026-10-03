/**
 * キャンバス: React Flow にプロジェクトを描き、ドラッグ・結線・選択を store に反映する
 */
import { Background, BackgroundVariant, Controls, MiniMap, ReactFlow, useNodesState, useReactFlow, useStore, type ReactFlowState, type Connection, type Edge as RFEdge, type NodeChange, type OnConnectEnd, type OnNodeDrag } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connect, connectToBlock, isHiddenByCollapse, majorBlocks, moveBlock, moveBlockToParent, moveInputGroup, moveTerminal, resolveOverlap, validateConnection } from "../model/graph";
import { blockSize, isExpanded } from "../model/size";
import { ROOT_ID } from "../model/types";
import { nextFreePosition } from "../model/autolayout";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { BlockNode } from "./BlockNode";
import { TerminalNode } from "./TerminalNode";
import { RoutedEdge } from "./RoutedEdge";
import { buildEdges, buildNodes, parseHandle, SCOPE_IN, SCOPE_OUT, type AnyRFNode } from "./layout";
import { FrameNode } from "./FrameNode";
import { routeAll, type EdgeSpec, type NodeRect } from "./routeAll";

/** 全体表示の設定: 大きな計画でも収まるよう最小ズームを下げる (fitView の既定は 0.5 で、大きい図は左右が切れる) */
const FIT_OPTIONS = { padding: 0.15, minZoom: 0.05, maxZoom: 1 };

const nodeTypes = { block: BlockNode, terminal: TerminalNode, frame: FrameNode };

/** ノードの絶対位置・大きさと、ハンドルの中心位置を 1 つの文字列にする (経路計算の入力) */
const selectGeometry = (s: ReactFlowState): string => {
  const lines: string[] = [];
  for (const n of s.nodes) {
    if (n.hidden) continue;
    const internal = s.nodeLookup.get(n.id);
    const abs = internal?.internals.positionAbsolute ?? n.position;
    const w = n.type === "frame" ? 0 : internal?.measured.width ?? n.width ?? 0; // 見えない枠は障害物にも壁にもしない
    const h = n.type === "frame" ? 0 : internal?.measured.height ?? n.height ?? 0;
    lines.push(`N\t${n.id}\t${n.parentId ?? ""}\t${Math.round(abs.x)}\t${Math.round(abs.y)}\t${Math.round(w)}\t${Math.round(h)}`);
    const hb = internal?.internals.handleBounds;
    for (const hd of [...(hb?.source ?? []), ...(hb?.target ?? [])]) {
      lines.push(`H\t${n.id}\t${hd.id ?? ""}\t${Math.round(abs.x + hd.x + hd.width / 2)}\t${Math.round(abs.y + hd.y + hd.height / 2)}`);
    }
  }
  return lines.join("\n");
};

/** selectGeometry の文字列を戻す */
function parseGeometry(sig: string): { nodeRects: NodeRect[]; handles: Map<string, { x: number; y: number }> } {
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
const edgeTypes = { routed: RoutedEdge };

interface Props {
  project: Project;
  /** フィルタ (false を返したブロックは薄く描く)。null なら全部そのまま */
  matcher: ((blockId: string) => boolean) | null;
}

export function FlowCanvas({ project, matcher }: Props) {
  const readonly = useProjectStore((s) => s.readonly);
  const editMode = useProjectStore((s) => s.editMode);
  const canEdit = !readonly && editMode;
  const selection = useProjectStore((s) => s.selection);
  const select = useProjectStore((s) => s.select);
  const apply = useProjectStore((s) => s.apply);
  const setToast = useProjectStore((s) => s.setToast);
  const focus = useProjectStore((s) => s.focus);
  const meId = useProjectStore((s) => s.meId);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const viewScope = useProjectStore((s) => s.viewScope);
  const rf = useReactFlow();


  // 動作確認やスクリーンショット用に、React Flow の instance もコンソールから触れるようにしておく
  useEffect(() => { (window as unknown as { boxglow?: { rf?: unknown } }).boxglow = { ...((window as unknown as { boxglow?: object }).boxglow ?? {}), rf }; }, [rf]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // 追加したブロックが画面の外にあるときは、そこへ寄せる (拡大率は変えない)
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      const node = rf.getInternalNode(focus.blockId);
      if (!node) return;
      const w = node.measured.width ?? 240;
      const h = node.measured.height ?? 80;
      const abs = node.internals.positionAbsolute;
      const { zoom } = rf.getViewport();
      const { x, y } = rf.flowToScreenPosition({ x: abs.x, y: abs.y });
      const el = document.querySelector(".react-flow") as HTMLElement | null;
      const vw = el?.clientWidth ?? window.innerWidth;
      const vh = el?.clientHeight ?? window.innerHeight;
      const visible = x >= 0 && y >= 0 && x + w * zoom <= vw && y + h * zoom <= vh;
      if (!visible) void rf.setCenter(abs.x + w / 2, abs.y + h / 2, { zoom, duration: 300 });
    }, 120);
    return () => clearTimeout(t);
  }, [focus, rf]);

  // ノードはドラッグ中の見た目のために React Flow 側の状態を持ち、project が変わるたびに作り直す
  const [nodes, setNodes, onNodesChangeRaw] = useNodesState<AnyRFNode>([]);
  useEffect(() => {
    setNodes(buildNodes(project, { selectedBlockId: selection.blockId, readonly: !canEdit, matcher: matcher ?? undefined, meId, scope: viewScope }));
  }, [project, selection.blockId, canEdit, matcher, meId, viewScope, setNodes]);
  useEffect(() => {
    setNodes((ns) => ns.map((n) => (n.type === "block" ? { ...n, data: { ...n.data, dropTarget: n.id === dropTarget } } : n)));
  }, [dropTarget, setNodes]);

  // タブ (表示範囲) を切り替えたら、その範囲が収まるように全体表示する。
  // ノードが作り直されて大きさが測られる (nodesInitialized) のを待ってから fitView する (早すぎると古い大きさで計算して外れる)
  const scopeMounted = useRef(false);
  const pendingFit = useRef(false);
  useEffect(() => {
    if (!scopeMounted.current) { scopeMounted.current = true; return; } // 最初は fitView 属性に任せる
    pendingFit.current = true;
  }, [viewScope]);
  useEffect(() => {
    if (!pendingFit.current) return;
    // 見えているノードが全部測られてから (大きさの変化も nodes の更新として届くので、この効果が再び走る)
    const ready = rf.getNodes().every((n) => n.hidden || (n.measured?.width ?? 0) > 0);
    if (!ready) return;
    pendingFit.current = false;
    const t = setTimeout(() => void rf.fitView({ ...FIT_OPTIONS, duration: 250 }), 30);
    return () => clearTimeout(t);
  }, [nodes, rf]);

  // 箱にマウスを乗せたら、つながる線を強調する
  const [hovered, setHovered] = useState<string | null>(null);
  const baseEdges = useMemo(() => buildEdges(project, { selectedEdgeId: selection.edgeId, selectedBlockId: selection.blockId, scope: viewScope }), [project, selection.edgeId, selection.blockId, viewScope]);

  // ノードの絶対位置・大きさ・ハンドルの位置 (変わったときだけ経路を計算し直すため、文字列にして比べる)
  const geometrySig = useStore(selectGeometry);
  const edges = useMemo(() => {
    const { nodeRects, handles } = parseGeometry(geometrySig);
    const specs: EdgeSpec[] = [];
    for (const e of baseEdges) {
      if (e.hidden) continue;
      const s = handles.get(`${e.source}|${e.sourceHandle ?? ""}`);
      const t = handles.get(`${e.target}|${e.targetHandle ?? ""}`);
      if (!s || !t) continue;
      specs.push({ id: e.id, source: e.source, target: e.target, s, t });
    }
    const paths = routeAll(nodeRects, specs);
    return baseEdges.map((e) => {
      const path = paths.get(e.id);
      const hot = hovered && (e.source === hovered || e.target === hovered);
      const hotClass = hot || (e.className ?? "").includes("edge-hot");
      return {
        ...e
      , data: { ...(e.data ?? {}), path, hot: !!hotClass } // net (選んだ線とのつながり) を残す
      , className: hot ? `${(e.className ?? "").replace("edge-dim", "")} edge-hot` : e.className
      };
    });
  }, [baseEdges, geometrySig, hovered]);

  /** 選択の変化を store に伝え、位置の変化は React Flow の状態に反映する */
  const onNodesChange = useCallback(
    (changes: NodeChange<AnyRFNode>[]) => {
      onNodesChangeRaw(changes);
      for (const ch of changes) {
        if (ch.type === "select" && ch.selected) {
          if (ch.id === "root-in") select({ terminal: "in" });
          else if (ch.id.startsWith("root-in:")) select({ terminal: "in", terminalGroup: ch.id.slice(8) });
          else if (ch.id === "root-out") select({ terminal: "out" });
          // 大項目の入力/出力ノードを選んだら、その大項目の箱を選ぶ (右のパネルで入出力を直せる)
          else if (ch.id === SCOPE_IN || ch.id === SCOPE_OUT) { const sc = useProjectStore.getState().viewScope; if (sc) select({ blockId: sc }); }
          else select({ blockId: ch.id });
          // 右の詳細パネルが開いてキャンバスが狭まり、選んだノードが隠れることがあるので、見えなければ寄せる
          focusBlock(ch.id);
        }
      }
    }
  , [onNodesChangeRaw, select, focusBlock]
  );

  /**
   * ドラッグ中の箱の中心が入っている「落とせる箱」(展開中で、自分や自分の子孫でない) を探す。無ければ null
   * Input : nodeId = ドラッグ中の箱
   * Output: 落とせる箱の id (一番深いもの)
   */
  const findContainer = useCallback(
    (nodeId: string): string | null => {
      const me = rf.getInternalNode(nodeId);
      if (!me) return null;
      const cx = me.internals.positionAbsolute.x + (me.measured.width ?? 0) / 2;
      const cy = me.internals.positionAbsolute.y + (me.measured.height ?? 0) / 2;
      const myDesc = new Set<string>();
      const stack = [nodeId];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const b of Object.values(project.blocks)) if (b.parentId === cur) { myDesc.add(b.id); stack.push(b.id); }
      }
      let best: { id: string; depth: number } | null = null;
      // 落とせる箱: 展開中の箱、または All で畳まれている大項目 (中はタブで見る。落とすとその大項目の中の空いた場所に入る)
      const majors = new Set(majorBlocks(project).map((b) => b.id));
      for (const b of Object.values(project.blocks)) {
        if (b.id === ROOT_ID || b.id === nodeId || myDesc.has(b.id)) continue;
        if (!isExpanded(project, b.id) && !(majors.has(b.id) && !isHiddenByCollapse(project, b.id))) continue;
        const n = rf.getInternalNode(b.id);
        if (!n) continue;
        const x = n.internals.positionAbsolute.x;
        const y = n.internals.positionAbsolute.y;
        const w = n.measured.width ?? 0;
        const h = n.measured.height ?? 0;
        if (cx < x || cx > x + w || cy < y || cy > y + h) continue;
        let depth = 0;
        let cur: string | null = b.parentId;
        while (cur) { depth++; cur = project.blocks[cur]?.parentId ?? null; }
        if (!best || depth > best.depth) best = { id: b.id, depth };
      }
      return best?.id ?? null;
    }
  , [project, rf]
  );

  const onNodeDrag: OnNodeDrag<AnyRFNode> = useCallback(
    (_ev, node) => {
      if (node.type !== "block") return;
      const c = findContainer(node.id);
      const b = project.blocks[node.id];
      // 今の親と同じなら移動先ではない
      setDropTarget(c && b && c !== b.parentId ? c : null);
    }
  , [findContainer, project]
  );

  /** ドラッグが終わったら位置を保存する (履歴に積む)。別の箱の中に落としたら階層を移す */
  const onNodeDragStop: OnNodeDrag<AnyRFNode> = useCallback(
    (_ev, _node, dragged) => {
      setDropTarget(null);
      apply((p) => {
        let q = p;
        for (const n of dragged) {
          if (n.id === "root-in") q = moveTerminal(q, "in", n.position);
          else if (n.id.startsWith("root-in:")) q = moveInputGroup(q, n.id.slice(8), n.position);
          else if (n.id === "root-out") q = moveTerminal(q, "out", n.position);
          else {
            const b = q.blocks[n.id];
            const container = b && b.kind !== "project" ? findContainer(n.id) : null;
            if (container && b && container !== b.parentId) {
              // 新しい親の座標系での位置に直す
              const me = rf.getInternalNode(n.id);
              const parent = rf.getInternalNode(container);
              if (me && parent) {
                // 畳まれた箱 (All の大項目) に落としたときは中の空いた場所へ。展開中なら落とした位置 (新しい親の座標系) へ
                const rel = isExpanded(project, container)
                  ? { x: me.internals.positionAbsolute.x - parent.internals.positionAbsolute.x, y: me.internals.positionAbsolute.y - parent.internals.positionAbsolute.y }
                  : nextFreePosition(q, container);
                q = moveBlockToParent(q, n.id, container, rel);
                q = resolveOverlap(q, n.id, blockSize);
                continue;
              }
            }
            q = moveBlock(q, n.id, n.position);
            // 同じ階層の箱と重なったままにしない
            q = resolveOverlap(q, n.id, blockSize);
          }
        }
        return q;
      });
    }
  , [apply, findContainer, rf]
  );

  /** 丸ではなく箱の上で離したときも結線する (空いている入力か、新しい入力へ) */
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromHandle || !state.fromHandle.id) return;
      const from = parseHandle(state.fromHandle.id);
      if (!from) return;
      const pt = "changedTouches" in event ? event.changedTouches[0] : (event as MouseEvent);
      const el = document.elementFromPoint(pt.clientX, pt.clientY);
      const nodeEl = el?.closest(".react-flow__node-block") as HTMLElement | null;
      const targetId = nodeEl?.getAttribute("data-id");
      if (!targetId) return;
      let error: string | undefined;
      apply((p) => {
        const r = connectToBlock(p, from, targetId);
        error = r.error;
        return r.project;
      });
      if (error) setToast(error);
    }
  , [apply, setToast]
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const from = parseHandle(c.sourceHandle);
      const to = parseHandle(c.targetHandle);
      if (!from || !to) return;
      let error: string | undefined;
      apply((p) => {
        const r = connect(p, from, to);
        error = r.error;
        return r.project;
      });
      if (error) setToast(error);
    }
  , [apply, setToast]
  );

  const isValidConnection = useCallback(
    (c: Connection | RFEdge) => {
      const from = parseHandle(c.sourceHandle);
      const to = parseHandle(c.targetHandle);
      if (!from || !to) return false;
      return validateConnection(project, from, to).ok;
    }
  , [project]
  );

  const onEdgeClick = useCallback((_ev: React.MouseEvent, e: RFEdge) => select({ edgeId: e.id }), [select]);
  const onPaneClick = useCallback(() => select({}), [select]);


  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodeMouseEnter={(_e, n) => setHovered(n.id)}
      onNodeMouseLeave={() => setHovered(null)}
      onNodesChange={onNodesChange}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onConnectEnd={onConnectEnd}
      connectionRadius={40}
      isValidConnection={isValidConnection}
      onEdgeClick={onEdgeClick}
      onPaneClick={onPaneClick}
      nodesDraggable={canEdit}
      nodesConnectable={canEdit}
      elementsSelectable
      deleteKeyCode={null}
      selectionKeyCode={null}
      multiSelectionKeyCode={null}
      zoomOnDoubleClick={false} // ダブルクリックは箱の畳む / 展開 (大項目ならタブを開く) に使う。拡大に取られると View で届かない
      fitView
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.05} // 大きな計画 (横 1 万 px など) も全体表示できるように
      maxZoom={2}
      proOptions={{ hideAttribution: false }}
    >
      <Background variant={BackgroundVariant.Lines} gap={32} lineWidth={1} color="var(--bg-grid)" />
      <Controls showInteractive={false} position="bottom-left" fitViewOptions={FIT_OPTIONS} />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={(n) => {
          if (n.type === "terminal") return "var(--primary)";
          const s = project.blocks[n.id]?.status;
          return s === "white" ? "var(--box-white-bg)" : s === "gray" ? "var(--box-gray-bg)" : "var(--box-black-bg)";
        }}
        nodeStrokeColor="var(--line)"
        maskColor="rgba(127,127,127,0.15)"
      />
    </ReactFlow>
  );
}
