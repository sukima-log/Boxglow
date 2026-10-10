/**
 * ブロックの大きさ (画面と自動整列で共用。React Flow に依存しない)
 */
import { categoryOf } from "./categories";
import type { Project, Port } from "./types";
import { missingRequiredInputs, childrenOf, portsOf, incomingEdges, outgoingEdges } from "./graph";
import { ROOT_ID } from "./types";
import { t } from "../i18n/core";

/** 畳んだブロックの幅 */
export const BLOCK_W = 256;
/** 見出し行の高さ (入力/出力ノード用。ボックスは題名の行 + 情報の行) */
export const HEADER_H = 44;
/** ボックスの題名の行の高さ (1 行) */
export const TITLE_H = 36;
/** 題名の 2 行目以降の高さ */
export const TITLE_LINE_H = 18;
/** 題名の下の情報の行 (状態・担当・進捗・活動・ID) の高さ */
export const META_H = 24;
/** ポート 1 行の高さ */
export const ROW_H = 26;
/** ポート列の下の余白 */
export const PAD_BOTTOM = 16;
/** 展開中のブロックの最小幅 */
export const EXPANDED_MIN_W = 320;
/** 展開中: 子の右端からボックスの縁までの余白 (子の出力から親の出力へ上がる線の通路) */
export const EXPANDED_PAD = 96;
/** 展開中: 子の下端からボックスの縁までの余白 */
export const EXPANDED_PAD_Y = 104; // 子の下を通る線 (縁から 36px + 2 本分)。空きが足りないときは線の間隔を詰める
/** 入力/出力ノードの幅 */
export const TERMINAL_W = 200;

export interface Size {
  width: number;
  height: number;
  /** 見出し行の高さ (題名が 2 行になると増える) */
  headerH: number;
}

/** ボックスの最大幅 (これを超える題名は折り返す) */
export const BLOCK_MAX_W = 460;

/** 文字列のおおよその表示幅 (px)。全角は幅広、半角は細い */
export function textWidth(s: string, fontPx: number): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    w += code > 0x2e7f ? fontPx * 1.05 : fontPx * 0.6;
  }
  return w;
}

/**
 * 情報の行 (題名の下) の幅: 状態の印、担当のアバター、進捗の札、活動の札、期日、ID
 * Input : 担当の人数, 札の有無
 */
export function metaRowWidth(opts: { assigneeText: string; unassigned: boolean; hasPercent: boolean; activityText: string | null; hasDue: boolean; keyLen: number; isProject: boolean; hasReady?: boolean }): number {
  const chip = (text: string) => textWidth(text, 10) + 14 + 6;
  let w = 12 + 10;
  if (!opts.isProject) w += chip("In Progress"); // 状態の札は一番長い文言で見積もる
  if (opts.assigneeText) w += chip(opts.assigneeText);
  else if (opts.unassigned) w += chip(t("未担当"));
  if (opts.hasPercent) w += chip("100%");
  if (opts.activityText) w += chip(opts.activityText);
  if (opts.hasReady) w += chip("Ready");
  if (opts.hasDue) w += chip(t("期日 {date}", { date: "10/15" })); // BlockNode と同じ文言で見積もる
  w += opts.keyLen * 7 + 8;
  return w;
}

/** 入出力の行を接続相手の上下順にそろえる (保存されたポートや接続は変更しない)。
 * 名前順では上のタスクへの線が下の行から出て交差するため、相手の位置の平均を使う。
 * 同じ位置・未接続の場合は元の順序を保つ。親の内側端点は従来の並びを維持する。
 * Input: 計画、箱 ID、入出力方向。Output: 表示順に並べたポート (原本は変更しない)
 */
