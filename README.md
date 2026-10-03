<p align="center"><img src="docs/logo/boxglow-wordmark.svg" alt="Boxglow" width="420"></p>

# Boxglow

**Plans and progress as boxes and wires. See at a glance what your AI agents and your team are working on.**
Tasks are boxes with inputs and outputs; a box goes New (BlackBox: dark, output decided but nothing inside yet) → In Progress (GrayBox: hatched) → Done (WhiteBox: paper) as its output gets confirmed. Humans and AI agents (Claude Code, Codex, ...) edit the same `boxglow.json`; the UI shows who is working where, what is waiting for your decision, and what is left. The CLI alone is enough for an agent; the UI is for people.

**計画と進捗を、箱と線で。AI エージェントとチームが今どこを作っていて、何が終わり、どこで判断を待っているかが一目でわかる。**

- Web app: https://boxglow.pages.dev/ (no sign-in; data stays in your browser, or opens a local `boxglow.json`)
- CLI for agents: `npx boxglow` (status / start / done / split / ask / answer ...)
- License: MIT

## Quick start with an AI agent

```bash
cd your-repo
npx boxglow init --name "My project"
npx boxglow add "Decide requirements" --out "Requirements list"
npx boxglow add "Build it" --out "Working app"
npx boxglow connect "Decide requirements.Requirements list" "Build it"   # the input is created with the output's name
npx boxglow connect "Build it.Working app" "project.最終成果物"
npx boxglow status
npx boxglow start "Build it" --note "scaffolding"
npx boxglow ask "Build it" "Which framework?" --options "React|Svelte"     # a human (or the agent itself) answers later
npx boxglow answer "Build it" "React" --by human
npx boxglow done "Build it" --artifact "app=src/App.tsx"                    # deliverables are commit+path+blob, never uploaded
```

Recommended flow for a new project: the agent reads the brief (README, request) and creates 3-7 top-level boxes with concrete outputs, asks the human to confirm the split (`ask`), and only then decomposes the box it starts (`split`). Decisions keep the candidates that were not chosen; `reopen` lets you change course later without losing the history.

Then run `npx boxglow setup-agent` once: it appends the working agreement ([docs/AGENTS_SNIPPET.md](docs/AGENTS_SNIPPET.md)) to your `AGENTS.md` / `CLAUDE.md`, installs a Claude Code skill (`.claude/skills/boxglow`), a SessionStart hook that runs `npx boxglow status`, and registers the MCP server in `.mcp.json` (`npx boxglow mcp`), so the agent reads the plan at the start of every session and can call `boxglow_status` / `boxglow_start` / `boxglow_done` / `boxglow_ask` ... as tools. Open `boxglow.json` in the web app (Chrome / Edge: "boxglow.json を開く"): the agent creates and decomposes boxes, records `start` / `done` / `ask` by itself, and the boxes change in front of you.

| Command | What it does |
|---|---|
| `setup-agent` | One-time setup for AI agents: AGENTS.md / CLAUDE.md snippet, Claude Code skill, SessionStart hook, `.mcp.json` |
| `mcp [--file path]` | MCP server over stdio: every command above as a tool (`boxglow_status`, `boxglow_add`, `boxglow_split`, `boxglow_start`, `boxglow_done`, `boxglow_ask`, `boxglow_answer`, ... and `boxglow_run` for the rest) |
| `serve [--port 4174] [--open]` | Local server: the bundled web app at `http://localhost:4174/?serve=1` reading and writing your `boxglow.json` through a small API, with live reload when the CLI or an agent changes the file. Works in any browser (Firefox, Safari) |
| `status` | Markdown summary: pending decisions, who is working where, tree with ids, next candidates |
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

## Any browser: `npx boxglow serve`

The web app opens a local `boxglow.json` directly only in Chrome / Edge (File System Access API), and those browsers refuse some locations: a file inside WSL (`\\wsl.localhost\...`) is rejected with a "contains system files" message. Use `serve` (or the VS Code extension) for those. `npx boxglow serve` runs a small local server (127.0.0.1 only) that serves the bundled app and exposes the file as `GET/PUT /api/project` plus an SSE `/api/events` stream, so the page updates a moment after the CLI or an agent writes the file, and edits in the page are written back. Open `http://localhost:4174/?serve=1` (`--open` opens it for you).

## MCP server

`npx boxglow mcp` is a stdio MCP server exposing the CLI as tools (`boxglow_status`, `boxglow_show`, `boxglow_add`, `boxglow_split`, `boxglow_connect`, `boxglow_start`, `boxglow_done`, `boxglow_blocked`, `boxglow_ask`, `boxglow_answer`, `boxglow_set`, `boxglow_export`, `boxglow_validate`, `boxglow_run`, ...). `setup-agent` writes the registration into `.mcp.json`:

```json
{ "mcpServers": { "boxglow": { "command": "npx", "args": ["boxglow", "mcp"] } } }
```

The server finds `boxglow.json` like the CLI does (current directory upwards, or `--file` / `BOXGLOW_FILE`). The CLI and the MCP tools write the same file, so either can be used.

