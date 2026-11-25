import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POINTER_RELATIVE,
  RUN_TIMEOUT_MS,
  STALE_AFTER_MS,
  actionPrompt,
  availableActions,
  dayLabel,
  describeStatus,
  filterSkipPatterns,
  formatAttentionMarkdown,
  isRunActive,
  lightColor,
  needsAttention,
  normalizeRunRecord,
  normalizeVerdict,
  parseArchitecturePointer,
  sanitizeMarkdownLabel,
  shownState,
  validCommit,
  validDay,
} from "./architecture-core.mjs";
import {
  clearRunState,
  findRepositoryRoot,
  readRepositoryStatus,
  recordRunStart,
  runKeyForRepo,
  saveVerdictForRepo,
} from "./architecture.mjs";
import { buildSessionStartOutput } from "./session-start.mjs";

const DOC_1 = "21655eba-fa32-4a7d-8249-4ee28c8f1157";
const DOC_2 = "2a12a251-35ae-47d1-9426-4ab7e4b0dc9b";
const CLI_PATH = fileURLToPath(new URL("./architecture.mjs", import.meta.url));
const HOOK_PATH = fileURLToPath(new URL("./session-start.mjs", import.meta.url));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "unpaged-agy-arch-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("validDay, validCommit, and filterSkipPatterns enforce strict input shapes", () => {
  assert.equal(validDay("2026-11-25"), "2026-11-25");
  assert.equal(validDay(" 2026-02-28 "), "2026-02-28");
  assert.equal(validDay("2026-02-31"), null);
  assert.equal(validDay("not-a-date"), null);

  assert.equal(validCommit("a1b2c3d"), "a1b2c3d");
  assert.equal(validCommit("0123456789abcdef0123456789abcdef01234567"), "0123456789abcdef0123456789abcdef01234567");
  assert.equal(validCommit("a1b2c3"), null);
  assert.equal(validCommit("A1B2C3D"), null);
  assert.equal(validCommit("a1b2c3d;rm"), null);

  const filtered = filterSkipPatterns([
    "**/*.spec.*",
    "docs/**",
    "bad;rm -rf /",
    "has space/*.ts",
    "",
  ]);
  assert.deepEqual(filtered.accepted, ["**/*.spec.*", "docs/**"]);
  assert.deepEqual(filtered.rejected, ["bad;rm -rf /", "has space/*.ts", ""]);
});

test("parseArchitecturePointer validates documentId and ignores invalid pointers", () => {
  const ok = parseArchitecturePointer(
    JSON.stringify({
      documentId: DOC_1,
      title: "  unpaged  ",
      skip: ["**/*.test.*", "bad$(whoami)"],
    })
  );
  assert.deepEqual(ok, {
    documentId: DOC_1,
    title: "unpaged",
    skip: ["**/*.test.*"],
    rejectedSkip: ["bad$(whoami)"],
  });

  assert.equal(parseArchitecturePointer("not json"), null);
  assert.equal(parseArchitecturePointer(JSON.stringify({ documentId: "../etc/passwd" })), null);
  assert.equal(parseArchitecturePointer(JSON.stringify([])), null);
});

