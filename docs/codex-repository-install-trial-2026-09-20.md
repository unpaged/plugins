# Codex repository installation smoke — September 20, 2026

This redacted record covers native CLI installation and server discovery for the
repository package. It does not establish clean desktop onboarding, service
sign-in or the visual-plan lifecycle. See the [readiness runbook](codex-connection-readiness.md)
for those gates and the [current customer preview instructions](../README.md#install-for-codex--preview).

## Candidate and isolation

| Item | Recorded value |
| --- | --- |
| Source | `unpaged/plugins`, candidate branch `codex/repository-marketplace` |
| Fetched commit | `2952c7c1993b7cc3ad7bf939a5b35fdb1548ad90` |
| Package | `unpaged-codex@unpaged`, version `0.3.1` |
| Host | macOS; desktop-bundled CLI `0.155.0-alpha.9.2` |
| Test runtime | Node `24.15.0` |
| Connection | Bundled direct HTTP MCP configuration; no registered `.app.json` mapping |

The local and Git trials each used newly created temporary home and Codex state
directories, an empty working directory, an allowlisted child-process environment
and file-only CLI/MCP credential stores. No credentials, hook approval, plugin
cache or review state were copied from the existing profile. The Git trial also
disabled inherited system/global Git configuration and terminal credential prompts.
This isolates CLI state on the same OS account; it is not a separate OS user,
machine or desktop profile.

## Observations

1. **Local catalog installation passed.** Native marketplace add, exact plugin
   add and marketplace-filtered plugin list all exited successfully. Codex
   reported the intended plugin installed and enabled.
2. **Git installation passed.** In a second fresh profile, the native commands
   below completed successfully. The fetched snapshot's Git HEAD matched the
   recorded commit. The installed version was `0.3.1` and it was enabled.
3. **Installed files matched.** All 25 installed files matched the candidate
   source byte for byte, including all three skills, hooks, runtime and direct
   `.mcp.json`. No `.app.json` registered mapping was present.
4. **Bundled-server discovery passed.** Native `mcp list --json` discovered
   `unpaged`, enabled, using `streamable_http`, with `auth_status: not_logged_in`.
   No separate manual MCP entry was added.
5. **Authentication was not completed.** The installer reported `ON_INSTALL`
   policy but returned without signing in. No saved authentication or Unpaged
   review state was created. No login, model-task, hook-trust or restart operation
   was performed.

The candidate Git commands were:

```sh
codex plugin marketplace add unpaged/plugins --ref codex/repository-marketplace --json
codex plugin add unpaged-codex@unpaged --json
codex plugin list --marketplace unpaged --json
codex mcp list --json
```

The branch selector above identifies this trial. Customer instructions target
`main` after the catalog merges; a successful branch trial does not make the
catalog available on `main` before then.

## Automated validation and remaining gates

For the recorded 0.3.1 candidate, all 144 Node 24 tests passed, including six catalog tests. Standalone catalog
validation, the Plugin Creator package validator and whitespace checks passed.
These checks validate packaging and existing runtime behavior, not a native
authenticated review session.

For the recorded 0.3.1 smoke, the repository route was **PARTIAL**: CLI installation
and bundled-server discovery passed. Fresh desktop installation/sign-in, native hook approval, comment
delivery, acceptance and separately authorized implementation, as-built records,
restart/reopen recovery, credential-expiry recovery and exact listener cleanup
were **NOT RUN** in that smoke. The [registered-connection pilot](codex-installed-trial-2026-09-19.md)
does not fill those gaps. Its existing installation and live review were not used
or modified by these smoke tests.

## Version 0.3.2 follow-up

The repository package version advanced to `0.3.2` because its installed README
now contains the repository installation guidance. Runtime, hooks and skills
remain unchanged. Catalog validation now explicitly requires Unpaged's recovery
hook/helper and its named direct server at the documented production endpoint.

The updated candidate passed all 146 Node 24 tests, including eight catalog
tests, and both catalog and Plugin Creator validation. A new isolated CLI profile
installed `0.3.2` from the local candidate catalog and reported it enabled; all 25
installed files matched the source. This is a fresh installation, not an upgrade
or approval-preservation trial. The original Git trial above remains attributed
to its actual 0.3.1 commit; no authentication or desktop lifecycle result is added
by this follow-up.

## Ubuntu installation follow-up — September 21, 2026

The user supplied successful marketplace-add and installation output for version
`0.4.0` on a fresh Ubuntu installation, then identified the missing next step:
`codex mcp login unpaged`. Plugin installation had not completed Unpaged sign-in.
The customer sequence is marketplace add, plugin add, explicit service login,
then native approval of the SessionStart hook before listening.

The user then explicitly confirmed completing Unpaged sign-in and native hook
trust. A supplied screenshot showed the `visual-plan` and `review-plan` skills
loading. These are user-reported setup results and visually observed skill
loading, separate from the isolated macOS smoke above; they are not
machine-verified comment-delivery evidence.

The user subsequently reported creating an **Ubuntu plugin trial** canvas in
**Visual plans**, with successful content readback and digest verification. An
independent MCP read from the maintainer's task confirmed the canvas's
**PROPOSED** state, fictional assumptions and Decision log. Digest verification
remains user-reported. Visual inspection in the VM remained blocked by the
browser's sign-in requirement.

**The 0.4.0 CLI listener setup was blocked.** No listener was started and no
listener key was minted. The installed helper's `doctor` check in the affected task returned
`query_failed` / `early_exit`. Approved read-only guest diagnostics independently
verified Node `24.21.0`, shell Codex `0.155.1`, and desktop-bundled Codex
`0.155.0-alpha.9.2`. They also verified the raw Codex SQLite initialization error
and `bwrap` directory-creation failures beneath SQLite file paths, with exit
code `101`; the user corroborated those errors. Both the file-level grants and
the later containing-directory grant returned `scope: session`. Task commands
remained blocked before startup; the underlying runtime diagnosis is separate.

An explicitly approved, one-off read-only `doctor` run outside the affected
task's sandbox, in the same working directory with installed plugin `0.4.0` and
the desktop-bundled CLI, returned `setupReady: true`, `current_hook_trusted` and
an enabled hook. This independently verifies the persisted native hook
inventory. It does not repair the failing task commands or prove listener
startup, comment delivery or recovery. No SQLite or trust records were edited,
and no listener key or worker was created by these diagnostics.

At this stage the repository route was **PARTIAL**, with CLI listener setup
**BLOCKED**.
Comment delivery, the full plan lifecycle and restart recovery were unproven
at that checkpoint. These observations concern 0.4.0 and are historical
evidence for its CLI launch path, not a result for the new local-tool candidate.

## Local review-tool candidate — September 22, 2026

The unreleased 0.5.0 candidate adds a bundled local stdio MCP review tool for
host-side setup and detached-worker launch. Its fixed operations use native
per-call task/workspace metadata. Source inspection of native Codex
`0.155.0-alpha.9.2` establishes the launch and metadata mechanism; it does not
establish installed Linux behavior. The SessionStart recovery hook is unchanged.

The installed candidate for the following observation was commit
`fddbe96200ea4098e60299b95f5c00742bada64e` (version 0.5.0), on desktop build
`26.915.31945`. These results do not establish behavior for later PR revisions.

The same Ubuntu task initially could not discover the local tool after the
update. The user then turned **Unpaged for Codex** off and on through the
**Plugins → Plugins tab** enable switch. In that same task, the user reported:

- Discovery of `mcp__unpaged_review__review`.
- A successful `info` operation reporting Node `24.21.0` and the existing
  profile's Unpaged data directory. Private paths are omitted here.
- `doctor` returning `setupReady: true`, `ready` / `current_hook_trusted`,
  an enabled and trusted hook, and `launchMethod: "native_mcp"`.

These are **user-reported live setup results**. The native refresh mechanism was
independently checked in the same desktop build's bundled code and native Codex
source: toggling plugin enablement clears plugin/skill caches and refreshes
loaded tasks without uninstalling or changing saved hook trust, sign-in or
review storage. At this setup checkpoint, no listener had been started and no
listener key had been minted.

### Listener startup and human comment delivery

The same task subsequently armed its listener through the local tool. The user
reported `workerAlive: true`, `connectionState: connected`, and
`lastSuccessfulPollAt` advancing from **05:49:04.576Z** to **05:49:34.976Z** on
September 22: two successful polls **30.4 seconds** apart. The canvas remained
**PROPOSED**, with no implementation. A later read-only VM inspection
independently confirmed worker `551380` and a connected `poll-v1` binding.

A human then posted a comment asking the agent to add a monthly-review note
while keeping the canvas PROPOSED. Read-only inspection of the VM's stored event
and task records established the following chronology on September 22, in UTC:

| Event | Time |
| --- | --- |
| Human comment created | `09:03:59.075Z` |
| Listener received the event | `09:04:25.464Z` |
| Owning task woke | `09:04:27.413Z` |
| Event processing began | `09:04:41.861Z` |

The listener received the comment after **26.4 seconds**, and the same task woke
after **28.3 seconds**, without a follow-up user message in that task. This
establishes polling delivery and automatic wakeup for the installed `fddbe96`
candidate. A canvas mutation was issued at `09:05:27Z` and was still awaiting a
result when checked at `12:23Z`; the cause of that wait was not established.
Subsequent remote readback verified exactly one note containing the requested
text, the unchanged PROPOSED status element, and one agent reply created at
`12:33:03.583Z`. The user confirmed that the owning task reported successful
event completion before shutting down the VM. Completion bookkeeping is thus
user-confirmed; the final local receipt was not independently inspected while
the VM was stopped.

The write call had no observed result for at least **3 h 17 min**, and the reply
was created about **3 h 29 min** after the human comment. The note's commit time
is not established, so this does not measure the duration of the server write.
These are call/response observations, not polling delivery latency. The
26.4-second delivery and 28.3-second wakeup
observations do not establish timely completion of feedback handling, and no
cause is assigned to the missing call result without evidence.

The repository route remains **PARTIAL**. Local-tool setup, worker survival,
successful polling, human-comment wakeup and feedback handling now have the
evidence and latency limitation above. Timely feedback completion, plan
lifecycle, an update to the final candidate, visibility of
its native instructions and native restart recovery remain unverified. These
observations do not cover later PR revisions, and the historical 0.4.0 failures above are not reinterpreted
as new-route results.
