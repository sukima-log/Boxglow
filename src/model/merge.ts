/**
 * boxglow.json の 3 方向マージ (Git のマージドライバ用)
 * 1 つのファイルを複数人で編集すると、push のたびに衝突して手でマージすることになる。
 * 行単位ではなく「ボックス・ポート・線の単位」で突き合わせれば、別々のボックスを直した変更は自動で合わさる。
 *
 *   boxglow git-setup   で .gitattributes と git config に登録すると、git merge / pull が自動でこれを使う
 */
// 文言の言語切り替え (React に依存しない core を使う)
import { t } from "../i18n/core";
import type { Project } from "./types";

/**
 * 競合した項目ごとの選択 (競合の id → どちらを採るか)。
 * 指定の無い項目は ours。ただし「片方が消し、もう片方が変えた」項目は、指定が無ければ変えた側 (残っている側) を採る (データを失わない側を既定にする)
 */
export type ConflictChoices = Record<string, "ours" | "theirs">;
/**
 * 両側が同じ項目を別の値に変えていた箇所 1 件
 * id = 項目の場所 (segments) を JSON にしたもの (選択のキー), path = 表示用 ("blocks.xxx.title"), segments = 項目の場所,
 * ours / theirs = それぞれの値 (消した側は undefined), automatic = 自動で解決した (ボックスの短い ID の振り直し。選択の対象外),
 * adopted = 採用した側 (選択、または既定で決まった側。automatic の項目には無い)
 */
export interface MergeConflict { id: string; path: string; segments: string[]; ours: unknown; theirs: unknown; automatic?: boolean; adopted?: "ours" | "theirs" }
/** マージの結果と、両側で同じ項目を変えていた箇所 (選択が無ければ ours を採用し、theirs の値を記録。削除と変更がぶつかった項目は変更された側を残す) */
export interface MergeResult {
  project: Project;
  /** 自動で合わせられた変更の数 */
  merged: number;
  /** 両側が同じ項目を別の値に変えていた箇所 (ours を採用) */
  conflicts: MergeConflict[];
}

/** マージの途中の状態 (結果を溜める先と、競合の選択) */
type MergeContext = MergeResult & { choices: ConflictChoices };
type Dict = Record<string, unknown>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * 1 つの値を 3 方向で決める (base から ours だけが変えた / theirs だけが変えた / 両方同じ / 両方違う)
 * Input : path = 項目の場所 (記録と選択のキーに使う), base, ours, theirs (項目が無い側は undefined), r = 結果を溜める先
 * Output: 採用する値 (両方違えば競合として記録し、選択があればその側、無ければ ours。undefined = 項目を消す)。
 *         片方が消し (undefined)、もう片方が変えていた場合は、選択が無ければ変えた側を採る
 *         (どちらが消した場合でも同じ。消す方を既定にすると、相手の変更が黙って失われるため)
 */
function pick(path: string[], base: unknown, ours: unknown, theirs: unknown, r: MergeContext): unknown {
  if (same(ours, theirs)) return ours;
  if (same(ours, base)) { r.merged++; return theirs; }
  if (same(theirs, base)) return ours;
  const id = JSON.stringify(path);
  // 既定: ふつうは ours。ours が消していて theirs が残っている (変えた) ときだけ theirs
  const adopted = r.choices[id] ?? (ours === undefined && theirs !== undefined ? "theirs" : "ours");
  r.conflicts.push({ id, path: path.join("."), segments: path, ours, theirs, adopted });
  return adopted === "theirs" ? theirs : ours;
}

/**
 * オブジェクトを項目ごとに 3 方向で合わせる (ボックス 1 つ、ポート 1 つなど)
 */
function mergeObject(path: string[], base: Dict | undefined, ours: Dict, theirs: Dict, r: MergeContext): Dict {
  const out: Dict = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base ?? {})]);
  for (const k of keys) {
    const b = base?.[k];
    const o = ours[k];
    const t = theirs[k];
    // 配列や入れ子のオブジェクトは丸ごと 1 つの値として比べる (artifacts, decisions, position など)
    // 項目が無い側は undefined として比べる (片方が消し、もう片方が変えていなければ消える。両方が別々に変えた・消したなら競合)
    const value = pick([...path, k], b, o, t, r);
    if (value !== undefined) out[k] = value;
  }
  return out;
}

/**
 * id をキーにした辞書 (blocks / ports / edges) を 3 方向で合わせる
 *   片方だけが足した → 足す。片方だけが消した (もう片方は変えていない) → 消す。両方にある → 項目ごとに合わせる。
 *   片方が消し、もう片方が変えた → 競合として記録し、選択が無ければ変えた側を残す (pick)
 */
