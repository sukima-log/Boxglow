/**
 * 分岐のボックスの「道を選ぶ」欄 (右パネルの題名の直下)
 * 分岐の問いに答える操作を、状態タブの奥ではなくパネルの先頭に出す。
 * まだ答えていなければ、道 (出力) ごとに「この道にする」ボタンを並べる。押すと判断に答えたことになり、
 * 選んだ道が先へ進み、選ばなかった道は見送りになる (中身は answerDecision。分岐のボックスも完了になる)。
 * 答えた後は、選んだ道に印を付け、見送りの道を薄く出し、「選び直す」(reopenDecision) を置く。
 */
import { answerDecision, portsOf, reopenDecision } from "../model/graph";
import { branchDecision, chosenOption } from "../model/branch";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";

/**
 * 道を選ぶ欄
 * Input : project = 計画, blockId = 分岐のボックスの id
 * Output: 欄の JSX。分岐のボックスでない、または判断が見つからないときは null (何も出さない)
 */
export function BranchPicker({ project, blockId }: { project: Project; blockId: string }) {
  useLang(); // 言語が変わったら描き直す
  const readonly = useProjectStore((s) => s.readonly);
  const apply = useProjectStore((s) => s.apply);
  const b = project.blocks[blockId];
  const d = b ? branchDecision(b) : undefined;
  if (!b?.branch || !d) return null;
  const chosen = chosenOption(b);
  // 答えが選択肢のどれでもない (自由記述) ときは、どの道も選ばれていない扱い。選び直せるようにする
  const answeredOther = d.answer !== undefined && chosen === undefined;
  // 道の一覧: 選択肢の付いた出力を、選択肢の並び順で出す (出力の名前は後から変えられるので、選択肢の文字も添える)
  const paths = portsOf(project, blockId, "out")
    .filter((q) => q.branchOption !== undefined)
    .sort((x, y) => d.options.indexOf(x.branchOption!) - d.options.indexOf(y.branchOption!));

  return (
    <section className="branch-picker" aria-label={t("道を選ぶ")}>
      <div className="branch-picker__head">
        <span className="label">{t("道を選ぶ")}</span>
        {/* 答えた後: 選び直し (方針転換)。前の答えは履歴に残る */}
        {!readonly && d.answer !== undefined && (
          <button className="btn btn-ghost btn-sm" onClick={() => apply((p) => reopenDecision(p, blockId, d.id, "human", ""))}
            title={t("答えを履歴に残して未回答に戻す (見送りの道も元に戻る)")}>{t("選び直す")}</button>
        )}
      </div>
      {/* 問い: 何を決めるのか (題名と同じなら出さない) */}
      {d.question && d.question !== b.title && <p className="branch-picker__question">{d.question}</p>}
      {answeredOther && <p className="branch-picker__note">{t("答え「{answer}」は選択肢のどれでもないため、道はまだ選ばれていません", { answer: d.answer! })}</p>}
      <ul className="branch-picker__list">
        {paths.map((q) => {
          const option = q.branchOption!;
          // 道の状態: 選んだ道 / 見送りの道 / まだ決まっていない
          const state = chosen === undefined ? "open" : chosen === option ? "chosen" : "skipped";
          return (
            <li key={q.id} className="branch-picker__item" data-state={state}>
              <span className="branch-picker__name">
                <span className="branch-picker__mark" aria-hidden="true">{state === "chosen" ? "✓" : "◆"}</span>
                <span className="truncate" title={q.name !== option ? t("{name} (選択肢: {option})", { name: q.name, option }) : q.name}>{q.name}</span>
              </span>
              {state === "chosen" && <span className="meta-chip branch-chosen">{t("選んだ道")}</span>}
              {state === "skipped" && <span className="meta-chip muted">{t("見送り")}</span>}
              {/* まだ決まっていなければ、この道を選ぶボタン (答えると分岐のボックスは完了になる) */}
              {state === "open" && !readonly && d.answer === undefined && (
                <button className="btn btn-sm btn-primary" onClick={() => apply((p) => answerDecision(p, blockId, d.id, option, "human"))}
                  title={t("この道に進む (ほかの道は見送りになり、分岐のボックスは完了になる)")}>{t("この道にする")}</button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
