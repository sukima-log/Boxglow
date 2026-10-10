/**
 * 分岐 (ロードマップの時点で決まっていない分かれ道) と合流
 *
 * - 分岐のボックス: Block.branch = { decisionId } を持ち、選択肢ごとに 1 つずつ出力 (Port.branchOption = 選択肢) を持つ。
 *   判断に答えると、答えと同じ選択肢の出力が「選んだ道」、それ以外の出力が「見送りの道」になる。答える前は、どの道も「未定」。
 * - 合流の入力: Port.anyOf = true の入力どうしは「どれか 1 つが届けばよい」(分かれた道が後で 1 つにまとまるところ)。
 *
 * ここでは、計画から「見送りのボックス」と「分岐待ちのボックス」を求める (ファイルには書かない。計画から毎回求める値)。
 *   見送り (skipped): 選ばなかった道の先にあるボックス。薄く残し、進捗・次の候補・担当の一覧から外す
 *   分岐待ち (pending): まだ答えていない分岐の先にあるボックス。次の候補から外し、着手するときに警告する
 */
import { addBlock, addPort, askDecision, childrenOf, descendantsOf, kindOf, portsOf, updatePort } from "./graph";
import { ROOT_ID, type Block, type Decision, type Port, type Project } from "./types";
import { t } from "../i18n/core";

/** 線の端の状態: 未定の道 / 見送りの道 (見送りのほうが強い。一度見送りになった端は未定に戻らない) */
type Taint = "pending" | "rejected";

/** 分岐の状態の計算結果 */
export interface BranchState {
  /** 見送りのボックス (選ばなかった道の先) */
  skipped: Set<string>;
  /** 分岐待ちのボックス → 待っている分岐のボックスの id (まだ答えていない分岐の先) */
  pending: Map<string, string[]>;
  /** 見送りの道の線 (画面で薄く描く) */
  rejectedEdges: Set<string>;
  /** 未定の道の線 (画面で、未定と分かるように描く) */
  pendingEdges: Set<string>;
  /** 見送りの道から来る入力 (合流の入力のうち、もう届かないもの。入力待ちに数えない) */
  rejectedInputs: Set<string>;
}

/** 計算結果の置き場 (計画は変更のたびに新しいオブジェクトになるので、同じ計画なら同じ結果を使い回す) */
const cache = new WeakMap<Project, BranchState>();

/**
 * 分岐のボックスの判断 (印が指す判断。消えていれば、そのボックスの最新の判断)
 * Input : b = ボックス / Output: 判断 (無ければ undefined)
 */
export function branchDecision(b: Block): Decision | undefined {
  if (!b.branch) return undefined;
  return b.decisions.find((d) => d.id === b.branch!.decisionId) ?? b.decisions.at(-1);
}

/**
 * 分岐で選ばれた選択肢 (答えが選択肢のどれかと同じときだけ。自由記述の答えは、どの道も選んでいない = 未定として扱う)
 * Input : b = 分岐のボックス / Output: 選んだ選択肢 (未定なら undefined)
 */
export function chosenOption(b: Block): string | undefined {
  const d = branchDecision(b);
  if (!d || d.answer === undefined) return undefined;
  return d.options.includes(d.answer) ? d.answer : undefined;
}

/**
 * 計画の分岐の状態を求める (見送り・分岐待ちのボックスと、見送り・未定の線)
 * Input : p = 計画 / Output: BranchState (同じ計画なら前の結果を返す)
 *
 * 求め方: 分岐のボックスの出力から、線をたどって「見送り」「未定」の印を広げる。
 *   - 入力の外側に印が届いたら、内側 (中の子への線) にも同じ印を付ける
 *   - 子の出力から親の出力へ束ねる線は、束ねるすべての線に印があるときだけ、親の出力にも印を付ける (一部だけなら、他の道から届く)
 *   - ボックスは、必須で合流でない入力のどれかに印がある、または必須の合流の入力がすべて印付きなら、その印の状態になる
 *     (見送りの印があれば見送り、無ければ未定 = 分岐待ち)。任意の入力は無くても着手できるので、判定に使わない。
 *     親の状態は子も引き継ぐ (親が見送りなら子も見送り、親が分岐待ちなら子も分岐待ち)
 *   - 印の付いたボックスの出力にも同じ印を付けて、先へ広げる
 * 速さ: 対応表 (箱 → ポート、端 → 線、親 → 子) を最初に 1 回だけ作り、印が変わった端と箱だけを順に処理する (作業の待ち行列)。
 *   印は強くなる向きにしか変わらず、元の分岐の集合も増えるだけなので、必ず止まる
 */
