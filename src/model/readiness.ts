/**
 * 着手の準備 (readiness): 「入力がそろっているか」とは別に、「実行できる粒度まで具体化されているか」を計画から導出する
 *
 * 3 つを別々に判定する (保存しない。計画から毎回求める):
 *   1. 予定の担当 (出力ごと): その出力を誰が作るか (自身 / 子 / through / 分岐 / 未定 / 重複)
 *   2. 具体化: 自身が担当する出力が 1 つ以上あり、その予定成果物 (expect) と完了条件 (scope.acceptance) が決まっているか
 *   3. 入力: 必須の入力と分岐の答えがそろっているか (既存の waitingFor)
 *
 * 階層の深さは判定に使わない。浅くても具体なら着手でき、深くても曖昧なら要具体化になる。
 * 成果物 (artifacts) の有無は担当の導出に使わない (再作業を許す)。
 * 分岐・合流のボックスは作業ではないので、具体化の判定の対象外 (既存の分岐待ち・見送りで扱う)。
 */
import { childrenOf, incomingEdges, kindOf, portsOf, waitingFor } from "./graph";
import { branchState, isSkipped, waitingBranches } from "./branch";
import { ROOT_ID, type Artifact, type Block, type Port, type Project } from "./types";
import { t } from "../i18n/core";

/** 出力の担当 */
export type OutputOwner =
  | { kind: "self" }                                  // このボックス自身が作る
  | { kind: "child"; blockIds: string[] }             // 子の出力がつながっている (子が作る)
  | { kind: "through" }                               // 入力をそのまま通す
  | { kind: "branch" }                                // 分岐の道 (判断の答えが成果物)
  | { kind: "undecided" }                             // 子を持つのに、誰が作るか決まっていない
  | { kind: "conflict"; blockIds: string[] };         // --self と子の結線 (または through) の両方が付いている

/** 要具体化の理由の種類 (文言は reasonText で作る) */
export type UnpreparedReason =
  | { kind: "no-outputs" }
  | { kind: "no-own-output"; delegated: { port: Port; owner: OutputOwner }[] }
  | { kind: "undecided"; port: Port }
  | { kind: "conflict"; port: Port; blockIds: string[] }
  | { kind: "missing-expect"; port: Port }
  | { kind: "missing-acceptance" };

/** 着手の準備の判定結果 */
export interface Readiness {
  /** 出力ごとの担当 */
  outputs: { port: Port; owner: OutputOwner }[];
  /** 自身が担当する出力 */
  own: Port[];
  /** 要具体化の理由 (空なら具体化済み) */
  unprepared: UnpreparedReason[];
  /** 入力待ち・分岐待ちの理由 (既存の waitingFor。空ならそろっている) */
  waiting: string[];
  /** 見送り中の案内 (選ばなかった道。今は作業不要。選択が変われば準備を確かめ直す) */
  advice?: string;
  /**
   * まとめ: skipped = 見送り, branch-waiting = 分岐待ち, unprepared = 要具体化, waiting = 入力待ち, ready = 着手できる,
   * none = 判定の対象外 (最上位・プロジェクトのボックス・分岐・合流)
   */
  state: "none" | "skipped" | "branch-waiting" | "unprepared" | "waiting" | "ready";
}

/**
 * 出力ごとの担当を導出する
 * Input : p = 計画, blockId = ボックスの id
 * Output: 出力ごとの担当。子を持たないボックスの出力は印が無くても自身の担当 (through を除く)
 */
export function outputOwners(p: Project, blockId: string): { port: Port; owner: OutputOwner }[] {
  const b = p.blocks[blockId];
  if (!b) return [];
  const hasChildren = childrenOf(p, blockId).length > 0;
  return portsOf(p, blockId, "out").map((port) => {
    // 分岐の道: 判断の答えそのものが成果物
    if (b.branch && port.branchOption !== undefined) return { port, owner: { kind: "branch" } as const };
    // 出力の内側に来ている線: 子の出力 (up) か、親の入力をそのまま通す線 (through)
    const inner = incomingEdges(p, { portId: port.id, side: "inner" });
    const fromChildren = [...new Set(inner.filter((e) => e.kind === "up").map((e) => p.ports[e.from.portId]?.blockId).filter((x): x is string => !!x))];
    const through = inner.some((e) => e.kind === "through");
    const supplied = fromChildren.length > 0 || through;
    // --self の印と、子の結線 (または through) の両方が付いていたら重複 (黙ってどちらかを優先しない)
    if (port.owner === "self" && supplied) return { port, owner: { kind: "conflict", blockIds: fromChildren } as const };
    if (fromChildren.length > 0) return { port, owner: { kind: "child", blockIds: fromChildren } as const };
    if (through) return { port, owner: { kind: "through" } as const };
    if (port.owner === "self" || !hasChildren) return { port, owner: { kind: "self" } as const };
    return { port, owner: { kind: "undecided" } as const };
  });
}

