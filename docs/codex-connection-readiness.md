# Codex connection and visual-plan readiness

Maintainer runbook, refreshed on September 19, 2026 against current Claude
plugin source, local host metadata/help, and official OpenAI documentation.
This documentation-only change defines acceptance criteria and trial preparation.
It does not establish that installation, automatic refresh, native reconnect,
or the installed visual-plan loop has passed. Record those outcomes separately
below; no live trial was run for this refresh.

The customer requirement is: install Unpaged through the native interface,
sign in, and continue working. Access refresh should require no intervention.
When another sign-in is necessary, the host must show an actionable native
prompt and preserve the task. A working read, local package, terminal login,
or server-only test is insufficient evidence for that experience.

## Connection delivery and visual-plan delivery

An MCP-only Unpaged plugin backed by `https://mcp.unpaged.io/mcp` is the smallest
connection submission. It can pass authentication acceptance without supplying
the visual-plan skills, local receiver, hooks, or as-built workflow. Full
Claude-equivalent visual planning requires the separate lifecycle and
installed-host criteria below. Neither delivery gate substitutes for the other.

For an approved, published listing available to the intended customer:

1. Open the native Plugins directory and select the verified Unpaged listing.
2. Install it and complete its requested service sign-in.
3. Start a fresh task and verify the required Unpaged tools before doing work.

OpenAI documents this installation sequence for supported Codex surfaces. The
IDE extension does not support plugins. API-key-authenticated Codex accounts
have additional OAuth availability limits. Test the actual customer's host,
account type, and workspace policy; a listing on one account proves only that
account's access. See [native plugin installation](https://learn.chatgpt.com/docs/plugins).

Do not also add a direct MCP server for the same workflow. Preserve any existing
connection until its account, tools, and active work are understood; report a
duplicate before changing it. Never silently choose a different account to make
a trial pass.

| Delivery surface | What it supplies | What it does not establish |
| --- | --- | --- |
| Published MCP-backed plugin | The reviewed server integration and native install/sign-in entry point | Successful recovery on every supported host or customer eligibility |
| Local package mapping a registered connection through `.app.json` | A reference to that existing connection | A new registration, access rights, or public availability |
| Local package bundling a direct MCP server | Server configuration in portable `mcp.json`, or legacy `.mcp.json` | A published connection or registered-connector recovery behavior |
| Direct MCP in host settings | An independently configured server connection | Plugin installation or parity with the registered connection |