export function taskCardPorts(p: Project, blockId: string, direction: Port["direction"]): Port[] {
  const ports = portsOf(p, blockId, direction);
  if (ports.length < 2) return ports;
  const absoluteY = (id: string): number => {
    let y = 0, current: string | null = id;
    while (current && current !== ROOT_ID) {
      const b: Project["blocks"][string] | undefined = p.blocks[current];
      if (!b) break;
      y += b.position.y;
      current = b.parentId;
    }
    return y;
  };
  const rows = ports.map((port, index) => {
    const edges = direction === "in" ? incomingEdges(p, { portId: port.id, side: "outer" }) : outgoingEdges(p, { portId: port.id, side: "outer" });
    const ys = edges.map(e => p.ports[direction === "in" ? e.from.portId : e.to.portId]?.blockId).filter((id): id is string => !!id).map(absoluteY);
    return { port, index, y: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity };
  });
  return rows.sort((a, b) => (a.y === b.y ? 0 : a.y - b.y) || a.index - b.index).map(row => row.port);
}

/** 合流のボックス (OR ゲート風の部品) の幅・最小の高さ・入力 1 本あたりの高さ */
export const MERGE_W = 136;
const MERGE_MIN_H = 80;
const MERGE_ROW = 32;

/**
 * 表示名の折り返しと接続点を同じ寸法から求める。
 * Input: 計画と箱 ID。Output: カード全体・見出し・情報行の寸法と各ポート行の位置
 * 状態・活動・期日が変わっても、情報行の予約領域は維持する。
 */
export function taskCardLayout(p: Project, blockId: string) {
  const b = p.blocks[blockId];
  const ins = taskCardPorts(p, blockId, "in");
  const outs = taskCardPorts(p, blockId, "out");
  // 合流のボックス: OR ゲートのような小さな部品。入力は左の弧に等間隔 (1 本あたり 32px)、出力は右の先端 (高さの中央) に 1 つ
  if (b?.merge) {
    const height = Math.max(MERGE_MIN_H, ins.length * MERGE_ROW + 16);
    const step = (height - 16) / Math.max(1, ins.length);
    const inputs = ins.map((q, i) => ({ id: q.id, top: 8 + i * step, height: step, center: 8 + i * step + step / 2 }));
    const outputs = outs.map((q) => ({ id: q.id, top: 0, height, center: height / 2 }));
    return { width: MERGE_W, height, headerH: 0, metaH: 0, inputs, outputs };
  }
  const titleWidth = textWidth(b?.title ?? "", 22);
  const portWidth = Math.max(0, ...[...ins, ...outs].map(q => textWidth(q.name, 16) + 104));
  const width = Math.min(360, Math.max(BLOCK_W, titleWidth + 64, portWidth));
  const titleLines = Math.max(1, Math.ceil(titleWidth / (width - 64)));
  // 受け持ち・活動・判断の更新で寸法を変えない。開始時に隣のタスクが押し出されると、
  // CLI の受け持ち範囲外への配置変更になってしまうため、情報行の場所を先に確保する。
  const metaH = 80; // 期日・課題・テンプレートの有無でも高さを変えない
  const headerH = 88 + (titleLines - 1) * 28 + metaH;
  let cursor = headerH;
  const rows = (ports: typeof ins) => ports.map(q => {
    const lines = Math.max(1, Math.ceil(textWidth(q.name, 16) / (width - 104)));
    const height = Math.max(48, lines * 24 + 16);
    const row = { id: q.id, top: cursor, height, center: cursor + height / 2 };
    cursor += height;
    return row;
  });
  const inputs = rows(ins);
  const outputs = rows(outs);
  return { width, height: cursor + 8, headerH, metaH, inputs, outputs };
}

/** ブロックが「展開中 (子を中に描く)」か */
export function isExpanded(p: Project, blockId: string): boolean {
  const b = p.blocks[blockId];
  return !!b && !b.collapsed && childrenOf(p, blockId).length > 0;
}

/**
 * ブロックの大きさ (展開中なら子をすべて含む大きさ)
 * Input : blockId
 * Output: { width, height }
 */
