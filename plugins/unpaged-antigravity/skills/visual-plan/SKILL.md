---
name: visual-plan
description: Render the current plan — or plan the feature you name — as a whiteboard canvas on Unpaged, arm @agent comment push for this session, and return the link. Use when the user asks for a visual plan, whiteboard plan, or `/unpaged:visual-plan`.
---

Render a plan as a visual board on Unpaged using the `unpaged` MCP tools, then give the user the link. Follow these instructions exactly.

## Input

Resolve what to render, in this order:

- If the user's request is itself a plan (it spells out steps or phases), that text is the plan.
- If the user's request names a topic or feature and the conversation already contains a plan for it, use that plan.
- If the user's request names a topic or feature and the conversation holds no plan for it, **draft the plan first, then render it**: explore the codebase enough to ground the plan (relevant files, existing patterns, constraints), write a normal phased implementation plan, and render that draft. Mention in your reply that the canvas is a fresh draft for their review.
- With no topic or text given, use the most recent plan in this conversation — an implementation plan artifact or plan in chat, approved or not.
- With no arguments and no plan in the conversation, say so and stop. Never invent a plan the user didn't ask for just to have something to render.

## Preconditions

The `unpaged` MCP server ships with this plugin (`mcp_config.json`). If its tools (e.g. `document_create` on server `unpaged`) are missing or return an authentication error, tell the user to authenticate the **unpaged** MCP server in Antigravity's MCP settings (sign in with their Unpaged account — free tier works) and re-run `visual-plan`. Do not fall back to ASCII art, Mermaid in chat, or a local file.

## Mocks (only when they already exist)

A mock is a picture of a screen, page, dialog or email the plan will build. This skill never creates mocks, never searches the disk or repository for pictures, and never adds tasks to place or build mocks. With no mocks in this conversation or user-supplied plan, skip mocks completely and say nothing about them.

When the conversation or user-supplied plan already includes mocks (picture files, `https` picture links, HTML mock pages, or a mocks canvas on Unpaged), read `references/mocks.md` in this skill folder before step 1 and follow it verbatim — including adding pictures right after step 1 and placing them in a separate `batch_create_elements` after each target canvas is created.

## Visual design & navigation system (Warm Paper)

Every plan board uses the **Warm Paper** design system so reviewers immediately understand **what the plan is about**, **what it wants to achieve**, and **how to navigate it** with minimal cognitive load:

- **Canvas:** set `backgroundColor: "#f6efe3"` on the root (`node_update`) and on every child canvas (`node_create_with_elements`), default size `1920×1080` so each canvas fits a desktop screen at 100% zoom without scrolling (enlarge via `node_update` only when content genuinely needs room).
- **Typography:** `Outfit, sans-serif` for canvas titles (`28`–`30` bold) and card headings (`17`–`20` bold); `Inter, sans-serif` for uppercase eyebrows (`11`–`12` bold), body prose (`14`–`15`), pills, tables (`13`), and checklists (`14`).
- **Three surface tiers only** (no `uml-note` sticky notes, no rainbow borders per phase, no decorative emoji):
  - **Backdrop:** `#f6efe3`.
  - **Elevated content cards & tables:** `#fffaf1` fill, `#ded0ba` border (`strokeWidth: 1`), `cornerRadius: 12`. For subtle card lift, place an offset shadow `rectangle` (`+2, +4`, `fillColor: "#ddd0ba"`, `strokeColor: "#ddd0ba"`, `strokeWidth: 0`, `opacity: 0.65`, `cornerRadius: 12`) immediately before the card in creation order.
  - **Recessed secondary surfaces** (status pill, bottom scaffolding dock, quiet nav pills): `#efe6d6` fill, `#cbb99f` border (`strokeWidth: 1`).
