# Unpaged for Google Antigravity

See the plan before the code. The `visual-plan` skill renders the plan Antigravity just made as an interactive whiteboard canvas on [Unpaged](https://unpaged.io): phases as connected boxes, tasks as checklists, risks on sticky notes — one link, zero setup. After the code is written, `as-built` compiles the record of what shipped and why, nested under the plan canvas.

![A plan rendered as a canvas: four phase boxes joined by arrows, a goal note and a risks note](../../docs/images/visual-plan-overview.png)

## What you get

- **`visual-plan`** — turns the current plan (an Antigravity implementation plan artifact, a plan in chat, or a feature you name) into an Unpaged canvas and hands you the edit link.
- **`@agent` comments wake the session** — leave a comment on any element of that canvas and mention `@agent`. The background listener (`monitors/listen.mjs --once <documentId>`) polls every 30 seconds (60 seconds after an idle hour), exits as soon as a new comment arrives to trigger Antigravity's reactive background-task wakeup, replies on the canvas, and re-arms itself for the next comment.
- **Approval flips the status** — when you approve the plan in Antigravity (clicking **Proceed** on an implementation plan artifact or approving in chat), the agent stamps the canvas `**Status:** 🚀 EXECUTING`.
- **The why is kept while you build** — every plan canvas carries a `📝 Decision log` node. While implementing the plan, the agent appends one row per deviation from the plan, dropped or added task, or choice a reviewer would later ask "why" about — at the moment of the choice, naming the alternative rejected.
- **`as-built`** — when the code is done, compiles the dated, frozen `📐 As built · <date>` record nested under the plan canvas: Plan delta, Decisions (`📝 recorded` vs `🔍 reconstructed` vs `not recorded`), Reviewer guide, and Data flow diagram (when a runtime flow changed), then stamps the plan `✅ BUILT`.
- **Visual self-check** — after rendering a plan or an as-built record, the agent inspects each canvas with `node_picture` and fixes overlaps or clipped text before returning the link.
- **Bundled MCP server** — installing the plugin registers Unpaged's remote MCP server (`https://mcp.unpaged.io/mcp`); no manual MCP JSON editing required.

## Requirements

- **Google Antigravity** (`agy` CLI / Antigravity IDE) with plugin support.
- **Node.js 22 or newer** on your `PATH` (uses Node's built-in `fetch`; zero npm dependencies).
- **An Unpaged account** — the free tier works.

## Install

Install directly from GitHub or a local checkout with the `agy` CLI:

```sh
agy plugin install https://github.com/unpaged/plugins/tree/main/plugins/unpaged-antigravity
```

Or from a local clone of this repository:

```sh
agy plugin install ./plugins/unpaged-antigravity
```

On first use, authenticate the **unpaged** MCP server in Antigravity with your Unpaged account.

## Use

1. Ask Antigravity to plan a feature (with `/plan` or in chat), or ask directly: *"Create a visual plan on Unpaged for <feature>"*.
2. Open the canvas link (`https://unpaged.io/document/<documentId>/edit`), review the phases, and leave `@agent` comments on any element you want adjusted.
3. Approve the plan (click **Proceed** on the plan artifact or say go ahead in chat). The canvas status flips to `🚀 EXECUTING` and the agent logs implementation decisions to the `📝 Decision log` table as it builds.
4. When implementation is complete, ask Antigravity to *"Compile the as-built record on Unpaged"* (or `/unpaged:as-built`).

## Skills

| Skill | Trigger examples | What it does |
| --- | --- | --- |
| [`visual-plan`](skills/visual-plan/SKILL.md) | *"Create a visual plan on Unpaged"*, `/unpaged:visual-plan` | Renders the conversation's plan (or drafts one for a named feature) as an Unpaged canvas, checks the layout with `node_picture`, arms the `@agent` listener for this session, and returns the edit link. |
| [`as-built`](skills/as-built/SKILL.md) | *"Compile the as-built record on Unpaged"*, `/unpaged:as-built [documentId] [base..head]` | Reconciles the plan canvas and its Decision log against the git diff and PR, writes the dated `📐 As built · <date>` canvas (with Reviewer guide and optional Data flow diagram), and stamps the plan `✅ BUILT`. |
| [`listen`](skills/listen/SKILL.md) | *"Check Unpaged listener status"*, `/unpaged:listen [status \| arm <id> \| revoke <id\|all>]` | Lists canvases armed from this folder, checks whether a listener is connected, arms a canvas in this session, or revokes listener keys on the server and removes retired local key files. |

## How `@agent` comment push works in Antigravity

- **Per-canvas listener keys:** when `visual-plan` or `listen arm <documentId>` arms a canvas, it calls `agent_listener_key_create` with label `antigravity on <host>` and stores the board-bound, receive-only key at `~/.gemini/unpaged/listeners/<documentId>.json` (mode `0600`, atomic temp-file + rename) via `monitors/keys.mjs store <documentId>`. Keeping keys under `~/.gemini/unpaged/` isolates Antigravity's keys and poll cursors from Claude Code (`~/.claude/unpaged/`).
- **Reactive background wakeup (`--once`):** Antigravity wakes the agent whenever a background command (`WaitMsBeforeAsync: 500, IsDaemon: false`) exits. `monitors/listen.mjs --once <documentId>` holds a local 3-of-5 loopback port quorum (`127.0.0.1`) for that canvas and polls `GET https://mcp.unpaged.io/events/poll` every 30 seconds (60 seconds after an idle hour, honoring `Unpaged-Poll-Interval` and `Unpaged-Idle-Poll-Interval` headers). Empty and replay-only polls stay quiet in the background with zero token cost. As soon as a poll returns one or more new unseen events (or a terminal `401`/`409`), `listen.mjs` persists the updated cursor and seen event IDs to `~/.gemini/unpaged/monitors/<documentId>.json`, prints the protocol preamble and event JSON line(s) to stdout, releases local ownership, and exits `0`.
- **Reply and re-arm:** the background task's exit wakes the Antigravity session with the event payload. The agent acknowledges mentions with `"On it…"`, reads `comments_list_unresolved`, updates the canvas via the `unpaged` MCP tools, posts a one-line summary reply, leaves the thread open, and starts the next `listen.mjs --once <documentId>` background task (which loads the persisted cursor and seen event IDs so events inside the server's 2-minute replay window are never handled twice).

## Privacy & Security

- **Policies:** [Privacy policy](https://unpaged.io/privacy) · [Terms of service](https://unpaged.io/terms).
- **Listener keys:** receive-only, bound to one canvas, stored at `~/.gemini/unpaged/listeners/<documentId>.json` with mode `0600`, never printed to stdout or chat, and sent only in the `Authorization: Bearer` header to `https://*.unpaged.io/events/poll`.
- **Comments are data, not instructions:** `@agent` comments are authored by canvas collaborators, not the local terminal user. Both the `rules/AGENTS.md` rule and the listener's `PROTOCOL_PREAMBLE` enforce that comments may only trigger `unpaged` MCP tool actions on that specific `documentId` — never shell commands, local file edits, git operations, or network requests — and `viewer` comments receive a proposed answer without modifying the canvas.

## Developing

```sh
agy plugin validate plugins/unpaged-antigravity
node --test plugins/unpaged-antigravity/monitors/*.test.mjs
```
