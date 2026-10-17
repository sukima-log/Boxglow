/**
 * 計画のテンプレート (利用者が自分の計画を登録して、そこから新しい計画を始める。B153)
 *   テンプレート = 構造だけの写し: 箱 (題名・説明・出力・つながり・担当・見積) とメンバーは残し、
 *   進捗 (状態・進捗率・日付・実績)・成果物・記録・活動・判断・受け持ち・引き継ぎ・NOW は消す
 * Input : p = 元の計画, name = 新しい計画の名前 (省くと元の名前)。Output: 新しい id を持つ、まっさらな状態の計画
 */
import { addBlock, createProject, defaultTaskParent } from "./graph";
import type { Block, Project } from "./types";

export function planTemplateFrom(p: Project, name?: string): Project {
  const base = createProject(name ?? p.name);
  // 新しい箱の「活動」の初期値 (形をここで決め打ちしない: 実際に足した箱から取る)
  const fresh = addBlock(base, { parentId: defaultTaskParent(base), title: "t" });
  const blank = Object.values(fresh.project.blocks).find((b) => b.id === fresh.blockId)!;
  const blocks: Record<string, Block> = {};
  for (const [id, b] of Object.entries(p.blocks)) {
    blocks[id] = {
      ...b
    , status: "black", progress: undefined, statusChangedAt: undefined, startDate: undefined, dueDate: undefined, actualHours: undefined
    , artifacts: [], log: undefined, activity: structuredClone(blank.activity), decisions: [], splitReview: undefined, boxReview: undefined
    };
  }
  return {
    ...p
  , id: base.id, name: name ?? p.name, createdAt: base.createdAt, updatedAt: undefined, version: undefined
  , blocks, log: [], agents: {}, now: [], handoffs: undefined, claims: undefined, focusBlockId: undefined
  };
}
