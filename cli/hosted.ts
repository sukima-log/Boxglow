/**
 * ホスト型の MCP (Workers で動かす): サーバーに保存した計画の中身に対して、手元の MCP と同じ道具を動かす
 *   - 計画の読み書きは plan-io のメモリ版 (ファイルは無い)。要求ごとに「中身 → 道具の実行 → 変わった中身」を返し、保存は呼び出し側 (保存先の Durable Object) が行う
 *   - 読み取り専用のトークンでは、書く道具を断る
 *   - 転送は Streamable HTTP (状態を持たない。JSON の応答)
 * Input : request = MCP の HTTP 要求 (POST の JSON-RPC), plan = { text, write, actor?, lang? }
 * Output: { response, text (実行後の中身), changed }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "./mcp";
import { runCli } from "./main";
import { memoryPlanIO, withPlanIO } from "./plan-io";
import { setLang, t } from "../src/i18n/core";
import { APP_VERSION } from "../src/model/version";

export interface HostedPlan { text: string | null; write: boolean; actor?: string; lang?: "ja" | "en" }

/** 読むだけのコマンド (読み取り専用のトークンで許すもの) */
const READ_ONLY = new Set(["status", "resume", "show", "context", "lint", "validate", "claims", "review-split", "review-box", "export", "help", "version", "log", "members", "plan"]);
/**
 * 読むだけのコマンドのうち、引数しだいで書き込むもの: 書き込む形かどうか
 *   log: 引数なし (最近のログ) と「log <block>」(その箱の記録の一覧) だけが読むだけ。本文・--edit・--remove は書き込む
 *   members: --remove で書き込む / plan: --name・--description で書き込む
 * Input : argv = コマンドと引数 / Output: true = 書き込む形
 */
function writesWith(argv: string[]): boolean {
  const cmd = argv[0] ?? "";
  if (cmd === "log") return argv.length > 2 || (argv.length === 2 && argv[1].startsWith("--"));
  if (cmd === "members") return argv.some((a) => a === "--remove" || a.startsWith("--remove="));
  if (cmd === "plan") return argv.some((a) => /^--(name|description)(=|$)/.test(a));
  return false;
}
/** 使わせないコマンド (ファイル・ネットワーク・常駐が要る) */
const NOT_HOSTED = new Set(["serve", "mcp", "sync", "login", "logout", "whoami", "billing", "remote", "setup-agent", "merge", "init", "unlock", "import", "template", "hook"]);

export async function handleMcpRequest(request: Request, plan: HostedPlan): Promise<{ response: Response; text: string | null; changed: boolean }> {
  setLang(plan.lang ?? "ja");
  const io = memoryPlanIO(plan.text);
  const run = (argv: string[]): string => {
    const cmd = argv[0] ?? "";
    if (NOT_HOSTED.has(cmd)) throw new Error(t("このコマンドは、ホスト型の MCP では使えません: {cmd}", { cmd }));
    if (writesWith(argv) && !plan.write) throw new Error(t("このトークンは読み取り専用です"));
    if (!plan.write && !READ_ONLY.has(cmd)) throw new Error(t("このトークンは読み取り専用です"));
    // 記録者の名前 (トークンの名前) を、手元の --actor と同じ仕組みで渡す
    const previousActor = process.env.BOXGLOW_ACTOR;
    if (plan.actor) process.env.BOXGLOW_ACTOR = plan.actor;
    try { return withPlanIO(io, () => runCli(argv)); }
    finally { if (previousActor === undefined) delete process.env.BOXGLOW_ACTOR; else process.env.BOXGLOW_ACTOR = previousActor; }
  };
  const server = new McpServer({ name: "boxglow", version: APP_VERSION });
  registerTools(server, run);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request);
    return { response, text: io.current(), changed: io.current() !== plan.text };
  } finally {
    await transport.close().catch(() => {});
  }
}
