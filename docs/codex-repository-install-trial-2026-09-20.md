# Codex repository installation smoke — September 20, 2026

This redacted record covers native CLI installation and server discovery for the
repository package. It does not establish clean desktop onboarding, service
sign-in or the visual-plan lifecycle. See the [readiness runbook](codex-connection-readiness.md)
for those gates and the [customer preview instructions](../plugins/unpaged-codex/README.md#install-from-the-repository-preview).

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

All 144 Node 24 tests passed, including six catalog tests. Standalone catalog
validation, the Plugin Creator package validator and whitespace checks passed.
These checks validate packaging and existing runtime behavior, not a native
authenticated review session.

The repository route is **PARTIAL**: CLI installation and bundled-server discovery
passed. Fresh desktop installation/sign-in, native hook approval, comment
delivery, acceptance and separately authorized implementation, as-built records,
restart/reopen recovery, credential-expiry recovery and exact listener cleanup
remain **NOT RUN** for this route. The [registered-connection pilot](codex-installed-trial-2026-09-19.md)
does not fill those gaps. Its existing installation and live review were not used
or modified by these smoke tests.
