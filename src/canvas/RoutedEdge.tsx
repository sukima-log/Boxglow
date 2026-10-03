/**
 * 箱を避ける直角の線 (React Flow のカスタム edge)
 * 経路は FlowCanvas が同じ階層の線をまとめて計算して data.path で渡す (重なりを解くため)
 */
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from "@xyflow/react";
import { memo } from "react";
import { toRoundedPath, type Point } from "./routeEdge";

export const RoutedEdge = memo(function RoutedEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, labelStyle, labelBgStyle, selected, data } = props;
  const hot = !!(data as { hot?: boolean } | undefined)?.hot;
  const net = !!(data as { net?: boolean } | undefined)?.net; // 選んだ線とつながっている線
  const arrow = !!(data as { arrow?: boolean } | undefined)?.arrow; // 入力に入る線は先端に矢印
  const path = ((data as { path?: Point[] } | undefined)?.path) ?? [{ x: sourceX, y: sourceY }, { x: targetX, y: targetY }];
  const d = toRoundedPath(path);
  // 当たり判定 (太い透明の線) は両端の丸にかぶらないよう、端から少し内側までにする
  const trim = (pts: Point[]): Point[] => {
    if (pts.length < 2) return pts;
    const inset = (a: Point, b: Point, len: number): Point => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const k = Math.min(len, dist * 0.6) / dist;
      return { x: a.x + dx * k, y: a.y + dy * k };
    };
    const first = inset(pts[0], pts[1], 14);
    const last = inset(pts[pts.length - 1], pts[pts.length - 2], 14);
    return [first, ...pts.slice(1, -1), last];
  };
  const dHit = toRoundedPath(trim(path));
  // ラベルは一番長い横の区間の中央、線の少し上 (線に重ねない)
  let best = { len: -1, x: (sourceX + targetX) / 2, y: (sourceY + targetY) / 2 };
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (Math.abs(a.y - b.y) < 0.5) {
      const len = Math.abs(b.x - a.x);
      if (len > best.len) best = { len, x: (a.x + b.x) / 2, y: a.y };
    }
  }
  const mid = { x: best.x, y: best.y - 14 };
  // 矢印: 最後の線分の向きに合わせた三角形 (React Flow のマーカーは色を属性で固定するため、テーマや状態 (確定 / 未確定 / 選択) に
  // 合わせられない。自前の path にして CSS で線と同じ色にする)
  let arrowD = "";
  if (arrow && path.length >= 2) {
    const tip = path[path.length - 1];
    const prev = path[path.length - 2];
    const dx = tip.x - prev.x;
    const dy = tip.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const L = 12; // 長さ
    const W = 5;  // 半幅
    const bx = tip.x - ux * L;
    const by = tip.y - uy * L;
    arrowD = `M ${tip.x} ${tip.y} L ${bx - uy * W} ${by + ux * W} L ${bx + uy * W} ${by - ux * W} Z`;
  }

  return (
    <>
      {(selected || hot || net) && <path d={d} className="react-flow__edge-halo" />}
      <BaseEdge id={id} path={d} markerEnd={markerEnd} style={style} interactionWidth={0} />
      {arrowD && <path d={arrowD} className="react-flow__edge-arrow" />}
      <path d={dHit} fill="none" stroke="transparent" strokeWidth={14} className="react-flow__edge-interaction" />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{
              position: "absolute"
            , transform: `translate(-50%, -50%) translate(${mid.x}px, ${mid.y}px)`
            , fontSize: 11
            , padding: "2px 6px"
            , borderRadius: 6
            , background: (labelBgStyle?.fill as string) ?? "var(--bg-card)"
            , border: "1px solid var(--line-soft)"
            , color: (labelStyle?.fill as string) ?? "var(--text)"
            , pointerEvents: "none"
            , opacity: 1
            , zIndex: 1000
            , whiteSpace: "nowrap"
            , boxShadow: "0 1px 2px rgba(0,0,0,0.15)"
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
