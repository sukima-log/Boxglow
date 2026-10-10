# Changelog

## 0.5.0

- Follows boxglow 0.6.0. Update together with the CLI and `serve`.
- **A diagram you can read at a glance**: boxes are cards (category, title, state, then inputs on the left and outputs on the right) with a header colored by state. In View mode boxes are laid out in dependency order as numbered stages; the zoom panel switches to a vertical, top-to-bottom view (Ctrl + wheel, or Cmd + wheel on a Mac, zooms). The layout saved in the file is untouched and is used in Edit mode.
- **Block tree**: a sidebar with the whole hierarchy. Jump to a box, or add, rename, move, change the status of and delete boxes from the tree.
- **Zoom and panels**: you cannot zoom out further than the whole diagram. Selecting a box, opening a panel, or resizing the editor (for example opening the terminal) keeps your zoom and position; the Fit button fits the diagram in the area not covered by panels.
- **Edits do not collide**: when the file changes while you have unsaved edits, changes to different boxes are merged automatically. Only a box that both sides changed asks you to choose, box by box.
- **Claims (optional, per plan)**: an agent that starts a box holds it for a while, so other agents and sub-agents leave it alone. The Owner tab of the side panel shows who holds a box, and the Activity panel's Claims tab lists every claim with the agent, its instance ID and the time left.
- **Start syncing (experimental, off by default)**: put this plan on the sync server or open one of your plans there, sign in, and keep machines in step. Nothing is sent until you start. Plans can be deleted from the server and restored for 30 days. The hosted sync server is an invite-only trial: an account that is not invited yet is told so and pointed to the waitlist.
- **Branches for undecided forks**: "Branch (IF)" in the + Block menu adds a box with a question and one path per option. Boxes on the paths wait until you pick one in **Choose a path** at the top of the side panel; after that, the paths not chosen are skipped (faded, left out of progress and lists). A branch is drawn as a card with cut corners and an "IF" diamond; where paths come together, a small OR-gate-like merge part ("Merge" in the same menu) passes the work on when any one path arrives. An existing box can be turned into a branch from its ⋯ menu.
- **In charge (assigned boxes as a table)**: the table icon next to the horizontal / vertical switch at the bottom left lists the boxes assigned to you (or another member, everyone, or unassigned) with status, progress, due date, estimate, waiting inputs and open questions. Click a row to open its details on the right while the table stays.
- On narrow editor widths, panels close with a large "× Close" button instead of a small ×.
- Selecting a wire shows a bar at the top of the diagram (where it runs, whether it is ready, and Disconnect in Edit mode) instead of opening the side panel. Double-click the Inputs or Outputs node inside a tab to go back to Top.
- Fixed: after switching tabs, Fit could stay at 100%.
- Saving moves only what changed: adding, moving or growing a box pushes only the boxes it now overlaps.
- Switching between Edit and View no longer changes the width of the top bar; Auto Layout is in the ⋯ menu.

## 0.4.1

- Follows boxglow 0.5.2 (0.5.1 is the same content). Update together with the CLI.
- Visual update of the canvas: confirmed wires are solid green and unconfirmed wires dashed amber; a selected wire is the moving orange dashed line; boxes put the title first and show details when selected; open questions get a small badge; below 65% zoom in View mode the canvas shows a simplified overview.
- Opening an empty `boxglow.json`: asks for a plan name and creates the plan in that file (it used to show the browser start page with an unrelated notice).
- The start page inside VS Code no longer shows browser-only guidance (sample, plans kept in the browser, `serve`); those plans were copies inside VS Code and never reached the file. A file that cannot be read as a plan, or content that does not arrive, is explained in full instead of being cut off.
- No Home button inside VS Code (the editor is bound to one file).
- Reload button next to the save state rereads the file on demand; the view still follows the file automatically.
- Wires that reach an output node end in an arrowhead.

## 0.4.0

- Follows boxglow 0.5.0: the details panel shows a box's scope (goal, non-goals, acceptance, when to consult) when it has one, the Next tab separates ready boxes from boxes waiting for inputs, and the project panel has the optional "AI の作業確認" policy. Update together with the CLI.

## 0.3.2

- Opening a WSL file (`\\wsl.localhost\...`) from a Windows window: the plan is shown instead of an empty screen. If VS Code does not allow extensions to access that location, the editor is read-only and explains what to do (open the file in a WSL window, or add the host to `security.allowedUNCHosts` and restart). Previously the Home list could lead you to an old copy kept inside VS Code, whose edits never reached the file.
- The Home list says its plans are copies kept inside VS Code.

## 0.3.1

- Save lock follows boxglow 0.4.1: a lock is recovered automatically only when its owner is confirmed gone (same host, OS and process-ID space). A VS Code window on Windows and a CLI in WSL no longer mistake each other's live lock for a dead one. Update together with the CLI and reload the window.
- Inspector: a short button on tabs other than Status leads to unanswered questions and answers the AI has not acknowledged.

## 0.3.0

- "Saved" appears only after the edit was applied, the document saved and the file on disk confirmed (CRLF files included). If saving fails, your edits stay on screen with retry and export.
- Shares the write lock with the CLI and `boxglow serve`, so an agent and the editor do not overwrite each other; conflicts can be compared and resolved item by item.
- Details panel shows questions and unread answers first, plus the agent handoff note. Activity panel has a Resume tab.
- Canvas tool strip (zoom, Fit, jump to selection, View drawer), shared trunks with branch dots for wires from one output.
- Japanese UI says "ボックス" instead of "箱".

## 0.2.0

First release on the Marketplace.

- Opens `boxglow.json` as a diagram (custom editor, command, context menus); follows changes written by the CLI / agents and writes edits back.
- One tab per major box with its Inputs / Outputs; wires never run through boxes; wires from the same output share one trunk.
- Decisions: answer an agent's question in the side panel; answers stay listed until the agent picks them up.
- English / Japanese UI following VS Code's display language; light / dark following the VS Code theme.
