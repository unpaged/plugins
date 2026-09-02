# unpaged — visual plans for Claude Code

See the plan before the code. `/unpaged:visual-plan` renders the plan Claude just made as a visual board on [UnPaged](https://unpaged.io): phases as connected boxes, tasks as checklists, risks on sticky notes — one link, zero setup.

<!-- TODO: demo clip -->

## What you get

- **`/unpaged:visual-plan`** — turns the current plan into a board and hands you the edit link. Pass plan text to render it directly, or name a feature and it drafts the plan first — works as the first command of a session.
- **Comments are pushed back** — leave a comment on any element, mention `@agent`, and the agent hears it within seconds and answers on the board. No polling, nothing to type: the first `/unpaged:visual-plan` arms a listener, and a background monitor reconnects in every later session.
- **Approval flips the board** — when you approve the plan in Claude Code, the board's status stamp changes to 🚀 EXECUTING.
- **Bundled MCP server** — installing the plugin registers UnPaged's MCP server; no manual config.

## Install

```
/plugin marketplace add iliedanila/unpaged-claude-plugins
/plugin install unpaged@unpaged
```

First use: run `/mcp` and authenticate the **unpaged** server with your UnPaged account (the free tier is enough).

## Use

1. Ask Claude Code to plan something (plan mode or plain conversation).
2. Run `/unpaged:visual-plan`.
3. Open the link, review the board, comment, approve.

`/unpaged:visual-plan <text>` renders the text you pass instead of the conversation's plan; if the text names a feature that has no plan yet, the plan is drafted first, then rendered.

## How push works

- The first time a board is handed back, the agent mints a **listener key** through the UnPaged MCP server (receive-only, revocable, shown once) and stores it in `~/.claude/unpaged/listener.json` (mode 600). The key is never the OAuth token and never travels in a URL.
- That session holds the `wss://mcp.unpaged.io/events` socket open with Claude Code's Monitor tool. Every later session, the plugin's background monitor (`monitors/listen.mjs`, plain Node ≥ 22) reconnects by itself and prints each event as one line the model reacts to.
- Each event names the board, node and thread; the agent runs `comments_list_unresolved` on that board, acts with the board tools, replies, and leaves the thread open for you to resolve.
- If you have Claude Code open on two machines, the newest connection answers (the older one is told it was superseded and stops).
- `/unpaged:listen` reports the state, re-arms a missing key, or `revoke`s this machine's keys. Background monitors run in interactive sessions only.
