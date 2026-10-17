/**
 * setup-agent の本体: AI エージェント側の設定を 1 回で入れる (利用者が仕組みを知らなくても、エージェントが自動で正しい手順を踏むように)
 *   Claude Code: CLAUDE.md (印の間)、.claude/skills/boxglow/SKILL.md、.claude/settings.json (hooks・CLI の許可・.mcp.json の自動承認)、
 *                .claude/agents/boxglow-review.md (レビュー用のサブエージェント)、.mcp.json (手元の MCP サーバ)
 *   Codex      : AGENTS.md (印の間)、.agents/skills/boxglow/SKILL.md + agents/openai.yaml (MCP への依存)、.codex/config.toml (MCP サーバ)、
 *                .codex/hooks.json (hooks)、.codex/agents/boxglow-review.toml (レビュー用のサブエージェント)
 *   hooks は `boxglow hook <event>` を呼ぶ: session-start (再開の概要を注入) / stop (記録の無い作業中の箱があれば続行を指示) / pre-tool (boxglow.json の直接編集を止める)
 * 何度実行しても同じ結果になるよう、指示書は印 (boxglow:begin 〜 boxglow:end) の間だけを書き換え、設定ファイルは自分の項目だけを足す。
 * 既存の設定ファイルが壊れているときは、何も書かずにエラーにする (利用者の設定を黙って捨てない)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
// 文言を今の言語 (日本語 / 英語) で出す
import { t } from "../src/i18n/core";

const BEGIN = "<!-- boxglow:begin -->";
const END = "<!-- boxglow:end -->";

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

/** hooks の 1 件 (Claude Code と Codex で同じ形: { matcher?, hooks: [{ type: "command", command }] }) */
interface HookEntry { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] }

/**
 * エージェントごとの hooks の定義 (イベント → 項目)
 * Input : actor = "claude-code" | "codex" (hook のコマンドの --actor に付ける)
 * Output: イベント名 → HookEntry[]
 */
