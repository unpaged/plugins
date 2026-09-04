# UnPaged for Codex

Review a visual plan on Unpaged while its assigned Codex task handles feedback.
This package belongs to Unpaged and requires no external review framework.
It is an experimental integration, with the recovery boundaries below.

## Requirements

- Node.js 24 or newer, available to Codex and its hooks. No npm dependencies.
- Codex 0.153.1 or newer with the public `queue` command. The adapter checks
  the actual binary before arming; it does not assume the terminal and desktop
  use the same version.
- Authenticated Unpaged MCP with comment, listener-key, and revision-safe tools.
- Native Codex trust for this plugin's SessionStart hook. Installing a plugin
  does not itself grant hook trust. Do not bypass that review.

The package is under `plugins/unpaged-codex`; its manifest is
`.codex-plugin/plugin.json`. It is separate from the existing Claude package.
Distribution and installation are not performed by this repository change.

## Use

Invoke the bundled **review-plan** skill to create a plan or attach this task to
an existing board. New plans go in **Visual plans**. The agent arms the board
using the remote MCP listener key and the local adapter. It must report the
actual connection state before asking you to comment.

Mention `@agent` on the part you want changed. Human replies in an agent thread
also trigger review. General comments without a mention, edits to comments,
thread resolution, and silence are not acceptance signals.

The agent reads the full comment through MCP, makes a scoped revision-checked
change, and replies in the same thread. **Agents leave threads open; humans
resolve them.** A viewer's feedback is a proposal for an owner/editor to confirm.
If a human already resolved the thread, the agent respects that decision.

Each submitted plan has a content digest and a short version label, displayed
in a separate status element. To accept an exact version, the owner comments
`@agent` followed by the displayed `I accept plan version <version>` phrase.
The agent checks the current board
digest and records an acceptance receipt. Acceptance stops this review; it does
not authorize code implementation. Pending feedback or a reconciliation gap
blocks acceptance until addressed.

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
is private (0700) and the database is private (0600). The receive-only listener
credential is stored there to allow reconnection; it is not an OAuth token.
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
```

The automated tests use temporary databases and fake sockets/queue commands.
They do not spend model tokens or write to a live board. The earlier live spike
proved one actual board comment waking the same idle desktop task and producing
a revision-checked edit and open-thread reply; that spike is not installed-build
or restart evidence for this package.

Verified on 2026-09-05 with Node 24.15.0: the adapter and existing Claude tests
pass, including actual abrupt process termination at the received, dispatching,
and processing boundaries. Plugin and skill validators pass. The runtime
preflight selected the desktop's installed Codex 0.153.1 and verified its queue
options. Installed hooks, long-interval live operation, and app restart/task
reopen still require the installed-package trial described in the architecture.
