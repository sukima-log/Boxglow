/**
 * サインインのボタン (GitHub / Google) と、サインインの状態の行。同期パネル・開始の手順・Home で共通
 *   - ボタンは各社の印つきで、見てすぐボタンと分かる大きさにする (利用者の指摘 2026-10-17: 札のように見えて押せると分かりにくい)
 *   - 状態の行は「サインイン中: 名前 (手段)」か「サインインしていません」を、色の点つきで出す
 * Input : act = ホストへの操作, status = 同期の状態。Output: JSX
 */
import { t } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
import { useProjectStore } from "../store/useProjectStore";

/** 自動で開いたサインインのページか (Google = URL、GitHub = コード)。store の印で描き直される */
export const useAutoOpened = (code: NonNullable<SyncStatus["signIn"]>): boolean => useProjectStore((s) => s.signInOpened) === (code.provider === "google" ? code.url : code.userCode);

/**
 * サインイン (または手段の追加) を始める
 *   Google: 押した瞬間に空のタブを開いておき (利用者の操作の中なので遮られない)、裏方からページの URL が届いたらそのタブを移す = 1 回の押下で Google のページへ。
 *   GitHub: 自動では開かない。コードを先に見てもらい、「コードをコピーして GitHub を開く」で移る (先にページへ飛ばすと、コードを探すことになる。利用者の指摘 2026-10-17)
 *   タブを開けない環境 (VS Code の webview など) では、今までどおり画面のリンクから開く
 * Input : act = ホストへの操作, provider, link = サインイン済みのアカウントに手段を足す。Output: なし
 */
export async function signInOneStep(act: (a: HostAction) => Promise<unknown>, provider: "github" | "google", link = false): Promise<void> {
  let tab: Window | null = null;
  if (provider === "google") { try { tab = window.open("about:blank", "_blank"); } catch { tab = null; } }
  await act(link ? { kind: "linkIdentity", provider } : { kind: "signIn", provider });
  if (provider === "github") return;
  // 裏方がページを用意するまで待つ (通信があるので少し遅れる)
  for (let i = 0; i < 150; i++) {
    const code = useProjectStore.getState().syncStatus?.signIn;
    if (code && code.provider === provider) {
      if (tab) {
        if (code.provider === "google") { tab.location.href = code.url; useProjectStore.setState({ signInOpened: code.url }); }
      }
      return;
    }
    if (!useProjectStore.getState().syncStatus) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // ページが届かなかった (失敗・中止): 空のタブは閉じる
  if (tab) { try { tab.close(); } catch { /* 閉じられなくてもよい */ } }
}

/** 各社の印 (GitHub のマーク / Google の G)。装飾なので読み上げない */
export function ProviderIcon({ provider }: { provider: "github" | "google" }) {
  if (provider === "github") {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** サインインのボタン 2 つ (GitHub は濃い色、Google は白地。各社の見た目に寄せる) */
export function SignInButtons({ act }: { act: (a: HostAction) => Promise<unknown> }) {
  return (
    <div className="signin-buttons">
      <button className="btn signin-btn signin-btn--github" onClick={() => void signInOneStep(act, "github")}>
        <ProviderIcon provider="github" /><span>{t("GitHub でサインイン")}</span>
      </button>
      <button className="btn signin-btn signin-btn--google" onClick={() => void signInOneStep(act, "google")}>
        <ProviderIcon provider="google" /><span>{t("Google でサインイン")}</span>
      </button>
    </div>
  );
}

/** サインインの状態の行: 緑の点 + 「サインイン中: 名前 (手段)」、または灰色の点 + 「サインインしていません」 */
export function SignedInLine({ status }: { status: SyncStatus }) {
  const account = status.credentials.account;
  const via = account?.signedInWith === "google" ? "Google" : account?.signedInWith === "github" ? "GitHub" : null;
  const on = !!account || status.credentials.source === "env";
  return (
    <div className="signed-line" data-on={on ? "true" : "false"} role="status">
      <span className="signed-line__dot" aria-hidden="true" />
      {account
        ? <span>{t("サインイン中")}: <b>{account.display}</b>{via ? ` (${via})` : ""}</span>
        : status.credentials.source === "env" ? <span>{t("環境変数のトークンで同期しています")}</span>
        : <span>{t("サインインしていません")}</span>}
    </div>
  );
}
