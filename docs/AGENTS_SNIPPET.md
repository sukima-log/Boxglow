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
2. **準備を確認**: 取りかかる前に `npx boxglow context <block>` を読む。出力の `readiness` が準備の状態: `state` が `ready` なら着手できる。`unprepared` (要具体化) なら `unprepared` の理由と `next` の次の一手に従って先に具体化する。`waiting` は必須の入力か分岐の答えを待っている
3. **受け持ち、具体化**: 具体化や分解の前に `npx boxglow claim <block>` で受け持ちだけを取る (実行中にはならない。受け持ち制御が無効な計画では「取得不要」で正常終了する)。そのうえで不足を埋める:
   - 出力の予定成果物: `npx boxglow port <block> --expect "<出力名>=file:src/x.ts"` (kind は file / dir / url / doc / note / decision / result。hint はパスの見当や題名。まだ作っていないファイルでよい)
   - 完了条件: `npx boxglow scope <block> --acceptance "<完了と判断する条件>"`。処理の範囲は `--goal`
   - 1 つのボックスで出力を作る見通しが立たないなら `npx boxglow split <block> --spec '<JSON>'` で中に小さなボックスを置く。今回着手する子だけ expect / acceptance を書き、先の子は題名と出力だけでよい (要具体化として残る)。入力は不明なら省略してよい (自動で上の階層の入力になる)
   - 対象のファイルが分からないときは、架空のファイルを書かず「対象を特定する調査」のボックスを出力 `note` で作って始める
4. **着手を記録**: 準備ができたら `npx boxglow context <block>` を読み直してから `npx boxglow start <block> --note "<何をするか>"`。同時に進めるボックスは 1〜2 個まで。
   start したボックスが「今ここ」(本当にいま作業しているボックス、1 つ) になり、画面で太い枠と札が付く。別のボックスに移るときは `npx boxglow now <block>` で切り替える (start でも移る)。done / leave で消える。人も画面の状態タブの NOW で切り替える
   確認トークンの要求 (guard) が有効な計画では、出力の `contextToken` (確認トークン) を付ける:
   `npx boxglow start <block> --note "<何をするか>" --context-token <確認トークン>` (下の「確認トークンと引き継ぎ」を参照)
   要具体化のボックスへの start は既定では警告 (理由と次の一手が出る)。`policy --unprepared reject` の計画では開始できない (`--reason` では通れない。人の操作は通る)。出力を子に任せきりの親も実行するものが無いので、子を start する
5. **完了を記録**: 出力の成果物ができたら `npx boxglow done <block> --artifact "<名前>=<リポジトリ内のパス>"`。
   guard が有効なら `--context-token <確認トークン>` を付ける (直前の自分の操作の出力に「新しい確認トークン: <token>」が出ていれば、それを使う)。
   HEAD にコミット済みで内容が一致するファイルは「コミット + パス + 中身のハッシュ」で記録される (アップロードはしない)。未コミット・未追跡のファイルはローカル参照として残り、コミットした後の `npx boxglow check` で Git の参照に補完される。記録のためだけにコミットしない。全階層が必要なら `npx boxglow status` を読む。PR や外部資料は URL でもよい。
   成果物だけ先に付けるなら `npx boxglow artifact <block> <パス>`。進捗の途中経過は `npx boxglow set <block> --progress 60`
6. **人間の判断が要る**: `npx boxglow ask <block> "<質問>" --options "A|B"`。回答があるまでそのボックスは進めず、他のボックスへ移る。人の回答は `status` の「回答あり」に出る。読んだら `npx boxglow ack <block>` で引き取る (そのボックスの `start` / `done` / `set` などでも自動で引き取られる)。引き取るまで人の画面には「AI 未確認」として残り、人が答えを直せる。回答の中に問い返しがあれば、`ask` と `answer --by <自分>` で自分の答えも記録する
7. **詰まったら**: 入力 (前のボックスの成果物・資料) が足りないことが原因なら、詰まりにしない。`npx boxglow show <block>` で入力の配線を確かめ、足りないものを作るボックスが無ければ `npx boxglow add` で外 (上流) に作り、`npx boxglow connect` でこのボックスの入力につなぐ (配線が「待ち」の色で残り、何を待っているかが図で見える)。選択肢から選んでもらえば進めるなら `ask`。それ以外の、計画の外にある障害 (環境が動かない、権限やキーが無い、外部の返事待ち、原因の分からない失敗) だけを `npx boxglow blocked <block> --note "<困っていること>"` で記録する
8. **成果物の確認**: ファイルを移動・改名したら `npx boxglow check` を実行する (移動を検出してパスを付け替える。見つからなければ印が付く)
9. **中断・引き継ぎの前に**: セッションの終わり・コンテキストの圧縮・他の AI や人への引き継ぎの前に、`npx boxglow checkpoint <block> --note "分かったこと; 次にすること; 未解決のこと"` で引き継ぎメモを残す (guard が有効なら `--context-token <確認トークン>` を付ける)。会話の履歴が消えても計画の中に残り、次のセッションが `resume` と `context` で読む
10. **報告**: 作業の最後に `npx boxglow status --brief` の内容を要約して報告する

