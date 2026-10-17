/**
 * AI エージェント用トークン (ホスト型の MCP) に関する、ホスト共通の処理
 *   - 一覧の応答の検証 (信頼しない入力として扱う)
 *   - MCP の URL と、Claude Code / Codex に貼る設定の文
 */
export interface AgentTokenEntry { id: string; name: string; projectId: string; write: boolean; createdAt: string; lastUsedAt: string | null; revoked: boolean; requests: number }

/** 一覧の応答を検証する。Output: AgentTokenEntry[] (多くても 100 件)。形が合わなければ例外 */
export function parseAgentTokens(data: unknown): AgentTokenEntry[] {
  const list = (data as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(list) || list.length > 1000) throw new Error("agent-tokens: unexpected response");
  return list.slice(0, 100).map((v) => {
    const s = v as Record<string, unknown>;
    if (typeof s.id !== "string" || typeof s.name !== "string" || typeof s.projectId !== "string") throw new Error("agent-tokens: unexpected entry");
    return { id: s.id.slice(0, 64), name: s.name.slice(0, 64), projectId: s.projectId.slice(0, 256), write: s.write === true, createdAt: typeof s.createdAt === "string" ? s.createdAt : ""
    , lastUsedAt: typeof s.lastUsedAt === "string" ? s.lastUsedAt : null, revoked: s.revoked === true, requests: typeof s.requests === "number" ? s.requests : 0 };
  });
}

/** ホスト型の MCP の URL (送り先のサーバーと同じ場所) */
export const mcpUrlOf = (server: string): string => `${server.replace(/\/$/, "")}/mcp`;

/** Claude Code に登録するコマンド (1 行) */
export const claudeCodeCommand = (server: string, token: string): string =>
  `claude mcp add --transport http boxglow ${mcpUrlOf(server)} --header "Authorization: Bearer ${token}"`;

/** Claude Code の設定ファイル (.mcp.json。作業フォルダの直下に置く。CLI の claude コマンドが無い VS Code 拡張・デスクトップアプリ向け) */
export const claudeCodeMcpJson = (server: string, token: string): string =>
  JSON.stringify({ mcpServers: { boxglow: { type: "http", url: mcpUrlOf(server), headers: { Authorization: `Bearer ${token}` } } } }, null, 2) + "\n";

/** Codex の設定 (~/.codex/config.toml に貼る) */
export const codexConfig = (server: string, token: string): string =>
  `[mcp_servers.boxglow]\nurl = "${mcpUrlOf(server)}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