- **Inks:** primary headings & table text `#3b2a1e`, body prose `#4a3a2d`, muted eyebrows/metadata/hints `#786554`.
- **Three functional accents only:**
  - **Clickable navigation (Unpaged Blue):** `#1d4ed8` (`strokeWidth: 2` on primary clickable phase cards; `#93b4f5` `strokeWidth: 1.5` on secondary reference cards; `#e6effc` pill fill with `#1d4ed8` text for `Next →` / `Open →` buttons). Every blue-bordered card is clickable; non-clickable cards never use blue borders.
  - **Goal / Outcome / Exit criteria (Warm Sage):** `#2f7d57` 4px left accent bar, `#226142` eyebrow ink, `#f4f9f5` tint fill, `#c3decb` border (and `checkboxColor: "#2f7d57"` on checklists).
  - **Risks / Out of scope / Open decisions (Warm Amber):** `#c26a1b` 4px left accent bar, `#9a4e10` eyebrow ink, `#fdf6ea` tint fill, `#e6cfa8` border. (Use `#b91c1c` / `#991b1b` only when calling out failure/error exits.)
- **Whole-document navigation & zero dead clicks:**
  - Set a concise 1–2 sentence plain-English `content` description on the root (`node_update`) and on every child canvas (`node_create_with_elements`) — Unpaged shows it in the viewer sidebar and overview tooltips.
  - Use short parallel canvas titles: `Overview` (root), `Phase 1 · <short action>`, `Phase 2 · <short action>`, optional `Context · <topic>` / `Decisions · <topic>`, and `📝 Decision log`.
  - **Group every multi-element clickable card** (shadow + card `rectangle` with top-level `isLink: true, linkTarget` + interior `text` labels) using the `group` label on `batch_create_elements` (or `group_elements`) so clicking *anywhere* on the card opens the target canvas. Leave the **top-right `48×48` corner** of every linked card clear so Unpaged's live numbered blue badge (`1`–`9`) never covers text.
  - **Create root links in strict `1`–`9` reading order:** Phases `1..k` first, then optional Context/Decisions cards, then `📝 Decision log` last — Unpaged assigns keyboard shortcuts `1`–`9` and sorts the *Related canvases* sidebar in this order.
  - **Sequential walking on every inner canvas:** put grouped top-right navigation pills on every child canvas in fixed link order — link `1`: `Next → <next title>` (`#e6effc` / `#1d4ed8`), link `2`: `← <prev title>` or `← Overview` (`#efe6d6` / `#cbb99f`) — so a reviewer can walk the entire plan with repeated `1` presses while keeping Graph Overview clean.

## Build the board

1. **Create the document** with `document_create({ title, folderId: "visual-plans" })`. Title: `<project name>: <short plan title>` (project = repo directory name or the obvious subject). `folderId: "visual-plans"` files the board in the reserved *Visual plans* folder of the user's library — one folder for every plan from every repo, created on demand, race-free (the repo stays visible in the title prefix). Filing is best-effort and never blocks the render: if the call rejects the `folderId` argument (an older server), retry without it and mention that folders need the current server; if the result carries `folderWarning`, the board exists — mention the warning in your reply and carry on. The document lands in the user's own Unpaged account — you are acting with their identity. Right after creation, set the root canvas background and summary with `node_update({ documentId, nodeId: rootNodeId, title: "Overview", backgroundColor: "#f6efe3", canvasWidth: 1920, canvasHeight: 1080, content: "<1–2 sentence plain-English overview of the plan>" })`. When this plan has mocks, add their pictures now (see *Mocks*).

