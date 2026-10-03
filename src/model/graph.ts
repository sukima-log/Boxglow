/**
 * ブロック図の操作 (純粋関数)
 *
 * すべての関数は Project を受け取り、変更後の新しい Project を返す (引数は変更しない)。
 * 画面 (React) や保存 (IndexedDB) に依存しないので、単体テストで結線ルールを検証できる。
 */
import { categoryOf } from "./categories";
// 文言の言語切り替え (React に依存しない core を使う。CLI の束に React を入れないため)
import { t } from "../i18n/core";
import { nanoid } from "nanoid";
import {
  ROOT_ID
, SCHEMA_VERSION
, type ActivityState
, type Artifact
, type Block
, type BlockKind
, type BlockStatus
, type BlockTemplate
, type Decision
, type Edge
, type EdgeKind
, type Endpoint
, type InputGroup
, type LogKind
, type Member
, type Port
, type Project
, type TemplateNode
, type TemplateOrigin
} from "./types";

/** ログに残す上限 (古いものから落とす) */
export const LOG_LIMIT = 500;

/** id を作る (短い英数字) */
export const newId = (): string => nanoid(10);

/** 現在時刻の ISO 文字列 */
const now = (): string => new Date().toISOString();

/** Project の深い複製 (元を変更しないため) */
const clone = <T>(value: T): T => structuredClone(value);

/** 次の短い ID (B1, B2, ...) を払い出す (呼び出し側で複製済みの Project を渡す) */
function nextKey(q: Project): string {
  const n = q.nextKey ?? 1;
  q.nextKey = n + 1;
  return `B${n}`;
}

/** 短い ID が無い箱に付ける (古いデータの移行用。呼び出し側で複製済み) */
function ensureKeys(q: Project): void {
  const used = new Set<string>();
  for (const b of Object.values(q.blocks)) if (b.key) used.add(b.key);
  let n = q.nextKey ?? 1;
  for (const b of Object.values(q.blocks)) {
    if (b.id === ROOT_ID || b.key) continue;
    while (used.has(`B${n}`)) n++;
    b.key = `B${n}`;
    used.add(b.key);
    n++;
  }
  q.nextKey = Math.max(n, q.nextKey ?? 1);
}

/** 子ブロックを置くときの親の内側の余白 (px)。top は見出し (題名 + 情報の行) の下にさらに空ける分 */
export const CHILD_PADDING = { left: 120, top: 76 }; // 左: 親の入力から子へ下りる線の通路 (縁から 36px + 線 3 本分)
/** 親の見出しの高さの既定 (size.ts と同じ 36 + 24)。題名が折り返すと size.ts 側で増える */
const DEFAULT_HEADER_H = 60;

/** 子を置ける一番上の y (親の座標系) */
export function childTop(p: Project, parentId: string): number {
  const b = p.blocks[parentId];
  if (!b) return CHILD_PADDING.top;
  // 題名が長いと見出しが伸びるので、その分を足す (size.ts の見積もりと同じ式)
  const lines = Math.min(3, Math.max(1, Math.ceil((b.title.length * 14) / 400)));
  return DEFAULT_HEADER_H + (lines - 1) * 18 + 16;
}

/* ------------------------------------------------------------------ */
/* 生成                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 空のプロジェクトを作る
 * Input : name = プロジェクト名
 * Output: 最上位ブロック (ROOT_ID) と、既定の出力ポート 1 つを持つ Project
 */
export function createProject(name: string): Project {
  const ts = now(); // (文言の t() と名前が重ならないよう ts)
  const root: Block = {
    id: ROOT_ID
  , parentId: null
  , title: name
  , description: ""
  , status: "black"
  , assigneeIds: []
  , position: { x: 0, y: 0 }
  , collapsed: false
  , artifacts: []
  , activity: null
  , decisions: []
  };
  const outPort: Port = {
    id: newId()
  , blockId: ROOT_ID
  , direction: "out"
  , name: t("最終成果物") // 既定の名前は作成時の言語で計画に書き込む
  , description: ""
  , required: true
  , artifacts: []
  };
  const base: Project = {
    schemaVersion: SCHEMA_VERSION
  , id: newId()
  , name
  , description: ""
  , createdAt: ts
  , visibility: "private"
  , members: []
  , blocks: { [ROOT_ID]: root }
  , ports: { [outPort.id]: outPort }
  , edges: {}
  , terminals: { in: { x: 0, y: 200 }, out: { x: 1100, y: 200 } }
  , log: []
  , agents: {}
  , nextKey: 1
  };
  // 最上位にはプロジェクトの箱を 1 つ置き、その出力を最終成果物につなぐ (タスクはこの箱の中に置く)
  return addProjectBlock(base, name).project;
}

/**
 * プロジェクトの箱を最上位に足す (同じファイルに複数のプロジェクトを置ける)
 * Input : name = プロジェクト名
 * Output: { project, blockId } (箱の出力「最終成果物」は、最上位の最終成果物 (同名を作る) につながる)
 */
export function addProjectBlock(p: Project, name: string): { project: Project; blockId: string } {
  const q = clone(p);
  const existing = projectBlocks(q);
  const id = newId();
  const y = existing.length === 0 ? 40 : Math.max(...existing.map((b) => b.position.y)) + 400;
  q.blocks[id] = {
    id
  , key: nextKey(q)
  , kind: "project"
  , parentId: ROOT_ID
  , title: name
  , description: ""
  , status: "black"
  , assigneeIds: []
  , position: { x: 300, y }
  , collapsed: false
  , artifacts: []
  , activity: null
  , decisions: []
  };
  const out: Port = { id: newId(), blockId: id, direction: "out", name: t("最終成果物"), description: "", required: true, artifacts: [] };
  q.ports[out.id] = out;
  // 最上位の最終成果物: まだ誰ともつながっていないものがあればそれへ、無ければ同名を作る
  let rootOut = portsOf(q, ROOT_ID, "out").find((o) => incomingEdges(q, { portId: o.id, side: "inner" }).length === 0);
  if (!rootOut) {
    rootOut = { id: newId(), blockId: ROOT_ID, direction: "out", name: existing.length === 0 ? t("最終成果物") : t("{name} の成果物", { name }), description: "", required: true, artifacts: [] };
    q.ports[rootOut.id] = rootOut;
  }
  const eid = newId();
  q.edges[eid] = { id: eid, from: { portId: out.id, side: "outer" }, to: { portId: rootOut.id, side: "inner" }, kind: "up", auto: false };
  return { project: q, blockId: id };
}

/** 最上位のプロジェクトの箱の一覧 */
export function projectBlocks(p: Project): Block[] {
  return childrenOf(p, ROOT_ID).filter((b) => b.kind === "project");
}

/** 既定でタスクを置く場所 (最初のプロジェクトの箱。無ければ最上位) */
export function defaultTaskParent(p: Project): string {
  return projectBlocks(p)[0]?.id ?? ROOT_ID;
}

/**
 * 「大項目」の箱 (プロジェクトの箱の直下。プロジェクトの箱が無ければ最上位の箱)。
 * All の画面にはこの階層までしか出さず (常に畳む)、中はそれぞれのタブで見る
 * Input : p
 * Output: 大項目の箱の配列 (配置の上から、同じ高さなら左から)
 */
export function majorBlocks(p: Project): Block[] {
  const projects = projectBlocks(p);
  const parents = projects.length > 0 ? projects.map((b) => b.id) : [ROOT_ID];
  const out: Block[] = [];
  for (const pid of parents) out.push(...childrenOf(p, pid).filter((b) => kindOf(b) !== "project"));
  return out.sort((a, b) => (a.position.y - b.position.y) || (a.position.x - b.position.x));
}

/**
 * 箱が属する大項目 (自分が大項目ならその id。大項目より上 (プロジェクトの箱・最上位) なら null)
 * Input : p, blockId
 * Output: 大項目の id または null
 */
export function majorOf(p: Project, blockId: string): string | null {
  const majors = new Set(majorBlocks(p).map((b) => b.id));
  let cur: string | null = blockId;
  while (cur !== null) {
    if (majors.has(cur)) return cur;
    cur = p.blocks[cur]?.parentId ?? null;
  }
  return null;
}

/**
 * 箱が表示範囲 (scope の箱とその中) に入っているか
 * Input : p, scope = 範囲の箱の id, blockId = 調べる箱 (null なら「入っていない」)
 * Output: true = 範囲の中 (scope 自身も含む)
 */
export function isInScope(p: Project, scope: string, blockId: string | null): boolean {
  let cur: string | null = blockId;
  while (cur !== null) {
    if (cur === scope) return true;
    cur = p.blocks[cur]?.parentId ?? null;
  }
  return false;
}

/**
 * 大項目の箱は常に畳んだ状態にそろえる (All の図は大項目までしか出さず、中はタブで見る。大項目の中の箱は入れ子のまま見せる)。
 * 並べるときの大きさの計算もこの状態で行う
 * Input : p
 * Output: 大項目の collapsed を true にした複製 (変える物が無ければ p そのもの)
 */
export function normalizeCollapsed(p: Project): Project {
  const ids = majorBlocks(p).filter((b) => !b.collapsed).map((b) => b.id);
  if (ids.length === 0) return p;
  const blocks = { ...p.blocks };
  for (const id of ids) blocks[id] = { ...blocks[id], collapsed: true };
  return { ...p, blocks };
}

/**
 * 箱が見える画面 (開いておくべきタブ)。大項目の中の箱ならその大項目のタブ、大項目そのものや上の階層なら All (null)
 * Input : p, blockId
 * Output: 大項目の id または null (= All)
 */
export function scopeFor(p: Project, blockId: string): string | null {
  const major = majorOf(p, blockId);
  return major && major !== blockId ? major : null;
}

/**
 * 開いている箱から大項目までの道 (パンくず用)。大項目が先頭、開いている箱が末尾
 * Input : p, scope = 開いている箱の id
 * Output: 箱の配列 (scope が大項目なら 1 個)
 */
export function scopePath(p: Project, scope: string): Block[] {
  const out: Block[] = [];
  let cur: string | null = scope;
  while (cur !== null && cur !== ROOT_ID) {
    const b: Block | undefined = p.blocks[cur];
    if (!b || kindOf(b) === "project") break;
    out.unshift(b);
    cur = b.parentId;
  }
  return out;
}

/** ブロックの種類 (省略時は task) */
export const kindOf = (b: Block): BlockKind => b.kind ?? "task";

/**
 * 空の成果物を作る
 * Input : title = 表示名, url = リンク先 (省略可)
 * Output: Artifact
 */
export function createArtifact(title: string, url = ""): Artifact {
  return { id: newId(), title, url, kind: url ? "url" : "note", note: "" };
}

/**
 * Git で管理されたファイルの成果物を作る (アップロードしない。コミット + パス + blob で記録)
 * Input : title, git = { repo, path, commit, blob, url? }
 * Output: Artifact (kind: git, state: ok)
 */
export function createGitArtifact(title: string, git: { repo: string; path: string; commit: string; blob: string; url?: string }): Artifact {
  return { id: newId(), title, url: git.url ?? "", kind: "git", note: "", repo: git.repo, path: git.path, commit: git.commit, blob: git.blob, state: "ok", checkedAt: now() };
}

/* ------------------------------------------------------------------ */
/* 参照 (読み取り)                                                       */
/* ------------------------------------------------------------------ */

/**
 * 参照の索引 (表示用): portsOf / childrenOf は毎回 Object.values を走査する (ポート 300 x 呼び出し数千で数百 ms)。
 * Project を書き換えない処理 (画面の構築) の間だけ、withIndex で索引を作って引く。
 * 索引は p.ports / p.blocks のオブジェクトの同一性で有効性を判定する (別の Project には使わない)。
 * 注意: 索引が有効な間に p.blocks / p.ports の中身を書き換えてはいけない (childrenOf は false にして無効にできる)
 */
let index: { ports: Project["ports"]; portsByBlock: Map<string, Port[]>; blocks: Project["blocks"] | null; kidsByParent: Map<string, Block[]> } | null = null;

/**
 * fn の間だけ p の索引を使う
 * Input : p = 参照する Project, fn = その間に行う処理, opts.children = false なら childrenOf は索引を使わない (箱を差し替える処理向け)
 * Output: fn の戻り値
 */
export function withIndex<T>(p: Project, fn: () => T, opts: { children?: boolean } = {}): T {
  const portsByBlock = new Map<string, Port[]>();
  for (const q of Object.values(p.ports)) {
    const list = portsByBlock.get(q.blockId) ?? [];
    list.push(q);
    portsByBlock.set(q.blockId, list);
  }
  const kidsByParent = new Map<string, Block[]>();
  if (opts.children !== false) {
    for (const b of Object.values(p.blocks)) {
      if (b.parentId === null) continue;
      const list = kidsByParent.get(b.parentId) ?? [];
      list.push(b);
      kidsByParent.set(b.parentId, list);
    }
  }
  const prev = index;
  index = { ports: p.ports, portsByBlock, blocks: opts.children !== false ? p.blocks : null, kidsByParent };
  try {
    return fn();
  } finally {
    index = prev;
  }
}

/** ブロックの子ブロック一覧 */
export function childrenOf(p: Project, blockId: string): Block[] {
  if (index && index.blocks === p.blocks) return (index.kidsByParent.get(blockId) ?? []).slice();
  return Object.values(p.blocks).filter((b) => b.parentId === blockId);
}

/** ブロックの子孫ブロック一覧 (自分は含まない) */
export function descendantsOf(p: Project, blockId: string): Block[] {
  const out: Block[] = [];
  const stack = [blockId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const c of childrenOf(p, id)) {
      out.push(c);
      stack.push(c.id);
    }
  }
  return out;
}

