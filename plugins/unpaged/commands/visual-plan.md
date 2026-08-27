---
description: Render the current plan — or plan the feature you name — as a visual board on UnPaged and return the link
argument-hint: [plan text, or a feature to plan — omit to use the plan in this conversation]
---

Render a plan as a visual board on UnPaged using the `unpaged` MCP tools, then give the user the link. Follow these instructions exactly.

## Input

Resolve what to render, in this order:

- If `$ARGUMENTS` is itself a plan (it spells out steps or phases), that text is the plan.
- If `$ARGUMENTS` names a topic or feature and the conversation already contains a plan for it, use that plan.
- If `$ARGUMENTS` names a topic or feature and the conversation holds no plan for it, **draft the plan first, then render it**: explore the codebase enough to ground the plan (relevant files, existing patterns, constraints), write a normal phased implementation plan, and render that draft. This makes `/visual-plan <feature>` work as the first command of a session. Mention in your reply that the board is a fresh draft for their review.
- With no arguments, use the most recent plan in this conversation — plan-mode output you presented, approved or not.
- With no arguments and no plan in the conversation, say so and stop. Never invent a plan the user didn't ask for just to have something to render.

## Preconditions

The `unpaged` MCP server ships with this plugin. If its tools (e.g. `document_create`) are missing or return an authentication error, tell the user to run `/mcp`, authenticate the **unpaged** server (sign in with their UnPaged account — free tier works), and re-run `/visual-plan`. Do not fall back to ASCII art, Mermaid in chat, or a local file.

## Build the board

1. **Create the document** with `document_create`. Title: `<project name>: <short plan title>` (project = repo directory name or the obvious subject). The document lands in the user's own UnPaged account — you are acting with their identity.

2. **Lay out the root node as the overview.** Create elements with `batch_create_elements` (atomic). The root canvas is the picture of the whole plan:
   - A title `text` element at the top (Markdown heading, fontSize ~28).
   - A status stamp: a `text` element near the top-right whose content is exactly `**Status:** 📋 PROPOSED` — the plan-approval hook looks for the `**Status:**` prefix later, so keep it verbatim.
   - One `rectangle` per phase/major step, laid out left-to-right or top-down in execution order, each labeled with the phase name, connected with `connector` elements (use anchors) to show sequence/dependencies.
   - A `uml-note` with the plan's goal and any key risks or open questions.

3. **One child node per phase** when the plan has distinct phases (use `node_create_with_elements`); skip child nodes for small single-phase plans and put the task list on the root instead. Each phase node carries:
   - A `checklist` element with that phase's tasks as items (unchecked).
   - A `uml-note` for that phase's verification/exit criteria when the plan states them.

4. **Layout discipline:** space elements generously (no overlaps), keep tables ≤20 rows, keep every element inside the canvas — enlarge the node first via `node_update` (`canvasWidth`/`canvasHeight`) if content needs room. Cell/label/text content is CommonMark Markdown.

5. **Fidelity:** the board reproduces the plan as written — same phases, same tasks, same order. Do not add tasks, merge phases, or editorialize. Trim wording only to fit labels.

## Finish

Reply to the user with:
- The edit link: `https://unpaged.io/document/<documentId>/edit`
- One sentence: comments they leave on the board (mention `@agent`) can be swept back into the session with the unpaged comment tools; approving the plan will stamp the board EXECUTING.

Remember the document ID — if the plan is approved later in this session, you will be asked to update this board's status stamp.
