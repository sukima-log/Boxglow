/**
 * 再利用のテンプレートのライブラリ (ブラウザ内 IndexedDB)。ファイル (*.boxglow-block.json) との読み書きも
 */
import { get, set } from "idb-keyval";
import type { BlockTemplate } from "../model/types";

const KEY = "boxglow:templates";

/** ライブラリの一覧 (更新日時の新しい順) */
export async function listTemplates(): Promise<BlockTemplate[]> {
  const list = (await get<BlockTemplate[]>(KEY)) ?? [];
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** テンプレートを保存する (同じ id があれば置き換える) */
export async function saveTemplate(t: BlockTemplate): Promise<void> {
  const list = (await get<BlockTemplate[]>(KEY)) ?? [];
  await set(KEY, [t, ...list.filter((x) => x.id !== t.id)]);
}

// ---- 計画のテンプレート (利用者が登録した計画の構造。B153) ----
const PLAN_KEY = "boxglow:plan-templates";
export interface PlanTemplate { id: string; name: string; updatedAt: string; text: string }
/** 計画のテンプレートの一覧 (更新日時の新しい順) */
export async function listPlanTemplates(): Promise<PlanTemplate[]> {
  const list = (await get<PlanTemplate[]>(PLAN_KEY)) ?? [];
  return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
/** 計画のテンプレートを保存する (同じ id = 同じ名前なら置き換える) */
export async function savePlanTemplate(t: PlanTemplate): Promise<void> {
  const list = (await get<PlanTemplate[]>(PLAN_KEY)) ?? [];
  await set(PLAN_KEY, [t, ...list.filter((x) => x.id !== t.id)]);
}
export async function deletePlanTemplate(id: string): Promise<void> {
  const list = (await get<PlanTemplate[]>(PLAN_KEY)) ?? [];
  await set(PLAN_KEY, list.filter((x) => x.id !== id));
}

/** テンプレートを消す */
export async function deleteTemplate(id: string): Promise<void> {
  const list = (await get<BlockTemplate[]>(KEY)) ?? [];
  await set(KEY, list.filter((x) => x.id !== id));
}
