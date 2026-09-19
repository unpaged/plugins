# Codex installed trial — September 19, 2026

This redacted maintainer record captures one local registered-connection pilot.
It supports the results in the [readiness runbook](codex-connection-readiness.md);
it is not a public release announcement or a fresh-customer installation test.
The [package README](../plugins/unpaged-codex/README.md) remains the usage guide.

## Candidate and environment

| Item | Recorded value |
| --- | --- |
| Host | macOS 27.0 (26A428), ChatGPT.app 26.915.31945 (9922) |
| Native CLI | Desktop-bundled `0.155.0-alpha.9.2`; PATH CLI `0.144.1` lacked the required queue command |
| Runtime | Node 24.15.0 |
| Connection | Existing authenticated registered Unpaged connection; registered package added no direct MCP configuration |
| Fixture | Disposable two-phase greeting plan and local repository, one assigned Codex task |
| Initial package | `0.3.0+codex.20260919091820`, tested adapter head `cfda36fd22d9745245e190e8fd525eb38ecf2045`, merged by PR #5 |
| Recovery package | `0.3.1+codex.20260919152134`, source `cdca9e7e935a5a25922e5e4faa19e0660f5f7233` |
| Recovery merge | PR #21 merged as `5ba8871e4e4d6798aa360a2f6ddf67d66dbf7ea8`; its tree equals the tested recovery-package source |

The cache suffix identifies the actual local installed package, not a published
version available to customers. The registered artifact excluded direct MCP
configuration; installed files matched it apart from the manifest cache suffix.
Credentials, registration IDs, listener keys, private document URLs, personal
filesystem paths and raw database backups are deliberately excluded here.

This pilot reused an existing account and desktop profile. A disposable canvas
and repository isolated feature work, not authentication. No controlled OAuth
expiry, revocation, lost-response or network fault was injected. The deployed
server commit/revision was not pinned by this trial, so observed remote behavior
does not establish an immutable production-server certification.

Initial installation included a controlled migration to the 0.3.0 ledger after
two verified old plugin workers were gracefully paused. Three pre-existing
bindings and their completed receipts were preserved, including keys, tasks,
digests and reconciliation flags. No unfinished legacy event was present. This
is limited migration evidence, not a pending-work or unattended upgrade pass.

## Evidence and its scope

The trial used full MCP document/comment readback, native task/queue logs,
read-only ledger snapshots, verified worker process identity, disposable Git
commits and test output, plus read-only rendered canvas review. The coordinating
task independently checked the reported outcomes. Raw evidence remains local
with the trial owner; this committed record is a summary, not an attached audit
bundle or a claim of independently reproducible server state.

The 0.3.1 source candidate passed 138 Node tests covering the Claude listener,
Codex runtime and registered packaging. Source plugin, all three skills and
generated artifact passed schema validation. Linux/macOS CI and the automated
review passed at the same source head; all three review findings were fixed.
Those checks support the code and package. The observations below separately
support the installed behavior. No runtime tests were rerun just to write this
documentation.

## Plan lifecycle on 0.3.0

| Trial | Observation |
| --- | --- |
| Render and arm | Created the plan in Visual plans, with overview, two phases, four unchecked tasks, status stamp and Decision log. Rendered review and MCP readback verified the canvas. One receiver was bound to its existing task. |
| First idle round | Human requested Grace as a second named example. The idle task woke automatically, preserved Ada, changed the scoped acceptance example with a revision precondition, replied once and left the thread open. |
| Second idle round | Human changed the planned empty-name result to `Hello, there!`. The same task woke, updated the three affected plan elements, read them back and replied once. |
| Owner acceptance | A real standalone acceptance comment accepted the exact current digest. Status became ACCEPTED, the original listener remained active, and implementation did not start. |
| Feedback after acceptance | A new human question received a reply without changing the accepted plan or starting implementation. |
| Phase 1 | A separate task-user instruction authorized only named greetings. Two tests passed; the agent recorded choices and appended a partial as-built record while Phase 2 remained open. |
| Phase 2 and busy arrival | A separate task-user instruction authorized the fallback. A real comment arrived during that turn, was answered there, and its later queued notification was recognized as already completed without a second effect. |
| Complete record | Three tests passed: Ada → `Hello, Ada!`, Grace → `Hello, Grace!`, empty string → `Hello, there!`. A complete as-built record and reviewer guide were added while the partial record stayed unchanged. Four tasks were done, zero open; status became BUILT. |

The disposable source range was local fixture baseline
`df878fdc76a1e14340fbde605498324c7281fce8` through Phase 1
`dbbd1ec206b61d5f605381f58dec1405eb5ab90a` and Phase 2
`0d73ff70c27f1ec896720a2586888fa047161d12`. These are fixture commits, not plugin
repository commits. No application integration or deployment was tested.

The final canvas contained ten nodes, 63 elements and three contemporaneous
Decision log entries. The first five human events had completed receipts;
there were no outstanding events. The accepted digest stayed an immutable
approval receipt while the current digest advanced through implementation and
records. Read-only rendered QA checked the overview, phase completion, records,
reviewer guides and flow diagrams.

Comment matching used the experimental single-human-message fallback: exact
routed document/node/thread, one current human message, and event-time role.
The MCP read did not expose individual message IDs or current author roles.
These results do not prove immutable comment identity or fresh authority. The
busy-arrival result does not cover a full two-canvas race or injected duplicates;
it also does not establish that a duplicate `begin` call was executed live.

