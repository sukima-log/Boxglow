/** 英語の辞書 (canvas)。キー = ソースの日本語の文 */
export const canvas: Record<string, string> = {
  "待ち": "Waiting",
  "工程 {n}": "Stage {n}",
  "工程順": "Flow layout",
  "工程順に並べて表示。オフにすると保存した配置を表示します。": "Arrange by dependency for reading. Turn off to see the saved layout.",
  "判断待ち {n}": "Decisions {n}",

  // ボックス (BlockNode): 題名の行
  "カテゴリ: {label}": "Category: {label}"
, "{title} (部品: {name})": "{title} (part: {name})"
, "この大項目のタブを開く (中のボックス {n} 個)": "Open this item's tab ({n} boxes inside)"
, "下の階層を展開する": "Expand children"
, "下の階層を畳む": "Collapse children"
  // ボックス (BlockNode): 情報の行
, "状態": "Status"
, "下の階層の完了 {done}": "Children done: {done}"
, "下の階層の完了 {done} ({percent}%)": "Children done: {done} ({percent}%)"
, "進捗": "Progress"
, "進捗 {percent}%": "Progress {percent}%"
, "期日 {date}": "Due {date}"
, "期日 {date} ({d} 日超過)": "Due {date} ({d} days overdue)"
, "期日 {date} (あと {d} 日)": "Due {date} ({d} days left)"
, "必須の入力がそろっています (着手できます)": "All required inputs are ready (you can start)"
, "外部の課題: {url}": "External issue: {url}"
, "部品: {name}": "Part: {name}"
, "部品": "Part"
, "ID (検索や CLI で使えます)": "ID (usable in search and the CLI)"
  // ボックス (BlockNode): 入出力
, "{name} (用意できています)": "{name} (ready)"
, "{name} (任意: 無くても着手できます)": "{name} (optional: you can start without it)"
, "{name} を中のブロックへ (ここから中のボックスの入力へドラッグ)": "{name} into the inner boxes (drag from here to an inner input)"
, "中のブロックの出力を {name} へ": "Inner box output to {name}"
  // 入力 / 出力ノード (TerminalNode)
, "空のグループ (右のパネルで入力を入れる)": "Empty group (add inputs in the right panel)"
, "供給元のない入力がここに上がります": "Inputs without a source appear here"
, "下の階層の未接続の入力 (自動)": "Unconnected input from a child (auto)"
  // ボックスの幅の見積もり (size.ts) だけで使う文言
, "未担当": "Unassigned"
, "折り返し": "Wrap"
, "並行するボックスを段に折り返す": "Wrap parallel boxes into rows"
, "横フロー": "Horizontal flow"
, "縦フロー": "Vertical flow"
, "フローの方向": "Flow direction"
, "フローの方向はViewで切り替えます": "Switch flow direction in View mode"
, "横幅に合わせて、先頭から読む": "Fit width and read from the top"
, "幅に合わせる": "Fit width"
, "Shift＋ホイールで上下へ、Ctrl＋Shift＋ホイールで左右へ移動できます。": "Shift + scroll to pan vertically; Ctrl + Shift + scroll to pan horizontally."
, "ホイールで上下へ · Ctrl＋ホイールで拡大縮小": "Scroll to read · Ctrl + scroll to zoom"
};
