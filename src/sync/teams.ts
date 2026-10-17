/**
 * チーム (ワークスペース) に関する、ホスト共通の処理 (B81)
 *   - チームの API の土台: 個人は <server>、チームは <server>/v1/teams/<id> (その先の /v1/projects... は個人と同じ)
 *   - 応答の検証 (信頼しない入力として扱う) と、画面・CLI が使う操作 (一覧・作る・メンバー・招待・契約・ログ・離脱・削除・参加)
 */
export type TeamRole = "viewer" | "editor" | "admin";
export interface TeamSummary { teamId: string; name: string; role: TeamRole; members: number }
export interface TeamMember { accountId: string; login: string; role: TeamRole; displayName: string; joinedAt: string }
export interface TeamInvite { id: string; role: TeamRole; createdBy: string; createdAt: string; expiresAt: string; uses: number; revoked: boolean; expired: boolean }
export interface TeamBilling { required: boolean; entitled: boolean; plan: string | null; status: string; seats: number; periodEnd: string | null; payer: boolean; portal: boolean; checkout: boolean }
export interface TeamDetail {
  teamId: string; name: string; ownerAccount: string; members: TeamMember[]; role: TeamRole
  ; usage: { projects: number; contentBytes: number }; billing: TeamBilling; maxMembers: number
  ; invites?: TeamInvite[]; log?: { actor: string; action: string; target: string; at: string }[]
}
/** 結び付けに持つチーム (ID と、画面に出す名前) */
export interface TeamRef { id: string; name: string }

/** チームの API の土台 (末尾の / 無し)。Input: server = 送り先の root, teamId。Output: <server>/v1/teams/<id> */
export const teamApiBase = (server: string, teamId: string): string => `${server.replace(/\/+$/, "")}/v1/teams/${encodeURIComponent(teamId)}`;
/** チームの API の土台から root の送り先に戻す (資格情報と製品判定は root で引く)。チームでなければそのまま */
export const rootServerOf = (server: string): string => server.replace(/\/v1\/teams\/[^/]+\/?$/, "");
/** チームの API の土台なら、そのチーム ID */
export const teamIdOf = (server: string): string | null => /\/v1\/teams\/([^/]+)\/?$/.exec(server)?.[1] ?? null;

const ROLES = new Set(["viewer", "editor", "admin"]);
const str = (v: unknown, max = 256): string => typeof v === "string" ? v.slice(0, max) : "";
const roleOf = (v: unknown): TeamRole => ROLES.has(v as string) ? v as TeamRole : "viewer";

/** 一覧の応答を検証する。形が合わなければ例外 */
export function parseTeams(data: unknown): TeamSummary[] {
  const list = (data as { teams?: unknown } | null)?.teams;
  if (!Array.isArray(list) || list.length > 1000) throw new Error("teams: unexpected response");
  return list.slice(0, 100).map((v) => { const s = v as Record<string, unknown>; if (typeof s.teamId !== "string") throw new Error("teams: unexpected entry"); return { teamId: s.teamId.slice(0, 64), name: str(s.name, 64), role: roleOf(s.role), members: Number(s.members) || 0 }; });
}
function parseMembers(v: unknown): TeamMember[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 200).map((m) => { const s = m as Record<string, unknown>; return { accountId: str(s.accountId, 64), login: str(s.login, 64), role: roleOf(s.role), displayName: str(s.displayName, 64), joinedAt: str(s.joinedAt, 64) }; });
}
function parseBilling(v: unknown): TeamBilling {
  const s = (v ?? {}) as Record<string, unknown>;
  return { required: s.required === true, entitled: s.entitled !== false, plan: typeof s.plan === "string" ? s.plan : null, status: str(s.status, 32) || "none", seats: Number(s.seats) || 0
  , periodEnd: typeof s.periodEnd === "string" ? s.periodEnd : null, payer: s.payer === true, portal: s.portal === true, checkout: s.checkout === true };
}
/** GET /v1/teams/:id の応答を検証する */
export function parseTeamDetail(data: unknown): TeamDetail {
  const s = (data ?? {}) as Record<string, unknown>;
  const team = (s.team ?? {}) as Record<string, unknown>;
  if (typeof team.teamId !== "string") throw new Error("team: unexpected response");
  const usage = (s.usage ?? {}) as Record<string, unknown>;
  return { teamId: team.teamId.slice(0, 64), name: str(team.name, 64), ownerAccount: str(team.ownerAccount, 64), members: parseMembers(team.members), role: roleOf(s.role)
  , usage: { projects: Number(usage.projects) || 0, contentBytes: Number(usage.contentBytes) || 0 }, billing: parseBilling(s.billing), maxMembers: Number(s.maxMembers) || 0 };
}
export function parseInvites(data: unknown): TeamInvite[] {
  const list = (data as { invites?: unknown } | null)?.invites;
  if (!Array.isArray(list)) throw new Error("invites: unexpected response");
  return list.slice(0, 100).map((v) => { const s = v as Record<string, unknown>; return { id: str(s.id, 64), role: roleOf(s.role), createdBy: str(s.createdBy, 64), createdAt: str(s.createdAt, 64), expiresAt: str(s.expiresAt, 64), uses: Number(s.uses) || 0, revoked: s.revoked === true, expired: s.expired === true }; });
}
export function parseLog(data: unknown): { actor: string; action: string; target: string; at: string }[] {
  const list = (data as { log?: unknown } | null)?.log;
  if (!Array.isArray(list)) throw new Error("log: unexpected response");
  return list.slice(0, 200).map((v) => { const s = v as Record<string, unknown>; return { actor: str(s.actor, 64), action: str(s.action, 64), target: str(s.target, 200), at: str(s.at, 64) }; });
}

