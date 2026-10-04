# Changelog

## 0.4.0 (2026-10-04)

Reviewed and extended together with Codex; "箱" is now "ボックス" throughout the Japanese UI, CLI and instructions.

Remembering decisions across sessions
- `context <box>` returns what an agent must read before working (the task, its parents and upstream boxes, answered decisions, input / output contracts, handoff notes) plus a context token. `checkpoint <box> --note ...` stores findings, next steps and open questions in the plan. `resume` (CLI, MCP `boxglow_resume`, the Resume tab of the Activity panel) lists unread answers, handoff notes and next candidates in one place.
- Context guard (`setup-agent` enables it; `guard on|off`): `start`, `done`, `set`, `split`, `artifact`, `ack`, `blocked`, `review`, `leave` and `checkpoint` by an agent need the current context token (`--context-token`). When a person answers, edits an answer, changes the instructions, or another agent leaves a handoff, the old token is rejected and the agent has to read the context again. People (`--actor human`) are never asked for a token. After an agent's own change the CLI prints the new token, so it can continue without re-reading. Volatile fields (`checkedAt`) are not part of the token.
- Editing an answered decision marks it "not read by the AI" again. Asking another question no longer acknowledges earlier answers.

Saving without losing changes
- CLI, `serve` and the VS Code extension share one lock and compare the revision they read with the file on disk before writing (atomic replace). A stale write is refused instead of silently overwriting. The lock records its owner, stale locks are recovered automatically, and writers wait a few seconds for each other; concurrent CLI commands reload and retry, so six parallel `add` calls all succeed.
- `serve`: `PUT` needs `If-Match` (ETag), validates the plan (schema, references, parent cycles), accepts only local Host / Origin, JSON, 5 MiB. The app shows what failed and keeps your edits; on a conflict it lets you compare both values and choose per item, or export your copy.
- VS Code extension: "Saved" is shown only after the edit was applied, the document saved and the disk content confirmed (also for CRLF files); failures keep your edits with retry / export.
- Opening a file directly in the browser (File System Access) is now view-only, because the browser cannot take part in the lock. Edit through `npx boxglow serve --open` or the VS Code extension. The Home dialog says so.
- 3-way merge: when one side deleted a box and the other changed it, the changed box is kept and the conflict is recorded.

Screen
- Wires from the same output draw their shared run once and mark real branch points with a dot; the selected branch stays continuous from the output. A new tool strip on the canvas (zoom, Fit, jump to selection, and a View drawer with legend, 8 px snapping, "align this level", minimap, help) replaces the default controls. Click-to-connect with Esc to cancel; connecting is disabled in View.
- Top bar shows the open plan and where it is saved; on narrow screens the bar wraps and secondary actions move into the menu. Home: a short welcome with "Try the sample"; your own plans open directly when the browser already has some. The sample is a small web-app plan (the DAW example stays at `?demo=daw`).
- Details panel: questions and unread answers come first; categories are one select box. Activity panel: tabs with counts (Resume / Decisions / Answered / Working / Next / Log), opening on the first that needs you; working rows show the full title and note.
- In a tab the Inputs / Outputs nodes line up with the opened box's port rows (straight wires); parallel Z-shaped wires are ordered by direction. Crossings on the DAW example went from 14 to 0.
- When the browser refuses to open a picked file (for example under `\\wsl.localhost\...`), the Home dialog says so and points to `npx boxglow serve --open`.
- IME confirmation (Enter while converting Japanese) no longer creates a project or submits a search. Version of the app, the connected CLI and the extension is shown in the footer.

CLI
- `setup-agent --agent codex|claude-code|all` (Codex: `AGENTS.md` and `.agents/skills`; Claude Code: `CLAUDE.md`, skill, hook, `.mcp.json`); malformed existing settings stop setup instead of being overwritten.
- `status --brief`, `version`, MCP tools report failed validation as errors and honour `mcp --actor`. Uncommitted files are recorded as local references and upgraded to Git references by `check` once committed.
- Browser checks in `e2e/` grew to 167 (Home, saving and conflicts, canvas, crossings and tab-switch time on the development plan).