/**
 * 具体化の判定の対象か (最上位・プロジェクトのボックス・分岐・合流は対象外)
 * Input : p, blockId / Output: 対象なら true
 */
export function isPreparable(p: Project, blockId: string): boolean {
  const b = p.blocks[blockId];
  return !!b && b.id !== ROOT_ID && kindOf(b) !== "project" && !b.branch && !b.merge;
}

/**
 * 要具体化の理由を求める (具体化済みなら空)
 * Input : p, blockId, opts.forStart = true なら「自身が作る出力が無い」(子に任せている) も理由に含める (start の検査用)。
 *         既定 (false) は画面・一覧・候補用で、子に任せきりの親は要具体化ではない (実行するものが無いだけ) ので含めない
 * Output: 理由の一覧。順番は「出力が無い → 自身の出力が無い → 担当の未定・重複 → 予定成果物 → 完了条件」
 */
export function unpreparedReasons(p: Project, blockId: string, opts: { forStart?: boolean } = {}): UnpreparedReason[] {
  if (!isPreparable(p, blockId)) return [];
  const b = p.blocks[blockId];
  const outputs = outputOwners(p, blockId);
  if (outputs.length === 0) return [{ kind: "no-outputs" }];
  const reasons: UnpreparedReason[] = [];
  const own = outputs.filter((o) => o.owner.kind === "self");
  // 自身が作る出力が無い: すべて子・through・分岐に任せている (未定や重複があれば、そちらを先に案内する)
  const undecided = outputs.filter((o) => o.owner.kind === "undecided");
  const conflicts = outputs.filter((o) => o.owner.kind === "conflict");
  if (opts.forStart && own.length === 0 && undecided.length === 0 && conflicts.length === 0) reasons.push({ kind: "no-own-output", delegated: outputs });
  for (const o of undecided) reasons.push({ kind: "undecided", port: o.port });
  for (const o of conflicts) reasons.push({ kind: "conflict", port: o.port, blockIds: o.owner.kind === "conflict" ? o.owner.blockIds : [] });
  // 自身が作る出力の予定成果物と、完了条件
  for (const o of own) if (!o.port.expect || !o.port.expect.hint.trim()) reasons.push({ kind: "missing-expect", port: o.port });
  if (own.length > 0 && !b.scope?.acceptance?.trim()) reasons.push({ kind: "missing-acceptance" });
  return reasons;
}

/**
 * 着手の準備をまとめて判定する
 * Input : p, blockId
 * Output: Readiness (担当・要具体化の理由・入力待ちの理由・まとめの状態)
 */
export function readiness(p: Project, blockId: string): Readiness {
  const outputs = outputOwners(p, blockId);
  const own = outputs.filter((o) => o.owner.kind === "self").map((o) => o.port);
  const preparable = isPreparable(p, blockId);
  // start の検査と同じ理由 (子に任せきりの親は「自身が作る出力が無い」が出る)
  const unprepared = unpreparedReasons(p, blockId, { forStart: true });
  const waiting = p.blocks[blockId] ? waitingFor(p, blockId) : [];
  let state: Readiness["state"] = "none";
  if (preparable || p.blocks[blockId]?.branch) {
    if (isSkipped(p, blockId)) state = "skipped";
    else if (waitingBranches(p, blockId).length > 0) state = "branch-waiting";
    else if (unprepared.length > 0) state = "unprepared";
    else if (waiting.length > 0) state = "waiting";
    else state = "ready";
  }
  // 見送り (選ばなかった道) のボックスは今は作業不要。具体化の理由や次の一手を出して作業を誘わない
  if (state === "skipped") return { outputs, own, unprepared: [], waiting: [], state, advice: t("見送り中 (選ばなかった分岐の道) です。今は作業不要です。分岐の答えが変われば、準備を確かめ直してください") };
  return { outputs, own, unprepared, waiting, state };
}

