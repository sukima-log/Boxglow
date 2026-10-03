/**
 * boxglow CLI: AI エージェント (Claude Code / Codex など) と人がリポジトリ内の boxglow.json を操作する入口
 *
 * コマンドの一覧と書式は、下の HELP_JA (日本語) と HELP_EN (英語) が正本 (help で出す文面)。
 * コマンドを足す・変えるときは両方を直す。
 */
import { fileURLToPath } from "node:url";
import { startMcp } from "./mcp";
import { startServe } from "./serve";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import AGENTS_SNIPPET_JA from "../docs/AGENTS_SNIPPET.md";
import AGENTS_SNIPPET_EN from "../docs/AGENTS_SNIPPET.en.md";
import { getLang, setLang, t, type Lang } from "../src/i18n/core";
import SKILL_MD_JA from "../.claude/skills/boxglow/SKILL.md";
import SKILL_MD_EN from "../.claude/skills/boxglow/SKILL.en.md";
import { CATEGORIES, findCategory } from "../src/model/categories";
import { projectToMarkdown } from "../src/model/export";
import { blockSize } from "../src/model/size";
import { mergeProjects } from "../src/model/merge";
import { execFileSync } from "node:child_process";

/**
 * 人が入れたカテゴリ名をキーにする (知らない名前なら一覧を出して止める)
 * Input : text = "design" / "設計" など
 * Output: カテゴリのキー
 */
function categoryKeyOf(text: string): string {
  const c = findCategory(text);
  if (!c) throw new Error(t("知らないカテゴリです: {text} (使えるもの: {list})", { text, list: CATEGORIES.map((x) => (getLang() === "en" ? x.en : `${x.en} ${x.label}`)).join(", ") })); // 英語のときは英語名だけを並べる (日本語の札は出さない)
  return c.key;
}
import { dirname, join, resolve } from "node:path";
import { updateDecision, moveBlockToParent, reopenDecision, disconnect, resolveAllOverlaps, setCategory, addBlock, addPort, addProjectBlock, answerDecision, askDecision, clearActivity, connect, createArtifact, createGitArtifact, createProject, defaultTaskParent, extractTemplate, findBlock, finishBlock, fromJSON, instantiateTemplate, parseTemplate, portsOf, projectBlocks, searchBlocks, setActivity, setProgress, setSchedule, setStatus, splitBlock, toJSON, updateBlock, updatePort, validateConnection, addInputGroup, exportInputGroup, importInputGroup, inputGroupsOf, setInputGroup, normalizeCollapsed, removeBlock, connectToBlock, isInputNameLocked, normalizeInputNames, ackDecisions } from "../src/model/graph";
import type { Artifact } from "../src/model/types";
import { blockToPrompt } from "../src/model/export";
import { blockReport, logReport, statusReport } from "../src/model/report";
import { checkGitRef, gitRefFor } from "./git";
import { layoutAll, layoutScope, nextFreePosition } from "../src/model/autolayout";
import { ROOT_ID, type Endpoint, type Project } from "../src/model/types";

/** 引数を { positional, options } に分ける (--key value / --key=value / --flag) */
function parseArgs(argv: string[]): { positional: string[]; options: Record<string, string | string[] | true> } {
  const positional: string[] = [];
  const options: Record<string, string | string[] | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      let key = a.slice(2);
      let value: string | true = true;
      if (key.includes("=")) {
        value = key.slice(key.indexOf("=") + 1);
        key = key.slice(0, key.indexOf("="));
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        value = argv[++i];
      }
      const prev = options[key];
      if (prev === undefined) options[key] = value;
      else if (Array.isArray(prev)) prev.push(String(value));
      else options[key] = [String(prev), String(value)];
    } else {
      positional.push(a);
    }
  }
  return { positional, options };
}

/** 文字列オプション (無ければ undefined) */
const str = (v: string | string[] | true | undefined): string | undefined => (typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : undefined);
/** 配列オプション */
const list = (v: string | string[] | true | undefined): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v : []);

/** boxglow.json の場所を決める (--file > BOXGLOW_FILE > カレントから上へ探す) */
function locateFile(opt: string | undefined, forInit = false): string {
  if (opt) return resolve(opt);
  if (process.env.BOXGLOW_FILE) return resolve(process.env.BOXGLOW_FILE);
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "boxglow.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (forInit) return join(process.cwd(), "boxglow.json");
  throw new Error(t("boxglow.json が見つかりません (--file で指定するか、`boxglow init` で作ってください)"));
}

/** 誰として操作するか */
function actorOf(opt: string | undefined): string {
  if (opt) return opt;
  if (process.env.BOXGLOW_ACTOR) return process.env.BOXGLOW_ACTOR;
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "claude-code";
  if (process.env.CODEX_SANDBOX || process.env.CODEX_HOME) return "codex";
  return "agent";
}

/**
 * 成果物の指定 ("題名=URL またはパス"、または "URL またはパス") から Artifact を作る
 * パスが Git 管理下なら Git の参照 (コミット + パス + blob)、それ以外のパスは file、URL は url
 */
function artifactFrom(spec: string, titleOpt?: string): Artifact {
  const eq = spec.indexOf("=");
  const isUrlLike = (s: string) => /^[a-z]+:\/\//i.test(s);
  let title: string;
  let value: string;
  if (eq > 0 && !isUrlLike(spec.slice(0, eq))) {
    title = spec.slice(0, eq);
    value = spec.slice(eq + 1);
  } else {
    value = spec;
    title = titleOpt ?? spec.split(/[\\/]/).pop() ?? spec;
  }
  if (titleOpt) title = titleOpt;
  if (isUrlLike(value)) return createArtifact(title, value);
  const ref = gitRefFor(value);
  if (ref) return createGitArtifact(title, { repo: ref.repo, path: ref.path, commit: ref.commit, blob: ref.blob, url: ref.url });
  const a = createArtifact(title, "");
  a.kind = "file";
  a.path = value;
  return a;
}

function load(path: string): Project {
  return fromJSON(readFileSync(path, "utf8"));
}

function save(path: string, p: Project): void {
  // 画面と同じく、保存のたびに箱の重なりを解く (子が増えて親が大きくなったときに、下の箱を押し出す)
  // 大項目は常に畳んだ状態 (All の図は大項目までしか出さず、中はタブで見る。大きさもこの前提で計算する)
  // つないだ入力の名前は供給元にそろえる (古いファイルの食い違いもここで直る)
  writeFileSync(path, toJSON(resolveAllOverlaps(normalizeCollapsed(normalizeInputNames(p).project), (q, id) => blockSize(q, id))) + "\n", "utf8");
}

/** ブロックを探す (見つからなければ候補を示して終了) */
function mustFind(p: Project, ref: string | undefined, what = "block") {
  if (!ref) throw new Error(t("<{what}> を指定してください (id または題名)", { what }));
  const r = findBlock(p, ref);
  if (!r.block) {
    // 文を組み立てずに、場合ごとに 1 文ずつ訳せる形にする (候補あり = 1 つに決まらない / 候補なし = 見つからない)
    if (r.candidates.length > 0) throw new Error(t("ブロック「{ref}」が1 つに決まりません。 候補: {list}", { ref, list: r.candidates.map((b) => `${b.title} (id: ${b.id})`).join(", ") }));
    throw new Error(t("ブロック「{ref}」が見つかりません。", { ref }));
  }
  return r.block;
}