## 0.3.0 (2026-10-03)

- English CLI: every plan has a language (`lang` in `boxglow.json`, set by `init` from the environment or `--lang en|ja`; plans made before this stay Japanese). CLI messages, the log lines stored in the plan, `status` / `show` / `export` / `prompt`, the MCP tool descriptions, and the agent instructions and skill written by `setup-agent` all follow it. `npx boxglow lang [ja|en]` shows or changes it; `--lang` / `BOXGLOW_LANG` override per call. About 260 strings and both documents translated; Japanese output is unchanged.
- Fix: `boxglow help` printed only "boxglow" in the bundled CLI (the help text lived in a comment that the bundler dropped). Help is now a string in both languages and mentions `--lang`.
- `examples/notes-app/boxglow.json` is now an English plan end to end (titles, log, language).

- Browser checks moved into the repository: `npm run e2e` (`e2e/`) verifies on the example plans (and with squeezed positions) that no wire crosses a box on any tab, that tab switching stays fast, the double-click / selection / decision flows, the English UI and the VS Code webview mode (37 checks).
- VS Code extension prepared for the Marketplace (publisher `sukima`, version 0.2.0): English listing with screenshots, changelog, gallery banner. English example plan `examples/notes-app/boxglow.json`.
- Answers stay visible until an agent picks them up: after you answer a question it no longer vanishes from the Activity list. It moves to an "Answered" section (and the top bar shows "回答済み N"), marked "not read by the AI yet" and still editable, until an agent acknowledges it with `npx boxglow ack <block>` (or records work on that box: `start`, `done`, `set`, `split`, `ask`, ...). `status` lists them under "回答あり"; MCP tool `boxglow_ack`. Answers an agent records itself are acknowledged immediately.

## 0.2.0 (2026-10-03)

Highlights: tabs per major box with Inputs / Outputs, wires that never cross boxes (verified on random layouts), English UI, MCP server, `boxglow serve`, VS Code extension, Cloudflare Pages hosting, much faster editing and tab switching. Details:

