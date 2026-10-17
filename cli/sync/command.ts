import { selectSyncServer, type SyncServerSelection } from "./server-config";
import { syncAudienceFor } from "../actor";
import { isHumanActor } from "../../src/model/graph";
/**
 * boxglow sync: 計画のファイルを、同期サーバーとそろえる (1 回)
 * 使い方:
 *   boxglow sync --server <URL> [--project <サーバー側の計画の ID>]   初めて結び付ける (ID を省くと新しく作る)
 *   boxglow sync                                                      結び付け済みのサーバーとそろえる
 *   boxglow sync --adopt <印>                                         止まっていた「消えた設定の確認」で、その削除を採って送る
 *   boxglow sync --restore <印>                                       同じ場面で、消えた設定だけを手元に戻す
 *   boxglow sync --resolve <印> --prefer local|remote                 止まっていた競合を、表示した項目について手元 / サーバーの値に決める
 *   boxglow sync --link <印> --prefer local|remote                    初めて結び付けるときに中身が違った場合に、どちらを採るかを決める
 *   boxglow sync --recover <印> --applied | --not-applied             止まっていた「受け取りの再開」を、人の選択で進める
 *   boxglow sync --relink <印> [--prefer local|remote]                サーバーの履歴が変わって止まった後に、見比べて選んで、結び直す
 *   boxglow sync --account <利用者の ID>                              利用者の記録が無い結び付けを、表示された利用者のものとして続ける
 * 止まったとき (競合・確認が要る場面) は、理由と次の操作を表示して、終了コード 2 で終わる。通信の失敗は終了コード 1 (もう一度実行すれば続きから)。
 *   boxglow sync --watch                                              常時の同期 (Ctrl+C で終了)。この端末の、同じサーバーに結び付いた計画すべてを受け持つ
 * グループごとの選択: --block / --settings / --choices-file (詳しい形式は docs/SYNC_CONFLICTS.md)
 */
import { blockResolutionKey, parseConflictResolution, type ConflictResolution, type ResolutionInput } from "../../src/model/conflict-groups";
import { t } from "../../src/i18n/core";
import { parseTeams } from "../../src/sync/teams";
import { readFileSync } from "node:fs";
import { syncOnce, SyncConfigurationError, HumanSyncRequired, SyncAuthError, SyncNetworkError, SyncRejectedError, type SyncResult } from "./client";
import { bindingsOf, hashOf, SyncStateUnreadable } from "./state-store";
import { resolveToken } from "./credentials";
import { authHint } from "./login";
import { bindingsFor, lockWatch, SyncWatcher, type WatchEvent } from "./watch";

/** sync コマンドの引数 (main.ts が解釈したオプションから作る) */
export interface SyncCommandOptions {
  /** CLIの明示フラグのみ。環境変数では人専用操作を許可しない。 */
  actor?: string;
  /** 表示だけの対象者。権限はactorの明示指定で別に確認する。MCPは常にai。 */
  audience?: "ai" | "human";
  /** 人が打ち直すときの元の引数。通信には使わない。 */
  rawArgs?: string[];
  /** 初めて置くときのチーム (ワークスペース) の ID (B81)。結び付いた後は結び付けのチームを使う */
  team?: string;
  file: string;
  server?: string;
  project?: string;
  reconnectRestored?: string;
  adopt?: string;
  restore?: string;
  resolve?: string;
  block?: string[];
  settings?: string;
  choicesFile?: string;
  /** MCP からは同じ要求を直接受け取る。CLIのフラグとの混在は受け付けない。 */
  resolution?: ConflictResolution;
  link?: string;
  /** --prefer の値 (local / remote)。--resolve と --link で使う */
  prefer?: string;
  recover?: string;
  /** サーバーの履歴が変わって止まった後の、結び直しの印 (どちらを採るかは --prefer。選べるものが 1 つなら要らない) */
  relink?: string;
  applied?: boolean;
  notApplied?: boolean;
  /** 利用者の記録が無い結び付けを、この利用者のものとして続ける (表示された利用者の ID) */
  account?: string;
  /** 常時の同期 (終了するまで動き続ける) */
  watch?: boolean;
}

