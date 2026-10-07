/**
 * MCP サーバ (標準入出力): AI エージェントが boxglow.json をツールとして操作する
 * 各ツールは CLI と同じ処理 (runCli) を呼び、その出力の文字列を返す。標準出力は MCP の通信に使うので、
 * CLI の出力は文字列に集める (runCli がそうする)
 * Input : run = CLI を関数として実行するもの (main.ts の runCli)
 * Output: 接続が切れるまで常駐
 */


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// 文言の言語切り替え (React に依存しない core を使う)。ツールの説明は起動時の言語 (BOXGLOW_LANG、無ければ日本語) で 1 回だけ登録される
import { setLang, t } from "../src/i18n/core";
// サーバの版はアプリの版 (package.json) と同じにする (直書きすると版を上げたときに食い違う)
import { APP_VERSION } from "../src/model/version";

type Run = (argv: string[]) => string | Promise<string>;

/** ツールの結果 (文字列 1 つ) */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s.trim() || t("(出力なし)") }] });

/** 失敗は isError 付きで返す (例外で落とさない) */
const safe = async (run: Run, argv: string[]) => {
  try {
    return text(await run(argv));
  } catch (e) {
    return { ...text(`[boxglow] ${e instanceof Error ? e.message : String(e)}`), isError: true };
  }
};

/** オプションを argv に足す (undefined は付けない。配列は繰り返す) */
function opt(argv: string[], name: string, value: string | string[] | boolean | number | undefined): void {
  if (value === undefined || value === false || value === "") return;
  if (value === true) { argv.push(`--${name}`); return; }
  for (const v of Array.isArray(value) ? value : [value]) argv.push(`--${name}`, String(v));
}

