/**
 * 見えない枠: タブで開いた大項目の箱。中の箱の座標の基準 (React Flow の parentId) にするためだけに置く。
 * 経路計算では大きさ 0 として扱う (障害物にも親の縁 (壁) にもならない。入力/出力ノードが枠の外にあるため)
 */
import { memo } from "react";

export const FrameNode = memo(function FrameNode() {
  // React Flow は大きさ 0 のノードを「計測済み」にしないので 1px にする (経路計算では FlowCanvas 側で 0 として扱う)
  return <div style={{ width: 1, height: 1, opacity: 0, pointerEvents: "none" }} />;
});
