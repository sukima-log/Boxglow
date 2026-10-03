/**
 * 書き出し: AI に渡す Markdown と、図を共有する Mermaid
 */
import { categoryOf } from "./categories";
import { ROOT_ID, type Block, type Port, type Project } from "./types";
import { t } from "../i18n/core";
import { candidatesOf, ancestorsOf, childrenOf, computeProgress, effectiveDescription, incomingEdges, outgoingEdges, portsOf } from "./graph";

/** 状態の日本語ラベル (定数は日本語のまま。読み込み時に言語は決まっていないので、使う側で t() に包む) */
export const STATUS_LABEL: Record<Block["status"], string> = {
  black: "New (BlackBox: 出力だけ決めてある)"
, gray: "In Progress (GrayBox: 分解中・作業中)"
, white: "Done (WhiteBox: 出力に成果物が付いて完了)"
};

/** ポート 1 つを Markdown の 1 行にする */
function portLine(p: Project, port: Port): string {
  const parts = [`- **${port.name}**`];
  const desc = effectiveDescription(p, port.id);
  if (desc) parts.push(`: ${desc}`);
  if (port.direction === "in" && !port.required) parts.push(" " + t("(任意)"));
  if (port.artifacts.length > 0) {
    parts.push(" / " + port.artifacts.map((a) => (a.url ? `[${a.title}](${a.url})` : a.title)).join(", "));
  }
  // つながっている先 (入力なら供給元、出力なら行き先)
  const links = port.direction === "in"
    ? incomingEdges(p, { portId: port.id, side: "outer" }).map((e) => describeEndpointSource(p, e.from.portId))
    : outgoingEdges(p, { portId: port.id, side: "outer" }).map((e) => describeEndpointTarget(p, e.to.portId));
  // 記号の矢印 (<- 等) は HTML に貼ったとき誤読される恐れがあるので、言葉で書く
  if (links.length > 0) parts.push(` (${port.direction === "in" ? t("供給元: {list}", { list: links.join(", ") }) : t("行き先: {list}", { list: links.join(", ") })})`);
  return parts.join("");
}

/** 線の出所 (ポート id) を「ブロック名.ポート名」で表す */
function describeEndpointSource(p: Project, portId: string): string {
  const port = p.ports[portId];
  if (!port) return "?";
  const block = p.blocks[port.blockId];
  const name = block?.id === ROOT_ID ? t("プロジェクトの入力") : block?.title ?? "?";
  return `${name}.${port.name}`;
}

/** 線の行き先 (ポート id) を「ブロック名.ポート名」で表す */
function describeEndpointTarget(p: Project, portId: string): string {
  const port = p.ports[portId];
  if (!port) return "?";
  const block = p.blocks[port.blockId];
  const name = block?.id === ROOT_ID ? t("プロジェクトの出力") : block?.title ?? "?";
  return `${name}.${port.name}`;
}

/**
 * ブロック 1 つの説明 (見出しレベル付き)
 * Input : blockId, level = 見出しの深さ (2 から), withChildren = 子孫も再帰的に書くか
 * Output: Markdown
 */
function blockSection(p: Project, blockId: string, level: number, withChildren: boolean): string {
  const b = p.blocks[blockId];
  if (!b) return "";
  const h = "#".repeat(Math.min(level, 6));
  const lines: string[] = [];
  lines.push(`${h} ${b.id === ROOT_ID ? t("プロジェクト: {name}", { name: p.name }) : `${b.key ? b.key + " " : ""}${b.title}`}`);
  lines.push("");
  if (b.id !== ROOT_ID) {
    lines.push(`- ${t("状態: {status}", { status: t(STATUS_LABEL[b.status]) })}`);
    const cat = categoryOf(b.category);
    if (cat) lines.push(`- ${t("カテゴリ: {label}", { label: t(cat.label) })}`);
    const names = b.assigneeIds.map((id) => p.members.find((m) => m.id === id)?.name).filter(Boolean);
    if (names.length > 0) lines.push(`- ${t("担当: {names}", { names: names.join(", ") })}`);
    const prog = computeProgress(p, b.id);
    if (childrenOf(p, b.id).length > 0) lines.push(`- ${t("進捗: 下の階層 {white}/{total} が完了", { white: prog.white, total: prog.total })}`);
  }
  // 判断 (選んだもの・残した候補・以前の答え) は方針転換の材料なので書き出しにも残す
  if (b.id !== ROOT_ID && b.decisions.length > 0) {
    lines.push(`- ${t("判断:")}`);
    for (const d of b.decisions) {
      const c = candidatesOf(d);
      lines.push(`  - ${d.question}${d.answer !== undefined ? ` → ${d.answer}` : " " + t("(未回答)")}${c.rejected.length ? t("。残した候補: {list}", { list: c.rejected.join(" / ") }) : ""}${(d.history ?? []).length ? t("。以前の答え: {list}", { list: d.history!.map((h) => h.answer).join(" → ") }) : ""}`);
    }
  }
  if (b.description) {
    lines.push("");
    lines.push(b.description);
  }
  const ins = portsOf(p, b.id, "in");
  const outs = portsOf(p, b.id, "out");
  lines.push("");
  lines.push(`**${t("入力")}** (${ins.length === 0 ? t("なし") : t("{n} 件", { n: ins.length })})`);
  for (const q of ins) lines.push(portLine(p, q));
  lines.push("");
  lines.push(`**${t("出力")}** (${t("{n} 件", { n: outs.length })})`);
  for (const q of outs) lines.push(portLine(p, q));
  if (b.artifacts.length > 0) {
    lines.push("");
    lines.push(`**${t("関連資料")}**`);
    for (const a of b.artifacts) lines.push(`- ${a.url ? `[${a.title}](${a.url})` : a.title}${a.note ? `: ${a.note}` : ""}`);
  }
  lines.push("");
  if (withChildren) {
    for (const c of childrenOf(p, b.id)) lines.push(blockSection(p, c.id, level + 1, true));
  }
  return lines.join("\n");
}

