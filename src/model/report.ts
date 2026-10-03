/**
 * 人と AI の両方が読める Markdown の報告 (CLI の status / show と、画面のタイムラインで使う)
 */
import { categoryOf } from "./categories";
import { ROOT_ID, type Block, type Project } from "./types";
import { candidatesOf, issueKeyOf, missingRequiredInputs, childrenOf, computeProgress, effectiveDescription, effectiveProgress, incomingEdges, isOverdue, outgoingEdges, pendingDecisions, portsOf, summarize } from "./graph";

/** 状態の記号 (チェックリスト風) */
const MARK: Record<Block["status"], string> = { black: "[ ]", gray: "[~]", white: "[x]" };

/** actor を短い印にする ("claude-code" -> "CC", "codex" -> "CX", "human:太郎" -> "太") */
export function actorLabel(actor: string): string {
  const a = actor.toLowerCase();
  if (a.startsWith("claude")) return "CC";
  if (a.startsWith("codex")) return "CX";
  if (a.startsWith("gemini")) return "GM";
  if (a.startsWith("copilot")) return "CP";
  if (a.startsWith("human:")) return actor.slice(6, 7).toUpperCase() || "H";
  return actor.slice(0, 2).toUpperCase();
}

/** actor の読める名前 ("claude-code" -> "Claude Code", "codex" -> "Codex", "human:太郎" -> "太郎") */
export function actorName(actor: string): string {
  const a = actor.toLowerCase();
  if (a.startsWith("claude")) return "Claude Code";
  if (a.startsWith("codex")) return "Codex";
  if (a.startsWith("gemini")) return "Gemini";
  if (a.startsWith("copilot")) return "Copilot";
  if (a.startsWith("human:")) return actor.slice(6) || "人";
  if (a === "human") return "人";
  return actor;
}

/** 活動の状態の日本語 */
export const ACTIVITY_LABEL = { working: "作業中", blocked: "詰まり", needs_decision: "判断待ち", waiting_review: "確認待ち" } as const;

