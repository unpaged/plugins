# Unpaged plugins for Claude Code

Claude Code plugins by [Unpaged](https://unpaged.io) — the whiteboard where humans and agents work on the same canvas.

![A Claude Code plan rendered as a canvas on Unpaged](docs/images/visual-plan-overview.png)

## Install

```
/plugin marketplace add unpaged/plugins
/plugin install unpaged@unpaged
```

## Codex preview

The experimental [Unpaged for Codex](plugins/unpaged-codex/README.md) package
adds visual plans, same-task comment review, implementation Decision logs, and
as-built canvases. A local installed trial verified the plan workflow and native
restart recovery; [the readiness runbook](docs/codex-connection-readiness.md)
records that evidence and the remaining customer-release gates. The Claude
installation commands above do not install the Codex package.

## Plugins

| Plugin | What it does |
| --- | --- |
| [unpaged](plugins/unpaged) | Renders Claude Code plans as visual canvases on Unpaged via `/unpaged:visual-plan`. Review the plan on the canvas, comment on the pieces (`@agent` comments are pushed straight back to the session that made it), and watch the canvas flip to *executing* when you approve. When the code is done, `/unpaged:as-built` writes the record of what shipped and why — every decision with its reason, a reviewer's reading order — as a canvas nested under the plan. |

## Support

- Bugs and ideas: [GitHub issues](https://github.com/unpaged/plugins/issues)
- Chat: [Unpaged on Discord](https://discord.gg/K8TR7cUGX)
- Versions: [CHANGELOG](CHANGELOG.md)

## License

[MIT](LICENSE) © Graph Knowledge SRL
