/**
 * 最上位の入力ノード (左端) / 出力ノード (右端)
 * 入力ノードの各ポートは「中へ流す」ので source ハンドル (右側)、出力ノードは target ハンドル (左側)
 */
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, useMemo } from "react";
import { inputGroupsOf, portsOf, rootInputsOf } from "../model/graph";
import { ROOT_ID } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { handleId, rowY, type TerminalRFNode } from "./layout";

export const TerminalNode = memo(function TerminalNode({ data, selected, height }: NodeProps<TerminalRFNode>) {
  const which = data.which;
  const groupId = data.groupId ?? null;
  const scopeId = data.scopeId ?? null; // タブで開いた大項目の箱の入出力を表すとき
  const readonly = useProjectStore((s) => s.readonly);
  // プロジェクト本体だけを取り、表示用の配列は useMemo で導く (セレクタで新しい配列を返すと無限ループになる)
  const project = useProjectStore((s) => s.project)!;
  const ports = useMemo(
    () => (scopeId ? portsOf(project, scopeId, which) : which === "in" ? rootInputsOf(project, groupId) : portsOf(project, ROOT_ID, "out")).map((q) => ({ id: q.id, name: q.name, promoted: !!q.promotedFrom, hasArtifact: q.artifacts.length > 0 }))
  , [project, which, groupId, scopeId]
  );
  const groupName = groupId ? inputGroupsOf(project).find((g) => g.id === groupId)?.name ?? "" : null;

  return (
    <div className={`bg-terminal ${selected ? "selected" : ""}`} style={{ height }}>
      <div className="bg-terminal__head">
        <span className="truncate" title={groupName ?? undefined}>{which === "in" ? (groupName ?? "Inputs") : "Outputs"}</span>
      </div>
      {ports.length === 0 && <div className="bg-terminal__empty">{which === "in" ? (scopeId ? "No inputs" : groupId ? "空のグループ (右のパネルで入力を入れる)" : "供給元のない入力がここに上がります") : "No outputs"}</div>}
      {ports.map((q) => (
        <div key={q.id} className={`bg-terminal__row ${q.promoted ? "promoted" : ""}`} title={q.promoted ? "下の階層の未接続の入力 (自動)" : q.name}>
          {q.hasArtifact ? "● " : ""}{q.name}
        </div>
      ))}
      {ports.map((q, i) => (
        <Handle
          key={q.id}
          type={which === "in" ? "source" : "target"}
          position={which === "in" ? Position.Right : Position.Left}
          id={handleId(which, q.id, "inner")}
          className={`${which === "in" ? "port-out" : ""} ${q.promoted ? "port-promoted" : ""}`}
          style={{ top: rowY(i) }}
          isConnectable={!readonly}
        />
      ))}
    </div>
  );
});
