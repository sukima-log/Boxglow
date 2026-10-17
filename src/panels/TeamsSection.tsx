/**
 * アカウントのメニューの「ワークスペース」の欄 (B81)
 *   一覧 (役割・人数) → 押すと詳細: メンバー (役割の変更・外す・自分の表示名)、招待リンク (作る・失効)、契約 (申し込み・人数・契約の管理)、監査ログ、離脱、削除
 *   「ワークスペースを作る」は名前 1 つ
 * Input : status (teams の状態を読む), act。Output: 欄の JSX
 */
import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { HostAction, SyncStatus } from "../sync/status";
import type { TeamRole } from "../sync/teams";

const ROLE_LABEL: Record<TeamRole, string> = { viewer: "閲覧", editor: "編集", admin: "管理" };

export function TeamsSection({ status, act }: { status: SyncStatus; act: (a: HostAction) => Promise<unknown> }) {
  const teams = status.teams;
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [inviteRole, setInviteRole] = useState<"viewer" | "editor">("editor");
  const [seats, setSeats] = useState(2);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "leave" | null>(null);
  const me = status.credentials.account?.accountId;
  useEffect(() => { if (open && me && teams?.list === undefined && !teams?.busy) void act({ kind: "listTeams" }); }, [open, me, teams?.list === undefined, teams?.busy]);
  // 欄を開き直したときは、前に開いていた詳細 (古いメンバー一覧など) を閉じる (押したチームを読み直す)
  useEffect(() => { if (open && teams?.open && !teams.busy) void act({ kind: "teamDismiss" }); }, [open]);
  const detail = teams?.open;
  const admin = detail?.role === "admin";
  return (
    <div className="sync-panel__group">
      <button className="sync-action" data-open={open ? "true" : "false"} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sync-action__icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 19c0-3 3-5 6-5s6 2 6 5"/><path d="M15 19c0-2 2-3.5 4-3.5s3 1 3 3.5"/></svg></span>
        <span className="sync-action__text"><span className="sync-action__label">{t("ワークスペース")}</span><span className="sync-action__hint">{t("チームで同じ計画を同期する。招待・役割・契約")}</span></span>
        <span className="sync-action__chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="teams">
          {teams?.error && <p role="alert" className="sync-panel__problem">{teams.error}</p>}
          {/* 一覧 */}
          {teams?.list?.map((tm) => (
            <button key={tm.teamId} className="sync-project-row teams__row" data-open={detail?.teamId === tm.teamId ? "true" : "false"} onClick={() => void act(detail?.teamId === tm.teamId ? { kind: "teamDismiss" } : { kind: "openTeam", id: tm.teamId })}>
              <strong>{tm.name}</strong><span>{t(ROLE_LABEL[tm.role])} · {t("{n} 人", { n: String(tm.members) })}</span>
            </button>
          ))}
          {teams?.list?.length === 0 && <p className="muted">{t("まだワークスペースはありません。")}</p>}
          {/* 作る */}
          <div className="teams__new">
            <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={64} placeholder={t("ワークスペースの名前")} aria-label={t("ワークスペースの名前")} />
            <button className="btn btn-sm" disabled={teams?.busy || !newName.trim()} onClick={() => { void act({ kind: "createTeam", name: newName.trim() }); setNewName(""); }}>{t("ワークスペースを作る")}</button>
          </div>
          {/* 詳細 */}
          {detail && (
            <div className="teams__detail">
              <div className="teams__head"><strong>{detail.name}</strong><span className="muted">{t(ROLE_LABEL[detail.role])} · {t("計画 {n} 個", { n: String(detail.usage.projects) })}</span></div>
              {/* メンバー */}
              <p className="teams__label">{t("メンバー")} ({detail.members.length}{detail.maxMembers > 0 ? ` / ${detail.maxMembers}` : ""})</p>
              {detail.members.map((m) => (
                <div key={m.accountId} className="teams__member">
                  <span className="teams__name">{m.displayName || m.login}{m.accountId === me ? ` (${t("自分")})` : ""}</span>
                  {admin && m.accountId !== me
                    ? <select className="input" value={m.role} aria-label={t("役割")} onChange={(e) => void act({ kind: "setMember", id: detail.teamId, accountId: m.accountId, role: e.target.value as TeamRole })}>{(["viewer", "editor", "admin"] as const).map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)}</select>
                    : <span className="muted">{t(ROLE_LABEL[m.role])}</span>}
                  {admin && m.accountId !== me && <button className="btn btn-ghost btn-sm" disabled={teams?.busy} onClick={() => void act({ kind: "removeMember", id: detail.teamId, accountId: m.accountId })}>{t("外す")}</button>}
                </div>
              ))}
              {/* 招待 (admin) */}
              {admin && (
                <>
                  <p className="teams__label">{t("招待リンク")}</p>
                  <div className="teams__new">
                    <select className="input" value={inviteRole} aria-label={t("招待する役割")} onChange={(e) => setInviteRole(e.target.value as "viewer" | "editor")}><option value="editor">{t("編集")}</option><option value="viewer">{t("閲覧")}</option></select>
                    <button className="btn btn-primary btn-sm" disabled={teams?.busy} onClick={() => { setCopied(false); void act({ kind: "createInvite", id: detail.teamId, role: inviteRole }); }}>{t("招待リンクを作る")}</button>
                  </div>
                  {teams?.newInvite && (
                    <div className="agent-tokens__token">
                      <strong>{t("招待リンクを作りました (7 日間有効)。相手に渡してください。")}</strong>
                      <code className="agent-tokens__secret">{teams.newInvite.url}</code>
                      <div className="sync-panel__row"><button className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(teams.newInvite!.url).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? t("コピーしました") : t("リンクをコピー")}</button></div>
                    </div>
                  )}
                  {detail.invites?.filter((i) => !i.revoked && !i.expired).map((i) => (
                    <div key={i.id} className="teams__member"><span className="teams__name">{t(ROLE_LABEL[i.role])} · {t("{n} 回使用", { n: String(i.uses) })} · {t("{date} まで", { date: new Date(i.expiresAt).toLocaleDateString() })}</span><button className="btn btn-ghost btn-sm" disabled={teams?.busy} onClick={() => void act({ kind: "revokeInvite", id: detail.teamId, inviteId: i.id })}>{t("失効")}</button></div>
                  ))}
                </>
              )}
              {/* 契約 */}
              <p className="teams__label">{t("契約")}</p>
              <p className="muted">{detail.billing.plan ? t("Team · {status} · {n} 人", { status: detail.billing.status === "active" ? t("有効") : detail.billing.status, n: String(detail.billing.seats) }) : detail.billing.required ? t("未契約 (契約するまでメンバーは同期できません)") : t("未契約 (試用の間は使えます)")}</p>
              {detail.billing.checkout && (
                <div className="teams__new">
                  <input className="input teams__seats" type="number" min={Math.max(2, detail.members.length)} max={100} value={seats} aria-label={t("人数")} onChange={(e) => setSeats(Number(e.target.value) || 2)} />
                  <button className="btn btn-primary btn-sm" disabled={teams?.busy} onClick={() => void act({ kind: "teamCheckout", id: detail.teamId, seats: Math.max(2, detail.members.length, seats) })}>{t("Team を申し込む (1 人 月 800 円)")}</button>
                </div>
              )}
              {admin && detail.billing.plan && detail.billing.entitled && (
                <div className="teams__new">
                  <input className="input teams__seats" type="number" min={detail.members.length} max={100} value={seats} aria-label={t("人数")} onChange={(e) => setSeats(Number(e.target.value) || 1)} />
                  <button className="btn btn-sm" disabled={teams?.busy} onClick={() => void act({ kind: "teamSeats", id: detail.teamId, seats: Math.max(detail.members.length, seats) })}>{t("人数を変える")}</button>
                  {detail.billing.portal && <button className="btn btn-sm" disabled={teams?.busy} onClick={() => void act({ kind: "teamPortal", id: detail.teamId })}>{t("契約の管理 (支払い方法・解約)")}</button>}
                </div>
              )}
              {teams?.link && <a className="btn btn-primary btn-sm" href={teams.link.url} target="_blank" rel="noreferrer" onClick={() => void act({ kind: "teamDismiss" })}>{teams.link.kind === "checkout" ? t("申し込み画面を開く") : t("契約の管理を開く")}</a>}
              {/* ログ (admin) */}
              {admin && detail.log && detail.log.length > 0 && (
                <details className="teams__log"><summary className="muted">{t("記録 {n} 件", { n: String(detail.log.length) })}</summary>
                  {detail.log.slice(0, 50).map((l, i) => <div key={i} className="muted teams__logrow">{new Date(l.at).toLocaleString()} · {l.actor} · {l.action} {l.target}</div>)}
                </details>
              )}
              {/* 離脱 / 削除 */}
              <div className="sync-panel__row">
                {confirm === null && <button className="btn btn-ghost btn-sm" disabled={teams?.busy} onClick={() => setConfirm("leave")}>{t("このワークスペースから抜ける…")}</button>}
                {confirm === null && admin && <button className="btn btn-ghost btn-sm danger" disabled={teams?.busy} onClick={() => setConfirm("delete")}>{t("ワークスペースを消す…")}</button>}
              </div>
              {confirm && (
                <div className="sync-lifecycle__confirm">
                  <p>{confirm === "delete" ? t("「{name}」を消します。中の計画はサーバーから 30 日後に消えます (手元のファイルは残ります)。", { name: detail.name }) : t("「{name}」から抜けます。このチームの計画は同期できなくなります。", { name: detail.name })}</p>
                  <div className="sync-panel__row">
                    <button className="btn btn-primary btn-sm danger" disabled={teams?.busy} onClick={() => { setConfirm(null); void act(confirm === "delete" ? { kind: "deleteTeam", id: detail.teamId } : { kind: "leaveTeam", id: detail.teamId }); }}>{confirm === "delete" ? t("消す") : t("抜ける")}</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(null)}>{t("やめる")}</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