2. **Create child canvases first** (so every target `nodeId` exists before building the root links in exact `1`–`9` order).
   - **One child node per phase** when the plan has distinct phases (`node_create_with_elements`, `parentNodeId: rootNodeId`, `backgroundColor: "#f6efe3"`, `canvasWidth: 1920`, `canvasHeight: 1080`, plain-English `content`, title `Phase N · <short action>`). Skip phase child nodes for small single-phase plans and put the task checklist on the root instead. Each phase canvas carries:
     - Top header: phase progress eyebrow (`PHASE N OF K` in `#786554`) + `Outfit` title (`26` bold `#3b2a1e`), plus grouped top-right walking pills added after all sibling nodes exist (link `1`: `Next → …`, link `2`: `← Prev` / `← Overview`).
     - Compact **WHAT THIS PHASE ACHIEVES** sage-tinted banner (`#f4f9f5`, `#c3decb` border, `#2f7d57` left bar) right under the header (1–2 sentences taken from what the plan itself says for this phase; omit the banner if the plan states no phase outcome rather than invent one).
     - Main left column: a `checklist` with that phase's tasks as unchecked items (`fillColor: "#fffaf1"`, `strokeColor: "#ded0ba"`, `textColor: "#3b2a1e"`, `checkboxColor: "#2f7d57"`, `fontSize: 14`, sized generously so wrapped items never clip).
     - Right column: an **EXIT CRITERIA / VERIFICATION** sage card when the plan states them, plus an amber **RISKS / NOTES** card if the phase carries specific guardrails.
     - When the plan has mocks for this phase, place them in a separate `batch_create_elements` after `node_create_with_elements` succeeds, following `references/mocks.md` so a refused picture never costs the phase its tasks.
   - **Optional Context / Decisions child canvases** (only when the plan itself includes substantial background, state comparisons, or open decisions that would crowd the root): `node_create_with_elements` (`parentNodeId: rootNodeId`, `backgroundColor: "#f6efe3"`, `1920×1080`, title `Context · <topic>` or `Decisions · <topic>`, plain-English `content`). Present comparisons and decisions as structured Warm Paper cards or diagrams rather than walls of text, and add the same top-right walking pills (`Next →` link `1`, `← Prev` link `2`).
   - **One `📝 Decision log` node on every plan** (`node_create_with_elements`, `parentNodeId: rootNodeId`, `backgroundColor: "#f6efe3"`, `canvasWidth: 1920`, `canvasHeight: 1080`, `content: "Running log of implementation deviations and design choices recorded while building."`), whatever the plan's size. This is where you record, while implementing, every choice a reviewer would later ask "why" about — the as-built record compiles it. The node carries:
     - Header (`Outfit` 28 bold `#3b2a1e`), a grouped top-right `← Overview` pill (link `1`, `linkTarget: rootNodeId`), and a quiet one-line rule subtitle (`Inter` 13 `#786554`) right below the title: *One row per deviation from the plan, dropped or added task, or choice a reviewer would ask "why" about — appended at the moment of the choice, naming the alternative rejected. Never backfill, never rewrite earlier rows.*
     - Full-width `table` (`x: 60`, `width: 1800`, `backgroundColor: "#fffaf1"`, `borderColor: "#d6c7b0"`, `textColor: "#3b2a1e"`, `fontFamily: "Inter, sans-serif"`, `fontSize: 13`, `textAlign: "left"`, `verticalAlign: "top"`, `columnWidths: [12, 26, 28, 22, 12]`) with ONE header row and five columns, exactly: `**When**` | `**Decision**` | `**Why**` | `**Alternative rejected**` | `**Plan item**`. Rows are appended later with `table_append_row`; pre-fill nothing. If the server refuses `columnWidths` (an older Unpaged server), retry without `columnWidths` and carry on.

   After all child nodes exist, add each child canvas's top-right walking pills (`Next →` as link `1`, `← Prev` or `← Overview` as link `2`, grouped with `group`) in a small `batch_create_elements` per child.

