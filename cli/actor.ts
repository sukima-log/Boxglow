/** CLIの記録者と同期の表示先が、同じ実行環境を別々に解釈しないための共通判定。 */
import { isHumanActor } from "../src/model/graph";
type Environment = Record<string, string | undefined>;

/** 入力: 表示名。出力: 明示されたAI名か。通常の人の記録者名は推測しない。 */
export const isAgentActor = (actor: string): boolean => /^(?:agent|ai|codex|claude(?:-code)?|copilot|cursor)(?::|-|$)/i.test(actor);

/** 入力: 子プロセスの環境。出力: 実行中のエージェント。設定フォルダだけでは判定しない。 */
export function executionAgent(env: Environment = process.env): string | undefined {
  if (env.CLAUDECODE || env.CLAUDE_CODE) return "claude-code";
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_SANDBOX) return "codex";
  return undefined;
}

/** 入力: 明示actorと環境。出力: ログの記録者。AI実行の印は継承した人名より優先する。 */
export function actorOf(explicit?: string, env: Environment = process.env): string {
  if (explicit) return explicit;
  const named = env.BOXGLOW_ACTOR;
  if (named && isAgentActor(named)) return named;
  return executionAgent(env) ?? named ?? "agent";
}

/**
 * 入力: 環境。出力: 実行中のエージェントのセッションの識別子 (無ければ undefined)。
 *   Claude Code は CLAUDE_CODE_SESSION_ID (公式。Bash の子プロセスと hook の入力の session_id が同じ値。/clear で変わる。常駐の MCP は起動時の値を保つ)。
 *   Codex は CODEX_THREAD_ID / CODEX_SESSION_ID (公式の確約は無いが、codex-cli 0.163 の実機で hook の入力の session_id と同じ値であることを確認 2026-10-18。違う版なら Stop フックは何も止めない = 安全側)。
 *   BOXGLOW_SESSION_ID は明示 (SessionStart フックが Claude Code の CLAUDE_ENV_FILE 経由で後続のシェルに渡す)
 */
export function sessionIdFromEnv(env: Environment = process.env): string | undefined {
  return env.BOXGLOW_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || undefined;
}

/** 入力: 明示actorと環境。出力: 同期の案内先。操作権限は明示actorで別に判定する。 */
export function syncAudienceFor(explicit?: string, env: Environment = process.env): "ai" | "human" {
  if (explicit && isHumanActor(explicit)) return "human";
  if ((explicit && isAgentActor(explicit)) || executionAgent(env) || (env.BOXGLOW_ACTOR && isAgentActor(env.BOXGLOW_ACTOR))) return "ai";
  // 識別のない通常端末は従来どおり人向け。環境のhuman宣言でAIの印を上書きしない。
  return "human";
}
