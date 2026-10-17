/**
 * boxglow agent-token: AI エージェント用トークン (ホスト型の MCP) の一覧・発行・失効 (CLI)
 *   list                              一覧 (秘密は出ない)
 *   create --name <名前> [--write]    今の計画 (結び付け) のトークンを作り、値と Claude Code / Codex の設定を表示する (値はこのときだけ)
 *   revoke <id>                       失効
 * Input : o = { server, out, fetch?, command, name?, write?, id?, projectId }。Output: 終了コード
 */
import { t } from "../../src/i18n/core";
import { claudeCodeCommand, codexConfig, mcpUrlOf, parseAgentTokens } from "../../src/sync/agent";
import { resolveToken } from "./credentials";
import { serverProblem } from "./login";
import { normalizeServer } from "./state-store";

export interface AgentTokenOptions { server: string; out: (line: string) => void; fetch?: typeof fetch; allowEnvironmentToken?: boolean; command: string; name?: string; write?: boolean; id?: string; projectId?: string }

export async function runAgentToken(o: AgentTokenOptions): Promise<number> {
  const { out } = o;
  const doFetch = o.fetch ?? fetch;
  const server = normalizeServer(o.server);
  const problem = serverProblem(server);
  if (problem) { out(problem); return 1; }
  const credential = resolveToken(server, o.allowEnvironmentToken);
  if (!credential) { out(t("先にサインインしてください")); return 1; }
  const headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
  try {
    if (o.command === "create") {
      if (!o.projectId) { out(t("この計画はまだサーバーに置かれていません (boxglow sync で結び付けてから)")); return 1; }
      const res = await doFetch(`${server}/v1/agent-tokens`, { method: "POST", headers, redirect: "error", body: JSON.stringify({ name: o.name ?? "agent", projectId: o.projectId, write: o.write === true }), signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => ({})) as { id?: unknown; token?: unknown; code?: unknown; limit?: unknown };
      if (!res.ok || typeof body.token !== "string") { out(res.status === 409 ? t("エージェント用トークンは {n} 個までです。使わないものを失効させてください", { n: String(body.limit ?? "") }) : res.status === 404 ? t("今サインインしているアカウントには、この計画がサーバー上にありません (別のアカウントで置いた計画かもしれません)。その計画を置いたアカウントでサインインし直すか、このアカウントで計画を置き直してください") : t("トークンを作れませんでした (サーバーの応答: {status})", { status: res.status })); return 1; }
      out(t("トークンを作りました。この値は今だけ表示されます (控えてください)。"));
      out(body.token);
      out("");
      out(t("MCP の URL") + ": " + mcpUrlOf(server));
      out("Claude Code: " + claudeCodeCommand(server, body.token));
      out("Codex (~/.codex/config.toml):");
      out(codexConfig(server, body.token).trimEnd());
      return 0;
    }
    if (o.command === "revoke") {
      if (!o.id) { out("boxglow agent-token revoke <id>"); return 1; }
      const res = await doFetch(`${server}/v1/agent-tokens/${encodeURIComponent(o.id)}`, { method: "DELETE", headers, redirect: "error", signal: AbortSignal.timeout(30000) });
      if (!res.ok) { out(t("トークンを失効できませんでした (サーバーの応答: {status})", { status: res.status })); return 1; }
      out(t("失効しました: {id}", { id: o.id }));
      return 0;
    }
    const res = await doFetch(`${server}/v1/agent-tokens`, { headers, redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!res.ok) { out(t("トークンの一覧を読めませんでした (サーバーの応答: {status})", { status: res.status })); return 1; }
    const tokens = parseAgentTokens(await res.json());
    if (tokens.length === 0) { out(t("トークンはまだありません。")); return 0; }
    for (const tk of tokens) out(`${tk.id}  ${tk.name}  ${tk.write ? t("読み書き") : t("読み取り専用")}  ${tk.projectId}  ${t("{n} 回", { n: String(tk.requests) })}${tk.revoked ? "  " + t("失効") : ""}`);
    return 0;
  } catch (e) { out(t("サーバーと通信できませんでした") + ` (${e instanceof Error ? e.message : String(e)})`); return 1; }
}
