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
 * TOML の 1 行を文字ごとに読み、コメントと文字列を見分ける
 *   - 文字列 (基本 "..."、リテラル '...'、複数行の 3 つ引用符) の中身は code に含めない (引用符は残す)。# はコメントの始まり (文字列の中は除く)
 *   - 基本文字列のエスケープ (\" など) を解釈して、閉じる位置を間違えない
 * Input : raw = 1 行, multi = 行の始めに複数行の文字列の中にいればその区切り
 * Output: { code = コメントと文字列の中身を除いた本文 (キーの判定に使う), kept = コメントだけを除いた本文 (見出しの判定に使う。引用符付きのキーを元の文字で読む),
 *          multi = 行の終わりの状態, inString = 行の始めが文字列の中だったか }
 */
function readTomlLine(raw: string, multi: '"""' | "'''" | null): { code: string; kept: string; multi: '"""' | "'''" | null; inString: boolean } {
  const inString = multi !== null;
  let code = "", kept = "";
  let i = 0;
  while (i < raw.length) {
    if (multi !== null) {
      // 複数行の文字列の中: 閉じる区切りを探す (基本文字列はエスケープを飛ばす)
      let j = i;
      while (j < raw.length && !raw.startsWith(multi, j)) { if (multi === '"""' && raw[j] === "\\") j++; j++; }
      if (j >= raw.length) { kept += raw.slice(i); return { code, kept, multi, inString }; }   // この行では閉じない
      kept += raw.slice(i, j + 3); i = j + 3; multi = null; code += '""';                        // (閉じた。値としては空の文字列の印だけ残す)
      continue;
    }
    const ch = raw[i];
    if (ch === "#") break;                                    // コメント: 行の残りは本文ではない
    if (raw.startsWith('"""', i) || raw.startsWith("'''", i)) { multi = raw.slice(i, i + 3) as '"""' | "'''"; kept += multi; i += 3; continue; }
    if (ch === '"' || ch === "'") {
      // 1 行の文字列: code には引用符だけ、kept には中身も残す
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) { if (ch === '"' && raw[j] === "\\") j++; j++; }
      const endAt = Math.min(j + 1, raw.length);
      code += ch + ch; kept += raw.slice(i, endAt); i = endAt; continue;
    }
    code += ch; kept += ch; i++;
  }
  return { code, kept, multi, inString };
}

/**
 * TOML の表の見出し行 ([a.b] / [[a.b]]) を、正規化した名前 ("a.b") にする
 *   引用符付きのキー ([mcp_servers."boxglow"])・見出しの中や前後の空白も同じ表として扱う (コメントは readTomlLine が先に除く)
 * Input : line = コメントを除いた 1 行 (引用符付きのキーは中身を含む)。Output: 表の名前。見出しでなければ null
 */
