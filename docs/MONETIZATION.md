# Free and paid: where the line is

Boxglow is open core. Everything that works with the plan file on your own machines is free (MIT) and stays free, including a team sharing that file through Git. Features that need a service run for you, or a connection to an external service, are the paid product (Boxglow Cloud, in preparation).

The rule: **your file, your machines, your Git = free. A service we run for you (sync, share links, team administration, integrations, hosted agents) = paid, and so is the self-hosted edition of that paid product.** Running the MIT core on your own server stays free.

| Feature | Free (MIT) | Paid |
|---|---|---|
| Web app (browser storage, local `boxglow.json` via File System Access) | yes | |
| CLI for AI agents, `setup-agent`, all plan / status / decision commands | yes | |
| One `boxglow.json` in Git, box-level 3-way merge driver | yes | |
| Members inside the file (owners, filters) | yes | |
| Parts (templates), input groups, categories, due dates | yes | |
| VS Code extension | yes | |
| Sync: the same plan on several devices / people, history, server-side merge | | Sync |
| Share: read-only links with password, expiry, embedding | | Share |
| Team: workspaces, invitations, permissions, activity across people | | Team |
| Connect: Slack / Teams notifications, JIRA / Redmine sync | | Connect |
| Agent: hosted MCP / agent API for cloud agents | | Agent |
| Self-host: all of the above inside your own network (commercial licence) | | Self-host |

What we will not do: features already published under MIT will not be moved behind a paywall, and the paid product never asks for your source or documents. Even in the cloud, only `boxglow.json` (plan, status, references) is stored.

## Status

Decided 2026-10-03: the free scope above is fixed. The paid features are still being designed (what exactly each one does and what is missing is being worked out), and nothing is sold yet.

If you want to be told when Boxglow Cloud opens, leave your email here: https://boxglow.pages.dev/waitlist/ (one message when it opens, nothing else). Questions and wishes are welcome as GitHub issues too.

---

# 無料と有料の線引き

Boxglow はオープンコアです。手元の計画ファイルで完結する機能は MIT で無料のまま (チームでそのファイルを Git で共有する使い方も含みます)。こちらで運営するサービスや、外部サービスとの連携が要る機能が有料版 (Boxglow Cloud、準備中) です。

原則: **手元のファイル・手元のマシン・手元の Git で済むものは無料。こちらで運営するサービス (同期、共有リンク、チームの管理、外部連携、ホスト型のエージェント) が有料。その有料版の機能を自社のサーバで動かす版 (Self-host) も有料です。** MIT で公開しているコアを自分のサーバで使うのは無料のままです。

無料に残す: ブラウザのアプリ (ブラウザ内保存・ローカルファイル)、CLI と setup-agent、1 ファイルの Git 運用とボックス単位のマージ、ファイル内のメンバー、部品・入力グループ・カテゴリ・期日、VS Code 拡張。

有料にする: Sync (同期・履歴)、Share (閲覧専用リンク)、Team (招待・権限・横断)、Connect (Slack / Teams、JIRA / Redmine)、Agent (ホスト型 MCP)、Self-host (自社サーバ版、商用ライセンス)。

約束: MIT で公開した機能を後から有料にはしません。有料版でも預かるのは boxglow.json (計画・状態・参照) だけで、ソースや文書は預かりません。

案内を受け取る: https://boxglow.pages.dev/waitlist/