export function branchState(p: Project): BranchState {
  const hit = cache.get(p);
  if (hit) return hit;
  const result: BranchState = { skipped: new Set(), pending: new Map(), rejectedEdges: new Set(), pendingEdges: new Set(), rejectedInputs: new Set() };
  if (!Object.values(p.blocks).some((b) => b.branch)) { cache.set(p, result); return result; }

  // ---- 対応表を 1 回だけ作る ----
  const key = (portId: string, side: "outer" | "inner") => `${portId}:${side}`;
  const insOf = new Map<string, Port[]>();   // 箱 → 入力
  const outsOf = new Map<string, Port[]>();  // 箱 → 出力
  for (const port of Object.values(p.ports)) {
    const m = port.direction === "in" ? insOf : outsOf;
    m.set(port.blockId, [...(m.get(port.blockId) ?? []), port]);
  }
  const edges = Object.values(p.edges);
  const from = new Map<string, typeof edges>(); // 出る端 → 線
  const into = new Map<string, typeof edges>(); // 入る端 → 線
  for (const e of edges) {
    const f = key(e.from.portId, e.from.side), t = key(e.to.portId, e.to.side);
    from.set(f, [...(from.get(f) ?? []), e]);
    into.set(t, [...(into.get(t) ?? []), e]);
  }
  const kids = new Map<string, string[]>(); // 親 → 子
  for (const b of Object.values(p.blocks)) if (b.parentId) kids.set(b.parentId, [...(kids.get(b.parentId) ?? []), b.id]);
  const isTask = (id: string) => { const b = p.blocks[id]; return !!b && id !== ROOT_ID && kindOf(b) !== "project"; };

  // ---- 印と、作業の待ち行列 ----
  const taint = new Map<string, Taint>();            // 端 (ポート:面) / 箱 ("box:<id>") の印
  const origin = new Map<string, Set<string>>();     // 印の元になった分岐 (分岐待ちが、どの分岐を待っているか)
  const rank = (t: Taint | undefined) => (t === "rejected" ? 2 : t === "pending" ? 1 : 0);
  const portQueue: string[] = [];
  const boxQueue: string[] = [];
  /**
   * 印を付ける。強くなったか、元の分岐が増えたときだけ true (そのときだけ先へ広げ直す)
   * Input : k = 端か箱の鍵, t = 印, src = 元の分岐 / Output: 変化したか
   */
  const mark = (k: string, t: Taint, src: Iterable<string>): boolean => {
    let changed = false;
    if (rank(t) > rank(taint.get(k))) { taint.set(k, t); changed = true; }
    const set = origin.get(k) ?? new Set<string>();
    for (const id of src) if (!set.has(id)) { set.add(id); changed = true; }
    origin.set(k, set);
    return changed;
  };
  const markPort = (k: string, t: Taint, src: Iterable<string>) => { if (mark(k, t, src)) portQueue.push(k); };

  // 1. 分岐のボックスの出力 (外側) に、見送り / 未定の印を付ける
  for (const b of Object.values(p.blocks)) {
    if (!b.branch) continue;
    const chosen = chosenOption(b);
    for (const out of outsOf.get(b.id) ?? []) {
      if (out.branchOption === undefined) continue; // 選択肢に対応しない出力 (共通の出力) は印を付けない
      if (chosen === undefined) markPort(key(out.id, "outer"), "pending", [b.id]);
      else if (out.branchOption !== chosen) markPort(key(out.id, "outer"), "rejected", [b.id]);
    }
  }

  /**
   * 箱の状態を、必須の入力の印と親の状態から決め直す。変われば出力と子へ広げる
   * Input : id = 箱 / Output: なし
   */
  const evaluateBox = (id: string) => {
    if (!isTask(id)) return;
    const b = p.blocks[id];
    const ins = (insOf.get(id) ?? []).filter((q) => q.required);
    // 合流のボックスの入力は、すべて「どれか 1 つでよい」入力として扱う
    const plain = ins.filter((q) => !q.anyOf && !b.merge).map((q) => taint.get(key(q.id, "outer")));
    const any = ins.filter((q) => q.anyOf || b.merge).map((q) => taint.get(key(q.id, "outer")));
    let t: Taint | undefined;
    if (plain.some((x) => x === "rejected") || (any.length > 0 && any.every((x) => x === "rejected"))) t = "rejected";
    else if (plain.some((x) => x === "pending") || (any.length > 0 && any.every(Boolean) && any.some((x) => x === "pending"))) t = "pending";
    const parent = b.parentId ? taint.get(`box:${b.parentId}`) : undefined;
    if (parent === "rejected") t = "rejected";
    else if (parent === "pending" && !t) t = "pending";
    if (!t) return;
    // 元の分岐: 印の付いた必須の入力の元と、親の元
    const src = [...ins.flatMap((q) => [...(origin.get(key(q.id, "outer")) ?? [])]), ...(b.parentId ? [...(origin.get(`box:${b.parentId}`) ?? [])] : [])];
    if (!mark(`box:${id}`, t, src)) return;
    const boxT = taint.get(`box:${id}`)!;
    const boxSrc = origin.get(`box:${id}`) ?? [];
    for (const out of outsOf.get(id) ?? []) markPort(key(out.id, "outer"), boxT, boxSrc);
    for (const child of kids.get(id) ?? []) boxQueue.push(child);
  };

  // 2. 変化した端と箱だけを順に処理する
  while (portQueue.length > 0 || boxQueue.length > 0) {
    const k = portQueue.pop();
    if (k !== undefined) {
      const t = taint.get(k)!;
      const src = origin.get(k) ?? [];
      // 線: この端から出る線の先へ
      for (const e of from.get(k) ?? []) markPort(key(e.to.portId, e.to.side), t, src);
      const [portId, side] = k.split(":") as [string, "outer" | "inner"];
      const port = p.ports[portId];
      if (!port) continue;
      if (port.direction === "in" && side === "outer") {
        // 入力の外側: 内側 (中の子への線) にも付け、持ち主の箱を決め直す
        markPort(key(port.id, "inner"), t, src);
        boxQueue.push(port.blockId);
      } else if (port.direction === "out" && side === "inner") {
        // 出力の内側 (中の子から束ねる線): すべての線に印があれば外側へ (一番弱い印)
        const incoming = into.get(k) ?? [];
        const ts = incoming.map((e) => taint.get(key(e.from.portId, e.from.side)));
        if (incoming.length > 0 && ts.every(Boolean)) {
          const weakest: Taint = ts.some((x) => x === "pending") ? "pending" : "rejected";
          markPort(key(port.id, "outer"), weakest, incoming.flatMap((e) => [...(origin.get(key(e.from.portId, e.from.side)) ?? [])]));
        }
      }
      continue;
    }
    evaluateBox(boxQueue.pop()!);
  }

  // 3. 結果にまとめる (見送りの子孫も見送り)
  for (const [k, t] of taint) {
    if (!k.startsWith("box:")) continue;
    const id = k.slice(4);
    if (t === "rejected") { result.skipped.add(id); for (const d of descendantsOf(p, id)) result.skipped.add(d.id); }
  }
  for (const [k, t] of taint) {
    if (!k.startsWith("box:") || t !== "pending") continue;
    const id = k.slice(4);
    if (!result.skipped.has(id)) result.pending.set(id, [...(origin.get(k) ?? [])].filter((x) => p.blocks[x]?.branch));
  }
  for (const e of edges) {
    const t = taint.get(key(e.from.portId, e.from.side));
    if (t === "rejected") result.rejectedEdges.add(e.id);
    else if (t === "pending") result.pendingEdges.add(e.id);
  }
  for (const port of Object.values(p.ports)) {
    if (port.direction === "in" && taint.get(key(port.id, "outer")) === "rejected") result.rejectedInputs.add(port.id);
  }
  cache.set(p, result);
  return result;
}

