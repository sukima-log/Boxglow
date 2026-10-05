<p align="center"><img src="docs/logo/boxglow-wordmark.svg" alt="Boxglow" width="420"></p>

# Boxglow

**Plans and progress as boxes and wires. See at a glance what your AI agents and your team are working on.**
Tasks are boxes with inputs and outputs; a box goes New (BlackBox: dark, output decided but nothing inside yet) → In Progress (GrayBox: hatched) → Done (WhiteBox: paper) as its output gets confirmed. Humans and AI agents (Claude Code, Codex, ...) edit the same `boxglow.json`; the UI shows who is working where, what is waiting for your decision, and what is left. The CLI alone is enough for an agent; the UI is for people.

**計画と進捗を、ボックスと線で。AI エージェントとチームが今どこを作っていて、何が終わり、どこで判断を待っているかが一目でわかる。**

- Web app: https://boxglow.pages.dev/ (no sign-in; data stays in your browser, or opens a local `boxglow.json`)
- CLI for agents: `npx boxglow` (status / start / done / split / ask / answer ...)
- License: MIT

## Agent workflow improvements (Unreleased)

The current development build adds three optional workflow aids. Existing plans still load as schema v5; no strict checks are enabled automatically.

- **Readiness:** CLI resume/status and the UI's Next list separate ready work from input waits and name missing inputs. start warns by default; --reason records why work can start early. done without output artifacts still warns. To opt in per plan, use policy --start reject --done reject (or choose Agent workflow checks in project settings). Human actions are never rejected. A start reason is allowed even in strict mode.
- **Scope:** scope B12 --goal "Goal" --non-goals "Excluded" --acceptance "Checks" --consult "When to ask" records four optional fields. Read them at the start of context, or expand Current scope in the inspector. Edit through ⋯ → Edit work scope. focus B12 prioritizes that box and its descendants; focus none clears it. Read-only scope/focus/policy commands take no changing options.
- **Resume:** current state comes first. Completed handoff notes show only a count unless --include-completed is requested. Descriptions and notes show when they were written and whether they predate the status change; legacy dates stay unknown. Done can suggest reviewing an outdated description, but never rewrites it.

With guard enabled, scope/focus/policy writes require the latest --context-token and return a new token when the context changes. MCP has matching scope/focus/policy tools, start.reason and resume.includeCompleted. Strict completion accepts existing output artifacts or new --artifact values; reference material on the box does not count. Textual acceptance criteria remain a checklist for the agent/person, not an automatic test runner.

**Compatibility:** workflowPolicy, focusBlockId, block.scope, descriptionUpdatedAt and statusChangedAt are optional. Old versions (0.4.2 and earlier) can read the plan but do not apply the new behavior; saving with them drops the new plan-level policy/focus fields. Use a supporting build for every writer, including running serve and the extension's bundled app. No release/version bump is included in this development change.

### 日本語: 着手確認・今回の範囲・再開情報

開発中の変更です。旧計画は形式 v5 のまま読め、厳格な確認は自動で有効になりません。

- resume / status --brief / 画面の Next で、着手できる候補と入力待ちを分け、不足する入力名を表示します。start は既定で警告しつつ開始、--reason 付きなら理由を活動とログに残して警告なしで開始します。成果物なしの done も既定は警告です。
- 計画ごとに policy --start reject --done reject を選ぶと拒否にできます。画面ではプロジェクト名 →「AI の作業確認」。人の操作は拒否せず、理由付きの開始は厳格設定でも可能です。各設定は warn で戻せます。
- scope B12 --goal "達成すること" --non-goals "今回扱わないこと" --acceptance "完了条件" --consult "相談条件" で任意の4項目を記録します。context の先頭と詳細パネルから読め、画面の ⋯ →「作業範囲を編集」で編集できます。空欄は普段の画面に出しません。none または空文字で項目を消せます。
- focus B12 は対象と配下を優先し、対象外は別の組に残します。focus none で解除できます。guard 有効時の scope/focus/policy 変更には最新の --context-token を付け、出力の新しいトークンを次に使います。
- resume は現況を先に表示し、完了した引き継ぎは件数だけ出します。--include-completed または画面の展開ボタンで履歴を読めます。説明・引き継ぎの日時と状態変更との前後関係を示し、古い記録の日時は推測しません。
- Done 後に説明の古い状況が残る可能性があるときは見直しを促します。本文は自動変更しません。完了条件の達成や成果物の品質を自動で証明するものではありません。
- **旧版との併用:** 0.4.2以前は新しい制御を行わず、保存すると計画の確認設定・優先対象を落とします。新機能を使う計画の書き手は対応ビルドに揃えてください。今回は版番号変更・公開を含みません。

