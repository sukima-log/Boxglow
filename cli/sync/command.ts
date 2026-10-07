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
import { readFileSync } from "node:fs";
import { syncOnce, HumanSyncRequired, SyncAuthError, SyncNetworkError, SyncRejectedError, type SyncResult } from "./client";
import { bindingsOf, hashOf, SyncStateUnreadable } from "./state-store";
import { resolveToken } from "./credentials";
import { authHint } from "./login";
import { bindingsFor, lockWatch, SyncWatcher, type WatchEvent } from "./watch";
import type { RecoveryOutcome } from "../../src/sync/engine";

/** sync コマンドの引数 (main.ts が解釈したオプションから作る) */
export interface SyncCommandOptions {
  /** CLIの明示フラグのみ。環境変数では人専用操作を許可しない。 */
  actor?: string;
  /** 表示だけの対象者。権限はactorの明示指定で別に確認する。MCPは常にai。 */
  audience?: "ai" | "human";
  /** 人が打ち直すときの元の引数。通信には使わない。 */
  rawArgs?: string[];
  file: string;
  server?: string;
  project?: string;
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
const hasHumanChoice = (o: SyncCommandOptions): boolean => [o.resolve, o.block, o.settings, o.choicesFile, o.resolution, o.prefer, o.link, o.relink, o.recover, o.applied, o.notApplied, o.adopt, o.restore, o.account].some(v => v !== undefined);

/** 入力: CLIの識別。出力: AI向けの案内にするか。自己申告を認証の代わりにはしない。 */
export const syncAudience = (o: SyncCommandOptions): "ai" | "human" => o.audience ?? syncAudienceFor(o.actor);
/** 入力: 人が実行した引数。出力: 対象と選択を省略しない、人用の打ち直しコマンド。 */
export function humanSyncCommand(o: SyncCommandOptions): string {
  const args = o.rawArgs ? [...o.rawArgs] : ["--file", o.file];
  if (!o.rawArgs) {
    for (const [key, value] of Object.entries(o)) {
      if (["file", "actor", "audience", "rawArgs", "resolution"].includes(key) || value === undefined || value === false) continue;
      const flag = key === "choicesFile" ? "choices-file" : key === "notApplied" ? "not-applied" : key;
      for (const item of Array.isArray(value) ? value : [value]) { args.push("--" + flag); if (item !== true) args.push(String(item)); }
    }
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
function humanRequired(o: SyncCommandOptions, out: (text: string) => void): number {
  if (syncAudience(o) === "ai") out(new HumanSyncRequired().message);
  else {
    out(t("この操作には人による確認が必要です。内容を確認したうえで、次のコマンドを実行してください。"));
    out(humanSyncCommand(o));
  }
  return 2;
}

export async function runSyncCommand(o: SyncCommandOptions, out: (text: string) => void): Promise<number> {
  if (!isHumanActor(o.actor ?? "") && hasHumanChoice(o)) {
    return humanRequired(o, out);
  }
  // サーバー: 指定 > 環境変数 > そのファイルの結び付け (1 つだけのとき)
  let server = o.server ?? process.env.BOXGLOW_SERVER;
  if (!server) {
    const { bindings: bound, unreadable } = bindingsOf(o.file);
    if (bound.length === 1) server = bound[0].server;
    else if (bound.length === 0) {
      out(syncAudience(o) === "ai" ? t("同期先が決まっていません。人に同期先の確認と初回の結び付けを依頼してください。") + "\n" + t("人が実行している場合は、boxglow sync --help の「人の操作」を参照してください。") : t("同期先が決まっていません。初めて結び付けるときは boxglow sync --server <URL> --actor human を指定してください"));
      // 読めない状態のフォルダがあるときは、「結び付けが無い」と決めつけずに知らせる
      if (unreadable.length > 0) out(t("同期の状態を読めないフォルダがあります (この計画の結び付けかもしれません。消さずに、中身を確かめてください): {list}", { list: unreadable.join(", ") }));
      return 1;
    }
    else { out(t("この計画は複数のサーバーに結び付いています。--server <URL> で選んでください: {list}", { list: bound.map((b) => b.server).join(", ") })); return 1; }
  }
  if (!server) return 1;
  if (o.recover && o.applied === o.notApplied) { out(t("--recover には --applied (反映済みとして続ける) か --not-applied (反映されていないものとして続ける) のどちらかを付けてください")); return 1; }
  if (o.link && o.prefer !== "local" && o.prefer !== "remote") { out(t("--resolve / --link には --prefer local (手元を採る) か --prefer remote (サーバーを採る) を付けてください")); return 1; }
  if (o.relink && o.prefer !== undefined && o.prefer !== "local" && o.prefer !== "remote") { out(t("--relink には、選べるものが 2 つあるときは --prefer local (手元を採る) か --prefer remote (サーバーを採る) を付けてください")); return 1; }
  const prefer = o.prefer as "local" | "remote";
  let result: SyncResult;
  try {
    const resolution = resolutionOptions(o);
    result = await syncOnce({
      humanActions: isHumanActor(o.actor ?? ""), file: o.file, server, remoteId: o.project, token: resolveToken(server)?.token
    , approvedDeletion: o.adopt
    , restoreDeletion: o.restore
    , resolution
    , firstLink: o.link ? { token: o.link, prefer } : undefined
    , recover: o.recover ? { token: o.recover, applied: !!o.applied } : undefined
    , relink: o.relink ? { token: o.relink, prefer: o.prefer as "local" | "remote" | undefined } : undefined
    , confirmAccount: o.account
    });
  } catch (e) {
    if (e instanceof HumanSyncRequired) return humanRequired(o, out);
    if (e instanceof ResolutionOptionError) { out(e.message); return 1; }
    if (e instanceof SyncRejectedError) { out(t("サーバーが、この計画の同期を受け付けませんでした (待っても直りません)。やりかけの操作は残してあります: {status} {detail}", { status: e.status, detail: rejectionHint(e.status) }));
      // 手元を直すだけでは、残った操作の中身は変わらない。次の実行で、その操作を片付けてから、今の中身で送り直すことを伝える
      out(t("手元のファイルを直してから、もう一度 boxglow sync を実行してください。断られた送信は送り直さず、サーバーで受理済みか・取り消すかを確定させてから、今の手元の内容で送り直します"));
      out(t("結び直しの途中の送信だった場合は、確定の後で、今の内容をもう一度選ぶことになります (同じ選択で、送り直しません)"));
      return 2;
    }
    // 使ったトークンの出どころ (環境変数 / 保存済みのサインイン / 無し) に合わせて、直し方を案内する
    if (e instanceof SyncAuthError) { out(t("サーバーが利用者を確かめられませんでした。やりかけの操作は残してあります")); out(authHint(resolveToken(server)?.source ?? null, e.status)); return 1; }
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
export function haltView(result: Extract<SyncResult, { status: "halted" }>, file: string, audience: "ai" | "human" = "human"): HaltView {
  const o = { file };
  const halt = result.halt;
  const items: HaltItem[] = [];
  let fix: HaltView["fix"] = "none";
  const out = (text: string) => { items.push({ kind: "text", text }); };
  // 選べる操作: 表示するコマンド (対象つき) と、画面で使う操作の内容
  const choice = (label: string, command: string, action: SyncAction) => { items.push({ kind: "choice", id: `${action.kind}:${items.length}`, label, command: command.trim() + " --actor human", action }); };
  // 表示するコマンドには、対象 (ファイル・サーバー・サーバー側の計画) をそのまま付ける。
  // 省くと、実行する場所や環境によって、別の対象に対する操作になってしまう (特に、まだ結び付けが無い初回の選択)
  const target = ` --file ${quote(result.target.file)}`;
  const fullTarget = ` --server ${quote(result.target.server)} --project ${quote(result.target.remoteId)}${target}`;
  // 止まる前に行ったことを、そのまま伝える (1 回の実行は何手か進むので、受け取りを書いた後で止まることがある)
  out(t("同期を止めました。"));
  if (result.relinkBackup) out(t("結び直しの前の状態 (手元の計画・同期の記録) を、次のフォルダに控えました (自動では消しません。要らなくなったら、フォルダごと消せます): {path}", { path: result.relinkBackup }));
  if (result.pulled > 0) out(t("止まる前に、サーバーの変更を手元のファイルに書きました ({count} 回)。", { count: result.pulled }));
  if (result.pushed > 0) out(t("止まる前に、手元の変更をサーバーへ送りました ({count} 回)。", { count: result.pushed }));
  if (result.edited > 0) out(t("止まる前に、消えていた設定を手元のファイルに戻しました。"));
  if (result.pulled === 0 && result.pushed === 0 && result.edited === 0) out(t("この実行では、手元のファイルもサーバーも変えていません。"));
  switch (halt.reason) {
    case "conflicts":
      if (halt.resolutionError) out(halt.resolutionError);
      out(t("競合する変更を比較"));
      for (const group of halt.review?.groups ?? []) {
        out(group.blocks.map(b => [b.key, b.title].filter(Boolean).join(" ")).concat(group.settings ? [t("計画の設定")] : []).join(" / "));
        if (group.structural) out(t("削除・移動と関連する変更を一緒に確認してください。"));
        if (group.deleted?.local) out(t("手元側をグループ全体に採用すると削除: {n} ボックス", { n: group.deleted.local }));
        if (group.deleted?.remote) out(t("相手側をグループ全体に採用すると削除: {n} ボックス", { n: group.deleted.remote }));
        if (group.retained?.local.length) out(t("手元側を採用しても追加保護で残る: {names}", { names: group.retained.local.join(" / ") }));
        if (group.retained?.remote.length) out(t("相手側を採用しても追加保護で残る: {names}", { names: group.retained.remote.join(" / ") }));
        for (const field of group.fields) {
          out("  " + field.label);
          out("    " + t("手元の編集") + ": " + field.localText);
          out("    " + t("サーバーの値") + ": " + field.remoteText);
          for (const side of ["local", "remote"] as const) if (field.unassigned?.[side]) out("    " + t(side === "local" ? "手元の編集" : "サーバーの値") + ": " + t("この選択で担当が外れるボックス: 最大 {n}（他の項目の選択によって変わります）", { n: field.unassigned[side] }));
        }
        if (audience === "human") out("  " + t("詳細 (CLIの選択キー)") + ": " + JSON.stringify({ group: group.id, blocks: group.blocks.map(b => b.id), fields: group.fields.map(f => ({ id: f.id, path: f.path })) }));
      }
      if (audience === "human") out(t("--resolve の印と --block <内部ID>=local|remote / --settings local|remote、または --choices-file <JSON> で全グループを選んでください。"));
      out(t("表示した項目を、手元の値に決めるなら (表示していない項目は、今までどおり自動で合わせます):"));
      choice(t("手元の値に決める"), `boxglow sync --resolve ${halt.token} --prefer local${target}`, { kind: "resolve", token: halt.token, prefer: "local" });
      out(t("サーバーの値に決めるなら:"));
      choice(t("サーバーの値に決める"), `boxglow sync --resolve ${halt.token} --prefer remote${target}`, { kind: "resolve", token: halt.token, prefer: "remote" });

      break;
    case "invalid-merge":
      fix = "local-file";
      out(t("手元とサーバーの変更を合わせると、計画として正しくない形になります: {problem}", { problem: halt.problem }));
      out(t("手元のファイルで、どちらかの変更を取り消してからもう一度実行してください"));
      break;
    case "invalid-local":
      fix = "local-file";
      out(t("手元のファイルが、計画として読めません: {problem}", { problem: halt.problem }));
      break;
    case "invalid-remote":
      fix = "server-content";
      out(t("サーバーの中身が、計画として読めません: {problem}", { problem: halt.problem }));
      break;
    case "protected-deletion":
      out(t("前回そろえたときに在った設定が、手元のファイルから消えています: {keys}", { keys: halt.keys.join(", ") }));
      out(t("古い版の Boxglow が保存のときに落としたのかもしれません (書き手は確認できません)。意図した削除なら、次を実行すると、その削除を送ります:"));
      choice(t("削除を送る"), `boxglow sync --adopt ${halt.approval}${target}`, { kind: "adopt", approval: halt.approval });
      out(t("意図していないなら、次を実行すると、消えた設定だけを手元のファイルに戻して、同期を続けます (ほかの編集はそのままです):"));
      choice(t("消えた設定を手元に戻す"), `boxglow sync --restore ${halt.approval}${target}`, { kind: "restore", approval: halt.approval });
      break;
    case "recover-pull": {
      out(t("前回の同期が、サーバーの変更 (版 {revision}) を手元に書く途中で終わっていました。書き込めたかどうかを、今のファイルからは確かめられません。", { revision: halt.pending.remote.revision }));
      out(t("続け方は 2 つあります。それぞれを選んだ場合に起きることを見比べて、選んでください。"));
      const recovery = result.recovery;
      if (recovery) {
        const show = (label: string, flag: string, outcome: RecoveryOutcome) => {
          out("");
          choice(label, `boxglow sync --recover ${recovery.token} ${flag}${target}`, { kind: "recover", token: recovery.token, applied: flag === "--applied" });
          out("  " + t("手元のファイルに入る変更:") + (outcome.localChanges.length ? "" : " " + t("なし")));
          for (const line of outcome.localChanges) out("    - " + line);
          if (outcome.next === "push") {
            out("  " + t("そのあと、サーバーへ送る変更:") + (outcome.remoteChanges.length ? "" : " " + t("記録 (ログなど) だけ")));
            for (const line of outcome.remoteChanges) out("    - " + line);
          } else if (outcome.next === "none") out("  " + t("サーバーへは何も送りません"));
          else out("  " + t("サーバーへ送る前に、別の確認が必要になって、もう一度止まります ({reason})", { reason: outcome.next }));
        };
        show(t("A. 受け取りは手元に反映済みとして続ける"), "--applied", recovery.applied);
        show(t("B. 反映されていないものとして続ける"), "--not-applied", recovery.notApplied);
        out("");
      }
      out(t("どちらとも決められないときは、何も実行しなければ、止まったままです (手元のファイルは、そのまま編集できます)。手元のファイルを別の場所へ写してから選ぶこともできます"));
      break;
    }
    case "history-changed":
    case "relink-stale": {
      out(halt.reason === "history-changed" ? t("サーバーの履歴が、前回そろえたときから変わっています (バックアップからの復旧など)。前回の続きとしては同期できません。") : t("結び直しの途中で、選んだときから手元かサーバーの中身が変わりました (または、選んだ送信が断られました)。選んだ内容は使っていません。今の内容で、選び直してください。"));
      const preview = result.relink;
      // 見比べが無い = 今の内容をまだ読めていない (消されている計画は、別の理由 remote-deleted で止まる)。もう一度の実行を案内する (R32-04)
      if (!preview) { fix = "rerun"; out(t("サーバーの履歴が、同期の途中で変わりました。何も送っていません・書いていません。もう一度 boxglow sync を実行すると、今の内容との見比べを表示します")); break; }
      const command = (prefer?: "local" | "remote") => {
        const label = prefer === "remote" ? t("サーバーの計画を採る") : prefer === "local" ? t("手元の計画を採る") : t("結び直す");
        choice(label, `boxglow sync --relink ${preview.token}${prefer ? ` --prefer ${prefer}` : ""}${target}`, { kind: "relink", token: preview.token, ...(prefer ? { prefer } : {}) });
      };
      out("  " + t("サーバーの今の版: {remote} (前回そろえた版: {base})", { remote: preview.remoteRevision ?? t("なし"), base: preview.baseRevision ?? t("なし") }));
      if (halt.reason === "history-changed") out("  " + (preview.localChanged === null ? t("手元: 前回そろえた後に変えたかどうかは、確かめられません (前回の中身の写しがありません)") : preview.localChanged ? t("手元: 前回そろえた後の変更があります") : t("手元: 前回そろえた後の変更はありません")));
      if (preview.pending === "push") out("  " + t("前回の送信が、途中のまま残っています (届いたかどうかは分かりません)。送り直しません。中身の写しが残っていれば、控えに入れます"));
      if (preview.pending === "pull") out("  " + t("前回の受け取りが、途中のまま残っています。続きは行いません。書く予定だった中身の写しが残っていれば、控えに入れます"));
      if (preview.relation === "differs") {
        out(t("サーバーの計画と、手元の計画は、中身が違います。手元の計画を採った場合に、サーバーの計画に起きる変化:"));
        for (const line of preview.differences) out("  - " + line);
        out(t("どちらを採るかを選んでください。古い中身を元にした自動の統合はしません (復旧の後は、手元の作業を消す方向に働くことがあるため)。"));
        out(t("A. サーバーの計画を採る (手元のファイルを置き換える。前の中身は <ファイル名>.before-sync-....json と、控えのフォルダに残します):"));
        command("remote");
        out(t("B. 手元の計画を採る (サーバーの計画を置き換える。サーバーの前の中身は、サーバーの履歴に残ります):"));
        command("local");
        out(t("項目ごとに選び分けたいときは、手元のファイルを採りたい内容に直してから、もう一度 boxglow sync を実行して B を選んでください"));
      } else {
        out(preview.relation === "same" ? t("サーバーの計画と、手元の計画は、同じ中身です。次を実行すると、今の中身を新しい出発点として、同期を続けます:") : preview.relation === "none" ? t("サーバーにも手元にも、この計画はありません。次を実行すると、結び付けだけを残して、止まった状態を解きます:") : preview.relation === "remote-only" ? t("手元の計画のファイルがありません。次を実行すると、サーバーの計画を手元に書いて、同期を続けます:") : t("復旧先の時点では、この計画はサーバーにありません。次を実行すると、手元の計画を、サーバーに新しく送ります:"));
        command();
      }
      out(t("この選択は、この端末の中身についてのものです。ほかの端末でも同じ確認が出ます (先に、どの端末の中身を正とするか決めてください)。手元の計画を別の計画として残したいときは、ファイルを別のフォルダへ写して、そこで結び付けてください"));
      break;
    }
    case "stale-operation":
      fix = "sync-state";
      out(t("前回の送信の記録が古すぎる、または日時が読めないため、自動では続けられません"));
      break;
    case "first-link":
      out(t("手元とサーバーの両方に、違う中身の計画があります。共通の元が分からないので、自動では合わせません。どちらを採るかを選んでください。"));
      out(t("手元の計画を採る (サーバーの計画を置き換える。前の中身はサーバーの履歴に残ります):"));
      choice(t("手元の計画を採る"), `boxglow sync --link ${halt.token} --prefer local${fullTarget}`, { kind: "link", token: halt.token, prefer: "local" });
      out(t("サーバーの計画を採る (手元のファイルを置き換える。前の中身は、同じフォルダに <ファイル名>.before-sync-....json として残します):"));
      choice(t("サーバーの計画を採る"), `boxglow sync --link ${halt.token} --prefer remote${fullTarget}`, { kind: "link", token: halt.token, prefer: "remote" });
      break;
    case "remote-deleted":
      fix = "none";
      out(t("サーバー側で、この計画は消されています (自動では作り直しません)"));
      break;
    case "local-missing":
      fix = "local-file";
      out(t("手元の計画のファイルがありません: {file}", { file: o.file }));
      break;
    case "base-missing":
      fix = "sync-state";
      out(t("同期の状態のフォルダから、前回そろえた中身の写しが見つかりません (または壊れています)。自動では続けられません。状態の記録はそのまま残して止まっています (消さないでください)"));
      break;
    case "binding-target":
      fix = "rerun";
      out(audience === "ai" ? t("この計画は {bound} に結び付いており、指定された {requested} とは違います。何も変更していません。人に同期対象を確認してください。", { bound: halt.bound, requested: halt.requested }) : t("この計画は、サーバー側の計画 {bound} に結び付いています。指定された {requested} とは違うので、何もしていません。結び付け済みの計画と同期するなら、--project を付けずに実行してください", { bound: halt.bound, requested: halt.requested }));
      break;
    case "bound-elsewhere":
      fix = "none";
      out(t("この計画のファイルは、すでに別のサーバーに結び付いています: {server} (1 つのファイルを、2 つのサーバーへは結び付けません)", { server: halt.server }));
      break;
    case "unreadable-bindings":
      fix = "sync-state";
      out(t("同期の状態を読めないフォルダがあるため、この計画がすでに結び付いているかを確かめられません。新しい結び付けは作りません (フォルダは消さずに、中身を確かめてください): {list}", { list: halt.dirs.join(", ") }));
      break;
    case "choice-not-applied":
      fix = "rerun";
      out(audience === "ai" ? t("指定された選択は今の状態に当てはまりません。何も変更していません。最新の比較を人に確認してもらってください。") : halt.choice === "relink" ? t("--relink の選択は、今の状態には当てはまりません (表示のあとで、手元かサーバーが変わった・選べる内容が違う)。何もしていません。boxglow sync でもう一度確かめてください") : halt.choice === "firstLink"
        ? t("--link の選択は、今の状態には当てはまりません (同期の対象が、選択を表示したときと違う可能性があります)。何もしていません。表示されたコマンドを、--server・--project・--file を付けたまま実行してください")
        : t("--resolve の選択は、今の状態には当てはまりません (競合がもう無い、または対象が違います)。何もしていません。boxglow sync でもう一度確かめてください"));
      break;
    case "account-mismatch":
      fix = "credentials";
      out(t("この計画の結び付けは、別の利用者 ({bound}) のものです。今のトークンの利用者は {actual} です。別の利用者の計画を置き換えないよう、何も送らず、何も書いていません。結び付けたときの利用者のトークンで実行してください", { bound: halt.bound, actual: halt.actual }));
      break;
    case "account-unconfirmed":
      out(t("この計画の結び付けには、利用者の記録がありません (記録するようになる前に結び付けたものです)。今のトークンの利用者は {account} です。この利用者で結び付けたものなら、次を実行すると、利用者を記録して同期を続けます:", { account: halt.account }));
      choice(t("この利用者のものとして続ける"), `boxglow sync --account ${quote(halt.account)}${target}`, { kind: "account", account: halt.account });
      out(t("別の利用者で結び付けたものなら、実行しないでください (そのときのトークンに直してから、もう一度確かめてください)"));
      break;
    case "state-changed":
      fix = "rerun";
      out(t("同期の状態が、選んだときから変わっています。何もしていません。もう一度確かめてから選んでください"));
      break;
    case "binding-mismatch":
      fix = "local-file";
      out(t("このパスには、結び付けたときとは別の計画が置かれています (結び付けた計画の ID: {expected}、今の計画の ID: {actual})。同期しません", { expected: halt.expected, actual: halt.actual }));
      break;
  }
  return {
    ...(halt.reason === "conflicts" ? { review: halt.review, resolutionError: halt.resolutionError } : {}),
    target: { ...result.target }
  , reason: halt.reason
  , done: { pulled: result.pulled, pushed: result.pushed, edited: result.edited, ...(result.relinkBackup ? { backup: result.relinkBackup } : {}) }
  , items, fix
  };
}

/**
 * 常時の同期 (boxglow sync --watch) を実行する。終了の合図 (Ctrl+C) まで動き続ける
 * Input : o = 引数 (初めての計画なら、先に 1 回の同期で結び付ける), out = 出力の関数,
 *         stop = 終了の合図を受け取る Promise (省略時は SIGINT / SIGTERM)
 * Output: 終了コード
 */
export async function runWatchCommand(o: SyncCommandOptions, out: (text: string) => void, stop?: Promise<void>): Promise<number> {
  // まず 1 回同期する (初めてなら結び付ける。止まった場合は理由を表示して、見張りは続ける)
  const first = await runSyncCommand({ ...o, watch: false }, out);
  if (first === 1 || (!isHumanActor(o.actor ?? "") && hasHumanChoice(o))) return first;
  const bound = bindingsOf(o.file).bindings;
  if (!bound.length) return first;
  const server = o.server ?? process.env.BOXGLOW_SERVER ?? bound[0]?.server;
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
  if (status === 507) return t("保存の上限 (計画の数、または保存量) に届いています。履歴の整理か、使っていない計画の削除が要ります");
  return t("要求の形が合いません");
}

/** コマンドの引数として表示する値を、空白などがあっても 1 つの引数になるように引用符で囲む */
function quote(value: string): string {
  if (process.platform === "win32") return /^[A-Za-z0-9_\-./:@]+$/.test(value) ? value : "'" + value.replace(/'/g, "''") + "'";
  return /^[A-Za-z0-9_\-./:@]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

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
