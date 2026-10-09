/**
 * 担当の一覧 (表): 図の代わりに、あるメンバーの担当のボックスを表で出す
 * 入口は図の左下の表示の切り替え (横・縦・表) の表の記号。表を出している間も、同じ場所に同じ切り替えを出す。
 * 行を押すと、表を出したまま、右にそのボックスの詳細を開く (図へは横・縦の記号か、閉じるボタンで戻る)
 */
import { CloseButton } from "./CloseButton";
import { useEffect, useMemo, useState } from "react";
import { assignmentRows, compareRows, type AssigneeTarget, type AssignmentRow } from "../model/assignments";
import { STATUS_LABEL } from "../model/status";
import type { Project } from "../model/types";
import { useProjectStore } from "../store/useProjectStore";
import { t, useLang } from "../i18n";
import { ViewSwitch } from "../canvas/CanvasTools";

/** 並べ替えに使う列 (既定は期日の近い順) */
type SortKey = "due" | "key" | "title" | "where" | "assignees" | "status" | "progress" | "estimate" | "inputs" | "decisions";

/** 状態の並び (New → In Progress → Done) */
const STATUS_ORDER = { black: 0, gray: 1, white: 2 } as const;

/**
 * 列ごとの比較 (同じ値なら既定の並び = 期日 → B 番号)
 * Input : key = 列, x / y = 行 / Output: 比較の値 (昇順)
 */
function compareBy(key: SortKey, x: AssignmentRow, y: AssignmentRow): number {
  const diff = (() => {
    switch (key) {
      case "due": return 0; // 既定の並びそのもの
      case "key": return 0;
      case "title": return x.title.localeCompare(y.title);
      case "where": return x.where.localeCompare(y.where);
      case "assignees": return x.assignees.join(", ").localeCompare(y.assignees.join(", "));
      case "status": return STATUS_ORDER[x.status] - STATUS_ORDER[y.status];
      case "progress": return x.progress - y.progress;
      case "estimate": return (x.estimateHours ?? Infinity) - (y.estimateHours ?? Infinity);
      case "inputs": return x.missingInputs.length - y.missingInputs.length;
      case "decisions": return x.pendingDecisions - y.pendingDecisions;
    }
  })();
  return diff || compareRows(x, y);
}

/**
 * 担当の一覧 (表)
 * Input : project = 計画, initial = 最初に出す対象 (メンバー / 未担当)
 * Output: 表の画面 (対象の切り替え、完了済みの表示の切り替え、列の並べ替え、行からボックスへの移動、図に戻るボタン)
 */