- Wires leaving the same output share one trunk: the vertical run right after the port is drawn once and the wires split off where each turns into its own lane (like a bus in a schematic). Before, eight wires from one output were packed 6 px apart in a narrow channel and looked like a solid band.
- Wires never cross boxes, now verified on random layouts: a property test routes 300 random plans (6-20 boxes, tight 24 px and normal 96 px spacing, up to 24 wires each) and asserts no wire passes through any box. Three causes found and fixed: (1) crossing a box cost the same as leaving the parent box, so a box right at the parent's edge could prefer to cut through its target - box crossing is now 100x heavier and the exit / entry stubs stay inside the parent; (2) the exit / entry stub (40 px) ran into a box sitting right next to the port - it now shortens to the gap; (3) spreading bundled wires could push one wire into its own box - each segment is now clamped to its own free range. When every fixed-shape candidate still crosses something, a grid shortest-path (Dijkstra over box edges with 36 / 12 / 2 px margins) finds a clean route.
- English UI: the web app follows the browser language (English unless it is Japanese), can be switched from the ⋯ menu (English / 日本語, remembered per browser) or forced with `?lang=en|ja`. Plan contents (titles, outputs) are shown as written; only the UI text is translated. The CLI stays Japanese (it talks to AI agents).
- A selected wire stays selected when you switch tabs, so you can follow it across box boundaries: the tabs where the wire (and its continuation) runs are marked with an orange dot in the tab strip, the Wire panel lists them as buttons (upstream to downstream), and the continuation lights up in the tab you open. Selecting a box outside the opened tab still clears as before. Double-clicking the wire's destination box to open its tab also keeps the wire selected (the first click of the double-click no longer loses it).
- Switching tabs is fast again: overlap resolution no longer deep-copies the whole plan for every box (115 copies per switch), box sizes are estimated once per pass, wire candidates are scored once and reused by both routing passes with crossing checks pruned by a lower bound, rectangle tests are precomputed, and port / child lookups use an index while the screen is built. On Boxglow's own plan: small tabs 1.2-2 s to about 0.1 s, the 66-box tab 8.9 s to about 0.45 s, All 7.5 s to about 0.2 s. The fit animation is shorter (150 ms).
- Selecting a box no longer blurs its wires into one band: connected wires get only +1 px of width and no glow, so a bundle of six wires stays six wires. The glow is reserved for a single selected wire.
- Box spacing is now guaranteed on screen, whatever the file says: the shown plan is passed through overlap resolution (96 px between siblings), so plans saved before the spacing change, or positions written by other tools, no longer leave wires with no channel but through a box. The file is untouched until you edit. Chain pushing only moves boxes right / down, fixing a case where a tightly packed column ended up stacked on one spot.
- Wires never run through boxes, even when staggered rows leave less than 72 px between boxes: the router now has fallback channels with a 12 px margin (used only when no normal channel exists), channel spreading keeps wires inside the free range, and sibling boxes are kept 96 px apart (room for two 36 px margins and a wire). Overlap resolution pushes boxes in a chain (each box avoids only the boxes already settled), fixing a ping-pong that left boxes overlapping after a title grew.
- `boxglow tidy` and every save / edit now align connected input names with their source (fixes plans written before the rule; 82 inputs in Boxglow's own plan were out of sync).
- VS Code extension (`vscode/`): opens `boxglow.json` as the Boxglow diagram inside the editor (custom editor + command), follows file changes from the CLI / agents, writes edits back, follows the VS Code theme. Built from the same web app (`npm run build:vscode`, `.vsix` via `cd vscode && npm run package`).
- Fix: after a save, external file changes were no longer picked up until the next edit (the save timer was never cleared).
- Top bar: `Auto Layout` is its own button; `+ Project` is gone from the bar (`New Project` stays in the ⋯ menu).
- Much faster editing on large plans: wire routing is recomputed only when connections or box geometry change (not on every keystroke, selection or hover), and text fields commit after you pause typing (or on Enter / blur). Renaming an output with 8 branches went from about 285 ms to 13 ms per keystroke.
- Wires between a tab's Inputs / Outputs nodes and the opened box are selectable: clicking one selects the real wire that feeds that port (and they light up with it).
- A connected input's name is the name of the output feeding it: connecting renames the input to the source's name, the name is read-only on the input side (UI, `port --rename` refuses), and renaming the output propagates.
- Input names follow the output that feeds them: `connect "A.Design" "B"` (and `split` connections with `to: "B"`) create the input with the output's name, and renaming an output renames the connected inputs that shared the name, through box boundaries.
- Tabs exist only for major boxes. Inside a tab the whole subtree is shown nested (boxes inside boxes); boxes can be collapsed / expanded again (screen-only in View, saved in Edit). No more drilling into sub-boxes or deeper breadcrumbs.
- Activity panel: each box in Working / Blocked now shows where it sits in the plan (major › middle item) and what it produces (its outputs), so you can tell at a glance where in the whole plan the agent is working and what for.
- Published `boxglow@0.1.0` to npm (2026-10-03): `npx boxglow` works without a checkout. Runtime dependencies are only the MCP SDK and zod; the web app is shipped prebuilt in `dist/`.
- `boxglow mcp`: MCP server (stdio) exposing the CLI as tools; `setup-agent` registers it in `.mcp.json`.
- `boxglow serve`: local server for any browser (Firefox / Safari): bundled web app + `/api/project` read/write + SSE live reload (`?serve=1`).
- The web build now uses relative asset paths, so the same `dist/` works when served from the npm package, the blog mirror and Cloudflare Pages.
- Free / paid line written down (README "Free and paid", docs/MONETIZATION.md) and a waitlist for Boxglow Cloud at /waitlist/ (Cloudflare Pages Function + KV; stores the email only).
- CLI: `boxglow remove <block> [--force]` deletes a box (with its children when forced); project boxes cannot be removed.
- Arrowheads are drawn by Boxglow itself and follow the wire's colour in both themes (amber = not ready, green = ready, orange = selected); before, ready arrowheads stayed dark teal in dark mode and looked like a third state.
- Answering a decision: the answer box is multi-line (Enter / Shift+Enter insert a line break), sent only with the Answer button or Ctrl+Enter, and an answered decision can be edited afterwards (Edit / Save) without losing the record.
- Fewer wire crossings: routes are chosen with a penalty for crossing other wires (two passes), and wires sharing a channel are ordered by where they come from and go to (U-turns outermost, nested by span). Boxglow's own plan went from 426 to 185 crossings across its screens.
- Wire colours: ready wires are thick green, not-ready wires are thin amber (per-theme shades with at least 3.5:1 contrast), box borders stay neutral gray, so both "ready vs not" and "wire vs border" are visible even in a zoomed-in fragment.
- Selecting a wire highlights only that wire and its continuation across box boundaries (upstream and downstream), not the sibling wires branching from the same port.
- A wire never reaches a port by cutting through its own box from the far side (this happened when the return lane was at the port's height). Wires that go back to a box on the left no longer cut through a box sitting right below (or above) their start: the vertical channels of a backward wire are now chosen from all free gaps, not only right next to the ports.
- Web app moved to Cloudflare Pages: https://boxglow.pages.dev/ (`npm run deploy:pages`). The blog mirror at sukimalog.com stays for a while.
- "All" now shows only the major boxes (children of project boxes), always collapsed; what is inside a major box is seen on its own tab (double-click a major box, or press its arrow, to open the tab). Layout, `boxglow layout` and Auto Layout treat major boxes as collapsed, so the overview stays compact. Dropping a box onto a collapsed major box moves it inside.
- Every level works the same way as All: a tab (or any opened box) draws the opened box as the top-level box with its direct children (collapsed) inside, and the box's Inputs / Outputs nodes outside it, wired to the box. Click a box that has children to open it; a breadcrumb (All › major › ...) at the top-left of the canvas goes back up. Task boxes are stored collapsed; layout uses collapsed sizes.
- Double-click a box that has children (or press its arrow) to open it; a single click only selects. Major boxes open their tab even when empty. Adding a box on All with nothing selected creates a new major box, i.e. a new tab.
- Tab bar works like spreadsheet sheets: no scrollbar, left / right arrows to scroll, and a list button that opens all tabs (with status and progress) to jump directly.
- Canvas tabs (at the bottom of the canvas, like sheets): "All" shows the whole plan; one tab per major box (children of project boxes) shows only that subtree, fitted to the screen, with the box's own inputs and outputs shown as Inputs / Outputs nodes on the left and right. The active tab is remembered per project in the browser. `+ Block` / `N` with nothing selected adds into the open tab's box.
- Resizable side panels: drag the border of the details panel (right) and the drawer (left). Widths are remembered in the browser.

## 0.1.0 (2026-10-03)

First public release.

- Web app: boxes with inputs / outputs, unlimited nesting, project boxes, obstacle-avoiding wires, Edit / View modes, local `boxglow.json` (File System Access API), light / dark themes.
- Status as New (BlackBox) / In Progress (GrayBox) / Done (WhiteBox) with icons; categories; schedule; short IDs and search; required inputs and Ready; decisions with kept candidates and `reopen`; issue links (JIRA / Redmine / GitHub).
- CLI `boxglow` for AI agents: init / status / add / split / connect / port / move / start / done / blocked / review / ask / answer / reopen / set / artifact / check / export / layout / validate / templates / input groups.
- Git-friendly file (schema 5): no timestamp churn, opening never writes, box-level 3-way merge driver (`boxglow merge`, `boxglow git-setup`).
- Deliverables recorded as commit + path + blob (never uploaded).
