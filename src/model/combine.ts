/**
 * 計画のファイルの結合と分割 (B154)
 *   結合: 別の計画を、1 つのファイルの中の「別のプロジェクトの箱」として取り込む。箱・ポート・線・判断・記録・成果物・受け持ち・引き継ぎは
 *         ID を付け直して全部残す (ID と番号 B<n> が重なっても壊れない)。メンバーは名前で合わせる。最上位の入力 / 出力も取り込む
 *   分割: プロジェクトの箱 1 つを、別の計画として切り出す。ファイルをまたぐ線は切り、両側に「どこから来る / どこへ行く」が分かる
 *         最上位の入力 / 出力ノードを残す (一度きりの変換。分けたまま同期し続ける仕組みは作らない)
 *   どちらもファイル形式の版は変えない
 */
import { t } from "../i18n/core";
import { createProject, LOG_LIMIT, newId, projectBlocks } from "./graph";
import { ROOT_ID, type Edge, type Port, type Project } from "./types";

const nowIso = (): string => new Date().toISOString();

/**
 * 深い置き換え: map にある文字列 (値と、オブジェクトのキー) を置き換える。ID が重なっても取り込めるようにするため
 * Input : value = 何でも, map = 旧 ID → 新 ID。Output: 置き換えた複製
 */
function remap<T>(value: T, map: Map<string, string>): T {
  if (typeof value === "string") return (map.get(value) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => remap(v, map)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[map.get(k) ?? k] = remap(v, map);
    return out as T;
  }
  return value;
}

/** 番号 B<n> を、使われていない番号で付け直す。Input: q = 付け直す計画 (複製済み), ids = 対象の箱。Output: なし (q を書き換える) */
function renumber(q: Project, ids: string[]): void {
  const used = new Set(Object.values(q.blocks).map((b) => b.key).filter((k): k is string => !!k));
  for (const id of ids) used.delete(q.blocks[id]?.key ?? "");
  let n = q.nextKey ?? 1;
  for (const id of ids) {
    const b = q.blocks[id];
    if (!b || id === ROOT_ID) continue;
    while (used.has(`B${n}`)) n++;
    b.key = `B${n}`; used.add(b.key); n++;
  }
  q.nextKey = Math.max(n, q.nextKey ?? 1);
}

/**
 * 結合: source の中身を target に取り込む
 * Input : target = 取り込む先, source = 取り込む計画, sourceLabel = 記録に書く名前 (省くと source.name)
 * Output: 取り込んだ後の計画 (target は変えない)。source の各プロジェクトの箱は、target の最上位に (既存の下に) 並ぶ
 */
export function combineProjects(target: Project, source: Project, sourceLabel?: string): Project {
  const q = structuredClone(target);
  const map = new Map<string, string>();
  for (const id of Object.keys(source.blocks)) if (id !== ROOT_ID) map.set(id, newId());
  for (const id of Object.keys(source.ports)) map.set(id, newId());
  for (const id of Object.keys(source.edges)) map.set(id, newId());
  for (const g of source.inputGroups ?? []) map.set(g.id, newId());
  for (const b of Object.values(source.blocks)) for (const d of b.decisions ?? []) map.set(d.id, newId());
  for (const e of source.log ?? []) map.set(e.id, newId());
  // メンバーは名前で合わせる (同じ名前があればその人、無ければ新しい ID)
  for (const m of source.members) {
    const same = q.members.find((x) => x.name.trim().toLowerCase() === m.name.trim().toLowerCase());
    map.set(m.id, same ? same.id : newId());
  }
  const s = remap(structuredClone(source), map);
  // プロジェクトの箱は、既存の下に並べる (中の箱の位置は親からの相対なのでそのまま)
  const existing = projectBlocks(q);
  const baseY = existing.length ? Math.max(...existing.map((b) => b.position.y)) + 400 : 40;
  const incoming = projectBlocks(s);
  const minY = incoming.length ? Math.min(...incoming.map((b) => b.position.y)) : 0;
  const copied: string[] = [];
  for (const b of Object.values(s.blocks)) {
    if (b.id === ROOT_ID) continue;
    if (b.kind === "project") b.position = { ...b.position, y: b.position.y - minY + baseY };
    q.blocks[b.id] = b; copied.push(b.id);
  }
  renumber(q, copied);
  Object.assign(q.ports, s.ports);
  Object.assign(q.edges, s.edges);
  for (const m of s.members) if (!q.members.some((x) => x.id === m.id)) q.members.push(m);
  if (s.inputGroups?.length) q.inputGroups = [...(q.inputGroups ?? []), ...s.inputGroups];
  if (s.now?.length) q.now = [...(q.now ?? []), ...s.now];
  if (s.claims && Object.keys(s.claims).length) q.claims = { ...(q.claims ?? {}), ...s.claims };
  if (s.handoffs && Object.keys(s.handoffs).length) q.handoffs = { ...(q.handoffs ?? {}), ...s.handoffs };
  for (const [actor, seen] of Object.entries(s.agents ?? {})) if (!q.agents[actor] || q.agents[actor].lastSeen < seen.lastSeen) q.agents[actor] = seen;
  const label = sourceLabel ?? source.name;
  // (日時では並べ替えない: それぞれの中では古い順のまま。取り込んだ記録の後に、結合の記録を 1 つ足す)
  q.log = [...q.log, ...(s.log ?? []), { id: newId(), at: nowIso(), actor: "human", kind: "note" as const, message: t("結合: 「{name}」を取り込んだ (箱 {n} 個)", { name: label, n: String(copied.length) }) }].slice(-LOG_LIMIT);
  return q;
}

