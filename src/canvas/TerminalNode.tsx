/**
 * 最上位の入力ノード (左端) / 出力ノード (右端)
 * 入力ノードの各ポートは「中へ流す」ので source ハンドル (右側)、出力ノードは target ハンドル (左側)
 */
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { memo, useMemo, useEffect } from "react";
import { inputGroupsOf, portsOf, rootInputsOf } from "../model/graph";
import { ROOT_ID } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { handleId, rowY, type TerminalRFNode } from "./layout";
import { t, useLang } from "../i18n";

export const TerminalNode = memo(function TerminalNode({ id, data, selected, height, width }: NodeProps<TerminalRFNode>) {
  useLang(); // 言語が変わったら文言を描き直す
  const which = data.which;
  const vertical = data.vertical;
  const update = useUpdateNodeInternals();
  useEffect(() => { update(id); }, [id, width, height, vertical, update]);
  const groupId = data.groupId ?? null;
  const scopeId = data.scopeId ?? null; // タブで開いた大項目のボックスの入出力を表すとき
  const canEdit = useProjectStore((s) => !s.readonly && s.editMode);
  // プロジェクト本体だけを取り、表示用の配列は useMemo で導く (セレクタで新しい配列を返すと無限ループになる)
  const project = useProjectStore((s) => s.project)!;
  const ports = useMemo(
    () => (scopeId ? portsOf(project, scopeId, which) : which === "in" ? rootInputsOf(project, groupId) : portsOf(project, ROOT_ID, "out")).map((q) => ({ id: q.id, name: q.name, promoted: !!q.promotedFrom, hasArtifact: q.artifacts.length > 0 }))
  , [project, which, groupId, scopeId]
  );
  const groupName = groupId ? inputGroupsOf(project).find((g) => g.id === groupId)?.name ?? "" : null;

  // onClick: 丸 (ハンドル) を押したクリックはノードの選択に伝えない (丸を押すだけで詳細パネルが開いて図がずれるのを防ぐ。BlockNode と同じ)。
  // 丸は Edit モードのときだけ結線できる (isConnectable = canEdit)
  return (
    <div className={`bg-terminal ${selected ? "selected" : ""} ${vertical ? "vertical-terminal" : ""}`} style={{ height, ...(vertical ? {width} : {}) }} onClick={(ev) => { if ((ev.target as HTMLElement).closest(".react-flow__handle")) ev.stopPropagation(); }}>
      <div className="bg-terminal__head">
        <span className="truncate" title={groupName ?? undefined}>{which === "in" ? (groupName ?? "Inputs") : "Outputs"}</span>
      </div>
      {ports.length === 0 && <div className="bg-terminal__empty">{which === "in" ? (scopeId ? "No inputs" : groupId ? t("空のグループ (右のパネルで入力を入れる)") : t("供給元のない入力がここに上がります")) : "No outputs"}</div>}
      <div className={vertical ? "vertical-terminal__ports" : undefined}>
      {ports.map((q) => (
        <div key={q.id} className={`bg-terminal__row ${q.promoted ? "promoted" : ""}`} title={q.promoted ? t("下の階層の未接続の入力 (自動)") : q.name}>
          {q.hasArtifact ? "● " : ""}{q.name}
        </div>
      ))}
      </div>
      {ports.map((q, i) => (
        <Handle
          key={q.id}
          type={which === "in" ? "source" : "target"}
          position={vertical ? (which === "in" ? Position.Bottom : Position.Top) : which === "in" ? Position.Right : Position.Left}
          id={handleId(which, q.id, "inner")}
          title={q.name}
          className={`${which === "in" ? "port-out" : ""} ${q.promoted ? "port-promoted" : ""}`}
          style={vertical ? {left:(which === "in" ? vertical.outputs : vertical.inputs).find(p=>p.id===q.id)?.x,top:which === "in" ? height : 0,bottom:"auto",right:"auto",transform:"translate(-50%, -50%)"} : { top: rowY(i) }}
          isConnectable={canEdit}
          onMouseDown={(ev) => ev.preventDefault()}
        />
      ))}
    </div>
  );
});
