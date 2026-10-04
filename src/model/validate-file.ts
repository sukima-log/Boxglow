/**
 * 計画ファイルの検査 (書き込む前に使う): 形式 (型)・参照 (ボックス / ポート / 線)・親の循環・線のつなぎ方を確かめる
 * fromJSON は読み込みのときに壊れた参照を黙って捨てて正規化するので、保存の入口 (serve の PUT、VS Code の保存、競合の統合) では
 * 正規化の前にここで検査し、壊れた中身をそのまま書かないようにする。
 * lang / contextGuard / handoffs などは省略可 (これらが無い古い計画もそのまま通る)。知らない項目は残す (passthrough)
 */
import { z } from "zod";
import { fromJSON, validateConnection } from "./graph";
import type { Project } from "./types";
import { t } from "../i18n/core";

// ---- 形式 (型) の定義: types.ts の Project と同じ形。1 行が 1 つの種類 ----
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const artifact = z.object({ id: z.string(), title: z.string(), url: z.string(), kind: z.enum(["url", "file", "note", "redmine_issue", "git"]), note: z.string(), repo: z.string().optional(), path: z.string().optional(), commit: z.string().optional(), blob: z.string().optional(), state: z.enum(["ok","moved","missing"]).optional(), checkedAt: z.string().optional() }).passthrough();
const decision = z.object({ id: z.string(), question: z.string(), options: z.array(z.string()), askedBy: z.string(), askedAt: z.string(), answer: z.string().optional(), context: z.string().optional(), answeredBy: z.string().optional(), answeredAt: z.string().optional(), ackedBy: z.string().optional(), ackedAt: z.string().optional(), history: z.array(z.object({ answer: z.string(), by: z.string(), at: z.string(), note: z.string().optional() })).optional() }).passthrough();
const scope = z.object({ goal: z.string().optional(), nonGoals: z.string().optional(), acceptance: z.string().optional(), consult: z.string().optional() }).passthrough();
const policy = z.object({ startWithoutInputs: z.enum(["warn", "reject"]).optional(), doneWithoutArtifacts: z.enum(["warn", "reject"]).optional() }).passthrough();
const block = z.object({ scope: scope.optional(), descriptionUpdatedAt: z.iso.datetime({ offset: true }).optional(), statusChangedAt: z.iso.datetime({ offset: true }).optional(), id: z.string(), parentId: z.string().nullable(), title: z.string(), description: z.string(), status: z.enum(["black", "gray", "white"]), assigneeIds: z.array(z.string()), position: point, collapsed: z.boolean(), key: z.string().optional(), kind: z.enum(["task","project"]).optional(), progress: z.number().min(0).max(100).optional(), startDate: z.string().optional(), dueDate: z.string().optional(), estimateHours: z.number().nonnegative().optional(), actualHours: z.number().nonnegative().optional(), category: z.string().optional(), repo: z.string().optional(), issue: z.string().optional(), template: z.object({id:z.string(),name:z.string(),version:z.number()}).optional(), artifacts: z.array(artifact), decisions: z.array(decision), activity: z.object({ actor: z.string(), state: z.enum(["working", "blocked", "needs_decision", "waiting_review"]), note: z.string(), since: z.string() }).nullable() }).passthrough();
const port = z.object({ id: z.string(), blockId: z.string(), direction: z.enum(["in", "out"]), name: z.string(), description: z.string(), required: z.boolean(), artifacts: z.array(artifact), promotedFrom: z.string().optional(), groupId: z.string().optional() }).passthrough();
const endpoint = z.object({ portId: z.string(), side: z.enum(["inner", "outer"]) });
const edge = z.object({ id: z.string(), from: endpoint, to: endpoint, kind: z.enum(["sibling", "up", "down", "through"]), auto: z.boolean() });
const schema = z.object({ schemaVersion: z.literal(5), id: z.string().min(1), name: z.string(), description: z.string(), createdAt: z.string(), visibility: z.enum(["private", "link", "public"]), members: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })), blocks: z.record(z.string(), block), ports: z.record(z.string(), port), edges: z.record(z.string(), edge), terminals: z.object({ in: point, out: point }), log: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), kind: z.string(), message: z.string() }).passthrough()), agents: z.record(z.string(), z.object({ lastSeen: z.string() })), lang: z.enum(["ja","en"]).optional(), nextKey: z.number().int().positive().optional(), inputGroups: z.array(z.object({id:z.string(),name:z.string(),description:z.string(),position:point})).optional(), contextGuard: z.boolean().optional(), workflowPolicy: policy.optional(), focusBlockId: z.string().optional(), handoffs: z.record(z.string(), z.object({ note: z.string(), actor: z.string(), at: z.string() })).optional() }).passthrough();

/**
 * 計画の文字列を検査して Project にする。正規化の「前」に検査する (壊れた参照を黙って捨てたまま書かないため)
 * Input : text = 計画ファイルの中身 (JSON の文字列)
 * Output: fromJSON 済みの Project。JSON でない・形式が違う・参照が壊れている・線のつなぎ方が不正なら例外
 */
export function validateProjectText(text: string): Project {
  const raw: unknown = JSON.parse(text);
  schema.parse(raw);
  const p = raw as Project;
  if (p.focusBlockId && !p.blocks[p.focusBlockId]) throw new Error(t("今回の範囲のボックスが見つかりません"));
  // 辞書のキーに __proto__ などを使わせない (読み込んだ側のオブジェクトを書き換えられないように)
  for (const map of [p.blocks, p.ports, p.edges, p.agents, p.handoffs ?? {}]) {
    for (const key of Object.keys(map)) if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(t("使えないキーです: {key}", { key }));
  }
  if (!p.blocks.root || p.blocks.root.parentId !== null) throw new Error(t("最上位のボックス (root) がありません"));
  for (const [id, b] of Object.entries(p.blocks)) {
    // 辞書のキーと id が同じこと、親が実在すること
    if (id !== b.id || (id !== "root" && (!b.parentId || !p.blocks[b.parentId]))) throw new Error(t("ボックスの参照が正しくありません: {id}", { id }));
    // 親をたどって root に着くこと (循環していないこと、深すぎないこと)
    const seen = new Set<string>();
    let at: string | null = id;
    while (at !== null) {
      if (seen.has(at)) throw new Error(t("ボックスの親子が循環しています: {id}", { id }));
      if (seen.size >= 256) throw new Error(t("階層が深すぎます (256 段まで)"));
      seen.add(at);
      if (!p.blocks[at]) throw new Error(t("ボックスの参照が正しくありません: {id}", { id }));
      at = p.blocks[at].parentId;
    }
  }
  for (const [id, q] of Object.entries(p.ports)) {
    if (id !== q.id || !p.blocks[q.blockId] || (q.promotedFrom && !p.ports[q.promotedFrom])) throw new Error(t("入出力の参照が正しくありません: {id}", { id }));
  }
  for (const [id, e] of Object.entries(p.edges)) {
    if (id !== e.id || !p.ports[e.from.portId] || !p.ports[e.to.portId]) throw new Error(t("線の参照が正しくありません: {id}", { id }));
    // 画面や CLI でつなぐときと同じ規則で確かめる (種類も一致すること)
    const result = validateConnection(p, e.from, e.to);
    if (!result.ok) throw new Error(t("線のつなぎ方が正しくありません: {id}: {reason}", { id, reason: result.reason ?? "" }));
    if (result.kind !== e.kind) throw new Error(t("線の種類が正しくありません: {id}", { id }));
  }
  return fromJSON(text);
}
