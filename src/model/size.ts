/**
 * ブロックの大きさ (画面と自動整列で共用。React Flow に依存しない)
 */
import type { Project } from "./types";
import { missingRequiredInputs, childrenOf, portsOf } from "./graph";
import { ROOT_ID } from "./types";
import { t } from "../i18n/core";

/** 畳んだブロックの幅 */
export const BLOCK_W = 240;
/** 見出し行の高さ (入力/出力ノード用。箱は題名の行 + 情報の行) */
export const HEADER_H = 44;
/** 箱の題名の行の高さ (1 行) */
export const TITLE_H = 36;
/** 題名の 2 行目以降の高さ */
export const TITLE_LINE_H = 18;
/** 題名の下の情報の行 (状態・担当・進捗・活動・ID) の高さ */
export const META_H = 24;
/** ポート 1 行の高さ */
export const ROW_H = 26;
/** ポート列の下の余白 */
export const PAD_BOTTOM = 12;
/** 展開中のブロックの最小幅 */
export const EXPANDED_MIN_W = 320;
/** 展開中: 子の右端から箱の縁までの余白 (子の出力から親の出力へ上がる線の通路) */
export const EXPANDED_PAD = 96;
/** 展開中: 子の下端から箱の縁までの余白 */
export const EXPANDED_PAD_Y = 104; // 子の下を通る線 (縁から 36px + 2 本分)。空きが足りないときは線の間隔を詰める
/** 入力/出力ノードの幅 */
export const TERMINAL_W = 200;

export interface Size {
  width: number;
  height: number;
  /** 見出し行の高さ (題名が 2 行になると増える) */
  headerH: number;
}

/** 箱の最大幅 (これを超える題名は折り返す) */
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
  const b = p.blocks[blockId];
  const insP = portsOf(p, blockId, "in");
  const outsP = portsOf(p, blockId, "out");
  const rows = Math.max(insP.length, outsP.length, 1);
  const kids = childrenOf(p, blockId);
  // 題名の行: 題名 (+ プロジェクトの札 + 畳むボタン) が収まる幅。最大幅を超えたら折り返す
  const titleExtras = 12 + 10 + (b?.kind === "project" ? 66 : 0) + (kids.length > 0 ? 30 : 0);
  const titleW = textWidth(b?.title ?? "", 14) + 4;
  const wantTitle = titleExtras + titleW;
  const titleLines = wantTitle > BLOCK_MAX_W ? Math.min(3, Math.ceil(titleW / (BLOCK_MAX_W - titleExtras))) : 1;
  // 情報の行: 状態・担当・進捗・活動・期日・ID
  const actorText = (actor: string) => { const a = actor.toLowerCase(); return a.startsWith("claude") ? "Claude Code" : a.startsWith("codex") ? "Codex" : a.startsWith("human:") ? actor.slice(6) : actor; };
  // 活動の札の文言 (BlockNode と同じキーを t() で引き、英語のときは英語の幅で見積もる)
  const stateText: Record<string, string> = { working: t("作業中"), blocked: t("詰まり"), needs_decision: t("判断待ち"), waiting_review: t("確認待ち") };
  const metaW = metaRowWidth({
    assigneeText: "" // 担当は箱に出さない
  , unassigned: false
  , hasPercent: !!b && b.status !== "white" && (kids.length > 0 || (typeof b.progress === "number" && b.progress > 0))
  , activityText: b?.activity ? `${stateText[b.activity.state] ?? ""} (${actorText(b.activity.actor)})` : null
  , hasDue: !!b?.dueDate && b.status !== "white"
  , keyLen: (b?.key ?? "").length
  , isProject: b?.kind === "project"
  , hasReady: !!b && b.status === "black" && b.kind !== "project" && insP.length > 0 && missingRequiredInputs(p, b.id).length === 0
  });
  const headWidth = Math.min(BLOCK_MAX_W, Math.max(BLOCK_W, wantTitle, metaW));
  const headerH = TITLE_H + (titleLines - 1) * TITLE_LINE_H + META_H;
  // 入出力の名前が省略されない幅 (左右の列 + 真ん中の隙間)
  const inW = Math.max(0, ...insP.map((q) => textWidth(q.name, 11) + (q.name ? 14 : 0) + (q.required ? 0 : textWidth(t("(任意)"), 9) + 4)));
  const outW = Math.max(0, ...outsP.map((q) => textWidth(q.name, 11)));
  const portsWidth = 12 + inW + 24 + outW + 10;
  const width = Math.max(BLOCK_W, headWidth, Math.min(BLOCK_MAX_W + 120, portsWidth));
  const baseH = headerH + rows * ROW_H + PAD_BOTTOM;
  if (!isExpanded(p, blockId)) return { width, height: baseH, headerH };
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
