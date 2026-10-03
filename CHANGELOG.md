# Changelog

## Unreleased

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
