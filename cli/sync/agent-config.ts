/**
 * AI エージェントの設定ファイルを手元に書く (ホスト型の MCP への接続。serve / VS Code / CLI 共通)
 *   - Claude Code: <計画のフォルダ>/.mcp.json に boxglow (http) の項目を足す。トークンを含むので .gitignore があれば .mcp.json を足す
 *   - Codex: ~/.codex/config.toml に [mcp_servers.boxglow] を足す
 * Input : target, server, token, dir = 計画のフォルダ (Claude Code のとき)。Output: 書いた場所と、.gitignore で守られているか
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gitignoreWithMcpJson, mergeMcpJson, type AgentTarget } from "../../src/sync/agent";
import { mergeCodexConfig } from "../../src/sync/codex-config";

export function writeAgentConfig(target: AgentTarget, server: string, token: string, dir: string): { path: string; gitignored: boolean } {
  if (target === "codex") {
    const path = join(homedir(), ".codex", "config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, mergeCodexConfig(existsSync(path) ? readFileSync(path, "utf8") : null, server, token), { mode: 0o600 });
    return { path, gitignored: true };
  }
  const path = join(dir, ".mcp.json");
  writeFileSync(path, mergeMcpJson(existsSync(path) ? readFileSync(path, "utf8") : null, server, token));
  // .gitignore があるフォルダ (= git で管理している可能性が高い) では、トークン入りの .mcp.json をコミットしないよう足す
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) return { path, gitignored: false };
  const next = gitignoreWithMcpJson(readFileSync(gi, "utf8"));
  if (next !== null) writeFileSync(gi, next);
  return { path, gitignored: true };
}