/** "題名.ポート名" を端点に解決する (connect 用)。親子関係は呼び出し側で面を決める */
/**
 * "<題名>.<ポート名>" を箱とポート名に分ける。題名やポート名にドットが含まれていてもよい
 * (例: "公開 (OSS).公開された Boxglow 1.0")。左から順にドットで区切ってみて、箱が見つかり、
 * できればその名前のポートがある区切りを選ぶ
 * Input : ref
 * Output: { blockId, portName }
 */
function resolveRef(p: Project, ref: string): { blockId: string; portName: string } {
  if (!ref.includes(".")) throw new Error(t("「{ref}」は <題名>.<ポート名> の形で指定してください", { ref }));
  const candidates: { blockId: string; portName: string; hasPort: boolean }[] = [];
  for (let i = ref.indexOf("."); i >= 0; i = ref.indexOf(".", i + 1)) {
    const title = ref.slice(0, i);
    const portName = ref.slice(i + 1);
    let blockId: string | null = null;
    // "project" は最初のプロジェクトの箱 (タスクはその中にあるので、最終成果物へはその箱の出力につなぐ)。最上位そのものは "root"
    if (title === "project") blockId = projectBlocks(p)[0]?.id ?? ROOT_ID;
    else if (title === ROOT_ID) blockId = ROOT_ID;
    else {
      const b = findBlock(p, title).block;
      if (b) blockId = b.id;
    }
    if (!blockId || !portName) continue;
    candidates.push({ blockId, portName, hasPort: portsOf(p, blockId).some((x) => x.name === portName) });
  }
  const best = candidates.find((c) => c.hasPort) ?? candidates[0];
  if (!best) throw new Error(t("「{ref}」の箱が見つかりません (<題名>.<ポート名> の形。題名は status に出る題名か B 番号)", { ref }));
  return { blockId: best.blockId, portName: best.portName };
}

/** 出力先 (既定は標準出力。MCP やテストでは文字列に集める) */
let sink: (text: string) => void = (text) => process.stdout.write(text);
const out = (text: string) => sink(text.endsWith("\n") ? text : text + "\n");

/**
 * CLI を関数として実行し、出力を文字列で返す (MCP サーバから使う。標準出力には何も書かない)
 * Input : argv = コマンドと引数 (process.argv.slice(2) と同じ形)
 * Output: 出力の文字列。失敗は例外
 */
export function runCli(argv: string[]): string {
  const prev = sink;
  let buf = "";
  sink = (text) => { buf += text; };
  try {
    main(argv);
    return buf;
  } finally {
    sink = prev;
  }
}

/**
 * 環境から言語を推す (init で計画に書き込む既定値)
 * Input : なし (LC_ALL / LC_MESSAGES / LANG を見る)
 * Output: 日本語の環境なら "ja"、それ以外は "en"
 */
function envLang(): Lang {
  const v = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "").toLowerCase();
  return v.startsWith("ja") ? "ja" : "en";
}

/** --lang / BOXGLOW_LANG の指定 (無ければ undefined) */
function explicitLang(options: ReturnType<typeof parseArgs>["options"]): Lang | undefined {
  const v = (str(options.lang) ?? process.env.BOXGLOW_LANG ?? "").toLowerCase();
  return v === "en" || v === "ja" ? v : undefined;
}

/**
 * 英語のヘルプ (help を英語で出すとき用)。内容はファイル先頭の doc コメント (日本語のヘルプ) と同じ
 * コマンドを足したり書式を変えたりしたら、先頭の doc コメントとここの両方を直すこと
 */
/** 日本語のヘルプ (束ねた bin/boxglow.js ではコメントが落ちるので、文字列として持つ) */
const HELP_JA = `
boxglow CLI: AI エージェント (Claude Code / Codex など) と人がリポジトリ内の boxglow.json を操作する入口

使い方 (npx boxglow <command> ...):
  init [--name <名前>] [--file <path>]           boxglow.json を作る
  setup-agent [--dir <path>]                     AI が自律的に使えるように設定する: AGENTS.md / CLAUDE.md に手順を追記、
                                                 Claude Code のスキル (.claude/skills/boxglow) と、セッション開始時に status を読むフックを入れる
  status [--json]                                全体の状況 (Markdown)
  export [--format md|json] [--out <path>]       計画全体を Markdown (または JSON) に書き出す (ロードマップの文書化に)
  show <block>                                   ブロックの詳細
  add <題名> [--parent <block>] [--out <出力名>] [--in <入力名>]... [--note <説明>] [--category <カテゴリ>]   (親を省略すると最初のプロジェクトの箱の中)
                                                 カテゴリ: study 検討 / research 調査 / design 設計 / ui デザイン / build 実装 / verify 検証 / evaluate 評価 / improve 改善 / fix 課題解決 / docs 文書 / ops 運用 / other その他
  project <名前>                                 プロジェクトの箱を最上位に足す (同じファイルで複数のプロジェクト) [--repo <パス>]  (複数リポジトリは boxglow.json を上のフォルダに置き、各リポジトリで BOXGLOW_FILE を指す)
  export-block <block> [--out <path>] [--tags "a,b"]   箱を下の階層ごとテンプレート (*.boxglow-block.json) に書き出す
  import-block <path> [--parent <block>]         テンプレートを挿入 (親を省略すると最初のプロジェクトの箱の中)
  split <block> --spec '<JSON>' | --spec-file <path>   下の階層にまとめて分解 (形式は docs/AGENTS_SNIPPET.md)
  move <block> --parent <block|project>            箱を別の親の中へ移す (線は間の箱のポートを経由してつながったまま)
  port <block|project> [--in <名前>]... [--out <名前>]... [--rename <旧名>=<新名>]   既存の箱に入力 / 出力を足す、名前を変える (project = 最初のプロジェクトの箱)
  disconnect <題名.出力名> <題名.入力名>          線を外す
  tidy                                              ファイルを規則にそろえて保存し直す (つないだ入力の名前を供給元に合わせる、大項目を畳む、重なりを解く)
  remove <block> [--force]                          箱を消す (中に箱があるときは --force。線も外れる。元に戻せないので Git で管理していること)
  serve [--port 4174] [--open]                      ローカルサーバ: 同梱の Web アプリを http://localhost:4174/?serve=1 で配信し、boxglow.json を読み書き (Firefox / Safari でも使える)
  mcp [--file <path>]                               MCP サーバ (標準入出力)。Claude Code などから status / start / done / ask ... をツールとして使う (.mcp.json は setup-agent が書く)
  connect <題名.出力名> <題名[.入力名]>           結線 (受け側は題名だけでよい: 出力名と同じ名前の入力を作ってつなぐ。親子は自動で内側の面。最終成果物へは project)
  start <block> [--note <何をするか>]            作業開始 (作業中になる)
  done <block> [--artifact <題名>=<URL またはパス>]... [--output <出力名>] [--note]   完了 (成果物を付けて white)
                                                 パスが Git 管理下なら「コミット + パス + blob」で記録する (アップロードしない)
  artifact <block> <URL またはパス> [--title <題名>] [--output <出力名>]   成果物だけ付ける (完了にはしない)
  check                                          Git の成果物が今も見つかるか確認し、移動していればパスを付け替える
  blocked <block> --note <困っていること>          詰まり
  review <block> [--note]                        確認待ち
  ask <block> <質問> [--options "A|B"] [--context <判断材料>]   人間に判断を求める (判断待ちになる)。質問だけで判断できるよう、前提・比較・影響を --context に書く
  decision <block> --id <decision id> [--question] [--options "A|B"] [--context]   未回答の判断を書き直す
  answer <block> <回答> [--id <decision id>] [--by <名前>]   判断に答える (既定は最新の未回答)
  ack <block> [--id <decision id>]                人の回答を読んで引き取ったと記録する (status の「回答あり」から消える。start / done / blocked / review / set / split / ask でも自動で引き取る)
  reopen <block> [--id <decision id>] [--note <理由>]   判断をやり直す (方針転換)。前の答えは履歴に、候補はそのまま残る
  set <block> [--status black|gray|white] [--progress 0..100|auto] [--title <題名>] [--note <説明>] [--category <カテゴリ>|none] [--repo <パス>|none] [--issue <URL>|none]
              [--start YYYY-MM-DD|none] [--due YYYY-MM-DD|none] [--estimate <時間>|none] [--hours <実績時間>|none]
  find <文字>                                    ID や題名で箱を探す
  group <名前>                                   最上位の入力グループを作る (例: "PCIe 仕様書")
  group-set <入力名> <グループ名|none>            最上位の入力をグループに入れる / 外す
  group-export <グループ名> [--out <path>]        グループを JSON に書き出す (他のプロジェクトで group-import)
  group-import <path>                            グループの JSON を読み込む
  leave <block>                                  活動を消す (作業を離れる)
  prompt <block> [--ask plan|decompose|review]    AI に渡す文脈 (Markdown)
  layout [block]                                 自動整列 (全体、または指定した箱の中)
  log [--n 20]                                   最近のログ
  validate                                       形式と結線の検査
  merge <base> <ours> <theirs>                    boxglow.json を箱・ポート・線の単位で 3 方向マージし <ours> に書く (Git のマージドライバ用)
  git-setup                                      このリポジトリの Git に merge ドライバを登録 (.gitattributes + git config)。以後 git merge / pull が自動で使う

  lang [ja|en]                                    計画の言語 (CLI の文言・ログ・AI 向け手順の言語) を見る / 変える。init は環境の言語で決める (--lang で指定可)
共通: --lang <ja|en> (既定: 計画の言語。環境変数 BOXGLOW_LANG でも可)
      --file <path> (既定: 上の階層へ boxglow.json を探す。環境変数 BOXGLOW_FILE でも可)
      --actor <名前> (既定: 環境変数 BOXGLOW_ACTOR、Claude Code なら claude-code、それ以外は agent)
<block> は短い ID (B12)、内部 id、または題名 (完全一致、または 1 つに決まる部分一致)。status に ID が出る
`;