export function blockSize(p: Project, blockId: string): Size {
  if (!isExpanded(p, blockId)) return taskCardLayout(p, blockId);
  const b = p.blocks[blockId];
  const insP = portsOf(p, blockId, "in");
  const outsP = portsOf(p, blockId, "out");
  const rows = Math.max(insP.length, outsP.length, 1);
  const kids = childrenOf(p, blockId);
  // 題名の行: 題名 (+ プロジェクトの札 + 畳むボタン) が収まる幅。最大幅を超えたら折り返す
  // 題名の左右に置くものの幅の見積もり: 左右の余白 (12 + 10) + 隙間 (8) + プロジェクトの札 (66) か状態アイコン (26)
  // + 畳むボタン (30) + カテゴリの札 (文字の幅 + 20。英語のときは英語の幅)。index.css の .bg-block__head と合わせる
  const category = categoryOf(b?.category);
  const titleExtras =12 + 10 + 8 + (b?.kind === "project" ? 66 : 26) + 30 + (category ? textWidth(t(category.label), 11) + 20 : 0);
  const titleW = textWidth(b?.title ?? "", 15) + 4;
  const wantTitle = titleExtras + titleW;
  // 情報の行: 状態・担当・進捗・活動・期日・ID
  const actorText = (actor: string) => { const a = actor.toLowerCase(); return a.startsWith("claude") ? "Claude Code" : a.startsWith("codex") ? "Codex" : a.startsWith("human:") ? actor.slice(6) : actor; };
  // 活動の札の文言 (BlockNode と同じキーを t() で引き、英語のときは英語の幅で見積もる)
  const stateText: Record<string, string> = { working: t("作業中"), blocked: t("詰まり"), needs_decision: t("判断待ち"), waiting_review: t("確認待ち") };
  const metaW = metaRowWidth({
    assigneeText: "" // 担当はボックスに出さない
  , unassigned: false
  , hasPercent: !!b && b.status !== "white" && (kids.length > 0 || (typeof b.progress === "number" && b.progress > 0))
  , activityText: b?.activity ? `${stateText[b.activity.state] ?? ""} (${actorText(b.activity.actor)})` : null
  , hasDue: !!b?.dueDate && b.status !== "white"
  , keyLen: (b?.key ?? "").length
  , isProject: b?.kind === "project"
  , hasReady: !!b && b.status === "black" && b.kind !== "project" && insP.length > 0 && missingRequiredInputs(p, b.id).length === 0
  });
  const headWidth = Math.min(BLOCK_MAX_W, Math.max(BLOCK_W, wantTitle, metaW));
  // 入出力の名前が省略されない幅 (左右の列 + 真ん中の隙間)
  const inW = Math.max(0, ...insP.map((q) => textWidth(q.name, 12) + (q.name ? 14 : 0) + (q.required ? 0 : textWidth(t("(任意)"), 9) + 4)));
  const outW = Math.max(0, ...outsP.map((q) => textWidth(q.name, 12)));
  const portsWidth = 12 + inW + 24 + outW + 10;
  const width = Math.max(BLOCK_W, headWidth, Math.min(BLOCK_MAX_W + 120, portsWidth));
  // 題名の行数は、入出力まで含めて決まったボックスの幅で数える。行数に上限は付けない:
  // 題名は「…」で省略せず必ず全部見せるので (CSS 側でも切らない)、長い題名はボックスの高さを増やして収める
  const titleLines = Math.max(1, Math.ceil(titleW / Math.max(80, width - titleExtras)));
  const headerH = TITLE_H + (titleLines - 1) * TITLE_LINE_H + META_H;
  const baseH = headerH + rows * ROW_H + PAD_BOTTOM;
  let right = 0;
  let bottom = 0;
  for (const c of kids) {
    const s = blockSize(p, c.id);
    right = Math.max(right, c.position.x + s.width);
    bottom = Math.max(bottom, c.position.y + s.height);
  }
  return {
    width: Math.max(EXPANDED_MIN_W, width, right + EXPANDED_PAD)
  , height: Math.max(baseH + 16, bottom + EXPANDED_PAD_Y + 12 + (headerH - HEADER_H))
  , headerH
  };
}

/** 入力/出力ノードの高さ */
export function terminalHeight(p: Project, which: "in" | "out"): number {
  const n = portsOf(p, ROOT_ID, which).length;
  return HEADER_H + Math.max(n, 1) * ROW_H + PAD_BOTTOM;
}
