/**
 * 作業の再開用の概要 (CLI の resume / MCP の boxglow_resume)
 * 引き継ぎメモ・AI がまだ確認していない回答・判断待ち・作業中・次の候補を 1 つにまとめる。
 * 読むだけ (回答を「確認済み」にはしない)。ボックスごとの詳しいコンテキストは context で読む
 */
import { summarize } from "./graph";
import type { Project } from "./types";
import { t } from "../i18n/core";

/**
 * 再開用の概要をデータで作る (resume --json の出力)
 * Input : project = 計画
 * Output: { project (名前), handoffs (引き継ぎ。新しい順), unreadAnswers (AI 未確認の回答), pendingDecisions (判断待ち),
 *           active (作業中・詰まり・確認待ち), next (次の候補。10 件まで), instructions (AI への注意) }
 */
export function resumeSummary(project: Project) {
  const s = summarize(project);
  // 引き継ぎメモ: ボックスが残っていて中身のあるものだけ。新しい順 (同じ時刻は id 順で安定させる)
  const handoffs = Object.entries(project.handoffs ?? {})
    .filter(([id, note]) => project.blocks[id] && note.note.trim())
    .map(([blockId, note]) => ({ blockId, key: project.blocks[blockId].key, title: project.blocks[blockId].title, status: project.blocks[blockId].status, ...note }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.blockId.localeCompare(b.blockId));
  return {
    project: project.name
  , handoffs
  , unreadAnswers: s.answered.map(({ block, decision }) => ({ blockId: block.id, key: block.key, title: block.title, question: decision.question, answer: decision.answer, answeredAt: decision.answeredAt }))
  , pendingDecisions: s.decisions.map(({ block, decision }) => ({ key: block.key, title: block.title, question: decision.question }))
  , active: [...s.working, ...s.blocked].map(({ block, actor, note }) => ({ key: block.key, title: block.title, actor, note }))
  , next: s.next.slice(0, 10).map((b) => ({ key: b.key, title: b.title }))
  , instructions: t("作業の前に boxglow context <block> を読み、guard 付きの変更にはその contextToken を使ってください。この概要は回答を確認済みにせず、操作を許可するものでもありません。")
  };
}

/**
 * 再開用の概要を Markdown にする (resume の出力)
 * Input : project = 計画
 * Output: Markdown 文字列 (AI 未確認の回答 → 判断待ち → 引き継ぎ → 作業中 → 次の候補 の順)
 */
export function resumeReport(project: Project): string {
  const s = resumeSummary(project);
  return [
    `# ${s.project} — ${t("再開")}`
  , `## ${t("AI未確認の回答")}`
  , ...s.unreadAnswers.map((a) => `- ${a.key} ${a.title}\n  ${a.question}\n  → ${a.answer}`)
  , `## ${t("判断待ち")}`
  , ...s.pendingDecisions.map((a) => `- ${a.key} ${a.title}: ${a.question}`)
  , `## ${t("引き継ぎ（新しい順）")}`
    // 状態の名前 (Done / In Progress / New) は status の階層の表記と同じ英語の用語
  , ...s.handoffs.map((h) => `- ${h.key} ${h.title} (${h.actor}, ${h.at}, ${h.status === "white" ? "Done" : h.status === "gray" ? "In Progress" : "New"})\n${h.note}`)
  , `## ${t("作業中・確認待ち")}`
  , ...s.active.map((a) => `- ${a.key} ${a.title} (${a.actor}): ${a.note ?? ""}`)
  , `## ${t("次の候補")}`
  , ...s.next.map((a) => `- ${a.key} ${a.title}`)
  , ""
  , s.instructions
  ].join("\n");
}