## Quick start with an AI agent

```bash
cd your-repo
npx boxglow init --name "My project" --lang en
npx boxglow add "Decide requirements" --out "Requirements list"
npx boxglow add "Build it" --out "Working app"
npx boxglow connect "Decide requirements.Requirements list" "Build it"   # the input is created with the output's name
npx boxglow connect "Build it.Working app" "project.Final deliverable"
npx boxglow status
npx boxglow start "Build it" --note "scaffolding"
npx boxglow ask "Build it" "Which framework?" --options "React|Svelte"     # a human (or the agent itself) answers later
npx boxglow answer "Build it" "React" --by human
npx boxglow done "Build it" --artifact "app=src/App.tsx"                    # deliverables are commit+path+blob, never uploaded
```

Recommended flow for a new project: the agent reads the brief (README, request) and creates 3-7 top-level boxes with concrete outputs, asks the human to confirm the split (`ask`), and only then decomposes the box it starts (`split`). Decisions keep the candidates that were not chosen; `reopen` lets you change course later without losing the history.

Then run `npx boxglow setup-agent` once. It installs agent instructions and skills and enables the context guard described below. Claude Code also receives a SessionStart hook and `.mcp.json`; Codex MCP registration is separate. Open `npx boxglow serve --open` or the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=sukima.boxglow-vscode) to edit the same repository file as the agent.

### Remember decisions across sessions

Boxglow keeps task instructions, decisions (including acknowledged answers), input/output contracts and handoff notes in the plan. `context` retrieves the task, its parents and upstream dependencies. `checkpoint` keeps findings, next steps and unresolved questions outside the bounded activity log.

```bash
npx boxglow context B12
# Read the returned context. Copy contextToken from that response.
npx boxglow start B12 --context-token <token> --note "Implement the agreed design"
npx boxglow checkpoint B12 --context-token <token> --note "Verified inputs; next: implement retries; open question: timeout"
# In the next session (or after any instruction/answer/handoff change):
npx boxglow context B12
npx boxglow done B12 --context-token <new-token> --artifact "implementation=src/retry.ts"
```

`setup-agent` enables this guard on the existing plan; `boxglow guard on` also enables it without installing agent settings. With the guard enabled, `start`, `done`, `set`, `split`, `artifact`, `ack`, `blocked`, `review`, `leave` and `checkpoint` by an agent need the current context token (`--context-token`); a missing or outdated token is rejected. People are never asked for a token (`--actor human`). After the agent's own change (`ask`, `artifact`, `checkpoint`, ...) the CLI prints the new token, so it can continue without reading again; after a person answers or edits an answer, changes the instructions, or another agent leaves a handoff, the agent has to read the context again. Read the changed context and reconcile it before retrying. A checkpoint changes the context, so reread afterward. The receipt excludes acknowledgement flags and activity timestamps; starting work does not invalidate it. Existing plans stay compatible until setup or explicit activation. `guard off` is an explicit configuration choice, not a recovery step for a rejected receipt.

MCP provides `boxglow_context`, `boxglow_checkpoint`, and `contextToken` on guarded dedicated tools; `boxglow_run` accepts the CLI arguments for the remaining commands. The task inspector's **Agent handoff** section can edit the note and copy its context. Revising a human answer clears the old acknowledgement. These mechanisms prevent losing recorded context and reject Boxglow work transitions based on stale instructions; they do not control an agent's actions outside Boxglow.

`boxglow resume` (`--json` for structured output; MCP: `boxglow_resume`) lists answers the agent has not acknowledged yet, saved handoff notes and next candidates in one place; in the UI the same overview is the **Resume** tab of the activity panel, and a task's detail shows questions that need an answer first. Reading the overview does not acknowledge answers: before working, still read `boxglow context <block>` and use its token. Earlier agent log entries alone no longer count as an acknowledgement, so older answers without an explicit acknowledgement may show up as unread again.