/** 箱とその下の階層の ID を集める。Input: p, rootId。Output: ID の集合 (rootId を含む) */
export function subtreeIds(p: Project, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) { grew = false; for (const b of Object.values(p.blocks)) if (b.parentId && ids.has(b.parentId) && !ids.has(b.id)) { ids.add(b.id); grew = true; } }
  return ids;
}

/**
 * 分割: プロジェクトの箱 1 つを別の計画として切り出す
 * Input : p = 元の計画, projectBlockId = 切り出すプロジェクトの箱, extractedName = 切り出した計画の名前 (省くと箱の題名)
 * Output: { remaining: 箱を除いた元の計画, extracted: 切り出した計画 }。ファイルをまたぐ線は、両側の最上位の入力 / 出力ノードに由来を書いて残す
 */
export function splitProject(p: Project, projectBlockId: string, extractedName?: string): { remaining: Project; extracted: Project } {
  const box = p.blocks[projectBlockId];
  if (!box || box.kind !== "project" || box.parentId !== ROOT_ID) throw new Error(t("最上位のプロジェクトの箱を指定してください"));
  if (projectBlocks(p).length < 2) throw new Error(t("プロジェクトの箱が 1 つだけの計画は分けられません"));
  const ids = subtreeIds(p, projectBlockId);
  const name = extractedName ?? box.title;
  // 切り出し先: 空の計画 (createProject が足す既定のプロジェクトの箱は使わない)
  const base = createProject(name);
  const extracted: Project = { ...base, blocks: { [ROOT_ID]: { ...base.blocks[ROOT_ID] } }, ports: {}, edges: {}, members: [], lang: p.lang, visibility: p.visibility, inputGroups: undefined, nextKey: 1 };
  const remaining = structuredClone(p);
  const ownerOf = (portId: string): string | null => p.ports[portId]?.blockId ?? null;
  const inSub = (portId: string): boolean => { const o = ownerOf(portId); return o !== null && ids.has(o); };
  const isRoot = (portId: string): boolean => ownerOf(portId) === ROOT_ID;
  // 箱とポートを移す
  for (const id of ids) { extracted.blocks[id] = structuredClone(p.blocks[id]); delete remaining.blocks[id]; }
  extracted.blocks[projectBlockId].position = { x: 300, y: 40 };
  for (const port of Object.values(p.ports)) if (ids.has(port.blockId)) { extracted.ports[port.id] = structuredClone(port); delete remaining.ports[port.id]; }
  // 線: 両端が中なら移す。片方が外 (最上位の入力 / 出力、または別のプロジェクト) なら切って、両側にノードを残す
  const crossing: string[] = [];
  for (const e of Object.values(p.edges)) {
    const fromIn = inSub(e.from.portId), toIn = inSub(e.to.portId);
    if (fromIn && toIn) { extracted.edges[e.id] = structuredClone(e); delete remaining.edges[e.id]; continue; }
    if (!fromIn && !toIn) continue;
    delete remaining.edges[e.id];
    crossing.push(e.id);
    const innerPortId = fromIn ? e.from.portId : e.to.portId;
    const outerPortId = fromIn ? e.to.portId : e.from.portId;
    const outer = p.ports[outerPortId];
    const outerOwner = outer ? p.blocks[outer.blockId] : undefined;
    const where = isRoot(outerPortId) ? p.name : `${p.name} / ${outerOwner?.title ?? ""}`;
    // 切り出し側: 最上位の入力 (外から来る) か出力 (外へ行く) を作り、中のポートとつなぐ
    const term: Port = { id: newId(), blockId: ROOT_ID, direction: fromIn ? "out" : "in", name: outer?.name ?? p.ports[innerPortId]?.name ?? "", description: fromIn ? t("行き先: {where}", { where }) : t("元: {where}", { where }), required: outer?.required ?? true, artifacts: [] };
    extracted.ports[term.id] = term;
    const ne: Edge = { ...structuredClone(e), id: newId(), from: fromIn ? e.from : { portId: term.id, side: "outer" }, to: fromIn ? { portId: term.id, side: "outer" } : e.to, auto: false };
    extracted.edges[ne.id] = ne;
    // 残す側: 相手が別のプロジェクトの箱なら、最上位の入力 (切り出した側から来る) か出力 (切り出した側へ行く) を作ってつなぐ。最上位の入力 / 出力が相手なら、そのノードはそのまま残る
    if (!isRoot(outerPortId) && outer) {
      const inner = p.ports[innerPortId];
      const stub: Port = { id: newId(), blockId: ROOT_ID, direction: fromIn ? "in" : "out", name: inner?.name ?? outer.name, description: fromIn ? t("元: {where}", { where: `${name} / ${p.blocks[inner?.blockId ?? ""]?.title ?? ""}` }) : t("行き先: {where}", { where: `${name} / ${p.blocks[inner?.blockId ?? ""]?.title ?? ""}` }), required: true, artifacts: [] };
      remaining.ports[stub.id] = stub;
      const re: Edge = { ...structuredClone(e), id: newId(), from: fromIn ? { portId: stub.id, side: "outer" } : e.from, to: fromIn ? e.to : { portId: stub.id, side: "outer" }, auto: false };
      remaining.edges[re.id] = re;
    }
  }
  // メンバー: 中で参照しているものだけ写す (ID はそのまま)
  const used = new Set<string>();
  for (const id of ids) for (const a of p.blocks[id].assigneeIds ?? []) used.add(a);
  for (const e of p.log) if (e.blockId && ids.has(e.blockId)) { /* 書き手はメンバーではない */ }
  extracted.members = p.members.filter((m) => used.has(m.id)).map((m) => structuredClone(m));
  // 記録・NOW・受け持ち・引き継ぎ: 中のものを移す
  extracted.log = p.log.filter((e) => e.blockId && ids.has(e.blockId)).map((e) => structuredClone(e));
  remaining.log = remaining.log.filter((e) => !(e.blockId && ids.has(e.blockId)));
  if (p.now?.length) { extracted.now = p.now.filter((n) => ids.has(n.blockId)); remaining.now = p.now.filter((n) => !ids.has(n.blockId)); }
  if (p.claims) { extracted.claims = Object.fromEntries(Object.entries(p.claims).filter(([k]) => ids.has(k))); remaining.claims = Object.fromEntries(Object.entries(p.claims).filter(([k]) => !ids.has(k))); extracted.claimPolicy = p.claimPolicy; }
  if (p.handoffs) { extracted.handoffs = Object.fromEntries(Object.entries(p.handoffs).filter(([k]) => ids.has(k))); remaining.handoffs = Object.fromEntries(Object.entries(p.handoffs).filter(([k]) => !ids.has(k))); }
  if (p.focusBlockId && ids.has(p.focusBlockId)) { extracted.focusBlockId = p.focusBlockId; delete remaining.focusBlockId; }
  extracted.agents = structuredClone(p.agents);
  // 番号: 切り出し側はそのまま (ファイルの中で一意)。次の番号は最大 + 1
  const maxKey = (q: Project) => Math.max(0, ...Object.values(q.blocks).map((b) => Number(/^B(\d+)$/.exec(b.key ?? "")?.[1] ?? 0)));
  extracted.nextKey = maxKey(extracted) + 1;
  remaining.nextKey = Math.max(remaining.nextKey ?? 1, maxKey(remaining) + 1);
  const at = nowIso();
  extracted.log = [...extracted.log, { id: newId(), at, actor: "human", kind: "note" as const, message: t("分割: 「{from}」から切り出した (またぐ線 {n} 本)", { from: p.name, n: String(crossing.length) }) }].slice(-LOG_LIMIT);
  remaining.log = [...remaining.log, { id: newId(), at, actor: "human", kind: "note" as const, message: t("分割: 「{name}」を別の計画に切り出した (またぐ線 {n} 本)", { name, n: String(crossing.length) }) }].slice(-LOG_LIMIT);
  return { remaining, extracted };
}
