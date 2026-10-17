import { SyncLifecycle } from "./SyncLifecycle";
/**
 * 画面からの同期: 上部バーの印と、押すと開く同期パネル。
 * - 印は「同期済み / 送受信中 / 確認が必要 / 停止中 / 未同期」の 5 群。元の状態は data-state に残す。
 * - 先頭は短い状態説明・主操作・確認が要る差分。アカウント・設定・版・ID・控えは詳細へ畳む。
 * - ここは表示と操作要求の送信だけ。通信、資格情報、選択の検証、保存・復旧はストアとホストに任せる。
 * - CLI の説明文は共有しても、コマンド文字列を実行しない。許可された種類の操作と opaque な choiceId を送る。
 * 裏方が状態を流す serve --sync / VS Code の拡張でだけ表示する。秘密のトークンを画面へ渡さない。
 */
import { SyncStartup } from "./SyncStartup";
import { ConflictGroups } from "./ConflictGroups";
import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "../store/useProjectStore";
import { planLabel } from "../sync/billing";
import { SignInButtons, SignedInLine } from "./SignInButtons";
import { t } from "../i18n";
import type { HaltItem, SyncStatus, HostAction } from "../sync/status";

/** 入力: ホストの状態。出力: 利用者向けの名前、記号、配色。元のstateは変更しない。 */
function chip(status: SyncStatus): {
  label: string;
  icon: string;
  tone: string;
} {
  switch (status.state) {
    case "synced":
      return { label: t("同期済み"), icon: "✓", tone: "ok" };
    case "unsent":
    case "syncing":
      return { label: t("送受信中"), icon: "↻", tone: "busy" };
    case "halted":
      return { label: t("確認が必要"), icon: "!", tone: "attention" };
    case "problem":
    case "offline":
    case "paused":
    case "external":
    case "unsupported":
      return { label: t("停止中"), icon: "Ⅱ", tone: "problem" };
    default:
      return { label: t("未同期"), icon: "○", tone: "quiet" };
  }
}

/** 入力: 元の状態。出力: 次の操作を決めるための短い説明。詳しい理由は詳細欄に保持する。 */
function explanation(status: SyncStatus): string {
  switch (status.state) {
    case "synced":
      return t("保存されたファイルは、サーバーとそろっています。");
    case "unsent":
      return t("ファイルは保存済みです。サーバーへの送信を待っています。");
    case "syncing":
      return t("サーバーと変更を送受信しています。");
    case "halted":
      return t("内容を確かめて、進め方を選んでください。");
    case "offline":
      return t("サーバーに接続できません。接続後に再試行してください。");
    case "paused":
      return t("同期を一時停止しています。");
    case "external":
      return t("別のプロセスが同期を受け持っています。");
    case "unsupported":
      return t("この環境では、まだサインインを保存できません");
    case "problem":
      return status.problem ? fixHint(status.problem.fix) : t("詳細で停止の理由を確認してください。");
    case "signed-out":
      return t("サインインすると、この計画を同期できます。");
    case "unbound":
      return t("この計画をサーバーに置くと、同期を始められます。");
    default:
      return t("この計画の同期はオフです。");
  }
}