function tomlHeader(line: string): string | null {
  const m = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*$/.exec(line);
  if (!m) return null;
  return m[1].split(".").map((k) => k.trim().replace(/^(["'])(.*)\1$/, "$2")).join(".");
}

/**
 * config.toml を行ごとに読み、各行が「どの表の見出しか」を出す (扱える範囲を限った読み取り。TOML の構文解析の代わりではない)
 *   - コメントと文字列 (1 行・複数行) を見分ける。文字列の中やコメントの中の [mcp_servers.boxglow] は見出しではない
 *   - 次の形は、置き換えると二重定義や取り違えになるので例外にする (呼び出し側は書き戻さず、手で置く手順を出す):
 *       見出しにエスケープ (\) がある / ルートに mcp_servers = ... や mcp_servers.boxglow... のキーがある / [mcp_servers] の表の中に boxglow のキーがある
 * Input : text = ファイルの中身。Output: { lines, headers } (headers[i] = i 行目の表の名前、見出しでなければ null)
 */
function scanCodexConfig(text: string): { lines: string[]; headers: (string | null)[] } {
  const lines = text.split("\n");
  const headers: (string | null)[] = [];
  let multi: '"""' | "'''" | null = null;   // 複数行の文字列の中にいるか (その区切り)
  let table: string | null = null;          // 今いる表 (null = ルート)
  for (const raw of lines) {
    const r = readTomlLine(raw, multi);
    multi = r.multi;
    if (r.inString) { headers.push(null); continue; }        // 行の始めが文字列の中: 見出しにならない
    // 見出しの判定は、コメントを除いた本文で行う (引用符付きのキーは元の文字で読む)
    const h = tomlHeader(r.kept);
    if (h !== null) {
      if (r.kept.includes("\\")) throw new Error("config.toml has an escaped table key; replace the Boxglow entry by hand");
      headers.push(h); table = h; continue;
    }
    headers.push(null);
    if (table === null && /^\s*(["']?)mcp_servers\1\s*[.=]/.test(r.code)) throw new Error("config.toml defines mcp_servers as a value at the top level; replace the Boxglow entry by hand");
    if (table === "mcp_servers" && /^\s*(["']?)boxglow\1\s*[.=]/.test(r.code)) throw new Error("config.toml defines boxglow inline under [mcp_servers]; replace it by hand");
  }
  return { lines, headers };
}

/** 表の見出しの集まり (名前ごとの数)。Boxglow 以外の表が併合で失われていないことの確認に使う */
function headerCounts(headers: (string | null)[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of headers) if (h !== null && h !== "mcp_servers.boxglow" && !h.startsWith("mcp_servers.boxglow.")) m.set(h, (m.get(h) ?? 0) + 1);
  return m;
}

/**
 * 既存の ~/.codex/config.toml に [mcp_servers.boxglow] を足す / 置き換える (その表の行だけを差し替え、ほかは残す)
 *   - 見出しにコメントや引用符が付いていても同じ表と見なす (気づかずに 2 つ目を足すと、Codex が設定を読めなくなる。Codex レビュー 29 R29-01)
 *   - boxglow の表の下の子の表 ([mcp_servers.boxglow.http_headers] など) も、まとめて置き換える
 *   - コメントや文字列の中の見出しは無視する。同じ表が 2 つある / ルートの値やインラインで定義してある / 見出しにエスケープがある /
 *     置き換えた結果に表が 1 つにならない、Boxglow 以外の表が減る、のどれかなら書き戻さずに例外 (呼び出し側が「設定ファイルを書けませんでした (理由)」と手で置く手順を出す)
 *   - TOML の構文全体を検証するものではない
 * Input : existing = 今のファイルの中身 (無ければ null)。Output: 書き戻す中身
 */
export function mergeCodexConfig(existing: string | null, server: string, token: string): string {
  const block = codexConfig(server, token);
  const text = existing ?? "";
  const { lines, headers } = scanCodexConfig(text);
  const starts = headers.flatMap((h, i) => h === "mcp_servers.boxglow" ? [i] : []);
  if (starts.length > 1) throw new Error("config.toml has [mcp_servers.boxglow] more than once; the file was not changed");
  const start = starts[0] ?? -1;
  let merged: string;
  if (start < 0) merged = text.trim() ? text.replace(/\s*$/, "\n\n") + block : block;
  else {
    // 次の表 ([...]) の手前までが boxglow の表。boxglow の子の表 (mcp_servers.boxglow.*) はその中身ごと含める
    let end = start + 1;
    while (end < lines.length && (headers[end] === null || headers[end]!.startsWith("mcp_servers.boxglow."))) end++;
    merged = [...lines.slice(0, start), ...block.trimEnd().split("\n"), ...lines.slice(end)].join("\n").replace(/\n*$/, "\n");
  }
  // 書き戻す前に確かめる: 同じ読み方で、boxglow の表が 1 つだけ・子の表が残っていない・Boxglow 以外の表がそのまま
  const after = scanCodexConfig(merged).headers;
  const before = headerCounts(headers), kept = headerCounts(after);
  const same = before.size === kept.size && [...before].every(([k, n]) => kept.get(k) === n);
  if (!same || after.filter((h) => h === "mcp_servers.boxglow").length !== 1 || after.some((h) => h !== null && h.startsWith("mcp_servers.boxglow."))) {
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
