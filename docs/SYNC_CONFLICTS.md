# 同期と保存の競合を選ぶ

競合する変更は、ブロックの内部IDごとのグループと「計画の設定」にまとめて表示する。B番号は見出し用で、選択キーには使わない。ポート・成果物・判断・引き継ぎメモは所属ブロックに含める。配線は両端、削除や親の移動は子孫や境界配線の相手も含む依存グループで確認する。

通常はグループごとに手元か相手を選ぶ。画面の「項目ごとに選ぶ」、または共通要求の `fields` で詳しく選び分けることもできる。初期選択は置かない。全競合を選び終わるまで、非競合の変更も含めて同期を反映しない。最終結果の参照・親子関係も検証してから書く。

メンバー・入力グループの削除で残る参照は、読み込みと統合の末尾で整理する。設定の色や名前を変えただけで担当ブロック全体を結合しない。昇格ポートは有無・所有者・昇格元が版によって違う場合だけ関連する持ち主を結合する。項目別の選択で参照が壊れた場合は、同じ比較とエラーを返し、選び直せるようにする。

削除件数は「グループ全体にその側を採用した結果」。競合しない追加は保護するため、削除側を選んでも親が復元される場合がある。その場合は、実際に削除される件数と、追加保護で残る親・子の名前を表示する。項目別の選択では結果が変わる場合がある。

## CLI

まず `boxglow sync` で現在の比較と確認tokenを読む。内部IDと依存グループのキーは「詳細」に表示される。

```sh
boxglow sync --actor human --resolve <token> --block <internal-id-A>=local --block <internal-id-B>=remote --settings remote
boxglow sync --actor human --choices-file choices.json
boxglow sync --actor human --resolve <token> --prefer local
```

同じ依存グループに属するブロックは、代表の1つだけを `--block` に指定する。複数の所属ブロックを重ねて指定すると、同じ側でも拒否する。`--settings` は設定が競合している場合だけ指定する。`--prefer` は現在の全グループを一括で選ぶ従来の省略形。

共通形式の例 (`groups` のキーは表示されたキーか `block:<内部ID>`、設定は `settings`):

```json
{
  "version": 1,
  "token": "表示された確認token",
  "groups": {
    "block:internal-id-A": "local",
    "block:internal-id-B": "remote",
    "settings": "remote"
  }
}
```

項目別の選択では、グループの代わりに `fields` へ比較に出た競合IDと `local` / `remote` を入れる。グループ指定と同じ項目の詳細指定は混在できない。未知キー、欠落、重複、古いtokenは拒否する。選択後に計画・基準・相手の版・結び付けが変わった場合も、再比較が必要になる。

## MCPと画面

`boxglow_sync` は引数なしで、MCP起動時の固定対象を `safe(run, ["sync"])` から同期し、停止理由と比較を返す。任意の `file`・`server`・`project` や選択を受け付けない。MCPは `BOXGLOW_ACTOR=human` や起動時の `--actor human` にかかわらず、同期について常にAIとして扱う。`boxglow_run` 経由でも同期の選択指定は拒否する。

CLIも通常同期以外の判断 (resolve/block/settings/choices-file/prefer/link/relink/recover/adopt/restore/account) と初回の結び付けには、明示した `--actor human` が必要。環境変数のactorは承認にしない。環境変数から得た新規サーバーも、ロック内で結び付けの実在を確かめ、AIなら通信・状態作成前に拒否する。人がGUIで選ぶ既存の操作に追加手順はない。AIは比較を要約してaskで人に知らせる。

`--actor human` は操作主体の明示であり、OSの利用者認証ではない。同じOS権限で任意コマンドを実行できるエージェントの意図的ななりすましを隔離する仕組みではない。手順書でもAIの代行と人を名乗る実行を禁止する。

保存画面と同期画面も同じ要求を使う。同期画面の要求には、ホストが発行した選択IDを追加で付け、対象ファイル・同期状態の世代・資格情報の世代をホストで検証する。tokenは認証資格情報ではなく、表示した比較の組を確認する印。

保存時に実際の競合がゼロなら、最新の版を前提にCASで再保存し、成功したときだけ短い通知を出す。VS Codeのエディタ側に未保存編集があるとき (`editorDirty`)、エディタの読み直し待ち、退避の取り込み後に手動確認を待っている間は自動統合しない。CAS失敗・自動統合・外部の版変更による再試行だけを数え、上限に達したら編集を保持して再試行を案内する。通常の連続入力はこの上限に数えない。

保存応答を待つ間の外部通知は保留し、保存成功後は送った本文を基準にして統合する。VS Codeの失敗応答は、文書がディスクに追い付いていない場合も印を返す。追い付く前の自動統合を止め、失敗応答時も、文書とディスクが一致しdirtyでない場合だけ保存基準を進める。

自動統合はUndoの新しい段にしない。過去・未来の履歴には差分を予約し、Undo/Redoで使う一段だけを統合・検証する。保存済みの外部読み込みも同じ扱いで、外部更新自体をUndoの段に足さない。履歴の古い版と外部変更を合わせると参照が壊れる、または相手の削除が復元される場合、その版以前には戻せなくし、外部変更を取り消す履歴から保存しない。保存失敗や手動解決の後へ自動統合の成功通知を持ち越さない。

## English reference

Conflicts are grouped by internal block ID, with a separate project settings group. Wires and structural changes join dependent blocks into a single review group. Block keys such as B12 are display labels, not identifiers for resolution.

