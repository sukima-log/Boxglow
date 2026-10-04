/**
 * setup-agent の本体: AI エージェント側の設定を 1 回で入れる
 * (指示書 AGENTS.md / CLAUDE.md への追記、スキル、Claude Code のフックと .mcp.json)
 * 何度実行しても同じ結果になるよう、指示書は印 (boxglow:begin 〜 boxglow:end) の間だけを書き換える。
 * 既存の設定ファイルが壊れているときは、何も書かずにエラーにする (利用者の設定を黙って捨てない)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
// 文言を今の言語 (日本語 / 英語) で出す
import { t } from "../src/i18n/core";

/**
 * JSON の設定ファイルをオブジェクトとして読む
 * Input : path = 設定ファイルのパス
 * Output: 中身のオブジェクト (ファイルが無ければ {})。JSON として読めない・オブジェクトでないときは例外
 */
function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("設定の形が正しくありません: {where}", { where: path }));
  return value as Record<string, unknown>;
}

/**
 * 設定の中の 1 項目をオブジェクトとして取り出す
 * Input : value = 取り出した値, label = エラーに出す項目名
 * Output: オブジェクト (undefined なら {})。オブジェクトでないときは例外
 */
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(t("設定の形が正しくありません: {where}", { where: label }));
  return value as Record<string, unknown>;
}

/**
 * 選んだエージェントの分だけ設定ファイルを作る / 更新する。書く前に既存の設定をすべて検査する (途中まで書いて失敗しない)
 * Input : root = 置き場 (リポジトリの直下), agent = "codex" | "claude-code" | "all",
 *         snippet = 指示書 (AGENTS_SNIPPET の文章), skill = スキル (SKILL.md の文章)
 * Output: 書き換えたファイルの相対パスの一覧 (変更が無ければ「変更なし」の 1 件)
 */
export function setupAgent(opts: { root: string; agent: string; snippet: string; skill: string }): string[] {
  const { root, agent, snippet, skill } = opts;
  if (!["all", "codex", "claude-code"].includes(agent)) throw new Error(t("--agent は codex | claude-code | all のいずれかを指定してください"));
  const codex = agent !== "claude-code";
  const claude = agent !== "codex";
  // 書く内容を先にすべて作る (相対パス → 中身)。検査が全部通ってから最後にまとめて書く
  const files = new Map<string, string>();
  const BEGIN = "<!-- boxglow:begin -->";
  const END = "<!-- boxglow:end -->";
  // 同梱の指示書は前置きが付いているので、「---」で挟まれた本文だけを貼る
  const parts = snippet.split(/^---$/m);
  const body = (parts.length >= 3 ? parts.slice(1, -1).join("---") : snippet).trim();
  const block = `${BEGIN}\n${body}\n${END}\n`;
  // 既定 (all) は今までどおり両方の指示書に書く。Codex だけ・Claude Code だけも選べる
  for (const name of [...(codex ? ["AGENTS.md"] : []), ...(claude ? ["CLAUDE.md"] : [])]) {
    const path = join(root, name);
    const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
    const begin = cur.indexOf(BEGIN);
    const end = cur.indexOf(END);
    // 印が片方だけ・順番が逆のときは、どこを書き換えるか決められないので止める
    if ((begin < 0) !== (end < 0) || (begin >= 0 && end < begin)) throw new Error(t("Boxglow の印 (boxglow:begin / boxglow:end) が正しく対になっていません: {path}", { path }));
    // 印があればその間だけを入れ替え、無ければ末尾に足す (利用者が書いた部分は残す)
    files.set(name, begin >= 0 ? cur.slice(0, begin) + block + cur.slice(end + END.length).replace(/^\r?\n/, "") : (cur ? cur.replace(/\s*$/, "\n\n") : "") + block);
  }
  // Codex のスキル (記録者の名前の例を codex に置き換える)
  if (codex) files.set(".agents/skills/boxglow/SKILL.md", skill.replaceAll("--by claude-code", "--by codex"));
  if (claude) {
    // Claude Code のスキル
    files.set(".claude/skills/boxglow/SKILL.md", skill);
    // セッション開始時に計画を読むフック (Claude Code の settings.json に追記。他の設定は残す)
    const settings = readObject(join(root, ".claude/settings.json"));
    const hooks = object(settings.hooks, "hooks");
    const start = hooks.SessionStart ?? [];
    if (!Array.isArray(start)) throw new Error(t("設定の形が正しくありません: {where}", { where: "hooks.SessionStart" }));
    const command = "npx boxglow status";
    const exists = start.some((h: unknown) => {
      const entry = object(h, "SessionStart entry");
      if (entry.hooks !== undefined && !Array.isArray(entry.hooks)) throw new Error(t("設定の形が正しくありません: {where}", { where: "SessionStart hooks" }));
      return (entry.hooks as unknown[] | undefined ?? []).some((x) => object(x, "hook").command === command);
    });
    if (!exists) {
      hooks.SessionStart = [...start, { hooks: [{ type: "command", command }] }];
      settings.hooks = hooks;
      files.set(".claude/settings.json", JSON.stringify(settings, null, 2) + "\n");
    }
    // MCP サーバの登録 (Claude Code はプロジェクトの .mcp.json を読む。他のサーバの設定は残す)
    const mcp = readObject(join(root, ".mcp.json"));
    const servers = object(mcp.mcpServers, "mcpServers");
    if (!servers.boxglow) {
      servers.boxglow = { command: "npx", args: ["-y", "boxglow", "mcp"] };
      mcp.mcpServers = servers;
      files.set(".mcp.json", JSON.stringify(mcp, null, 2) + "\n");
    }
  }
  // 中身が変わるファイルだけを書く (同じなら触らない = 何度実行しても同じ結果)
  const changed: string[] = [];
  for (const [name, text] of files) {
    const path = join(root, name);
    if (existsSync(path) && readFileSync(path, "utf8") === text) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
    changed.push(name);
  }
  return changed.length ? changed : [t("変更なし")];
}
