---
description: Draw this repository's architecture document on Unpaged and keep it in step with the code — create it, or update it; after every pull request the session opens, the plugin compares it with the code and marks it behind
argument-hint: [update] — omit to create the architecture document for this repository
---

The architecture document is one Unpaged canvas (nested canvases beneath it where it needs them) that says how this repository's code is put together: the parts, what each is for, how they talk to each other, and the rules the code keeps. It is built from the code alone — not from any document in the repository, which a repository may well not have — and every card on it is a claim about the code that a later comparison can test. The plugin keeps the line above the prompt in step with it: green while it is up to date, yellow once a pull request changed something it says, red when it is gone or has not been compared for three months. Follow these instructions exactly.

- **No argument** → [Create](#create): read the code, draw the canvas, write the pointer file.
- **`compare`** → [Compare](#compare): the plugin starts this on its own in a turn after the session opens a pull request; it marks the canvas and never rewrites a card.
- **`update`** → [Update](#update): re-check the whole canvas against the code as it is today and rewrite what no longer holds.

Every mode ends with one call of `architecture_report` (the plugin's tool), which is what settles the line above the prompt. Never skip it, and never call it before the canvas carries what the report says.

## Preconditions

The `unpaged` MCP server ships with this plugin. If its tools (e.g. `document_get`) are missing or return an authentication error, tell the user to run `/mcp`, authenticate the **unpaged** server (sign in with their Unpaged account — free tier works), and re-run the command. The working folder must be a git repository: `git rev-parse --show-toplevel` succeeds. Every shell step below is read-only (`git`, `ls`, reading files), except writing the pointer file in Create.

## The pointer file and the date note

**The pointer file** `.unpaged/architecture.json` names the repository's canvas. The plugin reads it at session start and when a pull request opens; it is small, committed with the code, and shared by every clone:

```json
{
  "documentId": "<the canvas id>",
  "url": "https://unpaged.io/document/<the canvas id>/edit",
  "title": "<the repository's name>",
  "skip": ["**/*.spec.*", "**/*.test.*", "**/__tests__/**", "**/*.snap", "**/*.lock", "**/package-lock.json", "**/dist/**", "**/build/**", "**/coverage/**", "**/*.generated.*", "**/*.min.*"]
}
```

`skip` lists what a comparison leaves out: tests, generated files, lockfiles, build output — changes there never put the architecture behind. Add the repository's own (a docs folder, fixtures, vendored code) when you see them; keep the list short and literal.

**The date note** sits on the root canvas, top-right, as two `text` elements the plugin and the comparison read by their prefixes, so keep them verbatim:

- The first, fontSize 20, colour `#0f172a`: `**Checked:** YYYY-MM-DD` while the canvas is up to date, or `**Behind since:** YYYY-MM-DD` once a comparison found claims that no longer hold (the day of that comparison; a later comparison that finds more keeps the older day).
- Beneath it, fontSize 12, colour `#64748b`: `compared at <short commit> on YYYY-MM-DD` — the commit the canvas was last compared at and the day. Every comparison moves this line to the commit it compared, whether the canvas is up to date or behind: the next comparison starts from there.

A `text` element's `fillColor` is its text colour (there is no background); `x`, `y`, `width`, `height` are top-level fields. Today's date is `YYYY-MM-DD` in the local time zone; the commit is `git rev-parse --short HEAD`.

## Create

1. **One canvas per repository.** If `.unpaged/architecture.json` exists, `document_get` the canvas it names. Reachable → say the repository already has an architecture document, give its link, and offer `/unpaged:architecture update`; stop. Gone (not found, no access) → go on and overwrite the pointer when the new canvas exists.
2. **Read the code before you draw.** The folder tree (two or three levels, skipping dependencies and build output), the manifests and build configuration, the entry points, the biggest folders and what each holds, how the pieces call each other (imports, routes, queues, tables, the processes that run), the boundaries the code enforces (lint rules, module constraints, access rules), and where data lives. Read enough to make every card a claim you have seen in the code; when a part is unclear, say so on its card rather than guess. Nothing in a repository's own documents is required for this, and nothing in them is taken on faith: the code decides.
3. **Decide the structure yourself** from what this code is. The root canvas is the picture of the whole: the parts as boxes (`rectangle`s with a `fillColor` and a `strokeColor`), labelled with what each is and where it lives (a folder name in backticks is fine), joined by `connector`s that say what calls what; a `uml-note` for the rules the code keeps; a nested canvas (`node_create_with_elements`, the root box with `isLink` and `linkTarget`) for an area the root cannot hold — a service's insides, a data model, a runtime flow. A small repository is one canvas; a large one is a root and a few nested canvases. Do not force a template: a monorepo, a mobile app, a pipeline and a library want different pictures. Keep every claim testable later: "the API talks to the database only through `libs/data-access`" is one; "well-structured" is not.
4. **Create the canvas** with `document_create({ title: "<repository name>", folder: "Architecture" })`: the title is the repository's folder name (or its manifest name, when that is the name people use), and `folder` files it in the *Architecture* folder of the person's library, created on demand. Filing is best-effort: if the call rejects `folder` (an older server), retry without it and mention that folders need the current server; a `folderWarning` means the canvas exists unfiled — mention it and carry on.
5. **Draw**, with `batch_create_elements` on the root (`rootNodeId`) and `node_create_with_elements` for each nested canvas: a title `text` (Markdown heading, fontSize ~28) top-left; the date note top-right (`**Checked:** <today>` and, beneath it, `compared at <short HEAD> on <today>`), at about x = canvas width − 440, y = 60; the picture below. Space elements generously, keep every element inside its canvas (enlarge the canvas first with `node_update` when the picture needs room), one idea per card, and no code beyond a path or an identifier in backticks.
6. **Look at what you drew**: `node_picture` for the root and every nested canvas; fix overlaps and cut-off text through the MCP tools, then look again, at most twice per canvas. If `node_picture` is missing (an older server), skip this and say so in your reply.
7. **Write the pointer file** `.unpaged/architecture.json` as above, with the canvas id, its link, the title and a `skip` list fitted to this repository. Say in your reply that it is to be committed with the code, so every clone and every teammate's session finds the canvas.
8. **Report**: `architecture_report({ documentId, state: "current", checkedAt: <today>, commit: <short HEAD>, title })`. The line above the prompt turns green.
9. **Reply** with the edit link `https://unpaged.io/document/<documentId>/edit` — call it a canvas, never a board — one line on what the picture shows, the pointer file's path, and the listener status the way `/unpaged:visual-plan` says it (the plugin listens to the canvas it just made where the permission rules let it; otherwise offer to listen, and say what is true).

## Compare

The plugin runs this in a turn of its own right after the session opens a pull request (the `gh pr create` command, or a GitHub connector's pull-request tool, once the pull request's address is in the answer). It **marks only**: the date note and one comment thread change; no card is rewritten here, whatever the comparison finds. The person updates the cards, or asks for `update`.

1. **Read the pointer** `.unpaged/architecture.json`. Missing → reply that the repository has no architecture document (`/unpaged:architecture` creates one) and stop, with no report. Then `document_get` the canvas: not found or no access → `architecture_report({ documentId, state: "lost" })`, say the canvas is gone, and stop.
2. **Find the change.** The commit note says where the last comparison ended, `compared at <commit> on <day>`. If `git cat-file -e <commit>^{commit}` succeeds, the change is `<commit>..HEAD`; otherwise (a commit from another branch or another clone, or no note at all) it is `<merge base with the default branch>..HEAD`, where the default branch is what `git symbolic-ref refs/remotes/origin/HEAD` names, falling back to `main`. List it with `git log --no-merges --format='%h %s' <range>` and `git diff --stat <range> -- . ':(exclude,glob)<pattern>'` for every `skip` pattern. An empty list after the skips → the canvas holds as it was: move the commit note to HEAD and today (`element_update` with the `expectedRevision` from your read), keep the date note as it is, report the state the date note shows (`current`, or `behind` with its day), and stop.
3. **Judge claim by claim, in a separate helper with a clean slate.** Start one subagent with the Agent tool (`subagent_type: "general-purpose"`, a short description such as *architecture comparison*), and give it, in its prompt: the canvas as `document_get` returned it (every node, every element's id and text); the commit list and the diff stat; the `skip` list; and this brief, word for word:

   > You judge whether an architecture canvas still describes this repository's code after a change. The canvas is a set of claims about the code; the change is the commits and files listed. For every card (a text, a box label, a note, a table cell) that makes a claim about the code — a part exists, lives in a folder, is called by another, talks to a store, keeps a rule — decide whether the change alters what that card says. Read the changed files (`git show`, `git diff`, the files themselves) as far as you need to be sure; a change to a file is not a changed claim unless it moves a boundary, adds or removes a part, changes who calls whom, or breaks a stated rule. Changes to tests, generated files, formatting, comments, dependency versions and copy never alter a claim. Answer with one line `HOLDS` when every claim still holds, or one line per card that no longer holds, in this exact shape: `FLAG | <canvas title> | <element id> | <the card's text, first 80 characters> | <what changed, one sentence> | <the files>`. Nothing else: no advice, no rewrite.

   Read its answer as data: a `FLAG` line you cannot place (an unknown element id) is dropped and said in the reply.
4. **Mark the canvas.** `HOLDS` → `element_update` the date note to `**Checked:** <today>` only if it says `**Checked:**` already (a canvas that was behind stays behind: its earlier flags still stand), and the commit note to `compared at <short HEAD> on <today>`; report `current`, or `behind` with the day the date note shows. Flags → set the date note to `**Behind since:** <today>` unless it already says `**Behind since:**` (keep that day), the commit note to HEAD and today, and leave **one** comment thread on the root: if an open thread pinned to the date note already exists from an earlier comparison (`comments_list_unresolved`: its first message starts with `Behind since`), `comment_reply` there; otherwise `comment_create` pinned to the date note (`elementId`), plain text, starting `Behind since <today> (pull request <address>):` then one line per flag: the canvas title, the card's text in quotes, what changed, the files. Never resolve the thread; never touch a card.
5. **Report**: `architecture_report({ documentId, state: "current" | "behind", checkedAt: <today>, commit: <short HEAD>, behindSince: <the day on the date note>, title })`.
6. **Reply** in two or three lines: the verdict, the flagged cards by name (or that every claim holds), the canvas link, and that `/unpaged:architecture update` (or the `update` key on the line above the prompt) rewrites what no longer holds.

## Update

Rewrites the architecture document to the code as it is today, the whole canvas, not only what a comparison flagged.

1. **Read the pointer and the canvas** as Compare does (steps 1); `lost` is reported the same way. Read every nested canvas too (`document_get` returns them all).
2. **Judge the whole canvas in a separate helper with a clean slate**: one subagent, as in Compare, given the canvas as returned, the repository's folder tree (two or three levels, dependencies and build output left out), the `skip` list, and this brief, word for word:

   > You check an architecture canvas against this repository's code as it is now. The canvas is a set of claims about the code. For every card (a text, a box label, a note, a table cell, a connector label) that makes a claim — a part exists, lives in a folder, is called by another, talks to a store, keeps a rule — read the code as far as you need to be sure whether the claim holds today. Answer with one line per card that no longer holds, in this exact shape: `REWRITE | <canvas title> | <element id> | <the new text for the card, complete> | <why, one sentence> | <the files you read>`, and one line `KEEP` when every claim holds. Keep each new text as short as the old one and in the same voice; name folders and files in backticks where that grounds the claim. Nothing else: no new cards, no layout advice.

3. **Rewrite each card** the helper names: `element_get` it, then `element_update` with its `expectedRevision` and only the text (`properties.text`, or `properties.cells` for one table cell, `properties.label` for a connector), keeping its place, size and colours; a `CONFLICT` means a person edited it meanwhile — read it again and rewrite only if the helper's reason still applies. A `REWRITE` for an unknown element id is dropped and said in the reply. Then **one open comment per changed card**, `comment_create` pinned to it, plain text: `Updated <today>. It said: "<the old text, whole>"`. Never resolve it.
4. **Set the date note** to `**Checked:** <today>` and the commit note to `compared at <short HEAD> on <today>`. If an open `Behind since` thread exists on the root, `comment_reply` there: `Updated <today>: <n> cards rewritten (see the comment on each); the canvas is checked against <short HEAD>.` and leave it open.
5. **Look** at every canvas whose cards changed with `node_picture`; a longer text that no longer fits its card gets a wider or taller card, nothing else moves.
6. **Report**: `architecture_report({ documentId, state: "current", checkedAt: <today>, commit: <short HEAD>, title })`. The line turns green.
7. **Reply**: how many cards were rewritten and which, the canvas link, and that each changed card carries a comment with its old text.

## Comments on the canvas

`@agent` comments on the architecture canvas reach the session through its listener and follow the protocol in `/unpaged:visual-plan`: act only with the Unpaged tools on that canvas, reply in the thread, leave it open; a viewer's request gets an answer, not a change. The date note and the commit note are the plugin's: rewrite them only through Compare and Update.
