/**
 * 人と AI の両方が読める Markdown の報告 (CLI の status / show と、画面のタイムラインで使う)
 */
import { candidateGroups, scopeEntries, freshnessText, descriptionReminder } from "./workflow";
import { categoryOf } from "./categories";
import { ROOT_ID, type Block, type Project } from "./types";
import { candidatesOf, issueKeyOf, childrenOf, computeProgress, effectiveDescription, effectiveProgress, incomingEdges, isOverdue, outgoingEdges, pendingDecisions, portsOf, summarize } from "./graph";
import { t } from "../i18n/core";

/**
 * 題名を引用符で囲む (日本語は「」、英語は "")
 * Input : title = ボックスの題名
 * Output: 今の言語の引用符で囲んだ文字列
 */
const quoted = (title: string): string => t("「{title}」", { title });

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
  if (a.startsWith("human:")) return actor.slice(6) || t("人");
  if (a === "human") return t("人");
  return actor;
}

/** 活動の状態の日本語 (定数は日本語のまま。使う側で t() に包んで今の言語にする) */
export const ACTIVITY_LABEL = { working: "作業中", blocked: "詰まり", needs_decision: "判断待ち", waiting_review: "確認待ち" } as const;

/** 経過時間を短く ("5 分", "2 時間", "3 日") */
export function ago(iso: string, now = Date.now()): string {
  const sec = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  // 画面の言語に合わせる (CLI では常に日本語)
  if (sec < 60) return t("今");
  if (sec < 3600) return t("{n} 分", { n: Math.floor(sec / 60) });
  if (sec < 86400) return t("{n} 時間", { n: Math.floor(sec / 3600) });
  return t("{n} 日", { n: Math.floor(sec / 86400) });
}

/** 「5 分前から」「今」のような文言 */
export function agoText(iso: string): string {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return t("たった今");
  return t("{ago}前から", { ago: ago(iso) });
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
    // 札・注記は呼ばれた時点の言語で出す (日本語のときの出力は変えない)
    const act = b.activity ? `  <- ${actorLabel(b.activity.actor)} ${t(ACTIVITY_LABEL[b.activity.state])}${b.activity.note ? ": " + b.activity.note : ""}` : "";
    const cat = categoryOf(b.category);
    const tag = (cat ? ` [${t(cat.label)}]` : "") + (b.kind === "project" ? ` [${t("プロジェクト")}${b.repo ? ": " + b.repo : ""}]` : b.template ? ` [${t("テンプレート: {name}", { name: b.template.name })}]` : "") + (b.issue ? ` [${issueKeyOf(b.issue)}]` : "");
    const pct = b.status === "white" ? "" : (() => { const v = effectiveProgress(p, b.id); return v > 0 ? ` ${v}%` : ""; })();
    const who = b.assigneeIds.length === 0 && b.kind !== "project" ? " " + t("(未担当)") : "";
    const due = b.dueDate && b.status !== "white" ? ` ${t("期日 {date}", { date: b.dueDate })}${isOverdue(b) ? " " + t("(超過)") : ""}` : "";
    lines.push(`${"  ".repeat(depth)}- ${MARK[b.status]}${pct} ${b.key ?? ""} ${b.title}${tag}${who}${due} -> ${outs}${act}`);
    treeLines(p, b.id, depth + 1, lines);
  }
}

/**
 * 全体の状況を Markdown にする (CLI の status)
 * Output: Markdown 文字列
 */