test("shownState, lightColor, staleness (90 days), and active runs follow the specification", () => {
  const pointer = { documentId: DOC_1, title: "unpaged", skip: [], rejectedSkip: [] };
  const nov25 = Date.parse("2026-11-25T12:00:00Z");

  assert.equal(shownState(null, null, null, nov25), "none");
  assert.equal(lightColor("none"), "gray");
  assert.deepEqual(availableActions("none"), ["create"]);

  assert.equal(shownState(pointer, null, null, nov25), "unknown");
  assert.equal(lightColor("unknown"), "gray");
  assert.equal(needsAttention("unknown"), false);
  assert.deepEqual(availableActions("unknown"), ["compare", "update"]);

  const currentVerdict = normalizeVerdict({
    documentId: DOC_1,
    state: "current",
    checkedAt: "2026-11-24",
    commit: "a1b2c3d",
    reportedAt: "2026-11-24T12:00:00Z",
  });
  assert.equal(shownState(pointer, currentVerdict, null, nov25), "current");
  assert.equal(lightColor("current"), "green");
  assert.equal(needsAttention("current"), false);
  assert.equal(dayLabel("2026-11-24", nov25), "24 Nov");
  assert.equal(dayLabel("2025-11-24", nov25), "24 Nov 2025");

  const staleBoundaryMs = Date.parse("2026-11-24T00:00:00Z") + STALE_AFTER_MS + 1;
  assert.equal(shownState(pointer, currentVerdict, null, staleBoundaryMs), "stale");
  assert.equal(lightColor("stale"), "red");
  assert.equal(needsAttention("stale"), true);
  assert.deepEqual(availableActions("stale"), ["update", "compare"]);

  const behindVerdict = normalizeVerdict({
    documentId: DOC_1,
    state: "behind",
    checkedAt: "2026-11-24",
    behindSince: "2026-11-18",
    reportedAt: "2026-11-24T12:00:00Z",
  });
  assert.equal(shownState(pointer, behindVerdict, null, nov25), "behind");
  assert.equal(lightColor("behind"), "yellow");
  assert.equal(needsAttention("behind"), true);
  assert.deepEqual(availableActions("behind"), ["update", "compare"]);

  const lostVerdict = normalizeVerdict({
    documentId: DOC_1,
    state: "lost",
    reportedAt: "2026-11-24T12:00:00Z",
  });
  assert.equal(shownState(pointer, lostVerdict, null, nov25), "lost");
  assert.equal(lightColor("lost"), "red");
  assert.equal(needsAttention("lost"), true);
  assert.deepEqual(availableActions("lost"), ["create"]);

  const activeRun = normalizeRunRecord({
    action: "compare",
    repoRoot: "/tmp/repo",
    startedAt: "2026-11-24T12:05:00Z",
  });
  assert.equal(isRunActive(activeRun, currentVerdict, Date.parse("2026-11-24T12:06:00Z")), true);
  assert.equal(shownState(pointer, currentVerdict, activeRun, Date.parse("2026-11-24T12:06:00Z")), "comparing");
  assert.equal(lightColor("comparing"), "yellow");
  assert.equal(needsAttention("comparing"), false);
  assert.deepEqual(availableActions("comparing"), []);

  // Settled once a later verdict is reported or once RUN_TIMEOUT_MS elapses.
  const settledVerdict = normalizeVerdict({
    documentId: DOC_1,
    state: "current",
    checkedAt: "2026-11-24",
    reportedAt: "2026-11-24T12:07:00Z",
  });
  assert.equal(isRunActive(activeRun, settledVerdict, Date.parse("2026-11-24T12:08:00Z")), false);
  assert.equal(isRunActive(activeRun, currentVerdict, Date.parse("2026-11-24T12:05:00Z") + RUN_TIMEOUT_MS), false);

  // Frozen-clock edge case: start-run at exact same ms as prior verdict remains active.
  const sameMsRun = normalizeRunRecord({
    action: "update",
    repoRoot: "/tmp/repo",
    startedAt: "2026-11-24T12:00:00.000Z",
  });
  assert.equal(isRunActive(sameMsRun, currentVerdict, Date.parse("2026-11-24T12:00:00.000Z")), true);
  assert.match(actionPrompt("create", { repoName: "demo", documentId: DOC_1 }), /already names canvas/);
  assert.equal(describeStatus({ shown: "behind", verdict: behindVerdict }, nov25).headline, "Behind since 18 Nov");
});

