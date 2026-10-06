/** 英語の辞書 (app: App / TopBar / TabBar / HomeDialog / store の toast)。キー = ソースの日本語の文 */
export const app: Record<string, string> = {
  "最新のファイルを取得できません。接続を確認して保存を再試行してください。": "Could not read the latest file. Check the connection and retry saving.",
  "別の保存処理が進行中です。編集は保持しています。少し待って保存を再試行してください。": "Another save is in progress. Your edits are retained. Wait briefly and retry saving.",
  "計画の形式や参照に問題があり、保存できません。編集を JSON で退避して確認してください。": "The plan has an invalid structure or reference. Export your edits as JSON for review.",
  "計画が保存可能なサイズ（5 MiB）を超えています。編集を JSON で退避してください。": "The plan exceeds the 5 MiB save limit. Export your edits as JSON.",
  "接続できません。編集は保持しています。サーバーを確認して保存を再試行してください。": "Connection failed. Your edits are retained. Check the server and retry saving.",
  "閲覧専用": "Read only",

  "保存の応答がありません。編集は画面に残っています。再試行してください。": "No save acknowledgement. Your edits remain here. Retry saving.",
  "他の編集と競合しました。両方の変更を保持しているので、統合方法を選んでください。": "Another edit conflicts with yours. Both versions are retained. Choose how to resolve them.",
  "共同編集は npx boxglow serve --open または VS Code 拡張で開いてください。": "For shared editing, open with npx boxglow serve --open or the VS Code extension.",
  "未保存の編集があります。必要なら JSON を書き出してください。編集を破棄して移動しますか？": "You have unsaved edits. Export JSON if needed. Discard the edits and leave?",
  // store (useProjectStore の canLeave) が使う文は「先に」が入る。キーが 1 文字でも違うと英語にならないので両方置く
  "未保存の編集があります。必要なら先に JSON を書き出してください。編集を破棄して移動しますか？": "You have unsaved edits. Export JSON first if needed. Discard the edits and leave?",
  "保存に失敗しました": "Saving failed",
  "このファイルは閲覧専用です。共同編集は npx boxglow serve --open または VS Code 拡張で開いてください。": "This file is read-only. For shared editing, use npx boxglow serve --open or the VS Code extension.",
  "手元の編集を JSON で退避": "Export unsaved edits as JSON",
  "手元を退避して最新のファイルを開く": "Export mine and open the latest file",
  "別の項目の変更です。統合できます。": "Different fields changed. They can be merged.",
  "保存を再試行": "Retry saving",
  "AI への引き継ぎ": "Agent handoff",
  "セッションを越えて残す発見・次の手順・未解決事項。AI は context コマンドで判断と合わせて読み直します。": "Keep findings, next steps and open questions across sessions. Agents reread these with decisions using the context command.",
  "発見 / 次の手順 / 未解決事項": "Findings / next steps / open questions",
  "引き継ぎ情報をコピーしました": "Handoff context copied",
  "判断・入出力も含めてコピー": "Copy with decisions and input/output contracts",
  "ファイルを閲覧": "View file",

  "コピー": "Copy",
  "ブラウザ内": "Browser",
  // App: キー操作・パンくず・絞り込み (ボックスの削除の確認文は inspector.ts にある)
  "新しいブロック": "New box"
, "大項目の一覧へ": "Back to the overview"
, "{title} へ戻る": "Back to {title}"
, "絞り込みを解除": "Clear the filter"
  // App: ヘルプ
, "ブロックを置く": "Add a box"
, "または「+ Block」(選んだボックスの中に)": "or \"+ Box\" (inside the selected box)"
, "上の切替。Edit のときだけドラッグで移動・結線・階層移動と Del が効く": "Toggle at the top. Drag to move, wire, re-parent and Del work only in Edit"
, "結線": "Wire"
, "丸から相手の丸、または相手のボックスへドラッグ (近くで離せばつながる)": "Drag from a dot to another dot or box (release nearby to connect)"
, "階層を移す": "Move into a box"
, "ボックスをドラッグして別のボックスの中に落とす": "Drag a box and drop it inside another"
, "下の階層を畳む / 展開": "Collapse / expand"
, "ブロックをダブルクリック": "Double-click a box"
, "削除": "Delete"
, "元に戻す / やり直す": "Undo / Redo"
, "選択を解除": "Clear selection"
, "ボックスは「入力から出力を作るタスク」。出力を先に決め、大きなボックスは「分解する」で中にボックスを置く。供給元の無い入力は左端の入力まで自動で点線が伸びる。": "A box is a task that turns inputs into an output. Decide the output first; break big boxes down by putting boxes inside. Inputs with no source get a dotted line from the left edge automatically."
  // App: 埋め込み・フッタ
, "Boxglow で開く": "Open in Boxglow"
, "ビルド日時 (日本時間)。古い場合は再読み込み (Ctrl+F5) してください": "Build time (JST). If it looks old, reload with Ctrl+F5"
  // TopBar: ボタンの説明
, "追加するプロジェクトの名前 (リポジトリごとに 1 つなど)": "Name of the project to add (e.g. one per repository)"
, "Mermaid をコピーしました": "Mermaid copied"
, "コピーできませんでした": "Could not copy"
, "サンプルは保存されません。Save で自分のプロジェクトとして保存": "The sample is not saved. Press Save to keep it as your own project"
, "このブラウザに自動で保存します": "Auto-saves in this browser"
, "階層 / 絞り込み / メンバー / 部品": "Tree / Filter / Members / Parts"
, "Home (プロジェクト一覧へ)": "Home (project list)"
, "自分のプロジェクトとして保存": "Save as your own project"
, "今の状況 (作業中・判断待ち・ログ)": "Current activity (working, decisions, log)"
, "Edit モード: ドラッグで移動・結線・階層移動ができます。押すと View (閲覧) に": "Edit mode: drag to move, wire and re-parent. Click to switch to View"
, "View モード: ドラッグでの編集は効きません。押すと Edit に": "View mode: dragging does not edit. Click to switch to Edit"
, "Search  ID / 題名": "Search  ID / title"
, "見つかりません": "No matches"
, "ブロックを追加 (N)。ボックスを選んでいればその中に、選んでいなければプロジェクトの中に": "Add a box (N): inside the selected box, or in the project if nothing is selected"
, "Auto Layout: 依存関係で並べ直す (大項目は畳んだ前提)": "Auto Layout: arrange by dependencies (top-level boxes assumed collapsed)"
, "元に戻す (Ctrl+Z)": "Undo (Ctrl+Z)"
, "やり直す (Ctrl+Y)": "Redo (Ctrl+Y)"
, "同じファイルにプロジェクトのボックスを足す": "Add a project box to the same file"
, "画面の文言の言語を切り替える": "Switch the UI language"
  // TabBar
, "タブの一覧 (押して選ぶ)": "List of tabs (click to pick)"
, "左へ": "Scroll left"
, "右へ": "Scroll right"
, "大項目の一覧を俯瞰する (中はそれぞれのタブで)": "Overview of top-level boxes (open a tab to look inside)"
, "{title} (選んだ線の続きがある)": "{title} (the selected wire continues here)"
, "{title} の中を見る": "Look inside {title}"
  // HomeDialog
, "AI エージェントとチームの作業を、ボックスと線で一目で。": "See what AI agents and your team are doing, at a glance, as boxes and wires."
  // 太字の npx boxglow を挟むので 2 つに分かれている: "<前> npx boxglow <後>"
, "前回開いたファイル": "The file you opened last time"
, "「{name}」を削除します。よろしいですか?": "Delete \"{name}\"?"
  // リンク (sukimalog.com) を挟むので 2 つに分かれている: "<前> (sukimalog.com) <後>"
, "すきま研究所日誌": "An app from Sukima Lab Diary"
  // store: toast など
, "サーバに書けません ({status})": "Could not write to the server ({status})"
, "ファイルへの書き込みが許可されていません (Save を押すともう一度確認します)": "Writing to the file was not allowed (press Save to ask again)"
, "保存に失敗しました: {error}": "Save failed: {error}"
, "ファイルへの書き込みが許可されていません": "Writing to the file was not allowed"
, "無題のプロジェクト": "Untitled project"
, "ファイルの読み書きが許可されませんでした": "Access to the file was not allowed"
, "ファイルを読めません: {error}": "Could not read the file: {error}"
, "サーバから読めません (npx boxglow serve が動いていますか): {error}": "Could not read from the server (is npx boxglow serve running?): {error}"
, "「{name}」を読み込みました": "Loaded \"{name}\""
, "{name} (複製)": "{name} (copy)"
, "自分のプロジェクトとして保存しました": "Saved as your own project"
, "このファイルはブラウザから直接開けませんでした ({error})。npx boxglow serve --open なら、どの場所のファイルでも開けます": "The browser could not open this file directly ({error}). npx boxglow serve --open opens a file in any location"

, "AI と一緒に使う": "WORK WITH YOUR AI AGENT"
, "リポジトリの計画を開く": "Open your repository plan"
, "WSL・Firefox・Safari でも使うには、計画のあるフォルダーで実行します。": "For WSL, Firefox or Safari, run this in the folder containing your plan."
, "まずブラウザで試す": "Try it in your browser"
, "作成・インポートした計画は、このブラウザに保存されます。元のファイルや AI とは自動で同期しません。": "Created and imported plans are saved in this browser. They do not automatically sync with the original file or your AI agent."
, "新しい計画の名前": "New project name"
, "このブラウザに保存した計画": "Saved in this browser"
, "使い方・CLI の手順": "Guide and CLI commands"
, "コマンドをコピーしました": "Command copied"
, "「{name}」を削除": "Delete \"{name}\""
, "変更なし": "No changes"
  // --- 保存の競合の統合で残すログ (useProjectStore.ts) ---
, "競合を統合: {path} (採用: {selected} / 手元: {ours} / 相手: {theirs})": "Conflict {path}: selected {selected}; local {ours}; remote {theirs}"
, "同期済み": "Synced"
, "送信待ち": "Unsent"
, "同期中": "Syncing"
, "確認": "Action needed"
, "問題": "Problem"
, "通信不可": "Offline"
, "一時停止": "Paused"
, "別プロセス": "Other process"
, "未対応": "Unsupported"
, "未サインイン": "Signed out"
, "未接続": "Not linked"
, "オフ": "Off"
, "同期": "Sync"
, "この環境では、まだサインインを保存できません": "Sign-in cannot be stored in this environment yet"
, "サインアウト": "Sign out"
, "環境変数のトークンで同期しています": "Syncing with the token from the environment variable"
, "GitHub でサインイン": "Sign in with GitHub"
, "この計画を同期する": "Sync this plan"
, "サーバーに置く": "Put on the server"
, "今すぐ同期": "Sync now"
, "未保存の編集があります。保存すると送られます": "There are unsaved edits. They are sent after you save"
, "先に保存してください": "Save first"
, "詳細を閉じる": "Hide details"
, "詳細": "Details"
, "控え": "Backup"
, "サーバーの版: {revision}": "Server revision: {revision}"
, "閉じる": "Close"
, "ブラウザで次のページを開き、コードを入力してください": "Open this page in your browser and enter the code"
, "中止": "Cancel"
, "手元のファイルを直してください": "Fix the local file"
, "同期の状態のフォルダを確かめてください": "Check the sync state folder"
, "サーバーの中身を確かめてください": "Check the content on the server"
, "サインインを確かめてください": "Check your sign-in"
, "もう一度同期してください": "Sync again"
, "しばらく待ちます": "Waiting a while"
, "同期で受け取った最新の中身を、VS Code のエディタがまだ読み込んでいません。": "The VS Code editor has not loaded the latest content received by sync yet."
, "退避済み: {path}。ファイルを閉じて開き直し、「退避した編集を読み込む」で見比べてください": "Saved a copy to {path}. Close and reopen the file, then use \"Load saved edits\" to compare"
, "画面に未保存の編集があります。先に別のファイルへ退避してから、ファイルを閉じて開き直してください (退避せずに閉じると、この編集は失われます)": "There are unsaved edits in this view. Save a copy to another file first, then close and reopen the file (closing without a copy loses these edits)"
, "未保存の編集はありません。ファイルを閉じて開き直すと、最新の中身になります": "No unsaved edits. Close and reopen the file to get the latest content"
, "編集を退避する": "Save a copy of the edits"
, "退避した編集を読み込む": "Load saved edits"
, "VS Code のエディタが、同期で受け取った最新の中身をまだ読み込んでいません。編集を退避してから、ファイルを閉じて開き直してください": "The VS Code editor has not loaded the latest content received by sync. Save a copy of your edits, then close and reopen the file"
, "同期で受け取った中身があります。手元の編集と見比べてください": "Sync received new content. Compare it with your edits"
, "Google でサインイン": "Sign in with Google"
, "ブラウザで次のページを開き、Google のアカウントで許可してください": "Open this page in your browser and allow with your Google account"
, "Google のサインインのページを開く": "Open the Google sign-in page"
, "退避したファイルとして読めません": "Not a saved copy of edits"
, "先にファイルを閉じて開き直し、最新の中身にしてから読み込んでください": "Close and reopen the file to get the latest content first, then load the saved edits"
, "退避した編集を取り込みました (両側で違っていた項目は、退避した編集の値にしました: {paths})。保存すると送られます": "Restored the saved edits (items changed on both sides take the saved value: {paths}). They are sent after you save"
, "退避した編集を取り込みました。保存すると送られます": "Restored the saved edits. They are sent after you save"
, "(無し)": "(none)"
, "今の値": "Current value"
, "退避した画面の値": "Saved view value"
, "退避したエディタの値": "Saved editor value"
, "退避した編集の取り込み": "Restore saved edits"
, "退避した編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どの値を採るかを選んでください。": "The saved edits and the current content changed the same items differently. Choose which value to keep for each item."
, "取り込む": "Restore"
, "やめる": "Cancel"
, "別の計画の退避ファイルです。取り込めません": "This saved copy belongs to another plan. It cannot be restored here"
, "取り込むものがありません": "Nothing to restore"
, "全部の項目について、どの値を採るかを選んでください": "Choose a value for every item"
, "取り込んだ結果が、計画として正しくなりません (親子の関係などが矛盾します)。画面は元のままです": "The result would not be a valid plan (for example, conflicting parent relations). The view is unchanged"
, "退避した編集を取り込みました。保存すると送られます (取り消すこともできます)": "Restored the saved edits. They are sent after you save (you can undo)"
, "表示した後で、今の中身が変わりました。今の値で選び直してください": "The current content changed after this was shown. Choose again with the current values"
, "(消されている)": "(deleted)"
, "退避した画面の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。": "The saved view edits and the current content changed the same items differently. Choose which one to keep for each item."
, "退避したエディタ側の編集と、今の中身で、同じ項目が違う値になっています。項目ごとに、どちらを採るかを選んでください。": "The saved editor edits and the current content changed the same items differently. Choose which one to keep for each item."
, "退避した編集を取り込んだので、自動保存を止めています。確かめてから Save で保存してください": "Auto-save is paused because saved edits were restored. Check, then press Save"
, "自動保存を一時停止中": "Auto-save paused"
, "退避した編集を取り込みました。自動保存を止めています。確かめてから Save で保存してください (取り消すこともできます)": "Restored the saved edits. Auto-save is paused; check, then press Save (you can undo)"
, "取り込みの確認の途中です。先に、表示中の欄で選ぶか、やめてください": "A restore is waiting for your choice. Choose in the open panel or cancel it first"
, "エディタ側の編集は取り込みませんでした。画面側の取り込みは残っています (取り消しで戻せます)。確かめてから Save で保存してください": "The editor edits were not restored. The view edits stay restored (you can undo). Check, then press Save"
, "画面側": "view"
, "エディタ側": "editor"
, "と": " and "
, "{done}の編集は取り込みました。{failed}の編集は取り込めませんでした: {reason}。Save の前に中身を確かめてください (取り消しで戻せます)": "Restored the {done} edits. The {failed} edits could not be restored: {reason}. Check the content before saving (you can undo)"
, "{done}の編集を取り込みました。自動保存を止めています。確かめてから Save で保存してください (取り消すこともできます)": "Restored the {done} edits. Auto-save is paused; check, then press Save (you can undo)"
, "{done}の編集は取り込みました。次に、エディタ側の編集を確かめてください": "Restored the {done} edits. Next, check the editor edits"
, "画面側の編集は取り込み済みです。「今の値」は、その結果です。": "The view edits are already restored. \"Current value\" is that result."
, "この段をやめる": "Skip this step"
};
