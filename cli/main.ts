import { runLifecycle } from "./sync/lifecycle";
import { selectSyncServer } from "./sync/server-config";
import { findClaimBlock, claimCommand, prepareClaimSave, type ClaimCommand } from "./claims";
import { covers, activeClaim, claimSummary, claimToken, claimsEnabled } from "../src/model/claims";
import { randomUUID } from "node:crypto";
import { actorOf } from "./actor";
/**
 * boxglow CLI: AI エージェント (Claude Code / Codex など) と人がリポジトリ内の boxglow.json を操作する入口
 *
 * コマンドの一覧と書式は、下の HELP_JA (日本語) と HELP_EN (英語) が正本 (help で出す文面)。
 * コマンドを足す・変えるときは両方を直す。
 */
import { fileURLToPath } from "node:url";
import { startMcp } from "./mcp";
import { startServe } from "./serve";
import { commitFile, describeLock, FileConflict, inspectLock, lockTokenOf, removeLock, revisionOf, sleepSync } from "./file-store";
import { briefReceipt, contextReceipt, isCurrentToken, requireContext } from "./context";
import { setupAgent } from "./setup-agent";
import { runSyncCommand, runWatchCommand } from "./sync/command";
import { runLogin, runLogout, runWhoami } from "./sync/login";
import { projectProblem } from "../src/model/validate-file";
import { APP_VERSION, SAVE_PROTOCOL } from "../src/model/version";
import { resumeSummary, resumeReport } from "../src/model/resume";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { updateDecision, moveBlockToParent, reopenDecision, disconnect, resolveChangedOverlaps, resolveAllOverlaps, setCategory, addBlock, addPort, addProjectBlock, answerDecision, askDecision, clearActivity, connect, createArtifact, createGitArtifact, createProject, defaultTaskParent, extractTemplate, findBlock, finishBlock, fromJSON, instantiateTemplate, parseTemplate, portsOf, projectBlocks, searchBlocks, setActivity, setProgress, setSchedule, setStatus, splitBlock, toJSON, updateBlock, updatePort, validateConnection, addInputGroup, exportInputGroup, importInputGroup, inputGroupsOf, setInputGroup, normalizeCollapsed, removeBlock, connectToBlock, isInputNameLocked, normalizeInputNames, ackDecisions, isHumanActor } from "../src/model/graph";
import { checkStart, checkDone, descriptionReminder, scopeEntries } from "../src/model/workflow";
import type { WorkScope, WorkflowPolicy } from "../src/model/types";
import type { Artifact } from "../src/model/types";
import { blockToPrompt } from "../src/model/export";
import { blockReport, logReport, statusReport } from "../src/model/report";
import { assignmentRows, type AssigneeTarget } from "../src/model/assignments";
import { addBranch, setInputAnyOf } from "../src/model/branch";
import { STATUS_LABEL } from "../src/model/status";
import { checkGitRef, findGitRef, gitRefFor } from "./git";
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

/**
 * 読んだときのリビジョン (絶対パス → 版の印。null = ファイルが無い前提)。
 * 保存のときに「読んだ後に他の誰かが書き換えていないか」を照合するために覚えておく (cli/file-store.ts の commitFile)
 */
const readRevisions = new Map<string, string | null>();

/**
 * この実行で最後に書いた計画の中身 (書いていなければ null)。
 * 操作のあとに「自分が書いた内容」から新しい確認トークンを作るために覚えておく
 * (ディスクを読み直すと、その間に他の人が書いた変更までトークンに含めてしまうので、読み直さない)
 */
let lastSavedText: string | null = null;
let claimRequest: ClaimCommand;

/** 書き込みの時点で他の変更とぶつかったとき (FileConflict)、最新を読み直してコマンドをやり直す回数の上限 */
const CONFLICT_RETRIES = 8;

/**
 * 計画を読む (読んだときのリビジョンを覚える)
 * Input : path = boxglow.json のパス
 * Output: fromJSON 済みの Project
 */
function load(path: string): Project {
  const text = readFileSync(path, "utf8");
  readRevisions.set(resolve(path), revisionOf(text));
  return fromJSON(text);
}

/**
 * 計画を書く (ロック + リビジョン照合 + 原子的な置換)
 * Input : path = boxglow.json のパス, p = 書く計画
 * Output: なし。読んだ後に他が書き換えていたら FileConflict、他が書き込み中なら FileBusy の例外 (どちらも書き込まない)
 */
function save(path: string, p: Project): void {
  // 画面と同じく、今回寸法や位置を変えたボックスだけ重なりを解く。
  // 大項目は常に畳んだ状態 (All の図は大項目までしか出さず、中はタブで見る。大きさもこの前提で計算する)
  // つないだ入力の名前は供給元にそろえる (古いファイルの食い違いもここで直る)
  // 読んでいないパス (新規作成) は「ファイルが無い」ことを前提にする
  const expected = readRevisions.has(resolve(path)) ? readRevisions.get(resolve(path))! : null;
  const normalized = normalizeCollapsed(normalizeInputNames(p).project);
  let text = toJSON(normalized) + "\n";
  const warnings:string[]=[];
  const revision = commitFile(path, text, expected, { prepare: (current) => {
    // ロック取得・リビジョン照合後の原本と比較する。受け持ち検証には補正後の差分を渡す。
    const next = current
      ? resolveChangedOverlaps(normalizeCollapsed(fromJSON(current)), normalized, blockSize)
      : resolveAllOverlaps(normalized, blockSize);
    text = prepareClaimSave(current, toJSON(next) + "\n", claimRequest, warning => warnings.push(warning));
    return text;
  } });
  for(const warning of warnings) out(warning);
  // 同じ実行の中で続けて書く場合に備えて、書いた後の版を覚え直す
  readRevisions.set(resolve(path), revision);
  // 書いた中身を覚える (新しい確認トークンの元にする)
  lastSavedText = text;
}

/** 書き出し先が受け持ち制御中の計画なら停止。通常の保存検証を経ない上書きを防ぐ。 */
function writeExport(target: string, text: string): void {
  let guarded=false;
  if(existsSync(target)) {
    try { guarded=claimsEnabled(fromJSON(readFileSync(target,"utf8"))); } catch { /* 計画以外の出力ファイル */ }
  }
  if(guarded) throw new Error(t("受け持ち制御中の計画へ書き出しで上書きできません。別の出力先を指定してください。"));
  writeFileSync(target,text,"utf8");
}

/** ブロックを探す (見つからなければ候補を示して終了) */
function mustFind(p: Project, ref: string | undefined, what = "block") {
  if (!ref) throw new Error(t("<{what}> を指定してください (id または題名)", { what }));
  const rootClaim=ref===ROOT_ID && claimsEnabled(p) && ["context","start","leave","checkpoint","claim-renew","claim-release"].includes(claimRequest.command);
  const r = rootClaim ? findClaimBlock(p,ref) : findBlock(p, ref);
  if (!r.block) {
    // 文を組み立てずに、場合ごとに 1 文ずつ訳せる形にする (候補あり = 1 つに決まらない / 候補なし = 見つからない)
    if (r.candidates.length > 0) throw new Error(t("ブロック「{ref}」が1 つに決まりません。 候補: {list}", { ref, list: r.candidates.map((b) => `${b.title} (id: ${b.id})`).join(", ") }));
    throw new Error(t("ブロック「{ref}」が見つかりません。", { ref }));
  }
  return r.block;
}

/** "題名.ポート名" を端点に解決する (connect 用)。親子関係は呼び出し側で面を決める */
/**
 * "<題名>.<ポート名>" をボックスとポート名に分ける。題名やポート名にドットが含まれていてもよい
 * (例: "公開 (OSS).公開された Boxglow 1.0")。左から順にドットで区切ってみて、ボックスが見つかり、
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
    // "project" は最初のプロジェクトのボックス (タスクはその中にあるので、最終成果物へはそのボックスの出力につなぐ)。最上位そのものは "root"
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
  if (!best) throw new Error(t("「{ref}」のボックスが見つかりません (<題名>.<ポート名> の形。題名は status に出る題名か B 番号)", { ref }));
  return { blockId: best.blockId, portName: best.portName };
}

/** 出力先 (既定は標準出力。MCP やテストでは文字列に集める) */
let sink: (text: string) => void = (text) => process.stdout.write(text);
const out = (text: string) => sink(text.endsWith("\n") ? text : text + "\n");

/**
 * コマンドを 1 回実行する。書く時点で計画が他の変更で更新されていたら (FileConflict)、最新を読み直して最初からやり直す
 * CLI の 1 コマンドは「読む → 変える → 書く」なので、複数の AI や人が同時に実行すると、後から書く側は古い内容を元にしている。
 * やり直せば最新の内容に自分の変更を重ねられる (やり直さないと、同時に実行したうちの 1 本しか成功しない)
 * Input : argv = コマンドと引数, onRetry = やり直す直前に呼ぶ関数 (溜めた出力を捨てる)
 * Output: なし。CONFLICT_RETRIES 回やり直してもぶつかるときは FileConflict を投げる。それ以外の例外はそのまま伝える
 */
function mainWithRetry(argv: string[], onRetry: () => void): void {
  for (let attempt = 0; ; attempt++) {
    try {
      main(argv);
      return;
    } catch (e) {
      if (!(e instanceof FileConflict) || attempt >= CONFLICT_RETRIES) throw e;
      onRetry();
      // 同時に走っている相手と同じ間隔でぶつかり続けないよう、待つ時間をばらつかせる
      sleepSync(5 + Math.floor(Math.random() * 25 * (attempt + 1)));
    }
  }
}

