# 期限付きの受け持ち (段階 C)

受け持ちは、同じ `boxglow.json` を使う CLI / MCP 実行の協調制御です。旧計画では無効のままです。人が計画設定の「AI の受け持ち」で有効化すると、既定の推奨設定は範囲外の保存を拒否、期限は30分です。警告だけに切り替えることもできます。

## 境界

- 同じファイルを同じ保存ロック/CAS方式で操作する実行について、取得と保存前検証をロック内で確定します。
- 同期された別端末のファイルは別の排他領域です。claimsを同期しても、分散leaseや分散ロックにはなりません。同一ファイルでも時計の正しさが前提です。更新時刻より時計が戻った場合は拒否しますが、時計の大きな前進による早い期限切れは防げません。
- 人のGUI操作と明示的な `--actor human` の操作は継続できます。これは認証やサンドボックスではありません。直接JSONを書き換えるツール、旧版、別コピーの書き手は制御に参加しません。
- 他者の受け持ち、範囲外は reject なら拒否、warn なら警告します。ただし、自分の期限切れ・解除済み・世代が違う受領証は warn でも拒否します。AIが人を名乗ることは運用上禁止です。
- 本段階は保存される計画の範囲を制御します。ソースコード等の作業ファイルそのものをロックする機能ではありません。

## 識別と範囲

`actor` は人が読む名前、`instanceId` は独立した実行セッションのIDです。同じ `codex` でも実行IDが違えば別の書き手です。CLIは `--instance` または `BOXGLOW_INSTANCE_ID` を使用します。独立したエージェントに同じIDを共有させないでください。環境から得た親タスクIDを自動採用することはしません。

`claims[blockId]` は取得ID、世代、取得・更新・期限日時、範囲を持ちます。解放時は記録を削除せず、世代を増やして理由を残します。再取得も新しい取得IDと世代になります。受領証は `[blockId,generation,claimId]` のJSON文字列です。秘密鍵ではなく、取得時点を照合するための値です。他者のinstanceId・受領証を使わないでください。計画やclaimsの出力から受領証を組み立てて他者として書き込むことも禁止です。拒否されたら人に相談し、取得済みの別の範囲へ進みます。

- `block` (通常のstart): ボックス自身、その入出力・成果物・判断・引き継ぎ。
- `subtree`: 上記に加えて子孫。
- 新規作成は既存の親、配線は両端、移動は本体・元の親・新しい親、削除は消える全子孫と親に受け持ちが必要です。複数の受領証は `--claim-token` を繰り返して渡します。
- 未接続入力を祖先へ自動で引き上げるポートと配線は、元の入力のボックスの範囲で扱います。入力の追加だけのために祖先・rootを取得する必要はありません。共有入力の内容そのものを変える場合は、影響を受ける全ボックスの取得が必要です。
- 計画全体の設定や未知の追加項目の変更にはrootの受け持ちが必要です。`context root` → `start root` で取得できます。計画設定の変更はrootのみの取得で足ります。rootの `--scope subtree` は並行作業を全部止めるため、AIは使わず人に相談してください。取得が成功すると、その影響を出力にも表示します。
- 保存時の入力名正規化や配置調整で、別の実ボックスまで変わる場合はその受け持ちも必要です。子の追加で隣のボックスが動く場合など、作業前に必要な範囲を決めてください。
- 重なる取得は自分同士も避けます。親のsubtreeを持っているときの子へのstartは、親の既存受領証を検証して使用します。子のdone/leaveでは親の受け持ちは解放しません。

## 人が最初に有効化

GUIの計画名 →「AI の受け持ち」か、次のCLIで設定します。AIは代行しません。

```sh
boxglow claim-policy --mode reject --minutes 30 --actor human
```

`--mode warn` は警告、`--mode off` は無効化です。無効化すると現在の受け持ちは解放され、再度有効にしても古い受領証は復活しません。設定・解除とそのログはUndo/Redoで巻き戻しません。解除済みの記録を再解除しても、世代・理由・ログは変わりません。

## CLIの並列作業

1. 各実行の開始時に、一意の実行IDとactorを固定します。
2. `resume` / `claims` で自分・他者・期限切れを読み、対象の `context` を確認します。
3. `start` で取得し、成功出力の `CLAIM` 行にある `token` を保持します。失敗時は作業を始めません。
4. 保存する全コマンドに同じ実行IDと受領証を付けます。context guardが有効なら、別途contextTokenも必要です。
5. 作業中は5分ごと (短い期限を設定した場合はその半分以内) に `claim-renew` を呼びます。checkpointは使用した受け持ちを延長します。通常の保存も、更新から5分または期限の半分が経った時点で延長します。処理が無い間に裏で自動延長する常駐タイマーはありません。
6. done/leaveで対象自身の受け持ちを解放します。長い作業の前後や中断前はcheckpointを残します。クラッシュしても即座には奪わず、期限まで待つか人の解除を求めます。