/** 入力: ストアの同期状態。出力: 開閉ボタンと画面内に収まるポップオーバー。 */
export function SyncChip() {
  const status = useProjectStore((s) => s.syncStatus);
  // serve との接続断では最後の状態は信用できない。「接続なし」の説明だけにして操作を出さない。
  const lost = useProjectStore((s) => s.syncLost);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 60 });
  const ref = useRef<HTMLDivElement>(null);
  // 比較中は左右の値を読める幅へ広げ、外枠と配置計算で同じ幅を使う。
  const panelWidth = status?.halt?.review && !lost ? 680 : 400;
  useEffect(() => {
    if (!open) return;
    // 入力: ボタンの座標と viewport。出力: パネルの左上。狭い画面でも右端へはみ出さないよう制限する。
    const place = () => {
      const box = ref.current?.getBoundingClientRect();
      if (box)
        setPosition({
          left: Math.max(8, Math.min(box.left, innerWidth - Math.min(panelWidth, innerWidth - 16) - 8)),
          top: Math.max(8, Math.min(box.bottom + 8, innerHeight - 160)),
        });
    };
    // 入力: MouseEvent。出力: void。パネル内の操作は保ち、外側のクリックでだけ閉じる。
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // 入力: KeyboardEvent。出力: void。Escape で閉じた後は入口に戻し、キー操作を続けられるようにする。
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, panelWidth]);
  if (!status) return null;
  const c = lost ? { label: t("停止中"), icon: "Ⅱ", tone: "problem" } : chip(status);
  return (
    <div className="sync-chip-wrap" ref={ref}>
      <button
        className={`sync-chip tone-${c.tone}`}
        data-state={lost ? "disconnected" : status.state}
        onClick={() => setOpen(!open)}
        title={t("同期")}
        aria-expanded={open}
      >
        <span aria-hidden="true">{c.icon}</span>
        <span>
          {t("同期")}: {c.label}
        </span>
      </button>
      {open && (
        <div
          className="sync-popover"
          style={{
            width: `min(${panelWidth}px, calc(100vw - 16px))`,
            left: position.left,
            top: position.top,
            maxHeight: `calc(100dvh - ${position.top + 8}px)`,
          }}
        >
          {lost ? (
            <div className="sync-panel" role="dialog" aria-label={t("同期")}>
              <strong>
                {t("停止中")} · {t("接続なし")}
              </strong>
              <div className="sync-panel__line">
                {t(
                  "boxglow serve と接続できません。同期の状態は分かりません (最後の表示は古い可能性があります)。serve が動いているか確かめてください。つながり直すと、表示は戻ります",
                )}
              </div>
              <button
                className="sync-panel__close btn btn-ghost btn-sm"
                onClick={() => setOpen(false)}
                aria-label={t("閉じる")}
              >
                ×
              </button>
            </div>
          ) : (
            <SyncPanel status={status} onClose={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}

/** 入力: 最新の同期状態と閉じる操作。出力: 主操作、比較、折りたたんだ設定・詳細。 */
function SyncPanel({ status, onClose }: { status: SyncStatus; onClose: () => void }) {
  /**
   * 申し込み / 契約の管理を 1 回の押下で開く
   *   押した瞬間に空のタブを開いておき (利用者の操作の中なので遮られない)、サーバーから URL が来たらそのタブをそこへ移す。
   *   タブを開けない環境 (VS Code の webview など) では、状態に残った URL をリンクとして出す (下の billingLink)
   */
  const openBilling = async (action: HostAction) => {
    let tab: Window | null = null;
    try { tab = window.open("about:blank", "_blank"); } catch { tab = null; }
    await act(action);
    const link = useProjectStore.getState().syncStatus?.billingLink;
    if (tab && link) { tab.location.href = link.url; void act({ kind: "billingDismiss" }); }
    else if (tab) tab.close();
  };
  /** アカウントの削除の確認を出しているか (サインアウトや閉じるで消える) */
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (status.credentials.source === "none") setConfirmDelete(false); }, [status.credentials.source]);
  const act = useProjectStore((s) => s.syncAct);
  const saveState = useProjectStore((s) => s.saveState);
  const file = status.file;
  const account = status.credentials.account;
  const c = chip(status);
  // 設計書 4 章: 未保存の画面を残してサーバー側を採ると、保存前の編集を失うおそれがある。
  // 同じ基準で比較し直せるよう、保存中も含めて選択を止める。最終的な可否はホストも再検証する。
  const unsaved = saveState === "unsaved" || saveState === "saving";
  // 表示の文と操作を分離。command の文面を解釈せず、ホストの choiceIds だけを操作に渡す。
  const choices =
    status.halt?.items.filter((i): i is Extract<HaltItem, { kind: "choice" }> => i.kind === "choice") ?? [];
  const texts =
    status.halt?.items.filter((i): i is Extract<HaltItem, { kind: "text" }> => i.kind === "text") ?? [];
  // 旧ホストは競合値を「  - path: 手元 ... / サーバー ...」として返す。
  // 値そのものは解釈せず表示し、共通の前置きだけを詳細へ移す。全件を見比べられるように残す。
  const conflicts =
    status.halt?.reason === "conflicts" ? texts.filter((item) => item.text.trimStart().startsWith("- ")) : [];
  const comparison = conflicts.length ? conflicts : texts;
  const extra = conflicts.length ? texts.filter((item) => !conflicts.includes(item)) : [];
  const ready = status.support === "ok" && status.state !== "signed-out";
  return (
    <div className="sync-panel" role="dialog" aria-label={t("同期")}>
      <div className={`sync-panel__heading tone-${c.tone}`}>
        <span aria-hidden="true">{c.icon}</span>
        <strong>{status.startup ? t("同期を始める") : c.label}</strong>
      </div>
      {!status.startup && <div className="sync-panel__line">{explanation(status)}</div>}
      {/* サインインの状態は、いつも同じ場所に出す (サインインしているかどうかが一目で分かるように) */}
      {status.support === "ok" && status.server && <SignedInLine status={status} />}
      {unsaved && file?.enabled && (
        <div className="sync-panel__line muted">{t("未保存の編集があります。保存すると送られます")}</div>
      )}
      {/* R49: エディタの未保存編集がある受信待ちは、自動統合・自動の開き直しへ進めず、先に退避を案内する。 */}
      <EditorBehind />
      {status.server && file && ((!file.binding && !status.halt) || status.startup) && status.support === "ok" && <SyncStartup key={status.startup?.operationId ?? "entry"} status={status} act={act} unsaved={unsaved}/>}
      {/* 招待されていない (開始の手順の外でサインインしたとき。手順の中では SyncStartup が出す) */}
      {status.notInvited && !status.startup && !status.signIn && (
        <div className="sync-panel__line" role="alert">
          {t("同期は招待制の試験中です。このアカウントはまだ招待されていません。")}
          {status.notInvited.waitlist && <> <a href={status.notInvited.waitlist} target="_blank" rel="noreferrer">{t("順番待ちに登録する")}</a></>}
        </div>
      )}
      {status.signIn ? (
        <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} />
      ) : (
        <div className="sync-panel__row">
          {status.support === "ok" && !account && status.credentials.source !== "env" && (!status.server || file?.binding || status.startup?.stage === "signin") && (
            <SignInButtons act={act} />
          )}
          {file && ready && !file.enabled && !status.startup && (!status.server || file.binding) && (
            <button className="btn btn-primary btn-sm" onClick={() => void act({ kind: "enable" })}>
              {t("この計画を同期する")}
            </button>
          )}
          {file?.enabled && ready && !file.binding && !status.server && !status.startup && status.state === "unbound" && (
            <button className="btn btn-primary btn-sm" onClick={() => void act({ kind: "bind" })}>
              {t("サーバーに置く")}
            </button>
          )}
          {file?.enabled &&
            ready &&
            file.binding &&
            status.state !== "external" &&
            status.state !== "halted" && (
              <button
                className="btn btn-sm"
                disabled={status.state === "syncing"}
                onClick={() => void act({ kind: "syncNow" })}
              >
                {t("今すぐ同期")}
              </button>
            )}
        </div>
      )}
      {status.localBackup && (
        <div role="status" className="sync-panel__line break-all">
          {t("置き換え前の手元の編集を保存しました。控え: {path}", { path: status.localBackup })}
        </div>
      )}
      {status.halt && (
        <div className="sync-panel__halt">
          {status.halt.review && status.halt.resolutionChoiceId ? (
            <>
              <ConflictGroups
                review={status.halt.review}
                remoteLabel={t("サーバーの値")}
                disabled={unsaved}
                onSubmit={(resolution) =>
                  void act({
                    kind: "resolveGroups",
                    choiceId: status.halt!.resolutionChoiceId!,
                    resolution,
                  })
                }
              />
              {status.halt.resolutionError && <p role="status">{status.halt.resolutionError}</p>}
            </>
          ) : (
            <>
              {/* 置き換え・復旧の注意も含むホストの説明を維持する。競合時は左右の選択を隣に置く。 */}
              <div className="sync-panel__comparison">
                {comparison.map((item, n) => (
                  <div className="sync-panel__line" key={n}>
                    {item.text}
                  </div>
                ))}
              </div>
              {choices.length ? (
                <div className="sync-panel__choices">
                  {choices.map((ch) => (
                    <button
                      key={ch.id}
                      className="btn btn-sm"
                      disabled={unsaved}
                      title={unsaved ? t("先に保存してください") : ch.label}
                      onClick={() => {
                        const id = status.halt!.choiceIds[ch.id];
                        if (id) void act({ kind: "choose", choiceId: id });
                      }}
                    >
                      {ch.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="muted">{fixHint(status.halt.fix)}</div>
              )}
            </>
          )}
        </div>
      )}
      {status.support === "ok" && status.credentials.source !== "none" && <details className="sync-panel__management" open={status.lifecycle ? true : undefined}><summary>{t("サーバーの計画を管理")}</summary><SyncLifecycle status={status} act={act}/></details>}
      {/* 日常の操作を埋もれさせないよう設定を畳む。ホストの停止理由・控えの場所は省略しない。 */}
      <details className="sync-panel__details">
        <summary>{t("詳細と設定")}</summary>
        {/* 知らせ (補足・停止の理由・控え): 組の上にまとめて出す */}
        {(status.message || status.problem || extra.length > 0 || status.halt?.done.backup) && (
          <div className="sync-panel__group sync-panel__group--notes">
            {status.message && <div className="sync-panel__line">{status.message}</div>}
            {status.problem && (
              <div className="sync-panel__line sync-panel__problem">
                {status.problem.text} {fixHint(status.problem.fix)}
              </div>
            )}
            {extra.map((item, n) => (
              <div key={n}>{item.text}</div>
            ))}
            {status.halt?.done.backup && (
              <div>
                {t("控え")}: {status.halt.done.backup}
              </div>
            )}
          </div>
        )}
        {/* 組 1: アカウント (誰で・どの手段でサインインしているか、サインアウト) */}
        {(account || status.credentials.source === "env") && (
          <section className="sync-panel__group" aria-label={t("アカウント")}>
            <div className="sync-panel__group-title">{t("アカウント")}</div>
            <div className="sync-panel__row">
              {account ? (
                <>
                  <span className="sync-panel__who">{account.display}</span>
                  {/* サインインの手段: 付いているものを記号で示し、無い方は「+」で足せる (本人の明示操作。保存したサインインのときだけ) */}
                  {account.identities && status.credentials.source === "stored" && !status.signIn && (
                    <span className="sync-panel__identities" title={t("このアカウントのサインインの手段。もう一方を足すと、どちらでサインインしても同じアカウントになります")}>
                      {(["github", "google"] as const).map((p) => account.identities!.includes(p)
                        ? <span key={p} className="sync-panel__identity" data-on="true">{p === "github" ? "GitHub" : "Google"} ✓</span>
                        : <button key={p} className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "linkIdentity", provider: p })} title={p === "github" ? t("GitHub でもサインインできるようにする") : t("Google でもサインインできるようにする")}>+ {p === "github" ? "GitHub" : "Google"}</button>)}
                    </span>
                  )}
                  <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "signOut" })}>
                    {t("サインアウト")}
                  </button>
                </>
              ) : (
                <span>{t("環境変数のトークンで同期しています")}</span>
              )}
            </div>
          </section>
        )}
        {/* 組 2: プラン (契約の状態・申し込み・契約の管理)。サーバーが契約の状態を返したときだけ */}
        {account?.billing && (account.billing.required || account.billing.plan || account.billing.checkout) && (
          <section className="sync-panel__group" aria-label={t("プラン")}>
            <div className="sync-panel__group-title">{t("プラン")}</div>
            <div className="sync-panel__row sync-panel__billing">
              <span className="sync-panel__plan" data-entitled={account.billing.entitled ? "true" : "false"}>
                {account.billing.plan ? planLabel(account.billing.plan) : t("未契約")}{account.billing.plan === "team" && account.billing.seats > 0 ? ` × ${account.billing.seats}` : ""}
                {account.billing.plan && account.billing.plan !== "comp" ? ` (${billingStatusLabel(account.billing.status)})` : ""}
              </span>
              {account.billing.portal && <button className="btn btn-ghost btn-sm" onClick={() => void openBilling({ kind: "billingPortal" })}>{t("契約の管理")}</button>}
            </div>
            {/* 申し込み: 契約が無い (試用中を含む) か、契約が切れているとき。契約を求めていない試用中は、契約が無くても同期は止まらない */}
            {account.billing.checkout && (!account.billing.plan || !account.billing.entitled) && (
              <div className="sync-panel__row">
                <button className="btn btn-primary btn-sm" onClick={() => void openBilling({ kind: "billingCheckout", plan: "personal" })}>{t("Personal を申し込む (月 500 円)")}</button>
                <button className="btn btn-sm" onClick={() => void openBilling({ kind: "billingCheckout", plan: "team", seats: 2 })}>{t("Team を申し込む (1 人 月 800 円)")}</button>
              </div>
            )}
            {/* タブを開けなかったときだけ残る: 画面の URL をリンクとして出す (VS Code の webview では外のブラウザで開く) */}
            {status.billingLink && (
              <div className="sync-panel__row sync-panel__billing-link">
                <a href={status.billingLink.url} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-sm">
                  {status.billingLink.kind === "checkout" ? t("申し込みの画面を開く (Stripe)") : t("契約の管理を開く (Stripe)")}
                </a>
                <button className="btn btn-ghost btn-sm" onClick={() => void act({ kind: "billingDismiss" })}>{t("閉じる")}</button>
              </div>
            )}
          </section>
        )}
        {/* 組 3: この計画 (同期の有無・送り先・ファイル・サーバーの ID と版) */}
        <section className="sync-panel__group" aria-label={t("この計画")}>
          <div className="sync-panel__group-title">{t("この計画")}</div>
          {file && ready && (!status.server || file.binding) && (
            <label className="sync-panel__toggle">
              <input
                type="checkbox"
                checked={file.enabled}
                onChange={(e) => void act({ kind: e.target.checked ? "enable" : "disable" })}
              />
              <span>{t("この計画を同期する")}</span>
            </label>
          )}
          <dl className="sync-panel__facts">
            {status.server && <><dt>{t("送り先")}</dt><dd className="break-all">{status.server}</dd></>}
            {file && <><dt>{t("ファイル")}</dt><dd className="break-all">{file.path}</dd></>}
            {status.startup?.opened && <><dt>{t("保存先")}</dt><dd className="break-all">{status.startup.opened.path}</dd></>}
            {file?.binding && status.state !== "signed-out" && <><dt>{t("サーバー ID")}</dt><dd className="sync-panel__id">{file.binding.remoteId}{status.revision ? ` (${t("版")} ${status.revision})` : ""}</dd></>}
          </dl>
          {/* R39-06: 開き直した後の VS Code で退避を取り込む入口。 */}
          <RestoreEntry />
        </section>
        {/* 組 4: 取り返しのつかない操作 (アカウントの削除)。欄の中で 2 段階の確認 (window.confirm は VS Code の webview で使えない) */}
        {account && (
          <section className="sync-panel__group sync-panel__group--danger" aria-label={t("アカウントの削除")}>
            {confirmDelete ? (
              <div className="sync-panel__confirm-delete" role="group" aria-label={t("アカウントの削除の確認")}>
                <div>{t("サーバーの計画は 30 日後に消えます (それまでは support@boxglow.app への連絡で取り消せます)。手元のファイルは残ります。")}</div>
                <div className="sync-panel__actions">
                  <button className="btn btn-sm btn-danger" onClick={() => { setConfirmDelete(false); void act({ kind: "deleteAccount" }); }}>{t("アカウントを削除する")}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>{t("やめる")}</button>
                </div>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm sync-panel__danger" onClick={() => setConfirmDelete(true)}>{t("アカウントを削除…")}</button>
            )}
          </section>
        )}
      </details>
      <button className="sync-panel__close btn btn-ghost btn-sm" onClick={onClose} aria-label={t("閉じる")}>
        ×
      </button>
    </div>
  );
}