/**
 * sync コマンドを実行する
 * Input : o = 引数, out = 出力の関数
 * Output: 終了コード (0 = そろった / 進められなかったが待てば直る, 2 = 人の確認が要る, 1 = 失敗)
 */
/** 入力: CLI引数。出力: 人の判断を要求する指定があるか (空の値も指定として拒否)。 */
const hasHumanChoice = (o: SyncCommandOptions): boolean => [o.reconnectRestored, o.resolve, o.block, o.settings, o.choicesFile, o.resolution, o.prefer, o.link, o.relink, o.recover, o.applied, o.notApplied, o.adopt, o.restore, o.account].some(v => v !== undefined);

/** 入力: CLIの識別。出力: AI向けの案内にするか。自己申告を認証の代わりにはしない。 */
export const syncAudience = (o: SyncCommandOptions): "ai" | "human" => o.audience ?? syncAudienceFor(o.actor);
/** 入力: 人が実行した引数。出力: 対象と選択を省略しない、人用の打ち直しコマンド。 */
export function humanSyncCommand(o: SyncCommandOptions, server?: string): string {
  const args = o.rawArgs ? [...o.rawArgs] : ["--file", o.file];
  if (!o.rawArgs) {
    for (const [key, value] of Object.entries(o)) {
      if (["file", "actor", "audience", "rawArgs", "resolution"].includes(key) || value === undefined || value === false) continue;
      const flag = key === "reconnectRestored" ? "reconnect-restored" : key === "choicesFile" ? "choices-file" : key === "notApplied" ? "not-applied" : key;
      for (const item of Array.isArray(value) ? value : [value]) { args.push("--" + flag); if (item !== true) args.push(String(item)); }
    }
  }
  if (server) {
    let found = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--server") { args[++i] = server; found = true; }
      else if (args[i].startsWith("--server=")) { args[i] = "--server=" + server; found = true; }
    }
    if (!found) args.push("--server", server);
  }
  return "boxglow sync " + [...args, "--actor", "human"].map(quote).join(" ");
}
/** 常時同期が別の計画で止まった場合も、言語などの元引数を保ったまま対象だけ替える。 */
export function retargetSyncArgs(args: string[], file: string): string[] {
  const next: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file") { i++; continue; }
    if (args[i].startsWith("--file=") || args[i] === "--watch" || args[i].startsWith("--watch=")) continue;
    next.push(args[i]);
  }
  return [...next, "--file", file];
}
/** 入力: 呼出元と出力先。出力: AIには相談内容、人には元の引数を保った打ち直し方法。 */
function humanRequired(o: SyncCommandOptions, out: (text: string) => void, selection?: SyncServerSelection): number {
  if (syncAudience(o) === "ai") out(new HumanSyncRequired().message);
  else {
    out(t("この操作には人による確認が必要です。内容を確認したうえで、次のコマンドを実行してください。"));
    if (selection?.server) out(selection.source === "default" ? t("送り先（製品既定）: {server}", { server: selection.server }) : t("送り先: {server}", { server: selection.server }));
    out(humanSyncCommand(o, selection?.server ?? undefined));
  }
  return 2;
}

