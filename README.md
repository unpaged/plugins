# Unpaged plugins for Claude Code and Codex

Claude Code and Codex plugins by [Unpaged](https://unpaged.io) — the whiteboard where humans and agents work on the same canvas.

![A Claude Code plan rendered as a canvas on Unpaged](docs/images/visual-plan-overview.png)

## Install for Claude Code

```
/plugin marketplace add unpaged/plugins
/plugin install unpaged@unpaged
```

## Install for Codex — preview

The experimental [Unpaged for Codex](plugins/unpaged-codex/README.md) package
adds visual plans, same-task comment review, implementation Decision logs, and
as-built canvases. It requires macOS or Linux, Node.js 24+ available to Codex's
hooks, and Codex 0.153.1+ with the public `queue` command and `hooks/list` support.
Listening is blocked in the ordinary Codex 0.155 Linux command sandbox because
detached receivers do not survive command completion; rendering remains usable.

Use a supported Codex CLI:

```sh
codex plugin marketplace add unpaged/plugins
codex plugin add unpaged-codex@unpaged
codex mcp login unpaged
```

Complete Unpaged sign-in through the last command; plugin installation does not
complete this step. Then start Codex, open `/hooks`, and review and trust the
Unpaged plugin's **SessionStart** hook before listening. Keep the hook enabled,
then invoke `visual-plan` in a fresh task. Desktop users can instead use the
[hook settings](plugins/unpaged-codex/README.md#hook-approval-before-listening).
The repository package includes its direct MCP connection; no personal
registration ID or artifact build is required.

The setup check may need native approval to initialize Codex's local runtime
storage. Version 0.4.1 identifies that failure separately from hook trust; use
the [host permission guidance](plugins/unpaged-codex/README.md#hook-approval-before-listening)
and keep the same task and profile. Setup approval alone does not verify that
the host allows a persistent background listener.

**Installation smoke passed; full workflow pending:** a [fresh CLI trial](docs/codex-repository-install-trial-2026-09-20.md)
installed the GitHub package and discovered its bundled server as not signed in.
A later user-reported fresh Ubuntu installation of 0.4.0 confirmed that the
explicit login command is required. The user confirmed sign-in and native hook
trust; a screenshot showed `visual-plan` and `review-plan` loading. A PROPOSED
canvas and Decision log were independently verified. Native sandbox failures
blocked listener setup; comment delivery, the plan lifecycle and restart
recovery remain unproven for that trial.
The successful [earlier pilot](docs/codex-installed-trial-2026-09-19.md)
used a different registered-connection artifact. The [readiness runbook](docs/codex-connection-readiness.md)
keeps those results and the remaining release gates separate.

## Plugins

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual canvases on Unpaged via `/unpaged:visual-plan`. Review the plan on the canvas, comment on the pieces (`@agent` comments are delivered automatically to the session that made it), and watch the canvas flip to *executing* when you approve. When the code is done, `/unpaged:as-built` writes the record of what shipped and why — every decision with its reason, a reviewer's reading order — as a canvas nested under the plan. |
| [unpaged-codex](plugins/unpaged-codex) (preview) | Visual plans, same-task comment review, Decision logs and as-built canvases in Codex. Repository installation passed; Ubuntu sign-in and hook trust are user-confirmed, and a PROPOSED canvas with Decision log was verified. Listener setup remains blocked in that trial. |

## Support

- Bugs and ideas: [GitHub issues](https://github.com/unpaged/plugins/issues)
- Chat: [Unpaged on Discord](https://discord.gg/K8TR7cUGX)
- Versions: [CHANGELOG](CHANGELOG.md)

## License

[MIT](LICENSE) © Graph Knowledge SRL
