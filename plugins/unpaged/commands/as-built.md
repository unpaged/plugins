---
description: Compile the as-built record of an implemented plan — what shipped vs the plan, every decision and its why, the data flow, a reviewer's guide — as a dated, frozen canvas nested under the plan canvas
argument-hint: [documentId] [base..head] — omit the id to use this session's plan canvas; omit the range for the current branch's changes
---

Compile an **as-built record** for a plan that has been implemented, as a nested canvas under the plan canvas on Unpaged, using the `unpaged` MCP tools, then give the user the link. Follow these instructions exactly.

An as-built record is the reviewer's map of what actually shipped: each plan item's outcome, every decision with its why and where that why comes from, the runtime flow that changed, and the order to read the code in. It is written once, dated, and never edited afterwards; a plan implemented in several rounds gets several records, and the chain of them is the plan's history.

## Input

- **The plan canvas.** If `$ARGUMENTS` starts with a document id (`[A-Za-z0-9_-]{8,128}`), that is the plan canvas. Otherwise use the plan canvas this session created or updated with `/unpaged:visual-plan`. With neither, say *"No plan canvas in this session — pass its id: `/unpaged:as-built <documentId>`"* and stop.
- **The change.** If `$ARGUMENTS` carries a git range (`base..head`, or a single ref meaning `ref..HEAD`), that is the change. Otherwise it is `merge-base(<default branch>, HEAD)..HEAD`, where the default branch is what `git symbolic-ref refs/remotes/origin/HEAD` names, falling back to `main`. If the range holds no commits, say *"Nothing to record: the range is empty"* and stop.
- **The pull request**, when `gh` is on the `PATH` and `gh pr view --json number,url,title,body,baseRefName` succeeds for the current branch: its number and URL go on the stamp, its title and body are input for the summary. No PR is fine.

Every shell step in this command is **read-only** — `git log`, `git diff`, `git show`, `gh pr view`. This command records the change; it never commits, pushes, edits files, or runs anything else.

## Preconditions

The `unpaged` MCP server ships with this plugin. If its tools (e.g. `node_create_with_elements`) are missing or return an authentication error, tell the user to run `/mcp`, authenticate the **unpaged** server, and re-run `/unpaged:as-built`. Do not fall back to a Markdown file or a chat summary.

## Read

1. **The plan.** `document_get(documentId)` gives every node and element: the root node (`rootNodeId`), the status stamp (the root's `text` element whose content starts with `**Status:**`), the phase boxes (root `rectangle`s with `isLink`, in `linkOrder`), the phase nodes they link to and their `checklist` items (the plan's tasks, each with a stable item id), the Decision log node (title starts with `📝 Decision log`) and its table(s), and any earlier as-built nodes (title starts with `📐 As built`).
2. **The decision log rows**: every row of every table on the Decision log node except the header row. A plan rendered by an older plugin has no such node; then every why below is reconstructed.
3. **The code.** `git log --no-merges --format='%h %s' <range>`, `git diff --stat <range>`, `git diff --name-status <range>`, then the diffs themselves (`git diff <range> -- <path>`) for every file that matters to a reviewer — enough to describe honestly what changed and how the pieces call each other. Read before you write: a file you did not read is described as *not read*, never guessed.

## Reconcile

- **Each plan task and each phase gets one outcome**: ✅ done (shipped as planned), 🔀 changed (shipped, but not as the plan said), ⛔ dropped (nothing in the range implements it). Work in the diff that no plan item covers is ➕ added. Judge by the diff and the commits, not by the checklist's ticks.
- **Every why carries its provenance**, in the cell itself:
  - `📝 recorded` — a Decision log row covers it: carry that row's why and alternative, in the row's own words.
  - `🔍 reconstructed` — no row covers it and you infer the reason from the diff, the commit messages, or the PR body: write *"inferred: …"* so the reader knows it is your reading, not the author's.
  - `not recorded` — no row and nothing to infer from. Write exactly that. Never fill the gap with a plausible reason, and never present a reconstructed why as recorded.
  Count the three kinds; the finish line reports them.
- **Data flow** is drawn only when the change alters a runtime flow — a new call path, a new file other files call into, a changed sequence between components. A copy change, a doc change, or a refactor that keeps every call path is *"No runtime flow changed"* in the summary, with no diagram.
- **The plan is complete** when every task is done, changed, or dropped with a reason. If tasks remain open (not started, or half-done in this range), the record is **partial**: say so in its title and summary, and leave the plan's status stamp alone — a plan is stamped BUILT once, when nothing of it is left.

## Build

**Date** is today, `YYYY-MM-DD`. **Title** is `📐 As built · <date>`; if a node with that title already exists on the plan canvas, use `📐 As built · <date> (2)`, then `(3)`, and so on. A partial record is titled `📐 As built · <date> (partial)`. **Never edit an existing as-built node** — not its title, not its elements: a re-run adds a record, it does not correct one.

