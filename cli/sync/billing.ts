/**
 * boxglow billing: 契約の状態の表示と、申し込み / 契約の管理の画面の URL の取得 (CLI)
 *   - 保存済みのサインイン (または環境変数のトークン) で GET /v1/billing を読む
 *   - --checkout personal|team [--seats n] で POST /v1/billing/checkout、--portal で POST /v1/billing/portal (URL を表示するだけ。ブラウザで開くのは人)
 * Input : o = { server, out, fetch?, allowEnvironmentToken?, checkout?, seats?, portal? }
 * Output: 終了コード (0 = 表示できた)
 */
import { t } from "../../src/i18n/core";
import { parseBilling, planLabel } from "../../src/sync/billing";
import { resolveToken } from "./credentials";
import { serverProblem } from "./login";
import { normalizeServer } from "./state-store";

export interface BillingOptions { server: string; out: (line: string) => void; fetch?: typeof fetch; allowEnvironmentToken?: boolean; checkout?: "personal" | "team"; seats?: number; portal?: boolean }

export async function runBilling(o: BillingOptions): Promise<number> {
  const { out } = o;
  const doFetch = o.fetch ?? fetch;
  const server = normalizeServer(o.server);
  const problem = serverProblem(server);
  if (problem) { out(problem); return 1; }
  const credential = resolveToken(server, o.allowEnvironmentToken);
  if (!credential) { out(t("先にサインインしてください")); return 1; }
  const headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
  try {
    // Team の契約はワークスペース単位 (teamId が要る): 画面のアカウントのメニュー → ワークスペース から申し込む
    if (o.checkout === "team") { out(t("Team プランはワークスペースごとの契約です。画面のアカウントのメニュー → ワークスペース から申し込んでください")); return 1; }
    if (o.checkout || o.portal) {
      const kind = o.checkout ? "checkout" : "portal";
      const res = await doFetch(`${server}/v1/billing/${kind}`, { method: "POST", headers, redirect: "error", body: JSON.stringify(o.checkout ? { plan: o.checkout, seats: o.seats } : {}), signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => ({})) as { url?: unknown; code?: unknown };
      if (!res.ok || typeof body.url !== "string") {
        out(res.status === 409 && body.code === "already-subscribed" ? t("すでに契約があります。契約の管理から変更してください")
          : res.status === 409 ? t("まだ契約がありません。先に申し込んでください (--checkout personal か --checkout team)")
          : res.status === 503 ? t("このサーバーでは、課金はまだ使えません")
          : t("課金の画面を用意できませんでした (サーバーの応答: {status})", { status: res.status }));
        return 1;
      }
      out(kind === "checkout" ? t("申し込みの画面 (Stripe)。ブラウザで開いてください:") : t("契約の管理の画面 (Stripe)。ブラウザで開いてください:"));
      out(body.url);
      return 0;
    }
    const res = await doFetch(`${server}/v1/billing`, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!res.ok) { out(t("契約の状態を読めませんでした (サーバーの応答: {status})", { status: res.status })); return 1; }
    const billing = parseBilling(await res.json());
    if (!billing) { out(t("このサーバーは課金に対応していません")); return 1; }
    out(t("プラン") + `: ${planLabel(billing.plan)}` + (billing.plan === "team" ? ` × ${billing.seats}` : "") + (billing.plan && billing.plan !== "comp" ? ` (${billing.status})` : ""));
    out(billing.required ? (billing.entitled ? t("同期できます") : t("有料プランの契約が必要です")) : t("試用中 (契約は求められていません)"));
    if (billing.periodEnd) out(t("次の更新") + `: ${billing.periodEnd.slice(0, 10)}`);
    if (billing.checkout) out(t("申し込み: boxglow billing --checkout personal"));
    if (billing.portal) out(t("契約の管理 (支払い方法・解約): boxglow billing --portal"));
    return 0;
  } catch (e) {
    out(t("サーバーと通信できませんでした") + ` (${e instanceof Error ? e.message : String(e)})`);
    return 1;
  }
}
