# Unpaged plugins for Claude Code and Codex

Claude Code and Codex plugins by [Unpaged](https://unpaged.io) — the whiteboard where humans and agents work on the same canvas.

## Install for Claude Code

```
/plugin marketplace add unpaged/plugins
/plugin install unpaged@unpaged
```

## Plugins

An experimental [Unpaged for Codex](plugins/unpaged-codex) package adds durable
comment routing to the same Codex task, explicit version acceptance, and recovery
status. It requires no external review skill. Read its requirements and current
server/runtime limits before use; the install commands above are for Claude Code.

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual canvases on Unpaged via `/unpaged:visual-plan`. Review the plan on the canvas, comment on the pieces (`@agent` comments are pushed straight back to the session that made it), and watch the canvas flip to *executing* when you approve. |
| [unpaged-codex](plugins/unpaged-codex) | Creates visual plans and routes anchored feedback to the same Codex task. Agents reply; humans resolve threads and explicitly accept the current version. Acceptance does not start implementation. |

## Codex pilot

The Codex package contains its own `visual-plan` and `review-plan` skills and
durable receiver. It requires no third-party review framework. Build it with a
registered Unpaged connection using the [package instructions](plugins/unpaged-codex/README.md#build-for-the-registered-connection).
Registration IDs are supplied at build time and do not belong in this repository.
The generated package includes the connection mapping; users authenticate through
the native plugin connection flow rather than adding an MCP URL themselves.

This repository has not published the Codex package to the public directory.
The current pilot needs Node 24+, a compatible Codex desktop runtime, and trusted
startup hooks. See the package's documented recovery and lifecycle limits.

## Test

With Node 24 or newer, no npm installation is needed:

```sh
node --test plugins/unpaged/monitors/*.test.mjs plugins/unpaged-codex/runtime/*.test.mjs scripts/*.test.mjs
```

CI runs the listener, adapter and generated-package checks on Linux and macOS.
These tests use disposable local state and fake sockets/queue commands; they do
not write to Unpaged or start a model task.