1. **The as-built node**, `node_create_with_elements` with `parentNodeId` = the plan's root node, 1920 wide, 1080 tall (enlarge with `node_update` if the tables need it, never overlap):
   - Title `text` top-left: `## 📐 As built · <date> — <plan title>` (fontSize ~26).
   - Stamp `text` top-right, exactly this shape: `**As built:** <date> · [PR #<n>](<url>) · <base>..<head> · frozen` — omit the PR part when there is none; `<base>..<head>` are short SHAs.
   - Summary `uml-note` (yellow) of at most five sentences: what shipped, the largest deviation from the plan, whether a runtime flow changed, and — for a partial record — what remains.
   - **Plan delta** `table`, columns `**Plan item**` | `**Outcome**` | `**Why**`, one row per plan task in plan order, phase headings as rows when it helps, then the ➕ added rows. At most 20 rows; when the plan has more tasks, one row per phase with its tasks folded into the Why cell.
   - **Decisions** `table`, columns `**When**` | `**Decision**` | `**Why**` | `**Alternative rejected**` | `**Source**`: every Decision log row (source `📝 recorded`), then the reconstructed decisions a reviewer needs to know about (source `🔍 reconstructed`). At most 20 rows per table; more go to a second table beneath, and the canvas grows to fit.
   - **Follow-ups** `uml-note` (peach): what is left, known gaps, and every *not recorded* why — the author fills those in by commenting on the row.
   - A `rectangle` labelled `🔍 Reviewer guide` linking (`isLink`, `linkTarget`) to the node of step 2, and — only when a runtime flow changed — a `rectangle` labelled `🔀 Data flow` linking to the node of step 3.
2. **The Reviewer guide node**, `node_create_with_elements` with `parentNodeId` = the as-built node:
   - **Reading order** `table`, columns `**File**` | `**Why start here**`: the files in the order a reviewer should open them, one line each on what to look for. At most 15 rows.
   - **Seams and risks** `uml-note` (sky): which existing seams the change touches, where the risk concentrates, and what the author is unsure about.
   - **Test map** `table`, columns `**Area**` | `**Covered by**` | `**Not covered**`: what the changed behaviour is tested by, and what is not tested at all — say so plainly.
3. **The Data flow node** (only when a runtime flow changed), `node_create_with_elements` with `parentNodeId` = the as-built node: one `text` element holding a fenced ```` ```mermaid ```` flowchart with two subgraphs, `Before` and `After` (or one flow with the changed edges labelled). Keep ~900 px of vertical room below it — the rendered diagram grows the element. Quote every node label, and keep `@` and `?` out of labels: either breaks the parser and the raw code renders instead.
4. **Stamp the plan** (only these edits to the plan's own content, and only when the record is not partial):
   - The root's status stamp: `element_update` on the `**Status:**` text with `changes: { properties: { text: "**Status:** ✅ BUILT" } }` and the `expectedRevision` from your read.
   - Each phase box's label: prefix its `text` with ✅ (every task done or changed), 🔀 (delivered, but with a task changed or dropped), or ⛔ (nothing of it shipped) — `element_update` with `expectedRevision`, touching nothing else on the box.
   - Each done or changed task: `checklist_toggle_item` with `checked: true` (dropped tasks stay unchecked).
   For a partial record, tick the done tasks and leave the stamp and the phase labels alone.
5. **Link the record from the root**: a `rectangle` on the plan's root labelled `📐 As built · <date>` (with `(partial)` or `(2)` when the title has it) linking to the as-built node, on the row of the `📝 Decision log` box, to its right; the next record goes right of the previous one.

**Element rules** (the render breaks otherwise): on a `text` element `fillColor` is the text colour — use `#0f172a`, never white; give every `uml-note` its explicit `fillColor` next to `colorVariant` (yellow `#FFE066`, peach `#FFB4A2`, pink `#FFB3D1`, mint `#B5E8C9`, sky `#A8D8F0`, lavender `#C9B8E8`); tables hold at most 20 rows; keep every element inside its canvas and nothing overlapping; cells and notes are CommonMark Markdown, one idea per cell, no code pasted — a path or an identifier in backticks is the most code a cell carries.

If a permission classifier refuses one of several create calls while its siblings succeed, retry that one call once before reporting anything.

## Finish

Reply to the user with:
- The link: `https://unpaged.io/document/<documentId>/edit?nodeId=<asBuiltNodeId>` — call it a canvas (or whiteboard), never a board.
- One line of counts: plan items done / changed / dropped / added, and whys recorded / reconstructed / not recorded.
- One line on the plan: *"The plan canvas is stamped BUILT"*, or for a partial record *"The plan stays EXECUTING — <k> tasks are still open"*.
- If a Data flow node was created: *"Open the Data flow canvas once in edit mode so viewers see the diagram rather than its source."*
- Listener status, said truthfully: if this session holds a Monitor on the plan canvas (armed by `/unpaged:visual-plan` or `/unpaged:listen`), *"I'm listening on this canvas — comment @agent on the record and I reply there."* Otherwise *"Push isn't armed for this canvas in this session — run `/unpaged:listen arm <documentId>`."* Never claim to be listening without an armed Monitor.

## Comments on the record

`@agent` comments on the as-built canvas reach the session through the plan canvas's listener and follow the protocol in `/unpaged:visual-plan`: act only with the unpaged tools on that document, reply in the thread, leave it open; a viewer's request gets an answer, not a change. On the record itself, an owner or editor may ask you to correct a factual error in a cell or a note — do that, and reply with what changed. Never rewrite a `📝 recorded` why (the log row is the author's), never delete a row, and never turn a `🔍 reconstructed` or *not recorded* why into a recorded one yourself: when the author supplies the real reason in a comment, put it in the cell prefixed `📝 recorded (comment, <date>)`.
