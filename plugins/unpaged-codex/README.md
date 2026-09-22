# Unpaged for Codex

Review a visual plan on Unpaged while its assigned Codex task handles feedback.
This package belongs to Unpaged and requires no external review framework.
It is an experimental integration, with the recovery boundaries below.

## Requirements

- macOS or Linux. The 0.5.0 candidate uses a native local MCP tool for setup,
  bookkeeping and detached-worker launch. Installed Linux pickup of the final
  candidate and restart recovery still need verification. Windows is not a supported pilot host.
- Node.js 24 or newer, available to Codex, its local MCP servers and hooks.
  Node 24 is the tested support floor; no npm dependencies are required.
- Codex with local stdio MCP, native per-call task/workspace metadata, the
  public `queue` command and native `hooks/list` support. These source contracts
  were verified in native `0.155.0-alpha.9.2`; missing metadata fails closed.
  The older CLI's version check alone does not establish local-tool support.
  The adapter verifies the actual queue binary before arming.
- Authenticated Unpaged MCP with comment, listener-key, and revision-safe tools.
- Native Codex trust for this plugin's SessionStart hook. Installing a plugin
  does not itself grant hook trust. Do not bypass that review.

The package is under `plugins/unpaged-codex`; its manifest is
`.codex-plugin/plugin.json`. It is separate from the existing Claude package.
Both live in the same plugin repository. The app monorepo contains neither.

## Install from the repository (preview)

**Installation smoke passed; full workflow pending:** a [fresh CLI trial](../../docs/codex-repository-install-trial-2026-09-20.md)
installed this package from GitHub, verified its files and discovered its bundled
direct MCP server as `not_logged_in`. In a later fresh Ubuntu setup with 0.4.0,
the user confirmed explicit sign-in and native hook trust, and a screenshot
showed `visual-plan` and `review-plan` loading. A PROPOSED canvas and Decision log
were independently verified. The 0.4.0 CLI listener setup hit native sandbox
failures. With the 0.5.0 candidate, the user confirmed local-tool discovery,
`info` and a ready `doctor` result in that same task after the bounded refresh
below. The installed `fddbe96` candidate subsequently polled successfully, and
read-only VM inspection verified a real human comment reaching and waking the
same task. The requested canvas edit and single reply were independently read
back, and the user confirmed successful event completion. Plan lifecycle and
restart recovery remain unproven; later PR revisions have not been installed
there. The canvas write waited at least 3 h 17 min for an unestablished reason,
and the reply arrived about 3 h 29 min after the comment; timely feedback
completion is not proven. The [earlier registered-connection pilot](../../docs/codex-installed-trial-2026-09-19.md)
does not establish those results for this package.

Run these commands with a supported Codex CLI:

```sh
codex plugin marketplace add unpaged/plugins
codex plugin add unpaged-codex@unpaged
codex mcp login unpaged
```

The [Codex catalog](../../.agents/plugins/marketplace.json) is named `unpaged`
and points to this package, which contains all three skills, the startup hook,
the local runtime, the remote `unpaged` connection to `https://mcp.unpaged.io/mcp`,
and the local stdio `unpaged_review` server. Its `review` tool performs local
setup and review bookkeeping; remote Unpaged tools read and change the canvas.
You do not need a personal registration ID, a generated artifact or another
manual MCP connection.

Complete Unpaged sign-in through the explicit `codex mcp login unpaged` command;
plugin installation does not complete this step. Then review and trust the
SessionStart hook as described below before listening. Start a fresh Codex task
and invoke `visual-plan`; the agent verifies the tools actually available before
using them. If sign-in or required tools are unavailable, report that
setup blocker rather than treating installation as a successful connection.
The CLI smoke returned without completing sign-in even though the catalog's
authentication policy is `ON_INSTALL`; that policy is not proof of authentication.

## Hook approval before listening

