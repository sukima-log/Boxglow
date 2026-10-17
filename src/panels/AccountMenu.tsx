/**
 * 右上のアカウント: 丸いボタン (サインイン中は頭文字 + 緑の点、未サインインは人型) と、押すと開くメニュー
 *   メニューの中身: 誰で・どの手段で / プラン (申し込み・契約の管理 = 支払い方法の変更・解約) / サインインの手段の追加 / サインアウト / アカウントの削除
 *   同期パネルは同期の状態と計画の操作だけにし、アカウントに関わる設定はここにまとめる (利用者の要望 2026-10-17)
 * Input : なし (店の syncStatus / syncAct を使う)。Output: JSX
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useProjectStore } from "../store/useProjectStore";
import { TEAM_PLAN_AVAILABLE, billingStatusLabel, planLabel } from "../sync/billing";
import { openBilling } from "./accountActions";
import { SignInButtons, signInOneStep } from "./SignInButtons";
import { SignInCode } from "./SyncPanel";

/** 人型の印 (未サインイン) */
function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

export function AccountButton() {
  const status = useProjectStore((s) => s.syncStatus);
  const act = useProjectStore((s) => s.syncAct);
  const open = useProjectStore((s) => s.accountMenuOpen);
  const setOpen = useProjectStore((s) => s.setAccountMenuOpen);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 60, right: 8 });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const account = status?.credentials.account;
  const initial = account ? (account.display.trim()[0] ?? "?").toUpperCase() : null;
  useEffect(() => {
    if (!open) { setConfirmDelete(false); return; }
    // 入口の下に、画面基準で置く (帯は横にスクロールするので絶対配置では切れる)
    const place = () => {
      const box = ref.current?.getBoundingClientRect();
      if (box) setPosition({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
    };
    const close = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    return () => { window.removeEventListener("resize", place); document.removeEventListener("pointerdown", close, true); document.removeEventListener("keydown", escape); };
  }, [open, setOpen]);
  // サインアウトしたら閉じる
  useEffect(() => { if (!account) setConfirmDelete(false); }, [!!account]);
  const billing = account?.billing;
  return (
    <div className="account-wrap" ref={ref}>
      <button className="account-button" data-on={account ? "true" : "false"} onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}
        title={account ? t("アカウント: {name}", { name: account.display }) : t("アカウント (サインインしていません)")} aria-label={t("アカウント")}>
        {initial ? <span className="account-button__initial">{initial}</span> : <PersonIcon />}
        {account && <span className="account-button__dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="account-menu card" role="dialog" aria-label={t("アカウント")} style={{ top: position.top, right: position.right }}>
          {!status ? (
            <p className="muted">{t("このページではアカウントと同期を使えません (boxglow.app か、npx boxglow serve --sync、VS Code の拡張で使えます)")}</p>
          ) : !account ? (
            <>
              <div className="account-menu__head"><PersonIcon /><span>{t("サインインしていません")}</span></div>
              {status.signIn && !status.signIn.link
                ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
                : status.support === "ok" && status.server && status.credentials.source !== "env" && <SignInButtons act={act} />}
              {status.credentials.source === "env" && <p className="muted">{t("環境変数のトークンで同期しています")}</p>}
            </>
          ) : (
            <>
              <div className="account-menu__head">
                <span className="account-button account-button--static" data-on="true"><span className="account-button__initial">{initial}</span></span>
                <div className="account-menu__who">
                  <span className="sync-account__name">{account.display}</span>
                  <span className="sync-account__via">{account.signedInWith === "google" ? "Google" : account.signedInWith === "github" ? "GitHub" : ""}</span>
                </div>
              </div>
              {/* プラン: 状態と、申し込み / 契約の管理 (支払い方法の変更・解約は Stripe の画面) */}
              {billing && (billing.required || billing.plan || billing.checkout) && (
                <div className="sync-panel__group">
                  <div className="sync-panel__group-title">{t("プラン")}</div>
                  <div className="sync-panel__row">
                    <span className="sync-account__plan" data-entitled={billing.entitled ? "true" : "false"}>{billing.plan ? planLabel(billing.plan) : t("未契約")}{billing.plan === "team" && billing.seats > 0 ? ` × ${billing.seats}` : ""}</span>
                    {billing.plan && billing.plan !== "comp" && <span className="muted">{billingStatusLabel(billing.status)}{billing.periodEnd ? ` · ${t("次の更新")} ${billing.periodEnd.slice(0, 10)}` : ""}</span>}
                  </div>
                  {billing.checkout && (!billing.plan || !billing.entitled) && (
                    <div className="sync-panel__row">
                      <button className="btn btn-primary btn-sm" onClick={() => void openBilling(act, { kind: "billingCheckout", plan: "personal" })}>{t("Personal を申し込む (月 500 円)")}</button>
                      {TEAM_PLAN_AVAILABLE && <button className="btn btn-sm" onClick={() => void openBilling(act, { kind: "billingCheckout", plan: "team", seats: 2 })}>{t("Team を申し込む (1 人 月 800 円)")}</button>}
                    </div>
                  )}
                  {billing.portal && (
                    <div className="sync-panel__row">
                      <button className="btn btn-sm" onClick={() => void openBilling(act, { kind: "billingPortal" })}>{t("契約の管理 (支払い方法・解約)")}</button>
                    </div>
                  )}
                  {status.billingLink && (
                    <div className="sync-panel__row sync-panel__billing-link">
                      <a href={status.billingLink.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                        {status.billingLink.kind === "checkout" ? t("申し込みの画面を開く (Stripe)") : t("契約の管理を開く (Stripe)")}
                      </a>
                      <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "billingDismiss" })}>{t("閉じる")}</button>
                    </div>
                  )}
                  {status.message && <div className="sync-panel__line muted">{status.message}</div>}
                </div>
              )}
              {/* サインインの手段: 付いているものを記号で示し、無い方は「+」で足せる */}
              {account.identities && status.credentials.source === "stored" && (
                <div className="sync-panel__group">
                  <div className="sync-panel__group-title">{t("サインインの手段")}</div>
                  {status.signIn?.link
                    ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
                    : <div className="sync-panel__row sync-panel__identities" title={t("このアカウントのサインインの手段。もう一方を足すと、どちらでサインインしても同じアカウントになります")}>
                      {(["github", "google"] as const).map((p) => account.identities!.includes(p)
                        ? <span key={p} className="sync-panel__identity" data-on="true">{p === "github" ? "GitHub" : "Google"} ✓</span>
                        : <button key={p} className="btn btn-ghost btn-sm" onClick={() => void signInOneStep(act, p, true)} title={p === "github" ? t("GitHub でもサインインできるようにする") : t("Google でもサインインできるようにする")}>+ {p === "github" ? "GitHub" : "Google"}</button>)}
                    </div>}
                </div>
              )}
              <div className="sync-panel__group">
                <button className="btn btn-sm" title={t("この端末の同期を止めてサインアウトします。手元の計画は残ります")} onClick={() => { setOpen(false); void act({ kind: "signOut" }); }}>{t("サインアウト")}</button>
              </div>
              {/* アカウントの削除: 欄の中で 2 段階の確認 (元に戻せない操作) */}
              <div className="sync-panel__group sync-panel__group--danger">
                <div className="sync-panel__group-title">{t("削除 (元に戻せません)")}</div>
                {confirmDelete ? (
                  <div className="sync-panel__confirm-delete" role="group" aria-label={t("アカウントの削除の確認")}>
                    <div>{t("サーバーの計画は 30 日後に消えます (それまでは support@boxglow.app への連絡で取り消せます)。手元のファイルは残ります。")}</div>
                    <div className="sync-panel__actions">
                      <button className="btn btn-sm btn-danger" onClick={() => { setConfirmDelete(false); setOpen(false); void act({ kind: "deleteAccount" }); }}>{t("アカウントを削除する")}</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("やめる")}</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn btn-ghost btn-sm sync-panel__danger" onClick={() => setConfirmDelete(true)}>{t("アカウントを削除…")}</button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
