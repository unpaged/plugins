# visual-plan — by UnPaged

See the plan before the code. `/visual-plan` renders the plan Claude just made as a visual board on [UnPaged](https://unpaged.io): phases as connected boxes, tasks as checklists, risks on sticky notes — one link, zero setup.

<!-- TODO: demo clip -->

## What you get

- **`/visual-plan`** — turns the current plan (or any text you pass it) into a board and hands you the edit link.
- **Comments flow back** — leave a comment on any element, mention `@agent`, and the agent picks it up in the session.
- **Approval flips the board** — when you approve the plan in Claude Code, the board's status stamp changes to 🚀 EXECUTING.
- **Bundled MCP server** — installing the plugin registers UnPaged's MCP server; no manual config.

## Install

```
/plugin marketplace add iliedanila/unpaged-claude-plugins
/plugin install visual-plan@unpaged
```

First use: run `/mcp` and authenticate the **unpaged** server with your UnPaged account (the free tier is enough).

## Use

1. Ask Claude Code to plan something (plan mode or plain conversation).
2. Run `/visual-plan`.
3. Open the link, review the board, comment, approve.

`/visual-plan <text>` renders the text you pass instead of the conversation's plan.