### 構造の約束

- **まだ決まっていない分かれ道は分岐で表す**: 計画を作る時点で、判断次第で後の作業 (道) が変わるときは `npx boxglow branch "<題名>" --options "A|B" --question "<問い>" --context "<判断材料>"` で分岐のボックスを作る。選択肢ごとに道 (出力) ができるので、それぞれの道の最初のボックスへ `connect` する。道が後で 1 つにまとまるところには `npx boxglow join --title "<題名>"` で合流の部品を置き、それぞれの道の最後の出力をこの部品へ `connect` し、部品の出力を先の箱へつなぐ (どれか 1 つの道が届けば先へ進む)。人が答えると、選ばなかった道の先は「見送り」になり、進捗と次の候補から外れる。すでに作ったボックスが実は決まっていない分かれ道だと分かったら、`npx boxglow branch --box <block> --options "A|B" --question "<問い>"` で分岐に変える (今の出力が 1 つ目の選択肢の道になり、線は残る)。答えが出る前の道のボックスは「分岐待ち」で、着手すると警告される (先に下調べするなど理由があれば `--reason` で記録する)
- 最上位には「入力ノード」「最終成果物ノード」と「プロジェクトのボックス」だけがある。タスクはプロジェクトのボックスの中に置く (`add` の既定の親は最初のプロジェクトのボックス)
- 階層の深さに制限はない。`split` は何段でも使える
- 別のプロジェクトでも使えそうなボックス (例: 入力画像のモノクロ化) は `npx boxglow export-block <block> --out <名前>.boxglow-block.json` でテンプレートにし、
  `npx boxglow import-block <path> --parent <block>` で挿入する。リポジトリの `boxglow-blocks/` に置いて共有してよい

最上位の入力が多いときは `npx boxglow group "<グループ名>"` でグループを作り、`npx boxglow group-set <入力名> <グループ名>` で分ける (例: PCIe 仕様書 / DDR 仕様書)。

### split の JSON 形式

```json
{
  "blocks": [
    { "title": "対象箇所を特定する", "inputs": ["再現手順"], "outputs": ["調査メモ"],
      "expect": "note:対象のファイルと処理、根拠、変更候補、確認方法、未決事項", "acceptance": "変更するファイルと処理が決まり、後続のボックスに expect と acceptance を設定できる。または、設定できない理由と必要な判断が分かる",
      "goal": "再現して経路を追う。製品コードの修正は今回の範囲外" },
    { "title": "保存の再試行後に同期状態を取り直す", "inputs": ["調査メモ"], "outputs": ["修正"],
      "expect": "file:src/sync/state.ts", "acceptance": "保存を一度失敗させ、再保存後に同期状態と操作が戻る (テストで確認)" },
    { "title": "リリースノートを書く", "inputs": ["修正"], "outputs": ["ノート"] }
  ],
  "connections": [
    { "from": "parent.再現手順", "to": "対象箇所を特定する.再現手順" },
    { "from": "対象箇所を特定する.調査メモ", "to": "保存の再試行後に同期状態を取り直す" },
    { "from": "保存の再試行後に同期状態を取り直す.修正", "to": "リリースノートを書く" },
    { "from": "リリースノートを書く.ノート", "to": "parent.出力" }
  ]
}
```

