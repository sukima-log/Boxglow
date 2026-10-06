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
import { mergeProjects } from "../model/merge";
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

/** 項目の場所 (segments) の値を読む (無ければ undefined) */
function valueAt(project: Project, segments: string[]): unknown {
  let v: unknown = project;
  for (const k of segments) { if (v === null || typeof v !== "object") return undefined; v = (v as Record<string, unknown>)[k]; }
  return v;
}
/** 項目の場所 (segments) に値を書く (undefined なら消す)。途中の入れ物が無ければ作る */
function setAt(project: Project, segments: string[], value: unknown): void {
  let o = project as unknown as Record<string, unknown>;
  for (const k of segments.slice(0, -1)) {
    if (o[k] === null || typeof o[k] !== "object") o[k] = {};
    o = o[k] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (value === undefined) delete o[last]; else o[last] = structuredClone(value);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 取り込みの準備: 同じ計画か確かめ、競合を集める (何も変えない)
 * 競合 = 今・退避した画面・退避したエディタのうち 2 つ以上が、基準から変えていて、値が食い違う項目。
 * 候補の値は、それぞれの元の版から取る (2 段の統合の途中の結果を「今の値」として見せない。R41-02)
 * Input : recovery = 退避ファイルの中身, current = 今開いている最新の中身
 * Output: { conflicts } (空なら、そのまま取り込める) / { error } (読めない・別の計画の退避)
 */
export function prepareRestore(recovery: Recovery, current: Project): { conflicts: RestoreConflict[] } | { error: string } {
  let p: ReturnType<typeof parse>;
  try { p = parse(recovery); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  // 同じ計画の退避だけを取り込む (別の場所へ移した同じ計画は通る。パスでは比べない。R40-06)
  for (const other of [p.base, p.gui, p.editor]) if (other && other.id !== current.id) return { error: "different-plan" };
  // 2 つずつ統合して、食い違う項目の場所を全部集める (今と画面・今とエディタ・画面とエディタ)
  const places = new Map<string, { path: string; segments: string[] }>();
  const collect = (ours: Project, theirs: Project) => { for (const c of mergeProjects(p.base, ours, theirs).conflicts) if (!c.automatic) places.set(c.id, { path: c.path, segments: c.segments }); };
  collect(p.gui, current);
  if (p.editor) { collect(p.editor, current); collect(p.editor, p.gui); }
  const conflicts: RestoreConflict[] = [];
  for (const [id, place] of places) {
    const c: RestoreConflict = { id, path: place.path, current: valueAt(current, place.segments), gui: valueAt(p.gui, place.segments) };
    if (p.editor) c.editor = valueAt(p.editor, place.segments);
    conflicts.push(c);
  }
  return { conflicts };
}

/**
 * 取り込む: 競合しない編集は統合し、競合した項目は、選んだ版の元の値をその場所に書く (自動の採用に負けない)。結果が計画として正しいかを確かめる
 * Input : recovery, current, picks = 競合ごとの選択 (prepareRestore の全部の競合について必要)
 * Output: { project, merged } / { error } (選んでいない競合がある・統合の結果が正しくない。何も変えない)
 */
export function applyRestore(recovery: Recovery, current: Project, picks: RestorePicks): { project: Project; merged: number } | { error: string } {
  const prepared = prepareRestore(recovery, current);
  if ("error" in prepared) return prepared;
  if (prepared.conflicts.some((c) => !picks[c.id])) return { error: "unresolved" };
  const p = parse(recovery);
  // 競合しない編集を統合する (画面の退避 → 今、エディタの退避 → その結果)
  const first = mergeProjects(p.base, p.gui, current);
  let project = first.project, merged = first.merged;
  if (p.editor) { const second = mergeProjects(p.base, p.editor, first.project); project = second.project; merged += second.merged; }
  project = structuredClone(project);
  // 競合した項目は、選んだ版の値を書く
  const sources = { current, gui: p.gui, editor: p.editor ?? p.gui };
  const places = new Map<string, string[]>();
  const collect = (ours: Project, theirs: Project) => { for (const c of mergeProjects(p.base, ours, theirs).conflicts) if (!c.automatic) places.set(c.id, c.segments); };
  collect(p.gui, current);
  if (p.editor) { collect(p.editor, current); collect(p.editor, p.gui); }
  for (const c of prepared.conflicts) {
    const segments = places.get(c.id);
    if (!segments) continue;
    const chosen = valueAt(sources[picks[c.id]], segments);
    if (!same(valueAt(project, segments), chosen)) setAt(project, segments, chosen);
  }
  // 統合の結果が計画として正しいか (個別には正しい編集どうしでも、親子の循環などができることがある。R40-04)
  let text: string;
  try { text = toJSON(project); validateProjectText(text); } catch (e) { return { error: "invalid:" + (e instanceof Error ? e.message : String(e)) }; }
  return { project: fromJSON(text), merged };
}

/**
 * エディタ待ちを解いてよいか (R39-07): エディタから届いた中身が、受け取った最新 (R) と同じになったときだけ。古い版の update では解かない
 * Input : behind = 受け取った最新 (エディタ待ちでなければ null), text = エディタから届いた中身 (LF にそろえたもの)
 */
export const editorCaughtUp = (behind: string | null, text: string): boolean => behind !== null && text === behind;