## VS Code extension

`vscode/` holds a VS Code extension that opens `boxglow.json` as the same diagram inside the editor (custom editor "Boxglow"; right-click the file or use the editor title button / command *Boxglow: Open boxglow.json as a diagram*). The diagram follows the file when the CLI or an agent writes it, edits in the diagram are written back, and light / dark follow the VS Code theme. Build it with `npm run build:vscode` (bundles the web app into `vscode/media/`) and package with `cd vscode && npm run package` (`.vsix`, install via *Extensions: Install from VSIX...*).

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

Boxglow never uploads your files. A deliverable is a **reference**: a URL, or for files in a Git repository, `commit + path + blob hash` recorded by the CLI (`boxglow done ... --artifact path`, `boxglow artifact <block> path`). Because the reference is pinned to a commit it can always be retrieved with `git show <commit>:<path>`, and `boxglow check` follows renames (same blob in HEAD, or `git log --follow`) to update the current path; files that cannot be found are flagged. If the remote is GitHub / GitLab style, a commit-pinned web link is generated too. Only `boxglow.json` (plan, status, references) is shared, which keeps the tool usable where source and documents must not leave the company.

## Concepts

| State | Meaning | Look |
|---|---|---|
| New (BlackBox) | Output decided, nothing inside yet | Dark fill, dashed border, ○ icon |
| In Progress (GrayBox) | Being decomposed or worked on | Hatched fill, ◐ icon, progress bar |
| Done (WhiteBox) | Output confirmed with a deliverable | Paper fill, ● with a check |

Expanded boxes (containers) are drawn as frames: the shallower the level, the thicker the border, and the fill alternates per level so nesting is visible. Wires are thin and use colors never used for borders (teal = the source already has a deliverable, light gray = not yet). Selecting a wire highlights the whole signal in orange, through parent ports, from the original output to the final input.

- Every box has at least one output. Inputs can be added later.
- The top level holds only the project's input node, its output node and one or more **project boxes**; tasks live inside a project box.
- Boxes nest without limit: decompose a big box into child boxes, and those again. Collapse / expand.
- **Reuse**: save any box as a template (structure, ports, descriptions, wiring; not status or artifacts) and insert it into another project, from the in-app library or as a `*.boxglow-block.json` file in your repo. Inserted boxes remember their template name and version.
- An input with no source is automatically promoted to the project's input (dashed line) until someone connects it.
- Activity badges: CC (Claude Code) / CX (Codex) / human, states working / blocked / needs decision / waiting review. Decisions are answered in the UI and read back by the agent.
- Ready inputs: a wire whose source already has a deliverable (or is done) is drawn thick and teal, and the input name gets a dot, so you can see at a glance which inputs are available.
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
- Saving: the top bar always shows Saved / Unsaved / Saving and a Save button. Opening a local file asks for read access only; write access is requested on the first edit.
- `boxglow validate` reports broken wiring as errors and "holes in the plan" (unconnected ports, Done boxes without deliverables) as warnings; `done` without `--artifact` warns.

When a person answers a question an agent asked (`ask`), the answer stays listed as "Answered" (and editable) until an agent picks it up with `npx boxglow ack <block>` or by recording work on that box (`start`, `done`, `set`, ...). `status` lists such answers under "回答あり" so an agent never misses them.

## Example plan

[examples/logic-daw/boxglow.json](examples/logic-daw/boxglow.json) is a mid-size plan for a browser DAW that borrows ideas from hardware logic design: a reference clock, dividers, counters and gates decide when sounds trigger. Open it in the web app (Home → "boxglow.json を開く") or run `BOXGLOW_FILE=examples/logic-daw/boxglow.json npx boxglow status` to see decisions, who is working where, and the next candidates.

Boxglow's own development is managed with Boxglow too (that plan stays local); what we learned by using it with Claude Code is in [docs/dogfooding.md](docs/dogfooding.md), and the working agreement for agents is in [CLAUDE.md](CLAUDE.md).

An English example lives in `examples/notes-app/boxglow.json` (a small notes app: 4 major boxes, 16 tasks, one in progress and one waiting for a decision). Open it from the web app's Home, or with the VS Code extension.

## Free and paid

Boxglow is open core: everything that works with the one file on your machine (web app, CLI, Git workflow, members, parts, categories, dates, the planned VS Code extension) is MIT and stays free. Cloud sync, share links, team workspaces, Slack / JIRA connectors, a hosted MCP endpoint and a self-hosted edition are the paid product in preparation. The exact line is written down in [docs/MONETIZATION.md](docs/MONETIZATION.md); features already released under MIT will not move behind a paywall, and the paid product never stores your source or documents. To hear when it opens: https://boxglow.pages.dev/waitlist/

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
| `src/lib/localfile.ts` | Local file mode (File System Access API: watch + write back) |
| `docs/` | Plans, the agent instruction snippet, ROADMAP.md (exported plan), dogfooding.md (findings), logo/ |