`expect` (予定成果物: `"kind:hint"` または `{ "kind", "hint" }`)、`acceptance` (完了条件)、`goal` (今回行う処理) は今回着手する子だけに書く。
3 つ目の子のように題名と出力だけの子は「要具体化」として残り、着手する番になってから `port --expect` / `scope --acceptance` で決める。
親自身が作る出力 (子の成果を統合するなど) は `"parentMakes": ["出力名"]` で印を付ける (子の結線と重なると「担当が重複」と案内される)。
`"splitBy": "工程"` で直下の子の分け方を一語で残す (工程 / 成果物 / 機能 など。`set <block> --split-by` でも書ける)。同じ階層の子は同じ分け方・同じ具体度にそろえる。
`split` が保存しないのは壊れた構造 (結線先が無い、循環、形の違う expect) だけ。子が 1 個、親の出力を作る子がまだ無い、といった途中の分解は保存され、不足として表示される。
分解の後と着手の前に `npx boxglow lint <block>` を読む。「必ず直す」(親出力の担当の未定・重複、同じ分岐の排他の道の両方を必須にしている、作業中なのに予定成果物・完了条件が無い、検査の対象そのものの欠落) は直してから進む。
「着手の前に埋める」(まだ始めていないボックスの予定成果物・完了条件) は、その子の着手の番で埋めればよい (先の仕事の分を今、形だけ書かない)。
「見直し候補」(子が 1 個、どこにもつながらない出力、形だけの記入、道の先が無い分岐、入力 1 本の合流、兄弟の同じ予定成果物) は内容を見て判断する (機械は拒否しない)。`context` にも件数と上位 3 件が出る。

**内容のレビュー (意味は機械では判定できないので、AI か人が材料を読んで評価し、根拠を残す)**
- 分解した後: `npx boxglow review-split <親>` で材料 (親の目的・制約・完了条件・入出力、子の対象・入出力・予定成果物・完了条件、結線) とチェック項目を読み、評価したら `npx boxglow split-ok <親> --note "<根拠: 何を確認したか>"` で記録する。
- 着手する前: `npx boxglow review-box <block>` で材料 (対象・処理・予定成果物・確認方法、入力の供給元、上流の分岐の答え) を読み、`npx boxglow box-ok <block> --note "<根拠>"` で記録する。
- 記録は「評価したと申告し根拠を残した記録」であり、妥当性の証明ではない。材料が変わると `context` の `reviews` が `stale` (何が変わったかと、何を確認すればよいかの案内つき) になる。`stale` は「分解が不正」ではなく「前回の確認後に材料が変わった」という意味。位置や配色、進捗、担当の変更では古くならない。分解の記録は分岐の答えでは古くならず、着手準備の記録は答えが変わると古くなる。
- 先の子を着手の番で具体化すると、親の分解の記録は必ず `stale` になる (子の expect / acceptance も材料のため)。その子の expect・scope を一通り書き終えてから、変わった子と、親の完了条件・対象外範囲・兄弟との分担への影響だけを確認し、整合すれば `split-ok <親> --note "B181 の具体化を確認。親の対象外範囲に入らず、B182 との分担は重複しない"` のように更新する。port や scope の操作ごとに再確認はしない。複数の子を同時に具体化したら、まとめて確認してよい。
- 着手の条件にはしていない (既定でも reject の計画でも)。`start` を止めるのは要具体化と入力待ちだけ。

**分岐・合流を AI が使う**
- `ask` に選択肢を付けたとき、答えで後の作業が分かれるなら `--branch` を付ける: そのボックスが分岐になり、選択肢ごとの道 (出力) ができる。各道の最初のボックスへ `connect` し、道がまとまるところに `join` を置く。
- `split` の JSON でも作れる: 子に `"branch": { "question": "...", "options": ["A", "B"] }` で分岐のボックス (出力は選択肢の名前)、`"join": true` で合流の部品。例:
  `{ "blocks": [{ "title": "認証方式を決める", "branch": { "question": "どれ?", "options": ["メール", "OAuth"] } }, { "title": "メールで実装", "outputs": ["認証"] }, { "title": "OAuth で実装", "outputs": ["認証"] }, { "title": "合流", "join": true }], "connections": [{ "from": "認証方式を決める.メール", "to": "メールで実装" }, { "from": "認証方式を決める.OAuth", "to": "OAuth で実装" }, { "from": "メールで実装.認証", "to": "合流" }, { "from": "OAuth で実装.認証", "to": "合流" }, { "from": "合流.合流", "to": "parent.認証" }] }`
