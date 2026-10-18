/**
 * 着手の準備 (右パネルの状態タブ)
 * 要具体化の理由を、読むだけの一覧ではなく「その場で埋められる欄」として出す:
 *   - 自身が作る出力の予定成果物 → 種類の選択と見当の文字欄 (入出力タブの ▾ の中と同じ値)
 *   - 完了条件 → 完了条件の文字欄 (作業範囲の acceptance と同じ値)
 *   - 出力の担当の未定・重複、出力が無い → 文と、入出力タブへのボタン
 * 欄は埋まっても消さない (利用者の指摘 2026-10-18: 1 文字打つと行が消えて、何を書いたか・どこに入ったか分からなくなった)。
 * 埋まった行には ✓ を付け、全部そろえば囲いの色を通常に戻して「✓ Ready」にする。各行に保存先 (入出力タブ / 作業範囲) を添える。
 * Ready のまま場所を取り続けないよう、ボックスを選んだときに Ready なら 1 行にたたんでおく (押すと開く)。入力の途中でたたまれることはない (利用者の指摘 2026-10-18)
 */
import { updateBlock } from "../model/graph";
import { outputOwners, reasonText, unpreparedReasons } from "../model/readiness";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { DebouncedText, EXPECT_KINDS, setExpect } from "./parts";
import { useState } from "react";
import { t, useLang } from "../i18n";

/**
 * Input : project, blockId, onOpenIo = 入出力タブを開く
 * Output: 欄の JSX (自身が作る出力も理由も無ければ null)
 */
export function ReadinessFields({ project, blockId, onOpenIo }: { project: Project; blockId: string; onOpenIo: () => void }) {
  useLang();
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const reasons = unpreparedReasons(project, blockId);
  // 自身が作る出力 (予定成果物の欄を出す対象)。埋まっていても出す
  const own = outputOwners(project, blockId).filter((o) => o.owner.kind === "self").map((o) => o.port);
  const ready = reasons.length === 0;
  // 開閉: 選んだ時点で Ready なら閉じて始める (Inspector が blockId ごとに作り直すので、入力中に Ready になっても閉じない)
  const [open, setOpen] = useState(!ready);
  if (reasons.length === 0 && own.length === 0) return null;
  const b = project.blocks[blockId];
  const acceptance = b.scope?.acceptance ?? "";
  // 欄以外の理由 (担当の未定・重複、出力が無い、自身が作る出力が無い): 入出力タブで直す
  const others = reasons.filter((r) => r.kind !== "missing-expect" && r.kind !== "missing-acceptance");
  const Done = () => <span className="readiness-fields__done" aria-label={t("記入済み")}>✓</span>;
  return (
    <details className={`readiness-fields${ready ? " readiness-fields--ready" : ""}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)}
      title={ready ? t("着手の準備ができています (押すと欄を開閉します)") : t("着手の前に、出力の予定成果物 (expect) と完了条件を決めます")}>
      <summary className="readiness-fields__head">{ready ? t("着手の準備 ✓ Ready") : t("着手の前に決めること")}</summary>
      {others.map((r, i) => (
        <div key={`r${i}`} className="readiness-fields__row">
          <button type="button" className="unprepared-list__item" onClick={onOpenIo} title={t("入出力")}>{reasonText(project, r)}</button>
        </div>
      ))}
      {own.map((q) => {
        const filled = !!q.expect?.kind && !!q.expect.hint.trim();
        return (
          <div key={q.id} className="readiness-fields__row">
            <span className="readiness-fields__label">
              {filled && <Done />}{t("出力「{name}」の予定成果物", { name: q.name })}
              {/* 保存先: 入出力タブの、この出力の ▾ の中 (同じ値) */}
              <button type="button" className="readiness-fields__where" onClick={onOpenIo} title={t("入出力タブのこの出力の欄と同じ値です")}>{t("保存先: I/O タブの出力「{name}」の ▾", { name: q.name })}</button>
            </span>
            <span className="readiness-fields__inputs">
              <select className="input input-plain" style={{ width: 96, fontSize: 11 }} aria-label={t("予定成果物の種類")} value={q.expect?.kind ?? ""} disabled={readonly}
                onChange={(e) => apply((p) => setExpect(p, q.id, e.target.value as typeof EXPECT_KINDS[number] | "", q.expect?.hint ?? ""))}>
                <option value="">{t("種類")}</option>
                {EXPECT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <DebouncedText className="input input-plain flex-1" placeholder={t("見当 (例: src/auth/callback.ts、docs/runbook.md)")} value={q.expect?.hint ?? ""} disabled={readonly || !q.expect?.kind}
                onCommit={(v) => apply((p) => setExpect(p, q.id, q.expect?.kind ?? "", v))} />
            </span>
            {/* 種類だけでは足りないことを示す */}
            {q.expect?.kind && !q.expect.hint.trim() && <span className="readiness-fields__note">{t("見当 (パスや題名) も書きます")}</span>}
          </div>
        );
      })}
      {own.length > 0 && (
        <div className="readiness-fields__row">
          <span className="readiness-fields__label">
            {!!acceptance.trim() && <Done />}{t("完了条件")}
            {/* 保存先: I/O タブの出力の下の「完了条件」(作業範囲の編集とも同じ値) */}
            <button type="button" className="readiness-fields__where" onClick={onOpenIo} title={t("I/O タブの出力の下にある完了条件の欄と同じ値です (More の作業範囲でも編集できます)")}>{t("保存先: I/O タブの出力の下")}</button>
          </span>
          <DebouncedText multiline className="input" rows={2} placeholder={t("何をどう確かめれば完了か (例: 配信先の URL でアプリが開く)")} value={acceptance} disabled={readonly}
            onCommit={(v) => apply((p) => { const scope = { ...p.blocks[blockId].scope }; if (v.trim()) scope.acceptance = v.trim(); else delete scope.acceptance; return updateBlock(p, blockId, { scope: Object.keys(scope).length ? scope : undefined }); })} />
        </div>
      )}
    </details>
  );
}
