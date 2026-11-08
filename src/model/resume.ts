/**
 * 再開時は現在の状態を先に示し、完了済みの引き継ぎは履歴として扱う。
 * 一覧を読むことは回答の確認にも、作業の開始にもならない。
 */
import { answeredUnacked, summarize } from "./graph";
import { candidateGroups, descriptionReminder, freshnessText, noteFreshness } from "./workflow";
import { lint, lintCounts } from "./lint";
import type { Project } from "./types";
import { t } from "../i18n/core";

/** AI が読む resume (CLI・MCP・hooks) で、作業中・確認待ちでない箱の引き継ぎを何件まで出すか */
export const RESUME_HANDOFF_LIMIT = 5;

/**
 * Input : 計画、完了済みメモの展開指定、handoffLimit = 作業中・確認待ちでない箱の引き継ぎを何件まで出すか (省略 = 全部。画面は全部を出す)
 * Output: 現況→候補→引き継ぎの読み取り専用データ。omittedHandoffCount = 上限で省いた引き継ぎの数
 * 上限を付けるのは AI が読む CLI の resume・MCP・hooks。引き継ぎは未完了の箱の分が全部たまるので、大きい計画では 60KB を超えた (2026-11-08、79 件)。
 * 作業中・確認待ちの箱の引き継ぎは、件数に関係なく全部出す (続きに要るのはそれ)
 */
export function resumeSummary(project: Project, options: { includeCompleted?: boolean; handoffLimit?: number } = {}) {
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
  const open = all.filter(h => h.status !== "white" || options.includeCompleted);
  // 上限: 作業中・確認待ちの箱の分は全部、ほかは新しい順に handoffLimit 件まで (並びは新しい順のまま)
  const activeIds = new Set([...s.working, ...s.blocked].map(x => x.block.id));
  const others = open.filter(h => !activeIds.has(h.blockId));
  const keep = options.handoffLimit === undefined ? null : new Set([...open.filter(h => activeIds.has(h.blockId)), ...others.slice(0, Math.max(0, options.handoffLimit))].map(h => h.blockId));
  const shownHandoffs = keep ? open.filter(h => keep.has(h.blockId)) : open;
  return {
    project: project.name,
    focus: project.focusBlockId ? { blockId: project.focusBlockId, title: project.blocks[project.focusBlockId]?.title } : undefined,
    active: [...s.working, ...s.blocked].map(({ block, actor, note }) => ({ blockId: block.id, key: block.key, title: block.title, actor, note })),
    pendingDecisions: s.decisions.map(({ block, decision }) => ({ key: block.key, title: block.title, question: decision.question })),
    unreadAnswers: s.answered.map(({ block, decision }) => ({ blockId: block.id, key: block.key, title: block.title, question: decision.question, answer: decision.answer, answeredAt: decision.answeredAt })),
    nextGroups,
    // 既存の利用側が next を参照していても読めるよう、平らな一覧も残す。
    next: nextGroups.flatMap(g => g.items),
    handoffs: shownHandoffs,
    omittedHandoffCount: open.length - shownHandoffs.length,
    completedHandoffCount: all.filter(h => h.status === "white").length,
    descriptionReminders: Object.values(project.blocks).filter(b => descriptionReminder(b)).map(b => ({ blockId: b.id, key: b.key, title: b.title, message: descriptionReminder(b), writtenAt: b.descriptionUpdatedAt })),
    // 検査の件数 (必ず直す / 見直し候補)。中身は boxglow lint で読む
    lint: lintCounts(lint(project)),
    instructions: t("作業の前に boxglow context <block> を読み、guard 付きの変更にはその contextToken を使ってください。この概要は回答を確認済みにせず、操作を許可するものでもありません。"),
  };
}

