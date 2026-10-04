# Boxglow をエージェントに使わせる指示書 (AGENTS.md / CLAUDE.md に貼る)

下の「---」の間をそのままリポジトリの AGENTS.md (Codex) や CLAUDE.md (Claude Code) に貼る。
boxglow.json はリポジトリ直下に置く (`npx boxglow init --name "<プロジェクト名>"`)。

---

## Boxglow (計画と進捗の共有)

このリポジトリの計画と進捗は `boxglow.json` が正本。人間は Boxglow の画面でこのファイルを見ている。
ファイルを直接編集せず、必ず `npx boxglow` コマンドで更新すること (結線ルールと履歴が保たれる)。

ブロック = 「入力から出力 (成果物) を作るタスク」。出力の成果物が確定したら完了 (WhiteBox)。
状態: BlackBox (出力だけ決めた) → GrayBox (分解中・着手中) → WhiteBox (完了)。

### 作業のたびに守ること

1. **最初に読む**: `npx boxglow resume` (または `npx boxglow status --brief`) で、作業中・判断待ち・AI 未確認の回答・次の候補・未完了の引き継ぎメモを読む。前のセッションの続きは、ここに出る引き継ぎメモから再開する。`npx boxglow show <block>` で担当するボックスの入出力を確認する
2. **着手を記録**: ボックスに取りかかるとき `npx boxglow start <block> --note "<何をするか>"`。同時に進めるボックスは 1〜2 個まで。
   確認トークンの要求 (guard) が有効な計画では、先に `npx boxglow context <block>` を読み、出力の `contextToken` (確認トークン) を付ける:
   `npx boxglow start <block> --note "<何をするか>" --context-token <確認トークン>` (下の「確認トークンと引き継ぎ」を参照)
3. **分解**: 1 つのボックスで出力を作る見通しが立たないときは、`npx boxglow split <block> --spec '<JSON>'` で中に小さなボックスを置く。各ボックスに出力 (成果物) を必ず決める。入力は不明なら省略してよい (自動で上の階層の入力になる)
4. **完了を記録**: 出力の成果物ができたら `npx boxglow done <block> --artifact "<名前>=<リポジトリ内のパス>"`。
   guard が有効なら `--context-token <確認トークン>` を付ける (直前の自分の操作の出力に「新しい確認トークン: <token>」が出ていれば、それを使う)。
   HEAD にコミット済みで内容が一致するファイルは「コミット + パス + 中身のハッシュ」で記録される (アップロードはしない)。未コミット・未追跡のファイルはローカル参照として残り、コミットした後の `npx boxglow check` で Git の参照に補完される。記録のためだけにコミットしない。全階層が必要なら `npx boxglow status` を読む。PR や外部資料は URL でもよい。
   成果物だけ先に付けるなら `npx boxglow artifact <block> <パス>`。進捗の途中経過は `npx boxglow set <block> --progress 60`
5. **人間の判断が要る**: `npx boxglow ask <block> "<質問>" --options "A|B"`。回答があるまでそのボックスは進めず、他のボックスへ移る。人の回答は `status` の「回答あり」に出る。読んだら `npx boxglow ack <block>` で引き取る (そのボックスの `start` / `done` / `set` などでも自動で引き取られる)。引き取るまで人の画面には「AI 未確認」として残り、人が答えを直せる。回答の中に問い返しがあれば、`ask` と `answer --by <自分>` で自分の答えも記録する
6. **詰まったら**: `npx boxglow blocked <block> --note "<困っていること>"`
7. **成果物の確認**: ファイルを移動・改名したら `npx boxglow check` を実行する (移動を検出してパスを付け替える。見つからなければ印が付く)
8. **中断・引き継ぎの前に**: セッションの終わり・コンテキストの圧縮・他の AI や人への引き継ぎの前に、`npx boxglow checkpoint <block> --note "分かったこと; 次にすること; 未解決のこと"` で引き継ぎメモを残す (guard が有効なら `--context-token <確認トークン>` を付ける)。会話の履歴が消えても計画の中に残り、次のセッションが `resume` と `context` で読む
9. **報告**: 作業の最後に `npx boxglow status --brief` の内容を要約して報告する

### 構造の約束

- 最上位には「入力ノード」「最終成果物ノード」と「プロジェクトのボックス」だけがある。タスクはプロジェクトのボックスの中に置く (`add` の既定の親は最初のプロジェクトのボックス)
- 階層の深さに制限はない。`split` は何段でも使える
- 別のプロジェクトでも使えそうなボックス (例: 入力画像のモノクロ化) は `npx boxglow export-block <block> --out <名前>.boxglow-block.json` でテンプレートにし、
  `npx boxglow import-block <path> --parent <block>` で挿入する。リポジトリの `boxglow-blocks/` に置いて共有してよい

最上位の入力が多いときは `npx boxglow group "<グループ名>"` でグループを作り、`npx boxglow group-set <入力名> <グループ名>` で分ける (例: PCIe 仕様書 / DDR 仕様書)。

### split の JSON 形式