```sh
export BOXGLOW_ACTOR=codex
export BOXGLOW_INSTANCE_ID="$(node -e 'console.log(require("node:crypto").randomUUID())')"
boxglow context B10
boxglow start B10 --actor codex --scope subtree --context-token '<contextToken>'
# 実際のCLAIM出力のtokenを保存する。以下のIDは例。
export CLAIM_TOKEN='["internal-id",1,"claim-id"]'
boxglow checkpoint B10 --actor codex --claim-token "$CLAIM_TOKEN" --context-token '<new-contextToken>' --note '確認済みの内容と次の手順'
boxglow claim-renew B10 --actor codex --claim-token "$CLAIM_TOKEN"
boxglow done B10 --actor codex --claim-token "$CLAIM_TOKEN" --context-token '<new-contextToken>' --artifact '成果物=path/to/file'
```

期限切れは延長では復活しません。最新contextを読み直し、成果が今も適用できるか確認した上でstartし、新しい受領証を使用します。

計画設定を変更するときの例です。各contextの内容を確認し、その出力のトークンを使います。rootの取得は専用の参照であり、通常の検索・編集ボックスにrootを追加するものではありません。

```sh
boxglow context root --actor codex
boxglow start root --actor codex --context-token '<contextToken>'
# このstartが出力したCLAIMのtoken。通常のボックス用の受領証とは別。
export ROOT_CLAIM_TOKEN='<token from this start>'
boxglow focus B10 --actor codex --claim-token "$ROOT_CLAIM_TOKEN" --context-token '<contextToken>'
boxglow group "資料" --actor codex --claim-token "$ROOT_CLAIM_TOKEN"
boxglow context root --actor codex
boxglow leave root --actor codex --claim-token "$ROOT_CLAIM_TOKEN" --context-token '<latest-contextToken>'
```

この例も上の固定した `BOXGLOW_INSTANCE_ID` を使います。rootのみの取得は、通常のボックスの編集権を含みません。rootの終了には `leave root` を使います。

人による解除は理由が必須です。

```sh
boxglow claim-release B10 --reason '実行を停止し、担当を交代する' --actor human
```

## MCP

MCPはプロセスごとの実行IDを生成し、そのプロセスがstartで取得した受領証を保持します。`boxglow_start` は任意の `scope: block | subtree` を受け付けます。`boxglow_claims` は一覧、`boxglow_claim_renew` は延長です。通常の更新ツールにも受領証を自動で付けます。再起動は別実行となり、前の受け持ちを自動回収しません。同じactorの別実行であることと、持ち主・範囲・期限を表示します。期限を待つか人に解除を依頼してください。旧実行のIDや受領証を借りて再開してはいけません。rootも `boxglow_context` → `boxglow_start` で指定でき、`boxglow_run` の `group` などにも取得済み受領証が付与されます。

`boxglow_run` から実行ID・actor・計画ファイル・受領証を差し替えたり、人向けの設定・解除操作を呼んだりできません。同期の競合はこれまでどおり人へ渡し、AIは選択しません。

## 画面と同期

ツリーは小さな錠アイコンのみ、ボックスは活動と担当名を一つの札で示します。範囲・期限・実行IDは詳細パネルで確認でき、人は理由を書いて解除できます。期限切れは時計に合わせて表示を変えますが、表示のために計画を保存しません。

受け持ちの同期マージはボックスごとの記録全体を一単位にし、actorと世代を別の書き手から混ぜません。競合は該当ボックスにまとめて人に見せます。別コピーでの同時取得を防ぐ仕組みではありません。

## Gitの統合とJSON出力

Gitマージドライバの `merge base ours theirs` は保存済みの両側を統合するため、作業用の受け持ち照合を行いません。保存ロック・CASと計画の整合性検証は維持します。claimsはボックスごとの記録全体を一単位で統合し、両側が同じ記録を変えた場合は既存の競合規則に従います。`--strict` では競合ログを残して非ゼロで終了します。AIが同期の競合を選択する権限は増えません。

`status --json` は従来どおりProjectだけを出力し、派生情報のclaimSummaryを混ぜません。`resume --json` と `context` のclaimSummaryは、受け持ちが有効な計画でだけ付けます。明示的な一覧取得には `claims` を使ってください。

画面ではclaimsだけが変わった外部更新も統合・保存しますが、その成功通知は出しません。通常の編集が混ざる場合や競合の場合の通知は維持します。