/** Input: 計画、完了済みメモの展開指定、handoffLimit (resumeSummary と同じ) / Output: 現況を先頭に置いた Markdown。 */
export function resumeReport(project: Project, options: { includeCompleted?: boolean; handoffLimit?: number } = {}): string {
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
    ...s.nextGroups.flatMap(g => ["### " + g.title, ...g.items.map(a => "- " + a.key + " " + a.title
      + (a.unprepared.length ? " — " + t("要具体化: {reasons}", { reasons: a.unprepared.join("; ") }) : "")
      + (a.missingInputs.length ? " — " + t("必須の入力待ち: {names}", { names: a.missingInputs.join(", ") }) : ""))]),
    "## " + t("引き継ぎ（新しい順）"),
    ...s.handoffs.map(h => "- " + h.key + " " + h.title + " (" + h.actor + ", " + (h.status === "white" ? "Done" : h.status === "gray" ? "In Progress" : "New") + ")\n  " + h.freshnessText + "\n" + h.note),
    ...(s.omittedHandoffCount ? [t("ほかの箱の引き継ぎ {n} 件は省きました。全部は resume --all、1 件は context <箱> で読めます。", { n: s.omittedHandoffCount })] : []),
    ...(!options.includeCompleted && s.completedHandoffCount ? [t("完了済みの引き継ぎ {n} 件。resume --include-completed で表示できます。", { n: s.completedHandoffCount })] : []),
    ...(s.descriptionReminders.length ? [t("説明の見直し候補: {names} (show で確認)", { names: s.descriptionReminders.map(x => x.key ?? x.title).join(", ") })] : []),
    ...(s.lint.errors || s.lint.later || s.lint.reviews ? [t("検査: 必ず直す {errors} 件 / 着手の前に {later} 件 / 見直し候補 {reviews} 件 (boxglow lint で確認)", s.lint)] : []),
    "", s.instructions,
  ].join("\n");
}

/**
 * 文脈が圧縮された直後に差し込む、短い再開の情報 (hook session-start の source = "compact")
 * 全体の再開の概要 (resumeReport) は大きい計画で 10KB を超え、Codex は hooks が文脈に入れる文章を 1 回あたり約 2,500 トークンで切る。
 * 概要の最後にある引き継ぎが切れないよう、圧縮の後は「このセッションで作業中の箱」の続きに要るものだけにする (全体は resume で読む)
 * Input : project = 計画, blockIds = このセッションで作業中の箱の id, counts = 圧縮の回数 (session = このセッション、boxes = 箱ごと),
 *         bigAfter = 箱が大きすぎると案内する回数 (この回数以上の圧縮をまたいだ箱)
 * Output: Markdown (箱ごとに: 作業の内容・圧縮をまたいだ回数・引き継ぎメモ・届いた回答。大きすぎる箱には分け方の案内)
 */
export function compactionReport(project: Project, blockIds: string[], counts: { session: number; boxes: Record<string, number> }, bigAfter: number): string {
  const answers = answeredUnacked(project);
  const lines = ["# " + project.name + " — " + t("圧縮の後の再開"), t("このセッションの文脈の圧縮: {count} 回目", { count: counts.session }), "## " + t("このセッションで作業中の箱")];
  for (const id of blockIds) {
    const b = project.blocks[id];
    if (!b) continue;
    const crossed = counts.boxes[id] ?? 0;
    lines.push(`- ${b.key ?? ""} ${b.title}${b.activity?.note ? ": " + b.activity.note : ""}`);
    lines.push("  " + t("圧縮をまたいだ回数: {count}", { count: crossed }));
    const handoff = project.handoffs?.[id];
    // 引き継ぎメモは全文 (圧縮で失った細部を補うのに一番要る)。無ければ残し方を案内する
    if (handoff?.note.trim()) lines.push("  " + t("引き継ぎ") + " (" + freshnessText(b, handoff.at) + "):", handoff.note);
    else lines.push("  " + t("引き継ぎメモがまだありません。区切りで boxglow checkpoint <箱> --note \"分かったこと; 次にすること; 未解決のこと\" を残すと、次の圧縮や新しいセッションで調べ直さずに済みます"));
    for (const a of answers.filter((x) => x.block.id === id)) lines.push("  " + t("届いた回答: {question} → {answer}", { question: a.decision.question, answer: a.decision.answer ?? "" }));
    if (crossed >= bigAfter) lines.push("  " + t("この箱は圧縮を {count} 回またいでいて、1 つのセッションに収まっていません。引き継ぎメモを更新し、残りの工程を split で別の箱に分けると、次は短い文脈で始められます", { count: crossed }));
  }
  lines.push("", t("判断待ち・次の候補・ほかの箱の引き継ぎは boxglow resume、箱の詳細は boxglow context <箱> --brief で読む。"));
  return lines.join("\n");
}