function mergeMap(path: string[], base: Record<string, Dict> | undefined, ours: Record<string, Dict>, theirs: Record<string, Dict>, r: MergeContext): Record<string, Dict> {
  const out: Record<string, Dict> = {};
  const ids = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base ?? {})]);
  for (const id of ids) {
    const b = base?.[id];
    const o = ours[id];
    const t = theirs[id];
    // 引き継ぎメモは書いた人・時刻とメモが 1 組なので、項目ごとに混ぜず丸ごと 1 つの値として比べる
    // 片方だけにある・片方が消した場合も pick に任せる (消した側と変えた側がぶつかれば競合として記録する)
    if (o && t && path[0] !== "handoffs") { out[id] = mergeObject([...path, id], b, o, t, r); continue; }
    const value = pick([...path, id], b, o, t, r);
    if (value !== undefined) out[id] = value as Dict;
  }
  return out;
}

/** id を持つ配列 (members, inputGroups, log) を id で合わせる */
function mergeArrayById<T extends { id: string }>(path: string[], base: T[] | undefined, ours: T[], theirs: T[], r: MergeContext): T[] {
  const toMap = (xs: T[] | undefined): Record<string, Dict> => Object.fromEntries((xs ?? []).map((x) => [x.id, x as unknown as Dict]));
  const merged = mergeMap(path, base ? toMap(base) : undefined, toMap(ours), toMap(theirs), r);
  // 並びは ours の順 → theirs だけにあるものを後ろに
  const order = [...ours.map((x) => x.id), ...theirs.map((x) => x.id).filter((id) => !ours.some((x) => x.id === id))];
  return order.filter((id) => merged[id]).map((id) => merged[id] as unknown as T);
}

/**
 * 片方が消したボックス (やその入出力) が、もう片方の変更を残すために復活した場合に、まわりの参照をそろえる
 * ボックスの削除は「そのボックス・中のボックス・入出力・線」をまとめて消す操作なので、ボックス 1 つだけが残ると、親のいないボックスや入出力の無いボックスができる。
 * 残ったボックスを含む「消されたまとまり」(消した側に無い一番上の親から下すべて) を、残っている側 (変えた側) の内容で戻す
 * Input : out = マージ途中の結果 (blocks / ports / edges / handoffs を書き換える), deleter = 消した側の計画, keeper = 残っている側の計画
 * Output: なし (out を書き換える)
 */
function restoreDeleted(out: Dict, deleter: Project, keeper: Project): void {
  const blocks = out.blocks as Record<string, Dict>;
  const ports = out.ports as Record<string, Dict>;
  const edges = out.edges as Record<string, Dict>;
  /** 消した側に無く、残っている側にあるボックスか (= 消した側が消した、または残っている側が足したボックス) */
  const onlyInKeeper = (id: string): boolean => !deleter.blocks[id] && !!keeper.blocks[id];
  // 戻す起点: 結果に残っている「消した側に無いボックス」と、結果に残っている「消した側に無い入出力」の持ち主で、結果に無いボックス
  const seeds = new Set<string>();
  for (const id of Object.keys(blocks)) if (onlyInKeeper(id)) seeds.add(id);
  for (const port of Object.values(ports)) {
    const id = port.blockId as string;
    if (!blocks[id] && onlyInKeeper(id) && !deleter.ports[port.id as string]) seeds.add(id);
  }
  if (seeds.size === 0) return;
  // 起点から親をたどり、消されたまとまりの一番上を求める (消した側にもある親に着いたら止まる)
  const tops = new Set<string>();
  for (const seed of seeds) {
    let top = seed;
    for (let parent = keeper.blocks[top]?.parentId; parent && onlyInKeeper(parent); parent = keeper.blocks[top]?.parentId) top = parent;
    tops.add(top);
  }
  // 一番上から下 (残っている側の親子関係) をすべて集める
  const restored = new Set<string>(tops);
  for (let grew = true; grew;) {
    grew = false;
    for (const b of Object.values(keeper.blocks)) {
      if (b.parentId && restored.has(b.parentId) && !restored.has(b.id)) { restored.add(b.id); grew = true; }
    }
  }
  // ボックス・入出力・引き継ぎメモを、結果に無いものだけ残っている側から戻す (結果にあるものは、項目ごとのマージの結果を優先する)
  for (const id of restored) if (!blocks[id]) blocks[id] = keeper.blocks[id] as unknown as Dict;
  for (const port of Object.values(keeper.ports)) if (restored.has(port.blockId) && !ports[port.id]) ports[port.id] = port as unknown as Dict;
  if (keeper.handoffs) {
    const handoffs = (out.handoffs ?? {}) as Record<string, Dict>;
    for (const id of restored) if (keeper.handoffs[id] && !handoffs[id]) handoffs[id] = keeper.handoffs[id] as unknown as Dict;
    out.handoffs = handoffs;
  }
  // 線は、戻したボックスにつながっていて、両端の入出力が結果にあるものだけ戻す
  for (const e of Object.values(keeper.edges)) {
    if (edges[e.id] || !ports[e.from.portId] || !ports[e.to.portId]) continue;
    const from = keeper.ports[e.from.portId]?.blockId;
    const to = keeper.ports[e.to.portId]?.blockId;
    if ((from && restored.has(from)) || (to && restored.has(to))) edges[e.id] = e as unknown as Dict;
  }
}

