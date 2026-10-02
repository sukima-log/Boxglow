---
name: boxglow
description: Boxglow (boxglow.json) で計画と進捗を人間と共有する。作業の開始・分解・完了・判断待ちを npx boxglow で記録する。「進捗を Boxglow に記録して」「boxglow で状況を見て」「/boxglow」で使用。
---

# Boxglow で計画と進捗を共有する

リポジトリ直下の `boxglow.json` が計画の正本。人間は Boxglow の画面 (https://www.sukimalog.com/apps/boxglow/ で「boxglow.json を開く」) で見ている。
直接編集せず `npx boxglow` で更新する。

## 最初の計画づくり (新しいプロジェクトのとき)

1. 方針 (README、依頼文、要件メモ) を読み、`npx boxglow init --name "<名前>"` のあと、最上位に大項目 (3〜7 個) を `add` で置く。
   各大項目には「入力 (何を使うか)」と「出力 (具体的な成果物: ファイル・URL・PR)」を必ず書き、最終成果物まで線でつなぐ (`connect`)
2. 作ったら `npx boxglow ask <最初の大項目> "この大項目の分け方でよいですか?" --options "よい|直したい"` で人の確認を取る。
   人は画面でも、`npx boxglow answer <block> "<回答>"` でも、チャットでも答えられる。チャットで答えが返ったら AI が `answer --by human` で記録する。
   人が画面を使わない運用 (AI だけで進める指示があるとき) は、AI 自身が `answer --by claude-code "<判断と理由>"` で記録して先へ進む。判断の記録を残すことが目的で、画面は必須ではない
3. 着手する大項目だけを `split` で分解する (先の段階は粗いまま。進めながら細かくする)

## 手順

1. `npx boxglow status` を読む。判断待ちの回答、作業中の箱、次の候補を把握する
2. 担当する箱を決めたら `npx boxglow show <block>` で入出力を確認し、`npx boxglow start <block> --note "<何をするか>"`
3. 大きい箱は `npx boxglow split <block> --spec '<JSON>'` で分解する (形式は `npx boxglow help`)。各箱の出力を必ず決める
4. 成果物ができたら `npx boxglow done <block> --artifact "<名前>=<URL またはパス>"`
5. 人間の判断が要るときは `npx boxglow ask <block> "<質問>" --options "A|B"` して他の箱へ移る
6. 詰まったら `npx boxglow blocked <block> --note "<困っていること>"`
7. 最後に `npx boxglow status` を要約して報告する

## 約束

- 候補から 1 つを選ぶ場面 (方式・ライブラリ・設計の選択) では、AI が自分で決めるときも `ask <block> "<問い>" --options "A|B|C"` → `answer --by claude-code "<選んだもの>。理由: ..."` の形で記録し、選ばなかった候補を箱に残す (方針転換のときに戻れる)
- 方針転換は `reopen <block> --note "<理由>"` で前の答えを履歴に残して選び直す (候補は消さない)

- 同時に作業中にする箱は 1〜2 個まで
- 成果物 (artifact) は後から人が開けるもの (コミット、PR、ファイルのパス) にする
- 出力は具体的な成果物の名前にする (ファイル・PR・URL・テスト結果)。抽象的な名前 (機能一式、所見) は避ける
- 箱は必ず「入力 → 出力」でつなぐ。足りない入出力は `port`、外すのは `disconnect`。文書化は `export --out docs/ROADMAP.md`
- 箱を add するときは仕事の種類を `--category` で付ける (design 設計 / build 実装 / verify 検証 / evaluate 評価 / study 検討 / research 調査 / ui デザイン / improve 改善 / fix 課題解決 / docs 文書 / ops 運用 / other その他)。画面では色の帯と札になる
- boxglow.json がまだ無ければ `npx boxglow init --name "<プロジェクト名>"` で作り、最終成果物と最上位の箱を `add` で置く