- `lint` は、同じ分岐の排他の道の両方を 1 つのボックスが必須にしている (両方が届くことはない) を「必ず直す」、道の先が無い・合流の入力が 1 本を「見直し候補」として出す。
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
- **最初は短い形で読む**: `npx boxglow context <block> --brief` は、対象のボックスの情報 (説明・範囲・判断・引き継ぎ・入出力・成果物) は全部、計画全体の説明、親と入力元の題名・状態・判断 (材料と選択肢つき。前の回答の履歴は省く)・対象につながる出力を出す。確認トークンは `--brief` なしと同じなので、そのまま `--context-token` に使える。`target.missingInputs` (不足している必須の入力) と `target.inputs[].sources` (どのボックスのどの出力か・成果物の参照) を先に見る。`omitted` に省いた件数が出る。省かれた説明・入出力の条件・引き継ぎが作業に関わりそうなら、`--brief` なしで読むか、そのボックスの `context` を読む
- **短い形で始める前提**: 範囲 (scope) を 1 項目でも設定した親・入力元のボックスの説明は、短い形では省かれる (`omitted.descriptions` に件数)。範囲を設定するときは、説明に書いた制約 (互換性・禁止事項・期限など) を範囲へ写し終えてからにする。写したか分からない計画・`omitted.descriptions` が 0 でない計画では、着手前に `--brief` なしで 1 度読む。短い形は調査の出発点で、それだけ読めば十分という保証ではない
- 短い形でも用が足りるように書く: 作業を縛る条件は説明の中に埋めずに scope (non-goals / acceptance / consult) に書く。引き継ぎメモは最新の 1 件だけが残るので、未解決の点・注意点・次の手順を毎回書き直して持ち越す。調べ始める場所は、対象のボックスの説明に次の形で書く (出発点であり、そのファイルだけ読めば足りるという意味ではない):
  `変更候補: <パス> — <調べ始める理由>` / `関連検査: <パスまたはコマンド> — <確かめること>`
- 古い確認トークンを通すために guard を無効にしない (AI が `guard off` するには最新の確認トークンが要る)
- MCP では `boxglow_context` と、各ツールの `contextToken` 引数を使う (新しい確認トークンはツールの結果の最後の行に出る)
- 「他の Boxglow が書き込み中 (ロック中)」と出て、少し待ってやり直しても解けないときは、`npx boxglow unlock` の表示 (持ち主と判定) を人に見せて解除を頼む。自分で `--actor human` を付けたり、ロックのフォルダを直接消したりしない

### 着手・完了、今回の範囲、記録の鮮度

- 最初に resume の現況 (活動・判断待ち・未確認回答) を読む。候補は「今回の範囲 / その他」の各組で「着手できる / 要具体化 / 入力待ち」に分かれ、要具体化の理由と不足する入力名が出る。要具体化や入力待ちを、準備済みと取り違えない。
- 「着手できる」(Ready) は、自身が作る出力があり、その予定成果物 (expect) と完了条件 (acceptance) が書かれ、必須の入力がそろっている、という機械検査の結果。内容が具体的かどうかまでは保証しない (`expect = src/`、`acceptance = 動作する` でも通る)。対象・処理・成果・確認方法を第三者が追えるように書く。
- ボックスの任意4項目を scope で設定する。goal = 今回達成すること、non-goals = 今回は扱わないこと、acceptance = 完了と判断する条件、consult = 範囲を広げる前に相談する条件。context の先頭で対象と親の範囲を読み、着手前と完了前に照合する。完了条件の本文をAIが満たしたかは自動判定しない。
- scope B12 --goal "達成すること" --non-goals "今回扱わないこと" --acceptance "確認する条件" --consult "相談する条件" で設定する。scope B12 は表示だけ。各項目に none または空文字を渡すと消す。画面では詳細パネルの「その他」タブ →「作業範囲を編集」。記入済みの項目だけが「今回の範囲」に出る。
- focus B12 でこのボックスと配下を次候補の先頭にする。focus は現在の対象の表示、focus none は解除。対象外も別の組に残る。候補に出ること自体は作業範囲の拡大や公開を許可しない。
- start の必須入力不足は既定で警告するが、従来どおり開始できる。先行作業が必要なら --reason "先に行う理由" を付ける。警告は出ず、理由は活動とログに残る。done の出力成果物なしも既定で警告のみ。既存の出力成果物または --artifact を数え、ボックスの参考資料は数えない。
- 計画で選ぶ場合だけ policy --start reject --done reject --unprepared reject にする。それぞれ warn に戻せる。入力待ちの拒否でも理由付きの開始は可能だが、要具体化の拒否は理由では通れない (先に具体化する)。成果物なしの拒否は set --status white にも効く。人の操作 (画面 / --actor human) は拒否しない。AIが拒否を避けるために人を名乗ったり、設定を弱めたりしない。
- guard 有効時、scope の変更、focus の設定・解除、policy の変更にも --context-token が必要。scope/focus/policy を変えると新しいトークンが出るので、次の操作はそれを使う。表示だけには不要。
- resume は完了済みの引き継ぎ本文を隠し、件数だけ示す。履歴が必要な場合だけ resume --include-completed で展開する (context / show では個別に読める)。
- 説明は descriptionUpdatedAt、状態は statusChangedAt、引き継ぎは既存の at で日時を確認できる。状態変更より古いメモはその旨を示す。旧記録の不明な日時は補わない。「新しい記録」は真偽の保証ではない。
- Done で古い状況説明が残る可能性がある場合、CLI・詳細パネル・resume に見直し案内が出る。本文は自動で消さない。内容を確認し、必要なら set B12 --note "現在の説明" (none で消去) または画面の Notes で直す。
- MCP は boxglow_scope / boxglow_focus / boxglow_policy、boxglow_claim、boxglow_port の expect / self、boxglow_start の reason、boxglow_resume の includeCompleted を使う。変更には contextToken を付ける。
- データ形式は v5 のままで全項目は任意。旧版 (0.4.2以前) は新しい規則を実行せず、保存時に計画の workflowPolicy / focusBlockId を落とす。これらを使う計画の書き手 (CLI・serve・画面・拡張内のアプリ) は対応したビルドに揃える。版番号だけでなくビルド日時も確認する。