export function hookDefinitions(actor: "claude-code" | "codex"): Record<string, HookEntry[]> {
  const cmd = (event: string) => `npx boxglow hook ${event} --actor ${actor}`;
  return {
    // 開始・再開・圧縮の後に、計画の再開の概要を文脈として注入する
    SessionStart: [{ matcher: "startup|resume|clear|compact|fork", hooks: [{ type: "command", command: cmd("session-start") }] }]
    // 応答を終える前に、作業中にした箱に記録が無ければ続行を指示する
  , Stop: [{ hooks: [{ type: "command", command: cmd("stop") }] }]
    // boxglow.json の直接編集を止める (CLI か MCP で更新させる)
  , PreToolUse: [{ matcher: actor === "codex" ? "apply_patch|Edit|Write" : "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: cmd("pre-tool") }] }]
  };
}

/**
 * hooks の設定 (JSON のオブジェクト) に Boxglow の項目を足す。既存の項目は残し、同じコマンドがあれば足さない。
 * 古い setup-agent が入れた `npx boxglow status` の SessionStart は、新しい session-start に置き換える
 * Input : hooks = 設定の hooks オブジェクト (変更する), actor。Output: 変えたか
 */
function mergeHooks(hooks: Record<string, unknown>, actor: "claude-code" | "codex"): boolean {
  let changed = false;
  for (const [event, entries] of Object.entries(hookDefinitions(actor))) {
    const cur = hooks[event] ?? [];
    if (!Array.isArray(cur)) throw new Error(t("設定の形が正しくありません: {where}", { where: "hooks." + event }));
    const kept: unknown[] = [];
    for (const h of cur) {
      const entry = object(h, event + " entry");
      if (entry.hooks !== undefined && !Array.isArray(entry.hooks)) throw new Error(t("設定の形が正しくありません: {where}", { where: event + " hooks" }));
      const commands = (entry.hooks as unknown[] | undefined ?? []).map((x) => String(object(x, "hook").command ?? ""));
      // 古い形 (npx boxglow status) は置き換える
      if (event === "SessionStart" && commands.length === 1 && commands[0] === "npx boxglow status") { changed = true; continue; }
      kept.push(h);
    }
    for (const e of entries) {
      // 同じイベントの Boxglow の hook が (コマンドの呼び方が違っても: npx boxglow / node bin/boxglow.js) 既にあれば足さない
      const eventName = /boxglow hook (session-start|stop|pre-tool)/.exec(e.hooks[0].command)![1];
      const exists = kept.some((h) => (object(h, event).hooks as { command?: string }[] | undefined ?? []).some((x) => new RegExp(`boxglow(\\.js)? hook ${eventName}\\b`).test(x.command ?? "")));
      if (!exists) { kept.push(e); changed = true; }
    }
    if (changed || kept.length !== cur.length) hooks[event] = kept;
  }
  return changed;
}

/** レビュー用のサブエージェントの説明と手順 (Claude Code の .md と Codex の .toml で同じ文) */
function reviewAgentText(actor: "claude-code" | "codex"): { description: string; body: string } {
  return {
    description: t("Boxglow の分解 (review-split) と着手準備 (review-box) のレビュー。親ボックスを分解した後や着手の前に、材料とチェック項目を読んで評価し、根拠を split-ok / box-ok で記録する")
  , body: t(`手順:
1. 対象のボックスを受け取り、\`npx boxglow context <box> --actor {actor}-review\` を読んで確認トークンを控える
2. 分解のレビューなら \`npx boxglow review-split <親> --actor {actor}-review\`、着手準備のレビューなら \`npx boxglow review-box <box> --actor {actor}-review\` で材料とチェック項目を読む
3. チェック項目ごとに、材料のどこを見て何と判断したかを書く。直すべき点があれば、直す内容を具体的に (ボックスの key・出力名・期待する文) 返す
4. 評価・根拠・対象のボックス (key) を親へ返す。記録は親が行う: 親が最新の \`context\` を読み、自分の記録者名と受け持ちで \`split-ok <親> --note "<根拠>"\` / \`box-ok <box> --note "<根拠>"\` を実行する (受け持ち制御が有効な計画では、子が親の受け持ちで書くことはできない)
5. boxglow.json は直接編集しない。判断が要ることは親に返し、親が \`npx boxglow ask\` で残す`, { actor })
  };
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
  // 同梱の指示書は前置きが付いているので、「---」で挟まれた本文だけを貼る
  const parts = snippet.split(/^---$/m);
  const body = (parts.length >= 3 ? parts.slice(1, -1).join("---") : snippet).trim();

  // 既定 (all) は両方の指示書に書く。Codex だけ・Claude Code だけも選べる
  for (const name of [...(codex ? ["AGENTS.md"] : []), ...(claude ? ["CLAUDE.md"] : [])]) {
    const actor = name === "AGENTS.md" ? "codex" : "claude-code";
    // WSLなどへ渡ると識別環境が失われることがある。人のシェル設定にも依存しない。
    const identity = t("このエージェントはすべてのBoxglow CLI呼び出しに --actor {actor} を付けてください。サブエージェントには {actor}-作業名 のように別名を付けます。人を名乗って同期の選択を代行しないでください。", { actor });
    const block = `${BEGIN}\n${body}\n\n${identity}\n${END}\n`;
    const path = join(root, name);
    const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
    const begin = cur.indexOf(BEGIN);
    const end = cur.indexOf(END);
    // 印が片方だけ・順番が逆のときは、どこを書き換えるか決められないので止める
    if ((begin < 0) !== (end < 0) || (begin >= 0 && end < begin)) throw new Error(t("Boxglow の印 (boxglow:begin / boxglow:end) が正しく対になっていません: {path}", { path }));
    // 印があればその間だけを入れ替え、無ければ末尾に足す (利用者が書いた部分は残す)
    files.set(name, begin >= 0 ? cur.slice(0, begin) + block + cur.slice(end + END.length).replace(/^\r?\n/, "") : (cur ? cur.replace(/\s*$/, "\n\n") : "") + block);
  }
  if (codex) {
    // Codex のスキル (記録者の名前の例を codex に置き換える) と、MCP への依存の宣言
    files.set(".agents/skills/boxglow/SKILL.md", skill.replaceAll("--by claude-code", "--by codex"));
    files.set(".agents/skills/boxglow/agents/openai.yaml", `interface:\n  display_name: Boxglow\n  short_description: ${t("boxglow.json の計画に作業の開始・完了・判断待ちを記録する")}\n  default_prompt: ${t("Boxglow の計画を読んで、今の作業を記録してください")}\npolicy:\n  allow_implicit_invocation: true\ndependencies:\n  tools:\n    - type: mcp\n      value: boxglow\n      transport: stdio\n`);
    // プロジェクトの .codex/config.toml に手元の MCP サーバ (信頼したプロジェクトで読まれる)。既に boxglow の表があれば触らない
    const tomlPath = join(root, ".codex/config.toml");
    const toml = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
    // TOML として読んで判定する (引用符付きのキー・空白も同じ表。壊れた TOML なら何も書かずに止める。Codex レビュー 30 R30-02)
    let parsed: Record<string, unknown>;
    try { parsed = parseToml(toml) as Record<string, unknown>; } catch (e) { throw new Error(t("設定の形が正しくありません: {where}", { where: tomlPath + " (" + (e instanceof Error ? e.message.split("\n")[0] : String(e)) + ")" })); }
    const servers = object(parsed.mcp_servers, "mcp_servers");
    if (!Object.hasOwn(servers, "boxglow")) {
      const block = `[mcp_servers.boxglow]\ncommand = "npx"\nargs = ["-y", "boxglow", "mcp", "--actor", "codex"]\ndefault_tools_approval_mode = "auto"\n`;
      const candidate = (toml.trim() ? toml.replace(/\s*$/, "\n\n") : "") + block;
      // 単純な追記で不正になる形 (mcp_servers がインラインの表など) は、書く前に止める
      try { parseToml(candidate); } catch { throw new Error(t("設定の形が正しくありません: {where}", { where: tomlPath + " (mcp_servers)" })); }
      files.set(".codex/config.toml", candidate);
    }
    // hooks (.codex/hooks.json。他の hooks は残す)
    const hooksFile = readObject(join(root, ".codex/hooks.json"));
    const hooks = object(hooksFile.hooks, "hooks");
    if (mergeHooks(hooks, "codex")) { hooksFile.hooks = hooks; files.set(".codex/hooks.json", JSON.stringify(hooksFile, null, 2) + "\n"); }
    // レビュー用のサブエージェント
    const r = reviewAgentText("codex");
    files.set(".codex/agents/boxglow-review.toml", `name = "boxglow-review"\ndescription = ${JSON.stringify(r.description)}\ndeveloper_instructions = """\n${r.body.replace(/"""/g, '\\"\\"\\"')}\n"""\n`);
  }
  if (claude) {
    // Claude Code のスキル
    files.set(".claude/skills/boxglow/SKILL.md", skill);
    // settings.json: hooks、Boxglow の CLI の許可 (確認を減らす)、.mcp.json の自動承認。他の設定は残す
    const settings = readObject(join(root, ".claude/settings.json"));
    const hooks = object(settings.hooks, "hooks");
    let changed = mergeHooks(hooks, "claude-code");
    if (changed) settings.hooks = hooks;
    const permissions = object(settings.permissions, "permissions");
    const allow = permissions.allow ?? [];
    if (!Array.isArray(allow)) throw new Error(t("設定の形が正しくありません: {where}", { where: "permissions.allow" }));
    for (const rule of ["Bash(npx boxglow *)", "Bash(boxglow *)"]) if (!allow.includes(rule)) { allow.push(rule); changed = true; }
    permissions.allow = allow; settings.permissions = permissions;
    // .mcp.json の boxglow だけを承認済みにする (ほかの MCP サーバの承認方針は変えない。既存の拒否も残す。R30-03)
    const enabled = settings.enabledMcpjsonServers ?? [];
    if (!Array.isArray(enabled) || enabled.some((x) => typeof x !== "string")) throw new Error(t("設定の形が正しくありません: {where}", { where: "enabledMcpjsonServers" }));
    if (!enabled.includes("boxglow")) { settings.enabledMcpjsonServers = [...enabled, "boxglow"]; changed = true; }
    if (changed) files.set(".claude/settings.json", JSON.stringify(settings, null, 2) + "\n");
    // レビュー用のサブエージェント
    const r = reviewAgentText("claude-code");
    files.set(".claude/agents/boxglow-review.md", `---\nname: boxglow-review\ndescription: ${r.description}\ntools: Bash, Read\n---\n\n${r.body}\n`);
    // MCP サーバの登録 (Claude Code はプロジェクトの .mcp.json を読む。他のサーバの設定は残す)
    const mcp = readObject(join(root, ".mcp.json"));
    const servers = object(mcp.mcpServers, "mcpServers");
    if (!servers.boxglow) {
      servers.boxglow = { command: "npx", args: ["-y", "boxglow", "mcp", "--actor", "claude-code"] };
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

/**
 * setup-agent --check: 入っているものと足りないものを一覧にする (書かない)
 * Input : root, agent。Output: 行の一覧 ("OK <項目>" / "NG <項目>")
 */
export function checkAgentSetup(root: string, agent: string): string[] {
  const codex = agent !== "claude-code";
  const claude = agent !== "codex";
  const lines: string[] = [];
  const has = (rel: string, test?: (text: string) => boolean) => { const p = join(root, rel); if (!existsSync(p)) return false; return test ? test(readFileSync(p, "utf8")) : true; };
  // hooks の構造を見る: イベントごとに、期待する matcher (SessionStart は compact を含む、PreToolUse は編集のツール名) と、そのイベントの中に Boxglow のコマンドがあること
  const hooksOk = (rel: string, actor: "claude-code" | "codex") => has(rel, (text) => {
    try {
      const o = JSON.parse(text) as { hooks?: Record<string, { matcher?: string; hooks?: { command?: string }[] }[]> };
      const hooks = o.hooks ?? {};
      const hasCmd = (event: string, name: string, matcherNeeds: string[]) => (hooks[event] ?? []).some((entry) =>
        matcherNeeds.every((m) => (entry.matcher ?? "").includes(m)) && (entry.hooks ?? []).some((h) => new RegExp(`boxglow(\\.js)? hook ${name} --actor ${actor}`).test(h.command ?? "")));
      return hasCmd("SessionStart", "session-start", ["compact"]) && hasCmd("Stop", "stop", []) && hasCmd("PreToolUse", "pre-tool", actor === "codex" ? ["apply_patch"] : ["Edit", "Write"]);
    } catch { return false; }
  });
  const row = (ok: boolean, label: string) => lines.push(`${ok ? "OK" : "NG"} ${label}`);
  if (claude) {
    row(has("CLAUDE.md", (s) => s.includes(BEGIN)), "CLAUDE.md " + t("(Boxglow の手順)"));
    row(has(".claude/skills/boxglow/SKILL.md"), ".claude/skills/boxglow/SKILL.md");
    row(hooksOk(".claude/settings.json", "claude-code"), ".claude/settings.json " + t("(hooks: session-start / stop / pre-tool)"));
    row(has(".claude/settings.json", (s) => { try { const o = JSON.parse(s) as { permissions?: { allow?: string[] }; enableAllProjectMcpServers?: boolean; enabledMcpjsonServers?: string[]; disabledMcpjsonServers?: string[] }; return !!o.permissions?.allow?.includes("Bash(npx boxglow *)") && (o.enableAllProjectMcpServers === true || !!o.enabledMcpjsonServers?.includes("boxglow")) && !o.disabledMcpjsonServers?.includes("boxglow"); } catch { return false; } }), ".claude/settings.json " + t("(CLI の許可と、.mcp.json の boxglow の承認)"));
    row(has(".claude/agents/boxglow-review.md"), ".claude/agents/boxglow-review.md");
    row(has(".mcp.json", (s) => s.includes('"boxglow"')), ".mcp.json " + t("(MCP サーバ boxglow)"));
  }
  if (codex) {
    row(has("AGENTS.md", (s) => s.includes(BEGIN)), "AGENTS.md " + t("(Boxglow の手順)"));
    row(has(".agents/skills/boxglow/SKILL.md"), ".agents/skills/boxglow/SKILL.md");
    row(has(".agents/skills/boxglow/agents/openai.yaml"), ".agents/skills/boxglow/agents/openai.yaml " + t("(MCP への依存)"));
    row(has(".codex/config.toml", (s) => { try { return Object.hasOwn(object((parseToml(s) as Record<string, unknown>).mcp_servers, "mcp_servers"), "boxglow"); } catch { return false; } }), ".codex/config.toml " + t("(MCP サーバ boxglow)"));
    row(hooksOk(".codex/hooks.json", "codex"), ".codex/hooks.json " + t("(hooks: session-start / stop / pre-tool)"));
    row(has(".codex/agents/boxglow-review.toml"), ".codex/agents/boxglow-review.toml");
  }
  lines.push(t("(OK = 設定ファイルが入っている。エージェント側の承認・信頼と、実際に発火したかは、ここでは確認できない)"));
  return lines;
}

/**
 * 利用者が一度だけ行うこと (自動化できないもの) の案内
 * Input : agent。Output: 行の一覧
 */
export function oneTimeSteps(agent: string): string[] {
  const lines: string[] = [];
  if (agent !== "claude-code") {
    lines.push(t("Codex: このプロジェクトを初めて開くときに「信頼しますか」と聞かれたら信頼する (.codex の MCP と hooks は信頼したプロジェクトでだけ動く)"));
    lines.push(t("Codex: /hooks を開いて Boxglow の hooks を承認する (初回と、hooks の定義が変わったとき。未承認の hooks は動かない)"));
    lines.push(t("Codex: 利用者設定にも MCP を入れるなら (プロジェクトの信頼の前から使える): codex mcp add boxglow -- npx -y boxglow mcp --actor codex"));
  }
  if (agent !== "codex") lines.push(t("Claude Code: プロジェクトを信頼して開き、/mcp で boxglow の接続状態を確かめる (承認待ち・拒否があれば表示に従う)"));
  return lines;
}
