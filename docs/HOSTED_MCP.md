# ホスト型の MCP (Claude Code / Codex がサーバー経由で計画を読み書きする)

手元に `boxglow.json` が無い環境 (別の PC、クラウドのエージェント、Claude Code の Web 版など) からでも、サーバー (https://sync.boxglow.app) に置いた計画を、AI エージェントが MCP で読み書きできます。手元の `npx boxglow mcp` (stdio) と同じ道具 (`boxglow_status`, `boxglow_show`, `boxglow_add`, `boxglow_start`, `boxglow_done`, ...) が、HTTP の MCP (`https://sync.boxglow.app/mcp`) で使えます。

## 使い方

1. 計画をサーバーに置く (同期を有効にして結び付ける。[SYNC_START.md](SYNC_START.md))。
2. アカウントのメニュー (右上のアイコン) → 「AI エージェントの接続」 → 名前 (例: claude-code) と「書き込みも許可」を決めて「トークンを作る」。
3. トークンの値 (`bga_...`) は作った直後だけ表示されます (サーバーはハッシュしか持ちません)。「Claude Code の登録コマンドをコピー」か「Codex の設定をコピー」で、そのまま貼れる形になります。
   - Claude Code: `claude mcp add --transport http boxglow https://sync.boxglow.app/mcp --header "Authorization: Bearer bga_..."`
   - Codex (`~/.codex/config.toml`):
     ```toml
     [mcp_servers.boxglow]
     url = "https://sync.boxglow.app/mcp"
     http_headers = { Authorization = "Bearer bga_..." }
     ```
4. エージェントが `boxglow_status` を呼ぶと、サーバー上の最新の版が読めます。書き込み (`boxglow_start` など) は、サーバーに新しい版として保存され、同期している端末には次の同期で届きます。

CLI でも同じことができます: `boxglow agent-token` (一覧)、`boxglow agent-token create --name claude-code --write` (今の計画のトークンを作る)、`boxglow agent-token revoke <id>`。

## トークンの性質

- トークンは **計画 1 つ** に結び付きます (別の計画には使えません)。計画をサーバーから消すと、そのトークンも使えなくなります。
- **読み取り専用** (status / show / context / lint / validate / claims / export / review-* / log の読み出し) と **読み書き** を選べます。読み取り専用のトークンで書く道具を呼ぶと「このトークンは読み取り専用です」になります。
- 1 アカウント **10 個** まで。使わないものは「失効」で止めてください (一覧に回数と最後に使った日時が出ます)。アカウントの削除・サインアウトでは失効しません (トークンは端末ではなく計画に付くため)。アカウントを削除すると全部使えなくなります。
- `serve` / `mcp` / `sync` / `login` / `remote` / `init` / `import` など、手元のファイルやネットワークが要るコマンドは、ホスト型では使えません。
- 要求は 1 回ずつ独立しています (セッションを持たない JSON 応答)。同時に 2 つの書き込みが重なると、後の方は 409 で失敗し、エージェントは読み直してから再試行します。
- 書き込みの記録 (作業記録・判断の記録) の actor は、トークンの名前になります。

## 仕組み (開発者向け)

CLI の本体 (`cli/main.ts`) はファイルの読み書きを `cli/plan-io.ts` (`PlanIO`) 経由で行い、ホスト型では `memoryPlanIO` (メモリ上の 1 計画) に差し替えます。`cli/hosted.ts` の `handleMcpRequest` が、`@modelcontextprotocol/sdk` の `WebStandardStreamableHTTPServerTransport` で 1 要求を処理し、変わった中身を返します。`npm run build:hosted` で `dist/hosted-mcp.mjs` にまとめ、サーバー (boxglow-cloud) が `POST /mcp` でトークンを検証してから呼びます。