/** 画面・CLI からの操作 (ホストが performTeamAction で実行する) */
export type TeamAction =
  | { kind: "listTeams" }
  | { kind: "openTeam"; id: string }
  | { kind: "createTeam"; name: string }
  | { kind: "renameTeam"; id: string; name: string }
  | { kind: "deleteTeam"; id: string }
  | { kind: "leaveTeam"; id: string }
  | { kind: "setMember"; id: string; accountId: string; role?: TeamRole; displayName?: string }
  | { kind: "removeMember"; id: string; accountId: string }
  | { kind: "createInvite"; id: string; role: "viewer" | "editor"; expiresInDays?: number }
  | { kind: "revokeInvite"; id: string; inviteId: string }
  | { kind: "teamCheckout"; id: string; seats: number }
  | { kind: "teamSeats"; id: string; seats: number }
  | { kind: "teamPortal"; id: string }
  | { kind: "joinPreview"; token: string }
  | { kind: "joinTeam"; token: string }
  | { kind: "teamDismiss" };

/** ホストが持つチームの状態 (画面に渡す) */
export interface TeamsState {
  busy: boolean; error?: string
  /** 自分のチームの一覧 (listTeams の後) */
  ; list?: TeamSummary[]
  /** 開いているチームの詳細 (openTeam の後。招待とログは admin のときだけ) */
  ; open?: TeamDetail
  /** 作った招待リンク (このときだけ URL が分かる) */
  ; newInvite?: { url: string; role: TeamRole; expiresAt: string }
  /** 申し込み / 契約の管理の URL (teamCheckout / teamPortal の結果) */
  ; link?: { kind: "checkout" | "portal"; url: string }
  /** 招待リンクで参加する流れ (joinPreview / joinTeam) */
  ; join?: { token: string; team?: { teamId: string; name: string; members: number }; role?: TeamRole; alreadyMember?: boolean; joined?: boolean; error?: string }
}

