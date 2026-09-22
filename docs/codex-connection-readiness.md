# Codex connection and visual-plan readiness

Maintainer runbook, setup guidance refreshed on September 22, 2026. The Codex
adapter and setup checks merged in PRs #5 and #21. The [installed trial record](codex-installed-trial-2026-09-19.md)
documents the observed 0.3.0 plan lifecycle and 0.3.1 setup, update and native
recovery results. The runtime is on `main`; this runbook records release
criteria and evidence, not another implementation. For current setup and use,
follow the [repository installation steps](../README.md#install-for-codex--preview)
and the [Codex package README](../plugins/unpaged-codex/README.md) for usage.

The local registered-connection pilot passed real comment review, explicit
approval and implementation, partial/complete as-built records, native restart
recovery, and a fresh post-recovery comment. This does not establish clean-profile
installation/sign-in, OAuth expiry/revocation recovery, public availability,
or unrestricted comment-identity and exactly-once guarantees. The matrices below
keep those remaining gates visible, with each result attributed to its host,
version and scenario.

The customer requirement is: install Unpaged through the native interface,
sign in, review the startup-hook approval once, and continue working. A deliberate
hook-definition change requires renewed native approval. Ordinary unchanged-hook
updates should retain it. Access refresh should require no intervention.
When another sign-in is necessary, the host must show an actionable native
prompt and preserve the task. A working read, local package, terminal login,
or server-only test is insufficient evidence for that experience.

## Connection delivery and visual-plan delivery

An MCP-only Unpaged plugin backed by `https://mcp.unpaged.io/mcp` is the smallest
connection submission. It can pass authentication acceptance without supplying
the visual-plan skills, local receiver, hooks, or as-built workflow. Full
Claude-equivalent visual planning requires the separate lifecycle and
installed-host criteria below. Neither delivery gate substitutes for the other.

For the current repository marketplace, use a supported Codex CLI in this order:

```sh
codex plugin marketplace add unpaged/plugins
codex plugin add unpaged-codex@unpaged
codex mcp login unpaged
```

Complete Unpaged sign-in through the explicit login command, then review the
SessionStart hook before listening. The installer returning successfully, or its
`ON_INSTALL` authentication policy, does not establish sign-in. A user-reported
fresh Ubuntu installation of 0.4.0 confirmed the separate login step is needed.
The user then confirmed sign-in and native hook trust; a screenshot showed
`visual-plan` and `review-plan` loading. A PROPOSED canvas and Decision log were
subsequently verified independently. Native sandbox failures blocked 0.4.0 CLI
listener setup. With the 0.5.0 candidate, the user confirmed local-tool discovery,
`info` and ready setup in the same task after a plugin enable-switch refresh.
The installed `fddbe96` candidate then polled successfully and woke that same
task on a real human comment. Remote readback verified exactly one requested
monthly-review note and one agent reply, with the canvas still PROPOSED. The
user confirmed successful event completion before VM shutdown; the durable
receipt was not independently read. Delivery took 26.4 seconds and wakeup 28.3
seconds, but the canvas write remained unanswered for at least 3 h 17 min and the
reply arrived about 3 h 29 min after the comment. The cause of the write wait was
not established, so timely feedback completion is not proven. The plan lifecycle,
an update to the final candidate with its native instructions and restart recovery remain unverified
in that trial. See the [dated trial evidence](codex-repository-install-trial-2026-09-20.md#listener-startup-and-human-comment-delivery) and
[Codex MCP login](https://learn.chatgpt.com/docs/extend/mcp?surface=cli#other-cli-commands).

For a separately approved, published listing available to the intended customer:

1. Open the native Plugins directory and select the verified Unpaged listing.
2. Install it and complete its requested service sign-in.
3. Start a fresh task and verify the required Unpaged tools before doing work.

For a listening visual plan, discover the current installed `unpaged_review`
server's `review` tool and call `operation: "doctor"` before creating a listener
key; `arm` repeats the check before opening state.
When trust is missing or changed, give the user the action for their host: in the
CLI, open `/hooks` and review and trust the Unpaged plugin's **SessionStart** hook;
in the desktop app, use **Settings → Hooks → From Plugins → Unpaged for Codex →
Trust** on that hook row. **⌘,** opens Settings on macOS. Keep the hook enabled,
then recheck. See [native hook trust](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).
Other setup failures have their own action; a folder-wide configuration warning is not a
request to trust Unpaged again. Do not make log inspection, manual ledger repair,
or repeated restarts part of customer setup. Render-only canvases skip this gate.
See the [implemented setup check](../plugins/unpaged-codex/runtime/setup.mjs).

The 0.5.0 candidate runs setup and detached-worker launch through this local
stdio MCP tool on the host. Native per-call metadata supplies the actual task
and workspace; missing metadata fails closed before listening. The model cannot
choose a task, executable, data directory or environment. If the tool is missing
after an update on desktop build 26.915.31945, use the
[bounded plugin enable-switch refresh](../plugins/unpaged-codex/README.md#missing-local-review-tool-after-an-update),
then rediscover it in the same task and run `info` followed by `doctor`. This is
conditional update recovery, not a routine fresh-install step. Preserve the
same profile and existing binding; do not prescribe SQLite grants, copied state,
repeated reinstalls or all-access mode. See the
[skill's native tool contract](../plugins/unpaged-codex/skills/review-plan/SKILL.md#runtime-and-tools).

`doctor` starts a bounded temporary native app-server in the current profile;
startup can initialize native storage even though the hook query changes no
settings. A `native_state_initialization_failed` result from the local tool is
a host setup blocker, not an instruction to grant database access. Preserve the
canvas and report it. The earlier Ubuntu 0.4.0 sandbox failures remain historical
evidence in the [trial record](codex-repository-install-trial-2026-09-20.md).

Native local MCP launch and metadata were inspected in Codex
`0.155.0-alpha.9.2`; source evidence does not prove installed worker survival,
comment delivery or restart recovery. Ordinary Linux `bwrap` still cannot
launch a persistent receiver: its per-command PID namespace ends with the
command, and cannot safely identify host workers. Legacy bookkeeping, setup and
worker CLI paths require explicitly approved host execution. Pure `digest` and
`info` remain available in an ordinary sandbox for render-only work. Keep actual
listener and recovery observations separate from the setup result.

Setup readiness establishes persisted hook configuration, not a running listener
or proven recovery. Reopen the same existing task after an app restart; the
trusted SessionStart hook restores only that task's authorized reviews. Complete
feedback reconciliation before proceeding. Do not create a replacement task or key.

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
| Repository marketplace (Codex preview) | Fresh CLI Git installation and bundled-server discovery passed; a user confirmed Ubuntu 0.4.0 sign-in and hook trust, with skill loading visible in a screenshot; a PROPOSED canvas and Decision log were independently verified; same-task local-tool discovery and ready setup with the 0.5.0 candidate are user-confirmed; installed candidate `fddbe96` polled and woke on a real human comment; remote readback verified one requested edit and one agent reply while the canvas remained PROPOSED; event completion is user-confirmed | The canvas write issued at `09:05:27Z` still awaited a result at `12:23Z` for an unestablished reason; the reply came about 3 h 29 min after the comment, so timely completion remains unproven despite fast delivery and wakeup. Independent receipt readback, plan lifecycle, final-candidate update with native instructions and restart recovery remain unverified in the Ubuntu trial; public-directory availability is separate |
| Local package mapping a registered connection through `.app.json` | A reference to that existing connection | A new registration, access rights, or public availability |
| Local package bundling a direct MCP server | Server configuration in portable `mcp.json`, or legacy `.mcp.json`; installation smoke passed, with the later Ubuntu setup, canvas, polling, human-comment wakeup, edit, reply and user-confirmed event completion described above | A published connection, timely completion after the unexplained write wait, independent receipt readback, plan lifecycle, final-candidate update with native instructions or restart recovery in the Ubuntu trial |
| Direct MCP in host settings | An independently configured server connection | Plugin installation or parity with the registered connection |

Repository distribution is separate from OpenAI's public directory. Codex can
add a GitHub marketplace and install its listed plugins without a public-directory
listing. The [Codex catalog](../.agents/plugins/marketplace.json) is named
`unpaged` and lists `unpaged-codex` at `./plugins/unpaged-codex`.
`.claude-plugin/marketplace.json` remains the separate Claude Code catalog;
the Codex package is absent there by design. The [customer preview instructions](../README.md#install-for-codex--preview)
target the repository's `main` branch, where the catalog is available.
The [September 20 CLI smoke](codex-repository-install-trial-2026-09-20.md) verified
local and Git installation, installed-file identity and bundled-server discovery
in fresh CLI state. It did not sign in or exercise a desktop profile. Before
treating these instructions as verified customer onboarding, complete desktop
installation, service sign-in, hook approval and the visual-plan lifecycle,
including restart recovery, on a clean profile. The required Node 24+, macOS/Linux
and native Codex capability checks still apply. Customers need no personal
registration ID or artifact build.
See [repository marketplace setup](https://developers.openai.com/plugins/build/plugins#add-a-marketplace-from-the-cli).

The source Codex package bundles direct MCP configuration; that route does not
require customers to build a personal registered artifact or supply a registration
ID. Its CLI installation smoke found the server enabled but `not_logged_in`.
All recorded 0.3.0 lifecycle and 0.3.1
setup, update and recovery results used the registered artifact, which excluded
`.mcp.json`. Those registered-pilot observations do not establish sign-in, hook
approval, lifecycle or recovery behavior for the bundled-direct-MCP route.

For a registered local pilot, its `.app.json` must refer to the intended
registration and its manifest must reference that file. Replace only the remote
`unpaged` MCP connection; retain the bundled local `unpaged_review` stdio server
in `.mcp.json`. Use a synthetic identifier in packaging tests and
keep real personal registration identifiers out of source control. The manifest
connects components; authentication stays in the server/host integration.
Current packaging guidance prefers root `plugin.json` and `mcp.json`; legacy
`.codex-plugin/plugin.json` remains supported. Portable MCP entries declare
transport `type`; renaming the legacy file is insufficient. Put registered
connection mappings and hooks in `extensions.com.openai` for a portable package.
See [plugin packaging](https://developers.openai.com/plugins/build/plugins).

## Registration, ownership, and publication gates

For distribution through OpenAI's public Plugins Directory, the release owner
must verify:

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

Keep distribution-specific identifiers separate. The tested local builder takes
the registered `plugin_asdk_app_` identifier supported by that host flow. Current
workspace-import guidance instead requires an app ID such as `asdk_app_` in
`.app.json` and explicitly excludes `plugin_...` IDs. Do not assume the pilot
artifact is already a validated workspace-import artifact; verify that route
and its mapping independently before distribution.

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
The September 19 visual-plan pilot reused an existing authenticated connection
and a disposable canvas/repository in the existing desktop profile. It does not
meet this clean-profile authentication boundary. Its results apply only to the
workflow and recovery cases actually observed; no authentication faults were injected.

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
evidence. A successful server check cannot fill the host column. The controlled
authentication cases below remain **NOT RUN** in the September 19 pilot. The
installed-package update preserved access to the required tools, but did not test
published metadata refresh or a changed tool schema. Worker restart recovery is
not an OAuth-expiry result.

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

## Recorded host evidence and its limits

The September 19 pilot recorded this host. These are dated observations, not a
claim about all supported customer environments:

| Component | Observed fact | Scope of evidence |
| --- | --- | --- |
| macOS | 27.0, build 26A428 | Local `sw_vers` output |
| Desktop app | ChatGPT.app 26.915.31945, build 9922 | Local installation and real restart/reopen observed on this host |
| Desktop-bundled CLI | `/Applications/ChatGPT.app/Contents/Resources/codex`, version `0.155.0-alpha.9.2` | Queue capability checked; real same-task delivery recorded separately |
| CLI on `PATH` | `codex-cli 0.144.1` | Its `queue --help` returns generic help with no queue command |
| Node | `v24.15.0` | Runtime tests and the installed recovered receiver used this version |
| Installed Codex package | 0.3.0, then `0.3.1+codex.20260919152134` | Lifecycle on 0.3.0; setup/update/restart/post-recovery comment on 0.3.1 |

Probe the executable the receiver will actually use. A zero exit code from
`queue --help` is not enough: check that the output describes the queue command
and its required arguments. Pin and record that executable for the trial; do
not infer capability from the desktop app version or choose an older CLI on
`PATH`. Verified help/version output establishes capability discovery only; it
does not prove that queued work starts, targets the right task, survives an idle
period, or resumes after a restart. The [trial record](codex-installed-trial-2026-09-19.md)
separately records actual idle wakeups, native restart recovery, and a
post-recovery reply.

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
Codex have identical internal states. Observed pilot results are recorded in
the matrix below; the Claude source baseline remains unchanged by PRs #5 and #21.

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
silently reactivate or mint replacement keys during an upgrade. Before changing
a legacy ledger schema, the runtime refuses a live or unverifiable old worker
(`legacy_worker_upgrade_required`) or unfinished old events
(`legacy_events_upgrade_required`). Quiesce the old worker and reconcile its
unfinished receipts with the old runtime before retrying the upgrade.

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
  corrections remain attributable. A partial record during execution ticks
  completed work and leaves the phase/stamp unchanged. A record added to a
  proposed or accepted binding changes its content baseline: submit it as
  PROPOSED and require fresh approval, retaining earlier acceptance receipts.

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
If the active catalog cannot supply that evidence, full-release acceptance
remains blocked. Do not apply the preview or treat finding a thread as proof of
identity. The experimental handler follows the narrower fallback and skip
rules below; its local completion state is not proof of the missing contract.

An experimental pilot may use a single-human-message heuristic for an open
thread with matching document, node, and thread. It does not prove exact comment
identity or current authority. Event `createdAt` is the inbox emission timestamp
(`functions/src/comments/notify-comment-activity.ts`), while the comment read
returns the message creation time. These timestamps need not match; use dates
only to assess plausibility, never as an identity join. Multiple human messages
or other ambiguity must defer. This limited fallback cannot close the
full-release exact-read gate.

Resolved threads are absent from `comments_list_unresolved`. Do not reopen a
thread just to inspect it: that changes human state before identity and authority
are checked. The current pilot leaves the thread untouched and records the event
as skipped with this evidence limit, as specified by [review-plan](../plugins/unpaged-codex/skills/review-plan/SKILL.md).
The full-release gate stays blocked until a safe exact read is available; a
skipped receipt is not an applied-feedback result. If a human explicitly reopens
the thread, evaluate any new routed feedback using the same identity rules.
The missing read contract is an external Unpaged API gate; local receiver tests
and plugin instructions cannot close it. Agents ordinarily
reply and leave resolution to humans. Viewer feedback may receive an explanation
or proposal but cannot cause canvas edits or accept a plan.

## Installed visual-plan acceptance matrix

Results below are from the [September 19 installed trial](codex-installed-trial-2026-09-19.md).
**PASS** applies only to the stated version and scenario. **PARTIAL** means an
observed subset; **BLOCKED** identifies a missing contract; **NOT RUN** means no
live evidence. Source tests do not fill an installed-host result.

| Trial | Result and installed-host evidence | Remaining scope |
| --- | --- | --- |
| Render and arm | PASS on 0.3.0: readable canvas in Visual plans, Decision log, one assigned task/document, active receiver | New 0.3.1 creation after its pre-arm setup gate has not been rerun live |
| Setup approval before listening | PARTIAL on 0.3.1: doctor detected modified approval, user trusted it in native settings, doctor became ready | Blocked-arm/no-ledger-mutation behavior passed automated tests; complete first-customer setup remains NOT RUN |
| Idle comments and later rounds | PASS on 0.3.0: two real idle wakeups revised the requested plan elements, replied once each and left threads open | Uses the documented single-human-message heuristic, not immutable comment identity |
| Feedback during execution | PARTIAL on 0.3.0: event arrived during Phase 2, was handled there; delayed queued notification caused no second edit/reply | Full two-canvas concurrency and forced duplicate-delivery trials remain NOT RUN |
| Identity and authorization | BLOCKED for full acceptance: current MCP omits per-message IDs/current author roles | Edited/deleted messages, role changes and ambiguity require exact authoritative reads; adversarial live matrix NOT RUN |
| Resolved-thread feedback | BLOCKED for full acceptance: current tool reads unresolved threads only | Exact resolved/deleted-state read needed; do not reopen solely to inspect |
| Approve and execute | PASS on 0.3.0 for real owner acceptance, continued feedback and separately authorized implementation | Changed-after-acceptance and pre-execution record resubmission remain NOT RUN live |
| Decision log | PASS on 0.3.0: three contemporaneous choices with reasons/rejected alternatives | No broader project integration claimed |
| Partial and complete as-built | PASS on 0.3.0: partial record preserved while a dated complete record and reviewer guide were added; four tasks done, zero open, BUILT | Other repeat-run and correction cases remain NOT RUN live |
| Native restart/reopen | PASS on 0.3.1 after trust: SessionStart restored the same receiver before model commands; task/key/BUILT/digests/five receipts preserved | The first untrusted-hook attempt failed on 0.3.0; no automatic restoration of closed tasks is claimed |
| Reconciliation and post-recovery comment | PASS on 0.3.1: reconciliation completed, a new real comment woke the idle task and received one reply; six events completed | Unresolved-only reads cannot prove complete unseen feedback history or exactly-once effects |
| Ordinary installed update | PASS for a 0.3.1 update with unchanged hook and no unfinished events: trust and ledger contents preserved | Update with pending work and clean-profile upgrade remain NOT RUN live |
| Legacy ledger migration | PARTIAL: controlled migration to 0.3.0 preserved three existing bindings and their completed receipts after verified old workers were paused | No unfinished legacy events were present; migration with unfinished work is not demonstrated |
| Lost queue or mutation acknowledgement | NOT RUN live; uncertainty states covered by local fixtures | Fault-injected host evidence still needed; no blind replay |
| Stop and exact-key revocation | NOT RUN live for this completed trial; receiver deliberately remains listening | Verify stop/revoke/readback without affecting other reviews when cleanup is authorized |

The pilot demonstrates a useful installed workflow, not full customer-release
acceptance. An installed parity pass requires every applicable scenario and
the connection and chosen distribution route's gates to be satisfied. Preserve
the version and scenario boundary when reporting a PASS; do not combine partial
rows into a blanket recovery or authorization guarantee.

## Evidence record and completion

Create a redacted record per trial with:

```text
Trial / timestamp / PASS, PARTIAL, FAIL, BLOCKED, or NOT RUN:
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