Before creating a listener key, the agent discovers the current installed
`unpaged_review` / `review` tool and calls `operation: "doctor"`. Tool prefixes
can differ, so it uses the tool actually exposed in the task. If approval is missing or the hook changed, use the native
approval surface: in the CLI, open `/hooks` and review and trust the Unpaged
plugin's **SessionStart** hook. In the desktop app, open **Settings → Hooks →
From Plugins → Unpaged for Codex**, review that hook row and click **Trust**.
On macOS, **⌘,** opens Settings.
Keep the hook enabled. The agent rechecks after approval; it does not ask the customer to
inspect logs, edit trust files, or repeatedly reinstall/restart. Other setup
problems return their own next action. Folder-wide hook configuration warnings
or errors are reported separately from Unpaged approval, without exposing their
raw content. Render-only canvases do not need this
approval. `arm` independently rechecks readiness before opening local state.

`doctor` reports persisted native setup, not successful comment delivery or
proof that the running app loaded the hook. It never runs a hook, opens the
review ledger, or starts a receiver. Live listening and restart recovery are
verified separately. The integration remains experimental; the dated evidence
and remaining gates are described below.

The local MCP process runs the setup check and worker launch on the host using
native task/workspace metadata. It accepts fixed review operations, not arbitrary
commands or paths. Codex's native child may initialize its own runtime storage;
this no longer depends on granting that storage to an agent command sandbox.
The current profile is preserved through `CODEX_HOME` forwarding. If native
metadata or the local tool is unavailable, listening remains blocked before a
key is minted. For an absent tool after an update, use the
[bounded refresh below](#missing-local-review-tool-after-an-update); repeated
installation is not a repair procedure.

For a Codex binary outside the standard locations and launch `PATH`, set
`UNPAGED_CODEX_PATH` to its absolute path in the environment that launches Codex.
The local server forwards this trusted host setting and verifies the binary's
version and queue capability. It never accepts an executable path in tool
arguments. Reload the local tools after changing that launch environment.

The CLI remains available for retained legacy helpers and explicitly approved
host maintenance. Pure `digest` and `info` operations remain safe in an ordinary
command sandbox; they open no ledger, inspect no process and start no native
Codex child. Render-only work can use that digest fallback if the local tool is
unavailable. Do not launch or verify a host worker through ordinary Linux
`bwrap`: detached children cannot outlive that command's PID namespace, and host
PIDs are not reliably visible inside it. Directory/network grants do not change
that boundary. No SQLite-file grants, copied state, alternate profile or
all-access mode are part of the normal customer flow. Preserve an existing
binding and report a blocker rather than guessing worker ownership.

The local-tool path is a 0.5.0 candidate. On installed commit `fddbe96`, the user
reported a live worker and successful polls 30.4 seconds apart. Read-only VM
inspection subsequently confirmed a connected polling worker and a real human
comment waking the same task. The requested edit and single reply were read back,
and the user confirmed event completion before shutting down the VM. Delivery
took 26.4 seconds and wakeup 28.3 seconds, but the subsequent write waited at
least 3 h 17 min for an unexplained reason; the reply arrived about 3 h 29 min
after the comment. Timely completion is therefore not established. Pickup of
the final candidate, its native instructions and native restart recovery remain
unverified. See the
[dated evidence](../../docs/codex-repository-install-trial-2026-09-20.md#local-review-tool-candidate--september-22-2026).

Repository marketplace distribution is separate from publication in OpenAI's
public Plugins Directory. That directory route needs a reviewed registration,
explicit publication and intended-customer availability. Neither a repository
catalog nor a working personal registration establishes a public-directory listing.

Official references: [plugin packaging](https://developers.openai.com/plugins/build/plugins),
[installation](https://learn.chatgpt.com/docs/plugins),
[MCP login](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#other-cli-commands), and
[hook trust](https://learn.chatgpt.com/docs/hooks).

### Missing local review tool after an update

If the updated plugin is installed but the same task cannot discover its local
review tool, desktop build **26.915.31945** supports this bounded refresh: open
**Plugins → Plugins tab → Unpaged for Codex**, turn the plugin enable switch
off, wait for the update to finish, then turn it on. Return to the same task,
rediscover the tool, and run `info` followed by `doctor`. This refreshes loaded
tasks and plugin configuration without uninstalling or changing saved hook trust,
sign-in or review storage. It was user-confirmed in the Ubuntu trial.

Use this once for a missing tool after an update, not as a normal fresh-install
step. The **MCPs** tab in this build has no Restart control for plugin servers.
If the tool remains absent, report the blocker and preserve the canvas and
existing binding; do not loop through toggles, reinstalls or app restarts.

## Advanced: build for a registered connection

This is the separate route used by the local pilot. It replaces the bundled
direct MCP connection with a reference to an existing registered connection.
Use only one connection route for a review.

From this repository's root, supply the actual registered Unpaged connection ID
and a new output directory outside every Git worktree. Its parent must already exist:

```sh
node scripts/build-codex-plugin.mjs --connection-id REGISTERED_PLUGIN_ID --output /absolute/new/unpaged-codex
```

Replace `REGISTERED_PLUGIN_ID` with the ID obtained from the native registration
flow. It has the `plugin_asdk_app_` prefix. Do not commit a personal ID or reuse
one as a public listing. The builder writes `.app.json`, connects the manifest's
`apps` field to it, and removes the remote direct connection from `.mcp.json` while retaining the
local `unpaged_review` stdio server. The output has one registered remote
connection, local review tools, all three skills, the startup hook and runtime. It never reads or copies the adapter database or OAuth credentials.
Existing output is refused rather than overwritten; the result prints its
canonical output path without the registration ID.

For a local pilot, point the personal Codex marketplace at that generated
package with the native plugin-creator flow, then install `unpaged-codex` from
that marketplace. Authenticate the registered Unpaged connection when prompted
and use the hook approval flow above. This build step neither publishes the
plugin nor registers a new server.

## Updating an existing installation

Keep the plugin name, review data directory and startup-hook identity stable.
Use the native update flow for the marketplace from which it was installed.
Registered-pilot users first regenerate and validate their registered artifact;
repository users keep the bundled direct MCP route. Do not switch connection
routes as part of an ordinary update.
Run the local `doctor` operation again after updating. If the same task cannot
discover the updated plugin's local review tool, use the
[bounded refresh above](#missing-local-review-tool-after-an-update); do not
repeat installation to repair tool discovery. Codex requires renewed approval
when the hook definition changes. Keep the definition stable for ordinary
runtime/skill updates; do not bypass approval for a deliberate hook change.
An existing receiver and its key, task, phase and receipts remain intact while
approval is pending. An interrupted receiver on an active binding is recovered
on that same binding, never by issuing a replacement key or creating another
task. A review stopped by the user or server remains stopped.
New receivers copy their executable files and bundled skills to a private,
content-addressed `${CODEX_HOME:-~/.codex}/unpaged/runtimes/<hash>/` directory before
launching. Queued messages reference that retained copy. Replacing the plugin
cache cannot delete the code needed by those receivers or messages. Snapshots
are retained; do not remove them while a review or queued event might use them.

Before opening a 0.2 ledger with the new helper (including its SessionStart
hook), use the original retained helper to reconcile all unfinished events and
quiesce its receiver. Migration refuses a live or unverifiable legacy worker
with `legacy_worker_upgrade_required`, and any unfinished legacy event with
`legacy_events_upgrade_required`, before changing the schema. Preserve the old
helper, queue paths, key and ledger while resolving those blockers; do not erase
receipts or mint a replacement key to bypass them. This is an explicit upgrade
procedure, not an automatic handoff between incompatible runtime versions.
Drain/reconcile with the old helper while the binding is active, then use a
graceful SIGTERM only on its verified plugin-owned receiver so it releases
worker ownership. The CLI `stop` command permanently stops that review; it is
not an upgrade pause. A stopped legacy binding with unreconciled events remains
blocked instead of being silently repaired.

A receiver already running from an older cache path is **not migrated by
installation**. Version 0.4.0 uses the deployed HTTP polling endpoint. Normal
`resume` or trusted SessionStart recovery can hand over an active socket receiver:
verify its recorded boot and process start identity, request graceful
shutdown, and wait for it to exit before starting the polling receiver. If the
identity or shutdown cannot be verified, preserve the binding and report the
blocker. `upgradePending` identifies an in-progress detached handover; wait for
a recent `lastSuccessfulPollAt` before claiming polling is working. The CLI `stop` command remains a permanent review stop.

The additive migration derives the canonical polling URL from the validated
stored socket binding and preserves the same credential, task, plan phase,
digests and event receipts. Keep original and retained helpers available for
queued operations; the transport handover does not retry or acknowledge their
effects. Do not uninstall to update, replace the listener key, or start a
competing receiver. Local cache-deletion tests
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
requirements, lays out the overview and useful phase detail, and a Decision log, then delegates
review lifecycle to **review-plan**. Use review-plan directly for an existing
review, incoming events, status, recovery or stopping. New plans default to
**Visual plans** and honor an explicit folder choice. The agent arms the board
using the remote MCP listener key and the local `review` tool. Its fixed operation
input never accepts a task ID, executable, data path, cwd or environment override;
native metadata supplies the task and workspace. It must report the
actual connection state before asking you to comment.

Mention `@agent` on the part you want changed. Human replies in an agent thread
also trigger review. General comments without a mention, edits to comments,
thread resolution, and silence are not acceptance signals.

The agent reads the full comment through MCP, makes a scoped revision-checked
change, and replies in the same thread. **Agents leave threads open; humans
resolve them.** A viewer's feedback is a proposal for an owner/editor to confirm.
Current MCP reads expose unresolved threads without individual message IDs.
The adapter defers ambiguous feedback and does not reopen a resolved thread just
to discover what it says. Claude currently reopens resolved reply events; exact
comment reads and authorization are still needed for safe parity on this path.

Codex tracks **PROPOSED → ACCEPTED → EXECUTING → BUILT**. Claude starts
execution directly when its user approves implementation. In Codex, plan
approval and the task user's instruction to implement remain distinct. To accept, the owner comments
`@agent I accept this plan`. Whitespace, a trailing period or exclamation mark,
and `@agent:` are accepted; questions, quoted phrases and conditional approval
are not. A displayed legacy `I accept plan version <version>` phrase remains
supported for existing boards. Users do not need to type a hash for new reviews.

The Codex adapter retains the full digest internally and verifies that current
content still matches the submitted baseline. It records an owner acceptance
receipt and keeps listening. Pending feedback or a reconciliation gap blocks
acceptance. Acceptance alone does not authorize implementation. An explicit
instruction from the user in the assigned Codex task permits implementation;
`review-plan` records that evidence before setting EXECUTING. Board comments
cannot grant permission to run shell commands or edit the repository.

Every new canvas includes a Decision log. During authorized implementation,
append choices and deviations as they happen, with the reason and rejected
alternative. The **as-built** skill reconciles the exact Git range against plan
items and the log, creates a dated record with reviewer guidance and runtime
flow when relevant, and distinguishes recorded reasons from inference. A partial
record leaves the phase unchanged; a verified complete record can advance an
executing plan to BUILT. Existing records remain unchanged on subsequent runs.
Listening continues through all phases until the user stops it.

The accepted digest remains an approval receipt as the current canvas digest
advances through log entries, checklist progress and as-built records. Changes
after acceptance but before execution return the plan to PROPOSED and require
fresh approval. Approval history is retained. The local lifecycle commands are
trusted task bookkeeping, never commands supplied by canvas collaborators.

Acceptance requires the matched human message's actual creation timestamp
from MCP; the inbox event timestamp records later emission and cannot substitute
for it. Missing or invalid comment time blocks acceptance. The human timestamp
allows up to five seconds of server/client clock skew. The local
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

The receiver polls every 30 seconds, slowing to 60 seconds after an hour without
a new event. New feedback returns it to the normal interval. These are polling
intervals, not maximum response times: network availability and the assigned
task's state also affect delivery and processing.

Worker ownership checks run on the host through the local tool or trusted
recovery hook. Do not substitute process inspection from an agent command
sandbox, weaken identity checks, or bypass hook trust.

## Recovery and limits

- A private SQLite ledger saves an event before enqueueing it and preserves
  board/task identity, queue IDs, operation tokens, and completion receipts.
  One event per board runs at a time. Replayed event IDs are ignored.
- Failed polls retry with bounded exponential backoff using the same key.
  Invalid or revoked keys (401) and supersession by a newer key (409) stop the
  receiver. They do not silently mint new keys. Rate limiting (429) and service
  failures (503) are retryable, not proof that a key is invalid.
- `connected` means an authenticated poll succeeded, including an empty result.
  `lastSuccessfulPollAt` records that response; `lastEventAt` records the latest
  newly received event. Normal waits between healthy polls remain connected.
  Local tool status also returns `workerAlive` from a fresh host identity check:
  true for the recorded process, false when absent or replaced, and null when
  inspection is unavailable. Neither process liveness nor a successful poll
  proves comment delivery or recovery.
  A failed poll reports reconnecting and a reconciliation gap. Previously
  received work may already be queued when a terminal response arrives.
  The adapter blocks new board work as soon as it observes that response;
  use the local `stop` operation first when cancelling the whole review.
- An interrupted enqueue becomes `queue_uncertain`; interrupted board work
  becomes `effect_uncertain`. Neither is blindly retried. Inspect Codex's task
  history and the board, record what actually committed, and make an explicit
  recovery decision. `status` includes these states.
- Reconnection/restart marks `reconciliationRequired`: Unpaged currently has a
  limited replay window, and event creation is not guaranteed. Compare the
  actual unresolved comments with the ledger and get owner confirmation for
  feedback whose role cannot be established. Clear the flag only after that
  evidence is recorded. A successful poll alone does not establish complete history.
- Unpaged does not currently support an atomic idempotent edit/reply/receipt.
  The adapter prevents automatic repeated effects after uncertainty but cannot
  promise exactly-once board writes. The server's newer-key rule does not fence
  two machines sharing the same key. Use one assigned agent per board.
- Legacy 0.2 bindings whose listener state is already terminal `accepted` stay
  terminal after upgrade. Updating the package does not resurrect their keys or
  transfer them to another task. Reconcile and finish their exact cleanup first.
- New accepted, executing and built phases keep the listener active. SessionStart
  on startup, resume or compaction restores phase and recovery context for the
  same root task. It does not turn a plan approval into implementation permission.

See [ARCHITECTURE.md](ARCHITECTURE.md) for contracts and release gates.

## Data and stopping

Local data is in `${CODEX_HOME:-~/.codex}/unpaged/reviews.sqlite`. The directory
is private (0700) and the database is private (0600). Retained runtime snapshots live alongside it under `runtimes/`. The receive-only listener
credential is stored in the database to allow reconnection; it is not an OAuth token.
Treat database backups as credentials. Never print or attach the database.
Status and queued prompts contain routing metadata, not comment text or keys.
The local tool and SessionStart hook use that same default directory; the MCP
server forwards the native `CODEX_HOME` setting. Only the legacy CLI supports
`--data` for isolated tests or explicitly approved host maintenance. The local
tool never accepts a data-path override.

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
node scripts/validate-codex-marketplace.mjs
node --test plugins/unpaged-codex/runtime/*.test.mjs
node --test plugins/unpaged/monitors/*.test.mjs
node --test scripts/*.test.mjs
```

The automated tests use temporary databases and injected HTTP/queue fixtures.
They do not spend model tokens or write to a live board.

The [September 19 installed trial](../../docs/codex-installed-trial-2026-09-19.md)
records a macOS pilot using an existing registered connection. Version 0.3.0
demonstrated rendering, repeated and busy comment review, acceptance with
continued feedback, authorized implementation, Decision logs, and partial and
complete as-built records. Version 0.3.1 retained native approval across an
unchanged-hook update, automatically restored the same BUILT review after an
app restart and task reopen, and handled a fresh comment with one read-only
reply. This was neither a clean-profile installation/sign-in trial nor a full
0.3.1 rerun of the earlier lifecycle. Those versions used sockets; the trial does
not prove installed 0.4.0 polling, socket-to-poll handover, or the 0.5.0 local-tool
launch and restart recovery.

The package test builds a real artifact with a synthetic connection ID and
executes its CLI, including a symlink-path invocation. Runtime tests cover cache removal, PID
reuse, acceptance text normalization, bounded clock skew, lifecycle transitions,
legacy terminal bindings and approval history. It also verifies no remote
direct MCP connection remains in the registered artifact, while the local
review server and all three skill paths exist,
source files remain unchanged, existing outputs are protected, and source symlinks
cannot pull external files into the package. CI is configured to run these checks with the
existing listener and adapter tests on Linux and macOS.

Plugin and skill schema validation uses the installed OpenAI plugin-creator and
skill-creator validators during local authoring; those external tools are not
repository dependencies. The [maintainer readiness runbook](../../docs/codex-connection-readiness.md)
tracks the remaining publication, authentication, fault-recovery, pending-work
update and cleanup gates, alongside the backend identity and history limits.
A read-only connection check alone does not pass those gates.
