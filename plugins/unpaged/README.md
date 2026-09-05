# unpaged — visual plans for Claude Code

See the plan before the code. `/unpaged:visual-plan` renders the plan Claude just made as a whiteboard on [Unpaged](https://unpaged.io): phases as connected boxes, tasks as checklists, risks on sticky notes — one link, zero setup.

<!-- TODO: demo clip -->

## What you get

- **`/unpaged:visual-plan`** — turns the current plan into a canvas and hands you the edit link. Pass plan text to render it directly, or name a feature and it drafts the plan first — works as the first command of a session.
- **Comments are pushed back** — leave a comment on any element of that canvas, mention `@agent`, and the session that made it hears you within seconds and answers on the canvas. No polling, nothing to type: `/unpaged:visual-plan` arms a listener for the canvas it just created. Each canvas has its own listener, so two sessions with two plans never answer each other's.
- **Explicit acceptance** — the owner comments `@agent I accept this plan`. Once the current plan and outstanding feedback are checked, its status changes from PROPOSED to ACCEPTED. Acceptance does not authorize implementation.
- **Bundled MCP server** — installing the plugin registers Unpaged's MCP server; no manual config.
- **Filed automatically** — every plan lands in the *Visual plans* folder of your Unpaged library (created the first time a plan is rendered), so plans from every repo sit together and never clutter the rest of your documents. Rename or delete the folder freely; the next plan recreates it.

## Install

```
/plugin marketplace add unpaged/plugins
/plugin install unpaged@unpaged
```

First use: run `/mcp` and authenticate the **unpaged** server with your Unpaged account (the free tier is enough).

## Use

1. Ask Claude Code to plan something (plan mode or plain conversation).
2. Run `/unpaged:visual-plan`.
3. Open the link, review the plan and comment. When ready, the owner writes `@agent I accept this plan`.

Agents reply and leave comment threads open; humans resolve them. A human-resolved
thread stays resolved. General praise, closing a thread and leaving plan mode do
not accept a plan. The owner must accept the current submitted content explicitly;
conditional or quoted acceptance is not an approval. A plan changed since review
needs another acceptance. Verified acceptance ends that board's review listener;
other boards stay active.

`/unpaged:visual-plan <text>` renders the text you pass instead of the conversation's plan; if the text names a feature that has no plan yet, the plan is drafted first, then rendered.

## How push works

- When a canvas is handed back, the agent mints a **listener key for that canvas** through the Unpaged MCP server (receive-only, revocable, shown once, bound to one Unpaged document) and stores it in `~/.claude/unpaged/listeners/<documentId>.json` (mode 600). The key is never the OAuth token and never travels in a URL.
- That session holds the document's `wss://mcp.unpaged.io/events` socket open with Claude Code's Monitor tool, running the plugin's `monitors/listen.mjs <documentId>` (plain Node ≥ 22). Every event is printed as one line the model reacts to: it runs `comments_list_unresolved` on that document, acts with the Unpaged tools, replies, and leaves the thread open for you to resolve.
- **A session listens only to canvases it armed itself.** Nothing reconnects in the background between sessions — that would spend tokens sweeping old plans nobody asked about. In a later session, `/unpaged:listen` lists the canvases armed from this project folder and arms the one you pick; `/unpaged:listen arm <documentId>` mints a key for a canvas created elsewhere; `status` and `revoke <documentId|all>` do what they say.
- Two sessions on two canvases listen side by side. Start a second session on the **same** canvas and it takes over (the older listener is told it was superseded and stops), so one plan is never answered twice.