/** ブロックの祖先 (親, 祖父, ... ROOT まで。近い順) */
export function ancestorsOf(p: Project, blockId: string): Block[] {
  const out: Block[] = [];
  let cur = p.blocks[blockId]?.parentId ?? null;
  while (cur !== null) {
    const b = p.blocks[cur];
    if (!b) break;
    out.push(b);
    cur = b.parentId;
  }
  return out;
}

/** ブロックのポート一覧 (direction を指定すればその向きだけ) */
export function portsOf(p: Project, blockId: string, direction?: "in" | "out"): Port[] {
  if (index && index.ports === p.ports) {
    const list = index.portsByBlock.get(blockId) ?? [];
    return direction === undefined ? list.slice() : list.filter((q) => q.direction === direction);
  }
  return Object.values(p.ports).filter((q) => q.blockId === blockId && (direction === undefined || q.direction === direction));
}

/** 端点が同じかどうか */
export const sameEndpoint = (a: Endpoint, b: Endpoint): boolean => a.portId === b.portId && a.side === b.side;

/** 端点に入ってくる線 (to が一致する線) */
export function incomingEdges(p: Project, ep: Endpoint): Edge[] {
  return Object.values(p.edges).filter((e) => sameEndpoint(e.to, ep));
}

/** 端点から出ていく線 (from が一致する線) */
export function outgoingEdges(p: Project, ep: Endpoint): Edge[] {
  return Object.values(p.edges).filter((e) => sameEndpoint(e.from, ep));
}

/**
 * 端点が属する「階層 (scope)」のブロック id
 *   outer 面 -> そのブロックの親の階層, inner 面 -> そのブロック自身の階層
 * Output: 階層のブロック id。最上位ブロックの outer 面は外に出られないので null
 */
export function scopeOf(p: Project, ep: Endpoint): string | null {
  const port = p.ports[ep.portId];
  if (!port) return null;
  const block = p.blocks[port.blockId];
  if (!block) return null;
  return ep.side === "inner" ? block.id : block.parentId;
}

/** ブロックが畳まれた祖先の中にある (= 画面に出ない) か */
export function isHiddenByCollapse(p: Project, blockId: string): boolean {
  return ancestorsOf(p, blockId).some((a) => a.collapsed);
}

/* ------------------------------------------------------------------ */
/* 結線の検証                                                             */
/* ------------------------------------------------------------------ */

export interface ConnectionCheck {
  ok: boolean;
  /** ok = false のときの理由 (画面に表示する日本語)。ok = true なら線の種類 */
  reason?: string;
  kind?: EdgeKind;
}

/**
 * 結線できるかを判定する
 * Input : from = 出す側の端点, to = 受ける側の端点
 * Output: ok と、ok なら線の種類 (kind)、だめなら理由 (reason)
 */
export function validateConnection(p: Project, from: Endpoint, to: Endpoint): ConnectionCheck {
  const fp = p.ports[from.portId];
  const tp = p.ports[to.portId];
  if (!fp || !tp) return { ok: false, reason: t("ポートが見つかりません") };
  if (from.portId === to.portId) return { ok: false, reason: t("同じポートどうしはつなげません") };

  // 出す側は「出力の外側」か「入力の内側 (親の入力を中へ流す)」だけ
  const fromIsSource = (fp.direction === "out" && from.side === "outer") || (fp.direction === "in" && from.side === "inner");
  // 受ける側は「入力の外側」か「出力の内側 (子の出力を親の出力へ)」だけ
  const toIsTarget = (tp.direction === "in" && to.side === "outer") || (tp.direction === "out" && to.side === "inner");
  if (!fromIsSource) return { ok: false, reason: t("線は出力ポート (または親の入力) から引いてください") };
  if (!toIsTarget) return { ok: false, reason: t("線は入力ポート (または親の出力) につないでください") };

  // 同じ階層の中でしかつなげない
  const sf = scopeOf(p, from);
  const st = scopeOf(p, to);
  if (sf === null || st === null || sf !== st) return { ok: false, reason: t("同じ階層のポートどうしだけつなげます") };

  // 線の種類
  let kind: EdgeKind;
  if (fp.direction === "out" && tp.direction === "in") kind = "sibling";
  else if (fp.direction === "out" && tp.direction === "out") kind = "up";
  else if (fp.direction === "in" && tp.direction === "in") kind = "down";
  else kind = "through";

  // 循環の禁止 (同じ階層のブロック間の依存で輪ができないか)
  if (kind === "sibling" && wouldCreateCycle(p, fp.blockId, tp.blockId)) {
    return { ok: false, reason: t("循環する結線はできません") };
  }
  return { ok: true, kind };
}

/**
 * fromBlock -> toBlock の依存を足すと、同じ階層で輪ができるか
 * (toBlock から出力をたどって fromBlock に戻れるなら輪になる)
 */
