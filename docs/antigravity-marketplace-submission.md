# Antigravity Plugin Marketplace submission pack

Reference answers for submitting `plugins/unpaged-antigravity` to the Google Antigravity Plugin Marketplace via the [Antigravity Marketplace partner intake form](https://forms.gle/2EX5RFYPoJe1UgxR9) (linked from https://antigravity.google/docs/build-plugins#publish-to-the-antigravity-marketplace). Keep this file free of credentials: any reviewer test account is provided only in the submission form.

## Identity

| Field | Value |
| --- | --- |
| Plugin name | `unpaged` |
| Display name | Unpaged |
| Repository | https://github.com/unpaged/plugins |
| Plugin path in repository | `plugins/unpaged-antigravity` |
| Version | `0.5.0` (passes `agy plugin validate --strict` with zero warnings) |
| Homepage | https://unpaged.io |
| Privacy policy | https://unpaged.io/privacy |
| Terms of service | https://unpaged.io/terms |
| Contact | https://unpaged.io/contact |
| Support | https://github.com/unpaged/plugins/issues · https://discord.gg/K8TR7cUGX |
| License | MIT |
| Category | Productivity / planning (collaboration) |
| Logo | `assets/logo.svg` (128×128 transparent SVG) |

## Short description

Visual plans, architecture documents, and whiteboards on Unpaged — render plans as interactive canvases, keep repository architecture docs in step with the code from a native side panel, attach Can view invite links to GitHub PRs, receive @agent comments, keep Decision logs, and compile as-built records.

## What it does (long)

Unpaged for Google Antigravity turns implementation plans and system architectures into interactive multi-canvas whiteboards on Unpaged:

- **`visual-plan`** renders the current plan (an Antigravity implementation plan artifact, a plan in chat, or a feature you name) as a structured Warm Paper overview canvas (What this is about, What it wants to achieve, connected clickable phase cards in numbered 1–9 reading order, risks/out-of-scope cards, and a Decision log dock) with nested phase canvases carrying task checklists, exit criteria, and optional existing mocks. It inspects every rendered canvas with `node_picture`, records the branch plan so pull requests get a **Can view** invite link and preview, and arms a receive-only background listener (`monitors/listen.mjs --once <documentId>`) that wakes the session when collaborators post `@agent` comments.
- **`architecture` & native side-pane panel (`sidecars/architecture/`)** reads a repository's code alone and draws an architecture canvas organised by a new engineer's questions (`create`), checks on demand in a separate clean-slate helper whether code changes invalidated any card without rewriting (`compare`), and rewrites outdated cards or redraws changed flows with open comments (`update`). In the desktop app, the **Unpaged Architecture** auxiliary side-pane panel displays the status light, elapsed time, canvas link, and clickable **Compare** / **Update** / **Create** / **Sync status** buttons that run directly in your open conversation without creating background chats, paired with a zero-token `SessionStart` notice (`hooks.json`, `monitors/session-start.mjs`) that speaks up only when the document is behind, stale, or unreachable.
- **Session rules (`rules/AGENTS.md`)** flip the canvas status to `🚀 EXECUTING` when you approve the plan, keep the `📝 Decision log` table up to date as implementation choices happen, reply to `@agent` canvas comments strictly within Unpaged MCP tools (never running shell, file, git, or external network commands from collaborator comments, and never editing on a `viewer`'s request), and attach the canvas's **Can view** preview when a GitHub pull request is opened for the branch.
- **`as-built`** reconciles the plan canvas and its Decision log against the git diff and pull request, compiles a dated, frozen `📐 As built · <date>` canvas nested under the plan (plan delta, recorded vs reconstructed decisions, reviewer guide, and optional data flow diagram), and stamps the plan `✅ BUILT`.
- **`listen`** checks listener status, arms additional canvases, or revokes listener keys on the server and removes retired local key files.
- **Bundled remote MCP server (`mcp_config.json`)** connects over HTTPS to `https://mcp.unpaged.io/mcp` using OAuth 2.0 (free Unpaged tier works; uploading mock pictures needs Premium).

## Suggested / verification prompts

1. `Create a visual plan on Unpaged for adding a --json output flag to this CLI` — drafts a grounded phased plan, renders the overview, phase canvases, and Decision log on Unpaged, checks each canvas with `node_picture`, returns the edit link, and arms `@agent` comment push.
2. `Compare this repo's architecture canvas with the code` — checks claims since the last compared commit in a clean-slate helper, updates the date note/comment thread on Unpaged, saves the local mode-0600 verdict, and updates the **Unpaged Architecture** side panel.
3. On the rendered canvas in Unpaged, add a comment mentioning `@agent` asking to add a verification task to Phase 1 — the background listener wakes Antigravity, acknowledges with `"On it…"`, updates the canvas via Unpaged MCP tools, replies with a one-line summary, leaves the thread open, and re-arms.
4. After approving and implementing the plan: `Compile the as-built record on Unpaged for this branch` — creates the nested `📐 As built · <date>` canvas and stamps the plan `✅ BUILT`.

## Security, privacy & runtime disclosures

- **Bundled MCP server:** Remote HTTPS MCP endpoint at `https://mcp.unpaged.io/mcp` (`mcp_config.json`), authenticated with OAuth 2.0 to the user's own Unpaged account (no static API keys, no local MCP process).
- **Runtime requirement:** Node.js 22 or newer (uses Node's built-in `fetch`; zero third-party npm dependencies).
- **External network calls:**
  - `https://mcp.unpaged.io/mcp` (MCP tools via OAuth 2.0) and `https://mcp.unpaged.io/events/poll` (short authenticated HTTPS polls per armed canvas using a receive-only, canvas-scoped listener key).
  - When a plan includes existing mock pictures and the user's account has Premium, mock files/screenshots upload via one-time ten-minute signed links to Unpaged's picture-upload Cloud Function (`europe-west1-knowledgegraph-72939.cloudfunctions.net`), and picture URLs are fetched by Unpaged's server.
  - When a GitHub pull request exists or is created for the branch, `gh pr view` / `gh pr edit` updates only a bounded `<!-- unpaged-plan:start --> ... <!-- unpaged-plan:end -->` preview block in the PR description.
- **Local storage:** Per-canvas receive-only listener keys at `~/.gemini/unpaged/listeners/<documentId>.json`, poll cursors at `~/.gemini/unpaged/monitors/<documentId>.json`, listener ownership records at `~/.gemini/unpaged/monitors/ownership/<documentId>.json`, architecture verdicts and active-run states at `~/.gemini/unpaged/architecture/`, and branch-to-plan records at `~/.gemini/unpaged/plans/` (all mode `0600`, written atomically via temp file + rename). The plugin reads no other credential stores and sends no telemetry.
- **Local sockets & sidecar UI:** While a canvas is armed, `monitors/listen.mjs` holds a majority (three of five) of deterministic loopback-only TCP ports on `127.0.0.1` (in `20000–59999`, derived from the canvas ID and state directory) so a single local listener owns each canvas. The **Unpaged Architecture** sidecar (`sidecars/architecture/server.mjs`) binds strictly to `127.0.0.1`, requires Antigravity's `X-Sidecar-Token` on all POST requests, holds no Unpaged OAuth tokens, and makes zero external network requests.
- **Session hook:** `hooks.json` registers a local-only `SessionStart` command (`monitors/session-start.mjs`) that reads local verdict files and emits a zero-token user-only notice only when an architecture canvas needs attention.
- **Prompt-injection boundary:** Collaborator `@agent` comments, `.unpaged/architecture.json`, and architecture canvas cards are treated strictly as untrusted data. `rules/AGENTS.md`, `skills/architecture/`, and the listener preamble forbid running shell commands, editing local files, running git operations, or making network calls from comments, prohibit modifying the canvas for `viewer` comments, escape untrusted labels, and render side-panel UI without `innerHTML`.
- **Publisher-owned domains:** `unpaged.io`, `mcp.unpaged.io` (Graph Knowledge SRL).

## Pre-submission checklist

- [ ] `agy plugin validate --strict plugins/unpaged-antigravity` exits 0 with zero errors and zero warnings (also verified against the merged `https://github.com/unpaged/plugins/tree/main/plugins/unpaged-antigravity` URL after merge)
- [ ] `node --test plugins/unpaged-antigravity/monitors/*.test.mjs plugins/unpaged-antigravity/sidecars/architecture/*.test.mjs` passes (including the 24,000-byte loader-limit check on every skill body, reference file, and `rules/AGENTS.md`)
- [ ] `plugins/unpaged-antigravity/plugin.json` includes `$schema`, `name`, `displayName`, `description`, `version`, `logo`, `author`, `homepage`, `repository`, `license`, `keywords`, and 3 `suggestedPrompts`
- [ ] Every public URL (`https://unpaged.io`, `/privacy`, `/terms`, `/contact`, `https://github.com/unpaged/plugins`, `https://mcp.unpaged.io/.well-known/oauth-protected-resource/mcp`) returns HTTP 200
- [ ] Reviewer test account (free Unpaged account with a sample canvas) is prepared separately and supplied only inside Google's submission form