/**
 * プロジェクト全体を Markdown にする (資料として、または AI への全体説明として)
 * Output: Markdown 文字列
 */
export function projectToMarkdown(p: Project): string {
  const prog = computeProgress(p, ROOT_ID);
  const head = [
    `# ${p.name}`
  , ""
  , p.description
  , ""
  , t("全体の進捗: {white}/{total} ブロックが完了 (BlackBox {black} / GrayBox {gray} / WhiteBox {white})", { white: prog.white, total: prog.total, black: prog.black, gray: prog.gray })
  , ""
  , t("ブロックは「入力から出力を作るタスク」。BlackBox は出力だけ決まっていて中身が未定、GrayBox は分解中・着手中、WhiteBox は完了。")
  , ""
  ].join("\n");
  return head + blockSection(p, ROOT_ID, 2, true);
}

/**
 * 1 つのブロックを AI に渡すための文脈つき Markdown
 * (上の階層での位置づけ、兄弟との関係、本人の入出力、子の一覧、定型の依頼文)
 * Input : blockId, ask = 依頼の種類
 * Output: Markdown 文字列
 */
export function blockToPrompt(p: Project, blockId: string, ask: "plan" | "decompose" | "review"): string {
  const b = p.blocks[blockId];
  if (!b) return "";
  const chain = [...ancestorsOf(p, blockId)].reverse().map((a) => (a.id === ROOT_ID ? p.name : a.title));
  const lines: string[] = [];
  lines.push(`# ${t("依頼: {title}", { title: b.title })}`);
  lines.push("");
  lines.push(t("このタスクは「{chain}」の中の 1 ブロックです。ブロックは「入力から出力を作る作業」で、出力の成果物が確定したら完了 (WhiteBox) になります。", { chain: chain.join(" > ") }));
  lines.push("");
  lines.push(blockSection(p, blockId, 2, false));
  const siblings = childrenOf(p, b.parentId ?? ROOT_ID).filter((s) => s.id !== blockId);
  if (siblings.length > 0) {
    lines.push("## " + t("同じ階層の他のブロック"));
    lines.push("");
    for (const s of siblings) lines.push(`- ${s.title} (${t(STATUS_LABEL[s.status])})`);
    lines.push("");
  }
  const kids = childrenOf(p, blockId);
  if (kids.length > 0) {
    lines.push("## " + t("現在の下の階層"));
    lines.push("");
    for (const k of kids) lines.push(`- ${k.title} (${t(STATUS_LABEL[k.status])})`);
    lines.push("");
  }
  lines.push("## " + t("お願い"));
  lines.push("");
  if (ask === "plan") {
    lines.push(t("上の入力から出力を得るための手順を提案してください。前提が足りなければ、追加で必要な入力を挙げてください。"));
  } else if (ask === "decompose") {
    lines.push(t("このブロックを、入力と出力を持つ小さなブロックに分解してください。次の JSON 形式で答えてください。"));
    lines.push("");
    lines.push("```json");
    // JSON の例の値 (名前の見本) も今の言語で出す。キー (blocks / title など) は固定
    const bn = t("ブロック名");
    lines.push(JSON.stringify({ blocks: [{ title: bn, description: t("やること"), inputs: [t("入力名")], outputs: [t("出力名")] }], connections: [{ from: `${bn}.${t("出力名")}`, to: `${bn}.${t("入力名")}` }] }, null, 2));
    lines.push("```");
  } else {
    lines.push(t("入力と出力の定義に抜けや曖昧さがないか指摘してください。出力が「確定した」と言える条件も提案してください。"));
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * ある階層のブロック図を Mermaid (flowchart LR) にする
 * Input : scopeId = 階層のブロック id (ROOT_ID なら最上位)
 * Output: Mermaid のコード
 */
export function scopeToMermaid(p: Project, scopeId: string): string {
  const kids = childrenOf(p, scopeId);
  const lines = ["flowchart LR"];
  const esc = (s: string) => s.replace(/"/g, "'");
  lines.push(`  IN(["${t("入力")}"])`);
  lines.push(`  OUT(["${t("出力")}"])`);
  for (const k of kids) {
    const shape = k.status === "white" ? `["${esc(k.title)}"]` : k.status === "gray" ? `[["${esc(k.title)}"]]` : `{{"${esc(k.title)}"}}`;
    lines.push(`  ${k.id}${shape}`);
  }
  for (const e of Object.values(p.edges)) {
    const fp = p.ports[e.from.portId];
    const tp = p.ports[e.to.portId];
    if (!fp || !tp) continue;
    const fromNode = fp.blockId === scopeId ? "IN" : kids.some((k) => k.id === fp.blockId) ? fp.blockId : null;
    const toNode = tp.blockId === scopeId ? "OUT" : kids.some((k) => k.id === tp.blockId) ? tp.blockId : null;
    if (!fromNode || !toNode) continue;
    const label = fp.direction === "out" ? fp.name : tp.name;
    lines.push(`  ${fromNode} ${e.auto ? "-.->" : "-->"}|${esc(label)}| ${toNode}`);
  }
  lines.push("  classDef white fill:#fbfbfb,stroke:#3a3f46,color:#2f343a");
  lines.push("  classDef gray fill:#d9dde1,stroke:#3a3f46,color:#2f343a");
  lines.push("  classDef black fill:#3a3f46,stroke:#3a3f46,color:#e8eaed");
  for (const k of kids) lines.push(`  class ${k.id} ${k.status}`);
  return lines.join("\n");
}