export async function runSyncCommand(o: SyncCommandOptions, out: (text: string) => void): Promise<number> {
  if (!isHumanActor(o.actor ?? "") && hasHumanChoice(o)) {
    return humanRequired(o, out);
  }
  // 共通の優先順で解決する。無効指定では通信しない。初回のAI制限はsyncOnceが維持する。
  let selection: SyncServerSelection;
  try { selection = selectSyncServer(o.file, o.server?.trim() || undefined); }
  catch (e) { out((e as Error).message); return 1; }
  const { server } = selection;
  if (!server) { out(t("同期は無効です。送り先を指定してからやり直してください。")); return 1; }
  if (o.recover && o.applied === o.notApplied) { out(t("--recover には --applied (反映済みとして続ける) か --not-applied (反映されていないものとして続ける) のどちらかを付けてください")); return 1; }
  if (o.link && o.prefer !== "local" && o.prefer !== "remote") { out(t("--resolve / --link には --prefer local (手元を採る) か --prefer remote (サーバーを採る) を付けてください")); return 1; }
  if (o.relink && o.prefer !== undefined && o.prefer !== "local" && o.prefer !== "remote") { out(t("--relink には、選べるものが 2 つあるときは --prefer local (手元を採る) か --prefer remote (サーバーを採る) を付けてください")); return 1; }
  const prefer = o.prefer as "local" | "remote";
  let result: SyncResult;
  try {
    const resolution = resolutionOptions(o);
    // --team <ID>: 候補 (自分のチーム) から名前を引いて、結び付けに記録する
    let team: { id: string; name: string } | undefined;
    if (o.team) {
      const token = resolveToken(server)?.token;
      const res = await fetch(`${server}/v1/teams`, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: "error", signal: AbortSignal.timeout(30000) }).catch(() => null);
      const found = res?.ok ? parseTeams(await res.json()).find((x) => x.teamId === o.team) : undefined;
      if (!found) { out(t("チームが見つかりません (メンバーでないか、ID が違います): {id}", { id: o.team })); return 1; }
      team = { id: found.teamId, name: found.name };
    }
    result = await syncOnce({
      humanActions: isHumanActor(o.actor ?? ""), file: o.file, server, remoteId: o.project, token: resolveToken(server)?.token, ...(team ? { team } : {})
    , reconnectRestored: o.reconnectRestored
    , approvedDeletion: o.adopt
    , restoreDeletion: o.restore
    , resolution
    , firstLink: o.link ? { token: o.link, prefer } : undefined
    , recover: o.recover ? { token: o.recover, applied: !!o.applied } : undefined
    , relink: o.relink ? { token: o.relink, prefer: o.prefer as "local" | "remote" | undefined } : undefined
    , confirmAccount: o.account
    });
  } catch (e) {
    if (e instanceof HumanSyncRequired) return humanRequired(o, out, selection);
    if (e instanceof ResolutionOptionError) { out(e.message); return 1; }
    if (e instanceof SyncRejectedError) { out(t("サーバーが、この計画の同期を受け付けませんでした (待っても直りません)。やりかけの操作は残してあります: {status} {detail}", { status: e.status, detail: rejectionHint(e.status) }));
      // 手元を直すだけでは、残った操作の中身は変わらない。次の実行で、その操作を片付けてから、今の中身で送り直すことを伝える
      out(t("手元のファイルを直してから、もう一度 boxglow sync を実行してください。断られた送信は送り直さず、サーバーで受理済みか・取り消すかを確定させてから、今の手元の内容で送り直します"));
      out(t("結び直しの途中の送信だった場合は、確定の後で、今の内容をもう一度選ぶことになります (同じ選択で、送り直しません)"));
      return 2;
    }
    // 使ったトークンの出どころ (環境変数 / 保存済みのサインイン / 無し) に合わせて、直し方を案内する
    if (e instanceof SyncAuthError) { out(t("サーバーが利用者を確かめられませんでした。やりかけの操作は残してあります")); out(authHint(resolveToken(server)?.source ?? null, e.status, server)); return 1; }
    if (e instanceof SyncConfigurationError) { out(e.message); return 1; }
    if (e instanceof SyncNetworkError) { out(t("サーバーと通信できませんでした (やりかけの操作は残してあります。もう一度 boxglow sync を実行すると、続きから進みます): {message}", { message: e.message })); return 1; }
    if (e instanceof SyncStateUnreadable) { out(t("同期の状態のファイルを読めません。自動では直しません (消すと、やりかけの操作と前回そろえた中身の記録を失います): {path} ({problem})", { path: e.path, problem: e.problem })); return 1; }
    throw e;
  }
  if (result.status === "synced") {
    if (result.relinkBackup) out(t("結び直しの前の状態 (手元の計画・同期の記録) を、次のフォルダに控えました (自動では消しません。要らなくなったら、フォルダごと消せます): {path}", { path: result.relinkBackup }));
    if (result.edited > 0) out(t("消えていた設定を、手元のファイルに戻しました。"));
    out(result.pulled || result.pushed
      ? t("同期しました (受け取り {pulled} 回、送り {pushed} 回)。サーバーの版: {revision}", { pulled: result.pulled, pushed: result.pushed, revision: result.revision ?? "-" })
      : t("変更はありません。サーバーの版: {revision}", { revision: result.revision ?? "-" }));
    return 0;
  }
  if (result.status === "busy") {
    out(result.what === "file" ? t("計画のファイルが書き込み中のため、今回は進めませんでした。少し待ってからもう一度実行してください") : t("この計画の同期が、ほかで動いています。終わってからもう一度実行してください"));
    return 0;
  }
  describeHalt(result, o.file, out, syncAudience(o));
  return 2;
}

