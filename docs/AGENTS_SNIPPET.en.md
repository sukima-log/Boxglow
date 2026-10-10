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

1. **Read first**: read `npx boxglow resume` (or `npx boxglow status --brief`) for work in progress, pending decisions, unread answers, next candidates, and handoffs for unfinished boxes. To continue a previous session, start from the handoff notes shown there. Check the inputs and outputs of your box with `npx boxglow show <block>`
2. **Check readiness**: before taking on a box, read `npx boxglow context <block>`. Its `readiness` is the state of preparation: `state: "ready"` means you can start. `"unprepared"` (needs detail) means you add detail first, following the reasons in `unprepared` and the commands in `next`. `"waiting"` means a required input or a branch answer is missing
3. **Hold, then add detail**: before adding detail or splitting, hold the box with `npx boxglow claim <block>` (this does not start it; on a plan without claims it prints "not needed" and succeeds). Then fill in what is missing:
   - the output's planned deliverable: `npx boxglow port <block> --expect "<output>=file:src/x.ts"` (kind: file / dir / url / doc / note / decision / result; hint: a path or title. The file need not exist yet)
   - the acceptance criteria: `npx boxglow scope <block> --acceptance "<when it counts as done>"`; the work itself with `--goal`
   - when you cannot see how to produce the output with a single box, place smaller boxes inside it with `npx boxglow split <block> --spec '<JSON>'`. Write expect / acceptance only for the children you will start now; later children need only a title and an output (they stay "needs detail"). Inputs can be omitted if unknown (they automatically become inputs of the level above)
   - when you do not know which files are involved, do not invent paths: add a box "find the target" with a `note` output and start that
4. **Record the start**: once ready, read `npx boxglow context <block>` again, then run `npx boxglow start <block> --note "<what you will do>"`. Work on at most 1-2 boxes at a time.
   The started box is marked "now" (the boxes being worked on right now; any number when several agents or people work; a thick frame and a NOW tag on the canvas). Add another with `npx boxglow now <block>` (`--off` removes one, `now none` clears all); done / leave remove that box. People toggle it with the NOW button on the Status tab
   On a plan with the context guard on, pass the `contextToken` (context token) from the context output:
   `npx boxglow start <block> --note "<what you will do>" --context-token <context token>` (see "Context token and handoff" below)
   Starting a box that still needs detail warns by default (with the reasons and the next commands). On a plan with `policy --unprepared reject` it is refused (`--reason` does not bypass it; human actions are allowed). A parent whose outputs are all made by its children has nothing to run itself: start the child instead
5. **Record completion**: when the output's deliverable exists, run `npx boxglow done <block> --artifact "<name>=<path in the repository>"`.
   With the guard on, add `--context-token <context token>` (if your previous command printed "New context token: <token>", use that one).
   An unchanged file already committed to HEAD is recorded as "commit + path + content hash" (nothing is uploaded). Uncommitted or untracked files remain local file references, and `npx boxglow check` turns them into Git references once they are committed; do not create a commit solely to satisfy Boxglow. Use full `npx boxglow status` when you need the entire tree. For PRs and external material, a URL is fine.
   To attach a deliverable ahead of completion, use `npx boxglow artifact <block> <path>`. Record progress along the way with `npx boxglow set <block> --progress 60`
6. **When a human decision is needed**: `npx boxglow ask <block> "<question>" --options "A|B"`. Do not proceed with that box until it is answered; move on to another box. A human's answer appears under "Answered" in `status`. After reading it, acknowledge it with `npx boxglow ack <block>` (`start` / `done` / `set` etc. on that box also acknowledge it automatically). Until you acknowledge it, it stays on the human's screen as "Not read by the AI yet" and the human can still revise the answer. If the answer contains a question back to you, record your own answer too with `ask` and `answer --by <yourself>`
7. **When you are stuck**: If the cause is a missing input (a deliverable of an earlier box, or material), do not mark the box as blocked. Check its input wires with `npx boxglow show <block>`; if no box produces what is missing, create one outside (upstream) with `npx boxglow add` and wire it to this box's input with `npx boxglow connect` (the wire stays in the waiting color, so the diagram shows what the box is waiting for). If a choice between options would let you continue, use `ask`. Record only obstacles outside the plan (an environment that does not work, missing permissions or keys, waiting for an outside reply, a failure with no known cause) with `npx boxglow blocked <block> --note "<what is in the way>"`
8. **Check deliverables**: after moving or renaming files, run `npx boxglow check` (it detects the move and updates the path; if the file cannot be found, it is flagged)
9. **Before an interruption or a handoff**: before the session ends, the context is compacted, or you hand over to another AI or a person, save a handoff note with `npx boxglow checkpoint <block> --note "Findings; next steps; unresolved questions"` (with the guard on, add `--context-token <context token>`). It stays in the plan even when the chat history is gone, and the next session reads it with `resume` and `context`
10. **Report**: at the end of your work, summarize `npx boxglow status --brief` and report it

