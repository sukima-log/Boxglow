# Boxglow を「AI の作業が一目でわかる」ツールにする計画

作成日: 2026-10-02
背景: mg-core のような大きなプロジェクトを Codex / Claude Code に任せると、「全体計画に対して今何をしていて、何が残っているか」が分からなくなる。
Boxglow を、AI 自身が読み書きする計画図にして、人間が全体像と進捗を見て意思決定できるようにする。

---

## 1. 売り文句 (ポジショニング)

**「AI が今どこを作っていて、何が終わっていて、どこで人間の判断を待っているかが、ボックスの色で一目でわかる」**

競合との違い (2026-10-02 調査):

| ツール | 何をするか | Boxglow との違い |
|---|---|---|
| claude-task-master (MCP、36 ツール) | PRD をタスクに分解し、依存関係を追跡。AI がタスクを読み書き | 一覧 (リスト) が中心。入出力の約束や階層の図は無い。人間向けの可視化が弱い |
| Agent Flow / Mohano (VS Code 拡張等) | エージェントの実行 (ツール呼び出し・サブエージェント) をリアルタイムに図示 | 「実行ログ」の可視化。計画 (何を作るか) の図ではなく、終わった後に残らない |
| Visual Plan Graph (Claude Code スキル) | タスクの依存グラフを色分け表示 | 静的な図の生成。AI と人間が同じ図を編集し続ける仕組みではない |
| CodeAgentSwarm (かんばん) | AI が更新するかんばん | 列が 4 つの一覧。入出力・階層・分解の構造が無い |

Boxglow の独自性:
1. ボックス = 入力から出力を作るタスク。**出力 (成果物) が確定したら白くなる**ので、「できた / できていない」が曖昧にならない
2. 階層 (分解) と結線 (何が何に必要か) が図になる。大きな計画の「どこ」を AI がやっているかが位置で分かる
3. **AI が直接編集するファイル** (リポジトリ内の boxglow.json) が正本。人間はアプリで見る・直す・判断を書き込む。AI は次に読む
4. ログではなく「計画」なので、作業が終わっても残り、引き継ぎ資料になる

---

## 2. 仕組み: AI と人間が同じファイルを編集する

### 2.1 正本はリポジトリ内のファイル

- `boxglow.json` (今の Project 形式。schemaVersion 2 で下の項目を追加) をリポジトリ直下 (または `.boxglow/`) に置く
- AI (Codex / Claude Code) はファイルを直接編集できるが、結線ルールや自動引き上げを守るのは難しいので、**CLI / MCP 経由で編集させる**のを基本にする
- 人間は Boxglow (Web / VS Code) で見る・編集する。両者は同じファイルを読み書きし、変更は即座に画面に反映される

### 2.2 形式の追加 (schemaVersion 2)

```
Block に追加
  activity?: {
    actor: string            // "claude-code" | "codex" | "human:<name>" など
    state: "working" | "blocked" | "needs_decision" | "waiting_review"
    note: string             // 今やっていること / 困っていること (1〜2 文)
    since: string            // ISO 日時
  }
  decisions: Decision[]      // 人間への質問と回答
Decision
  id, question, options?: string[], answer?: string, askedBy, askedAt, answeredAt?
Project に追加
  log: LogEvent[]            // 時系列 (started / done / blocked / decided / added / split)。上限 500 件で古いものから落とす
  agents: { [actor]: { lastSeen: string } }
```

