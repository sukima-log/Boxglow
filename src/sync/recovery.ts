/**
 * 退避した編集の取り込み (VS Code で、エディタが同期の受け取りに追い付かないまま画面で編集した場合の復旧。設計書 4 章 / レビュー 39〜42)
 * 退避ファイルの形式 (拡張が書く):
 *   { boxglowRecovery: 1, savedAt, file, base (画面が元にした中身), received (受け取った最新 R), gui: { text, hash }, editor: { text, version, hash } | null }
 * 取り込みは、退避した版ごとに 1 段ずつ行う (画面の退避 → エディタの退避があれば、その後で)。各段は「退避した版」と「その時点の今の中身」の
 * 2 者の統合で、共通の元は退避したときの基準。競合の選択は統合の仕組み (mergeProjects の choices) にそのまま渡す。
 * こうすると、候補の値は必ず実際の版の値になり (R41-02)、ID 付きの配列 (R42-02)・祖先と子の競合の重なり (R42-03)・本文と日時の対応 (R42-04)・
 * 削除に伴う入出力などの片付け (R42-05) を、ふつうの統合と同じ規則で扱える (値を後から書き換えない)
 *   prepareRestore = 同じ計画か確かめ、その段の競合を集める (何も変えない)
 *   applyRestore   = 競合ごとの選択で統合し、結果が計画として正しいかを確かめる
 */
import { fromJSON, toJSON } from "../model/graph";
import { mergeProjects, type ConflictChoices } from "../model/merge";
import { validateProjectText } from "../model/validate-file";
import type { Project } from "../model/types";

/** 退避ファイルの中身 (読めた部分) */
export interface Recovery { base: string | null; received: string | null; gui: string; editor: string | null }

/**
 * 退避ファイルの中身を読む
 * Input : value = JSON を解釈した値
 * Output: Recovery。形が違えば null
 */
export function readRecovery(value: unknown): Recovery | null {
  const r = value as { boxglowRecovery?: unknown; base?: unknown; received?: unknown; gui?: { text?: unknown }; editor?: { text?: unknown } | null } | null;
  if (!r || r.boxglowRecovery !== 1 || typeof r.gui?.text !== "string") return null;
  return {
    base: typeof r.base === "string" && r.base.trim() ? r.base : null
  , received: typeof r.received === "string" ? r.received : null
  , gui: r.gui.text
  , editor: r.editor && typeof r.editor.text === "string" ? r.editor.text : null
  };
}

/** 取り込みの段: 退避した画面の版 / 退避したエディタの版 */
export type RestoreStep = "gui" | "editor";
/** 競合 1 件: 項目の場所と、今の中身の値・退避した版の値 (消した側は undefined) */
export interface RestoreConflict { id: string; path: string; current: unknown; saved: unknown }
/** 競合ごとの選択: current = 今の値を残す / saved = 退避した版の値を採る */
export type RestorePicks = Record<string, "current" | "saved">;

/** 退避の中身を読む (読めなければ例外) */
function parse(recovery: Recovery): { base: Project | null; gui: Project; editor: Project | null } {
  return { base: recovery.base ? fromJSON(recovery.base) : null, gui: fromJSON(recovery.gui), editor: recovery.editor ? fromJSON(recovery.editor) : null };
}

/**
 * 取り込みの準備: 同じ計画か確かめ、その段の競合を集める (何も変えない)
 * Input : recovery = 退避ファイルの中身, current = 今の中身 (前の段を取り込んだ後なら、その結果), step = どの退避の版を取り込むか
 * Output: { conflicts } (空なら、そのまま取り込める) / { error } (読めない・別の計画の退避・その段の版が無い)
 */
export function prepareRestore(recovery: Recovery, current: Project, step: RestoreStep): { conflicts: RestoreConflict[] } | { error: string } {
  let p: ReturnType<typeof parse>;
  try { p = parse(recovery); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  // 同じ計画の退避だけを取り込む (別の場所へ移した同じ計画は通る。パスでは比べない。R40-06)
  for (const other of [p.base, p.gui, p.editor]) if (other && other.id !== current.id) return { error: "different-plan" };
  const saved = step === "gui" ? p.gui : p.editor;
  if (!saved) return { error: "no-step" };
  // (統合の仕組みの競合: ours = 退避した版、theirs = 今の中身。自動で解決した項目 (短い ID の振り直し) は選ばせない)
  const conflicts = mergeProjects(p.base, saved, current).conflicts.filter((c) => !c.automatic)
    .map((c) => ({ id: c.id, path: c.path, current: c.theirs, saved: c.ours }));
  return { conflicts };
}

/**
 * 取り込む: 競合ごとの選択を統合の仕組みに渡して統合し、結果が計画として正しいかを確かめる
 * Input : recovery, current, step, picks = 競合ごとの選択 (prepareRestore の全部の競合について必要)
 * Output: { project, merged } / { error } (選んでいない競合がある・統合の結果が正しくない。何も変えない)
 */
export function applyRestore(recovery: Recovery, current: Project, step: RestoreStep, picks: RestorePicks): { project: Project; merged: number } | { error: string } {
  const prepared = prepareRestore(recovery, current, step);
  if ("error" in prepared) return prepared;
  if (prepared.conflicts.some((c) => !picks[c.id])) return { error: "unresolved" };
  const p = parse(recovery);
  const saved = step === "gui" ? p.gui : p.editor!;
  const choices: ConflictChoices = {};
  for (const c of prepared.conflicts) choices[c.id] = picks[c.id] === "saved" ? "ours" : "theirs";
  const result = mergeProjects(p.base, saved, current, choices);
  // 統合の結果が計画として正しいか (個別には正しい編集どうしでも、親子の循環などができることがある。R40-04)
  let text: string;
  try { text = toJSON(result.project); validateProjectText(text); } catch (e) { return { error: "invalid:" + (e instanceof Error ? e.message : String(e)) }; }
  return { project: fromJSON(text), merged: result.merged };
}

/**
 * エディタ待ちを解いてよいか (R39-07): エディタから届いた中身が、受け取った最新 (R) と同じになったときだけ。古い版の update では解かない
 * Input : behind = 受け取った最新 (エディタ待ちでなければ null), text = エディタから届いた中身 (LF にそろえたもの)
 */
export const editorCaughtUp = (behind: string | null, text: string): boolean => behind !== null && text === behind;
