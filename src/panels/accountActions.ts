/**
 * アカウントに関わる操作の共通処理 (同期パネルとアカウントのメニューで同じ)
 */
import { useProjectStore } from "../store/useProjectStore";
import type { HostAction } from "../sync/status";

/**
 * 申し込み / 契約の管理を 1 回の押下で開く
 *   押した瞬間に空のタブを開いておき (利用者の操作の中なので遮られない)、サーバーから URL が来たらそのタブをそこへ移す。
 *   タブを開けない環境 (VS Code の webview など) では、状態に残った URL をリンクとして出す (billingLink)
 * Input : act = ホストへの操作, action = billingCheckout / billingPortal。Output: なし
 */
export async function openBilling(act: (a: HostAction) => Promise<unknown>, action: HostAction): Promise<void> {
  let tab: Window | null = null;
  try { tab = window.open("about:blank", "_blank"); } catch { tab = null; }
  await act(action);
  const link = useProjectStore.getState().syncStatus?.billingLink;
  if (tab && link) { tab.location.href = link.url; void act({ kind: "billingDismiss" }); }
  else if (tab) tab.close();
}