function wouldCreateCycle(p: Project, fromBlock: string, toBlock: string): boolean {
  if (fromBlock === toBlock) return true;
  const visited = new Set<string>();
  const stack = [toBlock];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === fromBlock) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    // cur の出力ポート (outer) から出る sibling 線の先のブロック
    for (const port of portsOf(p, cur, "out")) {
      for (const e of outgoingEdges(p, { portId: port.id, side: "outer" })) {
        if (e.kind !== "sibling") continue;
        const next = p.ports[e.to.portId]?.blockId;
        if (next) stack.push(next);
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 変更                                                                  */
/* ------------------------------------------------------------------ */

/** 変更用の複製を返す (すべての変更の入口。v5 から updatedAt は付けない: 開いて眺めただけで差分が出ないように) */
function touch(p: Project): Project {
  return clone(p);
}

/**
 * ブロックを追加する (出力ポートを 1 つ付ける。状態は black)
 * Input : parentId = 置く階層 (ROOT_ID なら最上位), title, position = 親の座標系での位置
 * Output: { project, blockId }
 */
export function addBlock(
  p: Project
, args: { parentId: string; title: string; position?: { x: number; y: number }; outputName?: string; actor?: string }
): { project: Project; blockId: string } {
  const q = touch(p);
  const id = newId();
  const siblings = childrenOf(q, args.parentId);
  // 既定の置き場所: 最上位では既存のブロックの右隣、下の階層では既存のブロックの下 (重ならないように)
  let defaultPos: { x: number; y: number };
  if (args.parentId === ROOT_ID) {
    defaultPos = siblings.length === 0 ? { x: 260, y: 80 } : { x: Math.max(...siblings.map((s) => s.position.x)) + 300, y: 80 };
  } else {
    defaultPos = siblings.length === 0
      ? { x: CHILD_PADDING.left, y: childTop(p, args.parentId) }
      : { x: CHILD_PADDING.left, y: Math.max(...siblings.map((s) => s.position.y)) + 110 };
  }
  q.blocks[id] = {
    id
  , key: nextKey(q)
  , parentId: args.parentId
  , title: args.title
  , description: ""
  , status: "black"
  , assigneeIds: []
  , position: args.position ?? defaultPos
  , collapsed: false
  , artifacts: []
  , activity: null
  , decisions: []
  };
  const out: Port = { id: newId(), blockId: id, direction: "out", name: args.outputName ?? t("出力"), description: "", required: true, artifacts: [] };
  q.ports[out.id] = out;
  if (args.actor) appendLog(q, { actor: args.actor, kind: "added", blockId: id, message: t("「{title}」を追加", { title: args.title }) });
  // 子を持ったら親は「分解中」。black のままの親だけ gray に上げる (white は人が決めたので触らない)
  const parent = q.blocks[args.parentId];
  if (parent && parent.id !== ROOT_ID && parent.status === "black") parent.status = "gray";
  return { project: normalizePromotions(q), blockId: id };
}

/** ブロックの属性を更新する (title / description / status / assigneeIds / artifacts / collapsed) */
export function updateBlock(p: Project, blockId: string, patch: Partial<Omit<Block, "id" | "parentId" | "position">>): Project {
  const q = touch(p);
  const b = q.blocks[blockId];
  if (!b) return p;
  Object.assign(b, patch);
  return q;
}

/** ブロックを動かす (親の座標系。子は親の内側の余白より手前には置けない) */
export function moveBlock(p: Project, blockId: string, position: { x: number; y: number }): Project {
  const q = clone(p);
  const b = q.blocks[blockId];
  if (!b) return p;
  const nested = b.parentId !== null && b.parentId !== ROOT_ID;
  b.position = nested
    ? { x: Math.max(CHILD_PADDING.left, position.x), y: Math.max(childTop(q, b.parentId!), position.y) }
    : position;
  return q;
}

/** 最上位の入力/出力ノードを動かす */
export function moveTerminal(p: Project, which: "in" | "out", position: { x: number; y: number }): Project {
  const q = clone(p);
  q.terminals[which] = position;
  return q;
}

/** ブロックを (子孫・ポート・線ごと) 削除する。最上位は消せない */
export function removeBlock(p: Project, blockId: string): Project {
  if (blockId === ROOT_ID) return p;
  const q = touch(p);
  const ids = new Set([blockId, ...descendantsOf(q, blockId).map((b) => b.id)]);
  const portIds = new Set(Object.values(q.ports).filter((x) => ids.has(x.blockId)).map((x) => x.id));
  for (const e of Object.values(q.edges)) {
    if (portIds.has(e.from.portId) || portIds.has(e.to.portId)) delete q.edges[e.id];
  }
  for (const id of portIds) delete q.ports[id];
  for (const id of ids) delete q.blocks[id];
  return normalizePromotions(q);
}

/**
 * ポートを追加する
 * Input : blockId, direction, name
 * Output: { project, portId }
 */
export function addPort(p: Project, args: { blockId: string; direction: "in" | "out"; name: string }): { project: Project; portId: string } {
  // 下の階層を持たない箱 (最上位以外) の出力は 1 本だけ。2 本目は足さない (下の階層ができれば足せる)
  if (args.direction === "out" && args.blockId !== ROOT_ID && !canAddOutput(p, args.blockId)) {
    return { project: p, portId: portsOf(p, args.blockId, "out")[0]?.id ?? "" };
  }
  const q = touch(p);
  const id = newId();
  q.ports[id] = {
    id
  , blockId: args.blockId
  , direction: args.direction
  , name: args.name
  , description: ""
  , required: true // 入力も既定は必須 (無くても着手できる入力だけ人が「任意」にする)
  , artifacts: []
  };
  // プロジェクトの箱の出力は、最上位 (Outputs ノード) にも同名の出力を作って自動でつなぐ (最終成果物として外から見えるように)
  if (args.direction === "out" && kindOf(q.blocks[args.blockId]) === "project") mirrorProjectOutput(q, id);
  return { project: normalizePromotions(q), portId: id };
}

/**
 * プロジェクトの箱の出力ポートを最上位の出力に写す (同名の出力を作り、外側 → 内側の線でつなぐ)
 * Input : q = 変更中の Project (直接書き換える), portId = プロジェクトの箱の出力ポート
 * Output: なし (すでに写っていれば何もしない)
 */
function mirrorProjectOutput(q: Project, portId: string): void {
  const port = q.ports[portId];
  if (!port || port.direction !== "out") return;
  const already = Object.values(q.edges).some((e) => e.from.portId === portId && e.from.side === "outer" && q.ports[e.to.portId]?.blockId === ROOT_ID);
  if (already) return;
  const rootOut: Port = { id: newId(), blockId: ROOT_ID, direction: "out", name: port.name, description: port.description, required: true, artifacts: [] };
  q.ports[rootOut.id] = rootOut;
  const eid = newId();
  q.edges[eid] = { id: eid, from: { portId, side: "outer" }, to: { portId: rootOut.id, side: "inner" }, kind: "up", auto: true };
}

/** プロジェクトの箱の出力に対応する最上位の出力ポート (無ければ null) */
function mirroredRootOutput(p: Project, portId: string): Port | null {
  const e = Object.values(p.edges).find((x) => x.from.portId === portId && x.from.side === "outer" && p.ports[x.to.portId]?.blockId === ROOT_ID);
  return e ? p.ports[e.to.portId] ?? null : null;
}

/** 出力を増やせるか: 最上位、下の階層を持つ箱、または出力がまだ無い箱 */
export function canAddOutput(p: Project, blockId: string): boolean {
  if (kindOf(p.blocks[blockId]) === "project") return true; // プロジェクトの箱は包みなので出力をいくつでも持てる
  if (blockId === ROOT_ID) return true;
  if (portsOf(p, blockId, "out").length === 0) return true;
  return childrenOf(p, blockId).length > 0;
}

/** ポートの属性を更新する (name / description / required / artifacts) */
export function updatePort(p: Project, portId: string, patch: Partial<Omit<Port, "id" | "blockId" | "direction">>): Project {
  const q = touch(p);
  const x = q.ports[portId];
  if (!x) return p;
  const oldName = x.name;
  // 供給元のある入力の名前は入力側では変えられない (供給元の出力の名前が入力名。変えるなら供給元で)
  if (patch.name !== undefined && isInputNameLocked(q, portId)) patch = { ...patch, name: undefined } as typeof patch;
  Object.assign(x, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  // プロジェクトの箱の出力の名前を変えたら、最上位の写しも同じ名前にする
  if (patch.name !== undefined && x.direction === "out" && kindOf(q.blocks[x.blockId]) === "project") {
    const mirror = mirroredRootOutput(q, portId);
    if (mirror) mirror.name = patch.name;
  }
  // 名前を変えたら、線でつながる先のポートで同じ名前だったものも一緒に変える (入力名は供給元の出力名と同じにしておくのが基本。
  // 二重に管理しなくて済むように、下流 (出力 → 入力、親の入力 → 子の入力、子の出力 → 親の出力) へ伝える)
  if (patch.name !== undefined && patch.name !== oldName) renameDownstream(q, portId, oldName, patch.name);
  return q;
}

/**
 * 供給元のある入力の名前を、供給元の名前にそろえる (規則が入る前に作った線や、手で直したファイルの食い違いを直す)。
 * 上流から順に (親の入力 → 子の入力、出力 → 入力) たどって決める
 * Input : p
 * Output: そろえた複製 (変える物が無ければ p そのもの)。変えたポートの数も返す
 */
export function normalizeInputNames(p: Project): { project: Project; renamed: number } {
  // 供給元を持つ入力ごとに「供給元の名前」を求める。供給元が入力 (親の入力の内側) なら、さらにその供給元をたどる
  const feeder = new Map<string, string>(); // 入力ポート id -> 供給元ポート id
  for (const e of Object.values(p.edges)) {
    if (e.auto) continue;
    const t = p.ports[e.to.portId];
    if (!t || t.direction !== "in" || e.to.side !== "outer") continue;
    feeder.set(t.id, e.from.portId);
  }
  const resolved = new Map<string, string>();
  const nameOf = (portId: string, seen: Set<string> = new Set()): string => {
    if (resolved.has(portId)) return resolved.get(portId)!;
    const port = p.ports[portId];
    if (!port) return "";
    const f = feeder.get(portId);
    let name = port.name;
    if (f && !seen.has(portId)) { seen.add(portId); const up = nameOf(f, seen); if (up) name = up; }
    resolved.set(portId, name);
    return name;
  };
  let q: Project | null = null;
  let renamed = 0;
  for (const id of feeder.keys()) {
    const want = nameOf(id);
    if (want && p.ports[id].name !== want) {
      if (!q) q = touch(p);
      q.ports[id].name = want;
      renamed++;
    }
  }
  return { project: q ?? p, renamed };
}

/**
 * 入力の名前が供給元に固定されているか (外から本物の線 (自動でない) がつながっている入力。名前は供給元の出力名で決まる)
 * Input : p, portId
 * Output: true = 入力側では名前を変えられない
 */
export function isInputNameLocked(p: Project, portId: string): boolean {
  const port = p.ports[portId];
  if (!port || port.direction !== "in") return false;
  return incomingEdges(p, { portId, side: "outer" }).some((e) => !e.auto);
}

/**
 * 線でつながる先のポートの名前を、元と同じ名前だったものだけ、再帰的に変える
 * Input : q = 変更中のプロジェクト (直接書き換える), portId = 変えたポート, oldName, newName
 * Output: 無し (q を書き換える)
 */
function renameDownstream(q: Project, portId: string, oldName: string, newName: string, seen: Set<string> = new Set()): void {
  if (seen.has(portId)) return;
  seen.add(portId);
  for (const e of Object.values(q.edges)) {
    if (e.from.portId !== portId) continue;
    const t = q.ports[e.to.portId];
    if (!t || t.name !== oldName) continue;
    t.name = newName;
    if (t.direction === "out" && kindOf(q.blocks[t.blockId]) === "project") {
      const mirror = mirroredRootOutput(q, t.id);
      if (mirror) mirror.name = newName;
    }
    renameDownstream(q, t.id, oldName, newName, seen);
  }
}

/** ポートを (つながる線ごと) 削除する。自動で引き上げたポートは消せない (元の入力をつなぐと自然に消える) */
export function removePort(p: Project, portId: string): Project {
  const x = p.ports[portId];
  if (!x || x.promotedFrom) return p;
  const q = touch(p);
  // プロジェクトの箱の出力を消したら、最上位の写しも (線ごと) 消す
  if (x.direction === "out" && kindOf(q.blocks[x.blockId]) === "project") {
    const mirror = mirroredRootOutput(q, portId);
    if (mirror) {
      for (const e of Object.values(q.edges)) if (e.from.portId === mirror.id || e.to.portId === mirror.id) delete q.edges[e.id];
      delete q.ports[mirror.id];
    }
  }
  for (const e of Object.values(q.edges)) {
    if (e.from.portId === portId || e.to.portId === portId) delete q.edges[e.id];
  }
  delete q.ports[portId];
  return normalizePromotions(q);
}

/**
 * 結線する (検証に通らなければ元の Project をそのまま返す)
 * 受ける側の端点に既にある線 (自動の線を含む) は置き換える
 * Output: { project, edgeId, error }
 */
export function connect(p: Project, from: Endpoint, to: Endpoint): { project: Project; edgeId?: string; error?: string } {
  const check = validateConnection(p, from, to);
  if (!check.ok) return { project: p, error: check.reason };
  const q = touch(p);
  for (const e of incomingEdges(q, to)) delete q.edges[e.id];
  const id = newId();
  q.edges[id] = { id, from, to, kind: check.kind!, auto: false };
  // つないだ入力の名前は供給元の名前にそろえる (入力名は入力側で決めない。親の入力 → 子の入力も同じ)
  const fromPort = q.ports[from.portId];
  const toPort = q.ports[to.portId];
  if (fromPort && toPort && toPort.direction === "in" && to.side === "outer" && toPort.name !== fromPort.name) {
    const old = toPort.name;
    toPort.name = fromPort.name;
    renameDownstream(q, toPort.id, old, fromPort.name);
  }
  return { project: normalizePromotions(q), edgeId: id };
}

/** 線を外す */
export function disconnect(p: Project, edgeId: string): Project {
  if (!p.edges[edgeId]) return p;
  const q = touch(p);
  delete q.edges[edgeId];
  return normalizePromotions(q);
}

/** メンバーを追加する */
export function addMember(p: Project, name: string, color: string): { project: Project; memberId: string } {
  const q = touch(p);
  const m: Member = { id: newId(), name, color };
  q.members.push(m);
  return { project: q, memberId: m.id };
}

/** メンバーを削除する (担当からも外す) */
export function removeMember(p: Project, memberId: string): Project {
  const q = touch(p);
  q.members = q.members.filter((m) => m.id !== memberId);
  for (const b of Object.values(q.blocks)) b.assigneeIds = b.assigneeIds.filter((id) => id !== memberId);
  return q;
}

/* ------------------------------------------------------------------ */
/* 浮いている入力の自動引き上げ (F-06)                                     */
/* ------------------------------------------------------------------ */

/**
 * 未接続の入力を最上位の入力ノードまで自動で伸ばし、不要になった自動ポート・自動線を片づける
 *
 * 1. 自動線の受け側に手動の線が来ていたら、自動線を消す
 * 2. 自動で作ったポートのうち、内側から誰も使っていないものを (その線ごと) 消す
 * 3. 最上位以外のブロックの入力 (outer) で線が来ていないものは、親に同名の自動ポートを作って自動線でつなぐ
 *    (親の自動ポートも外側が未接続なので、次の繰り返しでさらに上へ伸びる。最上位で止まる)
 * 安定するまで繰り返す。
 */
export function normalizePromotions(p: Project): Project {
  const q = clone(p);
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;

    // 1. 手動の線に置き換わった自動線を消す
    for (const e of Object.values(q.edges)) {
      if (!e.auto) continue;
      const manual = incomingEdges(q, e.to).some((o) => !o.auto);
      if (manual) {
        delete q.edges[e.id];
        changed = true;
      }
    }

    // 2. 使われなくなった自動ポートを消す
    for (const port of Object.values(q.ports)) {
      if (!port.promotedFrom) continue;
      const used = outgoingEdges(q, { portId: port.id, side: "inner" }).length > 0;
      if (!used) {
        for (const e of Object.values(q.edges)) {
          if (e.from.portId === port.id || e.to.portId === port.id) delete q.edges[e.id];
        }
        delete q.ports[port.id];
        changed = true;
      }
    }

    // 2b. 同じブロックに同じ名前の自動ポートが複数あれば 1 つにまとめる (古いデータの移行用)
    for (const port of Object.values(q.ports)) {
      if (!port.promotedFrom || !q.ports[port.id]) continue;
      const twin = Object.values(q.ports).find((x) => x.id !== port.id && x.blockId === port.blockId && x.direction === "in" && x.promotedFrom && x.name === port.name);
      if (!twin) continue;
      for (const e of Object.values(q.edges)) {
        if (e.from.portId === twin.id) e.from = { ...e.from, portId: port.id };
        if (e.to.portId === twin.id) e.to = { ...e.to, portId: port.id };
      }
      delete q.ports[twin.id];
      changed = true;
    }

    // 3. 浮いている入力を親へ引き上げる
    for (const port of Object.values(q.ports)) {
      if (port.direction !== "in") continue;
      const block = q.blocks[port.blockId];
      if (!block || block.parentId === null) continue; // 最上位の入力はこれ以上伸ばさない
      if (incomingEdges(q, { portId: port.id, side: "outer" }).length > 0) continue;
      // 同じ名前の自動ポートが親に既にあれば、それを共用する (同じ材料を複数の子が待っているとき、入力ノードに同名が並ばないように)
      let promoted = Object.values(q.ports).find((x) => x.blockId === block.parentId && x.direction === "in" && x.promotedFrom && x.name === port.name);
      if (!promoted) {
        promoted = {
          id: newId()
        , blockId: block.parentId
        , direction: "in"
        , name: port.name
        , description: port.description
        , required: port.required
        , artifacts: []
        , promotedFrom: port.id
        };
        q.ports[promoted.id] = promoted;
      }
      const id = newId();
      q.edges[id] = { id, from: { portId: promoted.id, side: "inner" }, to: { portId: port.id, side: "outer" }, kind: "down", auto: true };
      changed = true;
    }

    if (!changed) break;
  }
  return q;
}

/* ------------------------------------------------------------------ */
/* 進捗・状態                                                            */
/* ------------------------------------------------------------------ */

export interface Progress {
  /** 対象のブロック数 (子孫。子孫がなければ自分 1 つ) */
  total: number;
  white: number;
  gray: number;
  black: number;
  /** 0〜1 (完了した箱の割合) */
  ratio: number;
  /** 0〜100 (手入力の進捗と WhiteBox = 100 を合わせた実効の進捗) */
  percent: number;
}

/**
 * 箱の実効の進捗 (0〜100)
 *   WhiteBox なら 100。手入力があればそれ。下の階層があれば子の平均。それ以外は 0
 */
export function effectiveProgress(p: Project, blockId: string): number {
  const b = p.blocks[blockId];
  if (!b) return 0;
  if (b.status === "white") return 100;
  if (typeof b.progress === "number") return Math.max(0, Math.min(100, b.progress));
  const kids = childrenOf(p, blockId);
  if (kids.length === 0) return 0;
  return Math.round(kids.reduce((acc, k) => acc + effectiveProgress(p, k.id), 0) / kids.length);
}

/**
 * ブロックの進捗 (子孫の状態の内訳)
 * Input : blockId (ROOT_ID なら全体)
 * Output: Progress
 */
export function computeProgress(p: Project, blockId: string): Progress {
  const targets = descendantsOf(p, blockId).filter((b) => kindOf(b) !== "project");
  const list = targets.length > 0 ? targets : blockId === ROOT_ID ? [] : [p.blocks[blockId]].filter((b) => b && kindOf(b) !== "project");
  const count = (s: BlockStatus) => list.filter((b) => b.status === s).length;
  const white = count("white");
  const total = list.length;
  // 実効の進捗: 最上位ならプロジェクトの箱の平均、それ以外は自分の実効値
  const percent = blockId === ROOT_ID
    ? (() => { const pj = projectBlocks(p); return pj.length === 0 ? 0 : Math.round(pj.reduce((acc, b) => acc + effectiveProgress(p, b.id), 0) / pj.length); })()
    : effectiveProgress(p, blockId);
  return { total, white, gray: count("gray"), black: count("black"), ratio: total === 0 ? 0 : white / total, percent };
}

/** 手入力の進捗を変える (null で自動に戻す)。100 にしても状態は変えない (完了は人が決める) */
export function setProgress(p: Project, blockId: string, value: number | null, actor: string): Project {
  const b = p.blocks[blockId];
  if (!b) return p;
  const q = touch(p);
  if (value === null) delete q.blocks[blockId].progress;
  else q.blocks[blockId].progress = Math.max(0, Math.min(100, Math.round(value)));
  if (value !== null && b.status === "black" && value > 0) q.blocks[blockId].status = "gray";
  appendLog(q, { actor, kind: "note", blockId, message: t("「{title}」の進捗 {value}", { title: b.title, value: value === null ? t("自動") : value + "%" }) });
  return q;
}

/**
 * 入力がそろっているか (線の「用意できた」判定)
 *   出力ポート (outer): 成果物が付いている、または箱が WhiteBox
 *   入力ポート (inner, 親から中へ): その入力ポート自身に入力物が付いている、またはそこへ来る線が「用意できた」線
 *   最上位の入力: 入力物が付いていれば用意できている
 */
export function isSourceReady(p: Project, ep: Endpoint, seen: Set<string> = new Set()): boolean {
  const key = `${ep.portId}:${ep.side}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const port = p.ports[ep.portId];
  if (!port) return false;
  if (port.direction === "out") {
    const b = p.blocks[port.blockId];
    return port.artifacts.length > 0 || b?.status === "white";
  }
  // 入力ポート (親の内側から子へ流す)
  if (port.artifacts.length > 0) return true;
  const incoming = incomingEdges(p, { portId: port.id, side: "outer" });
  return incoming.some((e) => isSourceReady(p, e.from, seen));
}

/** 線が「用意できた」線か */
export function isEdgeReady(p: Project, e: Edge): boolean {
  return isSourceReady(p, e.from);
}

/** 入力ポート (outer) に用意できた線が来ているか (箱の入力名に印を付ける用) */
export function isInputReady(p: Project, portId: string): boolean {
  const port = p.ports[portId];
  if (!port || port.direction !== "in") return false;
  if (port.artifacts.length > 0) return true;
  return incomingEdges(p, { portId, side: "outer" }).some((e) => isEdgeReady(p, e));
}

/**
 * 必須なのにまだ用意できていない入力 (「必須」の意味はここで決まる)
 * Input : blockId
 * Output: 必須 (required) で、つながった出力が確定しておらず入力物も無い入力ポートの一覧
 *   空なら「着手できる」。任意 (required = false) の入力は無くても着手できる
 */
export function missingRequiredInputs(p: Project, blockId: string): Port[] {
  return portsOf(p, blockId, "in").filter((q) => q.required && !isInputReady(p, q.id));
}

/**
 * 「完了にできます」と提案してよいか
 * 条件: 子があるなら全部 white、かつ出力ポートすべてに成果物が付いている
 */
export function canSuggestWhite(p: Project, blockId: string): boolean {
  const b = p.blocks[blockId];
  if (!b || b.status === "white") return false;
  const kids = childrenOf(p, blockId);
  if (kids.some((k) => k.status !== "white")) return false;
  const outs = portsOf(p, blockId, "out");
  return outs.length > 0 && outs.every((o) => o.artifacts.length > 0);
}

/* ------------------------------------------------------------------ */
/* JSON の読み書き                                                       */
/* ------------------------------------------------------------------ */

/** JSON 文字列に書き出す */
export function toJSON(p: Project): string {
  // updatedAt / version は書かない (変更のたびに差分に出て Git の履歴を汚すため。更新時刻はログと Git が持つ)
  const { updatedAt: _u, version: _v, ...rest } = p;
  return JSON.stringify(rest, null, 2);
}

/**
 * JSON 文字列から読み込む (形式の最低限の検証つき)
 * Output: Project。形式が合わなければ例外 (日本語のメッセージ)
 */
export function fromJSON(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(t("JSON として読めません"));
  }
  if (typeof data !== "object" || data === null) throw new Error(t("プロジェクトの形式ではありません"));
  const d = data as Partial<Project>;
  const ver = Number(d.schemaVersion);
  if (![1, 2, 3, 4, 5].includes(ver)) throw new Error(t("対応していないデータ形式の版です (schemaVersion={version})", { version: String(d.schemaVersion) }));
  if (!d.blocks || !d.ports || !d.edges || !d.blocks[ROOT_ID]) throw new Error(t("ブロック・ポート・線のデータが足りません"));
  const q: Project = {
    schemaVersion: SCHEMA_VERSION
  , id: typeof d.id === "string" ? d.id : newId()
  , name: typeof d.name === "string" ? d.name : t("無題")
  , description: typeof d.description === "string" ? d.description : ""
  , createdAt: typeof d.createdAt === "string" ? d.createdAt : now()
  , visibility: d.visibility ?? "private"
  , members: Array.isArray(d.members) ? d.members : []
  , blocks: d.blocks
  , ports: d.ports
  , edges: d.edges
  , terminals: d.terminals ?? { in: { x: 0, y: 200 }, out: { x: 1100, y: 200 } }
  , log: Array.isArray(d.log) ? d.log : []
  , agents: d.agents && typeof d.agents === "object" ? d.agents : {}
  , nextKey: typeof d.nextKey === "number" ? d.nextKey : 1
  , inputGroups: Array.isArray(d.inputGroups) ? d.inputGroups : []
  };
  if (d.lang === "en" || d.lang === "ja") q.lang = d.lang; // CLI の文言の言語 (無ければ ja 扱い)
  // 無いグループを指している入力は既定の入力ノードに戻す
  for (const x of Object.values(q.ports)) if (x.groupId && !q.inputGroups!.some((gp) => gp.id === x.groupId)) delete x.groupId;
  // 版 1 (活動・判断の項目が無い) からの移行: 足りない項目を補う
  for (const b of Object.values(q.blocks)) {
    if (b.activity === undefined) b.activity = null;
    if (!Array.isArray(b.decisions)) b.decisions = [];
    if (!Array.isArray(b.artifacts)) b.artifacts = [];
    if (!Array.isArray(b.assigneeIds)) b.assigneeIds = [];
    if (b.progress !== undefined && typeof b.progress !== "number") delete b.progress;
  }
  // 版 3 まで: 入力の required は既定 false で、しかも何にも効いていなかった。版 4 から「必須」が意味を持つので全部 必須 に直す
  if (ver < 4) for (const x of Object.values(q.ports)) if (x.direction === "in") x.required = true;
  ensureKeys(q);
  // 壊れた参照 (存在しないブロックのポート、存在しないポートの線) を落とす
  for (const x of Object.values(q.ports)) if (!q.blocks[x.blockId]) delete q.ports[x.id];
  for (const e of Object.values(q.edges)) if (!q.ports[e.from.portId] || !q.ports[e.to.portId]) delete q.edges[e.id];
  return normalizePromotions(wrapIntoProject(q));
}

/**
 * 版 2 までのデータ (最上位に直接タスクがある) を、プロジェクトの箱で包む (版 3 の形)
 * 最上位にタスクが無い、または既にプロジェクトの箱だけなら何もしない
 */
export function wrapIntoProject(p: Project): Project {
  const topTasks = childrenOf(p, ROOT_ID).filter((b) => kindOf(b) !== "project");
  if (topTasks.length === 0) return p;
  const q = clone(p);
  const pid = newId();
  q.blocks[pid] = {
    id: pid
  , key: nextKey(q)
  , kind: "project"
  , parentId: ROOT_ID
  , title: q.name
  , description: q.description
  , status: "gray"
  , assigneeIds: []
  , position: { x: 300, y: 40 }
  , collapsed: false
  , artifacts: []
  , activity: null
  , decisions: []
  };
  // タスクを箱の中へ (位置は箱の内側の余白から)
  const minX = Math.min(...topTasks.map((b) => b.position.x));
  const minY = Math.min(...topTasks.map((b) => b.position.y));
  for (const b of topTasks) {
    q.blocks[b.id].parentId = pid;
    q.blocks[b.id].position = { x: b.position.x - minX + CHILD_PADDING.left, y: b.position.y - minY + childTop(q, pid) };
  }
  // 最上位の出力へ上がっていた線は、箱の出力 (同名) を経由させる
  for (const e of Object.values(q.edges)) {
    const tp = q.ports[e.to.portId];
    const fp = q.ports[e.from.portId];
    if (!tp || !fp) continue;
    if (e.kind === "up" && tp.blockId === ROOT_ID && e.to.side === "inner") {
      let mid = portsOf(q, pid, "out").find((o) => o.name === tp.name);
      if (!mid) {
        mid = { id: newId(), blockId: pid, direction: "out", name: tp.name, description: tp.description, required: true, artifacts: [] };
        q.ports[mid.id] = mid;
        const up = newId();
        q.edges[up] = { id: up, from: { portId: mid.id, side: "outer" }, to: { portId: tp.id, side: "inner" }, kind: "up", auto: false };
      }
      e.to = { portId: mid.id, side: "inner" };
    }
    // 最上位の入力から下りていた線 (手動) は、箱の入力 (同名) を経由させる。自動の線は消して作り直す
    if (e.kind === "down" && fp.blockId === ROOT_ID && e.from.side === "inner") {
      if (e.auto) {
        delete q.edges[e.id];
        continue;
      }
      let mid = portsOf(q, pid, "in").find((o) => o.name === fp.name);
      if (!mid) {
        mid = { id: newId(), blockId: pid, direction: "in", name: fp.name, description: fp.description, required: fp.required, artifacts: [] };
        q.ports[mid.id] = mid;
        const down = newId();
        q.edges[down] = { id: down, from: { portId: fp.id, side: "inner" }, to: { portId: mid.id, side: "outer" }, kind: "down", auto: false };
      }
      e.from = { portId: mid.id, side: "inner" };
    }
  }
  // 最上位の自動ポートは作り直す (箱を経由した形で再生成される)
  for (const x of portsOf(q, ROOT_ID, "in")) if (x.promotedFrom) delete q.ports[x.id];
  for (const e of Object.values(q.edges)) if (!q.ports[e.from.portId] || !q.ports[e.to.portId]) delete q.edges[e.id];
  // 箱の出力が 1 つも無ければ既定の出力を付け、最終成果物につなぐ
  if (portsOf(q, pid, "out").length === 0) {
    const out: Port = { id: newId(), blockId: pid, direction: "out", name: t("最終成果物"), description: "", required: true, artifacts: [] };
    q.ports[out.id] = out;
    const rootOut = portsOf(q, ROOT_ID, "out")[0];
    if (rootOut && incomingEdges(q, { portId: rootOut.id, side: "inner" }).length === 0) {
      const up = newId();
      q.edges[up] = { id: up, from: { portId: out.id, side: "outer" }, to: { portId: rootOut.id, side: "inner" }, kind: "up", auto: false };
    }
  }
  return q;
}

/* ------------------------------------------------------------------ */
/* AI エージェントと人の活動 (schemaVersion 2)                              */
/* ------------------------------------------------------------------ */

/** ログを 1 件足す (呼び出し側で複製済みの Project を渡す。上限を超えたら古いものから落とす) */
function appendLog(q: Project, ev: { actor: string; kind: LogKind; blockId?: string; message: string }): void {
  q.log.push({ id: newId(), at: now(), ...ev });
  if (q.log.length > LOG_LIMIT) q.log.splice(0, q.log.length - LOG_LIMIT);
  q.agents[ev.actor] = { lastSeen: now() };
}

/**
 * ブロックの活動を記録する (作業開始・詰まり・確認待ち)
 * Input : blockId, actor = 誰が, state, note = 何をしているか
 * Output: Project (black のブロックは gray に上がる)
 */
export function setActivity(p: Project, blockId: string, actor: string, state: ActivityState, note: string): Project {
  const q = touch(p);
  const b = q.blocks[blockId];
  if (!b || blockId === ROOT_ID) return p;
  b.activity = { actor, state, note, since: now() };
  if (state === "working" && b.status === "black") b.status = "gray";
  const kind: LogKind = state === "working" ? "started" : state === "blocked" ? "blocked" : "note";
  // 状態ごとに 1 文として訳す (英語は語順が変わるので、題名と状態を別々に訳してつなげない)
  const label = state === "working" ? t("「{title}」開始", { title: b.title })
    : state === "blocked" ? t("「{title}」詰まり", { title: b.title })
    : state === "waiting_review" ? t("「{title}」確認待ち", { title: b.title })
    : t("「{title}」判断待ち", { title: b.title });
  appendLog(q, { actor, kind, blockId, message: `${label}${note ? ": " + note : ""}` });
  return q;
}

/** 活動を消す (作業を離れる) */
export function clearActivity(p: Project, blockId: string): Project {
  const q = touch(p);
  const b = q.blocks[blockId];
  if (!b) return p;
  b.activity = null;
  return q;
}

/**
 * ブロックを完了にする: 成果物を出力ポートに付け、活動を消し、white にする
 * Input : blockId, actor, artifacts = 付ける成果物 ({title, url}。省略可), outputName = 付ける先の出力名 (省略時は最初の出力)
 * Output: { project, error } (出力が見つからなければ error)
 */
export function finishBlock(
  p: Project
, blockId: string
, actor: string
, args: { artifacts?: ({ title: string; url?: string } | Artifact)[]; outputName?: string; note?: string } = {}
): { project: Project; error?: string } {
  const b = p.blocks[blockId];
  if (!b || blockId === ROOT_ID) return { project: p, error: t("ブロックが見つかりません") };
  const outs = portsOf(p, blockId, "out");
  let target = outs[0];
  if (args.outputName) {
    const found = outs.find((o) => o.name === args.outputName);
    if (!found) return { project: p, error: t("出力「{name}」がありません ({list})", { name: args.outputName, list: outs.map((o) => o.name).join(", ") }) };
    target = found;
  }
  const q = touch(p);
  if (target && args.artifacts) {
    for (const a of args.artifacts) q.ports[target.id].artifacts.push("id" in a && "kind" in a ? (a as Artifact) : createArtifact(a.title, a.url ?? ""));
  }
  q.blocks[blockId].activity = null;
  q.blocks[blockId].status = "white";
  const arts = (args.artifacts ?? []).map((a) => a.title).join(", ");
  appendLog(q, { actor, kind: "done", blockId, message: `${t("「{title}」完了", { title: b.title })}${arts ? " (" + arts + ")" : ""}${args.note ? ": " + args.note : ""}` });
  return { project: q };
}

/**
 * 人間に判断を求める (ブロックは判断待ちになる)
 * Input : blockId, actor, question, options = 選択肢 (省略可)
 * Output: { project, decisionId }
 */
export function askDecision(p: Project, blockId: string, actor: string, question: string, options: string[] = [], context = ""): { project: Project; decisionId?: string } {
  const b = p.blocks[blockId];
  if (!b || blockId === ROOT_ID) return { project: p };
  const q = touch(p);
  const d: Decision = { id: newId(), question, options, askedBy: actor, askedAt: now(), ...(context ? { context } : {}) };
  q.blocks[blockId].decisions.push(d);
  q.blocks[blockId].activity = { actor, state: "needs_decision", note: question, since: now() };
  appendLog(q, { actor, kind: "asked", blockId, message: t("「{title}」で判断待ち: {question}", { title: b.title, question }) });
  return { project: q, decisionId: d.id };
}

/**
 * 未回答の判断を書き直す (質問・選択肢・判断材料)。回答済みは変えない (履歴が崩れるため)
 * Input : blockId, decisionId, patch
 * Output: 更新した Project (回答済み・見つからないときはそのまま)
 */
export function updateDecision(p: Project, blockId: string, decisionId: string, patch: { question?: string; options?: string[]; context?: string }): Project {
  const b = p.blocks[blockId];
  const d = b?.decisions.find((x) => x.id === decisionId);
  if (!b || !d || d.answer !== undefined) return p;
  const q = touch(p);
  const qd = q.blocks[blockId].decisions.find((x) => x.id === decisionId)!;
  if (patch.question !== undefined) qd.question = patch.question;
  if (patch.options !== undefined) qd.options = patch.options;
  if (patch.context !== undefined) { if (patch.context) qd.context = patch.context; else delete qd.context; }
  if (q.blocks[blockId].activity?.state === "needs_decision") q.blocks[blockId].activity = { ...q.blocks[blockId].activity!, note: qd.question };
  return q;
}

/**
 * 判断に答える (判断待ちだった活動は消える)
 * Input : blockId, decisionId, answer, by = 答えた人
 */
export function answerDecision(p: Project, blockId: string, decisionId: string, answer: string, by: string): Project {
  const b = p.blocks[blockId];
  const d = b?.decisions.find((x) => x.id === decisionId);
  if (!b || !d) return p;
  const q = touch(p);
  const qd = q.blocks[blockId].decisions.find((x) => x.id === decisionId)!;
  qd.answer = answer;
  qd.answeredBy = by;
  qd.answeredAt = now();
  // AI が自分で答えた判断は、その場で「確認済み」。人の回答は AI が引き取る (ack) まで未確認のまま残す
  if (isHumanActor(by)) { delete qd.ackedBy; delete qd.ackedAt; } else { qd.ackedBy = by; qd.ackedAt = qd.answeredAt; }
  if (q.blocks[blockId].activity?.state === "needs_decision") q.blocks[blockId].activity = null;
  appendLog(q, { actor: by, kind: "answered", blockId, message: t("「{title}」の判断: {question} → {answer}", { title: b.title, question: d.question, answer }) });
  return q;
}

/**
 * 答えた判断の文面を直す (選び直しではなく、書き間違いや補足の修正。履歴には積まず、ログに残す)
 * Input : blockId, decisionId, answer = 新しい文面, by = 直した人
 * Output: 直した複製 (答えていない判断や空文字なら p そのもの)
 */
export function editDecisionAnswer(p: Project, blockId: string, decisionId: string, answer: string, by: string): Project {
  const b = p.blocks[blockId];
  const d = b?.decisions.find((x) => x.id === decisionId);
  if (!b || !d || d.answer === undefined || !answer.trim() || answer.trim() === d.answer) return p;
  const q = touch(p);
  const qd = q.blocks[blockId].decisions.find((x) => x.id === decisionId)!;
  qd.answer = answer.trim();
  qd.answeredBy = by;
  qd.answeredAt = now();
  appendLog(q, { actor: by, kind: "answered", blockId, message: t("「{title}」の判断の答えを直した: {question} → {answer}", { title: b.title, question: d.question, answer: answer.trim() }) });
  return q;
}

/**
 * 判断の候補を「選んだもの」と「残した候補 (選ばなかったもの)」に分ける
 * Input : d = 判断
 * Output: { chosen, rejected } (未回答なら chosen は undefined、rejected は全候補)
 */
export function candidatesOf(d: Decision): { chosen?: string; rejected: string[] } {
  if (d.answer === undefined) return { rejected: [...d.options] };
  return { chosen: d.answer, rejected: d.options.filter((o) => o !== d.answer) };
}

/**
 * 判断をやり直す (方針転換): 今の答えを履歴に移して未回答に戻す。候補はそのまま残る
 * Input : blockId, decisionId, by = やり直す人, note = 理由
 * Output: 更新した Project
 */
export function reopenDecision(p: Project, blockId: string, decisionId: string, by: string, note = ""): Project {
  const b = p.blocks[blockId];
  const d = b?.decisions.find((x) => x.id === decisionId);
  if (!b || !d || d.answer === undefined) return p;
  const q = touch(p);
  const qd = q.blocks[blockId].decisions.find((x) => x.id === decisionId)!;
  qd.history = [...(qd.history ?? []), { answer: d.answer, by: d.answeredBy ?? "", at: d.answeredAt ?? now(), note: note || undefined }];
  delete qd.ackedBy;
  delete qd.ackedAt;
  delete qd.answer;
  delete qd.answeredBy;
  delete qd.answeredAt;
  q.blocks[blockId].activity = { actor: by, state: "needs_decision", note: d.question, since: now() };
  appendLog(q, { actor: by, kind: "asked", blockId, message: note
    ? t("「{title}」の判断をやり直し: {question} (前の答え: {answer}。理由: {note})", { title: b.title, question: d.question, answer: d.answer ?? "", note })
    : t("「{title}」の判断をやり直し: {question} (前の答え: {answer})", { title: b.title, question: d.question, answer: d.answer ?? "" }) });
  return q;
}

/** 未回答の判断 (ブロックと一緒に) */
export function pendingDecisions(p: Project): { block: Block; decision: Decision }[] {
  const out: { block: Block; decision: Decision }[] = [];
  for (const b of Object.values(p.blocks)) {
    for (const d of b.decisions) if (d.answer === undefined) out.push({ block: b, decision: d });
  }
  return out;
}

/** 人の名前か (human / human:<名前>)。それ以外は AI エージェント (claude-code / codex / agent など) とみなす */
export const isHumanActor = (actor: string): boolean => actor === "human" || actor.startsWith("human:");

/**
 * 回答済みだが AI がまだ引き取っていない判断 (人が答えた直後に一覧から消えて見失わないように、ack されるまで出し続ける)
 * Input : p
 * Output: { block, decision } の配列 (回答の新しい順)
 */
export function answeredUnacked(p: Project): { block: Block; decision: Decision }[] {
  const out: { block: Block; decision: Decision }[] = [];
  for (const b of Object.values(p.blocks)) {
    for (const d of b.decisions) if (d.answer !== undefined && !isAcked(p, b.id, d)) out.push({ block: b, decision: d });
  }
  return out.sort((a, b) => (b.decision.answeredAt ?? "").localeCompare(a.decision.answeredAt ?? ""));
}

/**
 * 回答が AI に引き取られたとみなせるか: ack の記録があるか、回答の後にその箱で AI の記録 (ログ) があるか
 * (この仕組みより前の回答も、AI が作業を記録していれば読まれている。古い回答が全部「未確認」に出ないように)
 */
export function isAcked(p: Project, blockId: string, d: Decision): boolean {
  if (d.ackedAt) return true;
  if (d.answer === undefined) return false;
  if (d.answeredBy && !isHumanActor(d.answeredBy)) return true; // AI が自分で答えた判断は読まれている
  const at = d.answeredAt ?? "";
  return p.log.some((e) => e.blockId === blockId && e.at > at && !isHumanActor(e.actor) && e.kind !== "answered");
}

/**
 * 回答を AI が引き取った記録を付ける (ack)。decisionId を省略すると、その箱の未確認の回答すべて
 * Input : blockId, by = 引き取った AI の名前, decisionId
 * Output: 付けた複製 (付ける物が無ければ p そのもの)
 */
export function ackDecisions(p: Project, blockId: string, by: string, decisionId?: string): Project {
  const b = p.blocks[blockId];
  if (!b || isHumanActor(by)) return p; // 引き取るのは AI だけ (人が CLI を使っても回答は未確認のまま)
  const targets = b.decisions.filter((d) => d.answer !== undefined && !d.ackedAt && (!decisionId || d.id === decisionId));
  if (targets.length === 0) return p;
  const q = touch(p);
  const at = now();
  for (const d of q.blocks[blockId].decisions) {
    if (targets.some((x) => x.id === d.id)) { d.ackedBy = by; d.ackedAt = at; }
  }
  appendLog(q, { actor: by, kind: "note", blockId, message: t("「{title}」の回答を確認: {questions}", { title: b.title, questions: targets.map((d) => d.question).join(" / ") }) });
  return q;
}

/** 状態を手で変える (ログ付き) */
export function setStatus(p: Project, blockId: string, status: BlockStatus, actor: string): Project {
  const b = p.blocks[blockId];
  if (!b || b.status === status) return p;
  const q = updateBlock(p, blockId, { status });
  if (status === "white") q.blocks[blockId].activity = null;
  appendLog(q, { actor, kind: "status", blockId, message: t("「{title}」を {status} に", { title: b.title, status }) });
  return q;
}

export interface Summary {
  total: number;
  white: number;
  gray: number;
  black: number;
  working: { block: Block; actor: string; note: string; since: string }[];
  blocked: { block: Block; actor: string; note: string }[];
  decisions: { block: Block; decision: Decision }[];
  /** 回答済みで AI が未確認の判断 (人が答えた後、AI が引き取るまで見える所に残す) */
  answered: { block: Block; decision: Decision }[];
  /** 未着手で活動も無い black のブロック (次の候補) */
  next: Block[];
  /** 期日を過ぎた未完了の箱 */
  overdue: Block[];
}

/** 全体の要約 (上の帯・CLI の status 用) */
export function summarize(p: Project): Summary {
  const blocks = Object.values(p.blocks).filter((b) => b.id !== ROOT_ID && kindOf(b) !== "project");
  const working = blocks.filter((b) => b.activity?.state === "working").map((b) => ({ block: b, actor: b.activity!.actor, note: b.activity!.note, since: b.activity!.since }));
  const blocked = blocks.filter((b) => b.activity?.state === "blocked" || b.activity?.state === "waiting_review").map((b) => ({ block: b, actor: b.activity!.actor, note: b.activity!.note }));
  const leafBlack = blocks
    .filter((b) => b.status === "black" && !b.activity && childrenOf(p, b.id).length === 0)
    .sort((a, b) => Number(missingRequiredInputs(p, a.id).length > 0) - Number(missingRequiredInputs(p, b.id).length > 0)); // 着手できるものを先に
  return {
    total: blocks.length
  , white: blocks.filter((b) => b.status === "white").length
  , gray: blocks.filter((b) => b.status === "gray").length
  , black: blocks.filter((b) => b.status === "black").length
  , working
  , blocked
  , decisions: pendingDecisions(p)
  , answered: answeredUnacked(p)
  , next: leafBlack
  , overdue: blocks.filter((b) => isOverdue(b))
  };
}

/**
 * 名前または id でブロックを探す (CLI 用)
 * Input : ref = id、または題名 (完全一致 → 1 つだけ含む部分一致)
 * Output: Block、見つからない / 曖昧なら null と候補
 */
export function findBlock(p: Project, ref: string): { block: Block | null; candidates: Block[] } {
  if (p.blocks[ref] && ref !== ROOT_ID) return { block: p.blocks[ref], candidates: [] };
  const blocks = Object.values(p.blocks).filter((b) => b.id !== ROOT_ID);
  const byKey = blocks.find((b) => b.key && b.key.toLowerCase() === ref.toLowerCase());
  if (byKey) return { block: byKey, candidates: [] };
  const exact = blocks.filter((b) => b.title === ref);
  if (exact.length === 1) return { block: exact[0], candidates: [] };
  const partial = blocks.filter((b) => b.title.includes(ref));
  if (partial.length === 1) return { block: partial[0], candidates: [] };
  return { block: null, candidates: exact.length > 0 ? exact : partial };
}

/**
 * ブロックを分解する (子ブロックをまとめて足し、名前で結線する)
 * Input : parentId, spec = { blocks: [{ title, description?, inputs?, outputs? }], connections?: [{ from: "題名.出力名", to: "題名.入力名" }] }
 *         from / to の題名に親の題名 (または "parent") を使うと、親の入力/出力 (内側) につながる
 * Output: { project, errors }
 */
export function splitBlock(
  p: Project
, parentId: string
, spec: { blocks: { title: string; description?: string; inputs?: string[]; outputs?: string[] }[]; connections?: { from: string; to: string }[] }
, actor: string
): { project: Project; errors: string[] } {
  const errors: string[] = [];
  const parent = p.blocks[parentId];
  if (!parent) return { project: p, errors: [t("親ブロックが見つかりません")] };
  let q = clone(p);
  const made: Record<string, string> = {};
  for (const b of spec.blocks) {
    const r = addBlock(q, { parentId, title: b.title, outputName: b.outputs?.[0] });
    q = r.project;
    made[b.title] = r.blockId;
    if (b.description) q.blocks[r.blockId].description = b.description;
    if ((b.outputs ?? []).length > 1) errors.push(t("「{title}」の出力は 1 本にしました (下の階層を持たない箱の出力は 1 本。{omitted} は省略)", { title: b.title, omitted: b.outputs!.slice(1).join(", ") }));
    for (const name of b.inputs ?? []) q = addPort(q, { blockId: r.blockId, direction: "in", name }).project;
  }
  // 参照の解決: 題名にドットがあってもよいので、区切り方を左から順に試す。失敗の理由 (箱が無い / ポートが無い) も返す
  const resolve = (ref: string, dir: "out" | "in"): { ep: Endpoint | null; why: string } => {
    let why = t("箱が見つかりません");
    for (const { title, portName } of refSplits(ref)) {
      const isParent = title === "parent" || title === parent.title || title === parentId;
      const blockId = isParent ? parentId : made[title] ?? findBlock(q, title).block?.id;
      if (!blockId) continue;
      // 親の場合は内側の面: 出す側なら親の入力 (inner)、受ける側なら親の出力 (inner)
      const want: "in" | "out" = isParent ? (dir === "out" ? "in" : "out") : dir;
      const port = portsOf(q, blockId, want).find((x) => x.name === portName);
      if (!port) { why = want === "in" ? t("「{title}」に入力「{port}」がありません", { title, port: portName }) : t("「{title}」に出力「{port}」がありません", { title, port: portName }); continue; }
      return { ep: { portId: port.id, side: isParent ? "inner" : "outer" }, why: "" };
    }
    return { ep: null, why };
  };
  for (const c of spec.connections ?? []) {
    const from = resolve(c.from, "out");
    let to = resolve(c.to, "in");
    // 受け側が「題名」だけ (ポート名なし) なら、出す側の出力名で入力を作ってつなぐ (入力名を二重に書かなくてよい)
    if (!to.ep && from.ep && !c.to.includes(".")) {
      const tid = c.to === "parent" || c.to === parent.title || c.to === parentId ? null : made[c.to] ?? findBlock(q, c.to).block?.id;
      if (tid) {
        const fromName = q.ports[from.ep.portId]?.name ?? "";
        // 同じ名前でまだ (自動の線以外が) つながっていない入力があればそれを使い、無ければ作る
        let port = portsOf(q, tid, "in").find((x) => x.name === fromName && incomingEdges(q, { portId: x.id, side: "outer" }).every((e) => e.auto));
        if (!port) {
          const r = addPort(q, { blockId: tid, direction: "in", name: fromName });
          q = r.project;
          port = q.ports[r.portId];
        }
        to = { ep: { portId: port.id, side: "outer" }, why: "" };
      }
    }
    if (!from.ep || !to.ep) {
      errors.push(t("結線できません: {from} -> {to} ({why})", { from: c.from, to: c.to, why: !from.ep ? from.why : to.why }));
      continue;
    }
    const r = connect(q, from.ep, to.ep);
    if (r.error) errors.push(t("結線できません: {from} -> {to} ({why})", { from: c.from, to: c.to, why: r.error }));
    q = r.project;
  }
  if (q.blocks[parentId].status === "black") q.blocks[parentId].status = "gray";
  q.blocks[parentId].collapsed = false;
  appendLog(q, { actor, kind: "split", blockId: parentId, message: t("「{title}」を {count} 個に分解: {list}", { title: parent.title, count: spec.blocks.length, list: spec.blocks.map((b) => b.title).join(", ") }) });
  return { project: q, errors };
}

/* ------------------------------------------------------------------ */
/* 再利用のテンプレート                                                   */
/* ------------------------------------------------------------------ */

/** ブロックを (下の階層ごと) テンプレートの木にする。id に依存しない形 (名前で結線) */
function toTemplateNode(p: Project, blockId: string): TemplateNode {
  const b = p.blocks[blockId];
  const kids = childrenOf(p, blockId);
  const name = (id: string) => (id === blockId ? "parent" : p.blocks[id]?.title ?? "?");
  const connections: { from: string; to: string }[] = [];
  const kidIds = new Set(kids.map((k) => k.id));
  for (const e of Object.values(p.edges)) {
    if (e.auto) continue;
    const fp = p.ports[e.from.portId];
    const tp = p.ports[e.to.portId];
    if (!fp || !tp) continue;
    const inScope = (port: Port, side: "inner" | "outer") => (side === "inner" ? port.blockId === blockId : kidIds.has(port.blockId));
    if (!inScope(fp, e.from.side) || !inScope(tp, e.to.side)) continue;
    connections.push({ from: `${name(fp.blockId)}.${fp.name}`, to: `${name(tp.blockId)}.${tp.name}` });
  }
  return {
    title: b.title
  , category: b.category
  , description: b.description
  , inputs: portsOf(p, blockId, "in").filter((x) => !x.promotedFrom).map((x) => ({ name: x.name, description: x.description, required: x.required }))
  , outputs: portsOf(p, blockId, "out").map((x) => ({ name: x.name, description: x.description }))
  , children: kids.sort((a, c) => a.position.y - c.position.y || a.position.x - c.position.x).map((k) => toTemplateNode(p, k.id))
  , connections
  };
}

/**
 * ブロックをテンプレートとして取り出す (状態・活動・成果物・担当は含めない。構造と説明だけ)
 * Input : blockId, name = テンプレート名 (省略時は箱の題名), tags
 * Output: BlockTemplate
 */
export function extractTemplate(p: Project, blockId: string, opts: { name?: string; tags?: string[]; description?: string } = {}): BlockTemplate {
  const b = p.blocks[blockId];
  const t = now();
  return {
    schema: "boxglow-block"
  , schemaVersion: 1
  , id: b.template?.id ?? newId()
  , name: opts.name ?? b.title
  , version: (b.template?.version ?? 0) + 1
  , description: opts.description ?? b.description
  , tags: opts.tags ?? []
  , createdAt: t
  , updatedAt: t
  , root: toTemplateNode(p, blockId)
  };
}

/** テンプレートの木を 1 段ずつ置いていく (再帰) */
function instantiateNode(p: Project, parentId: string, node: TemplateNode, origin: TemplateOrigin, position?: { x: number; y: number }): { project: Project; blockId: string } {
  const r = addBlock(p, { parentId, title: node.title, outputName: node.outputs[0]?.name, position });
  let q = r.project;
  const id = r.blockId;
  q.blocks[id].description = node.description;
  q.blocks[id].template = origin;
  if (node.category) q.blocks[id].category = node.category;
  if (node.outputs[0]) q = updatePort(q, portsOf(q, id, "out")[0].id, { description: node.outputs[0].description });
  for (const o of node.outputs.slice(1)) {
    const a = addPort(q, { blockId: id, direction: "out", name: o.name });
    q = updatePort(a.project, a.portId, { description: o.description });
  }
  for (const i of node.inputs) {
    const a = addPort(q, { blockId: id, direction: "in", name: i.name });
    q = updatePort(a.project, a.portId, { description: i.description, required: i.required });
  }
  // 子を置き、名前で結線 (splitBlock と同じ解決ルール)
  if (node.children.length > 0) {
    const made: Record<string, string> = {};
    let y = childTop(q, id);
    for (const c of node.children) {
      const rc = instantiateNode(q, id, c, origin, { x: CHILD_PADDING.left, y });
      q = rc.project;
      made[c.title] = rc.blockId;
      y += 120;
    }
    const resolve = (ref: string, dir: "out" | "in"): Endpoint | null => {
      // 題名にドットがあってもよいので、区切り方を左から順に試す
      for (const { title, portName } of refSplits(ref)) {
        const isParent = title === "parent";
        const blockId = isParent ? id : made[title];
        if (!blockId) continue;
        const want: "in" | "out" = isParent ? (dir === "out" ? "in" : "out") : dir;
        const port = portsOf(q, blockId, want).find((x) => x.name === portName);
        if (port) return { portId: port.id, side: isParent ? "inner" : "outer" };
      }
      return null;
    };
    for (const c of node.connections) {
      const from = resolve(c.from, "out");
      const to = resolve(c.to, "in");
      if (from && to) q = connect(q, from, to).project;
    }
    q.blocks[id].status = "gray";
  }
  return { project: q, blockId: id };
}

/**
 * テンプレートを階層に挿入する (新しい id で複製。状態は black から)
 * Input : parentId = 置く階層, template, actor
 * Output: { project, blockId }
 */
export function instantiateTemplate(p: Project, parentId: string, template: BlockTemplate, actor: string, position?: { x: number; y: number }): { project: Project; blockId: string } {
  const origin: TemplateOrigin = { id: template.id, name: template.name, version: template.version };
  const r = instantiateNode(p, parentId, template.root, origin, position);
  const q = r.project;
  appendLog(q, { actor, kind: "added", blockId: r.blockId, message: t("テンプレート「{name}」v{version} を挿入: {title}", { name: template.name, version: template.version, title: template.root.title }) });
  return { project: normalizePromotions(q), blockId: r.blockId };
}

/** テンプレートの JSON を読む (形式の検証つき) */
export function parseTemplate(text: string): BlockTemplate {
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(t("JSON として読めません"));
  }
  const tpl = d as Partial<BlockTemplate>; // (文言の t() と名前が重ならないよう tpl)
  if (!tpl || tpl.schema !== "boxglow-block" || !tpl.root || typeof tpl.root.title !== "string") throw new Error(t("Boxglow のテンプレート (boxglow-block) ではありません"));
  const fix = (n: Partial<TemplateNode>): TemplateNode => ({
    title: n.title ?? t("無題")
  , description: n.description ?? ""
  , category: typeof n.category === "string" ? n.category : undefined
  , inputs: (n.inputs ?? []).map((i) => ({ name: i.name, description: i.description ?? "", required: i.required ?? true }))
  , outputs: (n.outputs ?? []).map((o) => ({ name: o.name, description: o.description ?? "" }))
  , children: (n.children ?? []).map(fix)
  , connections: n.connections ?? []
  });
  return {
    schema: "boxglow-block"
  , schemaVersion: 1
  , id: tpl.id ?? newId()
  , name: tpl.name ?? tpl.root.title
  , version: tpl.version ?? 1
  , description: tpl.description ?? ""
  , tags: tpl.tags ?? []
  , createdAt: tpl.createdAt ?? now()
  , updatedAt: tpl.updatedAt ?? now()
  , root: fix(tpl.root)
  };
}

/* ------------------------------------------------------------------ */
/* 期日・時間、検索、入力の供給元                                            */
/* ------------------------------------------------------------------ */

/**
 * カテゴリを設定する
 * Input : blockId, key = categories.ts のキー (null で未分類に戻す)
 * Output: 更新した Project
 */
export function setCategory(p: Project, blockId: string, key: string | null): Project {
  const b = p.blocks[blockId];
  if (!b) return p;
  if (key && !categoryOf(key)) throw new Error(t("知らないカテゴリです: {key}", { key }));
  const q = touch(p);
  if (key) q.blocks[blockId].category = key;
  else delete q.blocks[blockId].category;
  return q;
}

/** 日付と時間を設定する (undefined は変えない、null は消す) */
export function setSchedule(
  p: Project
, blockId: string
, args: { startDate?: string | null; dueDate?: string | null; estimateHours?: number | null; actualHours?: number | null }
, actor: string
): Project {
  const b = p.blocks[blockId];
  if (!b) return p;
  const q = touch(p);
  const target = q.blocks[blockId]; // (文言の t() と名前が重ならないよう target)
  const put = <K extends "startDate" | "dueDate" | "estimateHours" | "actualHours">(k: K, v: Block[K] | null | undefined) => {
    if (v === undefined) return;
    if (v === null || v === "" || (typeof v === "number" && Number.isNaN(v))) delete target[k];
    else target[k] = v;
  };
  put("startDate", args.startDate);
  put("dueDate", args.dueDate);
  put("estimateHours", args.estimateHours);
  put("actualHours", args.actualHours);
  const parts: string[] = [];
  if (args.dueDate !== undefined) parts.push(t("期日 {date}", { date: args.dueDate ?? t("なし") }));
  if (args.startDate !== undefined) parts.push(t("開始 {date}", { date: args.startDate ?? t("なし") }));
  if (args.actualHours !== undefined) parts.push(t("実績 {hours}h", { hours: args.actualHours ?? 0 }));
  if (args.estimateHours !== undefined) parts.push(t("見積 {hours}h", { hours: args.estimateHours ?? 0 }));
  if (parts.length > 0) appendLog(q, { actor, kind: "note", blockId, message: t("「{title}」{detail}", { title: b.title, detail: parts.join(", ") }) });
  return q;
}

/** 期日を過ぎているか (完了していない箱だけ) */
export function isOverdue(b: Block, today = new Date()): boolean {
  if (!b.dueDate || b.status === "white") return false;
  const d = new Date(b.dueDate + "T23:59:59");
  return d.getTime() < today.getTime();
}

/** 期日までの日数 (負なら超過)。期日が無ければ null */
export function daysToDue(b: Block, today = new Date()): number | null {
  if (!b.dueDate) return null;
  const d = new Date(b.dueDate + "T00:00:00");
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d.getTime() - t0.getTime()) / 86400000);
}

/** 題名・短い ID・説明で箱を検索する (大文字小文字を区別しない。ID の完全一致を先頭に) */
export function searchBlocks(p: Project, text: string, limit = 20): Block[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const blocks = Object.values(p.blocks).filter((b) => b.id !== ROOT_ID);
  const exactKey = blocks.filter((b) => b.key?.toLowerCase() === q);
  const catOf = (b: Block) => categoryOf(b.category);
  const rest = blocks.filter((b) => !exactKey.includes(b) && (
    b.title.toLowerCase().includes(q) || (b.key ?? "").toLowerCase().includes(q) || b.description.toLowerCase().includes(q)
    || catOf(b)?.label === text.trim() || catOf(b)?.en === q // カテゴリ名 ("設計" / "design") でも探せる
  ));
  return [...exactKey, ...rest].slice(0, limit);
}

/**
 * 入力ポートの供給元 (線をさかのぼって、最終的に出力ポートか最上位の入力に行き着く)
 * Input : portId = 入力ポート
 * Output: 供給元のポート (無ければ null)。説明はこのポートのものを使う (一重管理)
 */
export function sourceOfInput(p: Project, portId: string, seen: Set<string> = new Set()): Port | null {
  if (seen.has(portId)) return null;
  seen.add(portId);
  const port = p.ports[portId];
  if (!port || port.direction !== "in") return null;
  const e = incomingEdges(p, { portId, side: "outer" })[0];
  if (!e) return null;
  const from = p.ports[e.from.portId];
  if (!from) return null;
  if (from.direction === "out") return from;
  if (from.blockId === ROOT_ID) return from; // 最上位の入力 (ここで説明を書く)
  return sourceOfInput(p, from.id, seen) ?? from;
}

/** 入力ポートの実効の説明 (供給元があればその説明、無ければ自分の説明) */
export function effectiveDescription(p: Project, portId: string): string {
  const port = p.ports[portId];
  if (!port) return "";
  if (port.direction === "out") return port.description;
  const src = sourceOfInput(p, portId);
  return src ? src.description : port.description;
}

/* ------------------------------------------------------------------ */
/* ドラッグ操作の補助: 階層の移動、箱へのドロップで結線                        */
/* ------------------------------------------------------------------ */

/**
 * 箱を別の階層へ移す (ドラッグで別の箱の中に落としたとき)
 * Input : blockId, newParentId = 移す先 (ROOT_ID は不可。プロジェクトの箱かタスク), position = 新しい親の座標系での位置
 * Output: Project。つながらなくなった線 (元の階層の兄弟との線) は外れ、浮いた入力は自動で上がる
 */
/**
 * 階層のならびを上へたどる (自分の階層 → 親の階層 → ... → ROOT)
 * Input : scope = 階層 (= 箱の id。最上位は ROOT_ID)
 * Output: [scope, parent, ..., ROOT_ID]
 */
function scopeChain(p: Project, scope: string): string[] {
  const out: string[] = [];
  let cur: string | null = scope;
  while (cur !== null) {
    out.push(cur);
    cur = p.blocks[cur]?.parentId ?? null;
  }
  return out;
}

/** 箱に同名のポートがあればそれを、無ければ作って返す (手で作ったものだけ。自動のものは別) */
function findOrAddPort(q: Project, blockId: string, direction: "in" | "out", name: string): Port | null {
  const existing = portsOf(q, blockId, direction).find((x) => x.name === name && !x.promotedFrom);
  if (existing) return existing;
  const r = addPort(q, { blockId, direction, name });
  Object.assign(q, r.project);
  return q.ports[r.portId] ?? null;
}

/**
 * 階層が違う 2 つのポートを、間の箱のポートを経由してつなぐ (q を直接書き換える)
 *   出す側: 共通の階層に着くまで、各階層の箱に出力ポートを作って「中 → 箱の出力 (内側)」「箱の出力 (外側) → 次」と上げる
 *   受ける側: 共通の階層から、各階層の箱に入力ポートを作って「箱の入力 (外側) → 箱の入力 (内側) → 中」と下ろす
 * Input : from = 出す側の端点, to = 受ける側の端点
 * Output: なし (つなげない部分は無視。浮いた入力は normalizePromotions が上げる)
 */
export function routeConnect(q: Project, from: Endpoint, to: Endpoint): void {
  const fs = scopeOf(q, from);
  const ts = scopeOf(q, to);
  if (fs === null || ts === null) return;
  const fromPort = q.ports[from.portId];
  const toPort = q.ports[to.portId];
  if (!fromPort || !toPort) return;
  const fChain = scopeChain(q, fs);
  const tChain = scopeChain(q, ts);
  const common = fChain.find((s) => tChain.includes(s));
  if (!common) return;
  let f: Endpoint = from;
  // 出す側を共通の階層まで上げる
  for (const sc of fChain.slice(0, fChain.indexOf(common))) {
    if (sc === ROOT_ID) return;
    const via = findOrAddPort(q, sc, "out", fromPort.name);
    if (!via) return;
    const r = connect(q, f, { portId: via.id, side: "inner" });
    if (!r.error) Object.assign(q, r.project);
    f = { portId: via.id, side: "outer" };
  }
  // 受ける側へ共通の階層から下ろす (上の箱から順に)
  for (const sc of tChain.slice(0, tChain.indexOf(common)).reverse()) {
    if (sc === ROOT_ID) return;
    const via = findOrAddPort(q, sc, "in", toPort.name);
    if (!via) return;
    const r = connect(q, f, { portId: via.id, side: "outer" });
    if (!r.error) Object.assign(q, r.project);
    f = { portId: via.id, side: "inner" };
  }
  const last = connect(q, f, to);
  if (!last.error) Object.assign(q, last.project);
}

/**
 * "<題名>.<ポート名>" の区切り方の候補を左から順に返す (題名やポート名にドットが含まれていてもよい)
 * Input : ref
 * Output: [{ title, portName }, ...] (最初のドット、次のドット、... の順)
 */
export function refSplits(ref: string): { title: string; portName: string }[] {
  const out: { title: string; portName: string }[] = [];
  for (let i = ref.indexOf("."); i >= 0; i = ref.indexOf(".", i + 1)) {
    const title = ref.slice(0, i);
    const portName = ref.slice(i + 1);
    if (title && portName) out.push({ title, portName });
  }
  return out;
}

/**
 * ブロックを別の階層へ移す (ドラッグで箱の中へ落とす / 外へ出す)
 * 自分に付いていた線は切らず、間の箱のポートを経由して付け替える (routeConnect)。
 *   例: 中の階層から外へ出すと、元の兄弟との線は元の親の出力 / 入力を経由してつながったままになる
 * Input : blockId = 動かす箱, newParentId = 新しい親, position = 新しい親の座標系での位置
 * Output: 更新した Project (移せないときはそのまま)
 */
export function moveBlockToParent(p: Project, blockId: string, newParentId: string, position: { x: number; y: number }): Project {
  const b = p.blocks[blockId];
  const np = p.blocks[newParentId];
  if (!b || !np || blockId === ROOT_ID || newParentId === ROOT_ID || b.parentId === newParentId) return p;
  if (kindOf(b) === "project") return p;
  // 自分の子孫の中へは移せない
  if (newParentId === blockId || descendantsOf(p, blockId).some((d) => d.id === newParentId)) return p;
  const q = touch(p);
  const oldParentId = b.parentId;
  // 付け替える線を先に集めておく (自分のポートの外側に付いている、手で引いた線)
  const myPorts = new Set(portsOf(q, blockId).map((x) => x.id));
  const pending: { from: Endpoint; to: Endpoint }[] = [];
  for (const e of Object.values(q.edges)) {
    const mineIsFrom = myPorts.has(e.from.portId) && e.from.side === "outer";
    const mineIsTo = myPorts.has(e.to.portId) && e.to.side === "outer";
    if (!mineIsFrom && !mineIsTo) continue;
    delete q.edges[e.id];
    if (e.auto) continue;
    const myEp = mineIsFrom ? e.from : e.to;
    const otherEp = mineIsFrom ? e.to : e.from;
    const otherPort = q.ports[otherEp.portId];
    if (!otherPort) continue;
    // 相手が移動先の箱そのもの (外側) の線: 自分がその箱の中に入るので意味を失う (切る)
    if (otherEp.side === "outer" && otherPort.blockId === newParentId) continue;
    if (otherEp.side === "inner" && otherPort.blockId === oldParentId && oldParentId !== null) {
      // 相手が元の親の内側のポート (親から下りてくる / 親へ上がる線): 元の親の外側の相手と直接つなぎ直す
      if (mineIsTo) {
        const src = incomingEdges(q, { portId: otherPort.id, side: "outer" })[0];
        if (src) pending.push({ from: src.from, to: myEp });
      } else {
        for (const dst of outgoingEdges(q, { portId: otherPort.id, side: "outer" })) pending.push({ from: myEp, to: dst.to });
      }
      continue;
    }
    pending.push(mineIsFrom ? { from: myEp, to: otherEp } : { from: otherEp, to: myEp });
  }
  q.blocks[blockId].parentId = newParentId;
  q.blocks[blockId].position = { x: Math.max(CHILD_PADDING.left, position.x), y: Math.max(childTop(q, newParentId), position.y) };
  // 新しい階層で、間の箱を経由してつなぎ直す
  for (const pr of pending) routeConnect(q, pr.from, pr.to);
  if (q.blocks[newParentId].status === "black") q.blocks[newParentId].status = "gray";
  q.blocks[newParentId].collapsed = false;
  appendLog(q, { actor: "human", kind: "note", blockId, message: t("「{title}」を「{parent}」の中へ移動", { title: b.title, parent: np.title }) });
  return normalizePromotions(q);
}

/**
 * 出力 (または親の入力) を、箱そのものにドロップしたときの結線
 * 空いている入力 (線が来ていない、自動の線だけの入力) があればそこへ、無ければ出力と同じ名前の入力を作ってつなぐ
 * Input : from = 出す側の端点, targetBlockId = 落とした箱
 * Output: { project, error }
 */
export function connectToBlock(p: Project, from: Endpoint, targetBlockId: string): { project: Project; error?: string } {
  const fp = p.ports[from.portId];
  const tb = p.blocks[targetBlockId];
  if (!fp || !tb || targetBlockId === ROOT_ID) return { project: p, error: t("つなぐ先が見つかりません") };
  // 出す側の階層と、落とした箱の階層が合うか (同じ階層の箱、または出す側が親の入力ならその子)
  const fromScope = scopeOf(p, from);
  const targetIsChildOfSource = fp.direction === "in" && from.side === "inner" && tb.parentId === fp.blockId;
  const sameScope = fromScope !== null && tb.parentId === fromScope;
  // 落とした箱が出す側の親なら、親の出力 (内側) につなぐ
  const targetIsParent = fp.direction === "out" && from.side === "outer" && p.blocks[fp.blockId]?.parentId === targetBlockId;
  if (targetIsParent) {
    const outs = portsOf(p, targetBlockId, "out");
    const free = outs.find((o) => incomingEdges(p, { portId: o.id, side: "inner" }).length === 0) ?? outs[0];
    if (!free) return { project: p, error: t("親に出力がありません") };
    return connect(p, from, { portId: free.id, side: "inner" });
  }
  if (!sameScope && !targetIsChildOfSource) return { project: p, error: t("同じ階層の箱 (または親子) にだけつなげます") };
  const ins = portsOf(p, targetBlockId, "in");
  let target = ins.find((i) => incomingEdges(p, { portId: i.id, side: "outer" }).every((e) => e.auto) && !i.promotedFrom);
  let q = p;
  if (!target) {
    const r = addPort(p, { blockId: targetBlockId, direction: "in", name: fp.name });
    q = r.project;
    target = q.ports[r.portId];
  }
  return connect(q, from, { portId: target.id, side: "outer" });
}

/** 箱と箱の間に要る間隔: 線は箱の縁から 36px 離れるので、両側で 72px + 線 1 本分。8px 単位で 96px */
const GAP = 96;

type SizeOf = (p: Project, id: string) => { width: number; height: number };

/**
 * 1 つの箱を、重なっている兄弟から押し出す (q を直接書き換える。箱のオブジェクトは差し替える = 元の Project は壊さない)
 * Input : q = blocks が浅くコピーされた Project, blockId, sizeOf, against = 避ける兄弟の id (省略時は全部),
 *         siblings = 同じ階層の箱の id (childrenOf の走査を省くため呼び出し側で渡せる)
 * Output: 動かしたら true
 */
function pushOut(q: Project, blockId: string, sizeOf: SizeOf, against?: Set<string>, siblings?: string[]): boolean {
  const b = q.blocks[blockId];
  if (!b || b.parentId === null) return false;
  const sibIds = siblings ?? childrenOf(q, b.parentId).map((s) => s.id);
  const me = sizeOf(q, blockId);
  // 確定済みの箱だけを避けるとき (全体の解消) は右か下にしか動かさない: 上や左へ戻すと、先に確定した別の箱に当たって
  // 「下へ押す ↔ 上へ戻す」の往復になり、重なったまま終わる。右・下だけなら単調に進むので必ず終わる (回数の上限も大きく取る)
  const forwardOnly = !!against;
  let moved = false;
  for (let iter = 0; iter < (forwardOnly ? 64 : 8); iter++) {
    const cur = q.blocks[blockId];
    let sib: Block | undefined;
    for (const id of sibIds) {
      if (id === blockId) continue;
      if (against && !against.has(id)) continue; // まだ確定していない (後で動かす) 箱は避けない
      const s = q.blocks[id];
      const sz = sizeOf(q, id);
      if (cur.position.x < s.position.x + sz.width + GAP && cur.position.x + me.width + GAP > s.position.x
        && cur.position.y < s.position.y + sz.height + GAP && cur.position.y + me.height + GAP > s.position.y) { sib = s; break; }
    }
    if (!sib) break;
    const sz = sizeOf(q, sib.id);
    // 4 方向の押し出し量を比べ、一番小さいものを採る
    const moves = [
      { x: sib.position.x + sz.width + GAP, y: cur.position.y, d: sib.position.x + sz.width + GAP - cur.position.x }
    , { x: cur.position.x, y: sib.position.y + sz.height + GAP, d: sib.position.y + sz.height + GAP - cur.position.y }
    , { x: sib.position.x - me.width - GAP, y: cur.position.y, d: cur.position.x - (sib.position.x - me.width - GAP) }
    , { x: cur.position.x, y: sib.position.y - me.height - GAP, d: cur.position.y - (sib.position.y - me.height - GAP) }
    ].filter((m, i) => m.d >= 0 && (!forwardOnly || i < 2)); // 先頭 2 つが右・下
    const nested = cur.parentId !== ROOT_ID;
    const ok = moves.filter((m) => !nested || (m.x >= CHILD_PADDING.left && m.y >= childTop(q, cur.parentId!)));
    const best = (ok.length > 0 ? ok : moves).sort((a, c) => a.d - c.d)[0];
    if (!best) break;
    q.blocks[blockId] = { ...cur, position: { x: best.x, y: best.y } };
    moved = true;
  }
  return moved;
}

/**
 * ドラッグで離した箱が同じ階層の箱と重なっていたら、最小の移動で押し出す
 * Input : blockId, sizeOf = 箱の大きさを返す関数 (size.ts の blockSize),
 *         against = 避ける兄弟の id (省略時は同じ階層の全部。resolveAllOverlaps は「先に確定した箱」だけを渡し、
 *         後ろの箱は順に玉突きで動かす。全部を避けると、左右の箱に挟まれたとき右へ押す ↔ 左へ戻すの往復で終わらない)
 * Output: 位置を直した Project (動かなければ元のまま)
 */
export function resolveOverlap(p: Project, blockId: string, sizeOf: SizeOf, against?: Set<string>): Project {
  const q: Project = { ...p, blocks: { ...p.blocks } };
  return pushOut(q, blockId, sizeOf, against) ? q : p;
}

/**
 * すべての階層で、重なっている兄弟を押し出す (移動・幅の変化・追加のたびに呼ぶ。表示用の計画にも毎回掛ける)
 * 位置が上 (左) の箱を優先して残し、後の箱を動かす。
 * 各箱は「先に確定した箱」だけを避ける (玉突き): 1 つ目の箱が広がって 2 つ目を右へ押すと、3 つ目は押された 2 つ目を避けて右へ、と順に動く。
 * (全部の兄弟を避けさせると、2 つ目が 1 つ目と 3 つ目に挟まれて右へ ↔ 左への往復になり、重なったまま終わることがある)
 * 速さのために: Project は複製せず、動いた箱だけ差し替える。大きさは箱ごとに 1 回だけ見積もる (深い階層から順に処理するので、
 * 開いた箱の大きさを見積もる時点で中の箱の位置は確定している)。何も動かなければ元の Project をそのまま返す
 * Input : sizeOf = 箱の大きさを返す関数 (size.ts の blockSize)
 * Output: 位置を直した Project
 */
export function resolveAllOverlaps(p: Project, sizeOf: SizeOf): Project {
  const q: Project = { ...p, blocks: { ...p.blocks } };
  // 親ごとの子の一覧 (1 回の走査で作る)
  const kidsOf = new Map<string, string[]>();
  for (const b of Object.values(q.blocks)) {
    if (b.id === ROOT_ID || b.parentId === null) continue;
    const list = kidsOf.get(b.parentId) ?? [];
    list.push(b.id);
    kidsOf.set(b.parentId, list);
  }
  // 深さ (根からの段数)。深い階層の親から処理する
  const depthOf = (id: string): number => { let d = 0; let cur = q.blocks[id]?.parentId; while (cur) { d++; cur = q.blocks[cur]?.parentId; } return d; };
  const parents = [...kidsOf.keys()].sort((a, b) => depthOf(b) - depthOf(a));
  // 大きさは箱ごとに 1 回 (位置は大きさに効かない。開いた箱は中の箱の位置に効くが、中の階層を先に済ませてから見積もる)
  const sizes = new Map<string, { width: number; height: number }>();
  const cachedSize: SizeOf = (pp, id) => { let s = sizes.get(id); if (!s) { s = sizeOf(pp, id); sizes.set(id, s); } return s; };
  let moved = false;
  for (const parentId of parents) {
    const kids = (kidsOf.get(parentId) ?? []).slice().sort((a, b) => q.blocks[a].position.y - q.blocks[b].position.y || q.blocks[a].position.x - q.blocks[b].position.x);
    const settled = new Set<string>(kids.slice(0, 1));
    for (let i = 1; i < kids.length; i++) {
      if (pushOut(q, kids[i], cachedSize, settled, kids)) moved = true;
      settled.add(kids[i]);
    }
  }
  return moved ? q : p;
}

/* ------------------------------------------------------------------ */
/* 最上位の入力のグループ                                                  */
/* ------------------------------------------------------------------ */

/** グループの一覧 */
export const inputGroupsOf = (p: Project): InputGroup[] => p.inputGroups ?? [];

/** 最上位の入力のうち、指定したグループ (null なら既定の入力ノード) に属するもの */
export function rootInputsOf(p: Project, groupId: string | null): Port[] {
  return portsOf(p, ROOT_ID, "in").filter((x) => (groupId === null ? !x.groupId : x.groupId === groupId));
}

/** グループを作る */
export function addInputGroup(p: Project, name: string): { project: Project; groupId: string } {
  const q = touch(p);
  const list = q.inputGroups ?? (q.inputGroups = []);
  const id = newId();
  const y = list.length === 0 ? q.terminals.in.y + 160 : Math.max(...list.map((gp) => gp.position.y)) + 160;
  list.push({ id, name, description: "", position: { x: q.terminals.in.x, y } });
  appendLog(q, { actor: "human", kind: "added", message: t("入力グループ「{name}」を追加", { name }) });
  return { project: q, groupId: id };
}

/** グループの名前・説明を変える */
export function updateInputGroup(p: Project, groupId: string, patch: { name?: string; description?: string }): Project {
  const q = touch(p);
  const gp = (q.inputGroups ?? []).find((x) => x.id === groupId);
  if (!gp) return p;
  Object.assign(gp, patch);
  return q;
}

/** グループを消す (入力は既定の入力ノードへ戻る) */
export function removeInputGroup(p: Project, groupId: string): Project {
  const q = touch(p);
  q.inputGroups = (q.inputGroups ?? []).filter((x) => x.id !== groupId);
  for (const x of Object.values(q.ports)) if (x.groupId === groupId) delete x.groupId;
  return q;
}

/** 入力をグループに入れる (null で既定へ)。最上位の入力だけ */
export function setInputGroup(p: Project, portId: string, groupId: string | null): Project {
  const port = p.ports[portId];
  if (!port || port.blockId !== ROOT_ID || port.direction !== "in") return p;
  const q = touch(p);
  if (groupId) q.ports[portId].groupId = groupId;
  else delete q.ports[portId].groupId;
  return q;
}

/** グループのノードを動かす */
export function moveInputGroup(p: Project, groupId: string, position: { x: number; y: number }): Project {
  const q = clone(p);
  const gp = (q.inputGroups ?? []).find((x) => x.id === groupId);
  if (!gp) return p;
  gp.position = position;
  return q;
}

/** グループを JSON に書き出す (他のプロジェクトで同じ入力の束を使うため) */
export function exportInputGroup(p: Project, groupId: string): string {
  const gp = (p.inputGroups ?? []).find((x) => x.id === groupId);
  const inputs = rootInputsOf(p, groupId).map((x) => ({ name: x.name, description: x.description, artifacts: x.artifacts.map((a) => ({ title: a.title, url: a.url })) }));
  return JSON.stringify({ schema: "boxglow-input-group", name: gp?.name ?? "", description: gp?.description ?? "", inputs }, null, 2);
}

/** グループの JSON を読み込んでグループと入力を作る */
export function importInputGroup(p: Project, text: string): { project: Project; groupId: string } {
  let d: { schema?: string; name?: string; description?: string; inputs?: { name: string; description?: string; artifacts?: { title: string; url?: string }[] }[] };
  try {
    d = JSON.parse(text);
  } catch {
    throw new Error(t("JSON として読めません"));
  }
  if (d.schema !== "boxglow-input-group" || !Array.isArray(d.inputs)) throw new Error(t("入力グループの JSON (boxglow-input-group) ではありません"));
  const r = addInputGroup(p, d.name ?? "Inputs");
  let q = updateInputGroup(r.project, r.groupId, { description: d.description ?? "" });
  for (const i of d.inputs) {
    const a = addPort(q, { blockId: ROOT_ID, direction: "in", name: i.name });
    q = updatePort(a.project, a.portId, { description: i.description ?? "", artifacts: (i.artifacts ?? []).map((x) => createArtifact(x.title, x.url ?? "")) });
    q = setInputGroup(q, a.portId, r.groupId);
  }
  return { project: q, groupId: r.groupId };
}

/**
 * 外部の課題の URL から短いキーを取り出す (札に出す用)
 * Input : url = https://jira.example.com/browse/PROJ-123 など
 * Output: "PROJ-123" / "#45" (Redmine, GitHub) / ホスト名 (分からないとき)
 */
export function issueKeyOf(url: string): string {
  const u = url.trim();
  let m = u.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/i); // JIRA
  if (m) return m[1].toUpperCase();
  m = u.match(/\/issues\/(\d+)/); // Redmine / GitHub / GitLab
  if (m) return `#${m[1]}`;
  m = u.match(/\/pull\/(\d+)/); // GitHub PR
  if (m) return `PR #${m[1]}`;
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u.slice(0, 20); }
}

/**
 * 1 本の線と「同じ信号」としてつながっている線の集合 (親の縁のポートを通り抜けて続く区間をすべて含む)
 *   出力 (外側) → 親の出力 (内側) → 親の出力 (外側) → 兄弟の入力 (外側) → 入力 (内側) → 子の入力 (外側) ... と、
 *   ポートの内側 / 外側で続く線をたどる。箱の中の処理 (入力 → 出力) はまたがない
 * Input : edgeId
 * Output: 線 id の集合 (自分を含む)
 */
/**
 * 1 本の線 (と、境界を越えた先の続き) が見えるタブの一覧
 * 線は「両端の箱が見える画面」に描かれる: 両端とも大項目の中なら、その大項目のタブ。大項目どうし・最上位の入出力との線は All (null)
 * Input : edgeId
 * Output: タブ (大項目の id、All は null) の配列。出す側のタブから受ける側のタブへの順。重複なし
 */
export function wireNetTabs(p: Project, edgeId: string): (string | null)[] {
  const out: (string | null)[] = [];
  const push = (t: string | null) => { if (!out.includes(t)) out.push(t); };
  const tabOf = (e: Edge): string | null => {
    const a = p.ports[e.from.portId]?.blockId;
    const b = p.ports[e.to.portId]?.blockId;
    // 大項目の外側のポートどうし (兄弟の線) や最上位との線は All。片方が中の箱なら、その大項目のタブ
    const ma = a && a !== ROOT_ID ? majorOf(p, a) : null;
    const mb = b && b !== ROOT_ID ? majorOf(p, b) : null;
    const inner = (id: string | undefined, side: "inner" | "outer") => !!id && id !== ROOT_ID && (majorOf(p, id) !== id || side === "inner");
    if (inner(a, e.from.side)) return ma;
    if (inner(b, e.to.side)) return mb;
    return null;
  };
  // 上流側から順に並ぶように、選んだ線のタブを基準に上流・下流を集める (wireNet は集合なので、順序はここで付け直す)
  const net = wireNet(p, edgeId);
  const edges = [...net].map((id) => p.edges[id]).filter((e): e is Edge => !!e);
  const start = p.edges[edgeId];
  const upstream = edges.filter((e) => e !== start && isUpstreamOf(p, e, start, net));
  const downstream = edges.filter((e) => e !== start && !upstream.includes(e));
  for (const e of upstream) push(tabOf(e));
  if (start) push(tabOf(start));
  for (const e of downstream) push(tabOf(e));
  return out;
}

/** e が start より上流 (start の出す側のポートへ、反対の面からたどり着く線) か */
function isUpstreamOf(p: Project, e: Edge, start: Edge | undefined, net: Set<string>): boolean {
  if (!start) return false;
  const stack = [start];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    const fp = p.ports[cur.from.portId];
    if (!fp) continue;
    const backSide: "inner" | "outer" = cur.from.side === "outer" ? "inner" : "outer";
    for (const id of net) {
      const x = p.edges[id];
      if (!x || seen.has(id)) continue;
      if (x.to.portId === fp.id && x.to.side === backSide) {
        if (x.id === e.id) return true;
        seen.add(id);
        stack.push(x);
      }
    }
  }
  return false;
}

