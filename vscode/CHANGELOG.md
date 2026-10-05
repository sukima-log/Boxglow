# Changelog

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