/** 操作の検証 (画面や拡張から来た JSON を、形を確かめてから使う)。合わなければ null */
export function parseTeamAction(o: Record<string, unknown>): TeamAction | null {
  const id = typeof o.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.id) ? o.id : null;
  switch (o.kind) {
    case "listTeams": case "teamDismiss": return { kind: o.kind };
    case "openTeam": case "deleteTeam": case "leaveTeam": case "teamPortal": return id ? { kind: o.kind, id } : null;
    case "createTeam": return typeof o.name === "string" && o.name.trim().length > 0 && o.name.length <= 64 ? { kind: "createTeam", name: o.name.trim() } : null;
    case "renameTeam": return id && typeof o.name === "string" && o.name.trim().length > 0 && o.name.length <= 64 ? { kind: "renameTeam", id, name: o.name.trim() } : null;
    case "setMember": return id && typeof o.accountId === "string" && o.accountId.length <= 64 && (o.role === undefined || ROLES.has(o.role as string)) && (o.displayName === undefined || (typeof o.displayName === "string" && o.displayName.length <= 64))
      ? { kind: "setMember", id, accountId: o.accountId, ...(o.role !== undefined ? { role: o.role as TeamRole } : {}), ...(typeof o.displayName === "string" ? { displayName: o.displayName } : {}) } : null;
    case "removeMember": return id && typeof o.accountId === "string" && o.accountId.length <= 64 ? { kind: "removeMember", id, accountId: o.accountId } : null;
    case "createInvite": return id && (o.role === "viewer" || o.role === "editor") && (o.expiresInDays === undefined || (typeof o.expiresInDays === "number" && o.expiresInDays >= 1 && o.expiresInDays <= 30))
      ? { kind: "createInvite", id, role: o.role, ...(typeof o.expiresInDays === "number" ? { expiresInDays: o.expiresInDays } : {}) } : null;
    case "revokeInvite": return id && typeof o.inviteId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(o.inviteId) ? { kind: "revokeInvite", id, inviteId: o.inviteId } : null;
    case "teamCheckout": case "teamSeats": return id && typeof o.seats === "number" && Number.isInteger(o.seats) && o.seats >= 1 && o.seats <= 100 ? { kind: o.kind, id, seats: o.seats } : null;
    case "joinPreview": case "joinTeam": return typeof o.token === "string" && /^bgi_[A-Za-z0-9_.-]{1,160}$/.test(o.token) ? { kind: o.kind, token: o.token } : null;
    default: return null;
  }
}

/**
 * 操作を実行して、チームの状態を進める (ホスト共通。通信の仕方 = doFetch は、Node は Bearer、ブラウザは Cookie)
 * Input : doFetch = 送り先の root を基点にした fetch (経路だけ渡す。認証のヘッダは呼び出し側が付ける), state = 今の状態, action
 * Output: 次の状態 (失敗は error に文を入れて返す。例外は投げない)
 */