/**
 * 入力: 引数なし。ストアの editorBehind・現在の計画・保存状態・退避結果を読む。
 * 出力: エディタ待ちの説明と退避ボタン、待っていなければ null。
 * R49: 画面とテキストエディタの未保存データを勝手に統合・破棄せず、退避して人が開き直す手順を案内する。
 */
function EditorBehind() {
  const behind = useProjectStore((s) => s.editorBehind);
  const evacuated = useProjectStore((s) => s.evacuated);
  const evacuate = useProjectStore((s) => s.evacuate);
  const contentHash = useProjectStore((s) => s.contentHash);
  const saveState = useProjectStore((s) => s.saveState);
  const project = useProjectStore((s) => s.project);
  const [current, setCurrent] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (behind) void contentHash().then(setCurrent);
  }, [behind, project, contentHash]);
  if (!behind) return null;
  // 退避後に再編集した場合、古い控えを「退避済み」と案内しない。内容ハッシュで一致を確認する。
  const upToDate = evacuated !== null && evacuated.hash === current;
  const dirty = saveState !== "saved";
  return (
    <div className="sync-panel__halt">
      <div className="sync-panel__line">
        {t("同期で受け取った最新の中身を、VS Code のエディタがまだ読み込んでいません。")}
      </div>
      {dirty ? (
        <div className="sync-panel__line">
          {upToDate
            ? t("退避済み: {path}。ファイルを閉じて開き直し、「退避した編集を読み込む」で見比べてください", {
                path: evacuated!.path,
              })
            : t(
                "画面に未保存の編集があります。先に別のファイルへ退避してから、ファイルを閉じて開き直してください (退避せずに閉じると、この編集は失われます)",
              )}
        </div>
      ) : (
        <div className="sync-panel__line">
          {t("未保存の編集はありません。ファイルを閉じて開き直すと、最新の中身になります")}
        </div>
      )}
      <div className="sync-panel__choices">
        {dirty && !upToDate && (
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void evacuate().finally(() => setBusy(false));
            }}
          >
            {t("編集を退避する")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 入力: 引数なし。ストアの restorePending (比較の基準・段階・競合集合) を読む。
 * 出力: 項目ごとの current / saved の選択欄。比較がなければ null。選択結果は applyRestorePicks へ渡す。
 * R40-03: 選び終わるまで画面にも保存にも反映しない。取り消しても、その段階の前の画面を保持する。
 */
export function RestoreDialog() {
  const pending = useProjectStore((s) => s.restorePending);
  const apply = useProjectStore((s) => s.applyRestorePicks);
  const cancel = useProjectStore((s) => s.cancelRestore);
  const [picks, setPicks] = useState<Record<string, "current" | "saved">>({});
  const [error, setError] = useState<string | null>(null);
  // (欄の中身が作り直されたら、前の選択は捨てる。表示していない値を、古い選択で採らない)
  useEffect(() => {
    setPicks({});
  }, [pending?.basis, pending?.conflicts, pending?.step]);
  if (!pending) return null;
  /** 入力: 任意の項目値 (unknown)。出力: 表示用の文字列。省略は表示だけで、選択には元の値を使う。 */
  const show = (v: unknown) => {
    const text = v === undefined ? t("(消されている)") : typeof v === "string" ? v : JSON.stringify(v);
    return text.length > 80 ? text.slice(0, 80) + "…" : text;
  };
  // (段ごとに、どの退避の版と比べているかを示す。今の値 = この段の前までを取り込んだ、今の画面の値)
  const savedLabel = pending.step === "gui" ? t("退避した画面の値") : t("退避したエディタの値");
  const done = pending.conflicts.every((c) => picks[c.id]);
  return (
    <div className="sync-panel restore-dialog" role="dialog" aria-label={t("退避した編集の取り込み")}>
      {/* (エディタの段: 画面側は取り込み済みで、今の値はその結果。この段をやめても、画面側の取り込みは残る) */}
      {pending.step === "editor" && (
        <div className="sync-panel__line muted">
          {t("画面側の編集は取り込み済みです。「今の値」は、その結果です。")}
        </div>
      )}
      <div className="sync-panel__line">
        {pending.step === "gui"
          ? t(
              "退避した画面の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。",
            )
          : t(
              "退避したエディタ側の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。",
            )}
      </div>
      {pending.conflicts.map((c) => (
        <div key={c.id} className="sync-panel__halt">
          <div className="sync-panel__id">{c.path}</div>
          {(["current", "saved"] as const).map((k) => (
            <label key={k} className="sync-panel__toggle">
              <input
                type="radio"
                name={c.id}
                checked={picks[c.id] === k}
                onChange={() => setPicks({ ...picks, [c.id]: k })}
              />
              <span>
                {k === "current" ? t("今の値") : savedLabel}: {show(k === "current" ? c.current : c.saved)}
              </span>
            </label>
          ))}
        </div>
      ))}
      {error && <div className="sync-panel__line sync-panel__problem">{error}</div>}
      <div className="sync-panel__choices">
        <button
          className="btn btn-sm"
          disabled={!done}
          onClick={() => {
            const message = apply(picks);
            setError(message);
          }}
        >
          {t("取り込む")}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            cancel();
            setPicks({});
            setError(null);
          }}
        >
          {pending.step === "editor" ? t("この段をやめる") : t("やめる")}
        </button>
      </div>
    </div>
  );
}