/**
 * 要具体化の理由を人が読む 1 文にする
 * Input : p = 計画 (子の題名を引くため), r = 理由
 * Output: 文 (CLI の応答と画面の一覧で使う)
 */
export function reasonText(p: Project, r: UnpreparedReason): string {
  const key = (id: string) => p.blocks[id]?.key ?? p.blocks[id]?.title ?? id;
  switch (r.kind) {
    case "no-outputs": return t("予定する出力がありません");
    case "no-own-output": {
      const toChildren = r.delegated.filter((d) => d.owner.kind === "child");
      if (toChildren.length === 0) return t("このボックス自身が作る出力はありません (入力をそのまま通しています)");
      const names = [...new Set(toChildren.flatMap((d) => d.owner.kind === "child" ? d.owner.blockIds : []))].map(key).join(", ");
      return t("このボックス自身が作る出力はありません (出力は {names} が作ります)", { names });
    }
    case "undecided": return t("出力「{name}」の担当が未定です (子の出力をつなぐか、自身が作るなら --self)", { name: r.port.name });
    case "conflict": return t("出力「{name}」の担当が重複しています (--self と子の結線の両方)", { name: r.port.name });
    case "missing-expect": return t("出力「{name}」の予定成果物 (expect) が未定です", { name: r.port.name });
    case "missing-acceptance": return t("完了条件 (acceptance) が未定です");
  }
}

/**
 * 不足を埋める次の一手 (CLI のコマンド例)。画面では出さない
 * Input : p, blockId, reasons
 * Output: コマンド例の一覧 (理由の種類ごとに 1 つ。同じ種類は 1 回だけ)
 */
export function nextSteps(p: Project, blockId: string, reasons: UnpreparedReason[]): string[] {
  const b = p.blocks[blockId];
  const ref = b?.key ?? blockId;
  const steps: string[] = [];
  const once = (s: string) => { if (!steps.includes(s)) steps.push(s); };
  for (const r of reasons) {
    switch (r.kind) {
      case "no-outputs": once(t("npx boxglow port {ref} --out \"<出力名>\" --expect \"<出力名>=file:<パス>\"", { ref })); break;
      case "no-own-output": {
        // 親出力を作る子は、入力待ちや要具体化で今は始められないことが多い (最後の子であることが多い)。
        // 「今着手できる子」(具体化済みで入力もそろっている) を先に案内し、親出力の担当は別に示す
        const providers = [...new Set(r.delegated.flatMap((d) => d.owner.kind === "child" ? d.owner.blockIds : []))];
        const startable = childrenOf(p, blockId).filter((c) => c.status === "black" && !c.merge && !c.branch && readiness(p, c.id).state === "ready");
        if (startable.length) once(t("今着手できる子: npx boxglow start {children}", { children: startable.map((c) => c.key ?? c.id).join(" / ") }));
        else once(t("今着手できる子はありません (要具体化か入力待ち)。npx boxglow lint {ref} で確かめてください", { ref }));
        if (providers.length) once(t("親の出力を作るのは {children} (入力がそろってから)", { children: providers.map((id) => p.blocks[id]?.key ?? id).join(" / ") }));
        once(t("分解のための受け持ちだけなら: npx boxglow claim {ref}", { ref }));
        break;
      }
      case "undecided": once(t("npx boxglow connect \"<子>.<出力>\" \"{ref}.{name}\" または npx boxglow port {ref} --self \"{name}\"", { ref, name: r.port.name })); break;
      case "conflict": once(t("npx boxglow disconnect \"<子>.<出力>\" \"{ref}.{name}\" または npx boxglow port {ref} --self \"{name}\" --no-self", { ref, name: r.port.name })); break;
      case "missing-expect": once(t("npx boxglow port {ref} --expect \"{name}=file:<パス>\" (kind は file / dir / url / doc / note / decision / result)", { ref, name: r.port.name })); break;
      case "missing-acceptance": once(t("npx boxglow scope {ref} --acceptance \"<完了と判断する条件>\"", { ref })); break;
    }
  }
  if (reasons.some((r) => r.kind !== "no-own-output")) once(t("または npx boxglow split {ref} で分ける", { ref }));
  return steps;
}