/**
 * CLI を関数として実行し、出力を文字列で返す (MCP サーバから使う。標準出力には何も書かない)
 * Input : argv = コマンドと引数 (process.argv.slice(2) と同じ形)
 * Output: 出力の文字列。失敗は例外
 */
export function runCli(argv: string[]): string {
  const prev = sink;
  // 終了コードはこの呼び出しの分だけを見る (常駐する MCP サーバで、前の失敗の終了コードが残らないように元に戻す)
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let buf = "";
  sink = (text) => { buf += text; };
  try {
    // 他の変更とぶつかったら、溜めた出力を捨てて最初からやり直す
    mainWithRetry(argv, () => { buf = ""; process.exitCode = undefined; });
    // コマンドが失敗の終了コードを立てたら (validate の問題あり、merge --strict の競合など)、出力を付けて失敗として返す
    if (process.exitCode) throw new Error(buf.trim());
    return buf;
  } finally {
    sink = prev;
    process.exitCode = previousExitCode;
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
  setup-agent [--agent codex|claude-code|all] [--dir <path>]                     AI が自律的に使えるように設定する: AGENTS.md / CLAUDE.md に手順を追記、
                                                 Codex は AGENTS.md と .agents/skills、Claude Code は CLAUDE.md・スキル・フック・.mcp.json (既定: all)
  claims                                        受け持ち一覧 (自分・他者・期限切れ)
  claim-policy --mode reject|warn|off [--minutes 30] --actor human  計画ごとの有効化 (人の操作)
  start <block> --instance <固定ID> [--scope subtree]              取得、受領証 CLAIM を表示
  claim-renew <block> --instance <固定ID> --claim-token <受領証>    期限を延長
  claim-release <block> --reason <理由> --actor human              人が強制解除
  受け持ち有効時: 保存する操作に --instance と --claim-token。通常の start は block 範囲。
  focus/groupなど計画設定: context root → start root で取得、終了は leave root。
  自動で引き上げる入力は元のボックスの範囲。他者の実行ID・受領証を借りない。
  checkpoint は延長、done/leave は解放。同じ共有ファイルの協調制御。別端末の同期は排他しない。
  resume [--json] [--include-completed]           現況・着手できる候補・入力待ちを表示。完了済みの引き継ぎは件数のみ (指定で展開)
  scope <block> [--goal <本文>] [--non-goals <本文>] [--acceptance <本文>] [--consult <本文>]
                                                 今回達成すること / 対象外 / 完了条件 / 相談条件。省略は表示、none で項目を消す
  focus [<block>|none]                           今回優先するボックスとその配下を指定 (候補内で着手可・入力待ちを区別)。省略は表示
  policy [--start warn|reject] [--done warn|reject]  入力待ちの開始 / 成果物なしの完了。既定 warn。人の操作は拒否しない
                                                 reject の start も --reason があれば通す。done は既存の出力成果物も数える。set --status white にも適用
                                                 guard 有効時の scope 設定・focus 設定・policy 設定は --context-token が必要
  context <block> [--brief]                      ボックスのコンテキスト (親と入力元の説明・判断・入出力の条件・引き継ぎ) と確認トークン contextToken を JSON で出す
                                                 --brief = 短い形: 対象の情報は全部、親・上流は題名・状態・有効な判断・対象につながる出力だけ。省いたものの件数と取り方を出す (確認トークンは同じ)
  checkpoint <block> --note <メモ>               引き継ぎメモ (分かったこと・次の手順・未解決の点) を計画に残す。中断や引き継ぎの前に使う
  guard on|off                                   確認トークンの要求を有効 / 無効にする (setup-agent は有効にする)。有効な間、AI の start / done / set / split / artifact / ack /
                                                 blocked / review / leave / checkpoint は --context-token <context で得た contextToken> が要る (読んだ後に指示・回答・引き継ぎが変わっていたら拒否)。
                                                 人 (--actor human) には要求しない。AI が off にするときは --context-token が要る
  version [--json]                               boxglow の版と、保存の取り決めの版を出す (--version でも可)
  sync [--server <URL>] [--project <ID>] [--watch] [--actor human]  (試験中) 計画のファイルを同期サーバーとそろえる。初回は人が --actor human で結び付ける (--server で送り先を上書き)。止まったら理由と次の操作を表示
                                                 競合: --resolve <印> --block <内部ID>=local|remote (繰り返し可) / --settings local|remote
                                                 共通JSON: --choices-file <ファイル>。一括選択: --resolve <印> --prefer local|remote
                                                 --watch = 常時の同期 (Ctrl+C で終了。この端末の、同じサーバーに結び付いた計画すべてを受け持つ)
                                                 --adopt <印> = 消えた設定の削除を採って送る / --restore <印> = 消えた設定を手元に戻す
                                                 --resolve <印> --prefer local|remote = 競合を手元 / サーバーの値に決める / --link <印> --prefer local|remote = 初回に中身が違うときの選択
                                                 --recover <印> --applied|--not-applied = 途中で終わった受け取りを続ける
                                                 --relink <印> [--prefer local|remote] = サーバーの履歴が変わって止まった後に、見比べて選んで結び直す
                                                 --account <利用者の ID> = 利用者の記録が無い結び付けを、表示された利用者のものとして続ける
  sync --reconnect-restored <印> --actor human   削除記録の復元先へ結び直し、手元の未送信編集と比較する
  remote trash | delete|restore <ID> [--server URL]  削除済み一覧 / 削除・復元の確認。確定は --confirm <印> --actor human
  login [--server <URL>] [--name <端末の名前>]   (試験中) 同期サーバーにサインインする (GitHub のアカウント。表示されたコードを、ブラウザで入力する)
  logout [--server <URL>] / whoami [--server <URL>]  サインアウトする (サーバー側のトークンも取り消す) / 今の利用者・端末・保存量を出す
  unlock [--remove --lock-token <印> --actor human]  残った保存ロックの状態 (持ち主・判定) を出す (読むだけ。AI も使える)。--remove は人が解除する:
                                                 この計画を開いている Boxglow を止めてから、表示された印を付けて実行する。持ち主が動いているロックは解除できない
  status [--brief] [--json]                     全体の状況 (Markdown)。--brief は全階層を省略し、判断・回答・活動・次の候補を表示
  export [--format md|json] [--out <path>]       計画全体を Markdown (または JSON) に書き出す (ロードマップの文書化に)
  show <block>                                   ブロックの詳細
  add <題名> [--parent <block>] [--out <出力名>] [--in <入力名>]... [--note <説明>] [--category <カテゴリ>]   (親を省略すると最初のプロジェクトのボックスの中)
                                                 カテゴリ: study 検討 / research 調査 / design 設計 / ui デザイン / build 実装 / verify 検証 / evaluate 評価 / improve 改善 / fix 課題解決 / docs 文書 / ops 運用 / other その他
  project <名前>                                 プロジェクトのボックスを最上位に足す (同じファイルで複数のプロジェクト) [--repo <パス>]  (複数リポジトリは boxglow.json を上のフォルダに置き、各リポジトリで BOXGLOW_FILE を指す)
  export-block <block> [--out <path>] [--tags "a,b"]   ボックスを下の階層ごとテンプレート (*.boxglow-block.json) に書き出す
  import-block <path> [--parent <block>]         テンプレートを挿入 (親を省略すると最初のプロジェクトのボックスの中)
  split <block> --spec '<JSON>' | --spec-file <path>   下の階層にまとめて分解 (形式は docs/AGENTS_SNIPPET.md)
  branch <題名> --options "A|B" | --option <A> --option <B> [--question <問い>] [--context <判断材料>] [--in <入力名>]... [--parent <block>]   まだ決まっていない分かれ道 (分岐) を足す。選択肢ごとに道 (出力) ができ、answer で答えると選ばなかった道は見送り
  move <block> --parent <block|project>            ボックスを別の親の中へ移す (線は間のボックスのポートを経由してつながったまま)
  port <block|project> [--in <名前>]... [--out <名前>]... [--rename <旧名>=<新名>] [--any-of <入力名>]... [--all-of <入力名>]...   既存のボックスに入力 / 出力を足す、名前を変える。--any-of で合流の入力 (どれか 1 つが届けばよい) にする (project = 最初のプロジェクトのボックス)
  disconnect <題名.出力名> <題名.入力名>          線を外す
  tidy                                              ファイルを規則にそろえて保存し直す (つないだ入力の名前を供給元に合わせる、大項目を畳む、重なりを解く)
  remove <block> [--force]                          ボックスを消す (中にボックスがあるときは --force。線も外れる。元に戻せないので Git で管理していること)
  serve [--port 4174] [--open] [--sync|--no-sync]             ローカルサーバ: 同梱の Web アプリを http://localhost:4174/?serve=1 で配信し、boxglow.json を読み書き (Firefox / Safari でも使える)
                                                 通常は「同期を始める」から開始。--sync = 明示有効化、--no-sync = 無効。送り先は --server > BOXGLOW_SERVER > 既存の結び付け > 製品既定。空/off も無効
  mcp [--file <path>]                               MCP サーバ (標準入出力)。Claude Code などから status / start / done / ask ... をツールとして使う (.mcp.json は setup-agent が書く)
  connect <題名.出力名> <題名[.入力名]>           結線 (受け側は題名だけでよい: 出力名と同じ名前の入力を作ってつなぐ。親子は自動で内側の面。最終成果物へは project)
  start <block> [--note <何をするか>] [--reason <理由>]  入力待ちは既定で警告。理由を記録すると警告なしで開始
  done <block> [--artifact <題名>=<URL またはパス>]... [--output <出力名>] [--note]   完了 (成果物を付けて white)
                                                 パスが Git 管理下なら「コミット + パス + blob」で記録する (アップロードしない)
  artifact <block> <URL またはパス> [--title <題名>] [--output <出力名>]   成果物だけ付ける (完了にはしない)
  check                                          Git の成果物が今も見つかるか確認し、移動していればパスを付け替える。未コミットのときに記録した成果物は、コミット済みになっていれば Git の参照に補完する
  blocked <block> --note <困っていること>          詰まり
  review <block> [--note]                        確認待ち
  ask <block> <質問> [--options "A|B"] [--context <判断材料>]   人間に判断を求める (判断待ちになる)。質問だけで判断できるよう、前提・比較・影響を --context に書く
  decision <block> --id <decision id> [--question] [--options "A|B"] [--context]   未回答の判断を書き直す
  answer <block> <回答> [--id <decision id>] [--by <名前>]   判断に答える (既定は最新の未回答)
  ack <block> [--id <decision id>]                人の回答を読んで引き取ったと記録する (status の「回答あり」から消える。start / done / blocked / review / set / split でも自動で引き取る)
  reopen <block> [--id <decision id>] [--note <理由>]   判断をやり直す (方針転換)。前の答えは履歴に、候補はそのまま残る
  set <block> [--status black|gray|white] [--progress 0..100|auto] [--title <題名>] [--note <説明>] [--category <カテゴリ>|none] [--repo <パス>|none] [--issue <URL>|none]
              [--start YYYY-MM-DD|none] [--due YYYY-MM-DD|none] [--estimate <時間>|none] [--hours <実績時間>|none]
  find <文字>                                    ID や題名でボックスを探す
  list --assignee <名前> | --unassigned | --everyone [--all] [--json]   担当の一覧を表で出す (既定は未完了だけ。--all で完了済みも。並びは期日の近い順)
  group <名前>                                   最上位の入力グループを作る (例: "PCIe 仕様書")
  group-set <入力名> <グループ名|none>            最上位の入力をグループに入れる / 外す
  group-export <グループ名> [--out <path>]        グループを JSON に書き出す (他のプロジェクトで group-import)
  group-import <path>                            グループの JSON を読み込む
  leave <block>                                  活動を消す (作業を離れる)
  prompt <block> [--ask plan|decompose|review]    AI に渡す文脈 (Markdown)
  layout [block]                                 自動整列 (全体、または指定したボックスの中)
  log [--n 20]                                   最近のログ
  validate                                       形式と結線の検査
  merge <base> <ours> <theirs>                    boxglow.json をボックス・ポート・線の単位で 3 方向マージし <ours> に書く (Git のマージドライバ用)
  git-setup                                      このリポジトリの Git に merge ドライバを登録 (.gitattributes + git config)。以後 git merge / pull が自動で使う

  lang [ja|en]                                    計画の言語 (CLI の文言・ログ・AI 向け手順の言語) を見る / 変える。init は環境の言語で決める (--lang で指定可)
共通: --lang <ja|en> (既定: 計画の言語。環境変数 BOXGLOW_LANG でも可)
      --context-token <token> (guard が有効な計画で、AI が作業を記録するコマンドに付ける。context <block> の contextToken。
                               自分の操作でコンテキストが変わると、出力の最後に「新しい確認トークン: <token>」が出るので、次の操作にはそれを使う。
                               ask / decision / answer / reopen は付けなくても動くが、付けると新しい確認トークンが出る)
      --file <path> (既定: 上の階層へ boxglow.json を探す。環境変数 BOXGLOW_FILE でも可)
      --actor <名前> (既定: 環境変数 BOXGLOW_ACTOR、Claude Code なら claude-code、Codex なら codex、それ以外は agent)
<block> は短い ID (B12)、内部 id、または題名 (完全一致、または 1 つに決まる部分一致)。status に ID が出る
`;

const HELP_EN = `
boxglow CLI: the entry point for AI agents (Claude Code / Codex, etc.) and people to work with the boxglow.json in a repository

Usage (npx boxglow <command> ...):
  init [--name <name>] [--file <path>]           Create boxglow.json
  setup-agent [--agent codex|claude-code|all] [--dir <path>]                     Set things up so AI can use Boxglow on its own: append the instructions to AGENTS.md / CLAUDE.md,
                                                 Codex: AGENTS.md and .agents/skills. Claude Code: CLAUDE.md, skill, hook and .mcp.json (default: all)
  claims                                        Claims grouped by own/others/expired
  claim-policy --mode reject|warn|off [--minutes 30] --actor human  Opt in per plan (human)
  start <block> --instance <fixed-ID> [--scope subtree]             Acquire; prints CLAIM receipt
  claim-renew <block> --instance <fixed-ID> --claim-token <receipt>  Renew expiry
  claim-release <block> --reason <reason> --actor human             Human force release
  When enabled, writes require --instance and --claim-token. Default start scope: block.
  Plan settings (focus/group): context root → start root; release with leave root.
  Promoted inputs use the original box scope. Never borrow another instance ID or receipt.
  checkpoint renews; done/leave releases. Coordination for one shared file, not a distributed lease.
  resume [--json] [--include-completed]           Current work, ready/waiting candidates, then handoffs; completed notes are counted unless requested
  scope <block> [--goal <text>] [--non-goals <text>] [--acceptance <text>] [--consult <text>]
                                                 Goal / non-goals / acceptance / consult before expansion. No flags reads; none clears a field
  focus [<block>|none]                           Prioritize this box and descendants, separating ready/waiting within each scope. No argument reads
  policy [--start warn|reject] [--done warn|reject]  Missing-input starts / artifact-free completion; default warn. Human actions are never rejected
                                                 A start reason overrides reject. Existing output artifacts count for done; set --status white also checks policy
                                                 With guard on, scope/focus/policy writes require --context-token
  context <block> [--brief]                      Print a box's context (descriptions, decisions, input/output contracts and handoff notes of its parents and input providers) and its contextToken as JSON
                                                 --brief = short form: everything about the box itself; parents and input providers reduced to title, status, answered decisions and the outputs feeding it; says what was left out (same contextToken)
  checkpoint <block> --note <note>               Save a handoff note (findings, next steps, unresolved questions) in the plan. Use it before an interruption or a handoff
  guard on|off                                   Turn the context-token requirement on / off (setup-agent turns it on). While on, an AI's start / done / set / split / artifact / ack /
                                                 blocked / review / leave / checkpoint need --context-token <contextToken from context> (rejected if instructions, answers or handoff notes changed after reading).
                                                 People (--actor human) are not asked for it. An AI needs --context-token to turn it off
  version [--json]                               Print the boxglow version and the save-protocol version (--version also works)
  sync [--server <URL>] [--project <ID>] [--watch] [--actor human]  (experimental) Bring the plan file in line with a sync server. A human binds with --actor human the first time (--server overrides the destination). When it stops, it prints why and what to do
                                                 Conflicts: --resolve <token> --block <internal-id>=local|remote (repeatable) / --settings local|remote
                                                 Shared JSON: --choices-file <file>. All groups: --resolve <token> --prefer local|remote
                                                 --watch = keep syncing (Ctrl+C to stop; covers every plan on this machine bound to the same server)
                                                 --adopt <token> = send the deletion of settings / --restore <token> = put the deleted settings back locally
                                                 --resolve <token> --prefer local|remote = settle conflicts / --link <token> --prefer local|remote = choose a side on first link
                                                 --recover <token> --applied|--not-applied = continue an interrupted pull
                                                 --relink <token> [--prefer local|remote] = after the server's history changed: compare, choose and bind again
                                                 --account <account id> = continue a binding that has no account recorded, as the account shown
  sync --reconnect-restored <token> --actor human  Reconnect the original file to its restored plan and compare unsent edits
  remote trash | delete|restore <ID> [--server URL]  List trash / preview delete or restore; confirm with --confirm <token> --actor human
  login [--server <URL>] [--name <device name>]  (experimental) Sign in to a sync server (GitHub account; enter the code shown in your browser)
  logout [--server <URL>] / whoami [--server <URL>]  Sign out (also revokes the token on the server) / show the current account, devices and storage
  unlock [--remove --lock-token <token> --actor human]  Show a leftover save lock (owner and verdict; read-only, agents may use it). --remove is for a person:
                                                 stop every Boxglow that has this plan open, then run it with the token shown. A lock whose owner is running cannot be removed
  status [--brief] [--json]                     Overall status (Markdown). --brief omits the tree; keeps decisions, answers, activity and next actions
  export [--format md|json] [--out <path>]       Write the whole plan out as Markdown (or JSON) (for documenting the roadmap)
  show <block>                                   Details of a block
  add <title> [--parent <block>] [--out <output name>] [--in <input name>]... [--note <description>] [--category <category>]   (without a parent, goes inside the first project box)
                                                 Categories: study / research / design / ui / build / verify / evaluate / improve / fix / docs / ops / other
  project <name>                                 Add a project box at the top level (several projects in one file) [--repo <path>]  (for several repositories, put boxglow.json in a parent folder and point BOXGLOW_FILE at it from each repository)
  export-block <block> [--out <path>] [--tags "a,b"]   Write a box and everything under it out as a template (*.boxglow-block.json)
  import-block <path> [--parent <block>]         Insert a template (without a parent, goes inside the first project box)
  split <block> --spec '<JSON>' | --spec-file <path>   Break a box down into child boxes in one go (format: docs/AGENTS_SNIPPET.en.md)
  branch <title> --options "A|B" | --option <A> --option <B> [--question <question>] [--context <background>] [--in <input name>]... [--parent <block>]   Add an undecided fork (branch). Each option gets a path (output); answering it with answer skips the paths not chosen
  move <block> --parent <block|project>            Move a box into another parent (wires stay connected through the ports of the boxes in between)
  port <block|project> [--in <name>]... [--out <name>]... [--rename <old>=<new>] [--any-of <input>]... [--all-of <input>]...   Add inputs / outputs to an existing box, or rename them. --any-of makes inputs a merge (any one of them is enough) (project = the first project box)
  disconnect <title.output> <title.input>          Remove a wire
  tidy                                              Normalize the file and save it again (match connected input names to their source, collapse top-level items, resolve overlaps)
  remove <block> [--force]                          Delete a box (--force if it contains boxes. Its wires are removed too. This cannot be undone, so keep the file in Git)
  serve [--port 4174] [--open] [--sync|--no-sync]             Local server: serves the bundled web app at http://localhost:4174/?serve=1 and reads / writes boxglow.json (works in Firefox / Safari too)
                                                 Normally use Start syncing in the UI. --sync enables; --no-sync disables. Server: --server > BOXGLOW_SERVER > existing binding > product default. Empty/off also disables.
  mcp [--file <path>]                               MCP server (stdio). Lets Claude Code and others use status / start / done / ask ... as tools (setup-agent writes .mcp.json)
  connect <title.output> <title[.input]>           Connect (the receiving side can be just a title: an input with the same name as the output is created and connected. Parent and child connect on the inner side automatically. Use project for the final deliverable)
  start <block> [--note <what you will do>] [--reason <reason>]  Missing inputs warn by default; a recorded reason allows starting without a warning
  done <block> [--artifact <title>=<URL or path>]... [--output <output name>] [--note]   Finish (attach artifacts and turn it white)
                                                 If the path is tracked by Git, it is recorded as "commit + path + blob" (nothing is uploaded)
  artifact <block> <URL or path> [--title <title>] [--output <output name>]   Attach an artifact only (does not finish the box)
  check                                          Check that Git artifacts can still be found, and update the path if they moved. Artifacts recorded while uncommitted become Git references once they are committed
  blocked <block> --note <what is blocking you>    Blocked
  review <block> [--note]                        Waiting for review
  ask <block> <question> [--options "A|B"] [--context <background>]   Ask a person to decide (becomes Needs decision). Put the assumptions, comparison and impact in --context so the question can be decided on its own
  decision <block> --id <decision id> [--question] [--options "A|B"] [--context]   Rewrite an unanswered decision
  answer <block> <answer> [--id <decision id>] [--by <name>]   Answer a decision (default: the latest unanswered one)
  ack <block> [--id <decision id>]                Record that you have read a person's answer and taken it on (removes it from "Answered" in status. start / done / blocked / review / set / split also do this automatically)
  reopen <block> [--id <decision id>] [--note <reason>]   Reopen a decision (change of direction). The previous answer stays in the history and the options are kept
  set <block> [--status black|gray|white] [--progress 0..100|auto] [--title <title>] [--note <description>] [--category <category>|none] [--repo <path>|none] [--issue <URL>|none]
              [--start YYYY-MM-DD|none] [--due YYYY-MM-DD|none] [--estimate <hours>|none] [--hours <actual hours>|none]
  find <text>                                    Find boxes by ID or title
  list --assignee <name> | --unassigned | --everyone [--all] [--json]   List assigned boxes as a table (open ones by default; --all adds done ones; sorted by due date)
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
      --context-token <token> (for an AI's commands that record work on a plan with the guard on; the contextToken from context <block>.
                               When your own command changes the context, the last line of its output is "New context token: <token>"; use that for the next command.
                               ask / decision / answer / reopen work without it, but print the new context token when you pass it)
      --file <path> (default: look for boxglow.json in parent folders. The BOXGLOW_FILE environment variable also works)
      --actor <name> (default: the BOXGLOW_ACTOR environment variable, claude-code under Claude Code, codex under Codex, otherwise agent)
<block> is a short ID (B12), an internal id, or a title (exact match, or a partial match that identifies one box). status shows the IDs
`;

function main(argv: string[]): void {
  // 常駐 (mcp) では前の呼び出しで覚えたリビジョンが残るので、毎回忘れてから読み直す
  readRevisions.clear();
  lastSavedText = null;
  const { positional, options } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  // 言語: --lang / BOXGLOW_LANG > 計画の lang (読み込んだ後に決め直す) > 日本語。常駐 (mcp) では前の呼び出しの言語が残るので毎回決め直す
  setLang(explicitLang(options) ?? "ja");
  // 手順書とスキルは、決まった言語のものを使う (呼ぶ時点の言語で選ぶ)
  const AGENTS_SNIPPET = () => (getLang() === "en" ? AGENTS_SNIPPET_EN : AGENTS_SNIPPET_JA);
  const SKILL_MD = () => (getLang() === "en" ? SKILL_MD_EN : SKILL_MD_JA);
  // 版の表示 (計画が無くても出せるよう、読み込みの前に処理する)。--json は { app, protocol }
  if (cmd === "version" || options.version) {
    out(options.json ? JSON.stringify({ app: APP_VERSION, protocol: SAVE_PROTOCOL }) : t("boxglow {version} (保存の取り決め {protocol})", { version: APP_VERSION, protocol: SAVE_PROTOCOL }));
    return;
  }
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
  claimRequest=claimCommand(cmd,rest[0],options,actor);

  if (cmd === "unlock") {
    // 残った保存ロックの状態を見る / 人の判断で解除する。計画の中身は読まない (壊れた計画でも使えるように)
    const path = locateFile(str(options.file));
    if (!explicitLang(options)) { try { setLang(load(path).lang ?? "ja"); } catch { /* 読めない計画でも、ロックの確認はできる */ } }
    const status = inspectLock(path);
    if (!status) { out(t("ロックはありません: {path}", { path })); return; }
    if (!options.remove) {
      // 既定は表示だけ (AI も使える)。解除は、表示した印 (--lock-token) を付けて人が実行する
      out(describeLock(status));
      if (status.verdict === "live") out(t("持ち主が動いているので、解除できません。保存が終わるのを待つか、そのプロセスを止めてからもう一度確かめてください"));
      else out(t("解除するには、この計画を開いている Boxglow (CLI・serve・VS Code。別の OS やマシンのものも含む) を止めてから、人が実行してください: boxglow unlock --remove --lock-token {token} --actor human", { token: lockTokenOf(status) }));
      return;
    }
    // 解除は人の操作に限る (--actor human は自己申告で、認証ではない。AI が自分の判断で消さないための取り決め)
    if (!isHumanActor(actor)) throw new Error(t("ロックの解除は人が行います。AI は boxglow unlock の表示を人に見せて、解除を頼んでください (自分で --actor human を付けたり、ロックを直接消したりしない)"));
    const expected = str(options["lock-token"]);
    if (!expected) throw new Error(t("--lock-token <boxglow unlock が表示した印> を付けてください (表示のあとで別のロックに替わっていないかを確かめるため)"));
    const result = removeLock(path, expected);
    if (result === "removed") out(t("ロックを解除しました: {path}", { path }));
    else if (result === "none") out(t("ロックはありません: {path}", { path }));
    else if (result === "busy") throw new Error(t("他の書き手が回収・解除の途中の可能性があり、解除の権利を取れませんでした。boxglow unlock で状態をもう一度確かめてください"));
    else if (result === "live") throw new Error(t("持ち主が動いているので、解除できません。保存が終わるのを待つか、そのプロセスを止めてからもう一度確かめてください"));
    else throw new Error(t("表示のあとで別のロックに替わっています。boxglow unlock でもう一度確かめてください"));
    return;
  }

  if (cmd === "init") {
    const path = locateFile(str(options.file), true);
    if (existsSync(path) && !options.force) throw new Error(t("{path} は既にあります (--force で上書き)", { path }));
    // 上書き (--force) のときは今の中身の版を、新規のときは「無い」ことを保存の前提にする
    readRevisions.set(resolve(path), existsSync(path) ? revisionOf(readFileSync(path, "utf8")) : null);
    // 計画の言語を決めて書き込む: 指定があればそれ、無ければ環境の言語 (日本語の環境なら ja、それ以外は en)
    const lang = explicitLang(options) ?? envLang();
    setLang(lang);
    const p = createProject(str(options.name) ?? t("新しいプロジェクト"));
    p.lang = lang;
    save(path, p);
    out(t("作成: {path}", { path }));
    return;
  }

  // merge (Git のマージドライバ) は、渡された 3 つのファイルだけで動く。作業中の boxglow.json は探さない。
  // (探すと、計画ファイルを別の名前・場所に置いたリポジトリや、boxglow.json の無いフォルダでは、
  //  「boxglow.json が見つかりません」で止まり、自動のマージが効かなくなるため)
  if (cmd === "merge") {
    // Git のマージドライバ: %O (base) %A (ours) %B (theirs)。結果は ours に書く。終了コード 0 = 自動で合わせた
    const [basePath, oursPath, theirsPath] = rest;
    if (!basePath || !oursPath || !theirsPath) throw new Error(t("merge <base> <ours> <theirs> の 3 つを指定してください"));
    const read = (f: string): Project | null => { const text = readFileSync(f, "utf8"); readRevisions.set(resolve(f), revisionOf(text)); return text.trim() ? fromJSON(text) : null; };
    const base = read(basePath);
    const ours = read(oursPath);
    const theirs = read(theirsPath);
    if (!ours || !theirs) throw new Error(t("ours / theirs が読めません"));
    // 文言とログの言語は、自分の側の計画に書かれた言語にそろえる (指定があればそちら)
    setLang(explicitLang(options) ?? ours.lang ?? "ja");
    const r = mergeProjects(base, ours, theirs, {}, new Date().toISOString());
    let q = r.project;
    // 競合が 0 件でも、合わせた結果が壊れた計画になることがある (互いを相手の中へ移した、など)。
    // 壊れた計画は書かずに、自分の側のファイルをそのまま残して失敗にする (Git は競合として扱う)
    const problem = projectProblem(q);
    if (problem) throw new Error(t("マージした結果が計画として正しくないため、書き込みませんでした (自分の側のファイルはそのままです): {problem}", { problem }));
    // 両側で同じ項目を変えていた箇所は、相手の値をログに残す (後から見直せるように)
    // 片方が削除・片方が変更の箇所は、変更された側を残したことを記録する (ボックスの中身を丸ごとログに書くと長いので、場所だけ)
    const kept = r.conflicts.filter((c) => !c.automatic && (c.ours === undefined || c.theirs === undefined));
    for (const c of r.conflicts) {
      const message = kept.includes(c)
        ? t("マージで片方が削除・片方が変更: {path} (変更された側を残しました。削除した側: {side})", { path: c.path, side: c.ours === undefined ? t("自分") : t("相手") })
        : t("マージで両側が変更: {path} (採用: {ours} / 相手: {theirs})", { path: c.path, ours: JSON.stringify(c.ours), theirs: JSON.stringify(c.theirs) });
      q = { ...q, log: [...q.log, { id: `m${Math.random().toString(36).slice(2, 10)}`, at: new Date().toISOString(), actor: "merge", kind: "note", message }] };
    }
    // Gitは保存済みの両側を統合する。作業の取得検証はせず、claimsも3方向マージの結果を保存する。
    commitFile(oursPath, toJSON(q) + "\n", readRevisions.get(resolve(oursPath))!);
    const both = r.conflicts.length - kept.length;
    out(
      t("マージ: 相手の変更 {count} 件を取り込み", { count: r.merged })
      + (both ? t("、両側で変更が {count} 件 (自分の値を採用し、相手の値はログに記録)", { count: both }) : "")
      + (kept.length ? t("、削除と変更の競合が {count} 件 (変更された側を残し、ログに記録)", { count: kept.length }) : "")
    );
    if (r.conflicts.length && options.strict) process.exitCode = 1;
    return;
  }

  const path = locateFile(str(options.file));
  let p = load(path);
  // 計画に書かれた言語で CLI の文言・ログを出す (同じ計画を触る AI と人が同じ言語になる)。指定があればそちらを優先
  setLang(explicitLang(options) ?? p.lang ?? "ja");

  // guard (確認トークン): 計画で有効 (contextGuard) なら、AI が作業を記録するコマンドは最新のコンテキストのトークンを要求する。
  // 無効 (contextGuard が無い古い計画を含む) なら何も要求しない。人 (--actor human / human:名前) には要求しない
  // (guard は AI が古い指示のまま進めるのを防ぐ仕組み。人が CLI から操作するのを止める理由が無い)。
  // ボックスの指定の誤りは今までどおり mustFind のエラーになる
  const token = str(options["context-token"]);
  // 操作のあとに新しい確認トークンを添えるボックス (操作の前のトークンが正しいと確かめられたときだけ決まる)
  let tokenTarget: string | undefined;
  if (p.contextGuard && !isHumanActor(actor)) {
    if (GUARDED_COMMANDS.includes(cmd) || (cmd === "scope" && Object.keys(SCOPE_OPTIONS).some(k => options[k] !== undefined))) {
      const id = mustFind(p, rest[0]).id;
      requireContext(p, id, token, actor);
      tokenTarget = id;
    } else if (CONTEXT_CHANGING_COMMANDS.includes(cmd) && token) {
      // トークンを要求しないコマンド (ask など) でも、最新のトークンを付けて実行したなら、操作のあとの新しいトークンを返す。
      // トークンが無い・古いときは返さない (人の変更を読まないまま新しいトークンを手に入れられないようにする)
      const b = findBlock(p, rest[0] ?? "").block;
      if (b && contextReceipt(p, b.id).contextToken === token) tokenTarget = b.id;
    } else if ((cmd === "focus" && rest[0] !== undefined) || (cmd === "policy" && (options.start !== undefined || options.done !== undefined))) {
      // 計画全体の規則を変える前にも、現在の指示を読んだことを照合する。
      if (!isCurrentToken(p, token)) throw new Error(t("計画の設定を変える前に context を読み、--context-token を付けてください。"));
      tokenTarget = Object.keys(p.blocks).find(id => contextReceipt(p, id).contextToken === token);
    } else if (cmd === "guard" && rest[0] === "off" && !isCurrentToken(p, token)) {
      // AI が古いトークンを通すために guard を外すのを防ぐ (人はトークン無しで外せる)
      throw new Error(t("AI が確認トークンの要求 (guard) を無効にするには --context-token <context で得た最新の確認トークン> が要ります。人が操作するときは --actor human を付けてください"));
    }
  }
  runCommand(cmd, rest, options, actor, path, p, AGENTS_SNIPPET, SKILL_MD);
  if(lastSavedText && cmd === "start") {
    const saved=fromJSON(lastSavedText), id=findClaimBlock(saved,rest[0]).block?.id;
    if(id && claimsEnabled(saved) && !claimRequest.human) {
      const held=Object.entries(saved.claims??{}).find(([root,c])=>activeClaim(c,Date.now()) && c.instanceId===claimRequest.identity.instanceId && c.actor===claimRequest.identity.actor && covers(saved,root,c,id));
      if (held) {
        out("CLAIM " + JSON.stringify({blockId:held[0],instanceId:claimRequest.identity.instanceId,token:claimToken(held[0],held[1]),expiresAt:held[1].expiresAt}));
        // 全計画の取得は、通常のボックス取得と異なり並行作業全体に影響する。
        // 保存が成功した後だけ、実際に取得した範囲に基づいて知らせる。
        if (id === ROOT_ID && held[0] === ROOT_ID && held[1].scope === "subtree") {
          out(t("全体を受け持ちました (他の実行は止まります)。"));
        }
      }
    }
  }
  // 自分の操作でコンテキストが変わったら、新しい確認トークンを出力の最後に添える。
  // 自分で変えた内容は読み直さなくても分かっているので、続けて次の操作ができる
  // (人の回答・人の指示の変更・他の AI の引き継ぎで変わった場合は、操作の前の照合で拒否している)
  if (tokenTarget && lastSavedText !== null) {
    const saved = fromJSON(lastSavedText);
    if (saved.contextGuard && saved.blocks[tokenTarget]) {
      const next = contextReceipt(saved, tokenTarget).contextToken;
      if (next !== token) out(t("新しい確認トークン: {token}", { token: next }));
    }
  }
}

/** Input: CLIの範囲フラグ / Output: 保存する WorkScope の項目名。 */
const SCOPE_OPTIONS = { goal: "goal", "non-goals": "nonGoals", acceptance: "acceptance", consult: "consult" } as const;
/** guard が有効な計画で、AI に確認トークンを要求するコマンド (作業を記録するもの) */
const GUARDED_COMMANDS = ["start", "done", "set", "split", "artifact", "ack", "blocked", "review", "leave", "checkpoint"];
/** 確認トークンは要求しないが、ボックスのコンテキストを変えるコマンド (最新のトークンを付けて実行すると、新しいトークンを返す) */
const CONTEXT_CHANGING_COMMANDS = ["ask", "decision", "answer", "reopen"];

/**
 * コマンドの本体 (計画を読んだ後の処理)。言語の決定・guard の照合は呼び出し側 (main) が済ませている
 * Input : cmd = コマンド名, rest = 残りの位置引数, options = オプション, actor = 操作する人 / AI の名前,
 *         path = boxglow.json のパス, p = 読み込んだ計画, AGENTS_SNIPPET / SKILL_MD = 今の言語の手順書・スキルを返す関数
 * Output: なし (結果は out で出力し、計画は save で書く)。失敗は例外
 */
function runCommand(cmd: string, rest: string[], options: ReturnType<typeof parseArgs>["options"], actor: string, path: string, p: Project, AGENTS_SNIPPET: () => string, SKILL_MD: () => string): void {
  switch (cmd) {
    case "scope": {
      const b = mustFind(p, rest[0]);
      const patch: WorkScope = { ...b.scope };
      let changed = false;
      for (const [flag, key] of Object.entries(SCOPE_OPTIONS)) {
        if (options[flag] === undefined) continue;
        const value = str(options[flag]);
        if (value === undefined) throw new Error(t("範囲の本文、または none を指定してください。"));
        if (!value.trim() || value === "none") delete patch[key];
        else patch[key] = value.trim();
        changed = true;
      }
      if (changed) {
        p = updateBlock(p, b.id, { scope: Object.keys(patch).length ? patch : undefined });
        save(path, p);
      }
      out(scopeEntries(p.blocks[b.id].scope).map(x => x.label + ": " + x.text).join("\n") || t("今回の範囲は未設定です"));
      return;
    }
    case "focus": {
      if (rest[0] !== undefined) {
        if (rest[0] === "none") delete p.focusBlockId;
        else p.focusBlockId = mustFind(p, rest[0]).id;
        save(path, p);
      }
      out(p.focusBlockId ? t("今回の範囲: {title}", { title: p.blocks[p.focusBlockId].title }) : t("今回の範囲は未設定です"));
      return;
    }
    case "policy": {
      const patch: WorkflowPolicy = { ...p.workflowPolicy };
      for (const [flag, key] of [["start", "startWithoutInputs"], ["done", "doneWithoutArtifacts"]] as const) {
        if (options[flag] === undefined) continue;
        const value = str(options[flag]);
        if (value !== "warn" && value !== "reject") throw new Error(t("確認方法は warn または reject を指定してください。"));
        patch[key] = value;
      }
      if (options.start !== undefined || options.done !== undefined) {
        p.workflowPolicy = patch;
        save(path, p);
      }
      out(JSON.stringify({ startWithoutInputs: patch.startWithoutInputs ?? "warn", doneWithoutArtifacts: patch.doneWithoutArtifacts ?? "warn" }, null, 2));
      return;
    }
    case "claims": {
      out(JSON.stringify(claimSummary(p,claimRequest.identity),null,2)); return;
    }
    case "claim-policy": {
      if(!options.mode && !options.minutes) {out(JSON.stringify(claimSummary(p,claimRequest.identity),null,2));return;}
      if(!claimRequest.human) throw new Error(t("受け持ちの設定と強制解除は人が行います。AIは人に依頼してください。"));
      const mode=str(options.mode)??p.claimPolicy?.mode??"reject";
      if(!["off","warn","reject"].includes(mode)) throw new Error(t("受け持ちの設定が正しくありません。期限は1〜1440分です。"));
      p={...p,claimPolicy:{mode:mode as "off"|"warn"|"reject",leaseMinutes:options.minutes===undefined?(p.claimPolicy?.leaseMinutes??30):Number(str(options.minutes))}};
      save(path,p);out(t("受け持ち設定: {mode}",{mode}));return;
    }
    case "claim-release":
    case "claim-renew": {
      const target=mustFind(p,rest[0]);
      if(cmd==="claim-release" && p.claims?.[target.id]?.releasedAt) {out(t("すでに解除されています。"));return;}
      save(path,p);out(t("受け持ちを更新しました。"));return;
    }
    case "context": {
      // ボックスのコンテキストと確認トークンを JSON で出す (読むだけ)
      // --brief: 短いコンテキスト (対象の情報は全部、親・上流は絞る)。確認トークンは、全部の出力と同じ
      out(JSON.stringify({...(options.brief ? briefReceipt : contextReceipt)(p, mustFind(p, rest[0]).id),...(claimsEnabled(p)?{claimSummary:claimSummary(p,claimRequest.identity)}:{})}, null, 2));
      return;
    }
    case "guard": {
      // 確認トークンの要求を有効 / 無効にする (計画に書くので、同じ計画を使う全員に効く)
      if (!["on", "off"].includes(rest[0])) throw new Error(t("guard on|off を指定してください"));
      p.contextGuard = rest[0] === "on";
      save(path, p);
      out(t("確認トークンの要求 (guard): {state}", { state: rest[0] }));
      return;
    }
    case "checkpoint": {
      const b = mustFind(p, rest[0]);
      const note = str(options.note)?.trim();
      if (!note) throw new Error(t("--note <分かったこと・次の手順・未解決の点> を指定してください"));
      // 引き継ぎメモはボックスごとに 1 つ (上書き)。件数に上限のある活動ログとは別に計画に残る
      p.handoffs = { ...p.handoffs, [b.id]: { note, actor, at: new Date().toISOString() } };
      save(path, p);
      out(t("引き継ぎメモを保存しました: {block}", { block: b.key ?? b.id }));
      return;
    }
    case "resume": {
      // 再開用の概要 (読むだけ。回答を確認済みにはしない)
      out(options.json ? JSON.stringify({...resumeSummary(p, { includeCompleted: !!options["include-completed"] }),...(claimsEnabled(p)?{claimSummary:claimSummary(p,claimRequest.identity)}:{})}, null, 2) : resumeReport(p, { includeCompleted: !!options["include-completed"] }) + (claimsEnabled(p) ? "\n"+JSON.stringify(claimSummary(p,claimRequest.identity),null,2):""));
      return;
    }
    case "status": {
      if (options.json) out(JSON.stringify(p, null, 2));
      else out(statusReport(p, { brief: !!options.brief }) + (claimsEnabled(p)?"\n"+JSON.stringify(claimSummary(p,claimRequest.identity),null,2):""));
      return;
    }
    case "export": {
      const fmt = str(options.format) ?? "md";
      const text = fmt === "json" ? toJSON(p) + "\n" : projectToMarkdown(p);
      const target = str(options.out);
      if (target) { writeExport(target, text); out(t("書き出し: {target}", { target })); }
      else out(text);
      return;
    }
    case "show": {
      out(blockReport(p, mustFind(p, rest[0]).id));
      return;
    }
    case "setup-agent": {
      // AI エージェント側の設定を 1 回で入れる (何度実行しても同じ結果になるよう、印の間だけを書き換える。本体は cli/setup-agent.ts)
      const root = str(options.dir) ? resolve(str(options.dir)!) : dirname(path);
      const done = setupAgent({ root, agent: str(options.agent) ?? "all", snippet: AGENTS_SNIPPET(), skill: SKILL_MD() });
      // 指示書に「context を読んでトークンを付ける」手順が入るので、計画の側でも確認トークンの要求を有効にする
      const guardWasOn = !!p.contextGuard;
      p.contextGuard = true;
      save(path, p);
      // 既存の計画で setup-agent をやり直した場合も動作が変わるので、有効にしたことと次の手順を必ず伝える
      if (!guardWasOn) out(t("確認トークン (guard) を有効にしました。AI は作業の前に boxglow context <ボックス> を読み、返ってきたトークンを --context-token で渡します。人の操作 (--actor human) には不要です。外すときは boxglow guard off --actor human"));
      out(t("設定しました: {list}\nAI は作業の始まり・終わり・判断待ちを boxglow.json に記録し、セッションの最初に計画を読みます。人は画面で見て判断してください (編集と回答は npx boxglow serve --open か VS Code 拡張で。boxglow.json を直接開いた画面は閲覧専用です)", { list: done.join(", ") }));
      return;
    }
    case "project": {
      const name = rest.join(" ");
      if (!name) throw new Error(t("<名前> を指定してください"));
      const r = addProjectBlock(p, name);
      if (str(options.repo)) r.project = updateBlock(r.project, r.blockId, { repo: str(options.repo) });
      save(path, r.project);
      out(t("プロジェクトのボックスを追加: 「{name}」(id: {id})。全部で {count} 件", { name, id: r.blockId, count: projectBlocks(r.project).length }));
      return;
    }
    case "export-block": {
      const b = mustFind(p, rest[0]);
      const tags = str(options.tags) ? str(options.tags)!.split(/[,、]/).map((s) => s.trim()).filter(Boolean) : [];
      const tpl = extractTemplate(p, b.id, { tags });
      const target = str(options.out) ?? `${b.title.replace(/[\\/:*?"<>|\s]/g, "_")}.boxglow-block.json`;
      writeExport(target, JSON.stringify(tpl, null, 2) + "\n");
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
      writeExport(target, exportInputGroup(p, gp.id) + "\n");
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
    case "list": {
      // 担当の一覧: --assignee <名前か id> のメンバーの担当、--unassigned で担当のいないボックス、--everyone で全員分を、Markdown の表で出す (--json で JSON)
      // 画面の「表で見る」と同じ行 (src/model/assignments.ts)。既定は未完了だけ、--all で完了済みも
      let target: AssigneeTarget;
      if (options.everyone) target = { everyone: true };
      else if (options.unassigned) target = { unassigned: true };
      else {
        const who = str(options.assignee);
        if (!who) throw new Error(t("--assignee <名前>、--unassigned、--everyone のどれかを指定してください (メンバー: {names})", { names: p.members.map((m) => m.name).join(", ") || t("(なし)") }));
        const m = p.members.find((x) => x.id === who) ?? p.members.find((x) => x.name === who);
        if (!m) throw new Error(t("メンバー「{name}」が見つかりません (メンバー: {names})", { name: who, names: p.members.map((x) => x.name).join(", ") || t("(なし)") }));
        target = { memberId: m.id };
      }
      const rows = assignmentRows(p, target, { includeDone: !!options.all });
      if (options.json) { out(JSON.stringify(rows, null, 2)); return; }
      if (rows.length === 0) { out(options.all ? t("担当のボックスはありません") : t("未完了の担当のボックスはありません")); return; }
      // 表の中の | は区切りと紛れるので、全角に置き換える
      const cell = (v: string) => v.replace(/\|/g, "｜").replace(/\s*\n\s*/g, " ");
      // 全員のときだけ、誰の担当かの列を足す
      const who = "everyone" in target;
      const lines = [
        `| ID | ${t("題名")} | ${t("場所")} | ${who ? `${t("担当")} | ` : ""}${t("状態")} | ${t("進捗")} | ${t("期日")} | ${t("見積")} | ${t("入力")} | ${t("判断待ち")} |`
      , `|---|---|---|${who ? "---|" : ""}---|---:|---|---:|---|---:|`
      , ...rows.map((r) => `| ${r.key} | ${cell(r.title)} | ${cell(r.where)} | ${who ? `${cell(r.assignees.join(", ") || t("未担当"))} | ` : ""}${STATUS_LABEL[r.status]} | ${r.progress}% | ${r.dueDate ?? ""}${r.overdue ? ` (${t("期日切れ")})` : ""} | ${r.estimateHours !== undefined ? `${r.estimateHours}h` : ""} | ${r.status === "white" ? "" : r.missingInputs.length ? cell(t("待ち: {names}", { names: r.missingInputs.join(", ") })) : t("そろった")} | ${r.pendingDecisions || ""} |`)
      ];
      out(lines.join("\n"));
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
    case "git-setup": {
      // .gitattributes に merge=boxglow を書き、git config にドライバを登録する
      const root = dirname(path);
      const attrs = join(root, ".gitattributes");
      const line = "boxglow.json merge=boxglow";
      const cur = existsSync(attrs) ? readFileSync(attrs, "utf8") : "";
      if (!cur.split(/\r?\n/).includes(line)) writeFileSync(attrs, (cur && !cur.endsWith("\n") ? cur + "\n" : cur) + line + "\n", "utf8");
      execFileSync("git", ["config", "merge.boxglow.name", "Boxglow plan merge (box level)"], { cwd: root });
      execFileSync("git", ["config", "merge.boxglow.driver", "npx boxglow merge %O %A %B"], { cwd: root });
      out(t("登録しました: {attrs} に「{line}」、git config merge.boxglow.driver = \"npx boxglow merge %O %A %B\"\n以後 git merge / pull / rebase で boxglow.json はボックスの単位で自動マージされます (チーム全員がこのコマンドを 1 回実行してください)", { attrs, line }));
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
          if (hasKids && !used.has(`${q.id}:inner`)) warnings.push(t(q.direction === "in" ? "{key} 「{title}」の入力「{name}」が中のボックスとつながっていません" : "{key} 「{title}」の出力「{name}」が中のボックスとつながっていません", { key: b.key ?? "", title: b.title, name: q.name }));
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
    case "branch": {
      // 分岐のボックスを足す: まだ決まっていない分かれ道。選択肢ごとに出力 (道) ができ、判断に答えると選ばなかった道の先は「見送り」になる
      // 例: branch "API の方式を決める" --question "API の方式はどれにしますか?" --options "REST|GraphQL" --in 設計書 --context "比較: ..."
      const title = rest[0];
      if (!title) throw new Error(t("<題名> を指定してください"));
      // 選択肢: --option を繰り返す (選択肢に「|」を含められる) か、--options "A|B" (「|」で区切る)
      const choices = [...list(options.option), ...(str(options.options) ?? "").split("|")].map((x) => x.trim()).filter(Boolean);
      if (new Set(choices).size < 2) throw new Error(t("--options \"A|B\" (または --option を繰り返して) 選択肢を 2 つ以上指定してください"));
      const parentId = str(options.parent) ? mustFind(p, str(options.parent)).id : defaultTaskParent(p);
      const r = addBranch(p, { parentId, title, question: str(options.question) ?? title, options: choices, context: str(options.context) ?? "", actor, position: nextFreePosition(p, parentId) });
      p = r.project;
      for (const name of list(options.in)) p = addPort(p, { blockId: r.blockId, direction: "in", name }).project;
      save(path, p);
      out(t("分岐を追加: 「{title}」(id: {id})。道 (出力): {options}。判断に答えると、選ばなかった道の先は見送りになります", { title, id: r.blockId, options: choices.join(", ") }));
      return;
    }
    case "split": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
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
      if (q === p) throw new Error(t("移せません (自分の子孫の中、プロジェクトのボックス、同じ親などは不可)"));
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
      // 合流の入力にする (どれか 1 つが届けばよい) / 通常の入力に戻す
      for (const [flag, on] of [["any-of", true], ["all-of", false]] as const) {
        for (const name of list(options[flag])) {
          // 同じ名前の入力はすべて対象にする (つないだ入力の名前は供給元の出力名に合わせて付くので、合流の入力は同じ名前になりやすい)
          const ports = portsOf(p, blockId, "in").filter((x) => x.name === name);
          if (ports.length === 0) throw new Error(t("ポート「{name}」が見つかりません", { name }));
          for (const port of ports) p = setInputAnyOf(p, port.id, on);
          added.push(on ? t("合流 {name}", { name }) : t("通常 {name}", { name }));
        }
      }
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
      if (added.length === 0) throw new Error(t("--in <名前> / --out <名前> / --rename <旧名>=<新名> / --any-of <入力名> / --all-of <入力名> のいずれかを指定してください"));
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
      if (b.kind === "project") throw new Error(t("プロジェクトのボックスは消せません (中のボックスを全部消すか、ファイルごと作り直してください)"));
      const kids = Object.values(p.blocks).filter((x) => x.parentId === b.id).length;
      if (kids > 0 && !options.force) throw new Error(t("「{title}」の中に {count} 個のボックスがあります。まとめて消すなら --force を付けてください", { title: b.title, count: kids }));
      const q = removeBlock(p, b.id);
      save(path, q);
      out(t("削除: 「{title}」", { title: b.title }) + (kids > 0 ? t(" と中の {count} 個のボックス", { count: kids }) : "") + t(" (つながっていた線も外しました)"));
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
      const reason = str(options.reason)?.trim() ?? "";
      if (options.reason !== undefined && !reason) throw new Error(t("開始する理由を --reason で記録してください。"));
      const check = checkStart(p, b.id, actor, reason);
      if (check.error) throw new Error(check.error);
      if (check.warning) out(check.warning);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
      // 理由は活動とログの両方に残る。警告を消すだけの一時オプションにはしない。
      const note = [str(options.note), reason ? t("入力待ちで開始する理由: {reason}", { reason }) : ""].filter(Boolean).join("\n");
      save(path, setActivity(p, b.id, actor, "working", note));
      out(t("開始: 「{title}」({actor})", { title: b.title, actor }));
      return;
    }
    case "blocked": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
      save(path, setActivity(p, b.id, actor, "blocked", str(options.note) ?? ""));
      out(t("詰まり: 「{title}」", { title: b.title }));
      return;
    }
    case "review": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
      save(path, setActivity(p, b.id, actor, "waiting_review", str(options.note) ?? ""));
      out(t("確認待ち: 「{title}」", { title: b.title }));
      return;
    }
    case "leave": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
      save(path, clearActivity(p, b.id));
      out(t("活動を消しました: 「{title}」", { title: b.title }));
      return;
    }
    case "done": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
      const specs = list(options.artifact);
      if (specs.some(s => !s.trim() || (s.includes("=") && !s.slice(s.indexOf("=") + 1).trim()))) throw new Error(t("成果物のパスまたは URL を指定してください。"));
      const artifacts = specs.map((s) => artifactFrom(s));
      const check = checkDone(p, b.id, artifacts.length, actor);
      if (check.error) throw new Error(check.error);
      const r = finishBlock(p, b.id, actor, { artifacts, outputName: str(options.output), note: str(options.note) });
      if (r.error) throw new Error(r.error);
      save(path, r.project);
      out(t("完了: 「{title}」", { title: b.title }) + `${artifacts.length ? t(" 成果物: ") + artifacts.map((a) => a.title + (a.kind === "git" ? ` (git ${a.path} @ ${(a.commit ?? "").slice(0, 7)})` : "")).join(", ") : ""}`);
      // 成果物の無い完了は「何ができたか」が後から分からない。具体的な物 (ファイル・URL・コミット) を付けるよう促す
      if (check.warning) out(check.warning);
      const reminder = descriptionReminder(r.project.blocks[b.id]);
      if (reminder) out(reminder);
      return;
    }
    case "artifact": {
      const b = mustFind(p, rest[0]);
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
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
          const owner = p.blocks[port.blockId]?.title ?? "?";
          // ローカル参照 (未コミットのときに記録した成果物) は、今は HEAD と中身が一致していれば Git の参照に補完する
          // (記録したときのパスは、計画ファイルの場所か実行した場所からの相対パスなので、両方を試す)
          if (a.kind === "file" && a.path) {
            const ref = findGitRef(a.path, [dirname(path), process.cwd()]);
            if (ref) {
              a.kind = "git";
              a.repo = ref.repo;
              a.path = ref.path;
              a.commit = ref.commit;
              a.blob = ref.blob;
              if (ref.url) a.url = ref.url;
              a.state = "ok";
              a.checkedAt = new Date().toISOString();
              lines.push(t("- [補完] {owner}.{port} 「{title}」 {path} @ {commit}", { owner, port: port.name, title: a.title, path: ref.path, commit: ref.commit.slice(0, 7) }));
              changed++;
            }
            continue;
          }
          if (a.kind !== "git") continue;
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
      // 新しい質問をしただけでは、前の人の回答を「読んで引き取った」ことにしない (ack か、作業を記録するコマンドで引き取る)
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
      p = ackDecisions(p, b.id, actor); // 作業を記録する = そのボックスの回答を読んで引き取った
      if (str(options.status) === "white") {
        const check = checkDone(p, b.id, 0, actor);
        if (check.error) throw new Error(check.error);
      }
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
      if (str(options.note) !== undefined) patch.description = str(options.note) === "none" ? "" : str(options.note);
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
  if (str(options.actor)) process.env.BOXGLOW_ACTOR = str(options.actor)!; // 記録者の名前 (各ツールの実行に引き継ぐ)
  if (str(options.lang)) process.env.BOXGLOW_LANG = str(options.lang)!; // ツールの説明の言語 (各コマンドの文言は計画の言語)
  const mcpFile = locateFile(str(options.file));
  const mcpInstance=randomUUID(), mcpTokens=new Map<string,string>();
  const configuredActor=actorOf(str(options.actor));
  const mcpActor=isHumanActor(configuredActor)?"agent":configuredActor;
  startMcp(async args => {
    if (args[0] !== "sync") {
      if(args.some(a=>/^--(?:actor|instance|claim-token|file)(?:=|$)/.test(a)) || (["claim-policy","claim-release"].includes(args[0]) || (args[0]==="unlock" && args.some(a=>a==="--remove" || a.startsWith("--remove="))))) throw new Error(t("MCPでは実行IDと受け持ちを自動管理します。人の操作は人に依頼してください。"));
      const result=runCli([...args,"--file",mcpFile,"--actor",mcpActor,"--instance",mcpInstance,...[...mcpTokens.values()].flatMap(token=>["--claim-token",token])]);
      for(const line of result.split("\n")) if(line.startsWith("CLAIM ")) {const receipt=JSON.parse(line.slice(6));mcpTokens.set(receipt.blockId,receipt.token);}
      if(["done","leave"].includes(args[0])) {const id=findClaimBlock(load(mcpFile),args[1]).block?.id;if(id)mcpTokens.delete(id);}
      return result;
    }
    if (args.length !== 1) throw new Error(t("この同期には人の判断が必要です。AIは変更の違いと停止理由を要約してaskで知らせ、人が画面またはCLIで選ぶまで待ってください。AIは選択を代行しないでください。") + "\n" + t("人が実行している場合は、boxglow sync --help の「人の操作」を参照してください。"));
    const lines: string[] = [];
    try { setLang(explicitLang(options) ?? load(mcpFile).lang ?? "ja"); } catch { /* 停止理由は返す */ }
    const code = await runSyncCommand({ file: mcpFile, actor: "agent", audience: "ai" }, line => lines.push(line));
    if (code === 1) throw new Error(lines.join("\n"));
    return lines.join("\n");
  }).catch((e) => { console.error(`[boxglow mcp] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
} else if (argv[0] === "remote") {
  const {positional,options}=parseArgs(argv.slice(1));
  (async()=>{
    setLang(explicitLang(options) ?? "ja");
    const known=new Set(["server","lang","actor","confirm","cursor"]);
    if(Object.keys(options).some(k=>!known.has(k)) || positional.length > 2) throw new Error("boxglow remote trash | delete|restore <ID> [--server URL] [--confirm token --actor human]");
    const {server}=selectSyncServer(undefined,str(options.server));
    if(!server) throw new Error(t("サーバーが決まっていません。--server <URL> を指定してください"));
    process.exitCode=await runLifecycle({server,command:positional[0],id:positional[1],actor:str(options.actor),confirm:str(options.confirm),cursor:str(options.cursor)},console.log);
  })().catch(e=>{console.error(e.message);process.exitCode=1;});
} else if (argv[0] === "login" || argv[0] === "logout" || argv[0] === "whoami") {
  // 同期サーバーへのサインイン (通信と、利用者の操作を待つので、ほかのコマンドとは別扱い)
  const { options } = parseArgs(argv.slice(1));
  (async () => {
    setLang(explicitLang(options) ?? "ja");
    const known = new Set(["server", "lang", "file", "name"]);
    const unknown = Object.keys(options).filter((k) => !known.has(k));
    if (unknown.length > 0) { console.log(t("boxglow {cmd} が知らない指定です: {list}", { cmd: argv[0], list: unknown.map((k) => "--" + k).join(", ") })); process.exitCode = 1; return; }
    // サーバー: 指定 > 環境変数 > 計画のファイルの結び付け (1 つだけのとき)
    let file: string | undefined;
    try { file = locateFile(str(options.file)); } catch { /* サインインは計画なしでも可能 */ }
    const { server } = selectSyncServer(file,str(options.server)?.trim() || undefined);
    if (!server) { console.log(t("サーバーが決まっていません。--server <URL> を指定してください")); process.exitCode = 1; return; }
    const out = (text: string) => console.log(text);
    process.exitCode = argv[0] === "login" ? await runLogin({ server, out, deviceName: str(options.name) })
      : argv[0] === "logout" ? await runLogout({ server, out }) : await runWhoami({ server, out });
  })().catch((e) => { console.error(`[boxglow ${argv[0]}] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
} else if (argv[0] === "sync") {
  // 同期 (通信を待つので、ほかのコマンドとは別扱い)
  const { options } = parseArgs(argv.slice(1));
  // 出力の先 (| head など) が先に閉じても、エラーの山を出さずに終わる
  process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code === "EPIPE") process.exit(process.exitCode ?? 0); else throw e; });
  (async () => {
    setLang(explicitLang(options) ?? "ja");
    if (options.help) {
      out((getLang() === "en" ? HELP_EN : HELP_JA).trim());
      out(t("人の操作: 初回の結び付けや競合の選択は、人が --actor human または --actor human:名前 を明示して実行します。BOXGLOW_ACTORだけでは選択を許可しません。AIは人を名乗らず、比較を伝えて人の操作を待ってください。"));
      return;
    }
    const file = locateFile(str(options.file));
    try { setLang(explicitLang(options) ?? load(file).lang ?? "ja"); } catch { /* 読めない計画でも、止まった理由は表示する */ }
    // 知らない指定 (まだ無い --watch など) を、黙って「1 回の同期」として実行しない
    const known = new Set(["file", "lang", "actor", "watch", "server", "project", "reconnect-restored", "adopt", "restore", "resolve", "link", "prefer", "recover", "applied", "not-applied", "account", "relink", "block", "settings", "choices-file"]);
    const unknown = Object.keys(options).filter((k) => !known.has(k));
    if (unknown.length > 0) { out(t("boxglow sync が知らない指定です: {list}", { list: unknown.map((k) => "--" + k).join(", ") })); process.exitCode = 1; return; }
    process.exitCode = await (options.watch ? runWatchCommand : runSyncCommand)({
      file
    , actor: str(options.actor)
    , rawArgs: argv.slice(1)
    , server: str(options.server)
    , reconnectRestored: str(options["reconnect-restored"])
    , project: str(options.project)
    , adopt: str(options.adopt)
    , restore: str(options.restore)
    , resolve: str(options.resolve)
    , block: options.block === undefined ? undefined : list(options.block)
    , settings: str(options.settings)
    , choicesFile: str(options["choices-file"])
    , link: str(options.link)
    , prefer: str(options.prefer)
    , recover: str(options.recover)
    , relink: str(options.relink)
    , applied: options.applied === undefined ? undefined : !!options.applied
    , notApplied: options["not-applied"] === undefined ? undefined : !!options["not-applied"]
    , account: str(options.account)
    }, out);
  })().catch((e) => { console.error(`[boxglow sync] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
} else if (argv[0] === "serve") {
  // ローカルサーバ: 同梱の Web アプリを配信し、boxglow.json を API で読み書きする (どのブラウザでも開ける)
  const { options } = parseArgs(argv.slice(1));
  try {
    // 言語を決める (main() を通らないのでここで行う): --lang / BOXGLOW_LANG > 計画の lang > 日本語
    setLang(explicitLang(options) ?? "ja");
    const file = locateFile(str(options.file));
    // 計画が読めなくてもサーバは今までどおり起動する (言語は上で決めたまま)
    try { setLang(explicitLang(options) ?? load(file).lang ?? "ja"); } catch { /* 読めないファイルは画面側で扱う */ }
    // 通常起動は入口だけ。明示--syncだけ従来どおり有効化し、--no-syncは入口も無効にする。
    const selection = selectSyncServer(file, options["no-sync"] ? null : (str(options.server)?.trim() || undefined));
    const syncServer = selection.server;
    startServe({ file, port: Number(str(options.port) ?? 4174), dist: fileURLToPath(new URL("../dist/", import.meta.url)), open: !!options.open, log: out
    , ...(syncServer ? { sync: { server: syncServer, restoreEnabled: selection.source !== "default", autoEnable:!!options.sync && selection.source !== "default" } } : {}) });
  } catch (e) {
    console.error(`[boxglow serve] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
} else {
  // 出力はいったん溜めて、最後にまとめて出す (他の変更とぶつかってやり直すとき、途中まで出した分を二重に出さないため)
  let buf = "";
  sink = (text) => { buf += text; };
  try {
    mainWithRetry(argv, () => { buf = ""; process.exitCode = undefined; });
  } catch (e) {
    console.error(`[boxglow] ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    process.stdout.write(buf);
  }
}
