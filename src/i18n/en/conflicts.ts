/** 保存・同期のブロック比較で使う英訳。 */
export const conflicts: Record<string, string> = {
  "この同期には人の判断が必要です。AIは変更の違いと停止理由を要約してaskで知らせ、人が画面またはCLIで選ぶまで待ってください。AIは選択を代行しないでください。": "This sync needs a human decision. Summarize the differences and stop reason, notify the user with ask, and wait for the user to choose in the UI or CLI. AI must not apply the choice.",
  "結び付け済みの計画を同期し、停止理由と比較を返す。判断が必要ならAIはaskで人に知らせる。人が画面かCLIで選ぶ。": "Sync the bound project and return stop reasons and comparisons. AI must ask the user when a decision is needed. The user chooses in the UI or CLI.",
  "この操作には人による確認が必要です。内容を確認したうえで、次のコマンドを実行してください。": "This operation requires your confirmation. Review the choices, then run the following command.",
  "同期先が決まっていません。人に同期先の確認と初回の結び付けを依頼してください。": "No sync target is configured. Ask the user to choose a server and create the initial binding.",
  "人が確認する選択肢: {label}": "Choice for the user to review: {label}",
  "削除されたメンバー {member} の担当を {block} から外しました。": "Removed deleted member {member} from the assignees of {block}.",
  "この選択で担当が外れるボックス: 最大 {n}（他の項目の選択によって変わります）": "This choice may remove assignments from up to {n} blocks (depends on other choices).",
  "これより前には戻せません。相手の変更と矛盾するため、古い履歴を終了しました。": "Cannot undo further. Earlier history conflicts with external changes and has been discarded.",
  "これより先には進めません。相手の変更と矛盾するため、やり直しの履歴を終了しました。": "Cannot redo further. Later history conflicts with external changes and has been discarded.",
  "競合の解決・初回の結び付けなどの判断は人専用です。AIは比較を要約してaskで知らせてください。人が画面で選ぶか、CLIで同じコマンドに --actor human を付けて実行してください。": "Conflict resolution, initial binding, and other choices require a human. AI must summarize the comparison and ask the user. A human can choose in the UI or run the same CLI command with --actor human.",
  "結び付け済みの計画を同期し、停止理由と比較を返す。判断が必要ならAIはaskで人に知らせる。人が画面かCLIの --actor human で選ぶ。": "Sync the bound project and return stop reasons and comparisons. AI must ask the user when a choice is required. A human chooses in the UI or CLI with --actor human.",
  "同期先が決まっていません。初めて結び付けるときは boxglow sync --server <URL> --actor human を指定してください": "No sync target. A human must create the initial binding with boxglow sync --server <URL> --actor human.",
  "折りたたみ済み": "Collapsed",
  "展開済み": "Expanded",
  "はい": "Yes",
  "いいえ": "No",
  "未着手": "Not started",
  "完了": "Done",

  "受け取った計画の形式や参照を確認できません。編集は保持しています。退避してファイルを確認してください。": "The received project has an invalid format or references. Your edits are preserved. Export them and check the file.",
  "担当のメンバーが見つかりません: {id}": "Assigned member not found: {id}",
  "入力グループが見つかりません: {id}": "Input group not found: {id}",
  "この組み合わせでは参照がつながりません。同じ比較で選び直してください。": "These choices break references. Choose again in the same comparison.",
  "選択ファイルを読めません。--choices-file のパスと読み取り権限を確認してください。": "Cannot read the choices file. Check the --choices-file path and read permissions.",
  "選択ファイルが正しいJSONではありません。内容を確認してください。": "The choices file is not valid JSON. Check its contents.",
  "手元側をグループ全体に採用すると削除: {n} ボックス": "Choosing local for this entire group deletes {n} blocks",
  "相手側をグループ全体に採用すると削除: {n} ボックス": "Choosing the other side for this entire group deletes {n} blocks",
  "手元側を採用しても追加保護で残る: {names}": "Kept to protect additions even when choosing local: {names}",
  "相手側を採用しても追加保護で残る: {names}": "Kept to protect additions even when choosing the other side: {names}",
  "項目別の選択では、削除数と残るボックスが変わる場合があります。": "Choosing by field can change which blocks are deleted or kept.",

  "手元側で削除されたボックス: {n} (子孫を含む)":
    "Blocks deleted locally: {n} (including descendants)",
  "相手側で削除されたボックス: {n} (子孫を含む)":
    "Blocks deleted on the other side: {n} (including descendants)",
  "--resolve の印と --block <内部ID>=local|remote / --settings local|remote、または --choices-file <JSON> で全グループを選んでください。":
    "Choose every group with the --resolve token and --block <internal-id>=local|remote / --settings local|remote, or --choices-file <JSON>.",
  "すべてのグループ、またはその中の全項目を選んでください。":
    "Choose a side for every group, or for every field within it.",
  コンテキストの確認: "Context guard",
  サーバーの値: "Server version",
  ブロック単位で選ぶ: "Choose by block",
  ボックス: "Block",
  メンバー: "Members",
  リポジトリ: "Repository",
  "両方の変更を統合して保存しました。": "Both changes merged and saved.",
  作業の範囲: "Work scope",
  作業方針: "Workflow policy",
  入出力の位置: "Terminal positions",
  公開範囲: "Visibility",
  "削除・移動と関連する変更を一緒に確認してください。":
    "Review the deletion or move together with its related changes.",
  参照先がありません: "Reference unavailable",
  "同じ項目をグループと詳細の両方で選ぶことはできません。":
    "Choose a field either through its group or individually, not both.",
  "同期するファイルを file または BOXGLOW_FILE で指定してください。":
    "Specify the file to sync with file or BOXGLOW_FILE.",
  "変更が続いているため保存を待っています。編集は保持しています。保存を再試行してください。":
    "Changes are still arriving. Your edits are preserved. Please retry saving.",
  折りたたみ: "Collapsed",
  接続元: "Source",
  活動: "Activity",
  種類: "Kind",
  "競合の指定が不正です。共通JSON、--prefer、--block / --settings のいずれかを使ってください。":
    "Invalid conflict choices. Use the shared JSON request, --prefer, or --block / --settings.",
  "表示したときから内容が変わりました。比較し直して選んでください。":
    "The content has changed since this comparison. Review the latest values and choose again.",
  親ボックス: "Parent block",
  言語: "Language",
  計画の設定: "Project settings",
  "計画を同期し、競合はブロック単位の共通形式で選ぶ。未選択の競合がある間は送受信しない。":
    "Sync a project and resolve conflicts by block using the shared request format. No changes are applied while a conflict remains unselected.",
  "詳細 (CLIの選択キー)": "Details (CLI selection keys)",
  課題: "Issue",
  "選択に未知の項目、または同じ依存グループの重複があります。":
    "Choices contain an unknown item or repeat the same dependency group.",
  開始日: "Start date",
  面: "Side",
  項目ごとに選ぶ: "Choose by field",
  "この計画は {bound} に結び付いており、指定された {requested} とは違います。何も変更していません。人に同期対象を確認してください。": "This plan is bound to {bound}, not the requested {requested}. Nothing was changed. Ask a human to confirm the sync target.",
  "指定された選択は今の状態に当てはまりません。何も変更していません。最新の比較を人に確認してもらってください。": "The choice no longer applies to the current state. Nothing was changed. Ask a human to review the latest comparison.",
  "一部は相手の変更と重なるため戻せませんでした。相手の変更は保持しています。": "Some changes could not be reverted because they overlap with external changes. The external changes have been preserved.",
  "人が実行している場合は、boxglow sync --help の「人の操作」を参照してください。": "If you are running this as a person, see Human operations in boxglow sync --help.",
  "人の操作: 初回の結び付けや競合の選択は、人が --actor human または --actor human:名前 を明示して実行します。BOXGLOW_ACTORだけでは選択を許可しません。AIは人を名乗らず、比較を伝えて人の操作を待ってください。": "Human operations: For initial binding or conflict choices, a person explicitly supplies --actor human or --actor human:name. BOXGLOW_ACTOR alone does not authorize choices. AI must not impersonate a person; report the comparison and wait for human action.",
};
