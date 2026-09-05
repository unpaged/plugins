# Unpaged plugins for Claude Code

Render plans as visual boards on [Unpaged](https://unpaged.io), review specific
parts with `@agent` comments, and receive replies in the session that made them.
Agents reply and leave threads open; humans resolve them and accept plans.

## Install

```
/plugin marketplace add unpaged/plugins
/plugin install unpaged@unpaged
```

Use `/unpaged:visual-plan` to create a board. See the
[Claude Code package](plugins/unpaged) for authentication, commands and listeners.

Experimental: [Unpaged for Codex](plugins/unpaged-codex) is a development pilot,
not a public release.

## Test

With Node 24 or newer, no npm installation is needed:

```sh
node --test plugins/unpaged/monitors/*.test.mjs plugins/unpaged-codex/runtime/*.test.mjs scripts/*.test.mjs
```

CI runs these local tests on Linux and macOS; it does not write to Unpaged or
start a model task.
