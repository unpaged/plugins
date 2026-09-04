# UnPaged Claude Plugins

Claude Code plugins by [UnPaged](https://unpaged.io) — the visual canvas where humans and agents work on the same board.

## Install

```
/plugin marketplace add iliedanila/unpaged-claude-plugins
/plugin install unpaged@unpaged
```

## Plugins

An experimental [UnPaged for Codex](plugins/unpaged-codex) package adds durable
comment routing to the same Codex task, explicit version acceptance, and recovery
status. It requires no external review skill. Read its requirements and current
server/runtime limits before use; the install commands above are for Claude Code.

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual boards on UnPaged via `/unpaged:visual-plan`. Review the plan on a canvas, comment on the pieces (`@agent` comments on a board are pushed straight back to the session that made it), and watch the board flip to *executing* when you approve. |
