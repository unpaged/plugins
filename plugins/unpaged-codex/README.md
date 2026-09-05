# Unpaged for Codex

Review a visual plan on Unpaged while its assigned Codex task handles feedback.
This package belongs to Unpaged and requires no external review framework.
It is an experimental integration, with the recovery boundaries below.

## Requirements

- macOS or Linux. Worker process identity is supported on those platforms;
  Windows is not a supported pilot host.
- Node.js 24 or newer, available to Codex and its hooks. Node 24 is the tested
  LTS support floor for this pilot; it is deliberate, not a claim that
  `node:sqlite` first became unflagged there (that happened in Node 22.13).
  No npm dependencies.
- Codex 0.153.1 or newer with the public `queue` command. The adapter checks
  the actual binary before arming; it does not assume the terminal and desktop
  use the same version.
- Authenticated Unpaged MCP with comment, listener-key, and revision-safe tools.
- Native Codex trust for this plugin's SessionStart hook. Installing a plugin
  does not itself grant hook trust. Do not bypass that review.

The package is under `plugins/unpaged-codex`; its manifest is
`.codex-plugin/plugin.json`. It is separate from the existing Claude package.
Both live in the same plugin repository. The app monorepo contains neither.

## Build for the registered connection

From this repository's root, supply the actual registered Unpaged connection ID
and a new output directory outside every Git worktree. Its parent must already exist:

```sh
node scripts/build-codex-plugin.mjs --connection-id REGISTERED_PLUGIN_ID --output /absolute/new/unpaged-codex
```

Replace `REGISTERED_PLUGIN_ID` with the ID obtained from the native registration
flow. It has the `plugin_asdk_app_` prefix. Do not commit a personal ID or reuse
one as a public listing. The builder writes `.app.json`, connects the manifest's
`apps` field to it, and excludes the source package's direct `.mcp.json` connection.
The output has one registered connection, both skills, the startup hook and the
runtime. It never reads or copies the adapter database or OAuth credentials.
Existing output is refused rather than overwritten; the result prints its
canonical output path without the registration ID.

For a local pilot, point the personal Codex marketplace at that generated
package with the native plugin-creator flow, then install `unpaged-codex` from
that marketplace. Authenticate the registered Unpaged connection when prompted;
there is no separate manual MCP setup. Review the startup hook through Codex's
normal trust flow. A fresh task can then invoke the `visual-plan` skill.

The checked-in source `.mcp.json` remains a direct remote-MCP configuration for
hosts or distributions that explicitly choose that route. The registered build
does not ship it. Do not enable both connections for the same workflow by default.

Public distribution needs a reviewed registration accessible to the intended
customers and the complete installation/recovery trials. A working personal
registration does not establish that availability. This build step does not
publish the plugin or register a new server.

