---
name: visual-plan
description: Turn a supplied plan, a named feature, or this task's latest plan into a visual Unpaged board for review in the same Codex task. Use review-plan for incoming comments, status, recovery, or stopping an existing review.
---

# Unpaged visual plan

Create a board the user can review by commenting on its specific parts. This is
the creation entry point for this plugin's own
[review-plan skill](../review-plan/SKILL.md), not an external planning framework.
Read that skill before board operations. It owns connection discovery, the
document/task binding, versioned status, listener, feedback, and acceptance.
Apply the instructions below to its creation flow; create the document once.

## Resolve the plan

Use this order:

1. An explicit plan supplied by the user is the source to render.
2. For a named topic or feature, use the matching plan already in this task.
3. If the user names a feature without an existing plan, use relevant project
   facts to draft a plan first. Label it as a fresh draft for human review.
4. Without new plan text or a topic, use this task's most recent plan.
5. If there is no plan or topic, ask for that input; do not invent a project.

Preserve the plan's phases, tasks, order, constraints, risks, and acceptance
criteria. Shorten overview labels only when the full meaning remains available
on the board. Do not add work or merge phases just to simplify the drawing.
For spec driven development, record the authoritative spec's path and revision
and carry its stable requirement IDs into the relevant plan items. The board
does not silently synchronize repository files or grant implementation authority.

## Choose the folder

Honor the user's explicit folder choice when calling `document_create`:

- An existing folder ID uses `folderId`. A supplied name uses `folder`; resolve
  ambiguity with `folder_list` when needed. Supply only one of these parameters.
- An explicit Unfiled choice omits both parameters on creation.
- Otherwise use `folderId: "visual-plans"`, the reserved folder created on demand.

Give the board a recognizable title such as `<project>: <plan title>`. Read back
the created document and its filing through `document_list`/`folder_list` before
claiming it is in the requested folder. Report the actual display name if the
reserved folder was renamed. A `folderWarning` means the board already exists;
keep its ID, report the filing problem, and continue rendering that document.
Do not create a duplicate or silently retry with a different destination. If a
create response is uncertain, establish whether the document exists before retrying.

## Build a useful board

Use the root node as the overview:

- A readable title and concise goal.
- One phase or major step per rectangle, arranged in the plan's execution order.
  Use anchored connectors for actual dependencies; do not invent dependencies.
- Notes for stated risks, assumptions, and open decisions.
- One dedicated status element, kept separate from plan content. Let review-plan
  set its version and acceptance phrase; approval must not stamp it EXECUTING.

For a small plan, keep its task checklist and verification criteria on the root.
For a larger plan, use `node_create_with_elements` for phase child nodes with
task checklists, the relevant requirement IDs, and stated verification criteria.
Keep overview wording concise while preserving complete task detail in those nodes.

Use the discovered schemas for `batch_create_elements`, connectors, checklists,
and node creation. Space content without overlaps and enlarge the canvas before
placing elements beyond its bounds. Read back all created nodes and elements,
check the plan's fidelity and bounds, then inspect the rendered overview and
detail canvases through a read-only browser view. Correct layout through MCP.
If rendered QA is unavailable, report that limit rather than claim a visual pass.
Use current revisions for subsequent edits, as required by review-plan.

## Hand over the review

Continue the same review-plan creation flow for the digest, versioned status,
board-bound listener, and verified connection state. Respect any explicit request
to render only or not listen: prepare the board without arming a listener and
state that mode. For an existing binding, use its status and recovery flow;
never mint a replacement key or bind another task just to run visual-plan again.

Return the edit link, actual folder, and verified review state. When listening
is established, invite an `@agent` comment and end the turn so idle delivery can
occur. Do not promise delivery while Codex is closed or the computer is asleep.
Agents reply and leave threads open; humans resolve them and explicitly accept
the current plan version. Acceptance alone does not start implementation.