export async function performTeamAction(doFetch: (path: string, init?: RequestInit) => Promise<Response>, state: TeamsState, action: TeamAction, t: (key: string, vars?: Record<string, string>) => string): Promise<TeamsState> {
  const next: TeamsState = { ...state, busy: false, error: undefined };
  const jsonInit = (method: string, body?: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const fail = (what: string, res: Response, body: Record<string, unknown>): TeamsState => {
    const code = typeof body.code === "string" ? body.code : "";
    const reason = res.status === 402 ? t("有料プランの契約が必要です") : res.status === 403 ? t("この操作には管理者の権限が要ります") : res.status === 404 ? t("見つかりません (チームが消えたか、メンバーではありません)")
      : code === "full" ? t("メンバーの上限 ({n} 人) に達しています。契約の人数を増やしてください", { n: String(body.limit ?? "") })
      : code === "last-admin" ? t("最後の管理者は抜けられません。先に別のメンバーを管理者にしてください")
      : code === "too-many" ? t("作れるチームの数の上限です")
      : code === "too-few-seats" ? t("人数は今のメンバー数 ({n} 人) 以上にしてください", { n: String(body.members ?? "") })
      : code === "already-subscribed" ? t("すでに契約があります。契約の管理から変更してください")
      : code === "no-subscription" ? t("このチームには契約がありません")
      : t("サーバーの応答: {status}", { status: String(res.status) });
    return { ...next, error: `${what}: ${reason}` };
  };
  const detail = async (id: string, role: TeamRole | null): Promise<TeamDetail> => {
    const res = await doFetch(`/v1/teams/${encodeURIComponent(id)}`);
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error("team"), { res, body });
    const d = parseTeamDetail(body);
    if ((role ?? d.role) === "admin") {
      const [inv, log] = await Promise.all([doFetch(`/v1/teams/${encodeURIComponent(id)}/invites`), doFetch(`/v1/teams/${encodeURIComponent(id)}/log`)]);
      if (inv.ok) d.invites = parseInvites(await inv.json());
      if (log.ok) d.log = parseLog(await log.json());
    }
    return d;
  };
  const refreshList = async (): Promise<void> => { const res = await doFetch("/v1/teams"); if (res.ok) next.list = parseTeams(await res.json()); };
  try {
    switch (action.kind) {
      case "teamDismiss": next.newInvite = undefined; next.link = undefined; next.join = undefined; next.open = undefined; return next;
      case "listTeams": { const res = await doFetch("/v1/teams"); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("チームの一覧"), res, body); next.list = parseTeams(body); return next; }
      case "openTeam": next.open = await detail(action.id, null); next.newInvite = undefined; next.link = undefined; return next;
      case "createTeam": { const res = await doFetch("/v1/teams", jsonInit("POST", { name: action.name })); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("チームを作る"), res, body); await refreshList(); const id = ((body.team ?? {}) as { teamId?: string }).teamId; if (id) next.open = await detail(id, "admin"); return next; }
      case "renameTeam": { const res = await doFetch(`/v1/teams/${encodeURIComponent(action.id)}`, jsonInit("PATCH", { name: action.name })); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("名前の変更"), res, body); await refreshList(); next.open = await detail(action.id, null); return next; }
      case "deleteTeam": { const res = await doFetch(`/v1/teams/${encodeURIComponent(action.id)}`, { method: "DELETE" }); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("チームの削除"), res, body); await refreshList(); next.open = undefined; return next; }
      case "leaveTeam": case "removeMember": {
        const who = action.kind === "leaveTeam" ? "me" : action.accountId;
        const res = await doFetch(`/v1/teams/${encodeURIComponent(action.id)}/members/${encodeURIComponent(who)}`, { method: "DELETE" });
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (!res.ok) return fail(action.kind === "leaveTeam" ? t("離脱") : t("メンバーを外す"), res, body);
        await refreshList();
        next.open = action.kind === "leaveTeam" ? undefined : await detail(action.id, null);
        return next;
      }
      case "setMember": { const res = await doFetch(`/v1/teams/${encodeURIComponent(action.id)}/members/${encodeURIComponent(action.accountId)}`, jsonInit("PATCH", { ...(action.role ? { role: action.role } : {}), ...(action.displayName !== undefined ? { displayName: action.displayName } : {}) })); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("メンバーの変更"), res, body); next.open = await detail(action.id, null); return next; }
      case "createInvite": { const res = await doFetch(`/v1/teams/${encodeURIComponent(action.id)}/invites`, jsonInit("POST", { role: action.role, ...(action.expiresInDays ? { expiresInDays: action.expiresInDays } : {}) })); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("招待リンク"), res, body); next.newInvite = { url: str(body.url, 512), role: roleOf(body.role), expiresAt: str(body.expiresAt, 64) }; next.open = await detail(action.id, "admin"); return next; }
      case "revokeInvite": { const res = await doFetch(`/v1/teams/${encodeURIComponent(action.id)}/invites/${encodeURIComponent(action.inviteId)}`, { method: "DELETE" }); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("招待の失効"), res, body); next.open = await detail(action.id, "admin"); return next; }
      case "teamCheckout": { const res = await doFetch("/v1/billing/checkout", jsonInit("POST", { plan: "team", seats: action.seats, teamId: action.id })); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok || typeof body.url !== "string") return fail(t("申し込み"), res, body); next.link = { kind: "checkout", url: body.url }; return next; }
      case "teamPortal": { const res = await doFetch("/v1/billing/portal", jsonInit("POST", {})); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok || typeof body.url !== "string") return fail(t("契約の管理"), res, body); next.link = { kind: "portal", url: body.url }; return next; }
      case "teamSeats": { const res = await doFetch("/v1/billing/seats", jsonInit("POST", { teamId: action.id, seats: action.seats })); const body = await res.json().catch(() => ({})) as Record<string, unknown>; if (!res.ok) return fail(t("人数の変更"), res, body); next.open = await detail(action.id, "admin"); return next; }
      case "joinPreview": case "joinTeam": {
        const res = await doFetch(`/v1/join/${encodeURIComponent(action.token)}`, action.kind === "joinTeam" ? { method: "POST" } : {});
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        if (!res.ok) { next.join = { token: action.token, error: res.status === 404 ? t("この招待リンクは使えません (失効・期限切れ・チームが消えた)") : fail(t("参加"), res, body).error }; return next; }
        const team = (body.team ?? {}) as Record<string, unknown>;
        next.join = { token: action.token, team: { teamId: str(team.teamId, 64), name: str(team.name, 64), members: Array.isArray(team.members) ? team.members.length : Number(team.members) || 0 }, role: roleOf(body.role), alreadyMember: body.alreadyMember === true, joined: body.joined === true };
        if (action.kind === "joinTeam") await refreshList();
        return next;
      }
    }
  } catch (e) {
    const err = e as { res?: Response; body?: Record<string, unknown> };
    if (err.res && err.body) return fail(t("チーム"), err.res, err.body);
    return { ...next, error: t("サーバーと通信できませんでした") + ` (${e instanceof Error ? e.message : String(e)})` };
  }
}
