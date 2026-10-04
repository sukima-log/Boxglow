/**
 * 英語の辞書 (model)。キー = ソースの日本語の文
 * 対象: src/model/graph.ts と src/model/merge.ts (ログの文・誤りの文・既定の名前)
 * 他の辞書に既にあるキーはここに書かない ("自動" は common.ts、"期日 {date}" は canvas.ts)
 */
export const model: Record<string, string> = {
  // --- 既定の名前 (作成時の言語で計画に書き込まれる) ---
  "最終成果物": "Final deliverable"
, "{name} の成果物": "{name} deliverable"
, "出力": "Output"
, "無題": "Untitled"
  // --- 結線の検査 (つなげない理由) ---
, "ポートが見つかりません": "Port not found"
, "同じポートどうしはつなげません": "A port cannot be connected to itself"
, "線は出力ポート (または親の入力) から引いてください": "Start the edge from an output port (or the parent's input)"
, "線は入力ポート (または親の出力) につないでください": "End the edge at an input port (or the parent's output)"
, "同じ階層のポートどうしだけつなげます": "Only ports on the same level can be connected"
, "循環する結線はできません": "Connections cannot form a cycle"
, "つなぐ先が見つかりません": "Connection target not found"
, "親に出力がありません": "The parent has no output"
, "同じ階層のボックス (または親子) にだけつなげます": "Only boxes on the same level (or parent and child) can be connected"
  // --- 読み込みの誤り ---
, "JSON として読めません": "Not valid JSON"
, "プロジェクトの形式ではありません": "Not a project file"
, "対応していないデータ形式の版です (schemaVersion={version})": "Unsupported data format version (schemaVersion={version})"
, "ブロック・ポート・線のデータが足りません": "Box, port, or edge data is missing"
, "Boxglow のテンプレート (boxglow-block) ではありません": "Not a Boxglow template (boxglow-box)"
, "入力グループの JSON (boxglow-input-group) ではありません": "Not an input group JSON (boxglow-input-group)"
, "知らないカテゴリです: {key}": "Unknown category: {key}"
  // --- 操作の誤り ---
, "ブロックが見つかりません": "Box not found"
, "親ブロックが見つかりません": "Parent box not found"
, "出力「{name}」がありません ({list})": "No output \"{name}\" ({list})"
  // --- 分解 (split) の指摘 ---
, "「{title}」の出力は 1 本にしました (下の階層を持たないボックスの出力は 1 本。{omitted} は省略)": "\"{title}\" was given a single output (a box with no children has one output; {omitted} omitted)"
, "ボックスが見つかりません": "Box not found"
, "「{title}」に入力「{port}」がありません": "\"{title}\" has no input \"{port}\""
, "「{title}」に出力「{port}」がありません": "\"{title}\" has no output \"{port}\""
, "結線できません: {from} -> {to} ({why})": "Cannot connect: {from} -> {to} ({why})"
  // --- ログ (Activity / CLI の log) ---
, "「{title}」を追加": "Added \"{title}\""
, "「{title}」の進捗 {value}": "\"{title}\" progress {value}"
, "「{title}」開始": "\"{title}\" started"
, "「{title}」詰まり": "\"{title}\" blocked"
, "「{title}」確認待ち": "\"{title}\" waiting for review"
, "「{title}」判断待ち": "\"{title}\" needs a decision"
, "「{title}」完了": "\"{title}\" done"
, "「{title}」で判断待ち: {question}": "\"{title}\" needs a decision: {question}"
, "「{title}」の判断: {question} → {answer}": "\"{title}\" decision: {question} → {answer}"
, "「{title}」の判断の答えを直した: {question} → {answer}": "\"{title}\" decision answer revised: {question} → {answer}"
, "「{title}」の判断をやり直し: {question} (前の答え: {answer}。理由: {note})": "\"{title}\" decision reopened: {question} (previous answer: {answer}; reason: {note})"
, "「{title}」の判断をやり直し: {question} (前の答え: {answer})": "\"{title}\" decision reopened: {question} (previous answer: {answer})"
, "「{title}」の回答を確認: {questions}": "\"{title}\" answers acknowledged: {questions}"
, "「{title}」を {status} に": "\"{title}\" set to {status}"
, "「{title}」を {count} 個に分解: {list}": "Split \"{title}\" into {count}: {list}"
, "テンプレート「{name}」v{version} を挿入: {title}": "Inserted template \"{name}\" v{version}: {title}"
, "「{title}」を「{parent}」の中へ移動": "Moved \"{title}\" into \"{parent}\""
, "入力グループ「{name}」を追加": "Added input group \"{name}\""
  // --- 日程のログ (「題名」+ 変えた項目の並び。"期日 {date}" は canvas.ts の "Due {date}" を使う) ---
, "「{title}」{detail}": "\"{title}\" {detail}"
, "開始 {date}": "Start {date}"
, "実績 {hours}h": "Actual {hours}h"
, "見積 {hours}h": "Estimate {hours}h"
, "なし": "none"
  // --- マージ (merge.ts): ボックスの短い ID の振り直し ---
, "{key} に振り直し": "renumbered to {key}"
  // --- 再開用の概要 (resume.ts) ---
, "作業の前に boxglow context <block> を読み、guard 付きの変更にはその contextToken を使ってください。この概要は回答を確認済みにせず、操作を許可するものでもありません。": "Read boxglow context <block> before work; use its contextToken for guarded changes. This overview does not acknowledge answers or authorize actions."
  // --- 計画ファイルの検査 (validate-file.ts) ---
, "使えないキーです: {key}": "Reserved key: {key}"
, "最上位のボックス (root) がありません": "Missing root block"
, "ボックスの参照が正しくありません: {id}": "Invalid block reference: {id}"
, "ボックスの親子が循環しています: {id}": "Parent cycle: {id}"
, "階層が深すぎます (256 段まで)": "Hierarchy exceeds 256 levels"
, "入出力の参照が正しくありません: {id}": "Invalid port reference: {id}"
, "線の参照が正しくありません: {id}": "Invalid edge reference: {id}"
, "線のつなぎ方が正しくありません: {id}: {reason}": "Invalid connection: {id}: {reason}"
, "線の種類が正しくありません: {id}": "Invalid edge kind: {id}"
};
