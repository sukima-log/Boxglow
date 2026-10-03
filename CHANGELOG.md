# Changelog

## Unreleased

- Canvas tabs: "All" shows the whole plan; one tab per major box (children of project boxes) shows only that subtree, fitted to the screen. The active tab is remembered per project in the browser. `+ Block` / `N` with nothing selected adds into the open tab's box.
- Resizable side panels: drag the border of the details panel (right) and the drawer (left). Widths are remembered in the browser.

## 0.1.0 (2026-10-03)

First public release.

- Web app: boxes with inputs / outputs, unlimited nesting, project boxes, obstacle-avoiding wires, Edit / View modes, local `boxglow.json` (File System Access API), light / dark themes.
- Status as New (BlackBox) / In Progress (GrayBox) / Done (WhiteBox) with icons; categories; schedule; short IDs and search; required inputs and Ready; decisions with kept candidates and `reopen`; issue links (JIRA / Redmine / GitHub).
- CLI `boxglow` for AI agents: init / status / add / split / connect / port / move / start / done / blocked / review / ask / answer / reopen / set / artifact / check / export / layout / validate / templates / input groups.
- Git-friendly file (schema 5): no timestamp churn, opening never writes, box-level 3-way merge driver (`boxglow merge`, `boxglow git-setup`).
- Deliverables recorded as commit + path + blob (never uploaded).
