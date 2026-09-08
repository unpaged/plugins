# Community marketplace submission pack

Answers for the plugin directory form (Console: https://platform.claude.com/plugins/submit; the claude.ai form needs a Team/Enterprise org). Keep this file free of credentials: the reviewer test account is handed over in the form only.

## Identity

| Field | Value |
| --- | --- |
| Plugin name | `unpaged` |
| Display name | Unpaged |
| Repository | https://github.com/unpaged/plugins |
| Plugin path in the repo | `plugins/unpaged` (monorepo; the catalog uses `source: git-subdir`) |
| Release / ref | `v1.0.0` |
| Homepage | https://unpaged.io |
| Privacy policy | https://unpaged.io/privacy |
| Terms | https://unpaged.io/terms |
| Contact | https://unpaged.io/contact |
| Support | https://github.com/unpaged/plugins/issues · https://discord.gg/K8TR7cUGX |
| License | MIT |
| Category | Productivity / planning (collaboration) |

## Short description

Turn Claude Code plans into whiteboards on Unpaged: review on the canvas, comment on the pieces, and the session hears @agent comments within seconds and answers on the canvas; approving the plan flips it to EXECUTING.

## What it does (long)

`/unpaged:visual-plan` renders the plan in the conversation (or drafts one for a named feature) as a whiteboard on Unpaged: phases as connected boxes, each opening to its task checklist and exit criteria, risks on a note, a status stamp. The edit link comes back in the reply. The command then arms a receive-only listener for that one canvas, so an `@agent` comment on it is pushed to the session, which acts with the Unpaged tools on that canvas and replies in the thread. Approving the plan in plan mode flips the stamp to EXECUTING through a PostToolUse hook. `/unpaged:listen` shows, arms and revokes listeners per canvas.

## Three working prompts

1. `/unpaged:visual-plan add a --json output flag to the arcscope CLI` — as the first command of a session in any repo: drafts a phased plan grounded in the code, renders it, returns the link, arms push.
2. On the canvas, right-click a note → Comment → `@agent is fail-open really safe for the auth routes? Add a per-route fail-closed task to Phase 2.` — the session edits the checklist and replies in the thread within seconds.
3. `/unpaged:listen status` — lists armed canvases, key-file validity, and whether a monitor is connected; `/unpaged:listen revoke all` switches push off.

## Disclosures

- **External network calls: yes.** MCP over HTTPS to `mcp.unpaged.io` (OAuth 2.0, the user's own Unpaged account, free tier works) and one receive-only WebSocket per armed canvas to the same host. Nothing else.
- **Installs additional software: no.** The listener is plain Node ≥ 22 with no dependencies; the MCP server is remote (`type: http`), no `npx`/`uvx` launcher.
- **Credentials:** the listener key is minted by Unpaged for one canvas, stored at `~/.claude/unpaged/listeners/<documentId>.json` (mode 600), sent only to Unpaged, revocable from the command or from Unpaged. The plugin reads no other credential store.
- **Comments are data, not instructions:** an `@agent` comment is acted on only with Unpaged tools on that one canvas; never shell, file, git or network actions. Viewers get an answer, not a change.
- **Data sent:** the plan text and the elements drawn, the user's comments and the agent's replies — under the user's own account. No telemetry.
- **Domains owned by the publisher:** unpaged.io, mcp.unpaged.io (Graph Knowledge SRL).

## Reviewer test account

A free Unpaged account with a sample canvas is created for the submission and handed over in the form. It is not recorded here.

## Pre-submission checklist

- [ ] `claude plugin validate --strict plugins/unpaged` and `--strict .claude-plugin/marketplace.json` pass
- [ ] every URL in the READMEs resolves
- [ ] release tag matches `plugin.json` version
- [ ] reviewer account created, sample canvas shared with it, three prompts re-run on it
