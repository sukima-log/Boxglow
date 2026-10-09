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

1. `npx boxglow resume` (または `npx boxglow status --brief`) を読む。作業中のボックス、判断待ち、AI 未確認の回答、次の候補、未完了の引き継ぎメモを把握する。全階層が要るときは `npx boxglow status`
2. 担当するボックスを決めたら `npx boxglow show <block>` で入出力を確認し、`npx boxglow start <block> --note "<何をするか>"`。
   確認トークンの要求 (guard) が有効な計画では、先に `npx boxglow context <block>` を読み、出力の `contextToken` (確認トークン) を `--context-token <確認トークン>` で付ける
3. 大きいボックスは `npx boxglow split <block> --spec '<JSON>'` で分解する (形式は `npx boxglow help`)。各ボックスの出力を必ず決める
4. 成果物ができたら `npx boxglow done <block> --artifact "<名前>=<URL またはパス>"` (guard が有効なら `--context-token <確認トークン>` を付ける。直前の自分の操作の出力に「新しい確認トークン: <token>」が出ていれば、それを使う)
5. 人間の判断が要るときは `npx boxglow ask <block> "<質問>" --options "A|B"` して他のボックスへ移る
6. 詰まったら: 入力 (前のボックスの成果物・資料) が足りないことが原因なら、詰まりにしない。`npx boxglow show <block>` で入力の配線を確かめ、足りないものを作るボックスが無ければ `npx boxglow add` で外 (上流) に作り、`npx boxglow connect` でこのボックスの入力につなぐ (配線が「待ち」の色で残り、何を待っているかが図で見える)。選択肢から選んでもらえば進めるなら `ask`。それ以外の、計画の外にある障害 (環境が動かない、権限やキーが無い、外部の返事待ち、原因の分からない失敗) だけを `npx boxglow blocked <block> --note "<困っていること>"` で記録する
7. 中断・コンテキストの圧縮・引き継ぎの前に `npx boxglow checkpoint <block> --note "分かったこと; 次にすること; 未解決のこと"` で引き継ぎメモを残す
8. 最後に `npx boxglow status --brief` を要約して報告する

## 約束

- **まだ決まっていない分かれ道は分岐で表す**: 計画を作る時点で、判断次第で後の作業 (道) が変わるときは `npx boxglow branch "<題名>" --options "A|B" --question "<問い>" --context "<判断材料>"` で分岐のボックスを作る。選択肢ごとに道 (出力) ができるので、それぞれの道の最初のボックスへ `connect` する。道が後で 1 つにまとまるところの入力は `npx boxglow port <block> --any-of <入力名>` で合流 (どれか 1 つが届けばよい) にする。人が答えると、選ばなかった道の先は「見送り」になり、進捗と次の候補から外れる。答えが出る前の道のボックスは「分岐待ち」で、着手すると警告される (先に下調べするなど理由があれば `--reason` で記録する)
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


### 着手・完了、今回の範囲、記録の鮮度

- 最初に resume の現況 (活動・判断待ち・未確認回答) を読む。候補は「今回の範囲 / その他」の各組で「着手できる / 入力待ち」に分かれ、不足する入力名が出る。入力待ちを、準備済みと取り違えない。
- ボックスの任意4項目を scope で設定する。goal = 今回達成すること、non-goals = 今回は扱わないこと、acceptance = 完了と判断する条件、consult = 範囲を広げる前に相談する条件。context の先頭で対象と親の範囲を読み、着手前と完了前に照合する。完了条件の本文をAIが満たしたかは自動判定しない。
- scope B12 --goal "達成すること" --non-goals "今回扱わないこと" --acceptance "確認する条件" --consult "相談する条件" で設定する。scope B12 は表示だけ。各項目に none または空文字を渡すと消す。画面では詳細パネルの ⋯ →「作業範囲を編集」。記入済みの項目だけが「今回の範囲」に出る。
- focus B12 でこのボックスと配下を次候補の先頭にする。focus は現在の対象の表示、focus none は解除。対象外も別の組に残る。候補に出ること自体は作業範囲の拡大や公開を許可しない。
- start の必須入力不足は既定で警告するが、従来どおり開始できる。先行作業が必要なら --reason "先に行う理由" を付ける。警告は出ず、理由は活動とログに残る。done の出力成果物なしも既定で警告のみ。既存の出力成果物または --artifact を数え、ボックスの参考資料は数えない。
- 計画で選ぶ場合だけ policy --start reject --done reject にする。それぞれ warn に戻せる。入力待ちの拒否でも理由付きの開始は可能。成果物なしの拒否は set --status white にも効く。人の操作 (画面 / --actor human) は拒否しない。AIが拒否を避けるために人を名乗ったり、設定を弱めたりしない。
- guard 有効時、scope の変更、focus の設定・解除、policy の変更にも --context-token が必要。scope/focus/policy を変えると新しいトークンが出るので、次の操作はそれを使う。表示だけには不要。
- resume は完了済みの引き継ぎ本文を隠し、件数だけ示す。履歴が必要な場合だけ resume --include-completed で展開する (context / show では個別に読める)。
- 説明は descriptionUpdatedAt、状態は statusChangedAt、引き継ぎは既存の at で日時を確認できる。状態変更より古いメモはその旨を示す。旧記録の不明な日時は補わない。「新しい記録」は真偽の保証ではない。
- Done で古い状況説明が残る可能性がある場合、CLI・詳細パネル・resume に見直し案内が出る。本文は自動で消さない。内容を確認し、必要なら set B12 --note "現在の説明" (none で消去) または画面の Notes で直す。
- MCP は boxglow_scope / boxglow_focus / boxglow_policy、boxglow_start の reason、boxglow_resume の includeCompleted を使う。変更には contextToken を付ける。
- データ形式は v5 のままで全項目は任意。旧版 (0.4.2以前) は新しい規則を実行せず、保存時に計画の workflowPolicy / focusBlockId を落とす。これらを使う計画の書き手 (CLI・serve・画面・拡張内のアプリ) は対応したビルドに揃える。版番号だけでなくビルド日時も確認する。
