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
 * TOML の表の見出し行 ([a.b] / [[a.b]]) を、正規化した名前 ("a.b") にする
 *   引用符付きのキー ([mcp_servers."boxglow"])・見出しの中や前後の空白・末尾のコメント (# ...) も同じ表として扱う
 * Input : line = 1 行。Output: 表の名前。見出しでなければ null
 */
function tomlHeader(line: string): string | null {
  const m = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  if (!m) return null;
  return m[1].split(".").map((k) => k.trim().replace(/^(["'])(.*)\1$/, "$2")).join(".");
}

/**
 * 既存の ~/.codex/config.toml に [mcp_servers.boxglow] を足す / 置き換える (その表の行だけを差し替え、ほかは残す)
 *   - 見出しにコメントや引用符が付いていても同じ表と見なす (気づかずに 2 つ目を足すと、Codex が設定を読めなくなる。Codex レビュー 29 R29-01)
 *   - boxglow の表の下の子の表 ([mcp_servers.boxglow.http_headers] など) も、まとめて置き換える
 *   - 同じ表が 2 つある、[mcp_servers] の中に boxglow = { ... } と書いてある、置き換えた結果に表が 1 つにならない、のどれかなら
 *     書き戻さずに例外 (呼び出し側が「設定ファイルを書けませんでした (理由)」と手で置く手順を出す)
 * Input : existing = 今のファイルの中身 (無ければ null)。Output: 書き戻す中身
 */
export function mergeCodexConfig(existing: string | null, server: string, token: string): string {
  const block = codexConfig(server, token);
  const text = existing ?? "";
  const lines = text.split("\n");
  const headers = lines.map(tomlHeader);
  const starts = headers.flatMap((h, i) => h === "mcp_servers.boxglow" ? [i] : []);
  if (starts.length > 1) throw new Error("config.toml has [mcp_servers.boxglow] more than once; the file was not changed");
  // [mcp_servers] の表の中に boxglow = { ... } (インラインの表) があると、[mcp_servers.boxglow] を足した時点で二重定義になる
  const parentAt = headers.indexOf("mcp_servers");
  if (parentAt >= 0) {
    for (let i = parentAt + 1; i < lines.length && headers[i] === null; i++) {
      if (/^\s*(["']?)boxglow\1\s*=/.test(lines[i])) throw new Error("config.toml defines boxglow inline under [mcp_servers]; replace it by hand");
    }
  }
  const start = starts[0] ?? -1;
  let merged: string;
  if (start < 0) merged = text.trim() ? text.replace(/\s*$/, "\n\n") + block : block;
  else {
    // 次の表 ([...]) の手前までが boxglow の表。boxglow の子の表 (mcp_servers.boxglow.*) はその中身ごと含める
    let end = start + 1;
    while (end < lines.length && (headers[end] === null || headers[end]!.startsWith("mcp_servers.boxglow."))) end++;
    merged = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n").replace(/\n*$/, "\n");
  }
  // 書き戻す前に確かめる: boxglow の表が 1 つだけで、子の表が残っていない
  const after = merged.split("\n").map(tomlHeader);
  if (after.filter((h) => h === "mcp_servers.boxglow").length !== 1 || after.some((h) => h !== null && h.startsWith("mcp_servers.boxglow."))) {
    throw new Error("config.toml could not be merged safely; the file was not changed");
  }
  return merged;
}

/** .gitignore に .mcp.json を足す (トークンを含むので)。既に書いてあれば null (変更なし) */
export function gitignoreWithMcpJson(existing: string): string | null {
  if (existing.split("\n").some((l) => /^\s*\/?\.mcp\.json\s*$/.test(l))) return null;
  return existing.replace(/\s*$/, existing.trim() ? "\n" : "") + "# Claude Code の MCP 設定 (Boxglow のトークンを含む)\n.mcp.json\n";
}

/** Codex の設定 (~/.codex/config.toml に貼る) */
export const codexConfig = (server: string, token: string): string =>
  `[mcp_servers.boxglow]\nurl = "${mcpUrlOf(server)}"\nhttp_headers = { Authorization = "Bearer ${token}" }\n`;
