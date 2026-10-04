/**
 * 再開時は現在の状態を先に示し、完了済みの引き継ぎは履歴として扱う。
 * 一覧を読むことは回答の確認にも、作業の開始にもならない。
 */
import { summarize } from "./graph";
import { candidateGroups, descriptionReminder, freshnessText, noteFreshness } from "./workflow";
import type { Project } from "./types";
import { t } from "../i18n/core";

/** Input: 計画、完了済みメモの展開指定 / Output: 現況→候補→引き継ぎの読み取り専用データ。 */
export function resumeSummary(project: Project, options: { includeCompleted?: boolean } = {}) {
  const s = summarize(project);
  const all = Object.entries(project.handoffs ?? {})
    .filter(([id, note]) => project.blocks[id] && note.note.trim())
    .map(([blockId, note]) => {
      const b = project.blocks[blockId];
      return { blockId, key: b.key, title: b.title, status: b.status, ...note,
        freshness: noteFreshness(b, note.at), freshnessText: freshnessText(b, note.at), statusChangedAt: b.statusChangedAt };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || a.blockId.localeCompare(b.blockId));
  const nextGroups = candidateGroups(project, s.next).map(g => ({ ...g, items: g.items.slice(0, 10) }));
  return {
    project: project.name,
    focus: project.focusBlockId ? { blockId: project.focusBlockId, title: project.blocks[project.focusBlockId]?.title } : undefined,
    active: [...s.working, ...s.blocked].map(({ block, actor, note }) => ({ blockId: block.id, key: block.key, title: block.title, actor, note })),
    pendingDecisions: s.decisions.map(({ block, decision }) => ({ key: block.key, title: block.title, question: decision.question })),
    unreadAnswers: s.answered.map(({ block, decision }) => ({ blockId: block.id, key: block.key, title: block.title, question: decision.question, answer: decision.answer, answeredAt: decision.answeredAt })),
    nextGroups,
    // 既存の利用側が next を参照していても読めるよう、平らな一覧も残す。
    next: nextGroups.flatMap(g => g.items),
    handoffs: all.filter(h => h.status !== "white" || options.includeCompleted),
    completedHandoffCount: all.filter(h => h.status === "white").length,
    descriptionReminders: Object.values(project.blocks).filter(b => descriptionReminder(b)).map(b => ({ blockId: b.id, key: b.key, title: b.title, message: descriptionReminder(b), writtenAt: b.descriptionUpdatedAt })),
    instructions: t("作業の前に boxglow context <block> を読み、guard 付きの変更にはその contextToken を使ってください。この概要は回答を確認済みにせず、操作を許可するものでもありません。"),
  };
}

/** Input: 計画、完了済みメモの展開指定 / Output: 現況を先頭に置いた Markdown。 */
export function resumeReport(project: Project, options: { includeCompleted?: boolean } = {}): string {
  const s = resumeSummary(project, options);
  return [
    "# " + s.project + " — " + t("再開"),
    // 今回の範囲のボックスが完了していたら、候補の優先がもう意味を持たないので、選び直しを促す
    ...(s.focus ? [t("今回の範囲: {title}", { title: s.focus.title ?? "" }) + (project.blocks[s.focus.blockId]?.status === "white" ? " — " + t("完了済みです。focus で次の対象を選ぶか、focus none で解除してください") : "")] : []),
    "## " + t("作業中・確認待ち"),
    ...s.active.map(a => "- " + a.key + " " + a.title + " (" + a.actor + "): " + (a.note ?? "")),
    "## " + t("判断待ち"),
    ...s.pendingDecisions.map(a => "- " + a.key + " " + a.title + ": " + a.question),
    "## " + t("AI未確認の回答"),
    ...s.unreadAnswers.map(a => "- " + a.key + " " + a.title + "\n  " + a.question + "\n  → " + a.answer),
    "## " + t("次の候補"),
    ...s.nextGroups.flatMap(g => ["### " + g.title, ...g.items.map(a => "- " + a.key + " " + a.title + (a.missingInputs.length ? " — " + t("必須の入力待ち: {names}", { names: a.missingInputs.join(", ") }) : ""))]),
    "## " + t("引き継ぎ（新しい順）"),
    ...s.handoffs.map(h => "- " + h.key + " " + h.title + " (" + h.actor + ", " + (h.status === "white" ? "Done" : h.status === "gray" ? "In Progress" : "New") + ")\n  " + h.freshnessText + "\n" + h.note),
    ...(!options.includeCompleted && s.completedHandoffCount ? [t("完了済みの引き継ぎ {n} 件。resume --include-completed で表示できます。", { n: s.completedHandoffCount })] : []),
    ...(s.descriptionReminders.length ? [t("説明の見直し候補: {names} (show で確認)", { names: s.descriptionReminders.map(x => x.key ?? x.title).join(", ") })] : []),
    "", s.instructions,
  ].join("\n");
}
