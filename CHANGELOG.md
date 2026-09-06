# Changelog

All notable changes to the `unpaged` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the `version` field of `plugins/unpaged/.claude-plugin/plugin.json`.

## [Unreleased]

- README screenshots and a live example canvas.
- `/unpaged:visual-plan` prompt: `fillColor` on a text element is the text colour — the render used to come out white-on-white when the model read it as a background.

## [0.5.1] - 2026-09-06

### Changed

- Repository moved to `unpaged/plugins`; install with `/plugin marketplace add unpaged/plugins` then `/plugin install unpaged@unpaged` ([#6](https://github.com/unpaged/plugins/pull/6)).
- User-facing copy spells the product **Unpaged** and says canvas or whiteboard throughout ([#6](https://github.com/unpaged/plugins/pull/6)).
- MIT license, this changelog, and a CI workflow (`node --test` + manifest checks).
- README: requirements (Claude Code Monitor tool, Node ≥ 22), a command table, troubleshooting, privacy and support sections; slash-command descriptions and the listener's stop lines say canvas.

## [0.5.0] - 2026-09-03

### Added

- Every plan is filed in the reserved **Visual plans** folder of your Unpaged library: `/unpaged:visual-plan` creates the canvas with `folderId: "visual-plans"`, which the server creates on demand ([#4](https://github.com/unpaged/plugins/pull/4)).

### Changed

- Filing is best-effort and never blocks a render: an older server that rejects the argument gets a retry without it; a `folderWarning` is mentioned in the reply and the canvas is still delivered.

## [0.4.0] - 2026-09-03

### Changed

- **One listener per canvas, armed only by the session that asks** ([#3](https://github.com/unpaged/plugins/pull/3)). Keys live in `~/.claude/unpaged/listeners/<documentId>.json` (mode 600) and `monitors/listen.mjs <documentId>` listens to one canvas as a session Monitor.
- Nothing reconnects between sessions: `/unpaged:visual-plan` arms the canvas it just created; `/unpaged:listen` lists the canvases armed from the current folder and arms your pick, with `arm <documentId>`, `status` and `revoke <documentId|all>`.
- A second session on the same canvas takes over; the older listener stops. The v1 single-key file is moved aside on first run, never deleted.

## [0.3.0] - 2026-09-02

### Added

- **Push listener**: `@agent` comments on a canvas reach the session that made it without polling ([#2](https://github.com/unpaged/plugins/pull/2)). `/unpaged:visual-plan` mints a receive-only listener key through the Unpaged MCP server and holds the canvas's events socket open with Claude Code's Monitor tool.
- `monitors/listen.mjs`: plain Node ≥ 22, no dependencies, reconnects with backoff.
- `/unpaged:listen` with `status`, repair and `revoke`.
- Sweep protocol and injection guard in the command prompt: comments are acted on only with Unpaged tools, on that document; a viewer's request gets an answer, not a change.

## [0.2.1] - 2026-08-28

### Added

- First release of the plugin ([#1](https://github.com/unpaged/plugins/pull/1)): marketplace `unpaged` with plugin `unpaged`, bundled Unpaged MCP server (`.mcp.json`), `/unpaged:visual-plan` (renders the conversation's plan, passed text, or drafts a plan for a named feature), and a PostToolUse hook on `ExitPlanMode` that stamps the canvas 🚀 EXECUTING when the plan is approved.

[Unreleased]: https://github.com/unpaged/plugins/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/unpaged/plugins/releases/tag/v0.5.1
[0.5.0]: https://github.com/unpaged/plugins/pull/4
[0.4.0]: https://github.com/unpaged/plugins/pull/3
[0.3.0]: https://github.com/unpaged/plugins/pull/2
[0.2.1]: https://github.com/unpaged/plugins/pull/1