const HELP_EN = `
boxglow CLI: the entry point for AI agents (Claude Code / Codex, etc.) and people to work with the boxglow.json in a repository

Usage (npx boxglow <command> ...):
  init [--name <name>] [--file <path>]           Create boxglow.json
  setup-agent [--dir <path>]                     Set things up so AI can use Boxglow on its own: append the instructions to AGENTS.md / CLAUDE.md,
                                                 install the Claude Code skill (.claude/skills/boxglow) and a hook that reads status at session start
  status [--json]                                Overall status (Markdown)
  export [--format md|json] [--out <path>]       Write the whole plan out as Markdown (or JSON) (for documenting the roadmap)
  show <block>                                   Details of a block
  add <title> [--parent <block>] [--out <output name>] [--in <input name>]... [--note <description>] [--category <category>]   (without a parent, goes inside the first project box)
                                                 Categories: study / research / design / ui / build / verify / evaluate / improve / fix / docs / ops / other
  project <name>                                 Add a project box at the top level (several projects in one file) [--repo <path>]  (for several repositories, put boxglow.json in a parent folder and point BOXGLOW_FILE at it from each repository)
  export-block <block> [--out <path>] [--tags "a,b"]   Write a box and everything under it out as a template (*.boxglow-block.json)
  import-block <path> [--parent <block>]         Insert a template (without a parent, goes inside the first project box)
  split <block> --spec '<JSON>' | --spec-file <path>   Break a box down into child boxes in one go (format: docs/AGENTS_SNIPPET.en.md)
  move <block> --parent <block|project>            Move a box into another parent (wires stay connected through the ports of the boxes in between)
  port <block|project> [--in <name>]... [--out <name>]... [--rename <old>=<new>]   Add inputs / outputs to an existing box, or rename them (project = the first project box)
  disconnect <title.output> <title.input>          Remove a wire
  tidy                                              Normalize the file and save it again (match connected input names to their source, collapse top-level items, resolve overlaps)
  remove <block> [--force]                          Delete a box (--force if it contains boxes. Its wires are removed too. This cannot be undone, so keep the file in Git)
  serve [--port 4174] [--open]                      Local server: serves the bundled web app at http://localhost:4174/?serve=1 and reads / writes boxglow.json (works in Firefox / Safari too)
  mcp [--file <path>]                               MCP server (stdio). Lets Claude Code and others use status / start / done / ask ... as tools (setup-agent writes .mcp.json)
  connect <title.output> <title[.input]>           Connect (the receiving side can be just a title: an input with the same name as the output is created and connected. Parent and child connect on the inner side automatically. Use project for the final deliverable)
  start <block> [--note <what you will do>]      Start work (becomes Working)
  done <block> [--artifact <title>=<URL or path>]... [--output <output name>] [--note]   Finish (attach artifacts and turn it white)
                                                 If the path is tracked by Git, it is recorded as "commit + path + blob" (nothing is uploaded)
  artifact <block> <URL or path> [--title <title>] [--output <output name>]   Attach an artifact only (does not finish the box)
  check                                          Check that Git artifacts can still be found, and update the path if they moved
  blocked <block> --note <what is blocking you>    Blocked
  review <block> [--note]                        Waiting for review
  ask <block> <question> [--options "A|B"] [--context <background>]   Ask a person to decide (becomes Needs decision). Put the assumptions, comparison and impact in --context so the question can be decided on its own
  decision <block> --id <decision id> [--question] [--options "A|B"] [--context]   Rewrite an unanswered decision
  answer <block> <answer> [--id <decision id>] [--by <name>]   Answer a decision (default: the latest unanswered one)
  ack <block> [--id <decision id>]                Record that you have read a person's answer and taken it on (removes it from "Answered" in status. start / done / blocked / review / set / split / ask also do this automatically)
  reopen <block> [--id <decision id>] [--note <reason>]   Reopen a decision (change of direction). The previous answer stays in the history and the options are kept
  set <block> [--status black|gray|white] [--progress 0..100|auto] [--title <title>] [--note <description>] [--category <category>|none] [--repo <path>|none] [--issue <URL>|none]
              [--start YYYY-MM-DD|none] [--due YYYY-MM-DD|none] [--estimate <hours>|none] [--hours <actual hours>|none]
  find <text>                                    Find boxes by ID or title
  group <name>                                   Create a top-level input group (e.g. "PCIe spec")
  group-set <input name> <group name|none>       Put a top-level input into a group / take it out
  group-export <group name> [--out <path>]       Write a group out as JSON (group-import it in another project)
  group-import <path>                            Read a group from JSON
  leave <block>                                  Clear the activity (leave the work)
  prompt <block> [--ask plan|decompose|review]    Context to hand to an AI (Markdown)
  layout [block]                                 Auto layout (everything, or inside the given box)
  log [--n 20]                                   Recent log
  validate                                       Check the format and the wiring
  merge <base> <ours> <theirs>                    3-way merge boxglow.json by box, port and wire, and write the result to <ours> (for the Git merge driver)
  git-setup                                      Register the merge driver in this repository's Git (.gitattributes + git config). git merge / pull then use it automatically

  lang [ja|en]                                    Show / change the plan's language (the language of CLI messages, the log and the AI instructions). init picks it from the environment (or --lang)
Common: --lang <ja|en> (default: the plan's language. The BOXGLOW_LANG environment variable also works)
      --file <path> (default: look for boxglow.json in parent folders. The BOXGLOW_FILE environment variable also works)
      --actor <name> (default: the BOXGLOW_ACTOR environment variable, claude-code under Claude Code, otherwise agent)
<block> is a short ID (B12), an internal id, or a title (exact match, or a partial match that identifies one box). status shows the IDs
`;

