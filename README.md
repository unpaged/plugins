# Unpaged plugins for Claude Code

Claude Code plugins by [Unpaged](https://unpaged.io) — the whiteboard where humans and agents work on the same canvas.

## Install

```
/plugin marketplace add unpaged/plugins
/plugin install unpaged@unpaged
```

## Plugins

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual canvases on Unpaged via `/unpaged:visual-plan`. Review the plan on the canvas, comment on the pieces (`@agent` comments are pushed straight back to the session that made it), and watch the canvas flip to *executing* when you approve. |

## Codex connection readiness

The [native connection and recovery runbook](docs/codex-connection-readiness.md)
defines the Codex installation path, publication requirements, and customer
recovery trials. It is a verification guide for maintainers; it does not claim
that Unpaged is publicly available in Codex or depend on the visual-plan pilot.