### Structural rules

- **Show an undecided fork as a branch**: when, at planning time, later work (a path) depends on a decision that has not been made, create a branch box with `npx boxglow branch "<title>" --options "A|B" --question "<question>" --context "<background>"`. Each option becomes a path (output); `connect` each one to the first box of that path. Where the paths come together again, add a merge part with `npx boxglow join --title "<title>"`, `connect` the last output of each path to it, and connect its output to the next box (any one path arriving is enough). Once a person answers, the boxes on the paths not chosen are skipped and drop out of progress and next candidates. If a box you already made turns out to be an undecided fork, turn it into a branch with `npx boxglow branch --box <block> --options "A|B" --question "<question>"` (its output becomes the first option's path; wires stay). Before the answer, boxes on the paths wait for the branch and starting them warns (record a reason with `--reason`, e.g. for early research)
- The top level contains only the "input node", the "final deliverable node" and "project boxes". Tasks go inside a project box (the default parent of `add` is the first project box)
- There is no limit on depth. `split` can be used at any level
- A box that could be reused in another project (e.g. converting input images to monochrome) can be turned into a template with `npx boxglow export-block <block> --out <name>.boxglow-block.json` and
  inserted with `npx boxglow import-block <path> --parent <block>`. You may share templates by putting them in the repository's `boxglow-blocks/`

When there are many top-level inputs, create a group with `npx boxglow group "<group name>"` and sort inputs into it with `npx boxglow group-set <input name> <group name>` (e.g. PCIe spec / DDR spec).

### JSON format for split

```json
{
  "blocks": [
    { "title": "Find the target", "inputs": ["Repro steps"], "outputs": ["Notes"],
      "expect": "note:the files and code paths involved, evidence, candidate changes, how to check, open questions", "acceptance": "the files and code to change are known and the following boxes can be given expect and acceptance; or the reason they cannot, and the decision needed, is clear",
      "goal": "reproduce and trace the path; changing product code is out of scope here" },
    { "title": "Refresh sync state after a retried save", "inputs": ["Notes"], "outputs": ["Fix"],
      "expect": "file:src/sync/state.ts", "acceptance": "fail one save, retry, and the sync state and actions come back (covered by a test)" },
    { "title": "Write the release note", "inputs": ["Fix"], "outputs": ["Note"] }
  ],
  "connections": [
    { "from": "parent.Repro steps", "to": "Find the target.Repro steps" },
    { "from": "Find the target.Notes", "to": "Refresh sync state after a retried save" },
    { "from": "Refresh sync state after a retried save.Fix", "to": "Write the release note" },
    { "from": "Write the release note.Note", "to": "parent.Output" }
  ]
}
```

`expect` (planned deliverable: `"kind:hint"` or `{ "kind", "hint" }`), `acceptance` and `goal` go only on the children you will start now.
A child with just a title and an output, like the third one, stays "needs detail" until its turn; then set them with `port --expect` / `scope --acceptance`.
Outputs the parent makes itself (integrating the children's results, for example) are marked with `"parentMakes": ["<output>"]` (if a child's wire also feeds it, readiness reports two makers).
`"splitBy": "stage"` records in one word how the direct children are divided (stage / deliverable / feature; also `set <block> --split-by`). Siblings should follow the same division and the same level of detail.
`split` refuses to save only a broken structure (a wire to nothing, a cycle, a malformed expect). Unfinished breakdowns (a single child, a parent output nobody makes yet) are saved and reported as gaps.
After a split and before a start, read `npx boxglow lint <block>`. Fix the "must fix" items (parent outputs with no or two makers, both exclusive paths of one branch required, a box in progress without expect / acceptance, gaps on the box you are checking) before going on.
"Fill in before starting" items (expect / acceptance of boxes not started yet) are filled when that child's turn comes (do not write token entries for later work now).
"Review" items (a single child, unconnected outputs, token entries, empty branch paths, single-input merges, siblings with the same expect) are for you to judge (the tool never refuses on them). `context` also prints the counts and the top three.

**Content review (meaning cannot be checked by the tool: an AI or a person reads the material, judges, and records the basis)**
- After a split: read `npx boxglow review-split <parent>` (the parent's goal, constraints, acceptance and ports; the children's targets, ports, planned deliverables and acceptance; the wiring; a checklist). When reviewed, record it with `npx boxglow split-ok <parent> --note "<basis: what you checked>"`.
- Before a start: read `npx boxglow review-box <block>` (target, work, planned deliverable, checks, input sources, upstream branch answers) and record with `npx boxglow box-ok <block> --note "<basis>"`.
- A record says "reviewed, with this basis"; it does not prove validity. When the material changes, `reviews` in `context` becomes `stale` (with what changed and what to check). `stale` does not mean the breakdown is wrong; it means the material changed after the last review. Position, colours, progress and assignees do not make it stale. The breakdown record is not affected by branch answers; the readiness record is.
- Adding detail to a later child at its turn always makes the parent's breakdown record `stale` (the children's expect / acceptance are part of the material). Finish that child's expect and scope first, then check only the changed child's effect on the parent's acceptance and nonGoals and on the division among siblings; if it still fits, update it with `split-ok <parent> --note "Checked B181's detail: not in the parent's nonGoals, no overlap with B182"`. Do not re-review after every port or scope command; several children detailed together can be checked together.
- It is not a condition for `start` (in default or reject plans). Only needs-detail and missing inputs stop a start.

