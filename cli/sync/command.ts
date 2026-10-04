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
 * 止まったとき (競合・確認が要る場面) は、理由と次の操作を表示して、終了コード 2 で終わる。通信の失敗は終了コード 1 (もう一度実行すれば続きから)。
 * まだ無いもの: 常時の同期 (--watch)、競合を 1 件ずつ選ぶ操作、サインイン (login)
 */
import { t } from "../../src/i18n/core";
import { syncOnce, SyncNetworkError, type SyncResult } from "./client";
import { bindingsOf } from "./state-store";
import type { RecoveryOutcome } from "../../src/sync/engine";

/** sync コマンドの引数 (main.ts が解釈したオプションから作る) */
export interface SyncCommandOptions {
  file: string;
  server?: string;
  project?: string;
  adopt?: string;
  restore?: string;
  resolve?: string;
  link?: string;
  /** --prefer の値 (local / remote)。--resolve と --link で使う */
  prefer?: string;
  recover?: string;
  applied?: boolean;
  notApplied?: boolean;
}

/**
 * sync コマンドを実行する
 * Input : o = 引数, out = 出力の関数
 * Output: 終了コード (0 = そろった / 進められなかったが待てば直る, 2 = 人の確認が要る, 1 = 失敗)
 */
export async function runSyncCommand(o: SyncCommandOptions, out: (text: string) => void): Promise<number> {
  // サーバー: 指定 > 環境変数 > そのファイルの結び付け (1 つだけのとき)
  let server = o.server ?? process.env.BOXGLOW_SERVER;
  if (!server) {
    const bound = bindingsOf(o.file);
    if (bound.length === 1) server = bound[0].server;
    else if (bound.length === 0) { out(t("同期先が決まっていません。初めて結び付けるときは boxglow sync --server <URL> を指定してください")); return 1; }
    else { out(t("この計画は複数のサーバーに結び付いています。--server <URL> で選んでください: {list}", { list: bound.map((b) => b.server).join(", ") })); return 1; }
  }
  if (o.recover && o.applied === o.notApplied) { out(t("--recover には --applied (反映済みとして続ける) か --not-applied (反映されていないものとして続ける) のどちらかを付けてください")); return 1; }
  if ((o.resolve || o.link) && o.prefer !== "local" && o.prefer !== "remote") { out(t("--resolve / --link には --prefer local (手元を採る) か --prefer remote (サーバーを採る) を付けてください")); return 1; }
  const prefer = o.prefer as "local" | "remote";
  let result: SyncResult;
  try {
    result = await syncOnce({
      file: o.file, server, remoteId: o.project, token: process.env.BOXGLOW_TOKEN
    , approvedDeletion: o.adopt
    , restoreDeletion: o.restore
    , resolution: o.resolve ? { token: o.resolve, prefer } : undefined
    , firstLink: o.link ? { token: o.link, prefer } : undefined
    , recover: o.recover ? { token: o.recover, applied: !!o.applied } : undefined
    });
  } catch (e) {
    if (e instanceof SyncNetworkError) { out(t("サーバーと通信できませんでした (やりかけの操作は残してあります。もう一度 boxglow sync を実行すると、続きから進みます): {message}", { message: e.message })); return 1; }
    throw e;
  }
  if (result.status === "synced") {
    out(result.pulled || result.pushed
      ? t("同期しました (受け取り {pulled} 回、送り {pushed} 回)。サーバーの版: {revision}", { pulled: result.pulled, pushed: result.pushed, revision: result.revision ?? "-" })
      : t("変更はありません。サーバーの版: {revision}", { revision: result.revision ?? "-" }));
    return 0;
  }
  if (result.status === "busy") {
    out(result.what === "file" ? t("計画のファイルが書き込み中のため、今回は進めませんでした。少し待ってからもう一度実行してください") : t("この計画の同期が、ほかで動いています。終わってからもう一度実行してください"));
    return 0;
  }
  // ---- 止まった: 理由と、次にできることを表示する ----
  const halt = result.halt;
  out(t("同期を止めました。手元のファイルもサーバーも変えていません。"));
  switch (halt.reason) {
    case "conflicts":
      out(t("手元とサーバーで、同じ項目が別の値に変わっています ({count} 件):", { count: halt.conflicts.length }));
      for (const c of halt.conflicts) out(`  - ${c.path}: ${t("手元")} ${JSON.stringify(c.ours)} / ${t("サーバー")} ${JSON.stringify(c.theirs)}`);
      out(t("表示した項目を、手元の値に決めるなら (ほかの変更は両方とも残ります):"));
      out(`  boxglow sync --resolve ${halt.token} --prefer local`);
      out(t("サーバーの値に決めるなら:"));
      out(`  boxglow sync --resolve ${halt.token} --prefer remote`);
      out(t("項目ごとに選び分けたいときは、手元のファイルで採りたい値に直してから、もう一度 boxglow sync を実行してください (サーバーと同じ値にした項目は、競合になりません)"));
      break;
    case "invalid-merge":
      out(t("手元とサーバーの変更を合わせると、計画として正しくない形になります: {problem}", { problem: halt.problem }));
      out(t("手元のファイルで、どちらかの変更を取り消してからもう一度実行してください"));
      break;
    case "invalid-local":
      out(t("手元のファイルが、計画として読めません: {problem}", { problem: halt.problem }));
      break;
    case "invalid-remote":
      out(t("サーバーの中身が、計画として読めません: {problem}", { problem: halt.problem }));
      break;
    case "protected-deletion":
      out(t("前回そろえたときに在った設定が、手元のファイルから消えています: {keys}", { keys: halt.keys.join(", ") }));
      out(t("古い版の Boxglow が保存のときに落としたのかもしれません (書き手は確認できません)。意図した削除なら、次を実行すると、その削除を送ります:"));
      out(`  boxglow sync --adopt ${halt.approval}`);
      out(t("意図していないなら、次を実行すると、消えた設定だけを手元のファイルに戻します (ほかの編集はそのままです):"));
      out(`  boxglow sync --restore ${halt.approval}`);
      break;
    case "recover-pull": {
      out(t("前回の同期が、サーバーの変更 (版 {revision}) を手元に書く途中で終わっていました。書き込めたかどうかを、今のファイルからは確かめられません。", { revision: halt.pending.remote.revision }));
      out(t("続け方は 2 つあります。それぞれを選んだ場合に起きることを見比べて、選んでください。"));
      const recovery = result.recovery;
      if (recovery) {
        const show = (label: string, flag: string, outcome: RecoveryOutcome) => {
          out("");
          out(`${label}: boxglow sync --recover ${recovery.token} ${flag}`);
          if (!["pull", "push", "none"].includes(outcome.next)) out("  " + t("この続け方では、別の確認が必要になって、もう一度止まります ({reason})", { reason: outcome.next }));
          out("  " + t("手元のファイルに入る変更:") + (outcome.localChanges.length ? "" : " " + t("なし")));
          for (const line of outcome.localChanges) out("    - " + line);
          out("  " + t("サーバーへ送ることになる変更:") + (outcome.remoteChanges.length ? "" : " " + t("なし")));
          for (const line of outcome.remoteChanges) out("    - " + line);
        };
        show(t("A. 受け取りは手元に反映済みとして続ける"), "--applied", recovery.applied);
        show(t("B. 反映されていないものとして続ける"), "--not-applied", recovery.notApplied);
        out("");
      }
      out(t("どちらとも決められないときは、何も実行しなければ、止まったままです (手元のファイルは、そのまま編集できます)。手元のファイルを別の場所へ写してから選ぶこともできます"));
      break;
    }
    case "history-changed":
      out(t("サーバーの履歴が、前回そろえたときから変わっています (バックアップからの復旧など)。前回の続きとしては同期できません。サービスの案内を確かめてください"));
      break;
    case "stale-operation":
      out(t("前回の送信の記録が古すぎる、または日時が読めないため、自動では続けられません"));
      break;
    case "first-link":
      out(t("手元とサーバーの両方に、違う中身の計画があります。共通の元が分からないので、自動では合わせません。どちらを採るかを選んでください。"));
      out(t("手元の計画を採る (サーバーの計画を置き換える。前の中身はサーバーの履歴に残ります):"));
      out(`  boxglow sync --link ${halt.token} --prefer local`);
      out(t("サーバーの計画を採る (手元のファイルを置き換える。前の中身は、同じフォルダに <ファイル名>.before-sync-....json として残します):"));
      out(`  boxglow sync --link ${halt.token} --prefer remote`);
      break;
    case "remote-deleted":
      out(t("サーバー側で、この計画は消されています (自動では作り直しません)"));
      break;
    case "local-missing":
      out(t("手元の計画のファイルがありません: {file}", { file: o.file }));
      break;
    case "base-missing":
      out(t("同期の状態のフォルダから、前回そろえた中身の写しが見つかりません。結び付け直しが必要です"));
      break;
    case "binding-mismatch":
      out(t("このパスには、結び付けたときとは別の計画が置かれています (結び付けた計画の ID: {expected}、今の計画の ID: {actual})。同期しません", { expected: halt.expected, actual: halt.actual }));
      break;
  }
  return 2;
}
