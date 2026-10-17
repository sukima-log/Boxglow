import { t } from "../i18n/core";
/**
 * 課金の状態 (サーバーの GET /v1/me の billing / GET /v1/billing)。ホスト共通
 *   - required: サーバーが契約を求めているか (提供開始後 true。試用の間は false)
 *   - entitled: 今の状態で同期できるか (required が false なら常に true)
 *   - plan: "personal" / "team" / "comp" (無償) / null、status: Stripe の契約の状態 ("active" / "past_due" / "canceled" / "none" など)
 *   - checkout: 申し込めるか、portal: 契約の管理 (支払い方法・解約) を開けるか
 */
export interface Billing { required: boolean; entitled: boolean; plan: string | null; status: string; seats: number; periodEnd: string | null; checkout: boolean; portal: boolean }

/** サーバーの応答から課金の状態を読む (形が合わなければ undefined。古いサーバーは billing を返さない) */
export function parseBilling(value: unknown): Billing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const b = value as Record<string, unknown>;
  if (typeof b.required !== "boolean" || typeof b.entitled !== "boolean") return undefined;
  return {
    required: b.required, entitled: b.entitled
  , plan: typeof b.plan === "string" ? b.plan.slice(0, 32) : null
  , status: typeof b.status === "string" ? b.status.slice(0, 32) : "none"
  , seats: typeof b.seats === "number" ? b.seats : 0
  , periodEnd: typeof b.periodEnd === "string" ? b.periodEnd.slice(0, 64) : null
  , checkout: b.checkout === true, portal: b.portal === true
  };
}

/** Stripe の契約の状態 → 画面の言葉 */
export function billingStatusLabel(status: string): string {
  switch (status) {
    case "active": return t("有効");
    case "trialing": return t("試用中");
    case "past_due": return t("支払いの確認待ち");
    case "canceled": return t("解約済み");
    case "unpaid": case "incomplete": case "incomplete_expired": return t("未払い");
    case "none": return t("未契約");
    default: return status;
  }
}


/** 画面に出すプランの名前 */
export function planLabel(plan: string | null): string {
  return plan === "personal" ? "Personal" : plan === "team" ? "Team" : plan === "comp" ? "Comp" : "-";
}