**Branches and merges for agents**
- When an `ask` has options and the answer changes the work that follows, add `--branch`: the box becomes a branch with one path (output) per option. `connect` each path to its first box, and put a `join` where the paths come together.
- The split JSON can make them too: a child with `"branch": { "question": "...", "options": ["A", "B"] }` becomes a branch box (its outputs are the option names), `"join": true` a merge part. Example:
  `{ "blocks": [{ "title": "Choose auth", "branch": { "question": "Which?", "options": ["Mail", "OAuth"] } }, { "title": "Mail impl", "outputs": ["Auth"] }, { "title": "OAuth impl", "outputs": ["Auth"] }, { "title": "Merge", "join": true }], "connections": [{ "from": "Choose auth.Mail", "to": "Mail impl" }, { "from": "Choose auth.OAuth", "to": "OAuth impl" }, { "from": "Mail impl.Auth", "to": "Merge" }, { "from": "OAuth impl.Auth", "to": "Merge" }, { "from": "Merge.Merge", "to": "parent.Auth" }] }`
- `lint` reports a box that requires inputs from both exclusive paths of one branch (they never both arrive) as must-fix, and empty paths or single-input merges as review items.
`parent.<name>` is an input / output of the box being split. `<block>` is a short ID (such as B12; shown in status) or a title.
A box with no children has a single output (write just one entry in outputs). Make the title a short phrase that tells "what is made".
Record dates and hours with `npx boxglow set <block> --due 2026-10-15 --start 2026-10-01 --estimate 8 --hours 3.5`.
Give each box a kind of work (category): `--category design` / build / verify / evaluate / study / research / ui / improve / fix / docs / ops / other (other: when unsure). Set it at add time; to change it, use `npx boxglow set <block> --category verify`.
The receiving side of a connection can be just a title (`npx boxglow connect "A.Design doc" "B"` creates an input "Design doc" on B and connects it. In split's connections, `to: "B"` also works). A connected input takes the name of the source output and cannot be renamed on the input side (to change it, rename the source output; everything connected to it changes with it). To add inputs / outputs to an existing box or rename them, use `npx boxglow port <block> --in <name> --out <name> --rename <old>=<new>` (`project` = the first project box. This also renames the final deliverable). Remove a wire with `npx boxglow disconnect <title.output name> <title.input name>`, and remove a box itself with `npx boxglow remove <block>` (`--force` if it has boxes inside). The MCP tools (`boxglow_status` / `boxglow_start` / `boxglow_done` / `boxglow_ask` etc.; available after registration in your agent; `.mcp.json` is the Claude Code configuration) are another entry point to the same commands, and either way updates the same file. Export the plan as a document with `npx boxglow export --out docs/ROADMAP.md`.
In a new project, first create 3-7 top-level items from the direction (the README or the request), confirm them with a human via `ask`, and then `split` only the item you are about to start (leave later stages coarse). Write each `ask` question so that it can be decided on its own, and put the premises, comparison and impact in `--context` (do not point outside the question, as in "Is this OK?"). When choosing one of several candidates, even if you decide by yourself, record it with `ask ... --options "A|B|C"` and `answer --by <yourself>` so that the candidates you did not choose are kept. To change direction, use `reopen <block> --note <reason>`. Everything works with the CLI alone (the screen is for humans to watch). If no human is in the loop, the AI records its decisions with `answer --by <yourself>` and proceeds.
Name each output after a "concrete deliverable" (e.g. `Design doc docs/design.md`, `PR #12`, `Public URL`, `Test results (vitest, 53 tests)`). Avoid abstract names such as "feature set" or "findings", and always attach a file, URL or commit with --artifact when you run done.
Make sure every box's "input → output" is connected to something (an unconnected box is a hole in the plan. Unconnected inputs are raised to the top-level input node automatically).
If several people edit the same boxglow.json, each of them runs `npx boxglow git-setup` once in their own clone (changes are merged automatically per box, and changes to different boxes do not conflict).
To manage several repositories with one plan, put boxglow.json in the folder above them and set the environment variable BOXGLOW_FILE to its location in each repository (one project box per repository: `npx boxglow project "name" --repo <path>`).
Inputs are required by default. On the screen, mark an input as "Optional" if work can start without it. "Next candidates" in status lists boxes whose required inputs are ready first (each is marked "ready to start" or "waiting for required inputs").
Do not write descriptions for inputs (the description of the connected output is used). Write the format and constraints in the output's description.


### Context token and handoff

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
- **You can update it yourself**: when your own `ask` / `artifact` / `done` / `set` / `split` / `checkpoint` etc. changes the context, the last line of its output is "New context token: <token>". You already know what you changed, so use it for the next command without rereading. `ask` / `decision` / `answer` / `reopen` run without a context token, but they print the new context token only when you pass the latest one
- **Read the short form first**: `npx boxglow context <block> --brief` prints everything about the box itself (description, scope, decisions, handoff, inputs/outputs, deliverables) plus the plan description and, for parents and input providers, title, status, decisions (with their context and options; the history of earlier answers is left out) and the outputs that feed the box. The context token is the same as without `--brief`, so pass it to `--context-token` as is. Look at `target.missingInputs` (required inputs that are not ready) and `target.inputs[].sources` (which output of which box, with references to its deliverables) first. `omitted` counts what was left out. If an omitted description, contract or handoff may matter to your work, read without `--brief`, or read `context` of that box
- **Precondition for starting from the short form**: the description of a parent or input provider that has any scope field set is left out of the short form (counted in `omitted.descriptions`). Set a scope only after moving the constraints written in the description (compatibility, prohibitions, deadlines) into it. On a plan where you cannot tell, or when `omitted.descriptions` is not 0, read once without `--brief` before you start. The short form is a starting point, not a guarantee that nothing else matters
- Write so that the short form is enough: put the conditions that bind the work in the scope (non-goals / acceptance / consult) instead of burying them in a description. Only the latest handoff note is kept, so carry the open points, cautions and next steps forward each time you write one. Say where to start looking in the description of the box, in this form (a starting point, not a claim that those files are all there is to read):
  `Change candidates: <path> — <why to start there>` / `Related checks: <path or command> — <what it verifies>`
- Do not turn the guard off to get past an old context token (an AI needs the latest context token to run `guard off`)
- With MCP, use `boxglow_context` and the `contextToken` argument of each tool (the new context token is the last line of the tool result)
- If "Another Boxglow writer holds the file lock" persists after waiting and retrying, show the output of `npx boxglow unlock` (owner and verdict) to a person and ask them to remove it. Never add `--actor human` yourself or delete the lock folder directly

### Readiness, current scope, and fresh resume information

- Read current activity, pending decisions, and unread answers first. Candidates are grouped by current scope / other candidates, then ready / needs detail / waiting for inputs, with the reasons and missing input names. A candidate that needs detail or is waiting is not ready.
- "Ready" is a mechanical check: the box makes at least one output itself, that output has a planned deliverable (expect), the acceptance criteria are written, and required inputs are in. It does not judge whether the text is specific (`expect = src/`, `acceptance = works` pass). Write them so a third party can follow the target, the work, the result and how it is checked.
- Four optional scope fields are available: goal, non-goals, acceptance, and consult (when to consult before expanding scope). Read the target and parent scopes at the start of context before starting and finishing. Textual acceptance criteria are not automatically evaluated.
- Use scope B12 --goal "Goal" --non-goals "Excluded" --acceptance "Checks" --consult "When to ask". scope B12 only reads; none or an empty string clears a field. In the inspector, use the More tab → Edit work scope. Only populated fields appear in the collapsed scope section.
- focus B12 prioritizes that box and its descendants; focus reads the selection, and focus none clears it. Other candidates remain in a separate group. Being listed does not authorize expanding scope or publishing.
- Missing required inputs warn on start by default but still allow the start. Supply --reason "Why starting early is appropriate" to proceed without a warning and save the reason in both activity and the log. Artifact-free done also remains warning-only by default. Existing output artifacts or --artifact count; reference material on the box does not.
- Only enable strict checks when selected for the plan: policy --start reject --done reject --unprepared reject. Each can return to warn. A recorded start reason overrides the missing-input rejection, but not the needs-detail one (add detail first). The artifact requirement also applies to set --status white. Human operations (UI / --actor human) are never rejected. Do not impersonate a human or weaken policy to bypass rejection.
- With guard enabled, scope writes, focus selection/clearing, and policy writes require --context-token. These changes print a new token: use it next. Read-only forms need no token.
- resume hides completed handoff bodies and shows their count. Request resume --include-completed only when history is needed; context / show can still read individual notes.
- descriptionUpdatedAt dates description changes; statusChangedAt dates status changes; handoffs use their existing at field. Notes predating a status change are marked. Unknown legacy dates stay unknown, and recency does not establish truth.
- After Done, CLI, inspector, and resume flag descriptions that may still describe an earlier state. Text is never rewritten automatically. Review it, then update with set B12 --note "Current description" (none clears it) or Notes in the UI.
- MCP: boxglow_scope / boxglow_focus / boxglow_policy, boxglow_claim, expect / self on boxglow_port, reason on boxglow_start, and includeCompleted on boxglow_resume. Pass contextToken for writes.
- All data fields are optional; schema v5 is unchanged. Old versions (0.4.2 and earlier) do not enforce these checks and drop workflowPolicy / focusBlockId when saving. Align all writers (CLI, serve, web app, bundled extension app) to a supporting build before using these settings. Check build time as well as version.


### Sync decisions

AI may only sync already bound projects and inspect comparisons. If sync stops for a conflict or a human choice, summarize the differences and use ask to notify the user. Never resolve conflicts, create a new binding, relink, recover, adopt, restore, or confirm an account. A human must use the UI or explicitly run CLI with --actor human. AI must never add --actor human, including after a chat answer; record the answer and wait for the human to apply the sync choice.

Codex must pass `--actor codex` on every CLI call; Claude Code must pass `--actor claude-code`. Execution markers may not survive a WSL boundary. Give subagents names such as `codex-task`; never impersonate a human.

### Claims for parallel work

When claims are enabled for the plan, fix a unique `BOXGLOW_INSTANCE_ID` for each independent CLI session. Do not share it between agents. Read `claims` and `context`, then acquire with `claim` (before adding detail or splitting) or `start` (to run); a claim taken with `claim` carries over to `start` (default block scope, `--scope subtree` for descendants). Keep the token from the successful CLAIM line and pass `--claim-token` on writes. MCP keeps its own instance ID and acquired receipts automatically. Renew with `claim-renew` / `boxglow_claim_renew` every 5 minutes (or within half the lease for shorter leases); checkpoint before handoff. done/leave releases the target claim. On expiry or a generation mismatch, reread context and acquire again. The same actor name does not make another instance yours. Ask a person to change claim settings, force release, or resolve sync conflicts; never impersonate human. Synced copies on different devices are not protected by a distributed lock. See `docs/CLAIMS.md`.

Never use another instance’s ID or receipt, including receipts reconstructed from plan data or claims output. After MCP restarts, the same actor is still a different instance: wait for expiry or ask a person to release it; never take it over automatically.

Automatically promoted inputs belong to the original box’s scope. Changes to shared input content or other boxes’ layout require claims for all affected boxes. For plan settings such as focus or group, use `context root` → `claim root` and pass that CLAIM receipt (`start root` also works, but `claim` does not mark it in progress). A block-scoped root claim does not include ordinary boxes and is sufficient for plan settings. A subtree claim on root blocks all parallel work: AI agents must not use it and must consult a person. End it with `leave root`. Context-guard tokens are still required.

---

Human-only sync operations prevent accidental actions; they are not enforced authorization or OS-level isolation. AI must never identify itself with `--actor human`. Report the comparison and stop reason to the user. MCP and AI-identified CLI output do not provide executable human choice commands.

Human CLI actions also accept `--actor human:name`; AI must not impersonate a human using either form. The `boxglow sync --help` hint in AI halt output is for humans who inherited an AI environment, not permission for AI to apply their choice.