/**
 * 要具体化のボックスの集まりと、親ごとの配下の件数 (画面の「要具体化 n」と候補の分類に使う)
 * Input : p = 計画
 * Output: { self: 要具体化のボックスの id (未完了のものだけ), below: 親の id → 配下 (子孫) の要具体化の件数 }
 *   計画ごとに 1 回だけ計算する (WeakMap)。計画が変わる (別のオブジェクトになる) と計算し直す
 */
const CACHE = new WeakMap<Project, { self: Set<string>; below: Map<string, number> }>();
export function unpreparedState(p: Project): { self: Set<string>; below: Map<string, number> } {
  const hit = CACHE.get(p);
  if (hit) return hit;
  const self = new Set<string>();
  for (const b of Object.values(p.blocks)) {
    // 完了済み・見送りは数えない (やらない仕事、終わった仕事)
    if (b.status === "white" || !isPreparable(p, b.id) || isSkipped(p, b.id)) continue;
    if (unpreparedReasons(p, b.id).length > 0) self.add(b.id);
  }
  // 配下の件数: 要具体化のボックスから先祖へ 1 ずつ足す
  const below = new Map<string, number>();
  for (const id of self) {
    let at: Block | undefined = p.blocks[p.blocks[id]?.parentId ?? ""];
    const seen = new Set<string>();
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      below.set(at.id, (below.get(at.id) ?? 0) + 1);
      at = at.parentId ? p.blocks[at.parentId] : undefined;
    }
  }
  const result = { self, below };
  CACHE.set(p, result);
  return result;
}

/** 画面・一覧向け: 要具体化か (未完了で、理由が 1 つ以上ある) */
export function isUnprepared(p: Project, blockId: string): boolean {
  return unpreparedState(p).self.has(blockId);
}

/**
 * 供給経路をたどって、出力の根拠になる成果物を集める (親の出力に付いていなくても、つながった子の出力の成果物を数える)
 * Input : p = 計画, portId = 出力ポート (または入力ポート) の id
 * Output: 成果物の一覧 (そのポートに直接付いたものがあればそれ。無ければ、内側 (子の出力・through) → 供給元を再帰でたどる)
 *   - 実際の結線だけをたどる (同じ子の別の出力や、ボックスに付いた参考資料は数えない)
 *   - 見送りの道 (選ばなかった分岐の線) は通らない。分岐の道そのものは成果物を持たない (判断の答えは成果物ではない)
 *   - 末端が Done でも成果物が無ければ数えない (isSourceReady とは違う)
 *   - 循環・壊れた参照では止まる
 */
export function suppliedArtifacts(p: Project, portId: string, seen: Set<string> = new Set()): Artifact[] {
  if (seen.has(portId)) return [];
  const port = p.ports[portId];
  if (!port) return [];
  if (port.artifacts.length > 0) return port.artifacts;
  const next = new Set(seen).add(portId);
  const gone = branchState(p).rejectedEdges;
  const found: Artifact[] = [];
  // 合流のボックスの出力: 入力のどれか (見送りでない道) から来た成果物を通す
  const owner = p.blocks[port.blockId];
  if (port.direction === "out" && owner?.merge) {
    for (const q of portsOf(p, owner.id, "in")) for (const a of suppliedArtifacts(p, q.id, next)) if (!found.some((x) => x.id === a.id)) found.push(a);
    return found;
  }
  // 出力なら内側 (子の出力 up / 親の入力 through)、入力なら外側 (兄弟の出力 / 親の入力 down) から来る線をたどる
  const side = port.direction === "out" ? "inner" : "outer";
  for (const e of incomingEdges(p, { portId, side })) {
    if (e.auto || gone.has(e.id)) continue;
    for (const a of suppliedArtifacts(p, e.from.portId, next)) if (!found.some((x) => x.id === a.id)) found.push(a);
  }
  return found;
}

