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
hooks and local MCP servers. The 0.5.0 candidate uses a bundled local review
tool to perform setup and launch detached receivers on the host. It requires
native task/workspace metadata plus the public `queue` and `hooks/list` APIs;
those source contracts were verified in Codex `0.155.0-alpha.9.2`. Missing
metadata blocks listening. Installed Ubuntu polling and human-comment wakeup
passed on candidate `fddbe96`, with one canvas edit and one agent reply verified.
The user confirmed event completion, but the canvas write waited at least
3 h 17 min for an unexplained reason; the reply came about 3 h 29 min after the
comment. Completion timeliness, the final candidate update, plan lifecycle and
recovery remain unverified. Rendering remains usable.

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

The agent checks setup through the bundled local `unpaged_review` server's
`review` tool before creating a listener key. If that tool is absent after an
update, follow the [bounded plugin refresh](plugins/unpaged-codex/README.md#missing-local-review-tool-after-an-update)
and rediscover it. This is update recovery, not a fresh-install requirement. Do
not use SQLite file grants or repeated reinstalls as the normal setup flow. A
ready setup check confirms hook configuration; it does not prove listening or recovery.

**Installation smoke passed; full workflow pending:** a [fresh CLI trial](docs/codex-repository-install-trial-2026-09-20.md)
installed the GitHub package and discovered its bundled server as not signed in.
A later user-reported fresh Ubuntu installation of 0.4.0 confirmed that the
explicit login command is required. The user confirmed sign-in and native hook
trust; a screenshot showed `visual-plan` and `review-plan` loading. A PROPOSED
canvas and Decision log were independently verified. Native sandbox failures in the 0.4.0 CLI flow
blocked listener setup. With the 0.5.0 candidate, the user subsequently confirmed
local-tool discovery, `info` and a ready `doctor` result in the same task after
a plugin enable-switch refresh. The installed `fddbe96` candidate then polled
successfully and woke that same task on a real human comment. Remote readback
verified one requested monthly-review note and one agent reply, with the canvas
still PROPOSED. The user confirmed successful event completion before VM
shutdown; the durable receipt was not independently read. The plan lifecycle,
an update to the final candidate with its native instructions and restart
recovery remain unverified for that trial. Delivery took 26.4 seconds and wakeup
28.3 seconds; the later canvas write waited at least 3 h 17 min for an
unestablished reason, and the reply arrived about 3 h 29 min after the comment.
Those delivery timings do not establish timely completion of feedback handling.
The successful [earlier pilot](docs/codex-installed-trial-2026-09-19.md)
used a different registered-connection artifact. The [readiness runbook](docs/codex-connection-readiness.md)
keeps those results and the remaining release gates separate.

## Plugins

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual canvases on Unpaged via `/unpaged:visual-plan`. Review the plan on the canvas, comment on the pieces (`@agent` comments are delivered automatically to the session that made it), and watch the canvas flip to *executing* when you approve. When the code is done, `/unpaged:as-built` writes the record of what shipped and why — every decision with its reason, a reviewer's reading order — as a canvas nested under the plan. |
| [unpaged-codex](plugins/unpaged-codex) (preview) | Visual plans, same-task comment review, Decision logs and as-built canvases in Codex. Repository installation passed; Ubuntu sign-in and hook trust are user-confirmed, and a PROPOSED canvas with Decision log was verified. Local-tool setup is user-confirmed. On installed 0.5.0 candidate `fddbe96`, polling and a real human-comment wakeup passed; remote readback verified one requested edit and one agent reply, with the canvas still PROPOSED. Event completion is user-confirmed, but the write waited at least 3 h 17 min for an unexplained reason. Completion timeliness, plan lifecycle, final-candidate update with native instructions and restart recovery remain unverified. |

## Support

- Bugs and ideas: [GitHub issues](https://github.com/unpaged/plugins/issues)
- Chat: [Unpaged on Discord](https://discord.gg/K8TR7cUGX)
- Versions: [CHANGELOG](CHANGELOG.md)

## License

[MIT](LICENSE) © Graph Knowledge SRL
