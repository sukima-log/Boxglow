/**
 * boxglow.json の 3 方向マージ (Git のマージドライバ用)
 * 1 つのファイルを複数人で編集すると、push のたびに衝突して手でマージすることになる。
 * 行単位ではなく「箱・ポート・線の単位」で突き合わせれば、別々の箱を直した変更は自動で合わさる。
 *
 *   boxglow git-setup   で .gitattributes と git config に登録すると、git merge / pull が自動でこれを使う
 */
// 文言の言語切り替え (React に依存しない core を使う)
import { t } from "../i18n/core";
import type { Project } from "./types";

/** マージの結果と、両側で同じ項目を変えていた箇所 (ours を採用し、theirs の値を記録) */
export interface MergeResult {
  project: Project;
  /** 自動で合わせられた変更の数 */
  merged: number;
  /** 両側が同じ項目を別の値に変えていた箇所 (ours を採用) */
  conflicts: { path: string; ours: unknown; theirs: unknown }[];
}

type Dict = Record<string, unknown>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * 1 つの値を 3 方向で決める (base から ours だけが変えた / theirs だけが変えた / 両方同じ / 両方違う)
 * Input : path = 記録用の名前, base, ours, theirs
 * Output: 採用する値 (両方違えば ours)
 */
function pick(path: string, base: unknown, ours: unknown, theirs: unknown, r: MergeResult): unknown {
  if (same(ours, theirs)) return ours;
  if (same(ours, base)) { r.merged++; return theirs; }
  if (same(theirs, base)) return ours;
  r.conflicts.push({ path, ours, theirs });
  return ours;
}

/**
 * オブジェクトを項目ごとに 3 方向で合わせる (箱 1 つ、ポート 1 つなど)
 */
function mergeObject(path: string, base: Dict | undefined, ours: Dict, theirs: Dict, r: MergeResult): Dict {
  const out: Dict = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base ?? {})]);
  for (const k of keys) {
    const b = base?.[k];
    const o = ours[k];
    const t = theirs[k];
    const inO = k in ours;
    const inT = k in theirs;
    const inB = base ? k in base : false;
    // 片方で消された項目: もう片方が変えていなければ消す
    if (!inO && inT) { if (inB && same(t, b)) continue; out[k] = t; if (!inB) r.merged++; continue; }
    if (inO && !inT) { if (inB && same(o, b)) continue; out[k] = o; continue; }
    if (!inO && !inT) continue;
    // 配列や入れ子のオブジェクトは丸ごと 1 つの値として比べる (artifacts, decisions, position など)
    out[k] = pick(`${path}.${k}`, b, o, t, r);
  }
  return out;
}

/**
 * id をキーにした辞書 (blocks / ports / edges) を 3 方向で合わせる
 *   片方だけが足した → 足す。片方だけが消した (もう片方は変えていない) → 消す。両方にある → 項目ごとに合わせる
 */
function mergeMap(path: string, base: Record<string, Dict> | undefined, ours: Record<string, Dict>, theirs: Record<string, Dict>, r: MergeResult): Record<string, Dict> {
  const out: Record<string, Dict> = {};
  const ids = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base ?? {})]);
  for (const id of ids) {
    const b = base?.[id];
    const o = ours[id];
    const t = theirs[id];
    if (o && t) { out[id] = mergeObject(`${path}.${id}`, b, o, t, r); continue; }
    if (o && !t) { if (b && same(o, b)) continue; out[id] = o; continue; } // theirs が消した (ours は未変更なら消える)
    if (!o && t) { if (b && same(t, b)) continue; out[id] = t; r.merged++; continue; } // theirs が足した / ours が消した
  }
  return out;
}

/** id を持つ配列 (members, inputGroups, log) を id で合わせる */
function mergeArrayById<T extends { id: string }>(path: string, base: T[] | undefined, ours: T[], theirs: T[], r: MergeResult): T[] {
  const toMap = (xs: T[] | undefined): Record<string, Dict> => Object.fromEntries((xs ?? []).map((x) => [x.id, x as unknown as Dict]));
  const merged = mergeMap(path, base ? toMap(base) : undefined, toMap(ours), toMap(theirs), r);
  // 並びは ours の順 → theirs だけにあるものを後ろに
  const order = [...ours.map((x) => x.id), ...theirs.map((x) => x.id).filter((id) => !ours.some((x) => x.id === id))];
  return order.filter((id) => merged[id]).map((id) => merged[id] as unknown as T);
}

/**
 * 3 方向マージ
 * Input : base = 共通の祖先, ours = 自分の版, theirs = 相手の版 (すべて fromJSON 済みの Project)
 * Output: { project, merged, conflicts }
 */
export function mergeProjects(base: Project | null, ours: Project, theirs: Project): MergeResult {
  const r: MergeResult = { project: ours, merged: 0, conflicts: [] };
  const b = (base ?? undefined) as unknown as Dict | undefined;
  const o = ours as unknown as Dict;
  const th = theirs as unknown as Dict; // (文言の t() と名前が重ならないよう th)
  const out: Dict = { ...o };
  // 単純な値
  for (const k of ["name", "description", "visibility", "terminals"]) out[k] = pick(k, b?.[k], o[k], th[k], r);
  // id の辞書
  for (const k of ["blocks", "ports", "edges", "agents"]) {
    out[k] = mergeMap(k, b?.[k] as Record<string, Dict> | undefined, (o[k] ?? {}) as Record<string, Dict>, (th[k] ?? {}) as Record<string, Dict>, r);
  }
  // id の配列
  out.members = mergeArrayById("members", base?.members, ours.members ?? [], theirs.members ?? [], r);
  out.inputGroups = mergeArrayById("inputGroups", base?.inputGroups, ours.inputGroups ?? [], theirs.inputGroups ?? [], r);
  // ログは両方を合わせて時刻順 (同じ id は 1 つ)
  const log = new Map<string, Project["log"][number]>();
  for (const e of [...(ours.log ?? []), ...(theirs.log ?? [])]) log.set(e.id, e);
  out.log = [...log.values()].sort((p, q) => (p.at < q.at ? -1 : p.at > q.at ? 1 : 0));
  // 箱の短い ID (B 番号) の衝突: 両方が同じ番号を別の箱に付けていたら、theirs 側を新しい番号に振り直す
  const blocks = out.blocks as Record<string, Dict>;
  const used = new Map<string, string>();
  let nextKey = Math.max(ours.nextKey ?? 1, theirs.nextKey ?? 1);
  for (const id of Object.keys(ours.blocks ?? {})) { const key = blocks[id]?.key as string | undefined; if (key) used.set(key, id); }
  for (const id of Object.keys(blocks)) {
    const key = blocks[id].key as string | undefined;
    if (!key) continue;
    const owner = used.get(key);
    if (owner && owner !== id) {
      blocks[id] = { ...blocks[id], key: `B${nextKey}` };
      r.conflicts.push({ path: `blocks.${id}.key`, ours: key, theirs: t("{key} に振り直し", { key: `B${nextKey}` }) });
      nextKey++;
    } else used.set(key, id);
  }
  out.nextKey = nextKey;
  r.project = out as unknown as Project;
  return r;
}
