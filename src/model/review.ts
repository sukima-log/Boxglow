/**
 * 意味のレビュー (AI か人が内容を評価する) のための材料と記録
 *
 *   review-split <親>: 親の分解の材料 (親の目的・制約・完了条件・入出力、直下の子の対象・入出力・予定成果物・完了条件、結線) とチェック項目
 *   split-ok <親>:     評価したと申告し、根拠を残す (Block.splitReview = { by, at, note, sig, parts })
 *   review-box <箱>:   そのボックスの着手準備の材料 (対象・処理・予定成果物・確認方法・入力とその供給元・上流の分岐の答え)
 *   box-ok <箱>:       同じく記録 (Block.boxReview)
 *
 * 記録は「評価したと申告し根拠を残した記録」であり、妥当性の証明ではない。
 * 署名 (sig) は材料そのもの (reviewMaterial) から作るので、表示と無効化の条件がずれない。
 * 位置・畳み・配色・担当者・進捗・状態・活動・日時・受け持ち・確認トークンは材料に含めない (変えても古くならない)。
 * 分岐の答えは box の材料にだけ含める (選ばれた道の着手準備は答えで変わる。分解全体の評価は答えでは変わらない)。
 */
import { childrenOf, kindOf, portsOf, sourceOfInput, isInputReady } from "./graph";
import { branchDecision, chosenOption } from "./branch";
import { outputOwners } from "./readiness";
import { pathTags } from "./lint";
import { ROOT_ID, type Block, type Port, type Project } from "./types";
import { t } from "../i18n/core";

/** レビューの記録 */
export interface ReviewRecord {
  by: string;
  at: string;
  /** 根拠 (--note をそのまま保存する) */
  note: string;
  /** 評価対象の署名 (材料の全体) */
  sig: string;
  /** 部分ごとの署名 (何が変わったかを案内するため) */
  parts: Record<string, string>;
}

/** 文字列の短いハッシュ (FNV-1a を 2 つの種で。ブラウザと Node の両方で動く) */
export function hashText(s: string): string {
  const fnv = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, "0");
  };
  return fnv(2166136261) + fnv(0x9747b28c);
}

/** 入出力の材料 (名前・説明・必須・合流・予定成果物・担当) */
function portMaterial(q: Port, owner?: string) {
  return {
    name: q.name
  , ...(q.description ? { description: q.description } : {})
  , ...(q.direction === "in" ? { required: q.required, ...(q.anyOf ? { anyOf: true } : {}) } : {})
  , ...(q.expect ? { expect: q.expect } : {})
  , ...(owner ? { owner } : {})
  , ...(q.branchOption !== undefined ? { branchOption: q.branchOption } : {})
  };
}

/** ボックスの材料 (題名・説明・範囲・カテゴリ・分け方・入出力・分岐の問い・合流) */
function blockMaterial(p: Project, b: Block) {
  const owners = new Map(outputOwners(p, b.id).map((o) => [o.port.id, o.owner.kind]));
  const d = b.branch ? branchDecision(b) : undefined;
  return {
    id: b.id
  , title: b.title
  , ...(b.description ? { description: b.description } : {})
  , ...(b.scope && Object.keys(b.scope).length ? { scope: b.scope } : {})
  , ...(b.category ? { category: b.category } : {})
  , ...(b.splitBy ? { splitBy: b.splitBy } : {})
  , inputs: portsOf(p, b.id, "in").map((q) => portMaterial(q))
  , outputs: portsOf(p, b.id, "out").map((q) => portMaterial(q, owners.get(q.id)))
  , ...(d ? { branch: { question: d.question, options: d.options, ...(d.context ? { context: d.context } : {}) } } : {})
  , ...(b.merge ? { merge: true } : {})
  };
}

/** 結線の材料 (親の内側と子どうし)。接続先はボックスの id とポート名で識別する (同名ポートへのつなぎ替えも変更になる) */
function wiringMaterial(p: Project, ids: Set<string>) {
  return Object.values(p.edges)
    .filter((e) => !e.auto)
    .map((e) => ({ from: p.ports[e.from.portId], to: p.ports[e.to.portId], e }))
    .filter(({ from, to }) => from && to && ids.has(from.blockId) && ids.has(to.blockId))
    .map(({ from, to }) => ({ from: { block: from.blockId, port: from.name }, to: { block: to.blockId, port: to.name } }))
    .sort((x, y) => (x.from.block + x.from.port + x.to.block + x.to.port).localeCompare(y.from.block + y.from.port + y.to.block + y.to.port));
}

/**
 * 分解のレビューの材料
 * Input : p, parentId
 * Output: { parent, children, wiring, checklist } と、署名 { sig, parts }
 */
export function splitMaterial(p: Project, parentId: string) {
  const parent = p.blocks[parentId];
  const kids = childrenOf(p, parentId);
  const ids = new Set([parentId, ...kids.map((k) => k.id)]);
  const material = {
    parent: blockMaterial(p, parent)
  , children: kids.map((k) => blockMaterial(p, k))
  , wiring: wiringMaterial(p, ids)
  };
  const parts: Record<string, string> = { parent: hashText(JSON.stringify(material.parent)), wiring: hashText(JSON.stringify(material.wiring)) };
  for (const k of material.children) parts[`child:${k.id}`] = hashText(JSON.stringify(k));
  const checklist = [
    t("子の成果を合わせると、親の完了条件を満たせるか")
  , t("親の出力ごとに、それを作る子 (または親自身の --self) があるか")
  , t("同じ階層の子は、同じ分け方 (splitBy) と同じ具体度か (機能全体と関数 1 つの修正が並んでいないか)")
  , t("複数の子が同じ責任範囲を重複して担当していないか")
  , t("親の「扱わないこと」(nonGoals) が子に紛れ込んでいないか")
  , t("分岐があるなら、すべての選択肢に道があり、道が合流か親の出力に届くか")
  ];
  return { material, checklist, sig: hashText(JSON.stringify(material)), parts };
}

