# Changelog

All notable changes to the `unpaged` plugin. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions are the `version` field of `plugins/unpaged/.claude-plugin/plugin.json`.

## [Unreleased]

## [1.0.1] - 2026-09-08

Directory submission prep, metadata only: no behaviour change.

### Added

- `plugin.json`: `homepage`, `repository`, `license`, `keywords`; `marketplace.json`: a description (the one `claude plugin validate` warning, so `--strict` passes on both manifests).
- README: privacy policy and terms links under Privacy, a verified contact channel under Support — both asked for by the Software Directory Policy.
- `docs/directory-submission.md`: the community marketplace form answers, disclosures, and the three working prompts.

## [1.0.0] - 2026-09-08

First stable release. The fresh-machine test (clean Ubuntu VM, free Unpaged account) passed on every item — cold install, OAuth, first-command render, folder filing, push, approval stamp, `listen` status/arm/revoke, takeover, key rejection and the stale-cache locator — and the fixes below are what fell out of it, plus the ones the first Claude reviews of this repo found in them; they went through 23 rounds of automated review before merging. 0.5.2 was merged but never tagged; its changes ship here.

### Fixed

- Auto mode: its classifier refuses the listener-key mint and the key-file writes, so push could never arm there and the session only said "Push isn't armed". Both commands now stop on that refusal and tell the user the one-time manual-mode route (`/unpaged:listen arm <documentId>`) or the allow rules to add; the README has a troubleshooting row for it. A key minted right before a refused file write is revoked on the spot, and a half-written `<documentId>.json.tmp` is removed, so auto mode cannot accumulate keys without files toward the 20-key cap.
- The 4401 exit line names the real causes (the key was revoked in another session or in Unpaged) instead of leaving the model to guess at server behaviour, and it says what happened to the key file. A session never mints a new key because of a 4401 (every cause is a deliberate revoke): it says push is off for that canvas and that `/unpaged:listen arm <documentId>` turns it back on. Before, a revoke was undone by a re-mint seconds later, and a re-arm could mint over another session's newer key file. A later `/unpaged:visual-plan` arms only the canvas it creates, and the line and the README row say so instead of offering it as a remedy.
- `/unpaged:visual-plan` retries a single create call that a classifier refused while its siblings succeeded — the per-phase node creates are the usual case — instead of reporting a half-built canvas.
- Key files outlive a server that cannot be reached. In 0.5.1, `/unpaged:listen status` (and `arm`) read a failed or refused `agent_listener_keys_list` as "every key is dead" and could delete every listener key file on the machine while the keys stayed live on the server; `revoke` had the same shape. Now no command retires a key file on a list that did not come back: `status` reports liveness as unknown, `arm` still arms with the stored key (the socket authenticates with the key, not the MCP session), and `revoke` deletes only files whose own revoke call returned success. A key file that stores no `keyId` (older layout) is kept and reported as unverified everywhere.

### Changed

- `/unpaged:listen revoke` is reworked. A key counts as this machine's if its label matches the host **or** its `keyId` is named by a key file under `~/.claude/unpaged/listeners/` (the label is only the hostname at arming time and can drift; the tradeoff is a `~/.claude` shared or synced between machines, where a revoke here also revokes there). After revoking, the command re-lists the server's keys and deletes key files by that list, not by what it attempted: a file whose key is still live because its revoke was refused or failed is kept, and that canvas is reported as still live, since only the server-side revoke stops a running listener. The full `~/.claude/unpaged/listeners/*.json*` sweep (tmp and retiring leftovers included) runs only when nothing was kept. The lister helper now prints each file's `keyId` (an identifier, never the key) so no step reads a key file.
- The spoken lines say canvas, not board: the render reply calls the link a canvas and a fresh draft canvas, "approving the plan will stamp the canvas EXECUTING", "Another session was listening to this canvas", and the revoke reply says "push is off until" the user re-arms.
- README: demo clip (release assets), screenshots, a new live example canvas, and troubleshooting rows for auto mode and for the 4401 line that says "a newer key for this canvas is already stored by another session".
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

[Unreleased]: https://github.com/unpaged/plugins/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/unpaged/plugins/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/unpaged/plugins/compare/v0.5.1...v1.0.0
[0.5.1]: https://github.com/unpaged/plugins/releases/tag/v0.5.1
[0.5.0]: https://github.com/unpaged/plugins/pull/4
[0.4.0]: https://github.com/unpaged/plugins/pull/3
[0.3.0]: https://github.com/unpaged/plugins/pull/2
[0.2.1]: https://github.com/unpaged/plugins/pull/1