function main(argv: string[]): void {
  const { positional, options } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  // 言語: --lang / BOXGLOW_LANG > 計画の lang (読み込んだ後に決め直す) > 日本語。常駐 (mcp) では前の呼び出しの言語が残るので毎回決め直す
  setLang(explicitLang(options) ?? "ja");
  // 手順書とスキルは、決まった言語のものを使う (呼ぶ時点の言語で選ぶ)
  const AGENTS_SNIPPET = () => (getLang() === "en" ? AGENTS_SNIPPET_EN : AGENTS_SNIPPET_JA);
  const SKILL_MD = () => (getLang() === "en" ? SKILL_MD_EN : SKILL_MD_JA);
  if (!cmd || cmd === "help" || options.help) {
    // ヘルプは文字列の定数 (HELP_JA / HELP_EN) を出す
    // 言語の指定が無ければ、近くの計画の言語に合わせる (計画が無い・読めないときは日本語のまま)
    if (!explicitLang(options)) {
      try { setLang(load(locateFile(str(options.file))).lang ?? "ja"); } catch { /* 計画が無くてもヘルプは出す */ }
    }
    out((getLang() === "en" ? HELP_EN : HELP_JA).trim());
    return;
  }
  const actor = actorOf(str(options.actor));

  if (cmd === "init") {
    const path = locateFile(str(options.file), true);
    if (existsSync(path) && !options.force) throw new Error(t("{path} は既にあります (--force で上書き)", { path }));
    // 計画の言語を決めて書き込む: 指定があればそれ、無ければ環境の言語 (日本語の環境なら ja、それ以外は en)
    const lang = explicitLang(options) ?? envLang();
    setLang(lang);
    const p = createProject(str(options.name) ?? t("新しいプロジェクト"));
    p.lang = lang;
    save(path, p);
    out(t("作成: {path}", { path }));
    return;
  }

  const path = locateFile(str(options.file));
  let p = load(path);
  // 計画に書かれた言語で CLI の文言・ログを出す (同じ計画を触る AI と人が同じ言語になる)。指定があればそちらを優先
  setLang(explicitLang(options) ?? p.lang ?? "ja");

  switch (cmd) {
    case "status": {
      if (options.json) out(JSON.stringify(p, null, 2));
      else out(statusReport(p));
      return;
    }
    case "export": {
      const fmt = str(options.format) ?? "md";
      const text = fmt === "json" ? toJSON(p) + "\n" : projectToMarkdown(p);
      const target = str(options.out);
      if (target) { writeFileSync(target, text, "utf8"); out(t("書き出し: {target}", { target })); }
      else out(text);
      return;
    }
    case "show": {
      out(blockReport(p, mustFind(p, rest[0]).id));
      return;
    }
    case "setup-agent": {
      // AI エージェント側の設定を 1 回で入れる (何度実行しても同じ結果になるよう、印の間だけを書き換える)
      const root = str(options.dir) ? resolve(str(options.dir)!) : dirname(path);
      const BEGIN = "<!-- boxglow:begin -->";
      const END = "<!-- boxglow:end -->";
      // 同梱の指示書は前置きが付いているので、「---」で挟まれた本文だけを貼る
      const snippet = AGENTS_SNIPPET();
      const parts = snippet.split(/^---$/m);
      const body = (parts.length >= 3 ? parts.slice(1, -1).join("---") : snippet).trim();
      const block = `${BEGIN}\n${body}\n${END}\n`;
      const done: string[] = [];
      for (const name of ["AGENTS.md", "CLAUDE.md"]) {
        const f = join(root, name);
        const cur = existsSync(f) ? readFileSync(f, "utf8") : "";
        let next: string;
        if (cur.includes(BEGIN) && cur.includes(END)) next = cur.slice(0, cur.indexOf(BEGIN)) + block + cur.slice(cur.indexOf(END) + END.length + 1);
        else next = (cur ? cur.replace(/\s*$/, "\n\n") : "") + block;
        if (next !== cur) { writeFileSync(f, next, "utf8"); done.push(name); }
      }
      // Claude Code のスキル
      const skillDir = join(root, ".claude", "skills", "boxglow");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD(), "utf8");
      done.push(".claude/skills/boxglow/SKILL.md");
      // セッション開始時に計画を読むフック (Claude Code の settings.json に追記。他の設定は残す)
      const settingsPath = join(root, ".claude", "settings.json");
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) { try { settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch { settings = {}; } }
      const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
      const start = (hooks.SessionStart ?? []) as { hooks?: { type: string; command: string }[] }[];
      const cmd = "npx boxglow status";
      if (!start.some((h) => (h.hooks ?? []).some((x) => x.command === cmd))) {
        start.push({ hooks: [{ type: "command", command: cmd }] });
        hooks.SessionStart = start;
        settings.hooks = hooks;
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        done.push(".claude/settings.json (SessionStart: npx boxglow status)");
      }
      // MCP サーバの登録 (Claude Code はプロジェクトの .mcp.json を読む。他のサーバの設定は残す)
      const mcpPath = join(root, ".mcp.json");
      let mcp: { mcpServers?: Record<string, unknown> } = {};
      if (existsSync(mcpPath)) { try { mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as typeof mcp; } catch { mcp = {}; } }
      mcp.mcpServers = mcp.mcpServers ?? {};
      if (!mcp.mcpServers.boxglow) {
        mcp.mcpServers.boxglow = { command: "npx", args: ["boxglow", "mcp"] };
        writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n", "utf8");
        done.push(t(".mcp.json (MCP サーバ boxglow)"));
      }
      out(t("設定しました: {list}\nAI は作業の始まり・終わり・判断待ちを boxglow.json に記録し、セッションの最初に計画を読みます。人は画面 (boxglow.json を開く、または npx boxglow serve) で見て判断してください", { list: done.join(", ") }));
      return;
    }
    case "project": {
      const name = rest.join(" ");
      if (!name) throw new Error(t("<名前> を指定してください"));
      const r = addProjectBlock(p, name);
      if (str(options.repo)) r.project = updateBlock(r.project, r.blockId, { repo: str(options.repo) });
      save(path, r.project);
      out(t("プロジェクトの箱を追加: 「{name}」(id: {id})。全部で {count} 件", { name, id: r.blockId, count: projectBlocks(r.project).length }));
      return;
    }
    case "export-block": {
      const b = mustFind(p, rest[0]);
      const tags = str(options.tags) ? str(options.tags)!.split(/[,、]/).map((s) => s.trim()).filter(Boolean) : [];
      const tpl = extractTemplate(p, b.id, { tags });
      const target = str(options.out) ?? `${b.title.replace(/[\\/:*?"<>|\s]/g, "_")}.boxglow-block.json`;
      writeFileSync(target, JSON.stringify(tpl, null, 2) + "\n", "utf8");
      out(t("テンプレートを書き出し: {target} ({count} 個の子)", { target, count: tpl.root.children.length }));
      return;
    }
    case "import-block": {
      if (!rest[0]) throw new Error(t("<path> を指定してください"));
      const tpl = parseTemplate(readFileSync(rest[0], "utf8"));
      const parentId = str(options.parent) ? mustFind(p, str(options.parent)).id : defaultTaskParent(p);
      const r = instantiateTemplate(p, parentId, tpl, actor, nextFreePosition(p, parentId));
      save(path, r.project);
      out(t("挿入: 「{title}」(id: {id}) テンプレート {name} v{version}", { title: tpl.root.title, id: r.blockId, name: tpl.name, version: tpl.version }));
      return;
    }
    case "group": {
      const name = rest.join(" ");
      if (!name) throw new Error(t("<名前> を指定してください"));
      const r = addInputGroup(p, name);
      save(path, r.project);
      out(t("入力グループを追加: 「{name}」", { name }));
      return;
    }
    case "group-set": {
      const port = portsOf(p, ROOT_ID, "in").find((x) => x.name === rest[0]);
      if (!port) throw new Error(t("最上位の入力「{name}」が見つかりません ({list})", { name: rest[0] ?? "", list: portsOf(p, ROOT_ID, "in").map((x) => x.name).join(", ") }));
      const gname = rest.slice(1).join(" ");
      const gp = gname === "none" ? null : inputGroupsOf(p).find((g) => g.name === gname);
      if (gname !== "none" && !gp) throw new Error(t("グループ「{name}」がありません ({list})", { name: gname, list: inputGroupsOf(p).map((g) => g.name).join(", ") }));
      save(path, setInputGroup(p, port.id, gp ? gp.id : null));
      out(gp ? t("「{port}」を グループ「{group}」 へ", { port: port.name, group: gp.name }) : t("「{port}」を Inputs へ", { port: port.name })); // 行き先ごとに 1 文にする (訳しやすくするため。日本語の出力は同じ)
      return;
    }
    case "group-export": {
      const gp = inputGroupsOf(p).find((g) => g.name === rest.join(" "));
      if (!gp) throw new Error(t("グループが見つかりません"));
      const target = str(options.out) ?? `${gp.name.replace(/[\\/:*?"<>|\s]/g, "_")}.boxglow-inputs.json`;
      writeFileSync(target, exportInputGroup(p, gp.id) + "\n", "utf8");
      out(t("書き出し: {target}", { target }));
      return;
    }
    case "group-import": {
      if (!rest[0]) throw new Error(t("<path> を指定してください"));
      const r = importInputGroup(p, readFileSync(rest[0], "utf8"));
      save(path, r.project);
      out(t("読み込み: グループ「{name}」", { name: String(inputGroupsOf(r.project).find((g) => g.id === r.groupId)?.name) }));
      return;
    }
    case "find": {
      const hits = searchBlocks(p, rest.join(" "), 30);
      out(hits.length === 0 ? t("見つかりません") : hits.map((b) => `- ${b.key ?? ""} ${b.title} (id: ${b.id})`).join("\n"));
      return;
    }
    case "layout": {
      // 大項目は畳んだ前提で並べる (All は大項目までしか出さない)
      const q = rest[0] ? layoutScope(normalizeCollapsed(p), mustFind(p, rest[0]).id) : layoutAll(normalizeCollapsed(p));
      save(path, q);
      out(rest[0] ? t("整列: 「{title}」の中", { title: mustFind(p, rest[0]).title }) : t("整列: 全体"));
      return;
    }
    case "log": {
      out(logReport(p, Number(str(options.n) ?? 20)));
      return;
    }
    case "prompt": {
      const ask = (str(options.ask) ?? "plan") as "plan" | "decompose" | "review";
      out(blockToPrompt(p, mustFind(p, rest[0]).id, ask));
      return;
    }
    case "merge": {
      // Git のマージドライバ: %O (base) %A (ours) %B (theirs)。結果は ours に書く。終了コード 0 = 自動で合わせた
      const [basePath, oursPath, theirsPath] = rest;
      if (!basePath || !oursPath || !theirsPath) throw new Error(t("merge <base> <ours> <theirs> の 3 つを指定してください"));
      const read = (f: string): Project | null => { const text = readFileSync(f, "utf8"); return text.trim() ? fromJSON(text) : null; };
      const base = read(basePath);
      const ours = read(oursPath);
      const theirs = read(theirsPath);
      if (!ours || !theirs) throw new Error(t("ours / theirs が読めません"));
      const r = mergeProjects(base, ours, theirs);
      let q = r.project;
      // 両側で同じ項目を変えていた箇所は、相手の値をログに残す (後から見直せるように)
      for (const c of r.conflicts) {
        q = { ...q, log: [...q.log, { id: `m${Math.random().toString(36).slice(2, 10)}`, at: new Date().toISOString(), actor: "merge", kind: "note", message: t("マージで両側が変更: {path} (採用: {ours} / 相手: {theirs})", { path: c.path, ours: JSON.stringify(c.ours), theirs: JSON.stringify(c.theirs) }) }] };
      }
      writeFileSync(oursPath, toJSON(q) + "\n", "utf8");
      out(t("マージ: 相手の変更 {count} 件を取り込み", { count: r.merged }) + (r.conflicts.length ? t("、両側で変更が {count} 件 (自分の値を採用し、相手の値はログに記録)", { count: r.conflicts.length }) : ""));
      if (r.conflicts.length && options.strict) process.exitCode = 1;
      return;
    }
    case "git-setup": {
      // .gitattributes に merge=boxglow を書き、git config にドライバを登録する
      const root = dirname(path);
      const attrs = join(root, ".gitattributes");
      const line = "boxglow.json merge=boxglow";
      const cur = existsSync(attrs) ? readFileSync(attrs, "utf8") : "";
      if (!cur.split(/\r?\n/).includes(line)) writeFileSync(attrs, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + line + "\n", "utf8");
      execFileSync("git", ["config", "merge.boxglow.name", "Boxglow plan merge (box level)"], { cwd: root });
      execFileSync("git", ["config", "merge.boxglow.driver", "npx boxglow merge %O %A %B"], { cwd: root });
      out(t("登録しました: {attrs} に「{line}」、git config merge.boxglow.driver = \"npx boxglow merge %O %A %B\"\n以後 git merge / pull / rebase で boxglow.json は箱の単位で自動マージされます (チーム全員がこのコマンドを 1 回実行してください)", { attrs, line }));
      return;
    }
    case "validate": {
      const problems: string[] = [];
      for (const b of Object.values(p.blocks)) {
        if (b.id !== ROOT_ID && portsOf(p, b.id, "out").length === 0) problems.push(t("「{title}」に出力がありません", { title: b.title }));
      }
      for (const e of Object.values(p.edges)) {
        const c = validateConnection(p, e.from, e.to);
        if (!c.ok) problems.push(t("線 {id}: {reason}", { id: e.id, reason: String(c.reason) }));
      }
      // 計画の穴 (エラーではなく注意): つながっていない入出力、成果物の無い Done
      const warnings: string[] = [];
      const used = new Set<string>();
      for (const e of Object.values(p.edges)) { used.add(`${e.from.portId}:${e.from.side}`); used.add(`${e.to.portId}:${e.to.side}`); }
      for (const b of Object.values(p.blocks)) {
        if (b.id === ROOT_ID) continue;
        const hasKids = Object.values(p.blocks).some((x) => x.parentId === b.id);
        for (const q of portsOf(p, b.id)) {
          if (!used.has(`${q.id}:outer`) && !q.promotedFrom) warnings.push(t(q.direction === "in" ? "{key} 「{title}」の入力「{name}」がどこにもつながっていません" : "{key} 「{title}」の出力「{name}」がどこにもつながっていません", { key: b.key ?? "", title: b.title, name: q.name })); // 入力 / 出力で文を分ける (訳しやすくするため)
          if (hasKids && !used.has(`${q.id}:inner`)) warnings.push(t(q.direction === "in" ? "{key} 「{title}」の入力「{name}」が中の箱とつながっていません" : "{key} 「{title}」の出力「{name}」が中の箱とつながっていません", { key: b.key ?? "", title: b.title, name: q.name }));
        }
        if (b.status === "white" && !hasKids && portsOf(p, b.id, "out").every((q) => q.artifacts.length === 0)) warnings.push(t("{key} 「{title}」は Done ですが成果物がありません (--artifact で付けてください)", { key: b.key ?? "", title: b.title }));
      }
      const lines = [problems.length === 0 ? t("問題ありません") : problems.map((x) => "- " + x).join("\n")];
      if (warnings.length > 0) lines.push("", t("注意 ({count} 件。計画の穴):", { count: warnings.length }), ...warnings.map((x) => "- " + x));
      out(lines.join("\n"));
      if (problems.length > 0) process.exitCode = 1;
      return;
    }
    case "add": {
      const title = rest[0];
      if (!title) throw new Error(t("<題名> を指定してください"));
      const parentId = str(options.parent) ? mustFind(p, str(options.parent)).id : defaultTaskParent(p);
      const r = addBlock(p, { parentId, title, outputName: str(options.out), actor, position: nextFreePosition(p, parentId) });
      p = r.project;
      for (const name of list(options.in)) p = addPort(p, { blockId: r.blockId, direction: "in", name }).project;
      if (str(options.note)) p = updateBlock(p, r.blockId, { description: str(options.note)! });
      if (str(options.category)) p = setCategory(p, r.blockId, categoryKeyOf(str(options.category)!));
      save(path, p);
      out(t("追加: 「{title}」(id: {id})", { title, id: r.blockId }));
      return;
    }
    case "split": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      const specText = str(options["spec-file"]) ? readFileSync(str(options["spec-file"])!, "utf8") : str(options.spec);
      if (!specText) throw new Error(t("--spec '<JSON>' または --spec-file <path> を指定してください"));
      const spec = JSON.parse(specText);
      const r = splitBlock(p, b.id, spec, actor);
      save(path, layoutScope(r.project, b.id));
      out(t("分解: 「{title}」に {count} 個を追加", { title: b.title, count: spec.blocks.length }) + (r.errors.length ? "\n" + r.errors.map((x) => "- " + x).join("\n") : ""));
      return;
    }
    case "move": {
      const b = mustFind(p, rest[0]);
      const target = str(options.parent);
      if (!target) throw new Error(t("--parent <block|project> を指定してください"));
      const parentId = target === "project" ? defaultTaskParent(p) : mustFind(p, target).id;
      const q = moveBlockToParent(p, b.id, parentId, nextFreePosition(p, parentId));
      if (q === p) throw new Error(t("移せません (自分の子孫の中、プロジェクトの箱、同じ親などは不可)"));
      save(path, q);
      out(t("移動: 「{title}」を「{parent}」の中へ (線はつなぎ直しました)", { title: b.title, parent: q.blocks[parentId].title }));
      return;
    }
    case "port": {
      // 例: port B5 --in "仕様書" --out "設計書"   /   port project --rename "最終成果物=公開された Boxglow 1.0"
      const target = rest[0] ?? "";
      const blockId = target === "project" ? (projectBlocks(p)[0]?.id ?? ROOT_ID) : target === ROOT_ID ? ROOT_ID : mustFind(p, target).id;
      const added: string[] = [];
      for (const name of list(options.in)) { p = addPort(p, { blockId, direction: "in", name }).project; added.push(t("入力 {name}", { name })); }
      for (const name of list(options.out)) { p = addPort(p, { blockId, direction: "out", name }).project; added.push(t("出力 {name}", { name })); }
      for (const spec of list(options.rename)) {
        const eq = spec.indexOf("=");
        if (eq < 0) throw new Error(t("--rename は <旧名>=<新名> の形で指定してください: {spec}", { spec }));
        const from = spec.slice(0, eq);
        const to = spec.slice(eq + 1);
        const port = portsOf(p, blockId).find((x) => x.name === from);
        if (!port) throw new Error(t("ポート「{name}」が見つかりません", { name: from }));
        if (isInputNameLocked(p, port.id)) throw new Error(t("入力「{name}」の名前は供給元の出力名で決まります。供給元の出力の名前を変えてください (port <供給元> --rename)", { name: from }));
        p = updatePort(p, port.id, { name: to });
        added.push(`${from} -> ${to}`);
      }
      if (added.length === 0) throw new Error(t("--in <名前> / --out <名前> / --rename <旧名>=<新名> のいずれかを指定してください"));
      save(path, p);
      out(t("ポート: {title}: {list}", { title: p.blocks[blockId]?.title ?? "project", list: added.join(", ") }));
      return;
    }
    case "tidy": {
      const r = normalizeInputNames(p);
      save(path, r.project);
      out(t("そろえました: 入力の名前 {count} 件を供給元に合わせました", { count: r.renamed }));
      return;
    }
    case "remove": {
      const b = mustFind(p, rest[0]);
      if (b.kind === "project") throw new Error(t("プロジェクトの箱は消せません (中の箱を全部消すか、ファイルごと作り直してください)"));
      const kids = Object.values(p.blocks).filter((x) => x.parentId === b.id).length;
      if (kids > 0 && !options.force) throw new Error(t("「{title}」の中に {count} 個の箱があります。まとめて消すなら --force を付けてください", { title: b.title, count: kids }));
      const q = removeBlock(p, b.id);
      save(path, q);
      out(t("削除: 「{title}」", { title: b.title }) + (kids > 0 ? t(" と中の {count} 個の箱", { count: kids }) : "") + t(" (つながっていた線も外しました)"));
      return;
    }
    case "disconnect": {
      const a = resolveRef(p, rest[0] ?? "");
      const b = resolveRef(p, rest[1] ?? "");
      const aPorts = portsOf(p, a.blockId).filter((x) => x.name === a.portName).map((x) => x.id);
      const bPorts = portsOf(p, b.blockId).filter((x) => x.name === b.portName).map((x) => x.id);
      const hit = Object.values(p.edges).find((e) => aPorts.includes(e.from.portId) && bPorts.includes(e.to.portId));
      if (!hit) throw new Error(t("線が見つかりません: {from} -> {to}", { from: String(rest[0]), to: String(rest[1]) }));
      save(path, disconnect(p, hit.id));
      out(t("線を外しました: {from} -> {to}", { from: rest[0], to: rest[1] }));
      return;
    }
    case "connect": {
      const a = resolveRef(p, rest[0] ?? "");
      // 受け側が「題名」だけ (ポート名なし) なら、出す側の出力名で入力を作ってつなぐ (入力名を二重に書かなくてよい)
      if (!(rest[1] ?? "").includes(".")) {
        const tb = rest[1] === "project" ? p.blocks[projectBlocks(p)[0]?.id ?? ROOT_ID] : mustFind(p, rest[1]);
        const fromIsParent = tb.parentId === a.blockId;
        const fromPort = portsOf(p, a.blockId, fromIsParent ? "in" : "out").find((x) => x.name === a.portName);
        if (!fromPort) throw new Error(t("「{ref}」のポートが見つかりません", { ref: rest[0] }));
        const r = connectToBlock(p, { portId: fromPort.id, side: fromIsParent ? "inner" : "outer" }, tb.id);
        if (r.error) throw new Error(r.error);
        save(path, r.project);
        // つながった先のポート名を伝える (受け側が親なら親の出力、そうでなければ出力名と同じ入力)
        const edge = Object.values(r.project.edges).find((e) => e.from.portId === fromPort.id && !Object.values(p.edges).some((x) => x.id === e.id));
        const toPort = edge ? r.project.ports[edge.to.portId] : undefined;
        out(t("結線: {from} -> {to}", { from: rest[0], to: `${tb.title}.${toPort?.name ?? fromPort.name}` }) + (toPort?.direction === "out" ? t(" (親の出力)") : t(" (出力名と同じ入力を使いました)")));
        return;
      }
      const b = resolveRef(p, rest[1] ?? "");
      const fromBlock = p.blocks[a.blockId];
      const toBlock = p.blocks[b.blockId];
      // 面の決め方: 出す側が受ける側の親なら「親の入力 (内側)」、受ける側が出す側の親なら「親の出力 (内側)」
      const fromIsParent = toBlock.parentId === a.blockId;
      const toIsParent = fromBlock.parentId === b.blockId;
      const fromPort = portsOf(p, a.blockId, fromIsParent ? "in" : "out").find((x) => x.name === a.portName);
      const toPort = portsOf(p, b.blockId, toIsParent ? "out" : "in").find((x) => x.name === b.portName);
      if (!fromPort) throw new Error(t("「{ref}」のポートが見つかりません", { ref: rest[0] }));
      if (!toPort) throw new Error(t("「{ref}」のポートが見つかりません", { ref: rest[1] }));
      const from: Endpoint = { portId: fromPort.id, side: fromIsParent ? "inner" : "outer" };
      const to: Endpoint = { portId: toPort.id, side: toIsParent ? "inner" : "outer" };
      const r = connect(p, from, to);
      if (r.error) throw new Error(r.error);
      save(path, r.project);
      out(t("結線: {from} -> {to}", { from: rest[0], to: rest[1] }));
      return;
    }
    case "start": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      save(path, setActivity(p, b.id, actor, "working", str(options.note) ?? ""));
      out(t("開始: 「{title}」({actor})", { title: b.title, actor }));
      return;
    }
    case "blocked": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      save(path, setActivity(p, b.id, actor, "blocked", str(options.note) ?? ""));
      out(t("詰まり: 「{title}」", { title: b.title }));
      return;
    }
    case "review": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      save(path, setActivity(p, b.id, actor, "waiting_review", str(options.note) ?? ""));
      out(t("確認待ち: 「{title}」", { title: b.title }));
      return;
    }
    case "leave": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      save(path, clearActivity(p, b.id));
      out(t("活動を消しました: 「{title}」", { title: b.title }));
      return;
    }
    case "done": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      const artifacts = list(options.artifact).map((s) => artifactFrom(s));
      const r = finishBlock(p, b.id, actor, { artifacts, outputName: str(options.output), note: str(options.note) });
      if (r.error) throw new Error(r.error);
      save(path, r.project);
      out(t("完了: 「{title}」", { title: b.title }) + `${artifacts.length ? t(" 成果物: ") + artifacts.map((a) => a.title + (a.kind === "git" ? ` (git ${a.path} @ ${(a.commit ?? "").slice(0, 7)})` : "")).join(", ") : ""}`);
      // 成果物の無い完了は「何ができたか」が後から分からない。具体的な物 (ファイル・URL・コミット) を付けるよう促す
      if (artifacts.length === 0) out(t("注意: 成果物が付いていません。--artifact \"<名前>=<パスまたは URL>\" で、人が後から開ける具体的な物を付けてください"));
      return;
    }
    case "artifact": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      if (!rest[1]) throw new Error(t("<URL またはパス> を指定してください"));
      const a = artifactFrom(rest[1], str(options.title));
      const outs = portsOf(p, b.id, "out");
      const target = str(options.output) ? outs.find((o) => o.name === str(options.output)) : outs[0];
      if (!target) throw new Error(t("出力ポートが見つかりません"));
      save(path, updatePort(p, target.id, { artifacts: [...target.artifacts, a] }));
      out(t("成果物を付けました: 「{title}」.{port} <- {artifact}", { title: b.title, port: target.name, artifact: a.title }) + `${a.kind === "git" ? ` (git ${a.path} @ ${(a.commit ?? "").slice(0, 7)})` : ""}`);
      return;
    }
    case "check": {
      let changed = 0;
      const lines: string[] = [];
      for (const port of Object.values(p.ports)) {
        for (const a of port.artifacts) {
          if (a.kind !== "git") continue;
          const owner = p.blocks[port.blockId]?.title ?? "?";
          // コミットの無いリポジトリで記録した成果物 (commit が空) は、コミットされた後の check で補う
          if (!a.commit && a.path) {
            const ref = gitRefFor(resolve(dirname(path), a.path));
            if (ref?.commit) {
              a.commit = ref.commit;
              a.blob = ref.blob;
              if (ref.url) a.url = ref.url;
              a.state = "ok";
              a.checkedAt = new Date().toISOString();
              lines.push(t("- [補完] {owner}.{port} 「{title}」 {path} @ {commit}", { owner, port: port.name, title: a.title, path: a.path, commit: ref.commit.slice(0, 7) }));
              changed++;
              continue;
            }
          }
          const r = checkGitRef(a, dirname(path));
          if (r.state === "moved" && r.path) {
            lines.push(t("- [移動] {owner}.{port} 「{title}」 {from} -> {to}", { owner, port: port.name, title: a.title, from: String(a.path), to: r.path }));
            a.path = r.path;
            if (r.commit) a.commit = r.commit;
            if (r.blob) a.blob = r.blob;
            if (r.url) a.url = r.url;
            a.state = "moved";
            changed++;
          } else if (r.state === "missing") {
            lines.push(t("- [見つかりません] {owner}.{port} 「{title}」 {path} (コミット {commit} からは取り出せます: git show {commit}:{path})", { owner, port: port.name, title: a.title, path: String(a.path), commit: (a.commit ?? "").slice(0, 7) }));
            if (a.state !== "missing") changed++;
            a.state = "missing";
          } else {
            if (a.state !== "ok") changed++;
            a.state = "ok";
          }
          a.checkedAt = new Date().toISOString();
        }
      }
      save(path, p);
      out(lines.length === 0 ? t("Git の成果物はすべて見つかりました") : lines.join("\n"));
      if (changed > 0) out(t("{count} 件を更新しました", { count: changed }));
      return;
    }
    case "ask": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      const question = rest.slice(1).join(" ");
      if (!question) throw new Error(t("<質問> を指定してください"));
      const opts = str(options.options) ? str(options.options)!.split("|").map((s) => s.trim()).filter(Boolean) : [];
      const r = askDecision(p, b.id, actor, question, opts, str(options.context) ?? "");
      save(path, r.project);
      out(t("判断待ち: 「{title}」 {question} (decision: {id})", { title: b.title, question, id: String(r.decisionId) }));
      return;
    }
    case "decision": {
      const b = mustFind(p, rest[0]);
      const id = str(options.id) ?? [...b.decisions].reverse().find((d) => d.answer === undefined)?.id;
      if (!id) throw new Error(t("未回答の判断がありません (--id で指定)"));
      const patch: { question?: string; options?: string[]; context?: string } = {};
      if (str(options.question) !== undefined) patch.question = str(options.question);
      if (str(options.options) !== undefined) patch.options = str(options.options)!.split("|").map((s) => s.trim()).filter(Boolean);
      if (str(options.context) !== undefined) patch.context = str(options.context);
      const q = updateDecision(p, b.id, id, patch);
      if (q === p) throw new Error(t("書き直せません (回答済み、または見つかりません)"));
      save(path, q);
      out(t("判断を書き直しました: 「{title}」 (decision: {id})", { title: b.title, id }));
      return;
    }
    case "ack": {
      const b = mustFind(p, rest[0]);
      const q = ackDecisions(p, b.id, actor, str(options.id));
      if (q === p) { out(t("「{title}」に未確認の回答はありません", { title: b.title })); return; }
      save(path, q);
      out(t("回答を確認: 「{title}」", { title: b.title }));
      return;
    }
    case "answer": {
      const b = mustFind(p, rest[0]);
      const answer = rest.slice(1).join(" ");
      if (!answer) throw new Error(t("<回答> を指定してください"));
      const id = str(options.id) ?? [...b.decisions].reverse().find((d) => d.answer === undefined)?.id;
      if (!id) throw new Error(t("未回答の判断がありません"));
      save(path, answerDecision(p, b.id, id, answer, str(options.by) ?? (actor === "agent" ? "human" : actor)));
      out(t("回答: 「{title}」 {answer}", { title: b.title, answer }));
      return;
    }
    case "reopen": {
      const b = mustFind(p, rest[0]);
      const id = str(options.id) ?? [...b.decisions].reverse().find((d) => d.answer !== undefined)?.id;
      if (!id) throw new Error(t("やり直せる判断 (回答済み) がありません"));
      save(path, reopenDecision(p, b.id, id, actor, str(options.note) ?? ""));
      out(t("やり直し: 「{title}」の判断を未回答に戻しました (前の答えは履歴に残ります)", { title: b.title }));
      return;
    }
    case "set": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = その箱の回答を読んで引き取った
      if (str(options.status)) p = setStatus(p, b.id, str(options.status) as "black" | "gray" | "white", actor);
      if (str(options.progress) !== undefined) p = setProgress(p, b.id, str(options.progress) === "auto" ? null : Number(str(options.progress)), actor);
      const sched: { startDate?: string | null; dueDate?: string | null; estimateHours?: number | null; actualHours?: number | null } = {};
      const dateOf = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : v);
      const numOf = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : Number(v));
      if (str(options.start) !== undefined) sched.startDate = dateOf(str(options.start));
      if (str(options.due) !== undefined) sched.dueDate = dateOf(str(options.due));
      if (str(options.estimate) !== undefined) sched.estimateHours = numOf(str(options.estimate));
      if (str(options.hours) !== undefined) sched.actualHours = numOf(str(options.hours));
      for (const v of [sched.startDate, sched.dueDate]) if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(t("日付は YYYY-MM-DD で指定してください: {value}", { value: v }));
      if (Object.keys(sched).length > 0) p = setSchedule(p, b.id, sched, actor);
      const patch: { title?: string; description?: string } = {};
      if (str(options.title)) patch.title = str(options.title);
      if (str(options.note)) patch.description = str(options.note);
      if (Object.keys(patch).length > 0) p = updateBlock(p, b.id, patch);
      if (str(options.category) !== undefined) p = setCategory(p, b.id, str(options.category) === "none" ? null : categoryKeyOf(str(options.category)!));
      if (str(options.repo) !== undefined) p = updateBlock(p, b.id, { repo: str(options.repo) === "none" ? undefined : str(options.repo) });
      if (str(options.issue) !== undefined) p = updateBlock(p, b.id, { issue: str(options.issue) === "none" ? undefined : str(options.issue) }); // JIRA / Redmine などの課題 URL
      save(path, p);
      out(t("更新: 「{title}」", { title: p.blocks[b.id].title }));
      return;
    }
    case "lang": {
      // 計画の言語 (CLI の文言・ログ・AI 向け手順) を見る / 変える。変えた後は setup-agent をもう一度実行すると手順書も入れ替わる
      const v = (rest[0] ?? "").toLowerCase();
      if (!v) { out(p.lang ?? "ja"); return; }
      if (v !== "en" && v !== "ja") throw new Error(t("lang <ja|en> を指定してください"));
      p = { ...p, lang: v };
      setLang(v);
      save(path, p);
      out(t("言語: {lang}", { lang: v }));
      return;
    }
    default:
      throw new Error(t("知らないコマンドです: {cmd} (boxglow help で一覧)", { cmd }));
  }
}

