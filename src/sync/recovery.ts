/**
 * 退避した編集の取り込み (VS Code で、エディタが同期の受け取りに追い付かないまま画面で編集した場合の復旧。設計書 4 章 / レビュー 39 の R39-05・06)
 * 退避ファイルの形式 (拡張が書く):
 *   { boxglowRecovery: 1, savedAt, file, base (画面が元にした中身), received (受け取った最新 R), gui: { text, hash }, editor: { text, version, hash } | null }
 * 取り込みは、退避したときの基準を共通の元にして、退避した画面の編集 (と、エディタ側の独立した編集) を、今開いている最新の中身へ統合する。
 * 結果は未保存の編集として扱い、保存の基準は今の中身のまま (呼び出し側の責任)
 */
import { fromJSON } from "../model/graph";
import { mergeProjects } from "../model/merge";
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

/**
 * 退避した編集を、今の中身へ統合する
 * Input : recovery = 退避ファイルの中身, current = 今開いている最新の中身 (= 保存の基準)
 * Output: { project = 統合の結果 (未保存として扱う), merged = 自動で合わせた数, conflicts = 両側で違う値になっていた項目 (退避した編集の値を採った) }
 *         読めない中身なら { error }
 */
export function mergeRecovery(recovery: Recovery, current: Project): { project: Project; merged: number; conflicts: string[] } | { error: string } {
  let base: Project | null, gui: Project, editor: Project | null;
  try {
    base = recovery.base ? fromJSON(recovery.base) : null;
    gui = fromJSON(recovery.gui);
    editor = recovery.editor ? fromJSON(recovery.editor) : null;
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  // 今の中身に、退避した画面の編集を (共通の元 = 退避したときの基準)
  const first = mergeProjects(base, gui, current);
  // さらに、エディタ側の独立した編集を (共通の元は同じ。画面の統合の結果を「今の中身」とみなす)
  const second = editor ? mergeProjects(base, editor, first.project) : null;
  return {
    project: second ? second.project : first.project
  , merged: first.merged + (second?.merged ?? 0)
  , conflicts: [...first.conflicts, ...(second?.conflicts ?? [])].map((c) => c.path)
  };
}

/**
 * エディタ待ちを解いてよいか (R39-07): エディタから届いた中身が、受け取った最新 (R) と同じになったときだけ。古い版の update では解かない
 * Input : behind = 受け取った最新 (エディタ待ちでなければ null), text = エディタから届いた中身 (LF にそろえたもの)
 */
export const editorCaughtUp = (behind: string | null, text: string): boolean => behind !== null && text === behind;