export async function startMcp(run: Run): Promise<void> {
  // ツールの説明の言語を決める: 環境変数 BOXGLOW_LANG (en / ja)、無ければ日本語のまま。
  // mcp の入口は main() を通らないので、説明を登録する前にここで決める (各ツールの実行時は runCli が毎回決め直す)
  const envLang = (process.env.BOXGLOW_LANG ?? "").toLowerCase();
  if (envLang === "en" || envLang === "ja") setLang(envLang);
  const server = new McpServer({ name: "boxglow", version: APP_VERSION });
  // 入力はなし。任意のfileや人の選択を指定した要求は、通常同期へ読み替えず拒否する。
  server.registerTool("boxglow_sync", {
    description: t("結び付け済みの計画を同期し、停止理由と比較を返す。判断が必要ならAIはaskで人に知らせる。人が画面かCLIで選ぶ。"),
    inputSchema: z.object({}).catchall(z.unknown()),
  }, async a => Object.keys(a).length
    ? safe(() => { throw new Error(t("この同期には人の判断が必要です。AIは変更の違いと停止理由を要約してaskで知らせ、人が画面またはCLIで選ぶまで待ってください。AIは選択を代行しないでください。") + "\n" + t("人が実行している場合は、boxglow sync --help の「人の操作」を参照してください。")); }, [])
    : safe(run, ["sync"]));
  const block = z.string().describe(t("ボックスの B 番号 (B12) か題名"));

  server.registerTool("boxglow_status", { description: t("計画の今の状況: 判断待ち・作業中・次の候補・階層の一覧 (セッションの最初に読む)"), inputSchema: { brief: z.boolean().optional().describe(t("階層の一覧を省く (判断・活動・次の候補は残す)")) }, annotations: { readOnlyHint: true } }, async ({ brief }) => safe(run, brief ? ["status", "--brief"] : ["status"]));
  server.registerTool("boxglow_resume", { description: t("再開の概要: 現況・準備状況別の候補・未完了の引き継ぎ。完了した引き継ぎは指定した場合だけ読む"), inputSchema: { includeCompleted: z.boolean().optional() }, annotations: { readOnlyHint: true } }, async ({ includeCompleted }) => safe(run, ["resume", "--json", ...(includeCompleted ? ["--include-completed"] : [])]));
  server.registerTool("boxglow_scope", {
    description: t("今回達成すること・対象外・完了条件・相談条件。省略は表示、none で項目を消す"),
    inputSchema: { block, contextToken: z.string().optional(), goal: z.string().optional(), nonGoals: z.string().optional(), acceptance: z.string().optional(), consult: z.string().optional() },
  }, async a => {
    const argv = ["scope", a.block];
    for (const [key, flag] of [["goal","goal"],["nonGoals","non-goals"],["acceptance","acceptance"],["consult","consult"]] as const) {
      // 空文字も「消す」として CLI に渡す。opt は空文字を省くため、ここだけ直接追加する。
      if (a[key] !== undefined) argv.push("--" + flag, a[key]!);
    }
    opt(argv, "context-token", a.contextToken);
    return safe(run, argv);
  });
  server.registerTool("boxglow_focus", {
    description: t("今回優先するボックスとその配下を選ぶ。none で解除、省略は表示"),
    inputSchema: { block: block.optional(), contextToken: z.string().optional() },
  }, async a => safe(run, ["focus", ...(a.block ? [a.block] : []), ...(a.contextToken ? ["--context-token", a.contextToken] : [])]));
  server.registerTool("boxglow_policy", {
    description: t("AI の着手・完了確認を計画ごとに選ぶ。既定は警告、人の操作は拒否しない"),
    inputSchema: { start: z.enum(["warn","reject"]).optional(), done: z.enum(["warn","reject"]).optional(), contextToken: z.string().optional() },
  }, async a => {
    const argv = ["policy"]; opt(argv, "start", a.start); opt(argv, "done", a.done); opt(argv, "context-token", a.contextToken); return safe(run, argv);
  });
  server.registerTool("boxglow_context", { description: t("ボックスのコンテキストを読む: 親と入力元の判断・入出力の条件・引き継ぎメモ。guard 付きの変更に使う contextToken を返す (自分の操作でコンテキストが変わると、その操作の出力に新しい確認トークンが出る)"), inputSchema: { block, brief: z.boolean().optional().describe(t("短い形で読む (対象の情報は全部、親と入力元は題名・状態・有効な判断・対象につながる出力だけ。確認トークンは同じ)")) }, annotations: { readOnlyHint: true } }, async ({ block: b, brief }) => safe(run, ["context", b, ...(brief ? ["--brief"] : [])]));
  server.registerTool("boxglow_checkpoint", { description: t("中断や引き継ぎの前に、分かったこと・次の手順・未解決の点を計画に残す"), inputSchema: { block, note: z.string(), contextToken: z.string().optional() } }, async (a) => { const argv = ["checkpoint", a.block, "--note", a.note]; opt(argv, "context-token", a.contextToken); return safe(run, argv); });
  server.registerTool("boxglow_show", { description: t("ボックスの詳細 (入出力・線・判断・成果物)"), inputSchema: { block }, annotations: { readOnlyHint: true } }, async ({ block: b }) => safe(run, ["show", b]));
  server.registerTool("boxglow_add", {
    description: t("ボックスを足す。出力 (成果物の名前) を必ず決める。parent を省くと最初のプロジェクトのボックスの直下 (大項目) に入る")
  , inputSchema: { title: z.string(), out: z.string().describe(t("出力の名前 (具体的な成果物: ファイル・URL・PR)")), parent: block.optional(), in: z.array(z.string()).optional().describe(t("入力の名前")), category: z.string().optional().describe("design/build/verify/evaluate/study/research/ui/improve/fix/docs/ops/other"), note: z.string().optional() }
  }, async (a) => { const argv = ["add", a.title]; opt(argv, "out", a.out); opt(argv, "parent", a.parent); opt(argv, "in", a.in); opt(argv, "category", a.category); opt(argv, "note", a.note); return safe(run, argv); });
  server.registerTool("boxglow_split", {
    description: t("大きいボックスを中のボックスに分解する。spec は { blocks: [{ title, inputs?: [名前], outputs: [名前] }], connections: [{ from: \"A.出力名\", to: \"B\" }] } の形 (to は題名だけでよい: 出力名と同じ入力が作られる。親の入力からは from: \"parent.入力名\"、親の出力へは to: \"parent.出力名\")")
  , inputSchema: { block, contextToken: z.string().optional(), spec: z.record(z.string(), z.unknown()).describe(t("分解の指定 (JSON)")) }
  }, async ({ block: b, spec, contextToken }) => safe(run, ["split", b, "--spec", JSON.stringify(spec), ...(contextToken ? ["--context-token", contextToken] : [])]));
  server.registerTool("boxglow_connect", { description: t("線をつなぐ: <題名.出力名> から <題名> へ (受け側は題名だけでよい。出力名と同じ名前の入力が作られる。<題名.入力名> で既存の入力を指定してもよい。親の入力は project.入力名、親の出力へは 題名.出力名 -> project)"), inputSchema: { from: z.string(), to: z.string() } }, async ({ from, to }) => safe(run, ["connect", from, to]));
  server.registerTool("boxglow_disconnect", { description: t("線を外す"), inputSchema: { from: z.string(), to: z.string() } }, async ({ from, to }) => safe(run, ["disconnect", from, to]));
  server.registerTool("boxglow_port", { description: t("ボックスに入力 / 出力を足す、名前を変える"), inputSchema: { block, in: z.array(z.string()).optional(), out: z.array(z.string()).optional(), rename: z.string().optional().describe(t("旧=新")) } }, async (a) => { const argv = ["port", a.block]; opt(argv, "in", a.in); opt(argv, "out", a.out); opt(argv, "rename", a.rename); return safe(run, argv); });
  server.registerTool("boxglow_move", { description: t("ボックスを別の親の中へ移す (線はつなぎ直される)"), inputSchema: { block, parent: z.string().describe(t("移す先のボックスか project")) } }, async ({ block: b, parent }) => safe(run, ["move", b, "--parent", parent]));
  server.registerTool("boxglow_remove", { description: t("ボックスを消す (中にボックスがあれば force)"), inputSchema: { block, force: z.boolean().optional() } }, async ({ block: b, force }) => { const argv = ["remove", b]; opt(argv, "force", force); return safe(run, argv); });
  server.registerTool("boxglow_start", { description: t("作業を始める (作業中の札が付く)。同時に作業中にするボックスは 1〜2 個まで"), inputSchema: { block, contextToken: z.string().optional(), note: z.string().optional().describe(t("何をするか")), reason: z.string().optional().describe(t("入力待ちで開始する理由")) } }, async ({ block: b, note, reason, contextToken }) => { const argv = ["start", b]; opt(argv, "note", note); opt(argv, "reason", reason); opt(argv, "context-token", contextToken); return safe(run, argv); });
  server.registerTool("boxglow_done", { description: t("完了にする。成果物 (名前=パスか URL) を付ける。Git のファイルなら commit+path+blob が記録される"), inputSchema: { block, contextToken: z.string().optional(), artifact: z.array(z.string()).optional().describe(t("名前=パス または 名前=URL")), note: z.string().optional(), output: z.string().optional().describe(t("出力の名前を変えるとき")) } }, async (a) => { const argv = ["done", a.block]; opt(argv, "artifact", a.artifact); opt(argv, "note", a.note); opt(argv, "output", a.output); opt(argv, "context-token", a.contextToken); return safe(run, argv); });
  server.registerTool("boxglow_blocked", { description: t("詰まった (困っていることを書いて他のボックスへ移る)"), inputSchema: { block, contextToken: z.string().optional(), note: z.string() } }, async ({ block: b, note, contextToken }) => safe(run, ["blocked", b, "--note", note, ...(contextToken ? ["--context-token", contextToken] : [])]));
  server.registerTool("boxglow_ask", {
    description: t("人の判断が要る質問を残す (選択肢付き)。質問だけで判断できるように、前提・比較・影響を context に書く。AI が自分で選ぶときも ask して answer (by=codex / claude-code) で記録する")
  , inputSchema: { block, contextToken: z.string().optional(), question: z.string(), options: z.array(z.string()).optional(), context: z.string().optional() }
  }, async (a) => { const argv = ["ask", a.block, a.question]; if (a.options?.length) argv.push("--options", a.options.join("|")); opt(argv, "context", a.context); opt(argv, "context-token", a.contextToken); return safe(run, argv); });
  server.registerTool("boxglow_answer", { description: t("判断に答える (人がチャットで答えたら by=human で記録)"), inputSchema: { block, contextToken: z.string().optional(), answer: z.string(), by: z.string().optional().describe(t("human / claude-code など")) } }, async (a) => { const argv = ["answer", a.block, a.answer]; opt(argv, "by", a.by); opt(argv, "context-token", a.contextToken); return safe(run, argv); });
  server.registerTool("boxglow_ack", { description: t("人の回答を読んで引き取ったと記録する (status の「回答あり」から消える)"), inputSchema: { block, contextToken: z.string().optional(), id: z.string().optional().describe(t("decision id (省略するとそのボックスの未確認の回答すべて)")) } }, async ({ block: b, id, contextToken }) => { const argv = ["ack", b]; opt(argv, "id", id); opt(argv, "context-token", contextToken); return safe(run, argv); });
  server.registerTool("boxglow_reopen", { description: t("判断をやり直す (前の答えは履歴に残る)"), inputSchema: { block, contextToken: z.string().optional(), note: z.string().optional() } }, async ({ block: b, note, contextToken }) => { const argv = ["reopen", b]; opt(argv, "note", note); opt(argv, "context-token", contextToken); return safe(run, argv); });
  server.registerTool("boxglow_set", { description: t("ボックスの属性を変える (題名・メモ・カテゴリ・期日・リポジトリ・課題 URL)"), inputSchema: { block, contextToken: z.string().optional(), title: z.string().optional(), note: z.string().optional(), category: z.string().optional(), start: z.string().optional().describe("YYYY-MM-DD"), due: z.string().optional().describe("YYYY-MM-DD"), repo: z.string().optional(), issue: z.string().optional() } }, async (a) => { const argv = ["set", a.block]; for (const k of ["title", "note", "category", "start", "due", "repo", "issue"] as const) opt(argv, k, a[k]); opt(argv, "context-token", a.contextToken); return safe(run, argv); });
  server.registerTool("boxglow_export", { description: t("計画を Markdown に書き出す (docs/ROADMAP.md など)"), inputSchema: { out: z.string().optional() } }, async ({ out: o }) => { const argv = ["export"]; opt(argv, "out", o); return safe(run, argv); });
  server.registerTool("boxglow_validate", { description: t("計画の問題 (つながっていない入出力など) を検査する"), inputSchema: {}, annotations: { readOnlyHint: true } }, async () => safe(run, ["validate"]));
  server.registerTool("boxglow_run", { description: t("そのほかの CLI コマンドをそのまま実行する (例: [\"log\", \"--n\", \"20\"]、[\"layout\"]、[\"help\"])"), inputSchema: { args: z.array(z.string()) } }, async ({ args }) => safe(run, args));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