// 入口: mcp と serve は常駐するので別扱い。それ以外は 1 回実行して終わる
const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  // MCP サーバ (標準入出力)。--file で計画の場所を指定できる (無ければカレントから上へ探す)
  const { options } = parseArgs(argv.slice(1));
  if (str(options.file)) process.env.BOXGLOW_FILE = resolve(str(options.file)!);
  if (str(options.lang)) process.env.BOXGLOW_LANG = str(options.lang)!; // ツールの説明の言語 (各コマンドの文言は計画の言語)
  startMcp(runCli).catch((e) => { console.error(`[boxglow mcp] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
} else if (argv[0] === "serve") {
  // ローカルサーバ: 同梱の Web アプリを配信し、boxglow.json を API で読み書きする (どのブラウザでも開ける)
  const { options } = parseArgs(argv.slice(1));
  try {
    // 言語を決める (main() を通らないのでここで行う): --lang / BOXGLOW_LANG > 計画の lang > 日本語
    setLang(explicitLang(options) ?? "ja");
    const file = locateFile(str(options.file));
    // 計画が読めなくてもサーバは今までどおり起動する (言語は上で決めたまま)
    try { setLang(explicitLang(options) ?? load(file).lang ?? "ja"); } catch { /* 読めないファイルは画面側で扱う */ }
    startServe({ file, port: Number(str(options.port) ?? 4174), dist: fileURLToPath(new URL("../dist/", import.meta.url)), open: !!options.open, log: out });
  } catch (e) {
    console.error(`[boxglow serve] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
} else {
  try {
    main(argv);
  } catch (e) {
    console.error(`[boxglow] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
