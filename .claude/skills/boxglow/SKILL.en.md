---
name: boxglow
description: Share the plan and progress with humans through Boxglow (boxglow.json). Record starting, splitting, finishing and pending decisions with npx boxglow. Use for "record progress in Boxglow", "check the status with boxglow", or "/boxglow".
---

# Share the plan and progress with Boxglow

`boxglow.json` at the repository root is the source of truth for the plan. Humans watch it on the Boxglow screen (https://boxglow.pages.dev/, "Open boxglow.json").
Do not edit it directly; update it with `npx boxglow`.

## Making the first plan (for a new project)

1. Read the direction (README, the request, requirement notes), run `npx boxglow init --name "<name>"`, then place the top-level items (3-7 of them) with `add`.
   For each item, always write its "inputs (what it uses)" and "output (a concrete deliverable: file, URL, PR)", and connect them all the way to the final deliverable (`connect`)
2. Once created, get a human's confirmation with `npx boxglow ask <first top-level item> "Is this breakdown into top-level items OK?" --options "OK|Needs changes"`.
   The human can answer on the screen, with `npx boxglow answer <block> "<answer>"`, or in chat. If the answer comes back in chat, the AI records it with `answer --by human`.
   If the human does not use the screen (when you are told to proceed with the AI alone), the AI records its own decision with `answer --by claude-code "<decision and reason>"` and moves on. The point is to keep a record of decisions; the screen is not required
3. `split` only the item you are about to start (leave later stages coarse, and refine them as you go)

## Steps

1. Read `npx boxglow status`. Take in the answers to pending decisions, the boxes in progress and the next candidates
2. Once you have chosen a box, check its inputs and outputs with `npx boxglow show <block>`, then run `npx boxglow start <block> --note "<what you will do>"`
3. Split a large box with `npx boxglow split <block> --spec '<JSON>'` (see `npx boxglow help` for the format). Always decide the output of each box
4. When the deliverable exists, run `npx boxglow done <block> --artifact "<name>=<URL or path>"`
5. When a human decision is needed, run `npx boxglow ask <block> "<question>" --options "A|B"` and move on to another box
6. When you are stuck, run `npx boxglow blocked <block> --note "<what is in the way>"`
7. At the end, summarize `npx boxglow status` and report it

## Rules

- Write each `ask` question so that it can be decided on its own. Do not point outside the question, as in "Is this OK?" or "the plan above"; put the premises, comparison and impact in `--context` (the human reads only the question in a list and answers it)
- When choosing one of several candidates (an approach, a library, a design choice), even if the AI decides by itself, record it as `ask <block> "<question>" --options "A|B|C"` → `answer --by claude-code "<the choice>. Reason: ..."` so that the candidates not chosen stay on the box (you can come back to them when the direction changes)
- To change direction, use `reopen <block> --note "<reason>"`: the previous answer stays in the history and you choose again (candidates are not deleted)

- Keep at most 1-2 boxes in progress at a time
- Make deliverables (artifacts) something a human can open later (a commit, a PR, a file path)
- Name outputs after concrete deliverables (file, PR, URL, test results). Avoid abstract names (feature set, findings)
- The receiving side of a connection can be just a title (`connect "A.Design doc" "B"` creates an input "Design doc" on B). An input's name is determined by the source output's name and is not changed on the input side
- Always connect boxes as "input → output". Add missing inputs / outputs with `port`, remove a wire with `disconnect`, and remove a box itself with `remove`. Export a document with `export --out docs/ROADMAP.md`
- When you add a box, give it a kind of work with `--category` (design / build / verify / evaluate / study / research / ui / improve / fix / docs / ops / other). On the screen it becomes a colored band and a tag
- If boxglow.json does not exist yet, create it with `npx boxglow init --name "<project name>"` and place the final deliverable and the top-level boxes with `add`
