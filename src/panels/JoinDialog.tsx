/**
 * 招待リンク (#join=<トークン>) で開いたときの参加の画面 (B81)
 *   サインインしていなければサインインの手段 → 「<チーム> に <役割> として参加しますか」 → 参加 → 「参加しました」
 * Input : なし (ストアの joinToken と syncStatus / syncAct を使う)。Output: 画面 (トークンが無い・裏方が無いときは何も出さない)
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../i18n";
import { useProjectStore } from "../store/useProjectStore";
import { SignInButtons } from "./SignInButtons";
import { SignInCode } from "./SyncPanel";

const ROLE_LABEL: Record<string, string> = { viewer: "閲覧", editor: "編集", admin: "管理" };

export function JoinDialog() {
  const token = useProjectStore((s) => s.joinToken);
  const setToken = useProjectStore((s) => s.setJoinToken);
  const status = useProjectStore((s) => s.syncStatus);
  const act = useProjectStore((s) => s.syncAct);
  const signedIn = !!status?.credentials.account;
  const join = status?.teams?.join;
  // サインイン済みで、まだ確認していなければ、招待の内容を読む
  useEffect(() => {
    if (token && signedIn && act && (!join || join.token !== token) && !status?.teams?.busy) void act({ kind: "joinPreview", token });
  }, [token, signedIn, act, join?.token, status?.teams?.busy]);
  if (!token || !status || !act) return null;
  const close = () => { setToken(null); void act({ kind: "teamDismiss" }); };
  // Home の覆いより上に出す (別の重なり文脈にならないよう、body の直下に描く)
  return createPortal(
    <div className="join-dialog" role="dialog" aria-label={t("ワークスペースへの参加")}>
      <div className="join-dialog__card">
        <strong>{t("ワークスペースへの参加")}</strong>
        {!signedIn ? (
          <>
            <p>{t("招待リンクを開きました。参加するには、先にサインインしてください。")}</p>
            {/* GitHub はコードを出してから相手のページへ (同期パネルと同じ部品) */}
            {status.signIn ? <SignInCode code={status.signIn} onCancel={() => void act({ kind: "cancelSignIn" })} /> : <SignInButtons act={act} />}
          </>
        ) : join?.error ? (
          <p role="alert" className="sync-panel__problem">{join.error}</p>
        ) : join?.joined || join?.alreadyMember ? (
          <>
            <p>{join.joined ? t("「{name}」に参加しました。") : t("「{name}」のメンバーです。", { name: join.team?.name ?? "" })}</p>
            <p className="muted">{t("Home の「サーバーの計画を受け取る」や、同期の「サーバーの計画を開く」で、ワークスペースを選ぶとその計画を開けます。")}</p>
          </>
        ) : join?.team ? (
          <>
            <p>{t("「{name}」({n} 人) に {role} として参加しますか?", { name: join.team.name, n: String(join.team.members), role: t(ROLE_LABEL[join.role ?? "viewer"] ?? "閲覧") })}</p>
            <div className="sync-panel__row">
              <button className="btn btn-primary btn-sm" disabled={status.teams?.busy} onClick={() => void act({ kind: "joinTeam", token })}>{t("参加する")}</button>
            </div>
          </>
        ) : (
          <p role="status">{t("確認しています…")}</p>
        )}
        <div className="sync-panel__row"><button className="btn btn-ghost btn-sm" onClick={close}>{t("閉じる")}</button></div>
      </div>
    </div>
  , document.body);
}
