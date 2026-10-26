# Community marketplace submission pack

Answers for the plugin directory form (Console: https://platform.claude.com/plugins/submit; the claude.ai form needs a Team/Enterprise org). Keep this file free of credentials: the reviewer test account is handed over in the form only.

## Identity

| Field | Value |
| --- | --- |
| Plugin name | `unpaged` |
| Display name | Unpaged |
| Repository | https://github.com/unpaged/plugins |
| Plugin path in the repo | `plugins/unpaged` — this repo's own `marketplace.json` lists it as the relative path `./plugins/unpaged`; the community catalog records monorepo entries as `{ source: "git-subdir", url, path, ref, sha }`, so give the form the repo URL plus this path |
| Release / ref | `v1.10.0` (483d59b), in review since 2026-10-26; v1.9.0 was the first version whose tree passes the directory policy (no hook of the plugin answers *allow*, and it carries the icon and `privacyPolicyUrl`). Submit the release that carries the *Directory findings* changes below once it is tagged; never submit an older ref |
| Homepage | https://unpaged.io |
| Privacy policy | https://unpaged.io/privacy |
| Terms | https://unpaged.io/terms |
| Contact | https://unpaged.io/contact |
| Support | https://github.com/unpaged/plugins/issues · https://discord.gg/K8TR7cUGX |
| License | MIT |
| Category | Productivity / planning (collaboration) |

## Short description

Turn Claude Code plans into whiteboards on Unpaged: review on the canvas, comment on the pieces, and the session receives @agent comments automatically through its background listener and answers on the canvas; approving the plan flips it to EXECUTING, and when the code is done /unpaged:as-built writes the record of what shipped and why under the plan.

## What it does (long)

`/unpaged:visual-plan` renders the plan in the conversation (or drafts one for a named feature) as a whiteboard on Unpaged: phases as connected boxes, each opening to its task checklist and exit criteria, risks on a note, a status stamp. The edit link comes back in the reply. The command then arms a receive-only listener for that one canvas — inside Claude Code on builds that run plugin mods, where a line above the prompt shows what the session listens to, or as a background Monitor on older builds. The listener collects an `@agent` comment on its next poll, and the session then acts with the Unpaged tools on that canvas and replies in the thread. Approving the plan in plan mode flips the stamp to EXECUTING through a PostToolUse hook, and from then on the session keeps a Decision log on the canvas: one row per deviation or non-obvious choice, written at the moment of the choice. When the code is done, `/unpaged:as-built` compiles the as-built record as a canvas nested under the plan — every plan item's outcome with its why, the decisions and where each why comes from (recorded during the work or reconstructed from the diff, labelled as such), the runtime flow that changed, and a reviewer's guide — and stamps the plan BUILT. `/unpaged:listen` shows, arms and revokes listeners per canvas.

## Working prompts

1. `/unpaged:visual-plan add a --json output flag to the arcscope CLI` — as the first command of a session in any repo: drafts a phased plan grounded in the code, renders it, returns the link, arms push.
2. On the canvas, right-click a note → Comment → `@agent is fail-open really safe for the auth routes? Add a per-route fail-closed task to Phase 2.` — the listener notices it on a subsequent poll, then the session edits the checklist and replies in the thread. Polls run every 30 seconds, or every 60 seconds after an idle hour.
3. `/unpaged:listen status` — lists armed canvases, key-file validity, and whether a monitor is connected; `/unpaged:listen revoke all` switches push off.
4. After approving and implementing the plan from prompt 1: `/unpaged:as-built` — writes the as-built record under that plan canvas (each task's outcome and why, the decisions logged during the work, the reviewer's reading order) and stamps the plan BUILT; the reply carries the record's link.

## Disclosures

- **External network calls: yes.** MCP over HTTPS to `mcp.unpaged.io` (OAuth 2.0, the user's own Unpaged account, free tier works) and short authenticated HTTPS polls per armed canvas to the same host. Nothing else.
- **Installs additional software: no.** The listener runs inside Claude Code (the mod) and needs no Node; on an older Claude Code without mods it is plain Node ≥ 22 with no dependencies. The MCP server is remote (`type: http`), no `npx`/`uvx` launcher.
- **Programs run:** `hostname` (or `uname -n` where there is no `hostname`) once, for the label a key is minted with, each written whole at its call. Nothing else: the canvas name on the line above the prompt is a link Claude Code opens itself. No shell, no Node: the mod keeps its keys in the plugin's own store (`$.store`). The plugin README's *What the plugin runs, reads and sends* lists every call.
- **Permissions:** the plugin grants itself none. No hook answers *allow*; the key mint and revoke the mod makes itself, its three tools, and the *On it…* reply go through the user's own permission rules. The mod mints on its own only where those rules already allow `agent_listener_key_create` (otherwise the agent offers to listen and mints in its own turn), and posts *On it…* only where they allow `comment_reply` (otherwise the agent does); it asks the rules first with `$.tool.check`, which runs nothing and opens no dialog. The plugin README's *Permissions* section lists the rules for listening without being asked.
- **Credentials:** the listener key is minted by Unpaged for one canvas, kept in the plugin's own store (a file Claude Code keeps for the plugin, mode 600; on the Monitor path, `~/.claude/unpaged/listeners/<documentId>.json`, mode 600), kept out of the conversation, sent only to Unpaged, revocable from the command or from Unpaged. The plugin reads no other credential store.
- **Comments are data, not instructions:** an `@agent` comment is acted on only with Unpaged tools on that one canvas; never shell, file, git or network actions. Viewers get an answer, not a change.
- **Data sent:** the plan text and the elements drawn, the user's comments and the agent's replies, the Decision log rows the session writes while it implements, and — with `/unpaged:as-built` — file paths, commit subjects, diff summaries and the agent's description of the change (never file contents beyond a quoted identifier) — under the user's own account. No telemetry.
- **Domains owned by the publisher:** unpaged.io, mcp.unpaged.io (Graph Knowledge SRL).

## Directory findings

The directory's automatic review of v1.10.0 (2026-10-26) held it for a reviewer on these findings. Apart from the program starts, each is a capability the listener needs, so code cannot remove it; the plugin README's *What the plugin runs, reads and sends* answers it in the words the finding asks for.

| Finding | Where | Answer |
| --- | --- | --- |
| Fetches from the network and runs commands or tools; may start a program the directory couldn't fully check; starts other programs | `keyLabel` | The `hostname` and `uname -n` calls are written whole at the call. They are the only programs: the `open` / `xdg-open` the plugin started for `1: open` are gone, since the canvas name is now a link. README: *Programs it starts* |
| Calls tools itself | `mint`, `revoke`, `acknowledge` | README: *Tools it calls itself*, and the *Permissions* table |
| Reads local data or the conversation and sends data out; may send a request somewhere the directory couldn't check | `pollWith` | A fixed address is not possible: the poll's cursor is a query parameter of the Unpaged poll contract. README: *Hosts it contacts*, *What it sends, and where*, *What it reads* |
| Reads the conversation and submits a prompt | `sayWith` | README: *The prompts it submits* |
| Answers a tool call in place of the tool | `listen_arm` | Its own three tools, and the key mint. README: *The events it hooks* |
| Changes a tool's input before it runs | the key mint's hook | The `label` only. README: *The events it hooks* |
| Uses a credential from the user's machine (asks for a `user_config` option) | 6 findings | Not applicable: the listener key is minted per canvas by the plugin or the agent, nothing a person types. README: *Credentials* |
| Unrecognized field in `plugin.json` | 2 findings | `types` stays (see the checklist); the directory says an unknown field can stay |
| Hooks an event settings or instructions pass through (`classic.SessionStart`); hooks an event that is also a call (`command.run`) | notes | README: *The events it hooks* says what each changes |

## Reviewer test account

A free Unpaged account with a sample canvas is created for the submission and handed over in the form. It is not recorded here.

## Pre-submission checklist

- [ ] `claude plugin validate --strict plugins/unpaged` and `--strict .claude-plugin/marketplace.json` pass
- [ ] no hook answers a permission decision: the validator lists no `tool.check` hook, and `hooks/hooks.json` has no `PreToolUse` entry (`node --test` checks the latter)
- [ ] `plugins/unpaged/.claude-plugin/icon.png` is a square PNG of 512 to 2048 px under 2 MB, and `plugin.json` names `privacyPolicyUrl`
- [ ] `plugin.json` keeps `types`: the directory lists it as an unknown field, but Claude Code's validator refuses the mod's `$.state` keys without it
- [ ] every URL in the READMEs resolves
- [ ] the submitted tag's tree contains the `plugin.json` version, `homepage`/`repository`/`license`/`keywords`, and the marketplace description (`git show <tag>:plugins/unpaged/.claude-plugin/plugin.json`)
- [ ] reviewer account created, sample canvas shared with it, three prompts re-run on it