/** 入力: 引数なし。ストアの saveHeld を読む。出力: 自動保存保留の印、保留がなければ null。
 * 取り込み結果の確認前に書かないための保留。解除と実際の保存はストアの Save に任せる。 */
export function SaveHeldChip() {
  const held = useProjectStore((s) => s.saveHeld);
  if (!held) return null;
  return (
    <span
      className="save-chip unsaved"
      title={t("退避した編集を取り込んだので、自動保存を止めています。確かめてから Save で保存してください")}
    >
      {t("自動保存を一時停止中")}
    </span>
  );
}

/** 入力: 引数なし。実行環境・エディタ待ち・比較中かをストアから読む。出力: 取り込みボタンまたは null。
 * R39-06: VS Code のファイル選択を通じて退避を読む。エディタ待ちでは先に開き直すので入口を出さない。 */
function RestoreEntry() {
  const source = useProjectStore((s) => s.source);
  const behind = useProjectStore((s) => s.editorBehind);
  const loadEvacuated = useProjectStore((s) => s.loadEvacuated);
  const pending = useProjectStore((s) => s.restorePending);
  // (取り込みの確認の途中は、新しい退避ファイルを読ませない。R43-02)
  if (source !== "vscode" || behind || pending) return null;
  return (
    <div className="sync-panel__row">
      <button className="btn btn-ghost btn-sm" onClick={loadEvacuated}>
        {t("退避した編集を読み込む")}
      </button>
    </div>
  );
}