export function statusReport(p: Project, options: { brief?: boolean } = {}): string {
  const s = summarize(p);
  const lines: string[] = [];
  lines.push(`# ${p.name}`);
  if (p.description) lines.push("", p.description);
  const prog = computeProgress(p, ROOT_ID);
  lines.push("", t("完了 {white} / {total} ・ 進捗 {percent}% (BlackBox {black}, GrayBox {gray}, WhiteBox {white})", { white: s.white, total: s.total, percent: prog.percent, black: s.black, gray: s.gray }));
  const rootOuts = portsOf(p, ROOT_ID, "out").map((o) => o.name + (o.artifacts.length > 0 ? "*" : ""));
  const rootIns = portsOf(p, ROOT_ID, "in").filter((o) => !o.groupId).map((o) => o.name + (o.promotedFrom ? ` (${t("自動")})` : ""));
  lines.push(t("最終成果物: {names}", { names: rootOuts.join(", ") || t("(未設定)") }));
  lines.push(t("プロジェクトの入力: {names}", { names: rootIns.join(", ") || t("(なし)") }));
  for (const gp of p.inputGroups ?? []) {
    const names = portsOf(p, ROOT_ID, "in").filter((o) => o.groupId === gp.id).map((o) => o.name + (o.artifacts.length > 0 ? "*" : ""));
    lines.push("  " + t("入力グループ「{name}」: {names}", { name: gp.name, names: names.join(", ") || t("(空)") }));
  }
  if (s.decisions.length > 0) {
    lines.push("", "## " + t("判断待ち (人間の回答が必要)"));
    for (const { block, decision } of s.decisions) {
      lines.push(`- ${block.key ?? ""} ${quoted(block.title)} ${decision.question}${decision.options.length > 0 ? " " + t("選択肢: {options}", { options: decision.options.join(" / ") }) : ""} (decision: ${decision.id})`);
      if (decision.context) lines.push("  " + t("判断材料: {text}", { text: decision.context.replace(/\n/g, "\n  ") }));
    }
  }
  if (s.answered.length > 0) {
    lines.push("", "## " + t("回答あり (人が答えた判断。読んだら `boxglow ack <block>` で引き取る。そのボックスの start / done などでも引き取られる)"));
    for (const { block, decision } of s.answered) {
      lines.push(`- ${block.key ?? ""} ${quoted(block.title)} ${decision.question} -> ${decision.answer} (${decision.answeredBy ?? ""}, decision: ${decision.id})`);
    }
  }
  if (s.overdue.length > 0) {
    lines.push("", "## " + t("期日超過"));
    for (const b of s.overdue) lines.push(`- ${b.key ?? ""} ${quoted(b.title)} ${t("期日 {date}", { date: b.dueDate ?? "" })}`);
  }
  if (s.working.length > 0) {
    lines.push("", "## " + t("作業中"));
    for (const w of s.working) lines.push(`- ${actorLabel(w.actor)} ${w.block.key ?? ""} ${quoted(w.block.title)} ${w.note} (${agoText(w.since)})`);
  }
  if (s.blocked.length > 0) {
    lines.push("", "## " + t("詰まり・確認待ち"));
    for (const w of s.blocked) lines.push(`- ${actorLabel(w.actor)} ${w.block.key ?? ""} ${quoted(w.block.title)} ${w.note}`);
  }
  if (!options.brief) {
    lines.push("", "## " + t("階層 ([ ] New / [~] In Progress / [x] Done。B 番号はボックスの ID。出力名の * は成果物あり)"));
    treeLines(p, ROOT_ID, 0, lines);
  } else {
    lines.push("", t("階層は省略しています。全体は `boxglow status`、ボックスの詳細は `boxglow show <block>` で確認できます。"));
  }
  if (s.next.length > 0) {
    lines.push("", "## " + t("次の候補 (今回の範囲を優先し、着手できる・入力待ちを区別)"));
    if (p.focusBlockId) lines.push(t("今回の範囲: {title}", { title: p.blocks[p.focusBlockId]?.title ?? "" }));
    for (const group of candidateGroups(p, s.next)) {
      lines.push("### " + group.title);
      for (const item of group.items.slice(0, 10)) lines.push("- " + (item.key ?? "") + " " + item.title + (item.missingInputs.length ? "  " + t("(必須の入力待ち: {names})", { names: item.missingInputs.join(", ") }) : "  " + t("(着手できる)")));
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
  const lines: string[] = [`# ${b.key ?? ""} ${b.title}`, "", `- ${t("状態: {status}", { status: b.status })}${b.status !== "white" ? " " + t("(進捗 {percent}%)", { percent: effectiveProgress(p, blockId) }) : ""}`];
  const cat = categoryOf(b.category);
  if (cat) lines.push(`- ${t("カテゴリ: {label}", { label: t(cat.label) })} (${cat.en})`);
  if (b.issue) lines.push(`- ${t("課題: {key}", { key: issueKeyOf(b.issue) })} <${b.issue}>`);
  if (b.startDate || b.dueDate) lines.push(`- ${t("日程:")} ${b.startDate ? t("開始 {date}", { date: b.startDate }) : ""}${b.startDate && b.dueDate ? " / " : ""}${b.dueDate ? t("期日 {date}", { date: b.dueDate }) + (isOverdue(b) ? " " + t("(超過)") : "") : ""}`);
  if (b.estimateHours !== undefined || b.actualHours !== undefined) lines.push(`- ${t("時間:")} ${b.estimateHours !== undefined ? t("見積 {hours}h", { hours: b.estimateHours }) : ""}${b.estimateHours !== undefined && b.actualHours !== undefined ? " / " : ""}${b.actualHours !== undefined ? t("実績 {hours}h", { hours: b.actualHours }) : ""}`);
  if (b.activity) lines.push(`- ${t("活動:")} ${b.activity.actor} ${t(ACTIVITY_LABEL[b.activity.state])} ${b.activity.note} (${b.activity.since})`);
  for (const item of scopeEntries(b.scope)) lines.push("", "## " + item.label, item.text);
  // 説明の日時は、分かるときだけ出す (日時の記録が無い古い説明に、毎回「不明」と付けない)
  if (b.description) lines.push("", ...[freshnessText(b, b.descriptionUpdatedAt, "known")].filter(Boolean), b.description);
  if (descriptionReminder(b)) lines.push("", descriptionReminder(b));
  if (p.handoffs?.[blockId]) lines.push("", "## " + t("AI への引き継ぎ"), freshnessText(b, p.handoffs[blockId].at), p.handoffs[blockId].note);
  lines.push("", "## " + t("入力"));
  for (const q of portsOf(p, blockId, "in")) {
    const src = incomingEdges(p, { portId: q.id, side: "outer" }).map((e) => `${name(p.ports[e.from.portId].blockId)}.${p.ports[e.from.portId].name}${e.auto ? ` (${t("自動")})` : ""}`);
    const desc = effectiveDescription(p, q.id);
    lines.push(`- ${q.name}${q.required ? "" : " " + t("(任意)")}${desc ? ": " + desc : ""}${src.length ? "  <- " + src.join(", ") : "  <- " + t("(未接続)")}`);
  }
  lines.push("", "## " + t("出力"));
  for (const q of portsOf(p, blockId, "out")) {
    const dst = outgoingEdges(p, { portId: q.id, side: "outer" }).map((e) => `${name(p.ports[e.to.portId].blockId)}.${p.ports[e.to.portId].name}`);
    const arts = q.artifacts.map((a) => (a.url ? `${a.title} <${a.url}>` : a.title));
    lines.push(`- ${q.name}${q.description ? ": " + q.description : ""}${dst.length ? "  -> " + dst.join(", ") : ""}${arts.length ? "  " + t("成果物: {list}", { list: arts.join(", ") }) : ""}`);
  }
  const kids = childrenOf(p, blockId);
  if (kids.length > 0) {
    lines.push("", "## " + t("下の階層"));
    for (const k of kids) lines.push(`- ${MARK[k.status]} ${k.title} (id: ${k.id})`);
  }
  if (b.decisions.length > 0) {
    lines.push("", "## " + t("判断"));
    for (const d of b.decisions) {
      const c = candidatesOf(d);
      lines.push(`- ${d.answer === undefined ? t("[未回答]") : t("[回答済]")} ${d.question}${d.answer !== undefined ? " -> " + d.answer : ""} (decision: ${d.id})`);
      if (d.context) lines.push("  " + t("判断材料: {text}", { text: d.context.replace(/\n/g, "\n  ") }));
      if (c.rejected.length > 0) lines.push("  " + (d.answer === undefined ? t("候補: {list}", { list: c.rejected.join(" / ") }) : t("残した候補: {list}", { list: c.rejected.join(" / ") })));
      for (const h of d.history ?? []) lines.push(`  ${t("以前の答え: {answer}", { answer: h.answer })} (${h.by}${h.note ? t("、") + h.note : ""}) ${h.at}`);
    }
  }
  if (b.artifacts.length > 0) {
    lines.push("", "## " + t("資料"));
    for (const a of b.artifacts) lines.push(`- ${a.url ? `${a.title} <${a.url}>` : a.title}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** ログを新しい順に n 件 */
export function logReport(p: Project, n = 20): string {
  const items = p.log.slice(-n).reverse();
  if (items.length === 0) return t("(ログはまだありません)") + "\n";
  return items.map((e) => `- ${shortTime(e.at)} ${actorLabel(e.actor)} ${e.message}`).join("\n") + "\n";
}

/** pendingDecisions の再公開 (画面側で使う) */
export { pendingDecisions };