All surfaces use `{ version: 1, token, groups, fields? }`. Values are `local` or `remote`. CLI flags are `--resolve`, repeated `--block <internal-id>=<side>`, `--settings <side>`, and `--choices-file <JSON>`. The existing `--prefer` applies a side to every current group. Human CLI choices require explicit `--actor human`. MCP only accepts an argument-free `boxglow_sync` for the fixed bound project and returns comparisons. It never accepts resolutions or new bindings, even with a human actor environment. AI summarizes halted choices and asks the user.

Missing, unknown, duplicate, conflicting or stale choices are rejected before applying changes. Field-level choices may replace a group choice; the merged project must still pass reference and hierarchy validation. No partial sync occurs while a conflict remains unresolved.

Disjoint file-save changes merge automatically against the latest CAS revision. Unsaved VS Code text-editor edits, an editor waiting to catch up, and edits held for manual review are excluded. Failed saves preserve edits and do not show a success notice.

Missing member and input-group references are removed during loading and merging. Metadata edits do not join all assigned blocks. Promoted ports join owners only when their existence, owner, or source differs. Invalid field combinations return the same comparison with a resolution error. Deletion counts describe the actual whole-group result; parents and additions kept by the existing restoration rules are listed explicitly.

Notifications received during a save are deferred until its outcome is known. Undo/redo history is lazily rebased one step at a time onto external changes, without adding an undo step that removes the merge. Invalid older history is discarded. Only conflict retries count toward the retry bound; normal consecutive edits do not.


Human CLI initial binding: `boxglow sync --server <URL> --actor human`. The flag is an explicit declaration, not OS-level authentication. Environment actor settings never authorize human-only sync actions.

## B4: 通知と長時間の編集

人専用操作は、強制的な権限分離ではなく誤操作の防止にとどめる。AI は `--actor human` を名乗らない。MCP と AI として識別した CLI には比較・停止理由・人へ確認を依頼する文を返し、人用の選択コマンドは出さない。識別のない人の端末には、拒否された元の引数と `--actor human` を含む打ち直しコマンドを案内する。Windows の案内は PowerShell 用。

外部更新の履歴予約は、項目ごとの最新値へ合成する。更新回数分の計画全文や処理列は保持しない。Undo/Redo で矛盾する段に達したら通知し、その段とさらに先の履歴を終了する。すでに戻せた段の逆方向の履歴は残す。保存ループの自己通知判別には本文の SHA-256 を使う。

メンバー削除との統合で担当を外した場合は、ボックス・メンバー名を計画のログに残す。比較欄の件数は両側にある担当の合計から重複を除いた上限で、「最大」と明示する。他の項目で担当を変更したりボックスを削除したりすると、実際の解除件数は小さくなる。

Human-only sync is accident prevention, not enforced authorization. AI must never impersonate a human with `--actor human`. MCP and AI-identified CLI output give comparison data and ask the user to decide without executable human-choice commands. Unidentified human terminals receive a retry command preserving the original arguments. Windows command examples use PowerShell quoting.

Deferred undo/redo changes are coalesced by field; complete project snapshots are not retained for every external update. Invalid history boundaries produce a notice and preserve already-valid opposite history. Own-save notifications use SHA-256 digests. Assignment removals caused by deleted members are logged; comparison counts are upper bounds because other choices can change the final assignment count.

## B5: 人の識別とUndoの制限

同期で人の判断を適用するCLIは、`--actor human` または `--actor human:名前` を明示する。`BOXGLOW_ACTOR` の普通の記録者名や `CODEX_HOME` だけではAIと判定しない。AI実行の環境変数を引き継いだ人の端末には、停止文から `boxglow sync --help` の「人の操作」を案内する。AI向け停止文には人を名乗るコマンドを載せない。環境変数だけでは人専用操作を許可せず、MCPは引き続きAI専用。常時同期が出す打ち直しの案内は、既存watchを動かしたまま1回実行するため `--watch` を外す。

Undo/Redoの古い段に相手が更新した対象が無い場合や、参照の整理によって相手の入出力・配線が消える場合は、その段を拒否して通知する。現在の計画を変更せず、その操作を保存しない。位置のx/y、担当・判断・成果物の配列は、従来どおり項目全体が統合単位。相手の変更を保持するため自分の項目を完全には戻せない場合は、その制限を通知する。部分ごとに戻す実装へは変更していない。

担当解除のログはB番号を振り直した後に作る。保存する統合では呼出元が時刻を渡し、比較用の純粋な計算では入力の既知時刻を使う。IDは対象と入力イベントに、共通基準の解除ログから数えた発生回を加える。同じ基準での再試行は重複せず、前回の解除が共通基準に入った後の再発は別の記録になる。

Human sync actions accept explicit `--actor human` or `--actor human:name`. An ordinary recorder name or `CODEX_HOME` alone does not identify AI. Halt messages point misidentified humans to `boxglow sync --help` without suggesting impersonation to AI. Environment-only actor settings do not authorize human actions; MCP remains AI-only. Watch retry commands omit `--watch` and execute once beside the existing watcher.

Undo/redo rejects a historical step if an externally edited entity is absent or cleanup would discard external ports or wires. Rejection leaves the current plan unchanged and does not save. Positions and nested arrays remain atomic fields: when external changes prevent fully restoring one, a partial-undo notice appears. Assignment cleanup logs use the caller's merge time, final block key, and an occurrence number derived from the common base; retries share an ID while subsequent cleanup events receive a new one.