/** 見送りのボックスか (選ばなかった道の先) */
export const isSkipped = (p: Project, blockId: string): boolean => branchState(p).skipped.has(blockId);

/**
 * 分岐待ちの理由 (まだ答えていない分岐の名前の一覧)。分岐待ちでなければ空
 * Input : p, blockId / Output: 待っている分岐のボックスの題名の一覧
 */
export function waitingBranches(p: Project, blockId: string): string[] {
  return (branchState(p).pending.get(blockId) ?? []).map((id) => p.blocks[id]?.title ?? id);
}

/** 子が全部見送りかを含めて、ボックスを進捗や一覧の対象から外すか (見送りなら外す) */
export const excludedFromWork = (p: Project, blockId: string): boolean => isSkipped(p, blockId);

/** 見送りでない子 (進捗の平均などで使う) */
export const activeChildrenOf = (p: Project, blockId: string): Block[] => childrenOf(p, blockId).filter((c) => !isSkipped(p, c.id));

/**
 * 分岐のボックスを作る (ロードマップの時点で決まっていない分かれ道)
 * Input : p = 計画, args = { parentId: 置く先, title: 題名, question: 判断の問い, options: 選択肢 (2 つ以上), context: 判断材料,
 *         actor: 作った人 (判断を聞いた人として記録), position: 置く位置 (省略可) }
 * Output: { project, blockId, decisionId }。選択肢ごとに 1 本ずつ出力 (名前 = 選択肢) を持ち、判断待ちになる
 */
