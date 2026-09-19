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

Once the Codex catalog is available on `main`, use a supported Codex CLI:

```sh
codex plugin marketplace add unpaged/plugins
codex plugin add unpaged-codex@unpaged
```

Complete Unpaged sign-in when prompted, then start a fresh Codex task and invoke
`visual-plan`. Listening also requires native approval of the SessionStart hook;
follow the [setup instructions](plugins/unpaged-codex/README.md#hook-approval-before-listening).
The repository package includes its direct MCP connection; no personal
registration ID or artifact build is required.

**Installation smoke passed; full workflow pending:** a [fresh CLI trial](docs/codex-repository-install-trial-2026-09-20.md)
installed the GitHub package and discovered its bundled server as not signed in.
Native sign-in, hook approval, the plan lifecycle and restart recovery remain
untested for this route. The successful [earlier pilot](docs/codex-installed-trial-2026-09-19.md)
used a different registered-connection artifact. The [readiness runbook](docs/codex-connection-readiness.md)
keeps those results and the remaining release gates separate.

## Plugins

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual canvases on Unpaged via `/unpaged:visual-plan`. Review the plan on the canvas, comment on the pieces (`@agent` comments are pushed straight back to the session that made it), and watch the canvas flip to *executing* when you approve. When the code is done, `/unpaged:as-built` writes the record of what shipped and why — every decision with its reason, a reviewer's reading order — as a canvas nested under the plan. |
| [unpaged-codex](plugins/unpaged-codex) (preview) | Visual plans, same-task comment review, Decision logs and as-built canvases in Codex. CLI repository installation passed; sign-in and the complete first-use workflow remain pending validation. |

## Support

- Bugs and ideas: [GitHub issues](https://github.com/unpaged/plugins/issues)
- Chat: [Unpaged on Discord](https://discord.gg/K8TR7cUGX)
- Versions: [CHANGELOG](CHANGELOG.md)

## License

[MIT](LICENSE) © Graph Knowledge SRL