import type { HaltItem, HaltView, SyncAction } from "../../src/sync/status";
export type { HaltItem, HaltView, SyncAction };

/**
 * 止まったときの表示: 理由と、次にできること (1 回の同期と、常時の同期の両方から使う)
 * Input : result = 止まった結果, file = 計画のファイル, out = 出力の関数
 * Output: なし (out に書く)。中身は haltView() の構造から作る
 */
export function describeHalt(result: Extract<SyncResult, { status: "halted" }>, file: string, out: (text: string) => void, audience: "ai" | "human" = "human"): void {
  for (const item of haltView(result, file, audience).items) {
    if (item.kind === "text") {
      // 比較値は省略しない。操作の案内だけをhaltViewで対象者に合わせる。
      out(item.text);
    } else out(audience === "human" ? `  ${item.command}` : t("人が確認する選択肢: {label}", { label: item.label }));
  }
  if (audience === "ai") out(new HumanSyncRequired().message);
}

/**
 * 止まった結果を、表示の構造にする
 * Input : result = 止まった結果, file = 計画のファイル
 * Output: HaltView (文章の順番は、CLI の表示の順番)
 */
export { haltView } from "../../src/sync/halt-view";
import { haltView, quote } from "../../src/sync/halt-view";
export async function runWatchCommand(o: SyncCommandOptions, out: (text: string) => void, stop?: Promise<void>): Promise<number> {
  const { server } = selectSyncServer(o.file, o.server?.trim() || undefined);
  // まず 1 回同期する (初めてなら結び付ける。止まった場合は理由を表示して、見張りは続ける)
  const first = await runSyncCommand({ ...o, watch: false }, out);
  if (first === 1 || (!isHumanActor(o.actor ?? "") && hasHumanChoice(o))) return first;
  const bound = bindingsOf(o.file).bindings;
  if (!bound.length) return first;
  if (!server) return 1;
  // 同じ端末・同じサーバーの常時の同期は 1 つだけ (確認の要求を、計画の数だけ倍にしないため)
  const lock = lockWatch(server);
  if (!lock.unlock) {
    out(t("この端末では、すでに常時の同期が動いています。そちらが、この計画も受け持ちます (動いていないのに残っているときは: boxglow unlock --file {path})", { path: lock.path }));
    return 0;
  }
  const stamp = () => new Date().toTimeString().slice(0, 8);
  const onEvent = (e: WatchEvent) => {
    if (e.kind === "synced") out(`[${stamp()}] ${e.file}: ` + t("同期しました (受け取り {pulled} 回、送り {pushed} 回)。サーバーの版: {revision}", { pulled: e.pulled, pushed: e.pushed, revision: e.revision ?? "-" }));
    else if (e.kind === "configuration") out(e.message);
    else if (e.kind === "network") out(`[${stamp()}] ` + t("サーバーと通信できません。{seconds} 秒後にやり直します: {message}", { seconds: Math.round(e.retryInMs / 1000), message: e.message }));
    else if (e.kind === "auth") out(`[${stamp()}] ` + t("サーバーが利用者を確かめられません (トークンが無い、または無効です)。常時の同期を止めずに待ちます。トークンを直してから、起動し直してください"));
    else if (e.kind === "checked" || e.kind === "authOk") return;   // (変更なしの確認・利用者の確認は、表示しない)
    else if (e.kind === "error" && e.message === new HumanSyncRequired().message) humanRequired({ ...o, file: e.file ?? o.file, watch: false, rawArgs: o.rawArgs ? retargetSyncArgs(o.rawArgs, e.file ?? o.file) : undefined }, out);
    else if (e.kind === "error") out(`[${stamp()}] ${e.file ? e.file + ": " : ""}` + t("この計画の同期を止めています: {message}", { message: e.message }));
    else { out(`[${stamp()}] ${e.file}:`); describeHalt(e.result, e.file, (line) => out("  " + line), syncAudience(o)); if (syncAudience(o) === "human") out("  " + t("(上のコマンドは、その計画のフォルダで、別の端末画面から実行してください。常時の同期は動かしたままで構いません)")); }
  };
  const watcher = new SyncWatcher({ server, token: resolveToken(server)?.token, onEvent });
  out(t("常時の同期を始めました (Ctrl+C で終了)。サーバー: {server}、計画: {count} 件", { server, count: bindingsFor(server).states.length }));
  // (tick は例外を投げない作りだが、万一の失敗でも、処理の全体を落とさない)
  const timer = setInterval(() => { watcher.tick().catch((e) => out(`[${stamp()}] ` + String(e))); }, 1000);
  try {
    await (stop ?? new Promise<void>((done) => { process.once("SIGINT", () => done()); process.once("SIGTERM", () => done()); }));
  } finally {
    clearInterval(timer);
    lock.unlock();
  }
  // 終わるときに、まだ送っていない変更が残っている計画を知らせる
  const unsent = bindingsFor(server).states.map((s) => s.state).filter((s) => { try { return hashOf(readFileSync(s.binding.file, "utf8")) !== s.base?.hash; } catch { return false; } });
  out(t("常時の同期を終えました。"));
  for (const s of unsent) out(t("まだ送っていない変更があります: {file} (boxglow sync で送れます)", { file: s.binding.file }));
  return 0;
}

