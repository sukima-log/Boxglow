/**
 * boxglow CLI: AI エージェント (Claude Code / Codex など) と人がリポジトリ内の boxglow.json を操作する入口
 *
 * 使い方 (npx boxglow <command> ...):
 *   init [--name <名前>] [--file <path>]           boxglow.json を作る
 *   setup-agent [--dir <path>]                     AI が自律的に使えるように設定する: AGENTS.md / CLAUDE.md に手順を追記、
 *                                                  Claude Code のスキル (.claude/skills/boxglow) と、セッション開始時に status を読むフックを入れる
 *   status [--json]                                全体の状況 (Markdown)
 *   export [--format md|json] [--out <path>]       計画全体を Markdown (または JSON) に書き出す (ロードマップの文書化に)
 *   show <block>                                   ブロックの詳細
 *   add <題名> [--parent <block>] [--out <出力名>] [--in <入力名>]... [--note <説明>] [--category <カテゴリ>]   (親を省略すると最初のプロジェクトの箱の中)
 *                                                  カテゴリ: study 検討 / research 調査 / design 設計 / ui デザイン / build 実装 / verify 検証 / evaluate 評価 / improve 改善 / fix 課題解決 / docs 文書 / ops 運用 / other その他
 *   project <名前>                                 プロジェクトの箱を最上位に足す (同じファイルで複数のプロジェクト) [--repo <パス>]  (複数リポジトリは boxglow.json を上のフォルダに置き、各リポジトリで BOXGLOW_FILE を指す)
 *   export-block <block> [--out <path>] [--tags "a,b"]   箱を下の階層ごとテンプレート (*.boxglow-block.json) に書き出す
 *   import-block <path> [--parent <block>]         テンプレートを挿入 (親を省略すると最初のプロジェクトの箱の中)
 *   split <block> --spec '<JSON>' | --spec-file <path>   下の階層にまとめて分解 (形式は docs/AGENTS_SNIPPET.md)
 *   move <block> --parent <block|project>            箱を別の親の中へ移す (線は間の箱のポートを経由してつながったまま)
 *   port <block|project> [--in <名前>]... [--out <名前>]... [--rename <旧名>=<新名>]   既存の箱に入力 / 出力を足す、名前を変える (project = 最初のプロジェクトの箱)
 *   disconnect <題名.出力名> <題名.入力名>          線を外す
 *   tidy                                              ファイルを規則にそろえて保存し直す (つないだ入力の名前を供給元に合わせる、大項目を畳む、重なりを解く)
 *   remove <block> [--force]                          箱を消す (中に箱があるときは --force。線も外れる。元に戻せないので Git で管理していること)
 *   serve [--port 4174] [--open]                      ローカルサーバ: 同梱の Web アプリを http://localhost:4174/?serve=1 で配信し、boxglow.json を読み書き (Firefox / Safari でも使える)
 *   mcp [--file <path>]                               MCP サーバ (標準入出力)。Claude Code などから status / start / done / ask ... をツールとして使う (.mcp.json は setup-agent が書く)
 *   connect <題名.出力名> <題名[.入力名]>           結線 (受け側は題名だけでよい: 出力名と同じ名前の入力を作ってつなぐ。親子は自動で内側の面。最終成果物へは project)
 *   start <block> [--note <何をするか>]            作業開始 (作業中になる)
 *   done <block> [--artifact <題名>=<URL またはパス>]... [--output <出力名>] [--note]   完了 (成果物を付けて white)
 *                                                  パスが Git 管理下なら「コミット + パス + blob」で記録する (アップロードしない)
 *   artifact <block> <URL またはパス> [--title <題名>] [--output <出力名>]   成果物だけ付ける (完了にはしない)
 *   check                                          Git の成果物が今も見つかるか確認し、移動していればパスを付け替える
 *   blocked <block> --note <困っていること>          詰まり
 *   review <block> [--note]                        確認待ち
 *   ask <block> <質問> [--options "A|B"] [--context <判断材料>]   人間に判断を求める (判断待ちになる)。質問だけで判断できるよう、前提・比較・影響を --context に書く
 *   decision <block> --id <decision id> [--question] [--options "A|B"] [--context]   未回答の判断を書き直す
 *   answer <block> <回答> [--id <decision id>] [--by <名前>]   判断に答える (既定は最新の未回答)
 *   reopen <block> [--id <decision id>] [--note <理由>]   判断をやり直す (方針転換)。前の答えは履歴に、候補はそのまま残る
 *   set <block> [--status black|gray|white] [--progress 0..100|auto] [--title <題名>] [--note <説明>] [--category <カテゴリ>|none] [--repo <パス>|none] [--issue <URL>|none]
 *               [--start YYYY-MM-DD|none] [--due YYYY-MM-DD|none] [--estimate <時間>|none] [--hours <実績時間>|none]
 *   find <文字>                                    ID や題名で箱を探す
 *   group <名前>                                   最上位の入力グループを作る (例: "PCIe 仕様書")
 *   group-set <入力名> <グループ名|none>            最上位の入力をグループに入れる / 外す
 *   group-export <グループ名> [--out <path>]        グループを JSON に書き出す (他のプロジェクトで group-import)
 *   group-import <path>                            グループの JSON を読み込む
 *   leave <block>                                  活動を消す (作業を離れる)
 *   prompt <block> [--ask plan|decompose|review]    AI に渡す文脈 (Markdown)
 *   layout [block]                                 自動整列 (全体、または指定した箱の中)
 *   log [--n 20]                                   最近のログ
 *   validate                                       形式と結線の検査
 *   merge <base> <ours> <theirs>                    boxglow.json を箱・ポート・線の単位で 3 方向マージし <ours> に書く (Git のマージドライバ用)
 *   git-setup                                      このリポジトリの Git に merge ドライバを登録 (.gitattributes + git config)。以後 git merge / pull が自動で使う
 *
 * 共通: --file <path> (既定: 上の階層へ boxglow.json を探す。環境変数 BOXGLOW_FILE でも可)
 *       --actor <名前> (既定: 環境変数 BOXGLOW_ACTOR、Claude Code なら claude-code、それ以外は agent)
 * <block> は短い ID (B12)、内部 id、または題名 (完全一致、または 1 つに決まる部分一致)。status に ID が出る
 */
