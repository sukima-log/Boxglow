/**
 * boxglow agent-token: AI エージェント用トークン (ホスト型の MCP) の一覧・発行・失効 (CLI)
 *   list                              一覧 (秘密は出ない)
 *   create --name <名前> [--write]    今の計画 (結び付け) のトークンを作り、値と Claude Code / Codex の設定を表示する (値はこのときだけ)
 *   connect claude-code|codex [--read-only]   トークンを作り、設定ファイル (Claude Code: 計画のフォルダの .mcp.json / Codex: ~/.codex/config.toml) に書く
 *   revoke <id>                       失効
 * Input : o = { server, out, fetch?, command, name?, write?, id?, projectId }。Output: 終了コード
 */
import { t } from "../../src/i18n/core";
import { claudeCodeCommand, claudeCodeMcpJson, codexConfig, mcpUrlOf, parseAgentTokens, type AgentTarget } from "../../src/sync/agent";
import { writeAgentConfig } from "./agent-config";
import { resolveToken } from "./credentials";
import { serverProblem } from "./login";
import { normalizeServer } from "./state-store";

export interface AgentTokenOptions { server: string; out: (line: string) => void; fetch?: typeof fetch; allowEnvironmentToken?: boolean; command: string; name?: string; write?: boolean; id?: string; projectId?: string; target?: string; dir?: string }

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
    if (o.command === "create" || o.command === "connect") {
      if (!o.projectId) { out(t("この計画はまだサーバーに置かれていません (boxglow sync で結び付けてから)")); return 1; }
      if (o.command === "connect" && o.target !== "claude-code" && o.target !== "codex") { out("boxglow agent-token connect claude-code|codex [--read-only]"); return 1; }
      const target = o.command === "connect" ? (o.target as AgentTarget) : undefined;
      const res = await doFetch(`${server}/v1/agent-tokens`, { method: "POST", headers, redirect: "error", body: JSON.stringify({ name: target ?? o.name ?? "agent", projectId: o.projectId, write: o.write === true }), signal: AbortSignal.timeout(30000) });
      const body = await res.json().catch(() => ({})) as { id?: unknown; token?: unknown; code?: unknown; limit?: unknown };
      if (!res.ok || typeof body.token !== "string") { out(res.status === 409 ? t("エージェント用トークンは {n} 個までです。使わないものを失効させてください", { n: String(body.limit ?? "") }) : res.status === 404 ? t("今サインインしているアカウントには、この計画がサーバー上にありません (別のアカウントで置いた計画かもしれません)。その計画を置いたアカウントでサインインし直すか、このアカウントで計画を置き直してください") : t("トークンを作れませんでした (サーバーの応答: {status})", { status: res.status })); return 1; }
      if (target) {
        // 設定ファイルを書く (トークンは表示しない)
        const written = writeAgentConfig(target, server, body.token, o.dir ?? process.cwd());
        out(target === "codex" ? t("Codex に接続しました") : t("Claude Code に接続しました"));
        out(t("設定を書きました") + ": " + written.path + (target === "claude-code" && written.gitignored ? ` (${t(".gitignore にも追加")})` : ""));
        if (target === "claude-code" && !written.gitignored) out(t("このファイルにはトークンが入るので、共有やコミットをしないでください"));
        out(target === "codex" ? t("Codex を開き直すと、boxglow のツールが使えます") : t("Claude Code を開き直すと、boxglow のツールが使えます。初回に「このプロジェクトの MCP サーバーを使うか」と聞かれたら許可してください"));
        return 0;
      }
      out(t("トークンを作りました。この値は今だけ表示されます (控えてください)。"));
      out(body.token);
      out("");
      out(t("MCP の URL") + ": " + mcpUrlOf(server));
      out("Claude Code: " + claudeCodeCommand(server, body.token));
      out("Claude Code (.mcp.json。作業フォルダの直下。CLI が無いとき):");
      out(claudeCodeMcpJson(server, body.token).trimEnd());
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
