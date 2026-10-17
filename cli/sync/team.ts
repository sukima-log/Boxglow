/**
 * boxglow team: チーム (ワークスペース) の操作 (CLI。B81)
 *   list                         自分のチームの一覧
 *   create <名前>                作る (作った人が管理者)
 *   show <ID>                    メンバー・契約・(管理者なら) 招待と記録
 *   invite <ID> [--role viewer|editor]   招待リンクを作る (管理者。URL はこのときだけ表示)
 *   join <トークンまたは URL>     招待リンクで参加する
 *   role <ID> <アカウント> <役割>  役割を変える (管理者)
 *   leave <ID>                   抜ける
 * Input : o = { server, out, fetch?, command, args, role? }。Output: 終了コード
 */
import { t } from "../../src/i18n/core";
import { performTeamAction, type TeamAction, type TeamsState } from "../../src/sync/teams";
import { APP_VERSION } from "../../src/model/version";
import { resolveToken } from "./credentials";
import { serverProblem } from "./login";
import { normalizeServer } from "./state-store";

export interface TeamCommandOptions { server: string; out: (line: string) => void; fetch?: typeof fetch; allowEnvironmentToken?: boolean; command: string; args: string[]; role?: string }

const ROLE_LABEL: Record<string, string> = { viewer: "閲覧", editor: "編集", admin: "管理" };

export async function runTeam(o: TeamCommandOptions): Promise<number> {
  const { out } = o;
  const server = normalizeServer(o.server);
  const problem = serverProblem(server);
  if (problem) { out(problem); return 1; }
  const credential = resolveToken(server, o.allowEnvironmentToken);
  if (!credential) { out(t("先にサインインしてください")); return 1; }
  const doFetch = (path: string, init: RequestInit = {}) => (o.fetch ?? fetch)(`${server}${path}`, { ...init, headers: { authorization: `Bearer ${credential.token}`, "x-boxglow-version": APP_VERSION, ...(init.headers as Record<string, string> | undefined) }, redirect: "error", signal: AbortSignal.timeout(30000) });
  const run = (action: TeamAction, state: TeamsState = { busy: false }) => performTeamAction(doFetch, state, action, t);
  const [a1, a2, a3] = o.args;
  let action: TeamAction;
  switch (o.command) {
    case "list": action = { kind: "listTeams" }; break;
    case "create": if (!a1) { out("boxglow team create <名前>"); return 1; } action = { kind: "createTeam", name: a1 }; break;
    case "show": if (!a1) { out("boxglow team show <ID>"); return 1; } action = { kind: "openTeam", id: a1 }; break;
    case "invite": if (!a1) { out("boxglow team invite <ID> [--role viewer|editor]"); return 1; } action = { kind: "createInvite", id: a1, role: o.role === "viewer" ? "viewer" : "editor" }; break;
    case "join": { const token = /bgi_[A-Za-z0-9_.-]+/.exec(a1 ?? "")?.[0]; if (!token) { out("boxglow team join <招待リンクまたはトークン>"); return 1; } action = { kind: "joinTeam", token }; break; }
    case "role": if (!a1 || !a2 || !["viewer", "editor", "admin"].includes(a3 ?? "")) { out("boxglow team role <ID> <アカウント> viewer|editor|admin"); return 1; } action = { kind: "setMember", id: a1, accountId: a2, role: a3 as "viewer" | "editor" | "admin" }; break;
    case "leave": if (!a1) { out("boxglow team leave <ID>"); return 1; } action = { kind: "leaveTeam", id: a1 }; break;
    default: out("boxglow team list | create <名前> | show <ID> | invite <ID> [--role viewer|editor] | join <リンク> | role <ID> <アカウント> <役割> | leave <ID>"); return 1;
  }
  const state = await run(action);
  if (state.error) { out(state.error); return 1; }
  if (action.kind === "listTeams") {
    if (!state.list?.length) { out(t("まだワークスペースはありません。")); return 0; }
    for (const tm of state.list) out(`${tm.teamId}  ${tm.name}  ${t(ROLE_LABEL[tm.role] ?? tm.role)}  ${t("{n} 人", { n: String(tm.members) })}`);
    return 0;
  }
  if (action.kind === "createTeam") { out(t("作りました: {name} ({id})", { name: state.open?.name ?? action.name, id: state.open?.teamId ?? "" })); return 0; }
  if (action.kind === "openTeam" && state.open) {
    const d = state.open;
    out(`${d.name} (${d.teamId})  ${t(ROLE_LABEL[d.role] ?? d.role)}  ${t("計画 {n} 個", { n: String(d.usage.projects) })}`);
    out(t("メンバー") + ` (${d.members.length}${d.maxMembers > 0 ? ` / ${d.maxMembers}` : ""}):`);
    for (const m of d.members) out(`  ${m.accountId}  ${m.displayName || m.login}  ${t(ROLE_LABEL[m.role] ?? m.role)}`);
    out(t("契約") + ": " + (d.billing.plan ? `Team ${d.billing.status} x${d.billing.seats}` : d.billing.required ? t("未契約 (契約するまでメンバーは同期できません)") : t("未契約 (試用の間は使えます)")));
    if (d.invites) for (const i of d.invites.filter((x) => !x.revoked && !x.expired)) out(`${t("招待リンク")}: ${i.id}  ${t(ROLE_LABEL[i.role] ?? i.role)}  ${t("{n} 回使用", { n: String(i.uses) })}  ${t("{date} まで", { date: i.expiresAt.slice(0, 10) })}`);
    return 0;
  }
  if (action.kind === "createInvite" && state.newInvite) { out(t("招待リンクを作りました (7 日間有効)。相手に渡してください。")); out(state.newInvite.url); return 0; }
  if (action.kind === "joinTeam" && state.join) { out(state.join.joined ? t("「{name}」に参加しました。", { name: state.join.team?.name ?? "" }) : t("「{name}」のメンバーです。", { name: state.join.team?.name ?? "" })); return 0; }
  if (action.kind === "setMember") { out(t("変更しました")); return 0; }
  if (action.kind === "leaveTeam") { out(t("抜けました")); return 0; }
  return 0;
}
