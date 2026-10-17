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

/** 接続先のエージェント (設定ファイルを書く相手) */
export type AgentTarget = "claude-code" | "codex";

/**
 * 既存の .mcp.json に boxglow (ホスト型) の項目を足す / 置き換える。ほかのサーバーの設定は残す
 * Input : existing = 今のファイルの中身 (無ければ null), server, token。Output: 書き戻す中身。形が JSON のオブジェクトでなければ例外
 */
export function mergeMcpJson(existing: string | null, server: string, token: string): string {
  const value: unknown = existing && existing.trim() ? JSON.parse(existing) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(".mcp.json is not an object");
  const root = value as Record<string, unknown>;
  const servers = root.mcpServers === undefined ? {} : root.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error(".mcp.json: mcpServers is not an object");
  (servers as Record<string, unknown>).boxglow = { type: "http", url: mcpUrlOf(server), headers: { Authorization: `Bearer ${token}` } };
  root.mcpServers = servers;
  return JSON.stringify(root, null, 2) + "\n";
}

/**
 * 既存の ~/.codex/config.toml に [mcp_servers.boxglow] を足す / 置き換える (その表の行だけを差し替え、ほかは残す)
 * Input : existing = 今のファイルの中身 (無ければ null)。Output: 書き戻す中身
 */
export function mergeCodexConfig(existing: string | null, server: string, token: string): string {
  const block = codexConfig(server, token);
  const text = existing ?? "";
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.boxglow\]\s*$/.test(l));
  if (start < 0) return text.trim() ? text.replace(/\s*$/, "\n\n") + block : block;
  // 次の表 ([...]) の手前までが boxglow の表
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n").replace(/\n*$/, "\n");
}

/** .gitignore に .mcp.json を足す (トークンを含むので)。既に書いてあれば null (変更なし) */
export function gitignoreWithMcpJson(existing: string): string | null {
  if (existing.split("\n").some((l) => /^\s*\/?\.mcp\.json\s*$/.test(l))) return null;
  return existing.replace(/\s*$/, existing.trim() ? "\n" : "") + "# Claude Code の MCP 設定 (Boxglow のトークンを含む)\n.mcp.json\n";
}

/** Codex の設定 (~/.codex/config.toml に貼る) */
export const codexConfig = (server: string, token: string): string =>
  `[mcp_servers.boxglow]\nurl = "${mcpUrlOf(server)}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