import { fileURLToPath } from "node:url";
import { startMcp } from "./mcp";
import { startServe } from "./serve";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import AGENTS_SNIPPET from "../docs/AGENTS_SNIPPET.md";
import SKILL_MD from "../.claude/skills/boxglow/SKILL.md";
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
  if (!c) throw new Error(`知らないカテゴリです: ${text} (使えるもの: ${CATEGORIES.map((x) => `${x.en} ${x.label}`).join(", ")})`);
  return c.key;
}
import { dirname, join, resolve } from "node:path";
import { updateDecision, moveBlockToParent, reopenDecision, disconnect, resolveAllOverlaps, setCategory, addBlock, addPort, addProjectBlock, answerDecision, askDecision, clearActivity, connect, createArtifact, createGitArtifact, createProject, defaultTaskParent, extractTemplate, findBlock, finishBlock, fromJSON, instantiateTemplate, parseTemplate, portsOf, projectBlocks, searchBlocks, setActivity, setProgress, setSchedule, setStatus, splitBlock, toJSON, updateBlock, updatePort, validateConnection, addInputGroup, exportInputGroup, importInputGroup, inputGroupsOf, setInputGroup, normalizeCollapsed, removeBlock, connectToBlock, isInputNameLocked, normalizeInputNames } from "../src/model/graph";
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
  throw new Error("boxglow.json が見つかりません (--file で指定するか、`boxglow init` で作ってください)");
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
  if (!ref) throw new Error(`<${what}> を指定してください (id または題名)`);
  const r = findBlock(p, ref);
  if (!r.block) {
    const hint = r.candidates.length > 0 ? ` 候補: ${r.candidates.map((b) => `${b.title} (id: ${b.id})`).join(", ")}` : "";
    throw new Error(`ブロック「${ref}」が${r.candidates.length > 0 ? "1 つに決まりません。" : "見つかりません。"}${hint}`);
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
  if (!ref.includes(".")) throw new Error(`「${ref}」は <題名>.<ポート名> の形で指定してください`);
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
  if (!best) throw new Error(`「${ref}」の箱が見つかりません (<題名>.<ポート名> の形。題名は status に出る題名か B 番号)`);
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

function main(argv: string[]): void {
  const { positional, options } = parseArgs(argv);
  const [cmd, ...rest] = positional;
  if (!cmd || cmd === "help" || options.help) {
    out(readFileSync(new URL(import.meta.url)).toString().match(/\/\*\*[\s\S]*?\*\//)?.[0].replace(/^\/\*\*|\*\/$/g, "").replace(/^ \* ?/gm, "") ?? "boxglow");
    return;
  }
  const actor = actorOf(str(options.actor));

  if (cmd === "init") {
    const path = locateFile(str(options.file), true);
    if (existsSync(path) && !options.force) throw new Error(`${path} は既にあります (--force で上書き)`);
    const p = createProject(str(options.name) ?? "新しいプロジェクト");
    save(path, p);
    out(`作成: ${path}`);
    return;
  }

  const path = locateFile(str(options.file));
  let p = load(path);

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
      if (target) { writeFileSync(target, text, "utf8"); out(`書き出し: ${target}`); }
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
      const parts = AGENTS_SNIPPET.split(/^---$/m);
      const body = (parts.length >= 3 ? parts.slice(1, -1).join("---") : AGENTS_SNIPPET).trim();
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
      writeFileSync(join(skillDir, "SKILL.md"), SKILL_MD, "utf8");
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
        done.push(".mcp.json (MCP サーバ boxglow)");
      }
      out(`設定しました: ${done.join(", ")}\nAI は作業の始まり・終わり・判断待ちを boxglow.json に記録し、セッションの最初に計画を読みます。人は画面 (boxglow.json を開く、または npx boxglow serve) で見て判断してください`);
      return;
    }
    case "project": {
      const name = rest.join(" ");
      if (!name) throw new Error("<名前> を指定してください");
      const r = addProjectBlock(p, name);
      if (str(options.repo)) r.project = updateBlock(r.project, r.blockId, { repo: str(options.repo) });
      save(path, r.project);
      out(`プロジェクトの箱を追加: 「${name}」(id: ${r.blockId})。全部で ${projectBlocks(r.project).length} 件`);
      return;
    }
    case "export-block": {
      const b = mustFind(p, rest[0]);
      const tags = str(options.tags) ? str(options.tags)!.split(/[,、]/).map((s) => s.trim()).filter(Boolean) : [];
      const tpl = extractTemplate(p, b.id, { tags });
      const target = str(options.out) ?? `${b.title.replace(/[\\/:*?"<>|\s]/g, "_")}.boxglow-block.json`;
      writeFileSync(target, JSON.stringify(tpl, null, 2) + "\n", "utf8");
      out(`テンプレートを書き出し: ${target} (${tpl.root.children.length} 個の子)`);
      return;
    }
    case "import-block": {
      if (!rest[0]) throw new Error("<path> を指定してください");
      const tpl = parseTemplate(readFileSync(rest[0], "utf8"));
      const parentId = str(options.parent) ? mustFind(p, str(options.parent)).id : defaultTaskParent(p);
      const r = instantiateTemplate(p, parentId, tpl, actor, nextFreePosition(p, parentId));
      save(path, r.project);
      out(`挿入: 「${tpl.root.title}」(id: ${r.blockId}) テンプレート ${tpl.name} v${tpl.version}`);
      return;
    }
    case "group": {
      const name = rest.join(" ");
      if (!name) throw new Error("<名前> を指定してください");
      const r = addInputGroup(p, name);
      save(path, r.project);
      out(`入力グループを追加: 「${name}」`);
      return;
    }
    case "group-set": {
      const port = portsOf(p, ROOT_ID, "in").find((x) => x.name === rest[0]);
      if (!port) throw new Error(`最上位の入力「${rest[0] ?? ""}」が見つかりません (${portsOf(p, ROOT_ID, "in").map((x) => x.name).join(", ")})`);
      const gname = rest.slice(1).join(" ");
      const gp = gname === "none" ? null : inputGroupsOf(p).find((g) => g.name === gname);
      if (gname !== "none" && !gp) throw new Error(`グループ「${gname}」がありません (${inputGroupsOf(p).map((g) => g.name).join(", ")})`);
      save(path, setInputGroup(p, port.id, gp ? gp.id : null));
      out(`「${port.name}」を ${gp ? "グループ「" + gp.name + "」" : "Inputs"} へ`);
      return;
    }
    case "group-export": {
      const gp = inputGroupsOf(p).find((g) => g.name === rest.join(" "));
      if (!gp) throw new Error("グループが見つかりません");
      const target = str(options.out) ?? `${gp.name.replace(/[\\/:*?"<>|\s]/g, "_")}.boxglow-inputs.json`;
      writeFileSync(target, exportInputGroup(p, gp.id) + "\n", "utf8");
      out(`書き出し: ${target}`);
      return;
    }
    case "group-import": {
      if (!rest[0]) throw new Error("<path> を指定してください");
      const r = importInputGroup(p, readFileSync(rest[0], "utf8"));
      save(path, r.project);
      out(`読み込み: グループ「${inputGroupsOf(r.project).find((g) => g.id === r.groupId)?.name}」`);
      return;
    }
    case "find": {
      const hits = searchBlocks(p, rest.join(" "), 30);
      out(hits.length === 0 ? "見つかりません" : hits.map((b) => `- ${b.key ?? ""} ${b.title} (id: ${b.id})`).join("\n"));
      return;
    }
    case "layout": {
      // 大項目は畳んだ前提で並べる (All は大項目までしか出さない)
      const q = rest[0] ? layoutScope(normalizeCollapsed(p), mustFind(p, rest[0]).id) : layoutAll(normalizeCollapsed(p));
      save(path, q);
      out(rest[0] ? `整列: 「${mustFind(p, rest[0]).title}」の中` : "整列: 全体");
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
      if (!basePath || !oursPath || !theirsPath) throw new Error("merge <base> <ours> <theirs> の 3 つを指定してください");
      const read = (f: string): Project | null => { const text = readFileSync(f, "utf8"); return text.trim() ? fromJSON(text) : null; };
      const base = read(basePath);
      const ours = read(oursPath);
      const theirs = read(theirsPath);
      if (!ours || !theirs) throw new Error("ours / theirs が読めません");
      const r = mergeProjects(base, ours, theirs);
      let q = r.project;
      // 両側で同じ項目を変えていた箇所は、相手の値をログに残す (後から見直せるように)
      for (const c of r.conflicts) {
        q = { ...q, log: [...q.log, { id: `m${Math.random().toString(36).slice(2, 10)}`, at: new Date().toISOString(), actor: "merge", kind: "note", message: `マージで両側が変更: ${c.path} (採用: ${JSON.stringify(c.ours)} / 相手: ${JSON.stringify(c.theirs)})` }] };
      }
      writeFileSync(oursPath, toJSON(q) + "\n", "utf8");
      out(`マージ: 相手の変更 ${r.merged} 件を取り込み` + (r.conflicts.length ? `、両側で変更が ${r.conflicts.length} 件 (自分の値を採用し、相手の値はログに記録)` : ""));
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
      out(`登録しました: ${attrs} に「${line}」、git config merge.boxglow.driver = "npx boxglow merge %O %A %B"\n以後 git merge / pull / rebase で boxglow.json は箱の単位で自動マージされます (チーム全員がこのコマンドを 1 回実行してください)`);
      return;
    }
    case "validate": {
      const problems: string[] = [];
      for (const b of Object.values(p.blocks)) {
        if (b.id !== ROOT_ID && portsOf(p, b.id, "out").length === 0) problems.push(`「${b.title}」に出力がありません`);
      }
      for (const e of Object.values(p.edges)) {
        const c = validateConnection(p, e.from, e.to);
        if (!c.ok) problems.push(`線 ${e.id}: ${c.reason}`);
      }
      // 計画の穴 (エラーではなく注意): つながっていない入出力、成果物の無い Done
      const warnings: string[] = [];
      const used = new Set<string>();
      for (const e of Object.values(p.edges)) { used.add(`${e.from.portId}:${e.from.side}`); used.add(`${e.to.portId}:${e.to.side}`); }
      for (const b of Object.values(p.blocks)) {
        if (b.id === ROOT_ID) continue;
        const hasKids = Object.values(p.blocks).some((x) => x.parentId === b.id);
        for (const q of portsOf(p, b.id)) {
          if (!used.has(`${q.id}:outer`) && !q.promotedFrom) warnings.push(`${b.key ?? ""} 「${b.title}」の${q.direction === "in" ? "入力" : "出力"}「${q.name}」がどこにもつながっていません`);
          if (hasKids && !used.has(`${q.id}:inner`)) warnings.push(`${b.key ?? ""} 「${b.title}」の${q.direction === "in" ? "入力" : "出力"}「${q.name}」が中の箱とつながっていません`);
        }
        if (b.status === "white" && !hasKids && portsOf(p, b.id, "out").every((q) => q.artifacts.length === 0)) warnings.push(`${b.key ?? ""} 「${b.title}」は Done ですが成果物がありません (--artifact で付けてください)`);
      }
      const lines = [problems.length === 0 ? "問題ありません" : problems.map((x) => "- " + x).join("\n")];
      if (warnings.length > 0) lines.push("", `注意 (${warnings.length} 件。計画の穴):`, ...warnings.map((x) => "- " + x));
      out(lines.join("\n"));
      if (problems.length > 0) process.exitCode = 1;
      return;
    }
    case "add": {
      const title = rest[0];
      if (!title) throw new Error("<題名> を指定してください");
      const parentId = str(options.parent) ? mustFind(p, str(options.parent)).id : defaultTaskParent(p);
      const r = addBlock(p, { parentId, title, outputName: str(options.out), actor, position: nextFreePosition(p, parentId) });
      p = r.project;
      for (const name of list(options.in)) p = addPort(p, { blockId: r.blockId, direction: "in", name }).project;
      if (str(options.note)) p = updateBlock(p, r.blockId, { description: str(options.note)! });
      if (str(options.category)) p = setCategory(p, r.blockId, categoryKeyOf(str(options.category)!));
      save(path, p);
      out(`追加: 「${title}」(id: ${r.blockId})`);
      return;
    }
    case "split": {
      const b = mustFind(p, rest[0]);
      const specText = str(options["spec-file"]) ? readFileSync(str(options["spec-file"])!, "utf8") : str(options.spec);
      if (!specText) throw new Error("--spec '<JSON>' または --spec-file <path> を指定してください");
      const spec = JSON.parse(specText);
      const r = splitBlock(p, b.id, spec, actor);
      save(path, layoutScope(r.project, b.id));
      out(`分解: 「${b.title}」に ${spec.blocks.length} 個を追加` + (r.errors.length ? "\n" + r.errors.map((x) => "- " + x).join("\n") : ""));
      return;
    }
    case "move": {
      const b = mustFind(p, rest[0]);
      const target = str(options.parent);
      if (!target) throw new Error("--parent <block|project> を指定してください");
      const parentId = target === "project" ? defaultTaskParent(p) : mustFind(p, target).id;
      const q = moveBlockToParent(p, b.id, parentId, nextFreePosition(p, parentId));
      if (q === p) throw new Error("移せません (自分の子孫の中、プロジェクトの箱、同じ親などは不可)");
      save(path, q);
      out(`移動: 「${b.title}」を「${q.blocks[parentId].title}」の中へ (線はつなぎ直しました)`);
      return;
    }
    case "port": {
      // 例: port B5 --in "仕様書" --out "設計書"   /   port project --rename "最終成果物=公開された Boxglow 1.0"
      const target = rest[0] ?? "";
      const blockId = target === "project" ? (projectBlocks(p)[0]?.id ?? ROOT_ID) : target === ROOT_ID ? ROOT_ID : mustFind(p, target).id;
      const added: string[] = [];
      for (const name of list(options.in)) { p = addPort(p, { blockId, direction: "in", name }).project; added.push(`入力 ${name}`); }
      for (const name of list(options.out)) { p = addPort(p, { blockId, direction: "out", name }).project; added.push(`出力 ${name}`); }
      for (const spec of list(options.rename)) {
        const eq = spec.indexOf("=");
        if (eq < 0) throw new Error(`--rename は <旧名>=<新名> の形で指定してください: ${spec}`);
        const from = spec.slice(0, eq);
        const to = spec.slice(eq + 1);
        const port = portsOf(p, blockId).find((x) => x.name === from);
        if (!port) throw new Error(`ポート「${from}」が見つかりません`);
        if (isInputNameLocked(p, port.id)) throw new Error(`入力「${from}」の名前は供給元の出力名で決まります。供給元の出力の名前を変えてください (port <供給元> --rename)`);
        p = updatePort(p, port.id, { name: to });
        added.push(`${from} -> ${to}`);
      }
      if (added.length === 0) throw new Error("--in <名前> / --out <名前> / --rename <旧名>=<新名> のいずれかを指定してください");
      save(path, p);
      out(`ポート: ${p.blocks[blockId]?.title ?? "project"}: ${added.join(", ")}`);
      return;
    }
    case "tidy": {
      const r = normalizeInputNames(p);
      save(path, r.project);
      out(`そろえました: 入力の名前 ${r.renamed} 件を供給元に合わせました`);
      return;
    }
    case "remove": {
      const b = mustFind(p, rest[0]);
      if (b.kind === "project") throw new Error("プロジェクトの箱は消せません (中の箱を全部消すか、ファイルごと作り直してください)");
      const kids = Object.values(p.blocks).filter((x) => x.parentId === b.id).length;
      if (kids > 0 && !options.force) throw new Error(`「${b.title}」の中に ${kids} 個の箱があります。まとめて消すなら --force を付けてください`);
      const q = removeBlock(p, b.id);
      save(path, q);
      out(`削除: 「${b.title}」` + (kids > 0 ? ` と中の ${kids} 個の箱` : "") + " (つながっていた線も外しました)");
      return;
    }
    case "disconnect": {
      const a = resolveRef(p, rest[0] ?? "");
      const b = resolveRef(p, rest[1] ?? "");
      const aPorts = portsOf(p, a.blockId).filter((x) => x.name === a.portName).map((x) => x.id);
      const bPorts = portsOf(p, b.blockId).filter((x) => x.name === b.portName).map((x) => x.id);
      const hit = Object.values(p.edges).find((e) => aPorts.includes(e.from.portId) && bPorts.includes(e.to.portId));
      if (!hit) throw new Error(`線が見つかりません: ${rest[0]} -> ${rest[1]}`);
      save(path, disconnect(p, hit.id));
      out(`線を外しました: ${rest[0]} -> ${rest[1]}`);
      return;
    }
    case "connect": {
      const a = resolveRef(p, rest[0] ?? "");
      // 受け側が「題名」だけ (ポート名なし) なら、出す側の出力名で入力を作ってつなぐ (入力名を二重に書かなくてよい)
      if (!(rest[1] ?? "").includes(".")) {
        const tb = rest[1] === "project" ? p.blocks[projectBlocks(p)[0]?.id ?? ROOT_ID] : mustFind(p, rest[1]);
        const fromIsParent = tb.parentId === a.blockId;
        const fromPort = portsOf(p, a.blockId, fromIsParent ? "in" : "out").find((x) => x.name === a.portName);
        if (!fromPort) throw new Error(`「${rest[0]}」のポートが見つかりません`);
        const r = connectToBlock(p, { portId: fromPort.id, side: fromIsParent ? "inner" : "outer" }, tb.id);
        if (r.error) throw new Error(r.error);
        save(path, r.project);
        // つながった先のポート名を伝える (受け側が親なら親の出力、そうでなければ出力名と同じ入力)
        const edge = Object.values(r.project.edges).find((e) => e.from.portId === fromPort.id && !Object.values(p.edges).some((x) => x.id === e.id));
        const toPort = edge ? r.project.ports[edge.to.portId] : undefined;
        out(`結線: ${rest[0]} -> ${tb.title}.${toPort?.name ?? fromPort.name}` + (toPort?.direction === "out" ? " (親の出力)" : " (出力名と同じ入力を使いました)"));
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
      if (!fromPort) throw new Error(`「${rest[0]}」のポートが見つかりません`);
      if (!toPort) throw new Error(`「${rest[1]}」のポートが見つかりません`);
      const from: Endpoint = { portId: fromPort.id, side: fromIsParent ? "inner" : "outer" };
      const to: Endpoint = { portId: toPort.id, side: toIsParent ? "inner" : "outer" };
      const r = connect(p, from, to);
      if (r.error) throw new Error(r.error);
      save(path, r.project);
      out(`結線: ${rest[0]} -> ${rest[1]}`);
      return;
    }
    case "start": {
      const b = mustFind(p, rest[0]);
      save(path, setActivity(p, b.id, actor, "working", str(options.note) ?? ""));
      out(`開始: 「${b.title}」(${actor})`);
      return;
    }
    case "blocked": {
      const b = mustFind(p, rest[0]);
      save(path, setActivity(p, b.id, actor, "blocked", str(options.note) ?? ""));
      out(`詰まり: 「${b.title}」`);
      return;
    }
    case "review": {
      const b = mustFind(p, rest[0]);
      save(path, setActivity(p, b.id, actor, "waiting_review", str(options.note) ?? ""));
      out(`確認待ち: 「${b.title}」`);
      return;
    }
    case "leave": {
      const b = mustFind(p, rest[0]);
      save(path, clearActivity(p, b.id));
      out(`活動を消しました: 「${b.title}」`);
      return;
    }
    case "done": {
      const b = mustFind(p, rest[0]);
      const artifacts = list(options.artifact).map((s) => artifactFrom(s));
      const r = finishBlock(p, b.id, actor, { artifacts, outputName: str(options.output), note: str(options.note) });
      if (r.error) throw new Error(r.error);
      save(path, r.project);
      out(`完了: 「${b.title}」${artifacts.length ? " 成果物: " + artifacts.map((a) => a.title + (a.kind === "git" ? ` (git ${a.path} @ ${(a.commit ?? "").slice(0, 7)})` : "")).join(", ") : ""}`);
      // 成果物の無い完了は「何ができたか」が後から分からない。具体的な物 (ファイル・URL・コミット) を付けるよう促す
      if (artifacts.length === 0) out("注意: 成果物が付いていません。--artifact \"<名前>=<パスまたは URL>\" で、人が後から開ける具体的な物を付けてください");
      return;
    }
    case "artifact": {
      const b = mustFind(p, rest[0]);
      if (!rest[1]) throw new Error("<URL またはパス> を指定してください");
      const a = artifactFrom(rest[1], str(options.title));
      const outs = portsOf(p, b.id, "out");
      const target = str(options.output) ? outs.find((o) => o.name === str(options.output)) : outs[0];
      if (!target) throw new Error("出力ポートが見つかりません");
      save(path, updatePort(p, target.id, { artifacts: [...target.artifacts, a] }));
      out(`成果物を付けました: 「${b.title}」.${target.name} <- ${a.title}${a.kind === "git" ? ` (git ${a.path} @ ${(a.commit ?? "").slice(0, 7)})` : ""}`);
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
              lines.push(`- [補完] ${owner}.${port.name} 「${a.title}」 ${a.path} @ ${ref.commit.slice(0, 7)}`);
              changed++;
              continue;
            }
          }
          const r = checkGitRef(a, dirname(path));
          if (r.state === "moved" && r.path) {
            lines.push(`- [移動] ${owner}.${port.name} 「${a.title}」 ${a.path} -> ${r.path}`);
            a.path = r.path;
            if (r.commit) a.commit = r.commit;
            if (r.blob) a.blob = r.blob;
            if (r.url) a.url = r.url;
            a.state = "moved";
            changed++;
          } else if (r.state === "missing") {
            lines.push(`- [見つかりません] ${owner}.${port.name} 「${a.title}」 ${a.path} (コミット ${(a.commit ?? "").slice(0, 7)} からは取り出せます: git show ${(a.commit ?? "").slice(0, 7)}:${a.path})`);
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
      out(lines.length === 0 ? "Git の成果物はすべて見つかりました" : lines.join("\n"));
      if (changed > 0) out(`${changed} 件を更新しました`);
      return;
    }
    case "ask": {
      const b = mustFind(p, rest[0]);
      const question = rest.slice(1).join(" ");
      if (!question) throw new Error("<質問> を指定してください");
      const opts = str(options.options) ? str(options.options)!.split("|").map((s) => s.trim()).filter(Boolean) : [];
      const r = askDecision(p, b.id, actor, question, opts, str(options.context) ?? "");
      save(path, r.project);
      out(`判断待ち: 「${b.title}」 ${question} (decision: ${r.decisionId})`);
      return;
    }
    case "decision": {
      const b = mustFind(p, rest[0]);
      const id = str(options.id) ?? [...b.decisions].reverse().find((d) => d.answer === undefined)?.id;
      if (!id) throw new Error("未回答の判断がありません (--id で指定)");
      const patch: { question?: string; options?: string[]; context?: string } = {};
      if (str(options.question) !== undefined) patch.question = str(options.question);
      if (str(options.options) !== undefined) patch.options = str(options.options)!.split("|").map((s) => s.trim()).filter(Boolean);
      if (str(options.context) !== undefined) patch.context = str(options.context);
      const q = updateDecision(p, b.id, id, patch);
      if (q === p) throw new Error("書き直せません (回答済み、または見つかりません)");
      save(path, q);
      out(`判断を書き直しました: 「${b.title}」 (decision: ${id})`);
      return;
    }
    case "answer": {
      const b = mustFind(p, rest[0]);
      const answer = rest.slice(1).join(" ");
      if (!answer) throw new Error("<回答> を指定してください");
      const id = str(options.id) ?? [...b.decisions].reverse().find((d) => d.answer === undefined)?.id;
      if (!id) throw new Error("未回答の判断がありません");
      save(path, answerDecision(p, b.id, id, answer, str(options.by) ?? (actor === "agent" ? "human" : actor)));
      out(`回答: 「${b.title}」 ${answer}`);
      return;
    }
    case "reopen": {
      const b = mustFind(p, rest[0]);
      const id = str(options.id) ?? [...b.decisions].reverse().find((d) => d.answer !== undefined)?.id;
      if (!id) throw new Error("やり直せる判断 (回答済み) がありません");
      save(path, reopenDecision(p, b.id, id, actor, str(options.note) ?? ""));
      out(`やり直し: 「${b.title}」の判断を未回答に戻しました (前の答えは履歴に残ります)`);
      return;
    }
    case "set": {
      const b = mustFind(p, rest[0]);
      if (str(options.status)) p = setStatus(p, b.id, str(options.status) as "black" | "gray" | "white", actor);
      if (str(options.progress) !== undefined) p = setProgress(p, b.id, str(options.progress) === "auto" ? null : Number(str(options.progress)), actor);
      const sched: { startDate?: string | null; dueDate?: string | null; estimateHours?: number | null; actualHours?: number | null } = {};
      const dateOf = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : v);
      const numOf = (v: string | undefined) => (v === undefined ? undefined : v === "none" ? null : Number(v));
      if (str(options.start) !== undefined) sched.startDate = dateOf(str(options.start));
      if (str(options.due) !== undefined) sched.dueDate = dateOf(str(options.due));
      if (str(options.estimate) !== undefined) sched.estimateHours = numOf(str(options.estimate));
      if (str(options.hours) !== undefined) sched.actualHours = numOf(str(options.hours));
      for (const v of [sched.startDate, sched.dueDate]) if (typeof v === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`日付は YYYY-MM-DD で指定してください: ${v}`);
      if (Object.keys(sched).length > 0) p = setSchedule(p, b.id, sched, actor);
      const patch: { title?: string; description?: string } = {};
      if (str(options.title)) patch.title = str(options.title);
      if (str(options.note)) patch.description = str(options.note);
      if (Object.keys(patch).length > 0) p = updateBlock(p, b.id, patch);
      if (str(options.category) !== undefined) p = setCategory(p, b.id, str(options.category) === "none" ? null : categoryKeyOf(str(options.category)!));
      if (str(options.repo) !== undefined) p = updateBlock(p, b.id, { repo: str(options.repo) === "none" ? undefined : str(options.repo) });
      if (str(options.issue) !== undefined) p = updateBlock(p, b.id, { issue: str(options.issue) === "none" ? undefined : str(options.issue) }); // JIRA / Redmine などの課題 URL
      save(path, p);
      out(`更新: 「${p.blocks[b.id].title}」`);
      return;
    }
    default:
      throw new Error(`知らないコマンドです: ${cmd} (boxglow help で一覧)`);
  }
}

// 入口: mcp と serve は常駐するので別扱い。それ以外は 1 回実行して終わる
const argv = process.argv.slice(2);
if (argv[0] === "mcp") {
  // MCP サーバ (標準入出力)。--file で計画の場所を指定できる (無ければカレントから上へ探す)
  const { options } = parseArgs(argv.slice(1));
  if (str(options.file)) process.env.BOXGLOW_FILE = resolve(str(options.file)!);
  startMcp(runCli).catch((e) => { console.error(`[boxglow mcp] ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1; });
} else if (argv[0] === "serve") {
  // ローカルサーバ: 同梱の Web アプリを配信し、boxglow.json を API で読み書きする (どのブラウザでも開ける)
  const { options } = parseArgs(argv.slice(1));
  try {
    const file = locateFile(str(options.file));
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
