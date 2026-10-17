# 同期を始める（段階D）

通常の `boxglow serve --open` と VS Code の同期パネルに「同期を始める」が出ます。起動しただけでは、新しい計画を送信しません。開始画面で送り先を確認して、「この計画を新しくサーバーに置く」か「サーバーの計画を開く」を選んでください。必要なサインインが終わると、選んだ手順を続けます。

## 送り先と無効設定

送り先の優先順は、CLI の `--server` / VS Code の `boxglow.sync.server`、環境変数 `BOXGLOW_SERVER`、ファイルの既存の結び付け、製品の既定値です。既定値は `https://sync.boxglow.app` です。VS Code の `null` は未指定、空文字と `off` は明示無効です。環境変数の空文字は未指定です。環境変数で入口を無効にする場合は `BOXGLOW_SERVER=off` を使います。

```sh
boxglow serve --open                         # 明示開始の入口（初回の送信なし）
boxglow serve --server http://localhost:9000  # 自分のサーバー
boxglow serve --no-sync                      # 同期の入口も出さない
boxglow serve --server off                   # 同じく無効
boxglow serve --sync                         # この計画の常時同期を明示的に有効化
```

VS Code は次の設定で無効にできます。

```json
{ "boxglow.sync.server": "" }
```

既存の結び付けを別のサーバーへ移しません。明示的に異なるサーバーを指定した場合も、既存の同期処理が `bound-elsewhere` で止めます。壊れた結び付けの記録や複数の結び付けがある場合は、推測で製品既定へ接続しません。

## 2台目で開く

「サーバーの計画を開く」で、サインイン中のアカウントの名前・更新日時・サイズだけを一覧します。20件ずつ表示し、次のページと再読み込みを使えます。本文とトークンは一覧の画面状態に含めません。

保存先は「今開いているファイル」と「新しいファイル」から選びます。

- 今開いているファイル: 内容が異なれば比較で止まります。自動的にサーバーの内容へ置き換えません。
- VS Code の新しいファイル: 計画を選んだ後、保存ダイアログで未使用のパスを選びます。取消では何も書きません。既存の別ファイルは上書きしません。
- serve の新しいファイル: 現在のファイルと同じフォルダ内に、指定した `.json` ファイルを作ります。「保存した計画を開く」で新しいローカル画面を開いてください。この画面も元のserveプロセスが配信するため、元のプロセスを終了すると両方閉じます。別フォルダを使うときは、そのフォルダの計画をserveで開いてから開始してください。

手元にまだファイルが無い端末 (新しい PC など) では、ファイルを作らずに始められます。`npx boxglow serve --sync --file <保存したいファイル名>` のように、まだ無いファイル名で起動すると、画面の Home に「このファイルは、まだありません」と出て、名前を付けて新しい計画を作るか、「サーバーの計画を受け取る」でサインイン → 一覧 → 選んだ計画をそのファイルに保存して開けます (保存先の選択は出ません)。VS Code では、空のファイル (0 バイトの `boxglow.json`) を Boxglow で開くと同じ案内が出ます。