export function addBranch(p: Project, args: { parentId: string; title: string; question: string; options: string[]; context?: string; actor: string; position?: { x: number; y: number } }): { project: Project; blockId: string; decisionId: string } {
  const options = [...new Set(args.options.map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) throw new Error("options");
  // 1. ボックスを作る (既定の出力 1 本を、最初の選択肢の出力にする)
  const made = addBlock(p, { parentId: args.parentId, title: args.title, position: args.position, actor: args.actor, outputName: options[0] });
  let q = made.project;
  // 2. 判断 (問いと選択肢) を付け、分岐の印を付ける (印が先に無いと、2 本目以降の出力を足せない)
  const asked = askDecision(q, made.blockId, args.actor, args.question, options, args.context ?? "");
  q = asked.project;
  q = { ...q, blocks: { ...q.blocks, [made.blockId]: { ...q.blocks[made.blockId], branch: { decisionId: asked.decisionId! } } } };
  // 3. 選択肢ごとの出力にする (1 本目は名前を合わせ、2 本目以降を足す)
  const first = portsOf(q, made.blockId, "out")[0];
  q = updatePort(q, first.id, { branchOption: options[0] });
  for (const option of options.slice(1)) {
    const added = addPort(q, { blockId: made.blockId, direction: "out", name: option });
    q = updatePort(added.project, added.portId, { branchOption: option });
  }
  return { project: q, blockId: made.blockId, decisionId: asked.decisionId! };
}

/**
 * 入力を合流の入力にする / 戻す (合流の入力どうしは、どれか 1 つが届けばよい)
 * Input : p, portId = 入力ポート, on = true で合流、false で通常 / Output: 更新した計画 (入力でなければそのまま)
 */
export function setInputAnyOf(p: Project, portId: string, on: boolean): Project {
  const port = p.ports[portId];
  if (!port || port.direction !== "in") return p;
  if (on) return updatePort(p, portId, { anyOf: true });
  // 通常に戻す: 項目ごと消す (古い版との差分を増やさない)
  const q: Project = { ...p, ports: { ...p.ports, [portId]: { ...port } } };
  delete q.ports[portId].anyOf;
  return q;
}

/**
 * 今あるボックスを分岐に変える (作ってから「やっぱり決まっていない分かれ道だった」と分かったとき)
 * Input : p = 計画, blockId = 変えるボックス, args = { question: 判断の問い, options: 選択肢 (2 つ以上), context: 判断材料, actor: 変えた人 }
 * Output: { project, decisionId }。今の出力は 1 つ目の選択肢の道になり (名前を選択肢に変え、つながっている線は残す)、
 *         2 つ目以降の選択肢の道 (出力) を足す。入力・担当・日程などはそのまま。
 *         中にボックスを持つボックス・プロジェクトのボックス・すでに分岐のボックスは変えられない (例外)
 */
export function convertToBranch(p: Project, blockId: string, args: { question: string; options: string[]; context?: string; actor: string }): { project: Project; decisionId: string } {
  const b = p.blocks[blockId];
  if (!b || blockId === ROOT_ID || kindOf(b) === "project") throw new Error("project");
  if (b.branch) throw new Error("already");
  if (childrenOf(p, blockId).length > 0) throw new Error("children");
  const options = [...new Set(args.options.map((o) => o.trim()).filter(Boolean))];
  if (options.length < 2) throw new Error("options");
  // 1. 判断 (問いと選択肢) を付け、分岐の印を付ける (印が先に無いと、2 本目以降の出力を足せない)
  const asked = askDecision(p, blockId, args.actor, args.question, options, args.context ?? "");
  let q = asked.project;
  q = { ...q, blocks: { ...q.blocks, [blockId]: { ...q.blocks[blockId], branch: { decisionId: asked.decisionId! } } } };
  // 2. 今の出力 (1 本目) を、1 つ目の選択肢の道にする。出力が無ければ足す
  const first = portsOf(q, blockId, "out")[0];
  if (first) q = updatePort(q, first.id, { name: options[0], branchOption: options[0] });
  else {
    const added = addPort(q, { blockId, direction: "out", name: options[0] });
    q = updatePort(added.project, added.portId, { branchOption: options[0] });
  }
  // 3. 2 つ目以降の選択肢の道を足す
  for (const option of options.slice(1)) {
    const added = addPort(q, { blockId, direction: "out", name: option });
    q = updatePort(added.project, added.portId, { branchOption: option });
  }
  return { project: q, decisionId: asked.decisionId! };
}

/**
 * 分岐にできるか (詳細パネルのメニューで、押せるかと理由を出すため)
 * Input : p, blockId / Output: { ok: できるか, reason: できない理由 (日本語の文。できるなら空) }
 */
export function canConvertToBranch(p: Project, blockId: string): { ok: boolean; reason: "" | "project" | "already" | "children" } {
  const b = p.blocks[blockId];
  if (!b || blockId === ROOT_ID || kindOf(b) === "project") return { ok: false, reason: "project" };
  if (b.branch) return { ok: false, reason: "already" };
  if (childrenOf(p, blockId).length > 0) return { ok: false, reason: "children" };
  return { ok: true, reason: "" };
}

/**
 * 合流のボックスを足す (分かれた道が 1 つにまとまるところ。OR ゲートのような小さな部品)
 * Input : p = 計画, args = { parentId: 置く先, actor: 足した人, position: 置く位置 (省略可), title: 題名 (省略時は「合流」) }
 * Output: { project, blockId }。入力はまだ無い (道の出力をこの箱へ connect すると、その名前の入力ができる)。出力は 1 本
 */
export function addMerge(p: Project, args: { parentId: string; actor: string; position?: { x: number; y: number }; title?: string }): { project: Project; blockId: string } {
  const made = addBlock(p, { parentId: args.parentId, title: args.title ?? t("合流"), position: args.position, actor: args.actor, outputName: t("合流") });
  const q = made.project;
  return { project: { ...q, blocks: { ...q.blocks, [made.blockId]: { ...q.blocks[made.blockId], merge: true } } }, blockId: made.blockId };
}