/** サーバーが断った理由の、短い説明 (状態コードから) */

function rejectionHint(status: number): string {
  if (status === 413) return t("計画が大きすぎます");
  if (status === 426) return t("この版の Boxglow は古く、サーバーが受け付けません。更新してください");
  if (status === 400) return t("サーバーが、計画として正しくないと判断しました");
  if (status === 507) return t("サーバーの保存上限に達しています。管理者に確認してください。")+" "+t("削除した計画も30日間は保存量に含まれます。");
  return t("要求の形が合いません");
}

/** コマンドの引数として表示する値を、空白などがあっても 1 つの引数になるように引用符で囲む */

/**
 * 入力: CLI/MCPの指定。出力: 共通の解決要求、旧prefer、または未指定。
 * 曖昧な混在や誤記は通信前に拒否する。依存グループの重複・完全性は最新比較を持つengineで検証する。
 */
class ResolutionOptionError extends Error {}

export function resolutionOptions(o: SyncCommandOptions): ResolutionInput | undefined {
  const fail = () => { throw new ResolutionOptionError(t("競合の指定が不正です。共通JSON、--prefer、--block / --settings のいずれかを使ってください。")); };
  const granular = o.block !== undefined || o.settings !== undefined;
  if (o.resolution || o.choicesFile) {
    if ((o.resolution && o.choicesFile) || granular || o.prefer !== undefined) return fail();
    let value: unknown = o.resolution;
    if (!value) {
      let text: string;
      try { text = readFileSync(o.choicesFile!, "utf8"); }
      catch { throw new ResolutionOptionError(t("選択ファイルを読めません。--choices-file のパスと読み取り権限を確認してください。")); }
      try { value = JSON.parse(text); }
      catch { throw new ResolutionOptionError(t("選択ファイルが正しいJSONではありません。内容を確認してください。")); }
    }
    const request = parseConflictResolution(value);
    if (!request || (o.resolve !== undefined && request.token !== o.resolve)) return fail();
    return request;
  }
  if (!o.resolve) { if (granular) return fail(); return undefined; }
  if (o.prefer !== undefined) {
    if (granular || !["local", "remote"].includes(o.prefer)) return fail();
    return { token: o.resolve, prefer: o.prefer as "local" | "remote" };
  }
  if (!granular) return fail();
  const groups: Record<string, "local" | "remote"> = Object.create(null);
  for (const flag of o.block ?? []) {
    const split = flag.lastIndexOf("=");
    const id = flag.slice(0, split), side = flag.slice(split + 1);
    if (split < 1 || !["local", "remote"].includes(side) || Object.hasOwn(groups, blockResolutionKey(id))) return fail();
    groups[blockResolutionKey(id)] = side as "local" | "remote";
  }
  if (o.settings !== undefined) {
    if (!["local", "remote"].includes(o.settings)) return fail();
    groups.settings = o.settings as "local" | "remote";
  }
  return { version: 1, token: o.resolve, groups };
}