ブラウザだけ (https://boxglow.app): 裏方なしでも同期できます。Home の「サーバーの計画を受け取る」でサインイン (GitHub のコード / Google の URL) すると、サーバーの計画がこのブラウザに保存されて開き、以後は開いている間 30 秒ごとと保存の直後に同期します。ブラウザ内で作った計画は、上のバーの同期の印 → 「同期を始める」→「この計画を新しくサーバーに置く」でサーバーに置けます。サインインの証はサーバーが発行する HttpOnly Cookie で、画面の JavaScript やブラウザの保存領域にはトークンを残しません。この Cookie は boxglow.app と sync.boxglow.app の間 (同じサイト) でだけ送られるので、boxglow.pages.dev では同期の入口は出ません (boxglow.app を使ってください)。サーバーの計画の削除・復元は、ブラウザ版ではまだ使えません (CLI の `boxglow remote` か serve / VS Code の画面で)。

2 つ目のサインインの手段: 同期パネルの詳細に、アカウントに付いている手段 (GitHub ✓ / Google ✓) が出ます。無い方の「+ Google」「+ GitHub」を押すと、その手段で許可する手順 (コードまたは URL) が出て、許可するとそのアカウントに足されます。以後はどちらの手段でサインインしても同じアカウントになります。CLI は `boxglow login --add google` (または github)。足す操作は本人の明示操作だけで、メールアドレスが同じというだけでは結び付けません。その手段が別のアカウントで使われているときは断られます (統合はしません)。

一覧のない旧サーバーでは、詳細の「計画IDを指定」を使えます。送り先の変更は `--server` / `boxglow.sync.server` で指定して開き直してください。知らないIDや他のアカウントのIDを入力しても、新しいサーバー計画の作成には切り替えません。

## 再開と中断

有効化は計画JSONの外、設定フォルダの `sync-enabled/` に、実ファイルのパスと送り先の組で保存します。通常起動はこの記録に従います。`--sync` は記憶した無効より優先する明示指定です。VS Code の旧globalState記録は、新しい記録がまだ無い場合だけ引き継ぎます。

開始画面のoperationIdと段階で重複クリック・古い一覧の選択を拒否します。通信前に既存の同期エンジンが結び付けとpendingの操作IDを永続化し、再起動後も同じリモートIDへ再試行します。認可前の選択はメモリ内だけで、再起動や取消の後に勝手に新規配置を再開しません。送信途中で止まった計画は既存の再開・比較手順に従います。

GitHub のコードは、ボタンを押すとコピーして認可ページを開きます。コピー不可でもコードが画面に残ります。Google の完了ページはタブを閉じることを試み、閉じられなければBoxglowへ戻る案内を残します。

HTTPSまたはlocalhostのHTTPだけを使用します。Windowsネイティブの資格情報保存は従来どおり未対応で、WSLまたはLinuxの拡張ホストを利用してください。AI/MCPの初回結び付け・競合解決の制限は変えていません。

## 配置の順序

B（boxglow-cloud）の一覧APIを作者が配置してからAを配布するのが推奨です。Aを先に使っても旧サーバーへのID指定に戻れます。クエリなしの `GET /v1/projects` は、既存の常時同期クライアント向けの配列を維持します。計画JSONの形式変更はありません。


### 互換性の変更: 製品先の環境トークン

**製品の既定の送り先では、`BOXGLOW_TOKEN` だけでは認証に使いません。使う場合は、同期先と一致する `BOXGLOW_TOKEN_SERVER` も必要です。** 明示指定や既存の結び付けにも適用します。独自サーバーは、専用送り先を未指定なら従来互換です。ただし、非localhostのHTTPへの同期送信は拒否します。HTTPSへ変更してください。

### 接続先とサインインの扱い

製品の同期サーバーには、`--server`・`BOXGLOW_SERVER`・既存の結び付け・既定へのフォールバックのどの経路でも、送り先未指定の `BOXGLOW_TOKEN` を使いません。そのサーバーでサインインして保存した資格情報を使います。URLのホスト名の大文字小文字・既定ポート・末尾スラッシュを正規化して判断し、製品のホストはHTTP表記・パス違いでも保護します。ホスト名末尾のドットはすべて除いて判定します。同期の送信・一覧取得もHTTPSまたはlocalhostのHTTPに限定し、リダイレクト先へ認証情報を送りません。

CIなどで製品サーバーへ環境トークンを使う場合は、`BOXGLOW_TOKEN` と一緒に `BOXGLOW_TOKEN_SERVER=https://sync.boxglow.app` を指定します。`BOXGLOW_TOKEN_SERVER` は同期先を選ぶ設定ではなく、トークンを渡してよい送り先です。同期先URLと正規化後に一致するときだけ、保存済みサインインより優先します。空・不正・不一致なら環境トークンを使わず、保存済みサインインへ戻ります。

自分のサーバーは、`BOXGLOW_TOKEN_SERVER` が未指定なら従来どおり環境トークンを使えます。これを指定した場合は、自分のサーバーでも一致を要求します。サインアウトは保存済みサインインを取り消す操作で、環境変数そのものは削除しません。

### 有料プランと課金 (Stripe)

同期パネルの詳細に、サーバーが返した契約の状態 (プラン・状態) が出ます。契約が無いときは「Personal を申し込む (月 500 円)」「Team を申し込む (1 人 月 800 円)」、契約があるときは「契約の管理」(支払い方法の変更・解約。Stripe の画面) が出ます。どちらもリンク (Stripe の画面) を開く形で、カード番号はサーバーも画面も扱いません。サーバーが契約を求めている間 (提供開始後)、契約の無いアカウントの同期は「有料プランの契約が必要です」で止まります (サインインと申し込みはできます)。CLI は `boxglow billing` (状態)、`boxglow billing --checkout personal|team [--seats 人数]` (申し込みの URL)、`boxglow billing --portal` (契約の管理の URL) です。招待制の試用の間は、契約が無くても同期できます。

### 共有リンク (閲覧専用)

同期パネルの「サーバーの計画を管理」→「共有リンク」→「リンクを作る」(期限は 7 / 30 / 90 日か無期限) で、`https://boxglow.app/#share=<トークン>` の URL ができます。リンクを知っている人は、サインインせずにその計画の最新の内容を閲覧専用で見られます (編集も保存もできません)。URL は作った直後だけ表示されます (サーバーはハッシュしか持たないので、後から再表示できません)。有効なリンクは 1 人 5 本までで、不要なリンクは「失効」で止められます。失効・期限切れ・アカウントの停止・計画の削除のどれでも、リンクは読めなくなります。

### 履歴から戻す

同期パネルの「サーバーの計画を管理」→「履歴」で、サーバーに残っている版の一覧 (新しい順) が出ます。「この版に戻す…」→ 確認 →「この版に戻す」で、その版の中身を手元のファイルに書き戻します (置き換える前の内容は、ファイルの隣の `*.before-sync-<ハッシュ>.json`、ブラウザ版ではブラウザの保存先に控えます)。サーバーの履歴は書き換えず、次の同期で新しい版として送られます。CLI は `boxglow remote versions <ID>` (一覧) と `boxglow remote revert <ID> <版> --file <計画のファイル> --actor human` です。

サーバーの履歴は計画ごとに間引かれます: 直近 24 時間は全部、7 日までは 1 時間に 1 つ、90 日までは 1 日に 1 つ (最新の版は必ず残ります)。保存量の上限に届くときは、この規則より先に古い版から間引かれ、それでも収まらなければ書き込みが断られます。

### AI エージェントの接続 (ホスト型の MCP)

アカウントのメニュー → 「AI エージェントの接続」で、今開いている計画 (サーバーに置いたもの) 用のトークンを作れます (名前、読み取り専用 / 読み書き。1 アカウント 10 個まで。値は作った直後だけ表示)。Claude Code や Codex にそのトークンを登録すると、手元にファイルが無くても `https://sync.boxglow.app/mcp` 経由で計画を読み書きできます。CLI は `boxglow agent-token [list | create --name <名前> [--write] | revoke <id>]`。詳しくは [HOSTED_MCP.md](HOSTED_MCP.md)。

### アカウントの削除

同期パネルの「詳細と設定」にある「アカウントを削除…」で、本人がアカウントを削除できます (serve / VS Code / ブラウザ版のどれからでも)。確認のあと、サーバーはすぐにアカウントを止めてトークンを全部失効させ、30 日後に保存データ (計画・端末・履歴) を消します。それまでは support@boxglow.app への連絡で取り消せます。手元のファイルは残ります。
サーバーに置いた計画の中身と招待のメールアドレスは暗号化して保存され (アカウントごとの鍵を、データベースの外の秘密で包む)、失効したトークンの記録は 30 日で消えます。

`serve --sync` は、同期先が製品既定へフォールバックした場合は開始の入口だけを表示します。トークンの送り先制限と自動開始の条件は別です。

無効な計画を開いただけでは通信せず、保存済みの利用者名を表示します。有効化の記憶は同期成功後に保存し、未連携の計画をサーバーから開く場合は新しいファイルを初期選択にします。既存ファイルへの保存は選択を明示したうえで比較へ進みます。

### Windows ネイティブで環境トークンを使う

Windowsネイティブではサインインの保存は未対応です。通常はWSLのCLIかLinuxのVS Code拡張ホストでサインインしてください。すでに有効なトークンを安全に入手している場合は、WindowsのCLIでも、PowerShellの同じセッションに送り先とトークンを設定できます。

```powershell
$env:BOXGLOW_TOKEN_SERVER = "https://sync.boxglow.app"
$env:BOXGLOW_TOKEN = [System.Net.NetworkCredential]::new("", (Read-Host "発行済みトークン" -AsSecureString)).Password
boxglow whoami --server $env:BOXGLOW_TOKEN_SERVER
boxglow sync --server $env:BOXGLOW_TOKEN_SERVER --actor human
```

トークンを持っていない場合、この例だけで取得はできません。WSL側のサインイン手順を利用してください。Windowsで保存に失敗したloginが発行したトークンは取り消され、画面にも表示されません。環境変数による指定はWindowsのGUIでの資格情報保存を有効にするものではありません。

### HTTPからHTTPSへの移行 / HTTP to HTTPS migration

非localhostのHTTPは設定エラーとして停止します。同じURLでの再試行では直りません。独自サーバーの管理者に、HTTPS側が同じアカウント・同じ計画ID・同じ履歴を提供することを先に確認してください。別のサービスへ自動的に付け替える機能ではありません。

1. 全端末のwatch、serve、VS Codeの同期を止め、未保存編集を保存または退避します。各端末の計画JSONと設定フォルダ全体を別の場所へ控えてください。設定フォルダは `BOXGLOW_CONFIG_DIR`、未指定なら `XDG_CONFIG_HOME/boxglow`、Windowsでは `%APPDATA%/boxglow`、それ以外は `~/.config/boxglow` です。
2. 設定フォルダの `sync/*/state.json` の `binding.file` と `binding.server` で対象を確認し、`binding.remoteId` を控えます。`pending` や `relink` に途中の操作がある場合、URL・account・世代を書き換えたり記録を捨てたりせず、管理者とサーバー側の反映結果を照合してください。不明なまま結び直さないでください。
3. 対象を確認した後、該当する **state.jsonの親フォルダ全体**（objects、操作・復旧の記録を含む）を `sync/` の外の保管先へ移します。例: 設定フォルダの `sync-archive/`。`sync/` 内の改名だけでは引き続き検出されます。削除せず保管し、ほかの計画のフォルダやロックには触れません。
4. HTTPS側でサインインし、同じ計画IDを指定して `boxglow sync --server https://<確認したホスト> --project <控えたremoteId> --file <計画JSON> --actor human` を実行します。手元とサーバーが違う場合は比較で停止するので、人が確認します。保存された旧状態をHTTPS用に直接書き換えないでください。
5. 内容を確認してから他端末でも同じ手順を行い、HTTPSの設定で再開します。旧HTTPの有効化記録は新しいURLへ自動継承しません。保管した状態を戻すときも、全端末の同期を止めてから行ってください。

これは人が行う移行手順です。Boxglowは状態フォルダの移動やサーバー側の移行を自動実行しません。HTTP側の本文や操作結果が確認できない場合は、保管した記録を維持して管理者へ確認してください。


## サーバーの計画の削除と復元 (段階E)

同期パネルの「サーバーの計画を管理」から操作します。「サーバーから削除…」は対象名・送り先・利用者・IDを表示し、「削除を確定」を押すまで送信しません。計画一覧のごみ箱アイコンも同じ確認を開きます。ほかの端末が更新して版が変わった場合は削除を拒否するので、確認を閉じて最新の対象を読み直してください。

削除後も手元のファイル・未送信の編集・同期の控えは残ります。各端末は次の同期で削除を検出して停止し、自動で同じIDを作り直しません。「削除済みの計画」に復元期限を表示します。期限は削除確定から30日 (UTCの時刻で720時間)。期限を過ぎた計画は復元できません。

復元は削除時の最新の内容を**新しいサーバーID**に戻します。元IDと削除記録は残り、古い端末は停止したままです。復元後に「サーバーの計画を開く」から進み、保存先を「新しいファイル」にして、復元した計画を開いてください。元のファイルに未送信の変更があれば、そのファイルを残して比較してください。以前の版の履歴は新しい計画には引き継ぎません。

CLI (画面なしでも利用可):

```sh
boxglow remote trash --server https://YOUR-SERVER
boxglow remote delete PLAN-ID --server https://YOUR-SERVER
boxglow remote restore DELETED-PLAN-ID --server https://YOUR-SERVER
```

delete / restore の初回は確認用の情報と `CONFIRM` を表示するだけです。人が対象を確認し、同じコマンドに `--actor human --confirm <CONFIRMの後の文字列>` を追加して確定します。環境変数の actor だけでは許可しません。通信結果が不明な場合は**同じ確認文字列**で再試行してください (新しい操作を作らず、受理済みの結果を取り直す)。認証・送り先・前提の版・履歴の世代が変わった場合は止まります。MCPからの確定操作は提供しません。

削除済み一覧の次ページは `--cursor <nextCursor>`。HTTPS / トークン指定は通常の同期と同じ規則です。新しい画面とCLIは `/trash` 付きの削除専用経路を使います。旧サーバーは404で拒否するため、復元不能な旧APIの削除へは進みません。

### Delete and restore server plans

Use **Manage server plans** in the sync panel. Deletion shows the plan, server, account and ID before confirmation. A changed revision rejects the deletion. Local files and unsent edits remain; old clients stop syncing the deleted ID.

Deleted plans are restorable for 30 days (720 hours). Restore creates a **new server ID** with the latest content at deletion. The original ID stays deleted forever. Open the restored plan from the server list with **New file** selected. Earlier revision history is not copied. Preserve and compare any unsent local edits separately.

The CLI commands above first display a preview. A person confirms with `--actor human --confirm <the CONFIRM value>`. Retry an uncertain result with the **same value**. Changed credentials, server, epoch or revision stop the operation. The trash list uses `--cursor <nextCursor>` for further pages. This requires a Stage E server. The new UI and CLI use a dedicated deletion route; older servers return 404 without deleting anything.


### 復元先へ元のファイルを結び直す (E2)

削除された計画に結び付いている元ファイルで「今すぐ同期」を実行します。削除記録に復元先があれば「復元した計画 … に結び直す」が現れます。選ぶと、元の同期状態・手元の本文・基準・未確定操作の本文を同期状態フォルダの `relinks/` に退避してから、復元先との通常のlink比較へ進みます。違いがある間は勝手に送受信しません。

「手元の計画を採る」で元ファイルの未送信編集を復元先へ送れます。「サーバーの計画を採る」では手元を退避したうえで復元先の内容を受け取ります。古い操作IDは新しい計画に流用しません。中断しても、新しい結び付けの比較または記録済みの同期から続けます。元の削除済みIDは410のままです。

CLIは `boxglow sync` に表示される `--reconnect-restored <印>` を人が `--actor human` とともに実行し、続く `--link` の比較で選びます。AIへの表示は対象と人への依頼だけで、確定用のコマンド・確認文字列を出しません。未送信編集を別に残したい場合は、引き続き「新しいファイル」で復元先を開くこともできます。

After restoring, run Sync now in the original file and choose **Reconnect to restored plan**. The client archives the original sync state, local content, base and pending content before entering the existing link comparison. Choose the local plan to send unsent edits to the restored destination, or the server plan to receive it with a local backup. The deleted ID stays blocked. In the CLI, a person uses the displayed `--reconnect-restored` action and then the `--link` comparison. AI previews show no confirmation token or executable confirmation recipe.