/** 入力: SyncStatus の signIn (プロバイダー別の公開案内情報) と取消コールバック。
 * 出力: 認可ページへのリンク、必要ならユーザーコード、取消ボタン。トークン保存・認可の監視はホストに任せる。 */
export function SignInCode({ code, onCancel }: { code: NonNullable<SyncStatus["signIn"]>; onCancel: () => void }) {
  const [copyFailed,setCopyFailed] = useState(false);
  if (code.provider === "google") {
    return (
      <div className="sync-panel__signin">
        <div>{code.link ? t("Google を足す: ブラウザで次のページを開き、Google のアカウントで許可してください") : t("ブラウザで次のページを開き、Google のアカウントで許可してください")}</div>
        <a href={code.url} target="_blank" rel="noreferrer">
          {t("Google のサインインのページを開く")}
        </a>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>
          {t("中止")}
        </button>
      </div>
    );
  }
  return (
    <div className="sync-panel__signin">
      <div>{code.link ? t("GitHub を足す: ブラウザで次のページを開き、コードを入力してください") : t("ブラウザで次のページを開き、コードを入力してください")}</div>
      <button className="btn btn-primary btn-sm" onClick={()=>{
        // クリック内で行う。コピーを先に始めてからページを開く (先に開くと、この画面の焦点が外れてコピーが断られる)。
        // コピーできない環境でもコードを残し、認可を代行しない。
        const copied = navigator.clipboard?.writeText(code.userCode);
        if (copied) copied.then(()=>setCopyFailed(false)).catch(()=>setCopyFailed(true)); else setCopyFailed(true);
        window.open(code.verificationUrl,"_blank","noopener,noreferrer");
      }}>{t("コードをコピーして許可のページを開く")}</button>
      {copyFailed&&<p role="status">{t("コピーできませんでした。下のコードを入力してください。")}</p>}
      <div className="sync-panel__code-row">
        <span className="sync-panel__code">{code.userCode}</span>
        {/* 貼り付けられなかったときのために、コードだけをコピーする手段も置く */}
        <button className="btn btn-ghost btn-sm" onClick={()=>{ void navigator.clipboard?.writeText(code.userCode).then(()=>setCopyFailed(false)).catch(()=>setCopyFailed(true)); }}>{t("コピー")}</button>
      </div>
      <button className="btn btn-ghost btn-sm" onClick={onCancel}>
        {t("中止")}
      </button>
    </div>
  );
}

/** 入力: 裏方が返す対処先のキー (fix: string)。出力: 翻訳した案内、未知なら空文字列。
 * 選べる操作がない場合も、どこを確かめるか伝える。ここでは修復処理を実行しない。 */
function fixHint(fix: string): string {
  switch (fix) {
    case "server-setting":
      return t("同期先の設定を確認し、https の URL に変更してください。");
    case "local-file":
      return t("手元のファイルを直してください");
    case "sync-state":
      return t("同期の状態のフォルダを確かめてください");
    case "server-content":
      return t("サーバーの中身を確かめてください");
    case "billing":
      return t("同期パネルの「申し込む」から有料プランを契約してください");
    case "credentials":
      return t("サインインを確かめてください");
    case "rerun":
      return t("もう一度同期してください");
    case "wait":
      return t("しばらく待ちます");
    default:
      return "";
  }
}

/** Stripe の契約の状態 → 画面の言葉 */
function billingStatusLabel(status: string): string {
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