test("formatAttentionMarkdown stays silent for healthy states and escapes untrusted titles", () => {
  const nov25 = Date.parse("2026-11-25T12:00:00Z");
  assert.equal(
    formatAttentionMarkdown([
      { shown: "current", documentId: DOC_1, title: "ok" },
      { shown: "unknown", documentId: DOC_1, title: "unchecked" },
      { shown: "comparing", documentId: DOC_1, title: "busy" },
      { shown: "none", documentId: null, title: null },
    ], nov25),
    ""
  );

  assert.equal(sanitizeMarkdownLabel("repo\n[click](https://evil.example)"), "repo \\[click\\]\\(https://evil.example\\)");
  const banner = formatAttentionMarkdown(
    [
      {
        shown: "behind",
        documentId: DOC_1,
        title: "repo [evil](https://evil.example)",
        verdict: { behindSince: "2026-11-18", checkedAt: "2026-11-24" },
      },
    ],
    nov25
  );
  assert.ok(banner.includes(`(https://unpaged.io/document/${DOC_1}/edit)`));
  assert.ok(!banner.includes("(https://evil.example)"));
  assert.ok(banner.includes("[Unpaged Architecture](sidecar://unpaged/architecture/)"));
});

test("architecture.mjs handles worktree .git files, atomic mode-0600 verdicts, run lifecycle, and mismatches", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repo = join(dir, "worktree-repo");
    const subDir = join(repo, "apps", "web");
    await mkdir(join(repo, ".unpaged"), { recursive: true });
    await mkdir(subDir, { recursive: true });
    // Worktrees store `.git` as a file rather than a directory.
    await writeFile(join(repo, ".git"), "gitdir: ../.git/worktrees/wt\n", "utf8");

    assert.equal(await findRepositoryRoot(subDir), repo);
    assert.equal(await findRepositoryRoot(dir), null);

    // Before pointer exists -> none.
    const emptyStatus = await readRepositoryStatus(subDir, { homeDir });
    assert.equal(emptyStatus.shown, "none");
    assert.equal(emptyStatus.repoRoot, repo);

    // Report fails without pointer file.
    const noPointer = await saveVerdictForRepo(subDir, { documentId: DOC_1, state: "current" }, { homeDir });
    assert.equal(noPointer.ok, false);

    // Write pointer file.
    await writeFile(
      join(repo, POINTER_RELATIVE),
      JSON.stringify({ documentId: DOC_1, title: "unpaged-wt" }),
      "utf8"
    );

    const unknownStatus = await readRepositoryStatus(subDir, { homeDir });
    assert.equal(unknownStatus.shown, "unknown");
    assert.equal(unknownStatus.title, "unpaged-wt");

    // Reject mismatched documentId.
    const mismatch = await saveVerdictForRepo(subDir, { documentId: DOC_2, state: "current" }, { homeDir });
    assert.equal(mismatch.ok, false);

    // Start run, verify comparing, then save verdict and verify run clears automatically.
    const now = () => Date.parse("2026-11-25T10:00:00Z");
    const started = await recordRunStart(subDir, "compare", { homeDir, now });
    assert.equal(started.ok, true);
    assert.equal(started.status.shown, "comparing");
    assert.equal(started.status.color, "yellow");

    const saved = await saveVerdictForRepo(
      subDir,
      { documentId: DOC_1, state: "behind", checkedAt: "2026-11-25", behindSince: "2026-11-20", commit: "abcdef1" },
      { homeDir, now: () => Date.parse("2026-11-25T10:01:00Z") }
    );
    assert.equal(saved.ok, true);

    const verdictPath = join(homeDir, ".gemini", "unpaged", "architecture", `${DOC_1}.json`);
    const runPath = join(homeDir, ".gemini", "unpaged", "architecture", "runs", `${runKeyForRepo(repo)}.json`);
    if (process.platform !== "win32") {
      const st = await stat(verdictPath);
      assert.equal(st.mode & 0o777, 0o600);
    }
    await assert.rejects(() => readFile(runPath, "utf8"));

    const finalStatus = await readRepositoryStatus(subDir, { homeDir, now: () => Date.parse("2026-11-25T10:02:00Z") });
    assert.equal(finalStatus.shown, "behind");
    assert.equal(finalStatus.color, "yellow");
    assert.equal(finalStatus.needsAttention, true);

    // Manual start-run + clear-run.
    await recordRunStart(subDir, "update", { homeDir, now: () => Date.parse("2026-11-25T10:03:00Z") });
    const cleared = await clearRunState(subDir, { homeDir });
    assert.equal(cleared.ok, true);
    const afterClear = await readRepositoryStatus(subDir, { homeDir, now: () => Date.parse("2026-11-25T10:04:00Z") });
    assert.equal(afterClear.shown, "behind");
  });
});

