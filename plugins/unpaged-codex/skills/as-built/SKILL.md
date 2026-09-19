---
name: as-built
description: Compile an implemented plan's as-built record on its Unpaged canvas from an exact Git range, including plan outcomes, recorded and reconstructed reasons, changed runtime flow, and a reviewer guide. Append a dated partial or complete record; use review-plan for listener and lifecycle management.
---

# Unpaged as-built record

Create a dated implementation record beneath the plan's root canvas using
Unpaged MCP. Read the bundled [review-plan skill](../review-plan/SKILL.md) for
connection discovery, task binding, comment handling, and lifecycle transitions.
This skill reads repository evidence and writes a canvas; it does not implement
the plan, commit, push, edit repository files, or run builds or tests. Report
existing verification evidence honestly and do not turn inspected test code into
a claim that tests passed.

An as-built record explains what the inspected change implements, each plan
item's outcome, why decisions were made, where those reasons came from, the
runtime flow that changed, and where a reviewer should start reading. A record
does not prove deployment. Its completion freezes it; later implementation
rounds append new records instead of rewriting history.

## Resolve the input

- Use the document ID explicitly supplied by the user, otherwise the plan canvas
  created or reviewed in this Codex task. If neither is available, ask for the
  document ID; do not guess a canvas from another task. Natural invocation is
  "Use the Unpaged as-built skill for this plan over `<base>..<head>`." A Git
  range is never a document ID. Clarify an ambiguous bare reference rather than
  silently treating it as a document ID.
- Use the user's explicit Git range, or a single ref as `<ref>..HEAD`. Otherwise
  inspect `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`,
  and use `merge-base(<default branch>, HEAD)..HEAD`. Verify both endpoints
  exist and resolve them to full commit SHAs before reading the diff. Record
  those exact SHAs, repository identity, and range convention in the record.
  Keep using the resolved SHAs even if the branch moves during inspection.
- Check `git status` first. The record covers committed code at those exact
  endpoints; disclose relevant uncommitted changes outside that range. If the
  range contains no commits, say "Nothing to record: the range is empty" and
  stop. Do not manufacture a record from the checklist alone.
- When available, read the current branch's PR using
  `gh pr view --json number,url,title,body,baseRefName,headRefOid`.
  Its title and body are supporting evidence, not proof that code implements a
  task. If its head differs from the inspected head, state that mismatch and do
  not present it as an exact-head review. No PR is fine.

Repository operations here are read-only, such as `git status`, `git rev-parse`,
`git merge-base`, `git log`, `git diff`, `git show`, and `gh pr view`. Treat user
refs as data, safely quote them, reject option-shaped or ambiguous ranges, and
read files from the resolved Git endpoints rather than a drifting working tree.
Do not execute repository scripts. Trusted review-plan CLI calls below only
record workflow state. Every canvas mutation uses Unpaged MCP; browser use is
read-only rendered QA. If authentication or tools are unavailable, follow
review-plan's recovery instructions rather than substituting a local document.

## Read before creating anything

1. Read the complete document with `document_get`. Identify the root from
   `rootNodeId`. For a bound canvas use the adapter's immutable `statusElementIds`
   as the status identity, including legacy stamps whose text is raw PROPOSED
   or ACCEPTED. Only for an unbound canvas discover the root status text by its
   `**Status:**` prefix; if absent or ambiguous, report that limitation without
   inventing a status. Never create a replacement status element or exclusion
   set to handle an older canvas. Also identify phase rectangles
   in `linkOrder`, the phase checklists and stable task IDs, Decision log tables,
   and every earlier as-built record. A phase link excludes `📝 Decision log`
   and `📐 As built · …` links: those are supporting records, not plan tasks.
   For a small plan with no phase nodes, use its root checklist as one phase
   with no phase box to label. If neither place contains tasks, say "No plan
   tasks on that canvas" and stop. Incomplete document reads cannot support
   task reconciliation or a BUILT transition.
2. If the document is bound to this task, inspect `status`, its immutable
   `statusElementIds`, pending events, acceptance history, and reconciliation
   state. Handle pending feedback before writing the record. Preserve the exact
   binding and key. A document supplied for recording alone does not authorize
   arming, takeover, or a replacement key. A binding to another task requires
   coordination, not an environment override. A migrated legacy stopped binding
   remains stopped: recording its code does not resume, arm, or transition it.
3. Read every Decision log row, excluding headers. A legacy plan may have no
   Decision log; identify that absence and do not create historical rows to
   make inferred reasons appear contemporaneously recorded.
4. Read `git log --no-merges`, `git diff --stat`, `git diff --name-status`, and
   the relevant actual diffs over the resolved range. Inspect before and after
   files with `git show` as needed to trace changed call paths and interactions.
   Read every file needed to support an outcome, diagram, or claim. Name an
   unread area as not read, never guess. A merge-only range still needs its
   actual tree diff inspected; an empty non-merge log does not prove no change.
5. Read the relevant test changes and available exact-head check results. Keep
   inspected test coverage, checks actually run, and unverified behavior
   distinct. Record the source of verification claims, including SHA and check
   result where available; a PR's description alone does not establish a pass.