/**
 * ボックスの着手準備のレビューの材料
 * Input : p, blockId
 * Output: { box, inputs (供給元と準備状況), upstreamBranches (上流の分岐と答え), checklist } と署名
 */
export function boxMaterial(p: Project, blockId: string) {
  const b = p.blocks[blockId];
  const inputs = portsOf(p, blockId, "in").map((q) => {
    const src = sourceOfInput(p, q.id);
    return {
      ...portMaterial(q)
    , ...(src ? { from: { block: src.blockId, blockTitle: p.blocks[src.blockId]?.title ?? "", output: src.name, ...(src.expect ? { expect: src.expect } : {}) } } : {})
    , ready: isInputReady(p, q.id)
    };
  });
  // 上流の分岐: 入力に付いた道の印から分岐のボックスを集め、その問いと答えを材料にする (答えが変わると古くなる)
  const tags = pathTags(p);
  const branchIds = new Set<string>();
  for (const q of portsOf(p, blockId, "in")) for (const tag of tags.get(`${q.id}:outer`) ?? []) branchIds.add(tag.split("|")[0]);
  const upstreamBranches = [...branchIds].map((id) => {
    const br = p.blocks[id]; const d = br ? branchDecision(br) : undefined;
    return { block: id, title: br?.title ?? "", question: d?.question ?? "", options: d?.options ?? [], answer: br ? chosenOption(br) ?? null : null };
  }).sort((x, y) => x.block.localeCompare(y.block));
  const material = { box: blockMaterial(p, b), inputs, upstreamBranches };
  const parts: Record<string, string> = { box: hashText(JSON.stringify(material.box)), inputs: hashText(JSON.stringify(inputs)), branches: hashText(JSON.stringify(upstreamBranches)) };
  const checklist = [
    t("何を対象に、どの処理・振る舞いを変えるかが第三者に伝わるか (goal / description)")
  , t("予定成果物 (expect) は、できた物を人が開いて確かめられる単位か (フォルダ全体や「機能一式」ではないか)")
  , t("完了条件 (acceptance) は、何をどう確かめれば完了と言えるかを書いているか")
  , t("入力の供給元は正しく、必要な入力がそろっているか (ダミーの入力を作っていないか)")
  , t("上流の分岐の答えと矛盾しない道の仕事か")
  ];
  return { material, checklist, sig: hashText(JSON.stringify(material)), parts };
}

/** 記録を作る */
export function makeRecord(by: string, note: string, sig: string, parts: Record<string, string>, at = new Date().toISOString()): ReviewRecord {
  return { by, at, note, sig, parts };
}

/**
 * レビューの状態: 記録が無い / 現在の材料と一致 / 古い (何が変わったか)
 * Input : record = 保存された記録, current = 今の材料の署名
 * Output: { state: "none" | "ok" | "stale", changed: 変わった部分の名前 }
 */
export function reviewStatus(record: ReviewRecord | undefined, current: { sig: string; parts: Record<string, string> }): { state: "none" | "ok" | "stale"; changed: string[] } {
  if (!record) return { state: "none", changed: [] };
  if (record.sig === current.sig) return { state: "ok", changed: [] };
  const keys = new Set([...Object.keys(record.parts), ...Object.keys(current.parts)]);
  const changed = [...keys].filter((k) => record.parts[k] !== current.parts[k]).sort();
  return { state: "stale", changed };
}

/** 変わった部分の名前を人が読む形に (child:<id> はボックスの短い ID に) */
export function changedText(p: Project, changed: string[]): string {
  return changed.map((k) => {
    if (k.startsWith("child:")) { const b = p.blocks[k.slice(6)]; return b ? (b.key ?? b.title) : t("消えた子"); }
    return ({ parent: t("親"), wiring: t("結線"), box: t("ボックス自身"), inputs: t("入力"), branches: t("上流の分岐の答え") } as Record<string, string>)[k] ?? k;
  }).join(", ");
}

/**
 * stale の案内 (何を確認すればよいか)。stale は「分解が不正」ではなく「前回の確認後に材料が変わった」という案内
 * Input : p, kind = split | box, changed = 変わった部分 / Output: 1 文
 */
export function staleAdvice(p: Project, kind: "split" | "box", changed: string[]): string {
  const what = changedText(p, changed);
  return kind === "split"
    ? t("前回の分解の確認後に {what} が変わっています。親の完了条件・対象外範囲と、兄弟との分担への影響を確認し、整合すれば split-ok を更新してください (全部を説明し直す必要はありません)", { what })
    : t("前回の着手準備の確認後に {what} が変わっています。対象・成果・確認方法と入力の根拠を見直し、整合すれば box-ok を更新してください", { what });
}

/** 判定の対象か (最上位・プロジェクトのボックスは対象外) */
export function reviewable(p: Project, blockId: string): boolean {
  const b = p.blocks[blockId];
  return !!b && b.id !== ROOT_ID && kindOf(b) !== "project";
}