3. **Lay out the root node as the reviewer-first overview** (`batch_create_elements`, atomic). Anyone opening the root should grasp the whole plan in 5 seconds:
   - **Header bar:** left project eyebrow (`<PROJECT> · IMPLEMENTATION PLAN`, `Inter` 12 bold `#786554`) + title `text` (`Outfit` 30 bold `#3b2a1e`). Right: recessed status pill (`#efe6d6`, `#cbb99f` border, `cornerRadius: 18`) holding the dedicated status `text` element whose content is **exact**: `**Status:** 📋 PROPOSED` — keep the `**Status:**` prefix verbatim. Exception: if the plan being rendered was already approved earlier in this session, stamp `**Status:** 🚀 EXECUTING` instead.
   - **Hero band (ABOVE the phases) — two side-by-side cards:**
     - Left (**WHAT THIS IS ABOUT**, `#fffaf1` elevated card, `#ded0ba` border): 2–3 plain-English sentences taken from what the plan itself says about the problem or feature it addresses (and its stated reason; when the plan gives no reason, leave the why out rather than invent one).
     - Right (**WHAT IT WANTS TO ACHIEVE**, `#f4f9f5` sage card, `#c3decb` border, `#2f7d57` left bar): the concrete target outcome stated by the plan. When the plan describes a 3–5 step user or system journey, include a compact horizontal flow strip of small pills joined by `connector` arrows inside this card so the outcome is visible at a glance.
   - **Phases band (the clickable spine):**
     - For multi-phase plans: one grouped card per phase (`group`: offset shadow + `#fffaf1` card `rectangle` with `isLink: true`, `linkTarget: <phaseNodeId>`, `strokeColor: "#1d4ed8"`, `strokeWidth: 2`, `cornerRadius: 12` + `PHASE 01` eyebrow + bold `Outfit` title + 1–2 line summary drawn strictly from the phase's stated scope/tasks without inventing rationale; top-right `48×48` corner empty for the live badge). Join phase cards with `connector` elements (`startAnchor: "edge-right"`, `endAnchor: "edge-left"`, `startMarker: "none"`, `endMarker: "arrow"`, `strokeColor: "#8c7a66"`, `strokeWidth: 2`) to show sequence/dependencies. Create the linked phase rectangles in exact `1..k` order inside the batch!
     - For small single-phase plans: place the task `checklist` directly here (`#fffaf1`, `#ded0ba` border, `checkboxColor: "#2f7d57"`). Place any mocks in their own follow-up `batch_create_elements` once this root batch succeeds (following `references/mocks.md`), to the right of or below the checklist and never level with the bottom scaffolding dock row (the `as-built` skill puts its record links along that dock row, one after another).
   - **Guardrails & Reference band (below phases):**
     - Left: amber **RISKS & OUT OF SCOPE** card (`#fdf6ea`, `#e6cfa8` border, `#c26a1b` left bar) with the plan's key risks, constraints, or explicit non-goals.
     - Right: either compact grouped clickable reference cards (`#fffaf1`, `#93b4f5` stroke `1.5`, linking to `Context · …` / `Decisions · …` in `k+1..m` order) when child reference canvases were created, or an amber **OPEN DECISIONS** card when there are 1–3 brief questions.
   - **Quiet bottom scaffolding dock** (clearly apart from phases): recessed bar (`#efe6d6`, `#cbb99f` border, `cornerRadius: 10`) holding a compact grouped `📝 Decision log` link card (`isLink: true`, `linkTarget` = Decision log node, created **last** in root link order so it sits after phases and reference canvases), open space to its right for future `📐 As built · <date>` links, and a muted right-aligned shortcut hint (`Press 1–N to jump · Backspace for overview · G for map`, `#786554` Inter 12).

   The Decision log node and scaffolding dock are plugin scaffolding, not plan content: they do not count against fidelity (step 6), and the Decision log's rows are written during implementation, never at render time.

4. **Layout & Markdown discipline:** space elements generously (no overlaps), keep tables ≤20 rows, keep every element inside the canvas — enlarge the node first via `node_update` (`canvasWidth`/`canvasHeight`) if content needs room. Cell/label/text content is CommonMark Markdown; avoid starting a standalone text line with `2. ` (CommonMark renumbers ordered lists to `1.` — use `02 · ` or `2\. `). Never use `line` with `endMarker: "arrow"` for flow arrows (use `connector` with `startAnchor`/`endAnchor`, `startMarker: "none"`, `endMarker: "arrow"`). On a `text` element `fillColor` is the **text colour** (there is no background fill): always use a high-contrast Warm Paper ink (`#3b2a1e`, `#4a3a2d`, `#786554`, `#1d4ed8`, `#226142`, `#9a4e10`), never white on light cards. Give every `rectangle` (and any other basic shape: `triangle`, `diamond`, `hexagon`, `ellipse`, `block-arrow`) both a `fillColor` and a `strokeColor` — older servers refuse a basic shape that lacks either, and the whole batch with it.

5. **Look at what you drew.** Before handing the link back, ask the server for a picture of each canvas you created — `node_picture({ documentId, nodeId })` for the root and for every child canvas, plus `document_picture({ documentId })` when available — and look at it the way a reviewer will: nothing overlaps, nothing is cut off at the canvas edge, top-right corners of linked cards are clear for numbered badges, every table cell and card shows its whole text, phase cards read in order with clean arrows, and every mock shows whole and large enough to read with its caption beneath it. Fix what you see through the MCP tools (move or resize elements, enlarge the canvas with `node_update`) and look again, at most twice per canvas. On a dense canvas, pass `region` to zoom in on a part. The picture draws Mermaid as a grey placeholder, emoji in black and white and an animated picture as its first frame; that is not a layout fault. If `node_picture` is missing (an older server), skip this step and say in your reply that the layout was not checked visually.

6. **Fidelity:** the board reproduces the plan as written — same phases, same tasks, same order. Do not add tasks, merge phases, or editorialize. Trim wording only to fit card labels while keeping full task detail on the phase canvases. The Decision log node, navigation pills, and root scaffolding dock are plugin scaffolding, not plan tasks. Mocks are part of the plan as it was given, shown where its phases build them: never add a task to place, finish or build a mock.

## Post-render: branch PR preview and `@agent` push (mandatory)

Right after rendering and checking the canvas pictures — before replying to the user — read `references/listener-and-pr.md` in this skill folder and follow every step:

1. Record the visual plan for the current git branch (`monitors/plans.mjs record <documentId>`) and, if an open pull request exists for the branch, attach its **Can view** invite link and preview (`document_join_link` + `monitors/plans.mjs splice`).
2. Arm `@agent` comment push for this canvas (`monitors/keys.mjs check` / `store` + `agent_listener_key_create` + background `monitors/listen.mjs --once <documentId>` with `WaitMsBeforeAsync: 500`, `IsDaemon: false`, and `BypassSandbox: true` if Standard Sandbox Mode blocks `~/.gemini/unpaged` or network).

## Finish

Reply to the user with:
- The edit link: `https://unpaged.io/document/<documentId>/edit` — call it a canvas (or whiteboard) in your reply, never a board.
- If an open pull request for this branch was updated, one short sentence naming that pull request and noting that its **Can view** preview is attached.
- When the plan had mocks, one sentence saying how many went on which canvases, and the sentence from `references/mocks.md` for any left out.
- One sentence: approving the plan will stamp the canvas EXECUTING, and the Decision log fills in while the plan is implemented.
- Once `listen.mjs --once <documentId>` is running in the background: *"I'm listening on this canvas — comment @agent there and I reply on it."* and end your turn.

Remember the document ID and the root status element ID: when the user approves the plan in this session (clicking **Proceed** on an implementation plan artifact or approving in chat), set the root's `**Status:**` text to `**Status:** 🚀 EXECUTING` via `element_update`, then keep the Decision log while you implement — append ONE row with `table_append_row` at the moment of every deviation from the plan, dropped or added task, or choice a reviewer would later ask "why" about (when, decision, why, alternative rejected, plan item; one line per cell; never rewrite earlier rows; at 20 rows start a second table titled `Decision log (2)` beneath it on the same node). Follow the plugin's session rules (`rules/AGENTS.md`) and `references/listener-and-pr.md` when `@agent` comments arrive or a pull request is opened later.