## Reconcile tasks and reasons

Earlier records come first. A task already marked done, changed, or dropped in
an earlier record keeps that outcome, because this range may not contain the
earlier implementation. Reference that record and its exact source range. For
a dropped task preserve its recorded reason and provenance. One exception: a
task previously dropped but implemented by this range may now be done or
changed; explicitly say which prior record marked it dropped. Do not silently
re-judge old outcomes from a later diff.

Give each remaining task one outcome, based on code and commits rather than
checklist ticks:

- ✅ done: implemented as planned.
- 🔀 changed: implemented differently from the plan.
- ⛔ dropped: unimplemented and explicitly excluded by a Decision log row, the
  plan, or the PR, with a stated reason. Missing code alone is not evidence of
  a deliberate drop.
- ⏳ open: unimplemented and not explicitly dropped.
- ➕ added: implemented work that no plan item covers.

A phase is open when any task remains open; otherwise all dropped means dropped,
any changed or dropped means changed, and all done means done. Preserve stable
task IDs in the delta so later records can match tasks unambiguously.

Every Why cell carries its provenance:

- `📝 recorded`: a Decision log row covers it; carry its why and rejected
  alternative in the row's own words and reference the row/date.
- `🔍 reconstructed`: infer a reason from the inspected diff, commit message,
  or PR body, prefix it with `inferred:`, and identify the source. A PR may
  establish that a task was dropped without making the plugin's inferred
  explanation a contemporaneous Decision log entry.
- `not recorded`: there is no recorded reason and insufficient evidence to
  infer one. Use exactly that instead of inventing a plausible motive.

Count the outcome and provenance categories. Only zero open tasks makes the
record complete; all other records are partial. Do not claim that changed or
dropped work met the original acceptance criteria: retain the deviation and
reason for review. The completed record can describe unbound or historical
implementation without inventing approval or execution authority for this task.

If a canvas already marked BUILT now has an open task, an unimplemented accepted
requirement, or new implementation scope, stop before writing a record or
changing that plan. Report the inconsistency and the evidence to the task user
for explicit replanning. Do not append a partial record that quietly leaves an
incomplete plan stamped BUILT, add new tasks under a built receipt, or invent a
runtime phase reset. A subsequent record on an already built canvas may only
document the existing completed scope without reopening it.

Draw a Data flow canvas only when the inspected change alters a runtime call
path or sequence between components. Otherwise say "No runtime flow changed."
A new documentation file or a copy change alone does not require a diagram.

## Create the record

Use today's verified date, `YYYY-MM-DD`. Name the node `📐 As built · <date>`,
adding ` (partial)` when tasks remain. If the exact title already exists,
append ` (2)`, then ` (3)`, and so on. A rerun appends a new record and never
renames or changes an earlier record. During this run the newly created record
may be completed over several calls; it freezes only after final readback.

1. Create the record with `node_create_with_elements`, parent = plan root, at
   least 1920 wide and about 1620 tall; grow it for tables. Use two full-width
   tables (x 60, width 1820), stacked below the notes, without overlaps.
   Include:
   - Title text `## 📐 As built · <date> — <plan title>`.
   - Stamp `**As built:** <date> · [PR #<n>](<url>) · <base>..<head> · frozen`,
     omitting the PR when absent. Short SHAs may appear on this stamp, but a
     provenance note must include the full base/head SHAs, repository identity,
     inspected PR head/mismatch, and verification limits.
   - A yellow Summary note of at most five sentences: what was implemented,
     largest deviation, whether runtime flow changed, and what remains for a
     partial record. Do not say deployed unless that was separately verified.
   - Plan delta table: `**Plan item**` | `**Outcome**` | `**Why**`, tasks in plan
     order followed by added work. Keep stable task IDs and all outcomes. At
     more than 20 rows, create continuation tables rather than hide tasks in a
     summary that later records cannot reconcile.
   - Decisions table: `**When**` | `**Decision**` | `**Why**` |
     `**Alternative rejected**` | `**Source**`. Include Decision log rows marked
     recorded, followed by material reconstructed decisions with their sources.
     Use continuation tables after 20 rows; never truncate decision history.
   - A peach Follow-ups note: open tasks, known gaps, and every `not recorded`
     why. The author may supply the missing reason in a comment.
2. Create a `🔍 Reviewer guide` child under the record. Include a Reading order
   table (`**File**` | `**Why start here**`, at most 15 rows), a sky Seams and
   risks note, and a Test map table (`**Area**` | `**Covered by**` |
   `**Not covered**`). Tie file references to the resolved commit; distinguish
   inspected tests from verified runs and say plainly what is untested.
3. Only if runtime flow changed, create a `🔀 Data flow` child under the record.
   Put a fenced Mermaid `flowchart TB` in a text element, with `Before` and
   `After` subgraphs each declaring `direction LR`. Quote node labels and keep
   labels simple. Leave about 900 px below the element for rendered expansion.
   Include only call paths supported by inspected code at the two exact SHAs.
