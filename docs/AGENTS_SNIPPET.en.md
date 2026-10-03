# Instructions for agents using Boxglow (paste into AGENTS.md / CLAUDE.md)

Paste the part between the "---" lines below, as is, into your repository's AGENTS.md (Codex) or CLAUDE.md (Claude Code).
Put boxglow.json at the repository root (`npx boxglow init --name "<project name>"`).

---

## Boxglow (shared plan and progress)

`boxglow.json` is the source of truth for this repository's plan and progress. Humans watch this file on the Boxglow screen.
Do not edit the file directly; always update it with `npx boxglow` commands (this keeps the wiring rules and the history intact).

A block = "a task that turns inputs into an output (deliverable)". It is done (WhiteBox) once the output's deliverable is settled.
Status: BlackBox (only the output is decided) → GrayBox (being broken down or worked on) → WhiteBox (done).

### What to do every time you work

1. **Read first**: read `npx boxglow status` for the overall picture, pending decisions, work in progress and next candidates. Check the inputs and outputs of your box with `npx boxglow show <block>`
2. **Record the start**: when you take on a box, run `npx boxglow start <block> --note "<what you will do>"`. Work on at most 1-2 boxes at a time
3. **Split**: when you cannot see how to produce the output with a single box, place smaller boxes inside it with `npx boxglow split <block> --spec '<JSON>'`. Always decide the output (deliverable) of each box. Inputs can be omitted if unknown (they automatically become inputs of the level above)
4. **Record completion**: when the output's deliverable exists, run `npx boxglow done <block> --artifact "<name>=<path in the repository>"`.
   A path under Git is recorded as "commit + path + content hash" (nothing is uploaded). Commit first, then run done. For PRs and external material, a URL is fine.
   To attach a deliverable ahead of completion, use `npx boxglow artifact <block> <path>`. Record progress along the way with `npx boxglow set <block> --progress 60`
5. **When a human decision is needed**: `npx boxglow ask <block> "<question>" --options "A|B"`. Do not proceed with that box until it is answered; move on to another box. A human's answer appears under "Answered" in `status`. After reading it, acknowledge it with `npx boxglow ack <block>` (`start` / `done` / `set` etc. on that box also acknowledge it automatically). Until you acknowledge it, it stays on the human's screen as "Not read by the AI yet" and the human can still revise the answer. If the answer contains a question back to you, record your own answer too with `ask` and `answer --by <yourself>`
6. **When you are stuck**: `npx boxglow blocked <block> --note "<what is in the way>"`
7. **Check deliverables**: after moving or renaming files, run `npx boxglow check` (it detects the move and updates the path; if the file cannot be found, it is flagged)
8. **Report**: at the end of your work, summarize `npx boxglow status` and report it

### Structural rules

- The top level contains only the "input node", the "final deliverable node" and "project boxes". Tasks go inside a project box (the default parent of `add` is the first project box)
- There is no limit on depth. `split` can be used at any level
- A box that could be reused in another project (e.g. converting input images to monochrome) can be turned into a template with `npx boxglow export-block <block> --out <name>.boxglow-block.json` and
  inserted with `npx boxglow import-block <path> --parent <block>`. You may share templates by putting them in the repository's `boxglow-blocks/`

When there are many top-level inputs, create a group with `npx boxglow group "<group name>"` and sort inputs into it with `npx boxglow group-set <input name> <group name>` (e.g. PCIe spec / DDR spec).

### JSON format for split

```json
{
  "blocks": [
    { "title": "Design", "description": "What to do", "inputs": ["Spec"], "outputs": ["Design doc"] },
    { "title": "Build", "inputs": ["Design doc"], "outputs": ["Code"] }
  ],
  "connections": [
    { "from": "parent.Spec", "to": "Design.Spec" },
    { "from": "Design.Design doc", "to": "Build.Design doc" },
    { "from": "Build.Code", "to": "parent.Output" }
  ]
}
```

`parent.<name>` is an input / output of the box being split. `<block>` is a short ID (such as B12; shown in status) or a title.
A box with no children has a single output (write just one entry in outputs). Make the title a short phrase that tells "what is made".
Record dates and hours with `npx boxglow set <block> --due 2026-10-15 --start 2026-10-01 --estimate 8 --hours 3.5`.
Give each box a kind of work (category): `--category design` / build / verify / evaluate / study / research / ui / improve / fix / docs / ops / other (other: when unsure). Set it at add time; to change it, use `npx boxglow set <block> --category verify`.
The receiving side of a connection can be just a title (`npx boxglow connect "A.Design doc" "B"` creates an input "Design doc" on B and connects it. In split's connections, `to: "B"` also works). A connected input takes the name of the source output and cannot be renamed on the input side (to change it, rename the source output; everything connected to it changes with it). To add inputs / outputs to an existing box or rename them, use `npx boxglow port <block> --in <name> --out <name> --rename <old>=<new>` (`project` = the first project box. This also renames the final deliverable). Remove a wire with `npx boxglow disconnect <title.output name> <title.input name>`, and remove a box itself with `npx boxglow remove <block>` (`--force` if it has boxes inside). The MCP tools (`boxglow_status` / `boxglow_start` / `boxglow_done` / `boxglow_ask` etc.; available if registered in `.mcp.json`) are another entry point to the same commands, and either way updates the same file. Export the plan as a document with `npx boxglow export --out docs/ROADMAP.md`.
In a new project, first create 3-7 top-level items from the direction (the README or the request), confirm them with a human via `ask`, and then `split` only the item you are about to start (leave later stages coarse). Write each `ask` question so that it can be decided on its own, and put the premises, comparison and impact in `--context` (do not point outside the question, as in "Is this OK?"). When choosing one of several candidates, even if you decide by yourself, record it with `ask ... --options "A|B|C"` and `answer --by <yourself>` so that the candidates you did not choose are kept. To change direction, use `reopen <block> --note <reason>`. Everything works with the CLI alone (the screen is for humans to watch). If no human is in the loop, the AI records its decisions with `answer --by <yourself>` and proceeds.
Name each output after a "concrete deliverable" (e.g. `Design doc docs/design.md`, `PR #12`, `Public URL`, `Test results (vitest, 53 tests)`). Avoid abstract names such as "feature set" or "findings", and always attach a file, URL or commit with --artifact when you run done.
Make sure every box's "input → output" is connected to something (an unconnected box is a hole in the plan. Unconnected inputs are raised to the top-level input node automatically).
If several people edit the same boxglow.json, each of them runs `npx boxglow git-setup` once in their own clone (changes are merged automatically per box, and changes to different boxes do not conflict).
To manage several repositories with one plan, put boxglow.json in the folder above them and set the environment variable BOXGLOW_FILE to its location in each repository (one project box per repository: `npx boxglow project "name" --repo <path>`).
Inputs are required by default. On the screen, mark an input as "Optional" if work can start without it. "Next candidates" in status lists boxes whose required inputs are ready first (each is marked "ready to start" or "waiting for required inputs").
Do not write descriptions for inputs (the description of the connected output is used). Write the format and constraints in the output's description.

---