## Setup and native recovery on 0.3.1

Times below are UTC on September 19. The listener was deliberately paused for
the restart trial using one graceful signal after verifying its exact identity.
Its active binding, key, BUILT phase, digests and five receipts were preserved;
the terminal `stop` command was not used. Unrelated reviews were left intact.

1. **Initial recovery attempt failed on 0.3.0.** After the first real app restart
   at 12:47, the receiver remained stopped. The task did not manually repair it.
   Later native inventory reported the changed SessionStart hook as untrusted
   (`modified`). The inventory result identified a concrete setup blocker;
   the startup logs alone had not established the cause.
2. **Setup check and approval verified.** The 0.3.1 installed helper reported
   the missing current approval and the native Trust action. The user trusted
   the hook in Settings. The helper then reported ready/enabled/trusted.
   No trust file was edited and no bypass was used. Automated tests cover
   blocked `arm` without opening or mutating the ledger; new 0.3.1 creation
   through the complete setup-to-arm flow was not repeated live.
3. **Ordinary update preserved approval.** A subsequent 0.3.1 installed update
   retained the exact hook definition and its trust. Before/after snapshots
   showed the bindings, events, acceptance receipts and database bytes unchanged.
   No unfinished event was present; this does not cover updating pending work.
4. **Native recovery succeeded.** The app restarted at 18:00:17.021 and the same
   task resumed at 18:00:35.732. Native `hooks.additional_context` at 18:00:39.482
   already reported a connected recovered worker. The first model command was
   at 18:01:07.366, 27.884 seconds later. There was no manual `arm`, `resume` or
   `session-start` invocation. Binding, key, BUILT phase, digests and five receipts
   were unchanged; the expected reconciliation flag was set.
5. **Reconciliation completed.** The owning task compared the full canvas and
   all five exposed open threads with event/reply receipts, found no unhandled
   exposed feedback, and recorded reconciliation at 18:08:59.768. Pending and
   uncertain counts were zero. This did not prove completeness for unresolved
   API gaps such as deleted/resolved threads or missing current author roles.
6. **Fresh post-recovery delivery succeeded.** A real new comment at
   18:16:31.884 asked for the three greeting results without a canvas edit.
   The native queued event reached the idle task at 18:16:38.284, 6.400 seconds
   later. The coordinating task did not forward it or wake the task manually.
   One reply appeared at 18:23:28.883; readback confirmed it and the open thread.
   Completion at 18:24:10.403 left six completed events, zero pending/uncertain,
   no reconciliation gap, and the same connected worker/key and BUILT phase.

The original trust change was the hook matcher changing from `startup|resume`
to `startup|resume|compact`. Native hash probes reproduced the old and new hashes
by changing that field alone. On this host, the raw command template was hashed
before installed-version path expansion; an ordinary version-path update did
not itself change trust. This does not authorize skipping approval for a future
hook-definition change.

The post-recovery reply took roughly seven minutes because the task investigated
a digest difference before replying. The root background had become explicitly
white before that turn. Removing only that field in a temporary diagnostic
snapshot reproduced the previous digest exactly. No remote field was removed,
and no canvas-write tool ran during the comment turn. The plan, checklists and
both as-built records were unchanged. The event recorded the actual new current
digest while preserving the original accepted digest and earlier receipts:

| Digest | Value |
| --- | --- |
| Accepted plan | `d79cc777e17fe5081397551040563cd02154cb9e42cccf523107b24d634a5cc7` |
| Built / restart baseline | `46b49d619ab443d2e242fde241401bc061618bbbe8c279d70f5e996cc071a3bd` |
| Post-recovery current canvas | `da405013dcda7275f32de8a5f86f63b7596ccd1a7a86cae5766f05d164f3da28` |

The preserved live receiver and all receipts remained available at the end of
the trial. No cleanup or public publication is implied. These 0.3.1 results
extend the existing 0.3.0 review; they are not a fresh 0.3.1 run of every lifecycle
transition. Reopening the assigned task after restarting Codex remains required.

## Remaining gates and owners

| Gate | Status | Responsible boundary |
| --- | --- | --- |
| Clean-profile native installation/sign-in and complete first-use setup | NOT RUN | Plugin release owner and native host |
| OAuth expiry, refresh rotation, lost responses, revocation, permission and network failures | NOT RUN in this pilot | Auth/server and native host |
| Public registration, publication and intended-customer eligibility | NOT VERIFIED here | Publisher/workspace administrator |
| Workspace-import artifact and identifier compatibility | NOT RUN | Packaging/distribution owner |
| Exact current comment identity, authority and resolved/deleted-thread reads | BLOCKED for full acceptance by the observed MCP contract | Unpaged API |
| Update with pending feedback, unfinished legacy events, two-canvas concurrency and changed-baseline lifecycle cases | NOT RUN live | Adapter/host integration |
| Interrupted queue/write acknowledgement and a general exactly-once guarantee | Fault trials NOT RUN; atomic server edit/reply/receipt contract absent | Adapter and Unpaged API |
| Permanent stop, exact-key revocation and cleanup of this trial | NOT RUN; continued listening preserved | Assigned task after explicit stop |

Use the [readiness matrices](codex-connection-readiness.md) to plan those trials.
A passing local update/restart is evidence for that path, not permission to
claim all customer environments or failure modes are ready.
