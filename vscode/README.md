# Boxglow for VS Code

Open `boxglow.json` as a diagram of boxes and wires, right inside VS Code: see which box your AI agent (Claude Code, Codex, ...) is working on, what is waiting for your decision, and what is left.

- Right-click `boxglow.json` or use the editor title button **Boxglow: Open boxglow.json as a diagram** (also in the command palette).
- The diagram follows the file: when the CLI (`npx boxglow ...`) or an agent writes the file, the view updates. Edits in the diagram are written back to the file.
- Light / dark follow the VS Code theme.

The plan format, the CLI for agents and the web app are at https://github.com/sukima-log/Boxglow (MIT).