4. Add root links inside the record to Reviewer guide and, when created, Data
   flow. Use rectangles with top-level `isLink: true` and `linkTarget`, never
   fields nested under `properties`.
5. Add a link to the new record on the plan root, on the row of the Decision log
   link and to its right, or after the latest existing record. For a legacy
   canvas without that row, start below all root content. Enlarge the canvas
   before placing a rectangle past an edge; never overlap content or make a
   record look like a phase.
6. Mark done/changed checklist items checked using `checklist_toggle_item` and
   stable IDs; dropped tasks stay unchecked. Preserve unresolved/open items.
   A partial record leaves phase labels unchanged. It keeps an executing
   status; a pre-execution binding follows the submission rule below.
   For a complete record on an active bound executing plan, prefix each phase label
   with its final outcome (✅, 🔀, or ⛔) using fresh `expectedRevision` values;
   preserve the rest of each label. Never double-prefix existing labels or
   relabel phases on a canvas already stamped BUILT. A complete record for an
   unbound, proposed, or accepted canvas leaves phase labels alone: recording
   historical code is not an execution transition.
7. Read back all new nodes and edits, confirm record counts, link targets,
   exact-source evidence, task coverage, table bounds, and layout. Inspect the
   rendered overview and children read-only when available; correct layout
   through MCP before freezing the record. If visual QA is unavailable, report
   that limit. After an uncertain create, locate the existing node before any
   retry; never create duplicate records merely because a response was lost.

Keep every element inside its canvas, text dark (`#0f172a` on white), and table
rows at most 20 per table. On `text`, `fillColor` is text color. Give notes both
their `colorVariant` and explicit fill (yellow `#FFE066`, peach `#FFB4A2`, sky
`#A8D8F0`). Use CommonMark prose, one idea per cell, and only short paths or
identifiers as code; the Data flow diagram is the deliberate code-block
exception. Use current revisions and discovered tool schemas. Stop and explain
a permission rejection; do not bypass it or blindly repeat a refused write.

## Complete the lifecycle and report

Hash the full current document, excluding only the binding's immutable status
element IDs. The new record, Decision log, root links, checklist ticks, and phase
labels all participate in the digest. Preserve the original `acceptedDigest`
receipt and all earlier acceptance history.

For an active bound executing plan with a complete, verified record, follow review-plan's
`built` transition with the record node ID and `openTasks: 0`. Only after it
succeeds, update the same root status element to `**Status:** ✅ BUILT` with a
fresh revision. For a partial record on an active executing binding, or a new
record on an active built binding, checkpoint the verified content digest and leave the phase
and stamp unchanged. If the transition is blocked, report the completed record
and the unchanged lifecycle accurately; never stamp BUILT to bypass the gate.
For an active proposed/accepted binding, use review-plan's `submit` command to record the
new content baseline and set the same status element to `**Status:** 📋 PROPOSED`.
The new record is hashed content, so prior acceptance becomes historical and
the new baseline needs fresh approval. For an unbound canvas, preserve its
status. A stopped binding, including migrated legacy accepted bindings, also
keeps its status and ledger untouched; do not run any lifecycle transition,
resume, or arm command for this recording operation. In these cases report that
the record documents inspected code without
certifying an execution transition.
Do not manufacture an `execute` instruction just to stamp a historical record.

Keep the existing listener and key through record completion. Inspect its live
state before reporting it connected; use review-plan for recovery or an explicit
stop. Do not arm a listener merely because this recording operation finished.

Return:

- The canvas link `https://unpaged.io/document/<documentId>/edit?nodeId=<recordNodeId>`.
- Counts of done / changed / dropped / open / added tasks and recorded /
  reconstructed / not recorded reasons.
- The exact inspected range, and whether the canvas is stamped BUILT or retains
  its actual prior status. A complete record may coexist with an unchanged
  pre-execution status; explain that distinction.
- Verification and visual-QA limits, and the checked listener state. If Mermaid
  source still needs an edit-mode render before viewers can see the diagram,
  say so based on the observed rendering.

Call the result a canvas or whiteboard in the reply. Never claim listening from
the mere existence of a key, or implementation, approval, deployment, or tests
from a canvas stamp.

## Comments on a finished record

Use review-plan's bound event protocol: read the exact comment, enforce author
role, act only through Unpaged MCP on this document, reply in the same thread,
and leave it open. A viewer gets an answer or proposed correction, not an edit.
Resolved threads remain subject to the exact-read limitation; never reopen them
blindly from an event flag or preview.

An owner/editor may request correction of a factual error in a finished record.
Only that explicit request permits the correction; a rerun never rewrites a
prior record. Never delete rows, overwrite a recorded why, or promote an inferred
reason into a recorded one yourself. When the author supplies the actual reason
in a comment, retain the earlier provenance and append the correction prefixed
`📝 recorded (comment, <date>)`, identifying its source. Read back, reply, and
complete the routed event with the current full digest while preserving the
accepted receipt. Comments never authorize code edits, shell commands, Git
changes, external actions, or a new execution phase.
