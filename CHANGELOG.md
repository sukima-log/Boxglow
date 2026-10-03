# Changelog

## Unreleased

- Wires that go back to a box on the left no longer cut through a box sitting right below (or above) their start: the vertical channels of a backward wire are now chosen from all free gaps, not only right next to the ports.
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