```json
{
  "blocks": [
    { "title": "設計", "description": "やること", "inputs": ["仕様"], "outputs": ["設計書"] },
    { "title": "実装", "inputs": ["設計書"], "outputs": ["コード"] }
  ],
  "connections": [
    { "from": "parent.仕様", "to": "設計.仕様" },
    { "from": "設計.設計書", "to": "実装.設計書" },
    { "from": "実装.コード", "to": "parent.出力" }
  ]
}
```

`parent.<名前>` は分解するボックス自身の入力 / 出力。`<block>` は短い ID (B12 など。status に出る) か題名。
下の階層を持たないボックスの出力は 1 本 (outputs は 1 つだけ書く)。題名は「何を作るか」が分かる短い言葉にする。
期日や時間は `npx boxglow set <block> --due 2026-10-15 --start 2026-10-01 --estimate 8 --hours 3.5` で記録する。
ボックスには仕事の種類 (カテゴリ) を付ける: `--category design` (設計) / build (実装) / verify (検証) / evaluate (評価) / study (検討) / research (調査) / ui (デザイン) / improve (改善) / fix (課題解決) / docs (文書) / ops (運用) / other (その他: 迷ったとき)。add のときに付け、変えるなら `npx boxglow set <block> --category verify`。
結線の受け側は題名だけでよい (`npx boxglow connect "A.設計書" "B"` で B に入力「設計書」が作られてつながる。split の connections も `to: "B"` でよい)。つないだ入力の名前は供給元の出力名になり、入力側では変えられない (変えるなら供給元の出力の名前を変える。つながる先も一緒に変わる)。既存のボックスに入出力を足す / 名前を変えるのは `npx boxglow port <block> --in <名前> --out <名前> --rename <旧>=<新>` (`project` = 最初のプロジェクトのボックス。最終成果物の名前もこれで変える)。線を外すのは `npx boxglow disconnect <題名.出力名> <題名.入力名>`、ボックスそのものを消すのは `npx boxglow remove <block>` (中にボックスがあれば `--force`)。MCP ツール (`boxglow_status` / `boxglow_start` / `boxglow_done` / `boxglow_ask` など。利用するエージェントに登録済みなら使える。`.mcp.json` は Claude Code 向けで、Codex は別途登録する) は同じコマンドの別の入口で、どちらで書いても同じファイルが更新される。計画の文書は `npx boxglow export --out docs/ROADMAP.md`。
新しいプロジェクトでは、方針 (README や依頼文) から最上位の大項目 3〜7 個を先に作り、人に `ask` で確認してから、着手する大項目だけを `split` で分解する (先の段階は粗いまま)。`ask` の質問はそれだけで判断できるように書き、前提・比較・影響は `--context` に入れる (「これでよいですか」のように外を指さない)。候補から 1 つを選ぶ場面では、自分で決めるときも `ask ... --options "A|B|C"` と `answer --by <自分>` で記録し、選ばなかった候補を残す。方針転換は `reopen <block> --note <理由>`。すべて CLI だけで成立する (画面は人が見るためのもの)。人がいない運用なら、AI が `answer --by <自分>` で判断を記録して進める。
出力の名前は「具体的な成果物」にする (例: `設計書 docs/design.md`、`PR #12`、`公開 URL`、`テスト結果 (vitest 53 件)`)。「機能一式」「所見」のような抽象的な名前は避け、done のときは必ず --artifact でファイル・URL・コミットを付ける。
すべてのボックスは「入力 → 出力」が何かにつながっているようにする (つながっていないボックスは計画の穴。最上位の入力ノードは、未接続の入力が自動で上がる)。
複数人で同じ boxglow.json を編集するなら、各自の clone で一度 `npx boxglow git-setup` を実行する (ボックスの単位で自動マージされ、別のボックスの変更は衝突しない)。
複数リポジトリを 1 つの計画で管理するときは、boxglow.json を上のフォルダに置き、各リポジトリでは環境変数 BOXGLOW_FILE にその場所を入れる (プロジェクトのボックスはリポジトリごとに 1 つ。`npx boxglow project "名前" --repo <パス>`)。
入力は既定で必須。無くても着手できる入力は画面で「任意」にする。status の「次の候補」は必須の入力がそろったボックスから並ぶ (「着手できる」/「必須の入力待ち」が付く)。
入力の説明は書かない (つながった出力側の説明が使われる)。出力の説明に形式・制約を書く。


### 確認トークンと引き継ぎ

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
- **自分で更新できる場合**: 自分の `ask` / `artifact` / `done` / `set` / `split` / `checkpoint` などでコンテキストが変わったときは、その出力の最後の行に「新しい確認トークン: <token>」が出る。自分で変えた内容は分かっているので、読み直さずに次の操作へ使う。`ask` / `decision` / `answer` / `reopen` は確認トークン無しでも実行できるが、新しい確認トークンが出るのは最新の確認トークンを付けたときだけ
- 古い確認トークンを通すために guard を無効にしない (AI が `guard off` するには最新の確認トークンが要る)
- MCP では `boxglow_context` と、各ツールの `contextToken` 引数を使う (新しい確認トークンはツールの結果の最後の行に出る)
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

---
