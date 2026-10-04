# Changelog

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