画面での見せ方 (今のボックスの見た目に足す):
- `working`: ボックスの枠がゆっくり脈打つ + 右上に actor の印 (CC / CX)。「今ここ」が一目で分かる
- `needs_decision`: 差し色 (オレンジ) の札「判断待ち」。人間が押すと質問が出て、その場で答えを書く
- `blocked` / `waiting_review`: 灰色の札
- タイムライン (右パネルの新しいタブ): 「14:02 claude-code が『API の実装』を開始」「14:30 完了 (PR #12)」
- 上の帯に要約: 「AI 作業中 2 / 判断待ち 1 / 完了 5 / 全 12」

### 2.3 AI 側の入口 (3 段階で用意する。中身は同じ純粋関数 graph.ts を共有)

| 入口 | 形 | 用途 |
|---|---|---|
| CLI `boxglow` (npm) | `npx boxglow status` / `start <ボックス>` / `done <ボックス> --artifact <URL>` / `add` / `split` / `ask` / `validate` | どのエージェントでも使える最小の入口。シェルが使えれば動く |
| MCP サーバー `boxglow-mcp` | 同じ操作をツールとして公開 (`claude mcp add boxglow -- npx -y boxglow-mcp`、Codex は config.toml) | ツール呼び出しで確実に操作させる。構造化された引数で誤りが減る |
| 指示書 (AGENTS.md / CLAUDE.md 用の文面、Claude Code スキル) | 「作業前に status を読む。着手時に start、完了時に done と成果物、迷ったら ask」 | エージェントの振る舞いを決める。CLI / MCP があってもこれが無いと使われない |

エージェントの基本ループ (指示書に書く内容):
1. 作業開始時: `boxglow status` で全体と自分の担当 (working / 未着手) を読む
2. 計画段階: 大きなボックスは `split` で分解し、各ボックスの出力 (成果物) を決める。入力が不明なら空のまま (自動で最上位へ上がる)
3. 着手: `start <ボックス> --note "何をするか"`。1 ボックスずつ。終わったら `done <ボックス> --artifact <PR や ファイルのパス>`
4. 人間の判断が要る: `ask <ボックス> "質問" --options A,B`。answer が書かれるまでそのボックスは進めず、他のボックスへ
5. 終了時: `status` の要約を報告に含める

### 2.4 人間側の入口 (配布の形)

| 形 | 仕組み | 利点 / 欠点 |
|---|---|---|
| A. Web (今の sukimalog.com/apps/boxglow) + ローカルファイルを開く | File System Access API で boxglow.json を開き、1〜2 秒ごとに更新を監視、編集は書き戻す | インストール不要。Chrome / Edge 限定。ブラウザのタブで見る |
| B. VS Code 拡張 | Webview に今の React 画面を載せ、ワークスペースの boxglow.json を監視 | Claude Code / Codex 利用者の多くが VS Code。Marketplace が配布経路になる。Cursor でも動く |
| C. ローカルサーバー `npx boxglow serve` | CLI がファイルを監視し localhost で Web 画面を配信 (WebSocket で即時反映) | エディタを選ばない。ブラウザ全部で動く。CLI と同じパッケージで配れる |
| D. デスクトップアプリ (Tauri) | C を 1 つの実行ファイルに | 後回し。C で足りる |

推奨: **A と C を先に** (どちらも今の React 画面をほぼそのまま使える。C は CLI と同梱)。次に B (配布経路として強い)。

---

## 3. 進め方 (段階)

### 段階 A: AI と人間が同じファイルを編集できる (目安 2 週間)

1. 形式 v2 (activity / decisions / log) と、画面の「今ここ」「判断待ち」「タイムライン」
2. Web 画面に「ローカルファイルを開く」(File System Access API。監視と書き戻し)
3. CLI `boxglow` (TypeScript、graph.ts を共有): status / add / split / start / done / ask / answer / validate。出力は人間と AI の両方が読める Markdown
4. 指示書の文面 (AGENTS.md / CLAUDE.md に貼る) と Claude Code スキル `/boxglow`
5. **mg-core で実際に使う** (dogfooding): 現在地.md と引き継ぎ文書の内容を boxglow.json に起こし、Codex / Claude Code に CLI で更新させて、困る点を直す

### 段階 B: 配布 (目安 2〜3 週間)

6. `npx boxglow serve` (ローカルサーバー + 即時反映)
7. MCP サーバー `boxglow-mcp`
8. VS Code 拡張 (Marketplace 公開)
9. GitHub で公開 (OSS)。README は英語 + 日本語。ボックスが白くなる GIF を先頭に
10. 紹介記事 (日本語) と、英語の投稿 (Show HN / X / Reddit r/ClaudeAI)。Claude Code の MCP / スキル一覧サイトへの登録

### 段階 C: 共有と収益 (配布後に判断)

11. クラウド同期: boxglow.json を Boxglow のサーバーに同期し、**共有リンク 1 つで、インストールしていない人 (上司・顧客・チーム) が進捗を見られる**。これが有料の中心
12. チーム: メンバー・権限・履歴の保持期間・複数プロジェクトの一覧 (ダッシュボード)
13. 公開プロジェクト (元の段階 3)

---

## 4. 収益化の考え方

- **無料 (OSS)**: Web 画面、ローカルファイル連携、CLI、MCP、VS Code 拡張。ここは広く使ってもらう入口なので課金しない
- **有料 (クラウド)**: 共有リンク、チーム、履歴、通知 (判断待ちを Slack / メールへ)、複数プロジェクトのダッシュボード。
  目安: 個人は無料枠 (1〜2 プロジェクト)、チームは 1 人あたり月 500〜1000 円程度 (競合の Linear / Notion の下)。
  決済は Stripe、基盤は計画済みの Cloudflare (Pages + Workers + D1)
- **指標**: まず「毎週使う人の数」。npm のダウンロード数、VS Code 拡張のインストール数、共有リンクの閲覧数で見る
- 現実的な見通し: 個人開発で最初から大きな収益は難しい。まず OSS として使われることを優先し、共有リンクの需要が見えてから課金を入れる

---

## 5. 決めてほしいこと

1. **公開の形**: GitHub で OSS (MIT) として公開してよいか。npm / VS Code Marketplace での配布と、海外利用者の獲得に必要。名前 `boxglow` / `boxglow-mcp` は npm で空いている (2026-10-02 確認)
2. **最初に作る入口**: 推奨は「ローカルファイルを開く (Web) + CLI」。VS Code 拡張を先にしたい場合は言ってほしい
3. **dogfooding の対象**: mg-core の現在の計画 (checkpoints/現在地.md 等) を boxglow.json に起こしてよいか (読み取りのみ。mg-core 側のファイルは boxglow.json を 1 つ追加するだけ)
4. **エージェントの呼び名**: 画面に出す印を "CC" (Claude Code) / "CX" (Codex) のような 2 文字にするか、アイコンにするか (後で変えられる)
5. **英語対応**: 配布するなら画面と CLI の英語 UI が要る (以前「英語版は見送り」と決めたのはブログ記事の話)。日本語 / 英語の切り替えを段階 B で入れてよいか