Official references: [plugin packaging](https://developers.openai.com/plugins/build/plugins),
[installation](https://learn.chatgpt.com/docs/plugins), and
[hook trust](https://learn.chatgpt.com/docs/hooks).

## Updating an existing pilot

Keep the plugin name, review data directory and startup-hook identity stable.
Generate and validate the registered package, then use the native update flow.
New receivers copy their executable files and bundled skills to a private,
content-addressed `${CODEX_HOME:-~/.codex}/unpaged/runtimes/<hash>/` directory before
launching. Queued messages reference that retained copy. Replacing the plugin
cache cannot delete the code needed by those receivers or messages. Snapshots
are retained; do not remove them while a review or queued event might use them.

A receiver already running from an older cache path is **not migrated by
installation**. Keep its original code available until its pending work has been
reconciled and it is deliberately stopped or migrated. Do not uninstall to update,
replace its listener key, or start a competing receiver. Local cache-deletion tests
cover retained runtime behavior; a native installed-package update with pending
feedback remains a release trial.

Stored worker ownership includes the operating-system boot and process start
identity, so reusing a PID does not make an unrelated process the review owner.
An unknown identity, including a live legacy PID with no stored identity, raises
`worker_identity_unverifiable`. Preserve that process and report the blocker;
installation does not silently migrate it or treat it as a new receiver.

## Use

Invoke the bundled **visual-plan** skill to render a supplied plan, the current
task's plan, or a draft for the feature you name. It preserves phases, tasks and
requirements, lays out the overview and useful phase detail, then delegates
review lifecycle to **review-plan**. Use review-plan directly for an existing
review, incoming events, status, recovery or stopping. New plans default to
**Visual plans** and honor an explicit folder choice. The agent arms the board
using the remote MCP listener key and the local adapter. It must report the
actual connection state before asking you to comment.

Mention `@agent` on the part you want changed. Human replies in an agent thread
also trigger review. General comments without a mention, edits to comments,
thread resolution, and silence are not acceptance signals.

The agent reads the full comment through MCP, makes a scoped revision-checked
change, and replies in the same thread. **Agents leave threads open; humans
resolve them.** A viewer's feedback is a proposal for an owner/editor to confirm.
If a human already resolved the thread, the agent respects that decision.

Both host plugins show **PROPOSED → ACCEPTED**. To accept, the owner comments
`@agent I accept this plan`. Whitespace, a trailing period or exclamation mark,
and `@agent:` are accepted; questions, quoted phrases and conditional approval
are not. A displayed legacy `I accept plan version <version>` phrase remains
supported for existing boards. Users do not need to type a hash for new reviews.

The Codex adapter retains the full digest internally and verifies that current
content still matches the submitted baseline. It records an owner acceptance
receipt and stops that review. Pending feedback or a reconciliation gap blocks
acceptance. Acceptance does not authorize implementation.

The server comment timestamp allows up to five seconds of clock skew. The local
event-receipt timestamp must be at or after the local submitted-baseline timestamp,
with no tolerance, so feedback already received before a revision cannot accept
that revision. Larger server/client discrepancies still defer acceptance for
verification. Neither timestamp check replaces current-content, owner-role or
outstanding-feedback checks.

The listener stays running between comments. After Codex closes, it can retain
received events and queue them for the assigned task. **Codex only automatically
wakes tasks loaded in its runtime.** Reopen the existing task after an app
restart; the SessionStart hook repairs its authorized receiver and exposes its
pending/recovery state. The adapter never starts a second model process or
creates a replacement task. It does not install a login service or wake a
sleeping computer.

## Recovery and limits

- A private SQLite ledger saves an event before enqueueing it and preserves
  board/task identity, queue IDs, operation tokens, and completion receipts.
  One event per board runs at a time. Duplicate socket events are ignored.
- Reconnects use bounded exponential backoff. Revocation, takeover, and protocol
  rejection stop the receiver. They do not silently mint new keys.
- `connected` means the WebSocket transport opened. The server has no explicit
  authentication-ready frame and can open a socket before rejecting its key.
  Previously received work may already be queued when that rejection arrives.
  The adapter blocks new board work as soon as it observes the terminal close;
  use the local stop command first when cancelling the whole review.
- An interrupted enqueue becomes `queue_uncertain`; interrupted board work
  becomes `effect_uncertain`. Neither is blindly retried. Inspect Codex's task
  history and the board, record what actually committed, and make an explicit
  recovery decision. `status` includes these states.
- Reconnection/restart marks `reconciliationRequired`: Unpaged currently has a
  limited replay window, and event creation is not guaranteed. Compare the
  actual unresolved comments with the ledger and get owner confirmation for
  feedback whose role cannot be established. Clear the flag only after that
  evidence is recorded. It is not a claim that the socket caught everything.
- Unpaged does not currently support an atomic idempotent edit/reply/receipt.
  The adapter prevents automatic repeated effects after uncertainty but cannot
  promise exactly-once board writes. Cross-host ownership is also not globally
  fenced by the present server. Use one assigned agent per board.
- Resuming an accepted plan is a new review decision. This version refuses
  implicit rebinding or transfer to another task.

See [ARCHITECTURE.md](ARCHITECTURE.md) for contracts and release gates.

## Data and stopping

Local data is in `${CODEX_HOME:-~/.codex}/unpaged/reviews.sqlite`. The directory
is private (0700) and the database is private (0600). Retained runtime snapshots live alongside it under `runtimes/`. The receive-only listener
credential is stored in the database to allow reconnection; it is not an OAuth token.
Treat database backups as credentials. Never print or attach the database.
Status and queued prompts contain routing metadata, not comment text or keys.
An explicit `--data /absolute/path` overrides the directory for tests; the
SessionStart hook uses the default directory.

Use the review-plan skill to stop: request local stop, revoke that exact key
through Unpaged MCP, verify revocation, then clear the stored credential. Other
boards and keys are untouched. Removing the plugin alone does not revoke a
server key or stop an already detached process; stop reviews before uninstalling.

## Spec driven development

Keep the team's chosen source of truth. If that is a repository spec, record its
path and revision in the plan and carry stable requirement IDs into review
items. A board is a review surface; it does not silently rewrite or synchronize
repository files. Check source drift before accepting a baseline. Spec approval,
plan approval, and permission to implement remain separate decisions.

## Verification

From the repository root, with Node 24 or newer:

```sh
node --test plugins/unpaged-codex/runtime/*.test.mjs
node --test plugins/unpaged/monitors/listen-core.test.mjs
node --test scripts/build-codex-plugin.test.mjs
```

The automated tests use temporary databases and fake sockets/queue commands.
They do not spend model tokens or write to a live board. The earlier live spike
proved one actual board comment waking the same idle desktop task and producing
a revision-checked edit and open-thread reply. An earlier installed package also
delivered native SessionStart context for its existing binding. Neither establishes
hook pickup or a live comment for this revised build.

The package test builds a real artifact with a synthetic connection ID and
executes its CLI, including a symlink-path invocation. Runtime tests cover cache removal, PID
reuse, acceptance text normalization and bounded clock skew. It also verifies no direct
MCP configuration remains in the registered artifact, both skill paths exist,
source files remain unchanged, existing outputs are protected, and source symlinks
cannot pull external files into the package. CI is configured to run these checks with the
existing listener and adapter tests on Linux and macOS.

Plugin and skill schema validation uses the installed OpenAI plugin-creator and
skill-creator validators during local authoring; those external tools are not
repository dependencies. Live visual fidelity, native hook pickup, comment
wakeup and recovery still need the installed-package trials described in the
architecture. A read-only connection check alone does not pass those gates.