export function TaskTable({ project, initial }: { project: Project; initial: AssigneeTarget }) {
  useLang(); // 言語が変わったら描き直す
  const setTaskTable = useProjectStore((s) => s.setTaskTable);
  const select = useProjectStore((s) => s.select);
  const focusBlock = useProjectStore((s) => s.focusBlock);
  const meId = useProjectStore((s) => s.meId);
  // 今選んでいるボックス (右に詳細を出している行を、表の上でも示す)
  const selectedId = useProjectStore((s) => s.selection.blockId);
  // 対象: 選択肢の値は「メンバーの id」か、「全員」を表す "__everyone"、「未担当」を表す "__unassigned"
  const [target, setTarget] = useState<string>("memberId" in initial ? initial.memberId : "everyone" in initial ? "__everyone" : "__unassigned");
  const [includeDone, setIncludeDone] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "due", desc: false });
  // 対象のメンバーが計画から消えた (別の端末や AI の編集) ときは、全員に切り替える
  const member = project.members.find((m) => m.id === target);
  const everyone = !member && target !== "__unassigned";
  const effective: AssigneeTarget = member ? { memberId: member.id } : everyone ? { everyone: true } : { unassigned: true };
  const rows = useMemo(() => {
    const list = assignmentRows(project, effective, { includeDone });
    const sorted = [...list].sort((x, y) => compareBy(sort.key, x, y));
    return sort.desc ? sorted.reverse() : sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, member?.id, everyone, includeDone, sort]);

  // Esc で図に戻る (入力欄で使っているときは除く)。
  // 右に詳細を開いているときは、先に詳細だけを閉じる (画面全体の Esc の処理に任せる)。
  // 画面全体の処理が選択を先に消してしまわないよう、捕捉の段階 (capture) で、選択の有無を先に見る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const sel = useProjectStore.getState().selection;
      if (sel.blockId || sel.edgeId || sel.project || sel.timeline) return;
      setTaskTable(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setTaskTable]);

  // 行を押す: 表を出したまま、そのボックスを選んで右に詳細を開く。
  // 図の側でも見える位置へ寄せておく (後で図に戻ったとき、そのボックスが見えるように。別の大項目の中なら、そのタブを開く)
  const open = (id: string) => {
    select({ blockId: id });
    focusBlock(id);
  };
  // 列の見出しを押す: 同じ列なら昇順と降順を入れ替え、別の列なら昇順から
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }));
  // 見出しのセル (今の並べ替えの向きを矢印で示す)
  const head = (key: SortKey, label: string, className = "") => (
    <th className={className} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" onClick={() => sortBy(key)}>{label}{sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}</button>
    </th>
  );

  return (
    <section className="task-table-view" aria-label="In charge">
      <header className="task-table-view__head">
        <h2>In charge</h2>
        {/* 対象: 自分 (Set as me) を先頭に、他のメンバー、未担当 */}
        <select className="input" aria-label={t("誰の担当")} value={member ? member.id : everyone ? "__everyone" : "__unassigned"} onChange={(e) => setTarget(e.target.value)}>
          <option value="__everyone">{t("全員")}</option>
          {[...project.members].sort((a, b) => Number(b.id === meId) - Number(a.id === meId)).map((m) => (
            <option key={m.id} value={m.id}>{m.id === meId ? t("{name} (自分)", { name: m.name }) : m.name}</option>
          ))}
          <option value="__unassigned">{t("未担当")}</option>
        </select>
        <label className="task-table-view__toggle">
          <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          {t("完了済みも表示")}
        </label>
        <span className="task-table-view__count">{t("{n} 件", { n: rows.length })}</span>
        <span className="ml-auto"><CloseButton onClick={() => setTaskTable(null)} title={t("図に戻る (Esc)")} label={t("図に戻る")} /></span>
      </header>
      {rows.length === 0 ? (
        <p className="task-table-view__empty">{includeDone ? t("担当のボックスはありません") : t("未完了の担当のボックスはありません")}</p>
      ) : (
        <div className="task-table-view__scroll">
          <table className="task-table">
            <thead>
              <tr>
                {head("key", "ID")}
                {head("title", t("題名"))}
                {head("where", t("場所"))}
                {/* 全員のときだけ、誰の担当かの列を出す (1 人を選んでいるときは全部その人なので出さない) */}
                {everyone && head("assignees", t("担当"))}
                {head("status", t("状態"))}
                {head("progress", t("進捗"), "num")}
                {head("due", t("期日"))}
                {head("estimate", t("見積"), "num")}
                {head("inputs", t("入力"))}
                {head("decisions", t("判断待ち"), "num")}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => open(r.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(r.id); }} title={t("右に詳細を開く")} aria-selected={r.id === selectedId} data-selected={r.id === selectedId}>
                  <td><span className="dec-key">{r.key}</span></td>
                  <td className="task-table__title">{r.title}</td>
                  <td className="task-table__where">{r.where}</td>
                  {everyone && <td className="task-table__assignees">{r.assignees.length ? r.assignees.join(", ") : <span className="task-table__none">{t("未担当")}</span>}</td>}
                  <td><span className={`task-table__status ${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  <td className="num">{r.progress}%</td>
                  {/* 期日を過ぎた未完了は、色と言葉で示す (色だけに頼らない) */}
                  <td data-overdue={r.overdue}>{r.dueDate ?? ""}{r.overdue ? ` (${t("期日切れ")})` : ""}</td>
                  <td className="num">{r.estimateHours !== undefined ? `${r.estimateHours}h` : ""}</td>
                  <td title={r.missingInputs.join(", ")}>{r.status === "white" ? "" : r.missingInputs.length ? t("待ち {n}", { n: r.missingInputs.length }) : t("そろった")}</td>
                  <td className="num">{r.pendingDecisions || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* 図の左下と同じ場所に、同じ表示の切り替えを出す (横・縦を押すと図に戻る) */}
      <div className="canvas-tools task-table-view__switch">
        <div className="canvas-tools__buttons"><ViewSwitch /></div>
      </div>
    </section>
  );
}
