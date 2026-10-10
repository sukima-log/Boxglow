/**
 * レビューの記録の状態 (右パネルの状態タブ)
 * 分解の記録 (split-ok。子があるボックスだけ) と着手準備の記録 (box-ok) を、なし / 済 / 古い の一語の札で出す。
 * 済なら誰が・いつ (根拠はヒント)、古いなら何が変わったか。人も「確認」で記録できる (根拠は入力欄)。
 * 記録は「評価したと申告し根拠を残した記録」で、妥当性の証明ではない (model/review.ts)
 */
import { useState } from "react";
import { childrenOf, updateBlock } from "../model/graph";
import { boxMaterial, changedText, makeRecord, reviewStatus, reviewable, splitMaterial, staleAdvice } from "../model/review";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { agoText } from "../model/report";
import { t, useLang } from "../i18n";

/**
 * Input : project = 計画, blockId = ボックスの id
 * Output: レビューの行 (対象外 = 最上位・プロジェクトのボックスなら null)
 */
export function ReviewState({ project, blockId }: { project: Project; blockId: string }) {
  useLang();
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const [noteFor, setNoteFor] = useState<"split" | "box" | null>(null);
  const [note, setNote] = useState("");
  if (!reviewable(project, blockId)) return null;
  const b = project.blocks[blockId];
  const rows = [
    ...(childrenOf(project, blockId).length ? [{ kind: "split" as const, label: t("分解"), record: b.splitReview, current: splitMaterial(project, blockId) }] : [])
  , { kind: "box" as const, label: t("着手準備"), record: b.boxReview, current: boxMaterial(project, blockId) }
  ];
  // 記録する (人の確認): 今の材料の署名で記録する
  const record = (kind: "split" | "box") => {
    const m = kind === "split" ? splitMaterial(project, blockId) : boxMaterial(project, blockId);
    const rec = makeRecord("human", note.trim(), m.sig, m.parts);
    apply((p) => updateBlock(p, blockId, kind === "split" ? { splitReview: rec } : { boxReview: rec }));
    setNoteFor(null); setNote("");
  };
  return (
    <div className="review-state text-[12px]">
      {rows.map((r) => {
        const st = reviewStatus(r.record, r.current);
        return (
          <div key={r.kind} className="review-state__row" data-state={st.state}>
            <span className="review-state__label">{t("レビュー")} · {r.label}</span>
            {/* 状態の札: なし / 済 / 古い */}
            <span className={`meta-chip review-${st.state}`} title={r.record ? r.record.note || undefined : undefined}>
              {st.state === "none" ? t("なし") : st.state === "ok" ? t("済") : t("古い")}
            </span>
            {st.state === "ok" && r.record && <span className="review-state__by">{r.record.by} · {agoText(r.record.at)}</span>}
            {/* 古い = 前回の確認後に変わった (不正ではない)。何を確認すればよいかはヒント */}
            {st.state === "stale" && <span className="review-state__changed" title={staleAdvice(project, r.kind, st.changed)}>{t("変わった: {what}", { what: changedText(project, st.changed) })}</span>}
            {!readonly && noteFor !== r.kind && <button className="btn btn-ghost btn-sm" onClick={() => { setNoteFor(r.kind); setNote(""); }} title={t("材料を見て評価したら、根拠を書いて記録します (妥当性の証明ではありません)")}>{t("確認")}</button>}
            {noteFor === r.kind && (
              <span className="review-state__note">
                <input className="input" value={note} placeholder={t("根拠 (何を確認したか)")} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) record(r.kind); if (e.key === "Escape") setNoteFor(null); }} autoFocus />
                <button className="btn btn-primary btn-sm" disabled={!note.trim()} onClick={() => record(r.kind)}>OK</button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