For a registered local pilot, its `.app.json` must refer to the intended
registration and its manifest must reference that file. Exclude direct MCP
wiring from that artifact. Use a synthetic identifier in packaging tests and
keep real personal registration identifiers out of source control. The manifest
connects components; authentication stays in the server/host integration.
Current packaging guidance prefers root `plugin.json` and `mcp.json`; legacy
`.codex-plugin/plugin.json` remains supported. Portable MCP entries declare
transport `type`; renaming the legacy file is insufficient. Put registered
connection mappings and hooks in `extensions.com.openai` for a portable package.
See [plugin packaging](https://developers.openai.com/plugins/build/plugins).

## Registration, ownership, and publication gates

Before promising a public customer flow, the release owner must verify:

- The submission is owned by the intended OpenAI organization; the submitter has
  Apps Management write access and a verified publisher identity.
- The submission supplies the universal production MCP URL, authentication
  configuration, working reviewer credentials, domain-control proof, accurate
  tool metadata, support/privacy/terms URLs, and test cases.
- OpenAI approved that exact submission and the owner explicitly published it.
- The intended customer can see and install the resulting listing.

Submit the MCP server itself through the portal. An existing integration
reference cannot substitute for a new MCP-backed submission. Record registration
ownership and review status from the authenticated portal; a local author field
is not ownership evidence. Publication remains a separately authorized action.
See [submission and publication](https://developers.openai.com/plugins/deploy/submission).

Workspace distribution is a separate route: administrators control availability
and required apps, and members still need service access and sign-in. Importing
a repository does not grant those permissions. A private workspace import does
not establish public customer availability.
See [workspace plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management).

## Detect failure and preserve work

The following are required behaviors to verify, not promises inferred from
OpenAI documentation:

| Condition | Detection and customer response | Resume rule |
| --- | --- | --- |
| Access token expired, refresh usable | Host refreshes credentials and continues without a sign-in prompt | Retry a read; verify mutation transport behavior separately |
| Refresh expired/revoked or OAuth grant revoked | Server rejects access correctly; host surfaces native sign-in/reconnect at the failing operation | Keep the existing task and resume after read-only verification |
| Insufficient permission | Server denies the operation; explain the missing document access or scope | Do not repeatedly sign in when the same account lacks access |
| Network outage or server failure | Report a temporary connection/service error, not an invalid-login claim | Retry reads after recovery; reconcile uncertain writes |
| Missing or stale tools | Compare the active catalog and schemas to the intended release | Stop affected operations and identify the connection/version |

Unpaged owns authorization enforcement and protocol responses. The host owns
stored credentials, automatic refresh, prompts/notifications, and how tools
remain available in an interrupted task. A plugin cannot guarantee host UI by
changing its description or installing a background login script.

Preserve the task's intended operation and last confirmed result before recovery.
Keep credentials and private content out of diagnostics. After reconnecting,
verify the same connection and account using a read before resuming. If a write
was sent but its response was lost, its outcome is **uncertain**: do not replay
it automatically. Read the relevant document/element, compare revisions and
operation evidence, and continue only when the committed result is established.
If the evidence is insufficient, ask the user to resolve that operation without
discarding the rest of the task.

If correctly signaled failure produces no native action, capture a minimal host
reproduction with exact host/server versions and redacted network evidence.
File it as an external recovery gate. Manual login, restart, or deleting and
re-adding the connection may diagnose the problem but do not pass acceptance.

## Isolate the installed-host trial

Use a separate test machine or OS user profile and dedicated Unpaged test
credentials. Do not copy production credentials, review ledgers, or listener
keys. A temporary CLI configuration alone does not isolate desktop plugin
caches or account state; establish those boundaries before using it as a trial.
The user completes native account sign-in and any account/workspace approval.

Before proposing an update on a profile that has visual review work, inspect
the running receiver's executable, imported runtime files, and paths referenced
by queued tasks. An old receiver can still depend on a superseded plugin cache.
Preserve that entire dependency set. Do not install over it, prune it, transfer
the review, alter its ledger, or replace its listener to run an auth trial.
Test listener event delivery and ordinary conversation wakeups independently
from MCP authentication.

On an isolated server/test tenant, use short token lifetimes and controlled
faults. Never shorten production token lifetimes or revoke a customer's session
for verification. Use a disposable document for mutation trials and give each
intended mutation an identifiable expected result.

## Connection acceptance matrix

Each row needs two results: protocol/packaged-server evidence and installed-host
evidence. A successful server check cannot fill the host column. All rows begin
**NOT RUN** until an evidence record identifies their observed result.

| Trial | Controlled setup | Required installed-host observation |
| --- | --- | --- |
| Fresh install and sign-in | Clean test profile, no Unpaged connections | One native installation/sign-in flow; intended tools available |
| Access expiry | Short access lifetime, usable refresh | Next operation succeeds automatically without login |
| Concurrent refresh | Two sessions using the test grant after expiry | Both recover; credentials remain usable after rotation |
| Lost refresh response | Interrupt response after server commits rotation | Host recovers usable credentials without a login loop |
| Expired/revoked refresh | Invalidate only the isolated test grant | Actionable native reconnect and preserved task |
| Invalid credentials | Present invalid test access credentials | Uniform auth rejection and actionable recovery, no tool loss hidden as success |
| Insufficient permissions | Same test account lacks access to a fixture | Permission denial without repeated login |
| Idle and restart | Let access expire while idle, then restart test host | Existing work remains; next operation refreshes or offers native action |
| Temporary network loss | Interrupt only the isolated test transport | Service error distinguished from auth; safe recovery after restoration |
| Catalog/plugin update | Publish or refresh only an authorized test version | Required names and schemas remain available on the intended connection |
| Interrupted write | Drop response after a disposable mutation commits | Readback detects committed result; no duplicate mutation on resume |

For capability checks, save the sorted tool names and input schemas and compare
the exact operations needed by the task. For document work, check listing,
document/node/element reads, and the intended mutation's revision contract.
For visual review, additionally check comment, listener, and revision-safe edit
tools, without arming a listener during an authentication-only trial. Historical
tool counts are not a capability contract; newly added tools can conceal removals.

Developer-mode connections have a native metadata Refresh flow. Published MCP
tools are scanned periodically: deletions apply when detected; new or changed
definitions go live after automated checks, with held updates retaining their
previous definition. Changes to submitted plugin information or imported skills
still need a new version, review, and publication. Check the observed catalog;
restarting is not evidence that an update arrived. See [connection metadata testing](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [published metadata versions](https://developers.openai.com/plugins/deploy/submission#how-published-mcp-metadata-versions-work).

## Current host evidence and its limits

Read-only checks on September 19, 2026 found:

| Component | Observed fact | Scope of evidence |
| --- | --- | --- |
| macOS | 27.0, build 26A428 | Local `sw_vers` output |
| Desktop app | ChatGPT.app 26.915.31945, build 9922 | App bundle metadata, not an installed-plugin trial |
| Desktop-bundled CLI | `/Applications/ChatGPT.app/Contents/Resources/codex`, version `0.155.0-alpha.9.2` | Its `queue --help` describes `--thread` and `--message` |
| CLI on `PATH` | `codex-cli 0.144.1` | Its `queue --help` returns generic help with no queue command |
| Node on `PATH` | `v24.15.0` | Local runtime version, not receiver operation |

Probe the executable the receiver will actually use. A zero exit code from
`queue --help` is not enough: check that the output describes the queue command
and its required arguments. Pin and record that executable for the trial; do
not infer capability from the desktop app version or choose an older CLI on
`PATH`. These observations establish capability discovery only. They do not
prove that queued work starts, targets the right task, survives an idle period,
or resumes after a restart.

Official guidance supports plugin hooks but requires review and trust of the
current hook definition. Installing or enabling the plugin alone does not arm
its hooks. `SessionStart` has startup/resume/clear/compact sources; hook scripts
must exist on the executing host. Record actual hook loading and trust in the
trial. Do not change trust settings or bypass them to manufacture a passing
result. See [plugin hook packaging](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)
and [Codex hooks](https://learn.chatgpt.com/docs/hooks).

## Visual-plan parity contract

The Claude baseline is the plugin at repository commit
`34ebef185dcca4230b7690bfca791904624c6e41`, including
[visual-plan](../plugins/unpaged/commands/visual-plan.md),
[approval context](../plugins/unpaged/hooks/plan-approved-context.json), and
[as-built](../plugins/unpaged/commands/as-built.md). The product outcome includes
plan rendering, comment-driven review, implementation tracking, and the final
record. A receive-only WebSocket or successful MCP call covers only part of it.
The following are Codex acceptance requirements, not claims that Claude and
Codex have identical internal states or that an installed pilot has passed.

| Plan phase | Required evidence and behavior |
| --- | --- |
| PROPOSED | A readable plan canvas in `visual-plans`, stable task identities, a status stamp, and a nested Decision log. Report filing warnings honestly. Bind review to this document and this Codex task/host. |
| ACCEPTED | Explicit human approval applies to the exact current plan version. Preserve that accepted version/digest as the approval receipt. Feedback, an empty inbox, or starting a listener cannot imply approval. |
| EXECUTING | Implementation begins within the user's authorized task scope after approval. Update the canvas stamp and append Decision log rows as choices are made. The receipt for the accepted plan remains intact while current canvas content changes. |
| BUILT | An as-built record reconciles every plan item against the inspected change and earlier records. Stamp BUILT only when no task remains open; report verification actually performed and remaining risks. |

An explicit instruction in the Codex task may both approve the displayed plan
and authorize implementation. Canvas comments are feedback for that canvas;
they do not authorize shell, repository, network, or unrelated tool work.
Keep listener state separate from plan phase: accepting a plan must not stop
feedback during execution or on its as-built record. Stopping a listener must
not mark work accepted or built. Previously terminal review bindings must not
silently reactivate or mint replacement keys during an upgrade.

The Decision log records the date, decision, why, and rejected alternative when
a deviation, dropped/added task, or consequential choice occurs. Do not invent
reasons later. The as-built record must include:

- Each task's done, changed, dropped, open, or added outcome. A dropped task
  needs a stated reason; absent work without that evidence stays open.
- Decisions whose reasons are marked recorded, reconstructed (explicitly an
  inference), or not recorded. Carry earlier completed outcomes forward; if a
  later range implements a previously dropped task, record its new outcome and
  cite the earlier drop.
- A reviewer's reading order, the affected boundaries and risks, and a map of
  tests performed and missing coverage. Add a before/after data-flow canvas
  only when a runtime flow changed.
- A dated nested record with the inspected base/head. A repeat run adds a new
  record; it does not silently overwrite an earlier one. Owner/editor-requested
  corrections remain attributable. A partial record ticks completed work but
  leaves the plan phase/stamp unchanged until nothing remains open.

Do not let an old acceptance receipt approve a changed proposal. Re-read after
a revision conflict and obtain approval for a revised plan when needed. Keeping
the accepted digest separate from the latest canvas digest is necessary because
Decision log entries and as-built children legitimately change the document.

## Comment identity and resolved-thread limits

The Unpaged app source inspected at commit
`f799585bb6fa781647e108148870ebcdda791131` defines these contracts in
`libs/domain/src/lib/models/agent-inbox.model.ts` and
`libs/mcp-server/src/lib/tools/comment-tools.ts`. Listener frames include event ID, `documentId`, `nodeId`, `threadId`, `commentId`, preview text, and
the author's role at event creation. `comments_list_unresolved` reads open
threads and their messages, but its message view omits comment IDs, user IDs,
and author roles. The preview may be truncated and event-time role may be stale.
Neither display name nor position in a message list proves which comment an
event represents or that its author still has editing authority.

Full-release acceptance requires an event handler to re-read authoritative
content and permissions for the same document, node, thread, and comment before
applying feedback. Match exact
comment identity; do not substitute the last human message or text matching.
The read needs current thread resolution, comment deletion/edit state, full
comment content, reliable author identity/current authority, and anchor context.
If the active catalog cannot supply that evidence, leave the event blocked for
reconciliation and report the missing read capability. Do not apply the preview
or acknowledge the event as completed merely because the thread was found.

An experimental pilot may correlate an open thread containing one human message
with an event when node, thread, and timestamp match unambiguously. Record that
as a limited pilot fallback: it does not prove the exact-comment/current-authority
read contract above. Multiple human messages or otherwise ambiguous identity
must remain blocked; the fallback cannot close the full-release gate.

Resolved threads are absent from `comments_list_unresolved`. Do not reopen a
thread just to inspect it: that changes human state before identity and authority
are checked. Leave that event blocked until a safe read of the resolved thread
is available, or the user explicitly reopens it and the remaining identity checks
can pass. The current missing read contract is an external Unpaged API gate;
local receiver tests and plugin instructions cannot close it. Agents ordinarily
reply and leave resolution to humans. Viewer feedback may receive an explanation
or proposal but cannot cause canvas edits or accept a plan.

## Installed visual-plan acceptance matrix

All rows are **NOT RUN** for this refresh. Exercise the installed candidate in an
isolated profile and retain separate source-test, packaged-runtime, and host
results. Do not fill these rows with a unit-test count or a historical pilot.

| Trial | Required installed-host observation |
| --- | --- |
| Render and arm | Correct folder, readable plan and Decision log, one task/host/document binding, trusted hook loaded, receiver attached without exposing keys |
| Idle comment and later rounds | After the agent turn ends, an authorized exact comment wakes that same task; re-read, revision-safe edit, reply, and leave the thread open; another review round works |
| Busy task and two canvases | Feedback is serialized with current work; each document wakes only its bound task; duplicate delivery produces no duplicate edit/reply |
| Identity and authorization | Edited/deleted messages, repeated text, viewer feedback, role changes, and mismatched comment IDs cannot cause unauthorized changes or approval |
| Resolved-thread feedback | Current comment identity, authority, and resolution are verified without reopening merely to read; missing capability is reported as BLOCKED |
| Approve and execute | Exact-version approval is retained; authorized work changes the phase to EXECUTING; feedback still arrives after acceptance; an edited proposal cannot reuse old approval |
| Decision log | A real implementation choice produces a contemporaneous row with its reason and rejected alternative |
| Partial and complete as-built | Inspected changes produce the nested record and reviewer guide; partial work preserves phase, completed reconciliation stamps BUILT; rerun preserves prior records |
| Receiver/host restart and task reopen | The same authorized binding resumes safely; unrelated tasks and old terminal reviews do not reactivate |
| Lost queue or mutation acknowledgement | Unknown delivery/effect remains uncertain until reconciled; no automatic duplicate enqueue, canvas edit, or reply |
| Stop, revoke, and upgrade | Stop prevents new admission; revoke result is confirmed; plugin/cache changes preserve active runtime dependencies and never silently transfer ownership |

An installed parity pass requires every applicable row to pass. A precisely
reproduced host or API limitation is a useful BLOCKED result, not a pass.

## Evidence record and completion

Create a redacted record per trial with:

```text
Trial / timestamp / PASS, FAIL, BLOCKED, or NOT RUN:
OS, host app version/build, bundled CLI version:
Account authentication type, plan, workspace policy (no identity):
Connection provenance and installed plugin version:
Server commit, deployed revision and immutable artifact digest:
Tool/schema baseline and required capabilities:
Controlled fault and expected result:
Protocol status/challenge and correlation ID (no tokens):
Observed native UI/action and screenshot reference (redacted):
Task preserved? Same account/connection confirmed after recovery?:
Mutation result/readback and duplicate count, if applicable:
Task/host/document binding, event/comment identity, and role-read evidence:
Plan phase, current digest, accepted digest, and as-built node, if applicable:
Remaining gate and responsible owner:
```

Report connection readiness only when supported native installation and recovery
are demonstrated. Report visual-plan parity only when its installed workflow
also passes. A reproduced external limitation is a BLOCKED gate with an owner,
not completed customer readiness. Keep protocol, source-test, packaged-runtime,
installed-host, and production results separate in the report.
