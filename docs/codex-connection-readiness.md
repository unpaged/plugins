# Codex native connection and recovery readiness

Maintainer runbook, checked against official OpenAI documentation on September
6, 2026. This document defines acceptance criteria and trial preparation. It
does not establish that installation, automatic refresh, or native reconnect
has passed on a customer account. Record those outcomes separately below.

The customer requirement is: install Unpaged through the native interface,
sign in, and continue working. Access refresh should require no intervention.
When another sign-in is necessary, the host must show an actionable native
prompt and preserve the task. A working read, local package, terminal login,
or server-only test is insufficient evidence for that experience.

## One installation path

Use an MCP-only Unpaged plugin backed by `https://mcp.unpaged.io/mcp` as the
smallest public submission. Authentication delivery does not require the
separate visual-plan skills, local receiver, or lifecycle hooks.

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
| Local package with `apps: "./.app.json"` | A reference to an existing registered connection | A new registration, access rights, or public availability |
| Local package with `mcpServers: "./.mcp.json"` | A bundled direct MCP configuration | A published connection or registered-connector recovery behavior |
| Direct MCP in host settings | An independently configured server connection | Plugin installation or parity with the registered connection |

For a registered local pilot, its `.app.json` must refer to the intended
registration and its manifest must reference that file. Exclude direct MCP
wiring from that artifact. Use a synthetic identifier in packaging tests and
keep real personal registration identifiers out of source control. The manifest
connects components; authentication stays in the server/host integration.
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

## Acceptance matrix

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
plugins use reviewed metadata snapshots: scan changes, submit a new version,
and publish the approved version. Do not tell published-plugin customers that
restarting will update a reviewed catalog. See [connection metadata testing](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [published metadata versions](https://developers.openai.com/plugins/deploy/submission#how-published-mcp-metadata-versions-work).

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
Remaining gate and responsible owner:
```

Complete customer readiness only when supported native installation and recovery
are demonstrated, or when an external host limitation is precisely reproduced
and the remaining account/publication/deployment gate is explicit. Keep protocol,
packaged-server, installed-host, and production results separate in the report.
