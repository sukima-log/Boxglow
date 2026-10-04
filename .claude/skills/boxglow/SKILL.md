---
name: boxglow
description: Boxglow (boxglow.json) で計画と進捗を人間と共有する。作業の開始・分解・完了・判断待ちを npx boxglow で記録する。「進捗を Boxglow に記録して」「boxglow で状況を見て」「/boxglow」で使用。
---

# Boxglow で計画と進捗を共有する

リポジトリ直下の `boxglow.json` が計画の正本。人間は Boxglow の画面 (https://boxglow.pages.dev/ で「boxglow.json を開く」) で見ている。
直接編集せず `npx boxglow` で更新する。

## 最初の計画づくり (新しいプロジェクトのとき)

1. 方針 (README、依頼文、要件メモ) を読み、`npx boxglow init --name "<名前>"` のあと、最上位に大項目 (3〜7 個) を `add` で置く。
   各大項目には「入力 (何を使うか)」と「出力 (具体的な成果物: ファイル・URL・PR)」を必ず書き、最終成果物まで線でつなぐ (`connect`)
2. 作ったら `npx boxglow ask <最初の大項目> "この大項目の分け方でよいですか?" --options "よい|直したい"` で人の確認を取る。
   人は画面でも、`npx boxglow answer <block> "<回答>"` でも、チャットでも答えられる。チャットで答えが返ったら AI が `answer --by human` で記録する。
   人が画面を使わない運用 (AI だけで進める指示があるとき) は、AI 自身が `answer --by claude-code "<判断と理由>"` で記録して先へ進む。判断の記録を残すことが目的で、画面は必須ではない
3. 着手する大項目だけを `split` で分解する (先の段階は粗いまま。進めながら細かくする)

## 手順

1. `npx boxglow resume` (または `npx boxglow status --brief`) を読む。引き継ぎメモ、AI 未確認の回答、判断待ち、作業中のボックス、次の候補を把握する。全階層が要るときは `npx boxglow status`
2. 担当するボックスを決めたら `npx boxglow show <block>` で入出力を確認し、`npx boxglow start <block> --note "<何をするか>"`。
   確認トークンの要求 (guard) が有効な計画では、先に `npx boxglow context <block>` を読み、出力の `contextToken` (確認トークン) を `--context-token <確認トークン>` で付ける
3. 大きいボックスは `npx boxglow split <block> --spec '<JSON>'` で分解する (形式は `npx boxglow help`)。各ボックスの出力を必ず決める
4. 成果物ができたら `npx boxglow done <block> --artifact "<名前>=<URL またはパス>"` (guard が有効なら `--context-token <確認トークン>` を付ける。直前の自分の操作の出力に「新しい確認トークン: <token>」が出ていれば、それを使う)
5. 人間の判断が要るときは `npx boxglow ask <block> "<質問>" --options "A|B"` して他のボックスへ移る
6. 詰まったら `npx boxglow blocked <block> --note "<困っていること>"`
7. 中断・コンテキストの圧縮・引き継ぎの前に `npx boxglow checkpoint <block> --note "分かったこと; 次にすること; 未解決のこと"` で引き継ぎメモを残す
8. 最後に `npx boxglow status --brief` を要約して報告する

## 約束

- `ask` の質問は、それだけで判断できるように書く。「これでよいですか」「上記の案」のように外を指さず、前提・比較・影響を `--context` に書く (人は一覧の中の質問だけを読んで答える)
- 候補から 1 つを選ぶ場面 (方式・ライブラリ・設計の選択) では、AI が自分で決めるときも `ask <block> "<問い>" --options "A|B|C"` → `answer --by claude-code "<選んだもの>。理由: ..."` の形で記録し、選ばなかった候補をボックスに残す (方針転換のときに戻れる)
- 方針転換は `reopen <block> --note "<理由>"` で前の答えを履歴に残して選び直す (候補は消さない)

- 同時に作業中にするボックスは 1〜2 個まで
- 成果物 (artifact) は後から人が開けるもの (コミット、PR、ファイルのパス) にする
- 出力は具体的な成果物の名前にする (ファイル・PR・URL・テスト結果)。抽象的な名前 (機能一式、所見) は避ける
- 結線の受け側は題名だけでよい (`connect "A.設計書" "B"` で B に入力「設計書」が作られる)。入力名は供給元の出力名で決まり、入力側では変えない
- ボックスは必ず「入力 → 出力」でつなぐ。足りない入出力は `port`、外すのは `disconnect`、ボックスそのものを消すのは `remove`。文書化は `export --out docs/ROADMAP.md`
- ボックスを add するときは仕事の種類を `--category` で付ける (design 設計 / build 実装 / verify 検証 / evaluate 評価 / study 検討 / research 調査 / ui デザイン / improve 改善 / fix 課題解決 / docs 文書 / ops 運用 / other その他)。画面では色の帯と札になる
- boxglow.json がまだ無ければ `npx boxglow init --name "<プロジェクト名>"` で作り、最終成果物と最上位のボックスを `add` で置く

## 確認トークンと引き継ぎ

確認トークンの要求 (guard) は、AI が古い指示のまま作業を進めるのを防ぐ仕組み。`setup-agent` が有効にする (それ以外の計画では `npx boxglow guard on`)。
有効な計画では、AI の `start` / `done` / `set` / `split` / `artifact` / `ack` / `blocked` / `review` / `leave` / `checkpoint` に `--context-token <確認トークン>` が要る。人の操作 (`--actor human`) には要求されない。

```
npx boxglow context B12        # 判断 (引き取り済みの回答を含む)・入出力の条件・引き継ぎメモを読む。出力の contextToken が確認トークン
npx boxglow start B12 --note "<何をするか>" --context-token <確認トークン>
npx boxglow ask B12 "<質問>" --options "A|B" --context-token <確認トークン>
#   → 出力の最後の行: 新しい確認トークン: <token>
npx boxglow done B12 --artifact "<名前>=<パス>" --context-token <新しい確認トークン>
```

- **確認トークンが変わる場合 (読み直しが要る)**: 人が回答した・回答を直した、人が指示 (題名・説明・入出力の条件) を変えた、他の AI や人が引き継ぎメモを更新した。親や入力元のボックスで起きた場合も同じ。古い確認トークンは拒否されるので、`context` を読み直し、変わった内容を作業に反映してからやり直す
- **確認トークンが変わらない場合**: `start` / `blocked` / `review` / `leave` / `ack`、進捗・状態・期日・カテゴリの変更、`check` による成果物の確認、画面での配置の変更。同じ確認トークンを使い続けられる
- **自分で更新できる場合**: 自分の `ask` / `artifact` / `done` / `set` / `split` / `checkpoint` などでコンテキストが変わったときは、その出力の最後の行に「新しい確認トークン: <token>」が出る。読み直さずに次の操作へ使う。`ask` / `decision` / `answer` / `reopen` は確認トークン無しでも実行できるが、新しい確認トークンが出るのは最新の確認トークンを付けたときだけ
- 古い確認トークンを通すために guard を無効にしない (AI が `guard off` するには最新の確認トークンが要る)
- 再開するときは `npx boxglow resume` を読み、引き継ぎメモのあるボックスは `context` で中身を確かめてから続ける。引き継ぎメモは会話の履歴や活動ログの上限とは別に、計画の中に残る
- MCP では `boxglow_context` と、各ツールの `contextToken` 引数を使う
- 「他の Boxglow が書き込み中 (ロック中)」と出て、少し待ってやり直しても解けないときは、`npx boxglow unlock` の表示 (持ち主と判定) を人に見せて解除を頼む。自分で `--actor human` を付けたり、ロックのフォルダを直接消したりしない
