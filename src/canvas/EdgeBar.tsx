/**
 * 線を選んだときに図の上部に出す帯 (右の詳細パネルの代わり)
 * どこからどこへの線か、確定済みか入力待ちかを 1 行で出す。Edit のときだけ「接続を外す」を出す (画面から線を外す唯一の方法)
 */
import { Panel } from "@xyflow/react";
import { disconnect, isEdgeReady } from "../model/graph";
import { ROOT_ID } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";

/**
 * 線の帯
 * Input : なし (選んでいる線を store から読む) / Output: 帯の JSX (線を選んでいなければ何も出さない)。ReactFlow の子として置くこと
 */
export function EdgeBar() {
  useLang(); // 言語が変わったら描き直す
  const project = useProjectStore((s) => s.project);
  const edgeId = useProjectStore((s) => s.selection.edgeId);
  const canEdit = useProjectStore((s) => !s.readonly && s.editMode);
  const apply = useProjectStore((s) => s.apply);
  const select = useProjectStore((s) => s.select);
  const e = project && edgeId ? project.edges[edgeId] : undefined;
  if (!project || !e) return null;
  const fp = project.ports[e.from.portId];
  const tp = project.ports[e.to.portId];
  if (!fp || !tp) return null;
  // 箱の名前 (最上位は「プロジェクト」)
  const name = (blockId: string) => (blockId === ROOT_ID ? t("プロジェクト") : project.blocks[blockId]?.title ?? "?");
  const ready = isEdgeReady(project, e);
  return (
    <Panel position="top-center" className="edge-bar" role="status">
      {/* どこから → どこへ (入出力の名前を添える) */}
      <span className="edge-bar__path"><b>{name(fp.blockId)}</b>{t("「{name}」", { name: fp.name })} → <b>{name(tp.blockId)}</b>{t("「{name}」", { name: tp.name })}</span>
      <span className="wire-state" data-ready={ready} title={ready ? t("供給元の完了・成果物、または上流の入力を確認できています。") : t("供給元が未完了で成果物がない、または上流の入力がまだ確定していません。")}>{ready ? t("確定済み") : t("入力待ち")}</span>
      {/* 接続を外す: Edit のときだけ。自動の線は手でつなぐと置き換わるので、外す対象にしない */}
      {canEdit && !e.auto && <button className="btn btn-sm" onClick={() => { select({}); apply((p) => disconnect(p, e.id)); }}>{t("接続を外す")}</button>}
      <button className="btn btn-ghost btn-sm" onClick={() => select({})} title={t("選択を外す (Esc)")} aria-label={t("選択を外す (Esc)")}>×</button>
    </Panel>
  );
}