/** 経過時間を短く ("5 分", "2 時間", "3 日") */
export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "今";
  if (sec < 3600) return `${Math.floor(sec / 60)} 分`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} 時間`;
  return `${Math.floor(sec / 86400)} 日`;
}

/** 「5 分前から」「今」のような文言 */
export function agoText(iso: string): string {
  const a = ago(iso);
  return a === "今" ? "たった今" : `${a}前から`;
}

/** ISO 日時をローカルの "MM-DD HH:mm" にする */
export function shortTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 階層を字下げした一覧にする (id 付き。AI が参照できるように) */
function treeLines(p: Project, parentId: string, depth: number, lines: string[]): void {
  const kids = childrenOf(p, parentId).sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  for (const b of kids) {
    const outs = portsOf(p, b.id, "out").map((o) => o.name + (o.artifacts.length > 0 ? "*" : "")).join(", ");
    const act = b.activity ? `  <- ${actorLabel(b.activity.actor)} ${ACTIVITY_LABEL[b.activity.state]}${b.activity.note ? ": " + b.activity.note : ""}` : "";
    const cat = categoryOf(b.category);
    const tag = (cat ? ` [${cat.label}]` : "") + (b.kind === "project" ? ` [プロジェクト${b.repo ? ": " + b.repo : ""}]` : b.template ? ` [テンプレート: ${b.template.name}]` : "") + (b.issue ? ` [${issueKeyOf(b.issue)}]` : "");
    const pct = b.status === "white" ? "" : (() => { const v = effectiveProgress(p, b.id); return v > 0 ? ` ${v}%` : ""; })();
    const who = b.assigneeIds.length === 0 && b.kind !== "project" ? " (未担当)" : "";
    const due = b.dueDate && b.status !== "white" ? ` 期日 ${b.dueDate}${isOverdue(b) ? " (超過)" : ""}` : "";
    lines.push(`${"  ".repeat(depth)}- ${MARK[b.status]}${pct} ${b.key ?? ""} ${b.title}${tag}${who}${due} -> ${outs}${act}`);
    treeLines(p, b.id, depth + 1, lines);
  }
}

/**
 * 全体の状況を Markdown にする (CLI の status)
 * Output: Markdown 文字列
 */
export function statusReport(p: Project): string {
  const s = summarize(p);
  const lines: string[] = [];
  lines.push(`# ${p.name}`);
  if (p.description) lines.push("", p.description);
  const prog = computeProgress(p, ROOT_ID);
  lines.push("", `完了 ${s.white} / ${s.total} ・ 進捗 ${prog.percent}% (BlackBox ${s.black}, GrayBox ${s.gray}, WhiteBox ${s.white})`);
  const rootOuts = portsOf(p, ROOT_ID, "out").map((o) => o.name + (o.artifacts.length > 0 ? "*" : ""));
  const rootIns = portsOf(p, ROOT_ID, "in").filter((o) => !o.groupId).map((o) => o.name + (o.promotedFrom ? " (自動)" : ""));
  lines.push(`最終成果物: ${rootOuts.join(", ") || "(未設定)"}`);
  lines.push(`プロジェクトの入力: ${rootIns.join(", ") || "(なし)"}`);
  for (const gp of p.inputGroups ?? []) {
    const names = portsOf(p, ROOT_ID, "in").filter((o) => o.groupId === gp.id).map((o) => o.name + (o.artifacts.length > 0 ? "*" : ""));
    lines.push(`  入力グループ「${gp.name}」: ${names.join(", ") || "(空)"}`);
  }
  if (s.decisions.length > 0) {
    lines.push("", "## 判断待ち (人間の回答が必要)");
    for (const { block, decision } of s.decisions) {
      lines.push(`- ${block.key ?? ""} 「${block.title}」 ${decision.question}${decision.options.length > 0 ? " 選択肢: " + decision.options.join(" / ") : ""} (decision: ${decision.id})`);
      if (decision.context) lines.push(`  判断材料: ${decision.context.replace(/\n/g, "\n  ")}`);
    }
  }
  if (s.overdue.length > 0) {
    lines.push("", "## 期日超過");
    for (const b of s.overdue) lines.push(`- ${b.key ?? ""} 「${b.title}」 期日 ${b.dueDate}`);
  }
  if (s.working.length > 0) {
    lines.push("", "## 作業中");
    for (const w of s.working) lines.push(`- ${actorLabel(w.actor)} ${w.block.key ?? ""} 「${w.block.title}」 ${w.note} (${agoText(w.since)})`);
  }
  if (s.blocked.length > 0) {
    lines.push("", "## 詰まり・確認待ち");
    for (const w of s.blocked) lines.push(`- ${actorLabel(w.actor)} ${w.block.key ?? ""} 「${w.block.title}」 ${w.note}`);
  }
  lines.push("", "## 階層 ([ ] New / [~] In Progress / [x] Done。B 番号は箱の ID。出力名の * は成果物あり)");
  treeLines(p, ROOT_ID, 0, lines);
  if (s.next.length > 0) {
    lines.push("", "## 次の候補 (未着手の New。必須の入力がそろっているものから)");
    for (const b of s.next.slice(0, 10)) {
      const missing = missingRequiredInputs(p, b.id);
      lines.push(`- ${b.key ?? ""} ${b.title}${missing.length > 0 ? `  (必須の入力待ち: ${missing.map((q) => q.name).join(", ")})` : "  (着手できる)"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** ブロック 1 つの詳細 (CLI の show) */
export function blockReport(p: Project, blockId: string): string {
  const b = p.blocks[blockId];
  if (!b) return "";
  const name = (id: string) => (id === ROOT_ID ? "project" : p.blocks[id]?.title ?? "?");
  const lines: string[] = [`# ${b.key ?? ""} ${b.title}`, "", `- 状態: ${b.status}${b.status !== "white" ? ` (進捗 ${effectiveProgress(p, blockId)}%)` : ""}`];
  const cat = categoryOf(b.category);
  if (cat) lines.push(`- カテゴリ: ${cat.label} (${cat.en})`);
  if (b.issue) lines.push(`- 課題: ${issueKeyOf(b.issue)} <${b.issue}>`);
  if (b.startDate || b.dueDate) lines.push(`- 日程: ${b.startDate ? "開始 " + b.startDate : ""}${b.startDate && b.dueDate ? " / " : ""}${b.dueDate ? "期日 " + b.dueDate + (isOverdue(b) ? " (超過)" : "") : ""}`);
  if (b.estimateHours !== undefined || b.actualHours !== undefined) lines.push(`- 時間: ${b.estimateHours !== undefined ? "見積 " + b.estimateHours + "h" : ""}${b.estimateHours !== undefined && b.actualHours !== undefined ? " / " : ""}${b.actualHours !== undefined ? "実績 " + b.actualHours + "h" : ""}`);
  if (b.activity) lines.push(`- 活動: ${b.activity.actor} ${ACTIVITY_LABEL[b.activity.state]} ${b.activity.note} (${b.activity.since})`);
  if (b.description) lines.push("", b.description);
  lines.push("", "## 入力");
  for (const q of portsOf(p, blockId, "in")) {
    const src = incomingEdges(p, { portId: q.id, side: "outer" }).map((e) => `${name(p.ports[e.from.portId].blockId)}.${p.ports[e.from.portId].name}${e.auto ? " (自動)" : ""}`);
    const desc = effectiveDescription(p, q.id);
    lines.push(`- ${q.name}${q.required ? "" : " (任意)"}${desc ? ": " + desc : ""}${src.length ? "  <- " + src.join(", ") : "  <- (未接続)"}`);
  }
  lines.push("", "## 出力");
  for (const q of portsOf(p, blockId, "out")) {
    const dst = outgoingEdges(p, { portId: q.id, side: "outer" }).map((e) => `${name(p.ports[e.to.portId].blockId)}.${p.ports[e.to.portId].name}`);
    const arts = q.artifacts.map((a) => (a.url ? `${a.title} <${a.url}>` : a.title));
    lines.push(`- ${q.name}${q.description ? ": " + q.description : ""}${dst.length ? "  -> " + dst.join(", ") : ""}${arts.length ? "  成果物: " + arts.join(", ") : ""}`);
  }
  const kids = childrenOf(p, blockId);
  if (kids.length > 0) {
    lines.push("", "## 下の階層");
    for (const k of kids) lines.push(`- ${MARK[k.status]} ${k.title} (id: ${k.id})`);
  }
  if (b.decisions.length > 0) {
    lines.push("", "## 判断");
    for (const d of b.decisions) {
      const c = candidatesOf(d);
      lines.push(`- ${d.answer === undefined ? "[未回答]" : "[回答済]"} ${d.question}${d.answer !== undefined ? " -> " + d.answer : ""} (decision: ${d.id})`);
      if (d.context) lines.push(`  判断材料: ${d.context.replace(/\n/g, "\n  ")}`);
      if (c.rejected.length > 0) lines.push(`  ${d.answer === undefined ? "候補" : "残した候補"}: ${c.rejected.join(" / ")}`);
      for (const h of d.history ?? []) lines.push(`  以前の答え: ${h.answer} (${h.by}${h.note ? "、" + h.note : ""}) ${h.at}`);
    }
  }
  if (b.artifacts.length > 0) {
    lines.push("", "## 資料");
    for (const a of b.artifacts) lines.push(`- ${a.url ? `${a.title} <${a.url}>` : a.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** ログを新しい順に n 件 */
export function logReport(p: Project, n = 20): string {
  const items = p.log.slice(-n).reverse();
  if (items.length === 0) return "(ログはまだありません)\n";
  return items.map((e) => `- ${shortTime(e.at)} ${actorLabel(e.actor)} ${e.message}`).join("\n") + "\n";
}

/** pendingDecisions の再公開 (画面側で使う) */
export { pendingDecisions };