test("architecture.mjs CLI verbs read stdin verdicts safely and reject bad calls", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".unpaged"), { recursive: true });
    await writeFile(join(repo, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "cli-repo" }), "utf8");

    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    const started = spawnSync(process.execPath, [CLI_PATH, "start-run", "compare", repo], { env, encoding: "utf8" });
    assert.equal(started.status, 0);
    assert.equal(started.stdout.trim(), "started compare");

    const badReport = spawnSync(process.execPath, [CLI_PATH, "report", repo], {
      env,
      input: JSON.stringify({ documentId: DOC_2, state: "current" }),
      encoding: "utf8",
    });
    assert.equal(badReport.status, 1);

    const goodReport = spawnSync(process.execPath, [CLI_PATH, "report", repo], {
      env,
      input: JSON.stringify({ documentId: DOC_1, state: "current", checkedAt: "2026-11-25", commit: "1234567" }),
      encoding: "utf8",
    });
    assert.equal(goodReport.status, 0);
    assert.equal(goodReport.stdout.trim(), `reported current ${DOC_1}`);

    const statusRes = spawnSync(process.execPath, [CLI_PATH, "status", repo], { env, encoding: "utf8" });
    assert.equal(statusRes.status, 0);
    const parsed = JSON.parse(statusRes.stdout);
    assert.equal(parsed.shown, "current");
    assert.equal(parsed.color, "green");
  });
});

test("session-start.mjs stays silent when current/unknown/none and emits zero-token notice only when attention is needed", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repoCurrent = join(dir, "repo-current");
    const repoBehind = join(dir, "repo-behind");
    for (const r of [repoCurrent, repoBehind]) {
      await mkdir(join(r, ".git"), { recursive: true });
      await mkdir(join(r, ".unpaged"), { recursive: true });
    }
    await writeFile(join(repoCurrent, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "ok-repo" }), "utf8");
    await writeFile(join(repoBehind, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_2, title: "behind-repo" }), "utf8");

    const now = () => Date.parse("2026-11-25T12:00:00Z");
    await saveVerdictForRepo(
      repoCurrent,
      { documentId: DOC_1, state: "current", checkedAt: "2026-11-24", commit: "abcdef1" },
      { homeDir, now }
    );

    const silentOut = await buildSessionStartOutput(
      { workspacePaths: [repoCurrent], cwd: repoCurrent },
      { homeDir, now }
    );
    assert.deepEqual(silentOut, {});

    await saveVerdictForRepo(
      repoBehind,
      { documentId: DOC_2, state: "behind", checkedAt: "2026-11-25", behindSince: "2026-11-18" },
      { homeDir, now }
    );

    const noticeOut = await buildSessionStartOutput(
      { workspacePaths: [repoCurrent, repoBehind, `file://${repoBehind}`], cwd: repoBehind },
      { homeDir, now }
    );
    assert.equal(noticeOut.injectSteps.length, 1);
    assert.equal(noticeOut.injectSteps[0].systemMessage.systemMessage, "");
    const md = noticeOut.injectSteps[0].systemMessage.metadata.user_markdown;
    assert.ok(md.includes("behind-repo"));
    assert.ok(md.includes("Behind since 18 Nov"));
    assert.ok(!md.includes("ok-repo"));
    assert.ok(md.includes("[Unpaged Architecture](sidecar://unpaged/architecture/)"));

    // Real hook invocation fails open cleanly on malformed stdin.
    const badHook = spawnSync(process.execPath, [HOOK_PATH], {
      env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
      input: "{broken json",
      encoding: "utf8",
    });
    assert.equal(badHook.status, 0);
    assert.equal(badHook.stdout.trim(), "{}");
  });
});
