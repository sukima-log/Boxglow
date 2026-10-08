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

1. Read `npx boxglow resume` (or `npx boxglow status --brief`). Take in the handoff notes, the answers not yet read by the AI, the pending decisions, the boxes in progress and the next candidates. Use `npx boxglow status` when you need the whole tree
2. Once you have chosen a box, check its inputs and outputs with `npx boxglow show <block>`, then run `npx boxglow start <block> --note "<what you will do>"`.
   On a plan with the context guard on, first read `npx boxglow context <block>` and pass the `contextToken` (context token) from its output as `--context-token <context token>`
3. Split a large box with `npx boxglow split <block> --spec '<JSON>'` (see `npx boxglow help` for the format). Always decide the output of each box
4. When the deliverable exists, run `npx boxglow done <block> --artifact "<name>=<URL or path>"` (with the guard on, add `--context-token <context token>`; if your previous command printed "New context token: <token>", use that one)
5. When a human decision is needed, run `npx boxglow ask <block> "<question>" --options "A|B"` and move on to another box
6. When you are stuck: If the cause is a missing input (a deliverable of an earlier box, or material), do not mark the box as blocked. Check its input wires with `npx boxglow show <block>`; if no box produces what is missing, create one outside (upstream) with `npx boxglow add` and wire it to this box's input with `npx boxglow connect` (the wire stays in the waiting color, so the diagram shows what the box is waiting for). If a choice between options would let you continue, use `ask`. Record only obstacles outside the plan (an environment that does not work, missing permissions or keys, waiting for an outside reply, a failure with no known cause) with `npx boxglow blocked <block> --note "<what is in the way>"`
7. Before an interruption, context compaction or a handoff, save a handoff note with `npx boxglow checkpoint <block> --note "Findings; next steps; unresolved questions"`
8. At the end, summarize `npx boxglow status --brief` and report it

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

## Context token and handoff

The context guard keeps an AI from continuing work on outdated instructions. `setup-agent` turns it on (on other plans, run `npx boxglow guard on`).
While it is on, an AI's `start` / `done` / `set` / `split` / `artifact` / `ack` / `blocked` / `review` / `leave` / `checkpoint` need `--context-token <context token>`. Commands run by a person (`--actor human`) do not.

```
npx boxglow context B12        # read the decisions (including acknowledged answers), input/output contracts and handoff notes. contextToken in the output is the context token
npx boxglow start B12 --note "<what you will do>" --context-token <context token>
npx boxglow ask B12 "<question>" --options "A|B" --context-token <context token>
#   -> last line of the output: New context token: <token>
npx boxglow done B12 --artifact "<name>=<path>" --context-token <new context token>
```

- **The context token changes (you must reread)** when a person answers a decision or revises an answer, a person changes the instructions (title, description, input/output contracts), or another AI or a person updates the handoff note. The same applies when this happens on a parent box or an input provider. The old context token is rejected: reread `context`, take the change into account in your work, then retry
- **The context token does not change** on `start` / `blocked` / `review` / `leave` / `ack`, on changes to progress, status, dates or category, when `check` verifies deliverables, or when boxes are moved on the screen. Keep using the same context token
- **You can update it yourself**: when your own `ask` / `artifact` / `done` / `set` / `split` / `checkpoint` etc. changes the context, the last line of its output is "New context token: <token>". Use it for the next command without rereading. `ask` / `decision` / `answer` / `reopen` run without a context token, but they print the new context token only when you pass the latest one
- Do not turn the guard off to get past an old context token (an AI needs the latest context token to run `guard off`)
- When resuming, read `npx boxglow resume`, and check a box that has a handoff note with `context` before continuing. Handoff notes stay in the plan, independent of the chat history and the activity-log limit
- With MCP, use `boxglow_context` and the `contextToken` argument of each tool
- If "Another Boxglow writer holds the file lock" persists after waiting and retrying, show the output of `npx boxglow unlock` (owner and verdict) to a person and ask them to remove it. Never add `--actor human` yourself or delete the lock folder directly


### Readiness, current scope, and fresh resume information

- Read current activity, pending decisions, and unread answers first. Candidates are grouped by current scope / other candidates, then ready / waiting for inputs, with missing input names. A waiting candidate is not ready.
- Four optional scope fields are available: goal, non-goals, acceptance, and consult (when to consult before expanding scope). Read the target and parent scopes at the start of context before starting and finishing. Textual acceptance criteria are not automatically evaluated.
- Use scope B12 --goal "Goal" --non-goals "Excluded" --acceptance "Checks" --consult "When to ask". scope B12 only reads; none or an empty string clears a field. In the inspector, use ⋯ → Edit work scope. Only populated fields appear in the collapsed scope section.
- focus B12 prioritizes that box and its descendants; focus reads the selection, and focus none clears it. Other candidates remain in a separate group. Being listed does not authorize expanding scope or publishing.
- Missing required inputs warn on start by default but still allow the start. Supply --reason "Why starting early is appropriate" to proceed without a warning and save the reason in both activity and the log. Artifact-free done also remains warning-only by default. Existing output artifacts or --artifact count; reference material on the box does not.
- Only enable strict checks when selected for the plan: policy --start reject --done reject. Each can return to warn. A recorded start reason also overrides reject. The artifact requirement also applies to set --status white. Human operations (UI / --actor human) are never rejected. Do not impersonate a human or weaken policy to bypass rejection.
- With guard enabled, scope writes, focus selection/clearing, and policy writes require --context-token. These changes print a new token: use it next. Read-only forms need no token.
- resume hides completed handoff bodies and shows their count. Request resume --include-completed only when history is needed; context / show can still read individual notes.
- descriptionUpdatedAt dates description changes; statusChangedAt dates status changes; handoffs use their existing at field. Notes predating a status change are marked. Unknown legacy dates stay unknown, and recency does not establish truth.
- After Done, CLI, inspector, and resume flag descriptions that may still describe an earlier state. Text is never rewritten automatically. Review it, then update with set B12 --note "Current description" (none clears it) or Notes in the UI.
- MCP: boxglow_scope / boxglow_focus / boxglow_policy, reason on boxglow_start, and includeCompleted on boxglow_resume. Pass contextToken for writes.
- All data fields are optional; schema v5 is unchanged. Old versions (0.4.2 and earlier) do not enforce these checks and drop workflowPolicy / focusBlockId when saving. Align all writers (CLI, serve, web app, bundled extension app) to a supporting build before using these settings. Check build time as well as version.
