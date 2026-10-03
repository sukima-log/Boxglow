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

type Run = (argv: string[]) => string;

/** ツールの結果 (文字列 1 つ) */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s.trim() || "(出力なし)" }] });

/** 失敗は isError 付きで返す (例外で落とさない) */
const safe = (run: Run, argv: string[]) => {
  try {
    return text(run(argv));
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
  const server = new McpServer({ name: "boxglow", version: "0.1.0" });
  const block = z.string().describe("箱の B 番号 (B12) か題名");

  server.registerTool("boxglow_status", { description: "計画の今の状況: 判断待ち・作業中・次の候補・階層の一覧 (セッションの最初に読む)", inputSchema: {} }, async () => safe(run, ["status"]));
  server.registerTool("boxglow_show", { description: "箱の詳細 (入出力・線・判断・成果物)", inputSchema: { block } }, async ({ block: b }) => safe(run, ["show", b]));
  server.registerTool("boxglow_add", {
    description: "箱を足す。出力 (成果物の名前) を必ず決める。parent を省くと最初のプロジェクトの箱の直下 (大項目) に入る"
  , inputSchema: { title: z.string(), out: z.string().describe("出力の名前 (具体的な成果物: ファイル・URL・PR)"), parent: block.optional(), in: z.array(z.string()).optional().describe("入力の名前"), category: z.string().optional().describe("design/build/verify/evaluate/study/research/ui/improve/fix/docs/ops/other"), note: z.string().optional() }
  }, async (a) => { const argv = ["add", a.title]; opt(argv, "out", a.out); opt(argv, "parent", a.parent); opt(argv, "in", a.in); opt(argv, "category", a.category); opt(argv, "note", a.note); return safe(run, argv); });
  server.registerTool("boxglow_split", {
    description: "大きい箱を中の箱に分解する。spec は { blocks: [{ title, inputs?: [名前], outputs: [名前] }], connections: [{ from: \"A.出力名\", to: \"B\" }] } の形 (to は題名だけでよい: 出力名と同じ入力が作られる。親の入力からは from: \"parent.入力名\"、親の出力へは to: \"parent.出力名\")"
  , inputSchema: { block, spec: z.record(z.string(), z.unknown()).describe("分解の指定 (JSON)") }
  }, async ({ block: b, spec }) => safe(run, ["split", b, "--spec", JSON.stringify(spec)]));
  server.registerTool("boxglow_connect", { description: "線をつなぐ: <題名.出力名> から <題名> へ (受け側は題名だけでよい。出力名と同じ名前の入力が作られる。<題名.入力名> で既存の入力を指定してもよい。親の入力は project.入力名、親の出力へは 題名.出力名 -> project)", inputSchema: { from: z.string(), to: z.string() } }, async ({ from, to }) => safe(run, ["connect", from, to]));
  server.registerTool("boxglow_disconnect", { description: "線を外す", inputSchema: { from: z.string(), to: z.string() } }, async ({ from, to }) => safe(run, ["disconnect", from, to]));
  server.registerTool("boxglow_port", { description: "箱に入力 / 出力を足す、名前を変える", inputSchema: { block, in: z.array(z.string()).optional(), out: z.array(z.string()).optional(), rename: z.string().optional().describe("旧=新") } }, async (a) => { const argv = ["port", a.block]; opt(argv, "in", a.in); opt(argv, "out", a.out); opt(argv, "rename", a.rename); return safe(run, argv); });
  server.registerTool("boxglow_move", { description: "箱を別の親の中へ移す (線はつなぎ直される)", inputSchema: { block, parent: z.string().describe("移す先の箱か project") } }, async ({ block: b, parent }) => safe(run, ["move", b, "--parent", parent]));
  server.registerTool("boxglow_remove", { description: "箱を消す (中に箱があれば force)", inputSchema: { block, force: z.boolean().optional() } }, async ({ block: b, force }) => { const argv = ["remove", b]; opt(argv, "force", force); return safe(run, argv); });
  server.registerTool("boxglow_start", { description: "作業を始める (作業中の札が付く)。同時に作業中にする箱は 1〜2 個まで", inputSchema: { block, note: z.string().optional().describe("何をするか") } }, async ({ block: b, note }) => { const argv = ["start", b]; opt(argv, "note", note); return safe(run, argv); });
  server.registerTool("boxglow_done", { description: "完了にする。成果物 (名前=パスか URL) を付ける。Git のファイルなら commit+path+blob が記録される", inputSchema: { block, artifact: z.array(z.string()).optional().describe("名前=パス または 名前=URL"), note: z.string().optional(), output: z.string().optional().describe("出力の名前を変えるとき") } }, async (a) => { const argv = ["done", a.block]; opt(argv, "artifact", a.artifact); opt(argv, "note", a.note); opt(argv, "output", a.output); return safe(run, argv); });
  server.registerTool("boxglow_blocked", { description: "詰まった (困っていることを書いて他の箱へ移る)", inputSchema: { block, note: z.string() } }, async ({ block: b, note }) => safe(run, ["blocked", b, "--note", note]));
  server.registerTool("boxglow_ask", {
    description: "人の判断が要る質問を残す (選択肢付き)。質問だけで判断できるように、前提・比較・影響を context に書く。AI が自分で選ぶときも ask して answer (by=claude-code) で記録する"
  , inputSchema: { block, question: z.string(), options: z.array(z.string()).optional(), context: z.string().optional() }
  }, async (a) => { const argv = ["ask", a.block, a.question]; if (a.options?.length) argv.push("--options", a.options.join("|")); opt(argv, "context", a.context); return safe(run, argv); });
  server.registerTool("boxglow_answer", { description: "判断に答える (人がチャットで答えたら by=human で記録)", inputSchema: { block, answer: z.string(), by: z.string().optional().describe("human / claude-code など") } }, async (a) => { const argv = ["answer", a.block, a.answer]; opt(argv, "by", a.by); return safe(run, argv); });
  server.registerTool("boxglow_ack", { description: "人の回答を読んで引き取ったと記録する (status の「回答あり」から消える)", inputSchema: { block, id: z.string().optional().describe("decision id (省略するとその箱の未確認の回答すべて)") } }, async ({ block: b, id }) => { const argv = ["ack", b]; opt(argv, "id", id); return safe(run, argv); });
  server.registerTool("boxglow_reopen", { description: "判断をやり直す (前の答えは履歴に残る)", inputSchema: { block, note: z.string().optional() } }, async ({ block: b, note }) => { const argv = ["reopen", b]; opt(argv, "note", note); return safe(run, argv); });
  server.registerTool("boxglow_set", { description: "箱の属性を変える (題名・メモ・カテゴリ・期日・リポジトリ・課題 URL)", inputSchema: { block, title: z.string().optional(), note: z.string().optional(), category: z.string().optional(), start: z.string().optional().describe("YYYY-MM-DD"), due: z.string().optional().describe("YYYY-MM-DD"), repo: z.string().optional(), issue: z.string().optional() } }, async (a) => { const argv = ["set", a.block]; for (const k of ["title", "note", "category", "start", "due", "repo", "issue"] as const) opt(argv, k, a[k]); return safe(run, argv); });
  server.registerTool("boxglow_export", { description: "計画を Markdown に書き出す (docs/ROADMAP.md など)", inputSchema: { out: z.string().optional() } }, async ({ out: o }) => { const argv = ["export"]; opt(argv, "out", o); return safe(run, argv); });
  server.registerTool("boxglow_validate", { description: "計画の問題 (つながっていない入出力など) を検査する", inputSchema: {} }, async () => safe(run, ["validate"]));
  server.registerTool("boxglow_run", { description: "そのほかの CLI コマンドをそのまま実行する (例: [\"log\", \"--n\", \"20\"]、[\"layout\"]、[\"help\"])", inputSchema: { args: z.array(z.string()) } }, async ({ args }) => safe(run, args));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
