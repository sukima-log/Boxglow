# Boxglow for VS Code

**See where your AI agent is in the plan, and what it is waiting for you to decide.**

Boxglow keeps a project plan in one file, `boxglow.json`: tasks are boxes with inputs and outputs, nested without limit. AI agents (Claude Code, Codex, ...) update the file through a CLI or MCP as they start, finish, or need a decision. This extension opens that file as a live diagram inside VS Code.

![The whole plan: four major boxes, wires show what feeds what](https://raw.githubusercontent.com/sukima-log/Boxglow/main/vscode/images/overview.png)

## How a plan is laid out

The **Top** view shows only the major boxes. Each major box opens as a tab with everything inside it, nested. Wires show which output feeds which input, so you can see what is blocked by what.

![Top shows the major boxes; a tab shows everything inside one of them](https://raw.githubusercontent.com/sukima-log/Boxglow/main/vscode/images/levels.png)

## What you see

- **Where the agent is working**: the box it is on carries a "Working" tag; the top bar counts what is in progress and what needs a decision.
- **What is done and what is not**: New boxes are dark, boxes in progress are hatched, done boxes are light. Green wires carry a finished deliverable, amber wires are still waiting.
- **The block tree**: the sidebar button opens the whole hierarchy. Jump to a box, or add, rename, move and delete boxes right from the tree.

![Inside the API tab, with the block tree: one box in progress, one waiting for a decision](https://raw.githubusercontent.com/sukima-log/Boxglow/main/vscode/images/tab.png)

- **Decisions in one place**: when an agent asks a question, the box is marked. Pick an option or write an answer in the side panel; the agent reads it from the file and carries on. Your answer stays listed until the agent has picked it up.

![Answering an agent's question from the side panel](https://raw.githubusercontent.com/sukima-log/Boxglow/main/vscode/images/decision.png)

## Working with several agents

- **Edits do not collide**: when the file changes while you have unsaved edits, changes to different boxes are merged automatically. Only a box that both sides changed asks you to choose, box by box.
- **Claims (optional, per plan)**: an agent that starts a box holds it for a while, so other agents and sub-agents leave it alone.

## How to use

1. In your repository: `npx boxglow init --name "My project"` and `npx boxglow setup-agent` (adds the instructions for your agent and registers the MCP server).
2. Ask your agent to "read the README and create the major boxes in Boxglow".
3. Right-click `boxglow.json` and choose **Boxglow: Open boxglow.json as a diagram** (also in the editor title bar and the command palette).

The diagram follows the file: when the CLI or an agent writes it, the view updates. Edits in the diagram (Edit mode) are written back to the file. Light / dark follow the VS Code theme, and the UI is in English or Japanese following VS Code's display language.

## Good to know

- Everything stays in your repository: the extension reads and writes `boxglow.json`. Nothing is uploaded unless you choose **Start syncing** (experimental sync between machines, off by default).
- Works without an agent too: you can build and track a plan by hand.
- The plan format, the CLI, the MCP server and the web app are open source (MIT): https://github.com/sukima-log/Boxglow
- Web version: https://boxglow.pages.dev/

Questions and bug reports: https://github.com/sukima-log/Boxglow/issues
