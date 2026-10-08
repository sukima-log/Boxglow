/**
 * Undo/Redoへ反映する外部差分。更新回数分の計画や処理列は保持せず、項目ごとの最新値に合成する。
 * 入力の計画と履歴は変更しない。同じ項目が元の値へ戻った場合も、外部が触った事実を保つ。
 */
import type { Project } from "../model/types";
import { toJSON } from "../model/graph";
import { validateProjectText } from "../model/validate-file";

type Dict = Record<string, unknown>;
type EntityChange = { replace: true; value: unknown } | { replace: false; fields: Dict; before: Dict; missing?: boolean };
export interface HistoryPatch { fields: Dict; before: Dict; maps: Record<string, Record<string, EntityChange>> }
const MAPS = ["blocks", "ports", "edges", "agents", "handoffs", "members", "inputGroups", "log"];
const ARRAYS = new Set(["members", "inputGroups", "log"]);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const dict = (value: unknown): Dict => (value ?? {}) as Dict;
const entityMap = (p: Project, key: string): Dict => ARRAYS.has(key)
  ? Object.fromEntries(((p as unknown as Dict)[key] as { id: string }[] ?? []).map(v => [v.id, v]))
  : dict((p as unknown as Dict)[key]);
const diff = (before: Dict, after: Dict): Dict => Object.fromEntries(
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => !same(before[k], after[k])).map(k => [k, after[k]]));
const applyFields = (source: Dict, fields: Dict): Dict => {
  const next = { ...source };
  for (const [key, value] of Object.entries(fields)) { if (value === undefined) delete next[key]; else next[key] = value; }
  return next;
};

/** 入力: 保存の旧基準と外部の最新。出力: mergeと同じ項目粒度の差分だけ。全文への参照を持たない。 */
export function externalHistoryPatch(base: Project | null, remote: Project): HistoryPatch {
  const fields = diff(dict(base), dict(remote));
  const maps: HistoryPatch["maps"] = {};
  for (const key of MAPS) {
    delete fields[key];
    const before = base ? entityMap(base, key) : {}, after = entityMap(remote, key);
    const changes: Record<string, EntityChange> = {};
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[id], a = after[id];
      if (same(b, a) || (key === "log" && a === undefined)) continue;
      if (!b || !a || key === "handoffs" || key === "log") changes[id] = { replace: true, value: a };
      else {
        const fields = diff(dict(b), dict(a));
        changes[id] = { replace: false, fields, before: Object.fromEntries(Object.keys(fields).map(k => [k, dict(b)[k]])) };
      }
    }
    if (Object.keys(changes).length) maps[key] = changes;
  }
  return { fields, before: Object.fromEntries(Object.keys(fields).map(k => [k, dict(base)[k]])), maps };
}

/** 入力: 既存予約と今回の外部差分。出力: 更新回数に依存しない、最新値へ合成した予約。 */
export function combineHistoryPatch(previous: HistoryPatch | undefined, delta: HistoryPatch): HistoryPatch {
  if (!previous) return delta;
  const maps = { ...previous.maps };
  for (const [key, changes] of Object.entries(delta.maps)) {
    const combined = { ...maps[key] };
    for (const [id, change] of Object.entries(changes)) {
      const old = combined[id];
      if (change.replace || !old) combined[id] = change;
      else if (old.replace) combined[id] = old.value ? { replace: true, value: applyFields(dict(old.value), change.fields) } : { ...change, missing: true };
      else combined[id] = { ...change, fields: { ...old.fields, ...change.fields }, before: { ...change.before, ...old.before }, missing: old.missing || change.missing };
    }
    maps[key] = combined;
  }
  return { fields: { ...previous.fields, ...delta.fields }, before: { ...delta.before, ...previous.before }, maps };
}

/** 入力: 履歴の1段と合成済み予約。出力: 外部変更を保つ有効な計画。矛盾する段はnull。 */
export function applyHistoryPatch(snapshot: Project, patch: HistoryPatch): Project | null {
  try {
    const next = applyFields(dict(snapshot), patch.fields);
    for (const [key, changes] of Object.entries(patch.maps)) {
      const values = { ...entityMap(snapshot, key) };
      for (const [id, change] of Object.entries(changes)) {
        if (change.replace) { if (change.value === undefined) delete values[id]; else values[id] = change.value; }
        else {
          // その段に存在しない対象は復元しない。周辺の入出力を欠く半端な復活になるため。
          if (!values[id] || change.missing) return null;
          values[id] = applyFields(dict(values[id]), change.fields);
        }
      }
      next[key] = ARRAYS.has(key) ? Object.values(values) : values;
    }
    // mergeと同じ参照整理。親を失うボックスは復元せず、下の検証でその履歴を拒否する。
    const p = next as unknown as Project;
    p.ports = { ...p.ports }; p.edges = { ...p.edges };
    for (const [id, port] of Object.entries(p.ports)) if (!p.blocks[port.blockId]) {
      if (patch.maps.ports?.[id]) return null;
      delete p.ports[id];
    }
    for (const [id, edge] of Object.entries(p.edges)) if (!p.ports[edge.from.portId] || !p.ports[edge.to.portId]) {
      if (patch.maps.edges?.[id]) return null;
      delete p.edges[id];
    }
    if (p.focusBlockId && !p.blocks[p.focusBlockId]) delete p.focusBlockId;
    if (p.handoffs) p.handoffs = Object.fromEntries(Object.entries(p.handoffs).filter(([id]) => p.blocks[id] || !snapshot.blocks[id]));
    const normalized = validateProjectText(toJSON(p));
    // fromJSONは失われたメンバー/入力グループ参照を正規化する。外部が予約した値を
    // その過程で落とすなら、成功したUndoとして保存せず、ポート・配線と同じ境界にする。
    const reserved = (change: EntityChange, field: string) => change.replace
      ? change.value !== undefined && Object.hasOwn(dict(change.value), field)
      : Object.hasOwn(change.fields, field);
    for (const [id, change] of Object.entries(patch.maps.blocks ?? {})) {
      if (reserved(change, "assigneeIds") && !same(p.blocks[id]?.assigneeIds, normalized.blocks[id]?.assigneeIds)) return null;
    }
    for (const [id, change] of Object.entries(patch.maps.ports ?? {})) {
      if (reserved(change, "groupId") && !same(p.ports[id]?.groupId, normalized.ports[id]?.groupId)) return null;
    }
    return normalized;
  } catch { return null; }
}

/** 外部更新前と異なる履歴の値を、予約の最新値が上書きする場合は部分的なUndo/Redoとして知らせる。 */
export function historyPatchMasksChanges(snapshot: Project, patch: HistoryPatch): boolean {
  const masks = (value: Dict, before: Dict, after: Dict) => Object.keys(after).some(k => !same(value[k], before[k]) && !same(value[k], after[k]));
  const editable=Object.fromEntries(Object.entries(patch.fields).filter(([key])=>!["id","claims","claimPolicy"].includes(key)));
  if (masks(dict(snapshot), patch.before, editable)) return true;
  return Object.entries(patch.maps).some(([key, changes]) => {
    const values = entityMap(snapshot, key);
    return Object.entries(changes).some(([id, change]) => !change.replace && !!values[id] && masks(dict(values[id]), change.before, change.fields));
  });
}