| Command | What it does |
|---|---|
| `setup-agent [--agent codex\|claude-code\|all]` | Install only the selected agent’s instructions and skill (default: `all`). Claude Code also gets a SessionStart hook and `.mcp.json`. Existing unrelated settings are preserved; malformed settings stop setup. |
| `mcp [--file path]` | MCP server over stdio: every command above as a tool (`boxglow_status`, `boxglow_add`, `boxglow_split`, `boxglow_start`, `boxglow_done`, `boxglow_ask`, `boxglow_answer`, ... and `boxglow_run` for the rest) |
| `serve [--port 4174] [--open]` | Local server: the bundled web app at `http://localhost:4174/?serve=1` reading and writing your `boxglow.json` through a small API, with live reload when the CLI or an agent changes the file. Works in any browser (Firefox, Safari) |
| `context <block>` / `checkpoint <block> --note ... --context-token ...` | Read persistent context with a receipt / record a durable handoff |
| `guard on\|off` | Enable or disable context checks (setup-agent enables them) |
| `resume [--json]` | Handoff notes, answers not yet acknowledged and next actions in one overview (read-only) |
| `status [--brief]` | Markdown summary (`--brief` omits the full tree): pending decisions, who is working where, tree with ids, next candidates |
| `start <block> --note` / `done <block> --artifact name=url` | Record work in progress / completion with deliverables |
| `split <block> --spec '<json>'` | Decompose a box into child boxes with named inputs / outputs and connections |
| `ask <block> "question" --options "A\|B"` / `answer <block> "A"` | Ask a human for a decision / answer it |
| `project <name>` | Add another project box to the same file (the top level holds only the input node, the output node and project boxes) |
| `export-block <block>` / `import-block <file> --parent <block>` | Reuse a box (with its sub-boxes, ports and wiring) across projects as a `*.boxglow-block.json` template |
| `reopen <block> --note "why"` | Reopen an answered decision: the old answer goes to its history, the candidates stay |
| `tidy` | Re-save the file by the rules: connected inputs take their source's name, major boxes collapsed, overlaps resolved (fixes files written before these rules) |
| `port <block|project> --in/--out/--rename` / `disconnect` / `move <block> --parent <block>` / `remove <block> [--force]` | Edit ports, remove a wire, move a box to another parent (wires are re-routed through the boxes in between), delete a box (and its children with `--force`) |
| `set <block> --status/--progress/--category/--due/--issue <url>/--repo` | Status, progress, category, schedule, JIRA / Redmine / GitHub issue link, repository |
| `export --out docs/ROADMAP.md` / `export --format json` | Write the whole plan as Markdown (or JSON) |
| `check` / `artifact` | Re-find deliverables after renames; attach a deliverable without finishing |
| `merge <base> <ours> <theirs>` / `git-setup` | Box-level 3-way merge for Git (see below) |
| `blocked`, `review`, `leave`, `show`, `log`, `layout`, `validate`, `prompt`, `group*` | See `npx boxglow help` |

### Codex setup

```bash
npx boxglow setup-agent --agent codex
npx boxglow status --brief
```

This installs `AGENTS.md` and `.agents/skills/boxglow/SKILL.md`; it does not create Claude Code settings. `--agent claude-code` installs only Claude Code files; omit `--agent` to install both. The CLI is sufficient for either agent. `status --brief` keeps decisions, unacknowledged answers, activity and next candidates while omitting the complete tree; `status --json` still returns the full project.

For Codex MCP tools, register the server separately with an absolute path to your plan (run this in the same environment as Codex):

```bash
codex mcp add boxglow -- npx -y boxglow mcp --file /absolute/path/to/boxglow.json --actor codex
```

Use `codex mcp list` to verify the registration. `.mcp.json` in a repository is the Claude Code setup; it is not the Codex MCP registration. MCP `boxglow_status` accepts `brief: true`, and validation failures are returned with `isError: true` so the agent can act on them.

