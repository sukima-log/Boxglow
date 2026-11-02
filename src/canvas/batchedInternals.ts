/**
 * ノードの丸の位置の測り直し (React Flow の updateNodeInternals) を、1 フレームに 1 回にまとめて頼む
 *   React Flow の useUpdateNodeInternals は、頼まれるたびに次のフレームの処理を 1 つずつ予約し、それぞれ別々に状態を更新する。
 *   箱の部品はそれぞれ自分の分を頼むので、箱が 1000 ある図では 1 フレームに 1000 回の更新が起き、そのたびに線の経路を計算し直していた
 *   (Edit への切り替えで経路計算が 366 回走り、2 分以上かかった。2026-11-03 計測)。
 *   ここでは頼まれたノードを集めて、次のフレームで 1 回の updateNodeInternals にまとめる。測る中身とフレームは React Flow の hook と同じ
 */
import { useCallback } from "react";
import { useStoreApi } from "@xyflow/react";

/** React Flow の状態 (store) ごとの、次のフレームで測り直すノードの id */
const pending = new WeakMap<object, Set<string>>();

/**
 * ノードの丸の位置の測り直しを頼む関数を返す (useUpdateNodeInternals の代わり)
 * Output: (id または id の配列) => void。次のフレームで、それまでに頼まれた全部のノードを 1 回で測り直す
 */
export function useBatchedUpdateNodeInternals(): (id: string | string[]) => void {
  const store = useStoreApi();
  return useCallback((id: string | string[]) => {
    let ids = pending.get(store);
    if (!ids) {
      ids = new Set();
      pending.set(store, ids);
      const queued = ids;
      requestAnimationFrame(() => {
        pending.delete(store);
        const { domNode, updateNodeInternals } = store.getState();
        // 測る要素は測るときに探す (頼んだ後に消えたノードは測らない)
        const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
        for (const nodeId of queued) {
          const nodeElement = domNode?.querySelector<HTMLDivElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
          if (nodeElement) updates.set(nodeId, { id: nodeId, nodeElement, force: true });
        }
        if (updates.size > 0) updateNodeInternals(updates, { triggerFitView: false });
      });
    }
    for (const x of Array.isArray(id) ? id : [id]) ids.add(x);
  }, [store]);
}
