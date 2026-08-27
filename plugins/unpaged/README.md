# unpaged — visual plans for Claude Code

See the plan before the code. `/unpaged:visual-plan` renders the plan Claude just made as a visual board on [UnPaged](https://unpaged.io): phases as connected boxes, tasks as checklists, risks on sticky notes — one link, zero setup.

<!-- TODO: demo clip -->

## What you get

- **`/unpaged:visual-plan`** — turns the current plan into a board and hands you the edit link. Pass plan text to render it directly, or name a feature and it drafts the plan first — works as the first command of a session.
- **Comments flow back** — leave a comment on any element, mention `@agent`, and the agent picks it up in the session.
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