See the official [Codex skills locations](https://learn.chatgpt.com/docs/build-skills) and [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Any browser: `npx boxglow serve`

The web app opens a local `boxglow.json` directly only in Chrome / Edge (File System Access API), and those browsers refuse some locations: a file inside WSL (`\\wsl.localhost\...`) is rejected with a "contains system files" message. Use `serve` (or the VS Code extension) for those. `npx boxglow serve` runs a small local server (127.0.0.1 only) that serves the bundled app and exposes the file as `GET/PUT /api/project` plus an SSE `/api/events` stream, so the page updates a moment after the CLI or an agent writes the file, and edits in the page are written back. Open `http://localhost:4174/?serve=1` (`--open` opens it for you).

### Save conflicts and recovery

CLI, local server and VS Code writers share a file lock (a `<file>.boxglow-lock` folder that records its owner: pid, host, OS, process-ID space and process start). Writers wait a few seconds for each other and concurrent CLI commands reload and retry. A lock is recovered automatically only when its owner is confirmed gone: same host, same OS, same process-ID space, and the pid no longer exists or now belongs to a different process. The process-ID space can be verified on Linux (including WSL); on Windows and macOS a leftover lock is never taken automatically and is removed with `boxglow unlock`. CLI/server saves compare the read revision and replace the file atomically; a stale writer must reread instead of replacing newer changes. The local API requires `If-Match` from the GET response's ETag, same-origin requests, an allowed loopback Host, JSON content type, valid schema/references and a body of at most 5 MiB.

The view follows the file automatically; the reload button next to the save state rereads it immediately when you do not want to wait. The GUI retains unsaved edits when a save fails or another writer changes the file. Its persistent notice offers retry, JSON export and an explicit three-way merge. Changes to different fields are both kept; for a field changed on both sides, **Compare and choose** shows the two values side by side and you pick one (the choice and both values are recorded in the activity log). Export unsaved JSON for a separate backup. VS Code shows Saved only after `applyEdit`, `document.save()` and disk-content confirmation succeed. A 10-second acknowledgement timeout remains Unsaved and permits retry.

Direct File System Access opening is **read-only**, with live updates. Use `serve` or VS Code for shared editing; browser file handles cannot participate in the Node writer lock. Import JSON still creates a separate browser copy. All editors writing a shared file must use compatible Boxglow versions; unrelated programs and older versions do not honor the cooperative lock. **Versions and connection** at the bottom right of the UI shows the versions of the GUI, the connected CLI server and the VS Code extension; for the CLI alone use `boxglow --version` (`boxglow version --json` for details). A live writer's lock is never taken away just because a save takes a long time, and a lock whose owner cannot be verified is never taken automatically either: another host, another OS on the same machine name (Windows and WSL have separate process IDs), another container, Windows or macOS (no verifiable process-ID space), a lock written by 0.4.0 or older, a missing, unreadable or malformed owner record, or an interrupted recovery. In those cases commands stop with a message that names the owner and the verdict.

```bash
npx boxglow unlock                                             # show the lock: owner, verdict, token (read-only)
npx boxglow unlock --remove --lock-token <token> --actor human # a person removes it
```

Before removing, stop every Boxglow that has the plan open (CLI, `serve`, VS Code; on every OS and machine involved). `unlock --remove` refuses when the owner is confirmed running, when another writer is confirmed to be in the middle of recovering it, or when the lock changed after it was shown. Release, automatic recovery and manual removal all take the same exclusive marker inside the lock before moving it and re-check which lock they hold it on, so a lock that a newer writer has taken in the meantime is not moved. A marker is published together with its owner record (never as an empty placeholder). Markers left by an interrupted recovery can only be taken over by `unlock --remove`, by adding a higher-numbered marker (existing markers are never renamed or deleted), and only when none of the existing markers belongs to a writer confirmed running. When that owner cannot be verified from here (another OS or machine, Windows, macOS), the takeover relies on you having stopped it: do not run two removals of the same lock from different environments at the same time. Agents may run `unlock` to read the status but ask a person to remove the lock.

**Upgrading from 0.4.0**: update the CLI, `serve` and the VS Code extension together and restart any that are still running. 0.4.0 takes over locks by elapsed time and does not read the new owner fields, so mixing 0.4.0 and 0.4.1 writers on one plan is not safe.

**VS Code on Windows with a plan inside WSL**: open the folder in a WSL window (Remote - WSL), where the extension runs inside WSL. A Windows window that opens `\\wsl.localhost\...` shows the plan read-only unless `security.allowedUNCHosts` contains `wsl.localhost`, because VS Code blocks extensions from that location; with the host allowed, saving works and locks taken on the other side are respected (never taken over, since Windows and WSL cannot check each other's processes).

## MCP server

`npx boxglow mcp` is a stdio MCP server exposing the CLI as tools (`boxglow_status`, `boxglow_show`, `boxglow_add`, `boxglow_split`, `boxglow_connect`, `boxglow_start`, `boxglow_done`, `boxglow_blocked`, `boxglow_ask`, `boxglow_answer`, `boxglow_set`, `boxglow_export`, `boxglow_validate`, `boxglow_run`, ...). `setup-agent` writes the registration into `.mcp.json`:

```json
{ "mcpServers": { "boxglow": { "command": "npx", "args": ["-y", "boxglow", "mcp"] } } }
```

The server finds `boxglow.json` like the CLI does (current directory upwards, or `--file` / `BOXGLOW_FILE`). The CLI and the MCP tools write the same file, so either can be used.

## VS Code extension

Install **Boxglow** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=sukima.boxglow-vscode): search for "Boxglow" in the Extensions view, or run `code --install-extension sukima.boxglow-vscode`. Keep the extension and the CLI on matching releases (extension 0.4.1 goes with boxglow 0.5.1).

`vscode/` holds the extension's source. It opens `boxglow.json` as the same diagram inside the editor (custom editor "Boxglow"; right-click the file or use the editor title button / command *Boxglow: Open boxglow.json as a diagram*). The diagram follows the file when the CLI or an agent writes it, edits in the diagram are written back, and light / dark follow the VS Code theme. To build it yourself: `npm run build:vscode` (bundles the web app into `vscode/media/`), then `cd vscode && npm run package` (`.vsix`, install via *Extensions: Install from VSIX...*).

## Several repositories, one plan

A `boxglow.json` can hold several project boxes (the top level only has Inputs, Outputs and project boxes). Add one with `New Project` in the ⋯ menu of the top bar or `npx boxglow project "Name" --repo ../path`, and set each box's Repository in the inspector. For a multi-repo workspace, keep the file in the parent folder and point every repository's agent at it:

```
workspace/
  boxglow.json        <- one plan, one project box per repository
  app-frontend/       <- BOXGLOW_FILE=../boxglow.json (set it in the agent's instructions or .env)
  app-backend/
```

Moving a box between levels keeps its wires: connections are re-routed through the ports of the boxes in between.

`boxglow.json` is made for Git: 2-space JSON, one field per line, boxes keyed by id, so a change shows up as a few lines plus one appended log entry. Opening the file (browser, CLI `status`/`show`, future editors) never writes it; only edits do. There is no `updatedAt`/`version` churn since schema 5 (the commit is the version). Collapsing boxes in View mode is screen-only; in Edit mode it is saved as shared layout.

## Working as a team on one `boxglow.json`

Line-based Git merges would conflict whenever two people touch the plan at the same time. Boxglow ships a merge driver that merges at the box / port / wire level instead, so edits to different boxes never conflict:

```bash
npx boxglow git-setup   # once per clone: writes .gitattributes and git config merge.boxglow.driver
```

After that, `git merge` / `pull` / `rebase` combine both sides automatically. If two people changed the same field of the same box, your value is kept and the other value is recorded in the log so nothing is lost. Short IDs (B12) that collide are renumbered.

## Deliverables stay in Git (nothing is uploaded)

Boxglow never uploads your files. A deliverable is a **reference**: a URL, or for files in a Git repository, `commit + path + blob hash` recorded by the CLI (`boxglow done ... --artifact path`, `boxglow artifact <block> path`). Only files whose content matches HEAD receive a pinned Git reference. Modified, untracked or not-yet-committed files remain local file references, so they do not link to an older or nonexistent version. A pinned reference can be retrieved with `git show <commit>:<path>`, and `boxglow check` follows renames (same blob in HEAD, or `git log --follow`) to update the current path; files that cannot be found are flagged. If the remote is GitHub / GitLab style, a commit-pinned web link is generated too. Only `boxglow.json` (plan, status, references) is shared, which keeps the tool usable where source and documents must not leave the company.

## Concepts

| State | Meaning | Look |
|---|---|---|
| New (BlackBox) | Output decided, nothing inside yet | Dark fill, dashed border, ○ icon |
| In Progress (GrayBox) | Being decomposed or worked on | Hatched fill, ◐ icon, progress bar |
| Done (WhiteBox) | Output confirmed with a deliverable | Paper fill, ● with a check |

Expanded boxes (containers) are drawn as frames: the shallower the level, the thicker the border, and the fill alternates per level so nesting is visible. Wires are thin and use colors never used for borders (thick green = the source already has a deliverable, thin amber = not yet). Selecting a wire highlights the whole signal in orange, through parent ports, from the original output to the final input.

- Every box has at least one output. Inputs can be added later.
- The top level holds only the project's input node, its output node and one or more **project boxes**; tasks live inside a project box.
- Boxes nest without limit: decompose a big box into child boxes, and those again. Collapse / expand.
- **Reuse**: save any box as a template (structure, ports, descriptions, wiring; not status or artifacts) and insert it into another project, from the in-app library or as a `*.boxglow-block.json` file in your repo. Inserted boxes remember their template name and version.
- An input with no source is automatically promoted to the project's input (dashed line) until someone connects it.
- Activity badges: CC (Claude Code) / CX (Codex) / human, states working / blocked / needs decision / waiting review. Decisions are answered in the UI and read back by the agent.
- Ready inputs: a wire whose source already has a deliverable (or is done) is drawn thick and green, and the input name gets a dot, so you can see at a glance which inputs are available.
- Me / unassigned: pick yourself in the drawer; your boxes get a teal stripe. Owners are not printed on boxes (open the box to see them); filter by owner or "unassigned" in the drawer.
- Decisions: `ask` records a question with candidates; the answer is kept together with the candidates that were not chosen, and `reopen` moves an answer to the history so you can change course later.
- Issue link: a box can carry a JIRA / Redmine / GitHub issue URL (`--issue`, or the More tab); the key (PROJ-123, #45) is shown on the box and opens the issue.
- Input groups: project inputs can be grouped (e.g. "PCIe specs", "DDR specs"); each group is its own input node, and a group can be exported / imported as `*.boxglow-inputs.json` to reuse in another project (`boxglow group`, `group-set`, `group-export`, `group-import`).
- Boxes never overlap: siblings are pushed apart automatically after moves, resizes and additions.
- Edit / View: a top-bar toggle; in View mode drag-and-drop editing and the Delete key are off.
- Short IDs: every box gets `B1`, `B2`, ... shown on the box; search by ID or title from the top bar (`/`), and use the ID in the CLI.
- Schedule: start date, due date, estimate and actual hours per box; overdue boxes are flagged.
- One source of truth: an input's description is the description of the output it is connected to (edit it there); only unconnected inputs carry their own text.
- Progress: set a percentage per box (slider in the inspector or `boxglow set <block> --progress 60`); parents average their children, WhiteBox counts as 100.
- Required inputs: every input is required by default; mark one as optional (任意) in the I/O tab if the box can start without it. A New box whose required inputs are all ready shows a `Ready` chip, and `boxglow status` lists such boxes first under next candidates.
- Category: tag a box with what kind of work it is (study, research, design, ui, build, verify, evaluate, improve, fix, docs, ops, other). It shows as a colored stripe and a short label on the box, and the drawer's Filter can narrow by it. `boxglow add "..." --category design` / `boxglow set <block> --category verify|none`.
- Saving: the top bar always shows Saved / Unsaved / Saving and a Save button. A local file opened directly in the browser is a read-only live view; edit it through `npx boxglow serve` or the VS Code extension.
- `boxglow validate` reports broken wiring as errors and "holes in the plan" (unconnected ports, Done boxes without deliverables) as warnings; `done` without `--artifact` warns.

When a person answers a question an agent asked (`ask`), the answer stays listed as "Answered" (and editable) until an agent picks it up with `npx boxglow ack <block>` or by recording work on that box (`start`, `done`, `set`, ...). `status` lists such answers under "回答あり" so an agent never misses them.

## Example plan

[examples/logic-daw/boxglow.json](examples/logic-daw/boxglow.json) is a mid-size plan for a browser DAW that borrows ideas from hardware logic design: a reference clock, dividers, counters and gates decide when sounds trigger. Open it in the web app (Home → "Start with your own plan" → "View a file", read-only) or run `BOXGLOW_FILE=examples/logic-daw/boxglow.json npx boxglow status` to see decisions, who is working where, and the next candidates.

Boxglow's own development is managed with Boxglow too (that plan stays local); what we learned by using it with Claude Code is in [docs/dogfooding.md](docs/dogfooding.md), and the working agreement for agents is in [CLAUDE.md](CLAUDE.md).

An English example lives in `examples/notes-app/boxglow.json` (a small notes app: 4 major boxes, 16 tasks, one in progress and one waiting for a decision). Open it from the web app's Home, or with the VS Code extension.

## Free and paid

Boxglow is open core: everything that works with the one file on your machine (web app, CLI, Git workflow, members, parts, categories, dates, the VS Code extension) is MIT and stays free. Cloud sync, share links, team workspaces, Slack / JIRA connectors, a hosted MCP endpoint and a self-hosted edition are the paid product in preparation. The exact line is written down in [docs/MONETIZATION.md](docs/MONETIZATION.md); features already released under MIT will not move behind a paywall, and the paid product never stores your source or documents. To hear when it opens: https://boxglow.pages.dev/waitlist/

## Development

```bash
npm install
npm run dev        # http://localhost:5173/apps/boxglow/
npm test           # Vitest (graph rules, merge, routing helpers)
npm run build      # web app -> dist/, CLI -> bin/boxglow.js
node bin/boxglow.js help
```

Schema: `schemaVersion` 5. Older files (1-4) load and are upgraded on the first edit.

The CLI speaks the plan's language: `npx boxglow init --lang en` (or `ja`; the default follows your environment) stores it in `boxglow.json`, and messages, log lines, `status` and the agent instructions written by `setup-agent` follow it. Change it with `npx boxglow lang en`.

URL parameters: `?demo=1` (sample), `&readonly=1`, `&embed=1`, `&theme=dark|light`, `&lang=en|ja` (UI language; otherwise the browser language, remembered once switched from the ⋯ menu), `?view=article` (= demo + embed + readonly), `#p=<id>`.

The web app is hosted on Cloudflare Pages (`npm run deploy:pages` builds with `VITE_BASE=/` into `dist-pages/` and uploads it). Any static host works: `vite build` with `VITE_BASE` set to the path you serve from (the default `/apps/boxglow/` is the author's blog mirror).

Browser checks live in `e2e/` (`npm run e2e`): wires never crossing boxes on every tab of the example plans (also with squeezed positions), tab switching time, double-click / selection / decision flows, the English UI and the VS Code webview mode. They need Playwright from outside this repository (`PLAYWRIGHT=<path>`; see `e2e/run.sh`) and are not part of CI; the unit and property tests (`npm test`) are.

## Layout

| Path | Role |
|---|---|
| `src/model/types.ts` | Data model (Project / Block / Port / Edge / Artifact / Activity / Decision / LogEvent) |
| `src/model/graph.ts` | Pure operations: connection rules, cycle check, auto-promotion of floating inputs, progress, activity, split |
| `src/model/report.ts` | Markdown reports shared by the CLI and the UI timeline |
| `src/model/export.ts` | Markdown prompts for AI, Mermaid |
| `src/model/merge.ts` | Box-level 3-way merge (Git merge driver) |
| `src/model/categories.ts`, `src/model/status.ts` | Category palette, status labels |
| `src/model/autolayout.ts`, `src/canvas/routeEdge.ts`, `src/canvas/routeAll.ts` | Layered layout; obstacle-avoiding wire routing and wire separation |
| `cli/main.ts` | CLI (`bin/boxglow.js`) |
| `src/canvas/` | React Flow canvas, block / terminal nodes, layout |
| `src/panels/` | Top bar, drawer (tree / filter / members), inspector (block / edge / terminal / project / timeline), home |
| `src/lib/localfile.ts` | Local file mode (File System Access API: read-only live view) |
| `docs/` | Plans, the agent instruction snippet, ROADMAP.md (exported plan), dogfooding.md (findings), logo/ |