### Sync decisions

AI may only sync already bound projects and inspect comparisons. If sync stops for a conflict or a human choice, summarize the differences and use ask to notify the user. Never resolve conflicts, create a new binding, relink, recover, adopt, restore, or confirm an account. A human must use the UI or explicitly run CLI with --actor human. AI must never add --actor human, including after a chat answer; record the answer and wait for the human to apply the sync choice.

Codexは全CLI呼び出しに `--actor codex`、Claude Codeは `--actor claude-code` を明示する。WSLなどでは実行環境の印が渡らないことがある。サブエージェントは `codex-作業名` などに分け、人を名乗らない。

### 並列作業の受け持ち

計画で受け持ちが有効なら、CLI実行ごとに一意の `BOXGLOW_INSTANCE_ID` を固定し、`claims` と `context` を読んでから `claim` (具体化・分解の前) または `start` (実行) する。`claim` で取った受け持ちは、そのまま `start` に引き継がれる。独立したエージェント間で実行IDを共有しない。既定はボックスのみ、必要なら `--scope subtree`。成功したCLAIM行のtokenを保持し、保存する操作に `--claim-token` を付ける。MCPは実行IDと受領証を自動で保持する。5分ごと (期限が短ければ半分以内) に `claim-renew` / `boxglow_claim_renew` を呼び、中断前はcheckpoint。done/leaveは対象の受け持ちを解放する。期限切れや世代違いを無視せず、最新contextを確認して取り直す。同名actorでも別実行の受け持ちは奪わない。設定・強制解除・同期競合の解決は人に依頼し、AIがhumanを名乗って代行しない。共有ファイル以外の同期コピー間には排他保証がない。詳しくは `docs/CLAIMS.md`。

他者の実行ID・受領証を使わない。計画やclaimsの出力から他者の受領証を組み立てることも禁止。MCP再起動後の同名actorも別実行なので、自動で引き継がず期限を待つか人に解除を頼む。

入力の自動引き上げは元のボックスの範囲で扱う。共有入力の内容変更や別ボックスへの配置変更には、影響する範囲の取得も必要。focusやgroupなど計画全体の設定には `context root` → `claim root` でrootを取得し、そのCLAIMを渡す (`start root` でも取れるが、実行中にはしない `claim` を使う)。rootのみの取得は通常のボックスを含まない。計画設定の変更はrootのみで足りる。rootのsubtreeは並行作業を全部止めるので、AIは使わず人に相談する。rootの終了は `leave root`。context guardの確認トークンも引き続き必要。

---

同期の人専用操作は、強制的な権限分離ではなく誤操作の防止です。AI は `--actor human` を名乗らず、比較と停止理由を人へ伝えてください。MCP と AI として識別した CLI は、人用の選択コマンドを出力しません。

人のCLI操作は `--actor human:名前` も受け付けます。AIはこの形でも人を名乗らないでください。AI向け停止文の `boxglow sync --help` は、AI環境を引き継いだ人への案内です。AIの代行許可ではありません。
