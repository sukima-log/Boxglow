/**
 * 着手の前に決めること (右パネルの状態タブ)
 * 要具体化の理由を、読むだけの一覧ではなく「その場で埋められる欄」として出す:
 *   - 予定成果物が未定の出力 → 種類の選択と見当の文字欄 (入出力タブの ▾ の中と同じ値)
 *   - 完了条件が未定 → 完了条件の文字欄 (作業範囲の acceptance と同じ値)
 *   - 出力の担当の未定・重複、出力が無い → 文と、入出力タブへのボタン
 * 埋まるとその行が消え、全部そろえば「✓ Ready」(入力がそろっていれば) になる。見送り中は何も出さない
 */
import { updateBlock } from "../model/graph";
import { reasonText, unpreparedReasons } from "../model/readiness";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { DebouncedText, EXPECT_KINDS, setExpect } from "./parts";
import { t, useLang } from "../i18n";

/**
 * Input : project, blockId, onOpenIo = 入出力タブを開く, onEditScope = 作業範囲の編集を開く
 * Output: 欄の JSX (理由が無ければ null)
 */
export function ReadinessFields({ project, blockId, onOpenIo }: { project: Project; blockId: string; onOpenIo: () => void }) {
  useLang();
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const reasons = unpreparedReasons(project, blockId);
  if (reasons.length === 0) return null;
  const b = project.blocks[blockId];
  return (
    <div className="readiness-fields" title={t("着手の前に、出力の予定成果物 (expect) と完了条件を決めます")}>
      <div className="readiness-fields__head">{t("着手の前に決めること")}</div>
      {reasons.map((r, i) => {
        if (r.kind === "missing-expect") {
          const q = r.port;
          return (
            <div key={i} className="readiness-fields__row">
              <span className="readiness-fields__label">{t("出力「{name}」の予定成果物", { name: q.name })}</span>
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
        }
        if (r.kind === "missing-acceptance") {
          return (
            <div key={i} className="readiness-fields__row">
              <span className="readiness-fields__label">{t("完了条件")}</span>
              <DebouncedText multiline className="input" rows={2} placeholder={t("何をどう確かめれば完了か (例: 配信先の URL でアプリが開く)")} value={b.scope?.acceptance ?? ""} disabled={readonly}
                onCommit={(v) => apply((p) => { const scope = { ...p.blocks[blockId].scope }; if (v.trim()) scope.acceptance = v.trim(); else delete scope.acceptance; return updateBlock(p, blockId, { scope: Object.keys(scope).length ? scope : undefined }); })} />
            </div>
          );
        }
        // 担当の未定・重複、出力が無い: 入出力タブで直す
        return (
          <div key={i} className="readiness-fields__row">
            <button type="button" className="unprepared-list__item" onClick={onOpenIo} title={t("入出力")}>{reasonText(project, r)}</button>
          </div>
        );
      })}
    </div>
  );
}
