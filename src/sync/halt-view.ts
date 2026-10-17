/**
 * 止まった同期の結果を、画面と CLI の両方で使う表示の構造 (HaltView) にする。環境に依存しない (Node の裏方とブラウザの裏方が共有)
 * 文章の順番は CLI の表示の順番。選択肢は「操作 (SyncAction)」として持ち、画面は choiceIds に写して使う
 */
import { t } from "../i18n/core";
import type { HaltItem, HaltView, SyncAction } from "./status";
import type { SyncResult } from "./run";
import type { RecoveryOutcome } from "./engine";

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
      if(result.reconnect) choice(t("復元した計画 {id} に結び直す",{id:result.reconnect.remoteId}),`boxglow sync --reconnect-restored ${result.reconnect.token}${target}`,{kind:"reconnectRestored",token:result.reconnect.token});
      out(t("削除から30日以内なら、同期パネルの「サーバーの計画を管理」または boxglow remote trash から復元できます。復元後は新しいIDの計画を開いてください。"));
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
      // (アカウント ID を並べても利用者には分からない。何が起きたか・どうすればよいかだけを言う)
      out(t("この計画は、別のアカウントでサーバーに置かれたものです。今のサインインでは送受信しません (手元のファイルもサーバーも変えていません)。置いたときのアカウントでサインインし直すか、この計画を新しくサーバーに置いてください"));
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

export function quote(value: string): string {
  if ((globalThis as { process?: { platform?: string } }).process?.platform === "win32") return /^[A-Za-z0-9_\-./:@]+$/.test(value) ? value : "'" + value.replace(/'/g, "''") + "'";
  return /^[A-Za-z0-9_\-./:@]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

