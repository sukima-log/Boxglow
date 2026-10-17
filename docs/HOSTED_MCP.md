# ホスト型の MCP (Claude Code / Codex がサーバー経由で計画を読み書きする)

手元に `boxglow.json` が無い環境 (別の PC、クラウドのエージェント、Claude Code の Web 版など) からでも、サーバー (https://sync.boxglow.app) に置いた計画を、AI エージェントが MCP で読み書きできます。手元の `npx boxglow mcp` (stdio) と同じ道具 (`boxglow_status`, `boxglow_show`, `boxglow_add`, `boxglow_start`, `boxglow_done`, ...) が、HTTP の MCP (`https://sync.boxglow.app/mcp`) で使えます。

## 使い方

1. 計画をサーバーに置く (同期を有効にして結び付ける。[SYNC_START.md](SYNC_START.md))。
2. アカウントのメニュー (右上のアイコン) → 「AI エージェントの接続」 → 「書き込みも許可」を決めて **「Claude Code に接続」** か **「Codex に接続」** を押す。
   - **serve / VS Code 拡張** (手元にファイルを書ける): これで終わりです。トークンを作り、設定ファイルに書き込みます (Claude Code は計画のフォルダの `.mcp.json`、Codex はホームフォルダの `.codex/config.toml`。ほかの項目は残し、boxglow の項目だけ足します。`.gitignore` があれば `.mcp.json` を足します)。Claude Code / Codex を開き直すと boxglow のツールが使えます。初回に「このプロジェクトの MCP サーバーを使うか」と聞かれたら許可します。トークンの値は表示しません。
   - **ブラウザ版 (boxglow.app)**: Claude Code は「フォルダを選んで設定を書く」で、Claude Code で開くフォルダ (プロジェクトの直下) を選ぶと、その中の `.mcp.json` に直接書きます (Chrome / Edge。既存の項目は残し、`.gitignore` があれば足します) → Claude Code を開き直す (初回の確認を許可)。フォルダを選べないブラウザでは `.mcp.json` をダウンロードし、名前を `.mcp.json` に直して置きます。Codex: 「設定をコピー」 → ホームフォルダの `.codex/config.toml` の末尾に貼る → Codex を開き直す。CLI の `claude` がある人は「登録コマンドをコピー」の 1 行でも済みます。
3. エージェントが `boxglow_status` を呼ぶと、サーバー上の最新の版が読めます。書き込み (`boxglow_start` など) は、サーバーに新しい版として保存され、同期している端末には次の同期で届きます。

CLI でも同じことができます: `boxglow agent-token connect claude-code|codex [--read-only]` (計画のフォルダで。トークンを作り、設定ファイルに書く)。トークンの値だけ要るときは `boxglow agent-token create --name <名前> [--write]`、一覧は `boxglow agent-token`、失効は `boxglow agent-token revoke <id>`。

設定ファイルの中身 (手で置くとき):

- Claude Code (`.mcp.json`。作業フォルダの直下): `{ "mcpServers": { "boxglow": { "type": "http", "url": "https://sync.boxglow.app/mcp", "headers": { "Authorization": "Bearer bga_..." } } } }`
- Claude Code の CLI: `claude mcp add --transport http boxglow https://sync.boxglow.app/mcp --header "Authorization: Bearer bga_..."`
- Codex (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.boxglow]
  url = "https://sync.boxglow.app/mcp"
  http_headers = { Authorization = "Bearer bga_..." }
  ```

## トークンの性質

- トークンは **計画 1 つ** に結び付きます (別の計画には使えません)。計画をサーバーから消すと、そのトークンも使えなくなります。
- **読み取り専用** (status / show / context / lint / validate / claims / export / review-* / log の読み出し) と **読み書き** を選べます。読み取り専用のトークンで書く道具を呼ぶと「このトークンは読み取り専用です」になります。
- 1 アカウント **10 個** まで。使わないものは「失効」で止めてください (一覧に回数と最後に使った日時が出ます)。アカウントの削除・サインアウトでは失効しません (トークンは端末ではなく計画に付くため)。アカウントを削除すると全部使えなくなります。
- `serve` / `mcp` / `sync` / `login` / `remote` / `init` / `import` など、手元のファイルやネットワークが要るコマンドは、ホスト型では使えません。
- 要求は 1 回ずつ独立しています (セッションを持たない JSON 応答)。同時に 2 つの書き込みが重なると、後の方は 409 で失敗し、エージェントは読み直してから再試行します。
- 書き込みの記録 (作業記録・判断の記録) の actor は、トークンの名前になります。

## 仕組み (開発者向け)

CLI の本体 (`cli/main.ts`) はファイルの読み書きを `cli/plan-io.ts` (`PlanIO`) 経由で行い、ホスト型では `memoryPlanIO` (メモリ上の 1 計画) に差し替えます。`cli/hosted.ts` の `handleMcpRequest` が、`@modelcontextprotocol/sdk` の `WebStandardStreamableHTTPServerTransport` で 1 要求を処理し、変わった中身を返します。`npm run build:hosted` で `dist/hosted-mcp.mjs` にまとめ、サーバー (boxglow-cloud) が `POST /mcp` でトークンを検証してから呼びます。