export function wireNet(p: Project, edgeId: string): Set<string> {
  // 選んだ線から、上流は上流へだけ、下流は下流へだけたどる (向きを折り返さない)。
  // 折り返すと「同じ境界のポートから枝分かれした兄弟の線」まで全部入ってしまい、見にくい
  const out = new Set<string>([edgeId]);
  const edges = Object.values(p.edges);
  const start = p.edges[edgeId];
  if (!start) return out;
  // 上流へ: 出す側のポートの反対の面に入ってくる線をたどる
  const up = [start];
  while (up.length > 0) {
    const e = up.pop()!;
    const fp = p.ports[e.from.portId];
    if (!fp) continue;
    const backSide: "inner" | "outer" = e.from.side === "outer" ? "inner" : "outer";
    for (const x of edges) {
      if (x.to.portId === fp.id && x.to.side === backSide && !out.has(x.id)) { out.add(x.id); up.push(x); }
    }
  }
  // 下流へ: 受ける側のポートの反対の面から出ていく線をたどる (境界を越えた先で分かれる線は、その先の続きなので含める)
  const down = [start];
  while (down.length > 0) {
    const e = down.pop()!;
    const tp = p.ports[e.to.portId];
    if (!tp) continue;
    const nextSide: "inner" | "outer" = e.to.side === "outer" ? "inner" : "outer";
    for (const x of edges) {
      if (x.from.portId === tp.id && x.from.side === nextSide && !out.has(x.id)) { out.add(x.id); down.push(x); }
    }
  }
  return out;
}
