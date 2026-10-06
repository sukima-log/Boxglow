/**
 * 退避した編集の取り込み (VS Code で、エディタが同期の受け取りに追い付かないまま画面で編集した場合の復旧。設計書 4 章 / レビュー 39・40)
 * 退避ファイルの形式 (拡張が書く):
 *   { boxglowRecovery: 1, savedAt, file, base (画面が元にした中身), received (受け取った最新 R), gui: { text, hash }, editor: { text, version, hash } | null }
 * 取り込みは 2 段:
 *   prepareRestore = 同じ計画か確かめ、退避したときの基準を共通の元にして、両側で違う値になっている項目 (競合) を集める (何も変えない)
 *   applyRestore   = 利用者が競合ごとに選んだ値で統合し、統合の結果が計画として正しいかを確かめる
 * 競合しない編集は自動で取り込む。競合する項目は、利用者が選ぶまで反映しない (R40-03)
 */
import { fromJSON, toJSON } from "../model/graph";
import { mergeProjects, type ConflictChoices } from "../model/merge";
import { validateProjectText } from "../model/validate-file";
import type { Project } from "../model/types";

/** 退避ファイルの中身 (読めた部分) */
export interface Recovery { base: string | null; received: string | null; gui: string; editor: string | null }

/** 競合 1 件: 項目の場所と、それぞれの値 (current = 今開いている最新、gui = 退避した画面、editor = 退避したエディタ側。無い側は省く) */
export interface RestoreConflict { id: string; path: string; current?: unknown; gui?: unknown; editor?: unknown }
/** 競合ごとの選択 */
export type RestorePicks = Record<string, "current" | "gui" | "editor">;

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

/** 退避の中身を読む (読めなければ例外) */
function parse(recovery: Recovery): { base: Project | null; gui: Project; editor: Project | null } {
  return { base: recovery.base ? fromJSON(recovery.base) : null, gui: fromJSON(recovery.gui), editor: recovery.editor ? fromJSON(recovery.editor) : null };
}

/**
 * 取り込みの準備: 同じ計画か確かめ、競合を集める (何も変えない)
 * Input : recovery = 退避ファイルの中身, current = 今開いている最新の中身
 * Output: { conflicts } (空なら、そのまま取り込める) / { error } (読めない・別の計画の退避)
 */
export function prepareRestore(recovery: Recovery, current: Project): { conflicts: RestoreConflict[] } | { error: string } {
  let p: ReturnType<typeof parse>;
  try { p = parse(recovery); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  // 同じ計画の退避だけを取り込む (別の場所へ移した同じ計画は通る。パスでは比べない。R40-06)
  for (const other of [p.base, p.gui, p.editor]) if (other && other.id !== current.id) return { error: "different-plan" };
  const first = mergeProjects(p.base, p.gui, current);
  const conflicts = new Map<string, RestoreConflict>();
  for (const c of first.conflicts) if (!c.automatic) conflicts.set(c.id, { id: c.id, path: c.path, gui: c.ours, current: c.theirs });
  if (p.editor) {
    const second = mergeProjects(p.base, p.editor, first.project);
    for (const c of second.conflicts) {
      if (c.automatic) continue;
      const known = conflicts.get(c.id);
      // (画面の退避と今の最新で競合していない項目は、統合した値 = 今の値として出す)
      conflicts.set(c.id, known ? { ...known, editor: c.ours } : { id: c.id, path: c.path, current: c.theirs, editor: c.ours });
    }
  }
  return { conflicts: [...conflicts.values()] };
}

/**
 * 取り込む: 競合ごとの選択で統合し、統合の結果が計画として正しいかを確かめる
 * Input : recovery, current, picks = 競合ごとの選択 (prepareRestore の全部の競合について必要)
 * Output: { project, merged } / { error } (選んでいない競合がある・統合の結果が正しくない。何も変えない)
 */
export function applyRestore(recovery: Recovery, current: Project, picks: RestorePicks): { project: Project; merged: number } | { error: string } {
  const prepared = prepareRestore(recovery, current);
  if ("error" in prepared) return prepared;
  if (prepared.conflicts.some((c) => !picks[c.id])) return { error: "unresolved" };
  const p = parse(recovery);
  // 1 段目: 画面の退避 (ours) と今の最新 (theirs)。「今の値」を選んだ項目だけ theirs
  const choices1: ConflictChoices = {};
  for (const c of prepared.conflicts) choices1[c.id] = picks[c.id] === "current" ? "theirs" : "ours";
  const first = mergeProjects(p.base, p.gui, current, choices1);
  // 2 段目: エディタ側の退避 (ours) と 1 段目の結果 (theirs)。「エディタ側の値」を選んだ項目だけ ours
  let project = first.project, merged = first.merged;
  if (p.editor) {
    const choices2: ConflictChoices = {};
    for (const c of prepared.conflicts) choices2[c.id] = picks[c.id] === "editor" ? "ours" : "theirs";
    const second = mergeProjects(p.base, p.editor, first.project, choices2);
    project = second.project; merged += second.merged;
  }
  // 統合の結果が計画として正しいか (個別には正しい編集どうしでも、親子の循環などができることがある。R40-04)
  try { validateProjectText(toJSON(project)); } catch (e) { return { error: "invalid:" + (e instanceof Error ? e.message : String(e)) }; }
  return { project, merged };
}

/**
 * エディタ待ちを解いてよいか (R39-07): エディタから届いた中身が、受け取った最新 (R) と同じになったときだけ。古い版の update では解かない
 * Input : behind = 受け取った最新 (エディタ待ちでなければ null), text = エディタから届いた中身 (LF にそろえたもの)
 */
export const editorCaughtUp = (behind: string | null, text: string): boolean => behind !== null && text === behind;