/**
 * 3 方向マージ
 * Input : base = 共通の祖先, ours = 自分の版, theirs = 相手の版 (すべて fromJSON 済みの Project),
 *         choices = 競合した項目ごとの選択 (省略時は既定: ふつうは ours、削除と変更がぶつかった項目は変更された側)
 * Output: { project, merged, conflicts }
 */
export function mergeProjects(base: Project | null, ours: Project, theirs: Project, choices: ConflictChoices = {}): MergeResult {
  const r: MergeContext = { project: ours, merged: 0, conflicts: [], choices };
  const b = (base ?? undefined) as unknown as Dict | undefined;
  const o = ours as unknown as Dict;
  const th = theirs as unknown as Dict; // (文言の t() と名前が重ならないよう th)
  const out: Dict = { ...o };
  // 単純な値
  for (const k of ["name", "description", "visibility", "terminals", "contextGuard"]) out[k] = pick([k], b?.[k], o[k], th[k], r);
  // id の辞書
  for (const k of ["blocks", "ports", "edges", "agents", "handoffs"]) {
    out[k] = mergeMap([k], b?.[k] as Record<string, Dict> | undefined, (o[k] ?? {}) as Record<string, Dict>, (th[k] ?? {}) as Record<string, Dict>, r);
  }
  // 片方が消したボックスが (もう片方の変更を残すために) 残ったときは、そのボックスの親・中のボックス・入出力・線も戻して参照をそろえる
  restoreDeleted(out, ours, theirs);
  restoreDeleted(out, theirs, ours);
  // 持ち主のボックスが無い入出力・端の入出力が無い線は残さない (削除を選んだ側に、相手が変えた入出力だけが残る場合)
  const mergedBlocks = out.blocks as Record<string, Dict>;
  const mergedPorts = out.ports as Record<string, Dict>;
  const mergedEdges = out.edges as Record<string, Dict>;
  for (const [id, port] of Object.entries(mergedPorts)) if (!mergedBlocks[port.blockId as string]) delete mergedPorts[id];
  for (const [id, e] of Object.entries(mergedEdges)) {
    const edge = e as unknown as Project["edges"][string];
    if (!mergedPorts[edge.from?.portId] || !mergedPorts[edge.to?.portId]) delete mergedEdges[id];
  }
  // 引き継ぎメモも、このマージでボックスが消えたものは残さない。引き継ぎメモを使っていない (古い) 計画には、空の項目を足さない
  const mergedHandoffs = out.handoffs as Record<string, Dict>;
  for (const id of Object.keys(mergedHandoffs)) {
    if (!mergedBlocks[id] && (ours.blocks[id] || theirs.blocks[id] || base?.blocks[id])) delete mergedHandoffs[id];
  }
  if (Object.keys(mergedHandoffs).length === 0 && !ours.handoffs && !theirs.handoffs) delete out.handoffs;
  // id の配列
  out.members = mergeArrayById(["members"], base?.members, ours.members ?? [], theirs.members ?? [], r);
  out.inputGroups = mergeArrayById(["inputGroups"], base?.inputGroups, ours.inputGroups ?? [], theirs.inputGroups ?? [], r);
  // ログは両方を合わせて時刻順 (同じ id は 1 つ)
  const log = new Map<string, Project["log"][number]>();
  for (const e of [...(ours.log ?? []), ...(theirs.log ?? [])]) log.set(e.id, e);
  out.log = [...log.values()].sort((p, q) => (p.at < q.at ? -1 : p.at > q.at ? 1 : 0));
  // ボックスの短い ID (B 番号) の衝突: 両方が同じ番号を別のボックスに付けていたら、theirs 側を新しい番号に振り直す
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
      r.conflicts.push({ id: JSON.stringify(["blocks", id, "key"]), segments: ["blocks", id, "key"], automatic: true, path: `blocks.${id}.key`, ours: key, theirs: t("{key} に振り直し", { key: `B${nextKey}` }) });
      nextKey++;
    } else used.set(key, id);
  }
  out.nextKey = nextKey;
  r.project = out as unknown as Project;
  return { project: r.project, merged: r.merged, conflicts: r.conflicts };
}
