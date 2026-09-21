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

**Listener setup is blocked.** No listener was started and no listener key was
minted. The installed helper's `doctor` check in the affected task returned
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

The repository route remains **PARTIAL**, with listener setup **BLOCKED**.
Comment delivery, the full plan lifecycle and restart recovery remain unproven
for the Ubuntu trial. These observations concern 0.4.0; the local 0.4.1
documentation correction is not a new installed-version trial or completed
onboarding result.
