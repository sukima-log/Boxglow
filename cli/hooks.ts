/**
 * AI エージェントのフック (Claude Code / Codex の hooks から呼ばれる `boxglow hook <event>`)
 *   利用者が仕組みを知らなくても、setup-agent が hooks の設定を入れ、エージェントが自動で正しい手順を踏むようにする:
 *   - session-start: セッションの開始・再開・圧縮の後に、計画の再開の概要 (resume) を文脈として注入する
 *   - stop: エージェントが応答を終えるとき、自分が作業中にしたボックスに記録 (checkpoint / log / done) が無ければ、記録してから終わるよう続行を指示する
 *   - pre-tool: boxglow.json を直接編集する操作 (Edit / Write / apply_patch) を止め、CLI か MCP を使うよう伝える
 *   どのフックも、失敗したときはエージェントを止めない (出力なし・終了コード 0)。
 *   出力の形は Claude Code と Codex の両方で通る形にそろえる (Stop: { decision: "block", reason }、PreToolUse: decision + hookSpecificOutput.permissionDecision)
 */
import { resumeReport } from "../src/model/resume";
import type { Project } from "../src/model/types";
import { t } from "../src/i18n/core";

export type HookEvent = "session-start" | "stop" | "pre-tool";

/** フックの入力 (stdin の JSON のうち、使う項目だけ) */
export interface HookInput {
  hook_event_name?: string;
  stop_hook_active?: boolean;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  source?: string;
}

/** フックの出力。stdout = そのまま出す文字列 (空なら出さない)、exitCode = 終了コード */
export interface HookOutput { stdout: string; exitCode: number }

/**
 * stdin の JSON を読む。JSON でなければ空の入力として扱う (フックは失敗させない)
 * Input : text = stdin の中身 (無ければ "")。Output: HookInput
 */
export function parseHookInput(text: string): HookInput {
  if (!text.trim()) return {};
  try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as HookInput : {}; } catch { return {}; }
}

/**
 * 記録者 (actor) が今作業中にしているのに、始めてから記録を残していないボックスを探す
 *   「記録」= そのボックスの引き継ぎメモ (handoffs) か作業記録 (log) が、作業を始めた時刻より後に、同じ記録者で付いたもの
 * Input : p = 計画, actor = 記録者 ("claude-code" など。サブエージェントの "claude-code-xxx" は先頭一致で同じ扱い)
 * Output: 記録の無い作業中のボックスの一覧 (key と題名)
 */
export function unrecordedWork(p: Project, actor: string): { key: string; title: string }[] {
  const mine = (by: string) => by === actor || by.startsWith(actor + "-") || by.startsWith(actor + ":");
  const out: { key: string; title: string }[] = [];
  for (const b of Object.values(p.blocks)) {
    const a = b.activity;
    if (!a || a.state !== "working" || !mine(a.actor) || b.status === "white") continue;
    const since = Date.parse(a.since) || 0;
    const handoff = p.handoffs?.[b.id];
    const recorded = (handoff && mine(handoff.actor) && Date.parse(handoff.at) >= since)
      || (b.log ?? []).some((l) => mine(l.by) && Date.parse(l.at) >= since);
    if (!recorded) out.push({ key: b.key ?? b.id, title: b.title });
  }
  return out;
}

/**
 * ツールの入力が boxglow.json を直接書き換えるものか
 *   Claude Code: Edit / Write / MultiEdit / NotebookEdit の file_path。Codex: apply_patch の patch 本文の "*** Update File: <path>" / "*** Add File:"
 * Input : toolName, toolInput。Output: 止めるべきなら true
 */
export function editsPlanFile(toolName: string | undefined, toolInput: Record<string, unknown> | undefined): boolean {
  if (!toolName || !toolInput) return false;
  const isPlan = (path: unknown) => typeof path === "string" && /(^|[\\/])boxglow\.json$/.test(path.trim());
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) return isPlan(toolInput.file_path) || isPlan(toolInput.path) || isPlan(toolInput.notebook_path);
  if (/^apply_patch$/i.test(toolName)) {
    const patch = typeof toolInput.patch === "string" ? toolInput.patch : typeof toolInput.input === "string" ? toolInput.input : "";
    return /^\*\*\* (Update|Add|Delete) File: .*boxglow\.json\s*$/m.test(patch);
  }
  return false;
}

/**
 * フックの本体
 * Input : event = どのフックか, input = stdin の JSON, p = 計画 (読めなければ null), actor = 記録者
 * Output: HookOutput
 */
export function runHook(event: HookEvent, input: HookInput, p: Project | null, actor: string): HookOutput {
  switch (event) {
    case "session-start": {
      if (!p) return { stdout: "", exitCode: 0 };
      // 開始・再開・圧縮の後に、計画の再開の概要を文脈として出す (両エージェントとも、SessionStart の stdout は文脈に加わる)
      const head = t("Boxglow: このリポジトリの計画 (boxglow.json) の再開の概要。作業の前に `npx boxglow context <ボックス>` を読み、記録は CLI か MCP で行う (ファイルを直接編集しない)。");
      return { stdout: head + "\n\n" + resumeReport(p) + "\n", exitCode: 0 };
    }
    case "stop": {
      // 2 回目 (続行の指示の後) は止めない (無限ループを防ぐ)
      if (!p || input.stop_hook_active) return { stdout: "", exitCode: 0 };
      const missing = unrecordedWork(p, actor);
      if (missing.length === 0) return { stdout: "", exitCode: 0 };
      const list = missing.map((m) => `${m.key} ${m.title}`).join(", ");
      const reason = t("Boxglow: 作業中にしたボックスに記録がありません: {list}。終わる前に、完了なら `npx boxglow done <ボックス> --artifact \"<名前>=<パス>\" --checked \"<実行した検査と結果>\"`、続きがあるなら `npx boxglow checkpoint <ボックス> --note \"分かったこと; 次にすること; 未解決のこと\"`、どちらでもなければ `npx boxglow log <ボックス> \"<今の状況>\"` を実行する (guard が有効なら --context-token を付ける)。", { list });
      return { stdout: JSON.stringify({ decision: "block", reason }) + "\n", exitCode: 0 };
    }
    case "pre-tool": {
      if (!editsPlanFile(input.tool_name, input.tool_input)) return { stdout: "", exitCode: 0 };
      const reason = t("Boxglow: boxglow.json は直接編集しない (結線の規則と履歴、確認トークンが壊れる)。`npx boxglow` の CLI か MCP のツール (boxglow_add / boxglow_set / boxglow_done など) で更新する。");
      return { stdout: JSON.stringify({ decision: "block", reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n", exitCode: 0 };
    }
    default:
      return { stdout: "", exitCode: 0 };
  }
}
