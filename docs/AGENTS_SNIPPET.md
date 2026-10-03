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

1. **最初に読む**: `npx boxglow status` で全体・判断待ち・作業中・次の候補を読む。`npx boxglow show <block>` で担当する箱の入出力を確認する
2. **着手を記録**: 箱に取りかかるとき `npx boxglow start <block> --note "<何をするか>"`。同時に進める箱は 1〜2 個まで
3. **分解**: 1 つの箱で出力を作る見通しが立たないときは、`npx boxglow split <block> --spec '<JSON>'` で中に小さな箱を置く。各箱に出力 (成果物) を必ず決める。入力は不明なら省略してよい (自動で上の階層の入力になる)
4. **完了を記録**: 出力の成果物ができたら `npx boxglow done <block> --artifact "<名前>=<リポジトリ内のパス>"`。
   Git 管理下のパスは「コミット + パス + 中身のハッシュ」で記録される (アップロードはしない)。コミットしてから done する。PR や外部資料は URL でもよい。
   成果物だけ先に付けるなら `npx boxglow artifact <block> <パス>`。進捗の途中経過は `npx boxglow set <block> --progress 60`
5. **人間の判断が要る**: `npx boxglow ask <block> "<質問>" --options "A|B"`。回答があるまでその箱は進めず、他の箱へ移る。回答は `status` の「判断待ち」が消えたら `show` で読む
6. **詰まったら**: `npx boxglow blocked <block> --note "<困っていること>"`
7. **成果物の確認**: ファイルを移動・改名したら `npx boxglow check` を実行する (移動を検出してパスを付け替える。見つからなければ印が付く)
8. **報告**: 作業の最後に `npx boxglow status` の内容を要約して報告する

### 構造の約束

- 最上位には「入力ノード」「最終成果物ノード」と「プロジェクトの箱」だけがある。タスクはプロジェクトの箱の中に置く (`add` の既定の親は最初のプロジェクトの箱)
- 階層の深さに制限はない。`split` は何段でも使える
- 別のプロジェクトでも使えそうな箱 (例: 入力画像のモノクロ化) は `npx boxglow export-block <block> --out <名前>.boxglow-block.json` でテンプレートにし、
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

`parent.<名前>` は分解する箱自身の入力 / 出力。`<block>` は短い ID (B12 など。status に出る) か題名。
下の階層を持たない箱の出力は 1 本 (outputs は 1 つだけ書く)。題名は「何を作るか」が分かる短い言葉にする。
期日や時間は `npx boxglow set <block> --due 2026-10-15 --start 2026-10-01 --estimate 8 --hours 3.5` で記録する。
箱には仕事の種類 (カテゴリ) を付ける: `--category design` (設計) / build (実装) / verify (検証) / evaluate (評価) / study (検討) / research (調査) / ui (デザイン) / improve (改善) / fix (課題解決) / docs (文書) / ops (運用) / other (その他: 迷ったとき)。add のときに付け、変えるなら `npx boxglow set <block> --category verify`。
既存の箱に入出力を足す / 名前を変えるのは `npx boxglow port <block> --in <名前> --out <名前> --rename <旧>=<新>` (`project` = 最初のプロジェクトの箱。最終成果物の名前もこれで変える)。線を外すのは `npx boxglow disconnect <題名.出力名> <題名.入力名>`、箱そのものを消すのは `npx boxglow remove <block>` (中に箱があれば `--force`)。MCP ツール (`boxglow_status` / `boxglow_start` / `boxglow_done` / `boxglow_ask` など。`.mcp.json` に登録済みなら使える) は同じコマンドの別の入口で、どちらで書いても同じファイルが更新される。計画の文書は `npx boxglow export --out docs/ROADMAP.md`。
新しいプロジェクトでは、方針 (README や依頼文) から最上位の大項目 3〜7 個を先に作り、人に `ask` で確認してから、着手する大項目だけを `split` で分解する (先の段階は粗いまま)。`ask` の質問はそれだけで判断できるように書き、前提・比較・影響は `--context` に入れる (「これでよいですか」のように外を指さない)。候補から 1 つを選ぶ場面では、自分で決めるときも `ask ... --options "A|B|C"` と `answer --by <自分>` で記録し、選ばなかった候補を残す。方針転換は `reopen <block> --note <理由>`。すべて CLI だけで成立する (画面は人が見るためのもの)。人がいない運用なら、AI が `answer --by <自分>` で判断を記録して進める。
出力の名前は「具体的な成果物」にする (例: `設計書 docs/design.md`、`PR #12`、`公開 URL`、`テスト結果 (vitest 53 件)`)。「機能一式」「所見」のような抽象的な名前は避け、done のときは必ず --artifact でファイル・URL・コミットを付ける。
すべての箱は「入力 → 出力」が何かにつながっているようにする (つながっていない箱は計画の穴。最上位の入力ノードは、未接続の入力が自動で上がる)。
複数人で同じ boxglow.json を編集するなら、各自の clone で一度 `npx boxglow git-setup` を実行する (箱の単位で自動マージされ、別の箱の変更は衝突しない)。
複数リポジトリを 1 つの計画で管理するときは、boxglow.json を上のフォルダに置き、各リポジトリでは環境変数 BOXGLOW_FILE にその場所を入れる (プロジェクトの箱はリポジトリごとに 1 つ。`npx boxglow project "名前" --repo <パス>`)。
入力は既定で必須。無くても着手できる入力は画面で「任意」にする。status の「次の候補」は必須の入力がそろった箱から並ぶ (「着手できる」/「必須の入力待ち」が付く)。
入力の説明は書かない (つながった出力側の説明が使われる)。出力の説明に形式・制約を書く。

---
