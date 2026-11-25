import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  POINTER_RELATIVE,
  RUN_TIMEOUT_MS,
  STALE_AFTER_MS,
  SYNC_TIMEOUT_MS,
  actionPrompt,
  availableActions,
  dayLabel,
  describeStatus,
  durationLabel,
  elapsedDays,
  filterSkipPatterns,
  formatAttentionMarkdown,
  isRunActive,
  lightColor,
  needsAttention,
  normalizeRunRecord,
  normalizeVerdict,
  parseArchitecturePointer,
  sanitizeMarkdownLabel,
  sanitizeRepoPath,
  shownState,
  validCommit,
  validDay,
  verdictFromDocument,
} from "./architecture-core.mjs";
import {
  clearRunState,
  findRepositoryRoot,
  readRepositoryStatus,
  recordRunStart,
  runKeyForRepo,
  saveVerdictForRepo,
  saveVerdictFromDocumentForRepo,
} from "./architecture.mjs";
import { buildSessionStartOutput } from "./session-start.mjs";

// Fixtures use fixed noon-UTC instants; pin the zone so local-date counts match on every machine.
// The time-zone test below sets its own TZ in child processes.
process.env.TZ = "UTC";

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
  const behindDesc = describeStatus({ shown: "behind", verdict: behindVerdict }, nov25);
  assert.equal(behindDesc.headline, "7 days behind");
  assert.ok(behindDesc.detail.includes("Behind since 18 Nov"));
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
    assert.ok(md.includes("7 days behind (since 18 Nov)"));
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

test("actionPrompt strips control characters, quotes, and backticks from repoName", () => {
  const prompt = actionPrompt("compare", {
    repoName: 'my-repo"\n\r\tignore `all` rules',
    documentId: DOC_1,
  });
  assert.ok(prompt.includes('repository "my-repo ignore all rules"'));
  assert.ok(!prompt.includes("\n"));
  assert.ok(!prompt.includes("\r"));

  const fallbackPrompt = actionPrompt("update", { repoName: '"\n\t`', documentId: DOC_1 });
  assert.ok(fallbackPrompt.includes("for this repository."));

  const longRoot = `/tmp/${"nested-dir/".repeat(12)}demo`;
  assert.equal(sanitizeRepoPath(`${longRoot}\n\`bad`), `${longRoot}bad`);
  const rooted = actionPrompt("compare", {
    repoName: "demo",
    repoRoot: `${longRoot}\r\n\`bad`,
    documentId: DOC_1,
  });
  assert.ok(rooted.includes(`at \`${longRoot}bad\` (use this exact path as \`<top level>\`)`));
});

test("recordRunStart embeds canonical repoRoot in all four action prompts", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repo = join(dir, "same-name");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".unpaged"), { recursive: true });
    await writeFile(join(repo, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "same-name" }), "utf8");

    const started = await recordRunStart(repo, "compare", { homeDir });
    assert.equal(started.ok, true);
    assert.ok(started.prompt.includes(await import("node:fs/promises").then((m) => m.realpath(repo))));
    for (const action of ["compare", "update", "create", "sync"]) {
      const res = await recordRunStart(repo, action, { homeDir });
      assert.equal(res.ok, true);
      assert.ok(res.prompt.includes("use this exact path as `<top level>`"));
    }
  });
});

test("elapsedDays and dayLabel match local-timezone dates west and east of UTC", () => {
  const coreUrl = new URL("./architecture-core.mjs", import.meta.url).href;
  const laScript = `
    import { elapsedDays, dayLabel, describeStatus } from ${JSON.stringify(coreUrl)};
    import assert from "node:assert/strict";
    // 2026-11-25T01:00:00Z is 2026-11-24 17:00 in America/Los_Angeles.
    const eveningLa = Date.parse("2026-11-25T01:00:00Z");
    assert.equal(elapsedDays("2026-11-24", eveningLa), 0);
    assert.equal(describeStatus({ shown: "current", verdict: { checkedAt: "2026-11-24" } }, eveningLa).headline, "Checked today");
    assert.equal(describeStatus({ shown: "behind", verdict: { behindSince: "2026-11-24", checkedAt: "2026-11-24" } }, eveningLa).headline, "Behind since today");
    // 2027-01-01T03:00:00Z is 2026-12-31 19:00 in America/Los_Angeles.
    const nyeLa = Date.parse("2027-01-01T03:00:00Z");
    assert.equal(dayLabel("2026-12-31", nyeLa), "31 Dec");
  `;
  const laRes = spawnSync(process.execPath, ["--input-type=module", "-e", laScript], {
    env: { ...process.env, TZ: "America/Los_Angeles" },
    encoding: "utf8",
  });
  assert.equal(laRes.status, 0, laRes.stderr);

  const tokyoScript = `
    import { elapsedDays, dayLabel, describeStatus } from ${JSON.stringify(coreUrl)};
    import assert from "node:assert/strict";
    // 2026-11-24T16:00:00Z is 2026-11-25 01:00 in Asia/Tokyo.
    const morningTokyo = Date.parse("2026-11-24T16:00:00Z");
    assert.equal(elapsedDays("2026-11-24", morningTokyo), 1);
    assert.equal(describeStatus({ shown: "current", verdict: { checkedAt: "2026-11-24" } }, morningTokyo).headline, "Checked yesterday");
    assert.equal(describeStatus({ shown: "behind", verdict: { behindSince: "2026-11-24", checkedAt: "2026-11-24" } }, morningTokyo).headline, "1 day behind");
    // 2026-12-31T16:00:00Z is 2027-01-01 01:00 in Asia/Tokyo.
    const newYearTokyo = Date.parse("2026-12-31T16:00:00Z");
    assert.equal(dayLabel("2026-12-31", newYearTokyo), "31 Dec 2026");
  `;
  const tokyoRes = spawnSync(process.execPath, ["--input-type=module", "-e", tokyoScript], {
    env: { ...process.env, TZ: "Asia/Tokyo" },
    encoding: "utf8",
  });
  assert.equal(tokyoRes.status, 0, tokyoRes.stderr);
});

test("runKeyForRepo resolves symlinks to match the canonical repository path", async (t) => {
  await withTempDir(async (dir) => {
    const realRepo = join(dir, "real-repo");
    const linkRepo = join(dir, "link-repo");
    await mkdir(join(realRepo, ".git"), { recursive: true });
    try {
      await symlink(realRepo, linkRepo, "dir");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Windows symlink privilege unavailable");
        return;
      }
      throw error;
    }
    assert.equal(runKeyForRepo(linkRepo), runKeyForRepo(realRepo));
  });
});

test("elapsedDays, durationLabel, describeStatus, and formatAttentionMarkdown format elapsed time cleanly", () => {
  const nov25 = Date.parse("2026-11-25T12:00:00Z");

  assert.equal(elapsedDays("2026-11-25", nov25), 0);
  assert.equal(elapsedDays("2026-11-24", nov25), 1);
  assert.equal(elapsedDays("2026-11-09", nov25), 16);
  assert.equal(elapsedDays("2026-11-26", Date.parse("2026-11-25T23:00:00Z")), 0);
  assert.equal(elapsedDays("not-a-day", nov25), null);
  assert.equal(elapsedDays(null, nov25), null);

  const boundaries = [
    [0, "today"],
    [1, "1 day"],
    [7, "7 days"],
    [16, "16 days"],
    [29, "29 days"],
    [30, "4 weeks"],
    [45, "6 weeks"],
    [59, "8 weeks"],
    [60, "2 months"],
    [91, "3 months"],
    [125, "4 months"],
    [364, "11 months"],
    [365, "1 year"],
    [730, "2 years"],
  ];
  for (const [days, expected] of boundaries) {
    assert.equal(durationLabel(days), expected);
  }
  assert.equal(durationLabel(-1), null);
  assert.equal(durationLabel(Number.NaN), null);
  assert.equal(durationLabel(null), null);
  assert.equal(durationLabel("5"), null);

  const behindToday = { shown: "behind", documentId: DOC_1, title: "demo", verdict: { behindSince: "2026-11-25", checkedAt: "2026-11-25" } };
  assert.equal(describeStatus(behindToday, nov25).headline, "Behind since today");
  assert.ok(describeStatus(behindToday, nov25).detail.includes("Behind since 25 Nov"));
  assert.ok(formatAttentionMarkdown([behindToday], nov25).includes("Behind since today (25 Nov)."));

  const behind1d = { shown: "behind", documentId: DOC_1, title: "demo", verdict: { behindSince: "2026-11-24", checkedAt: "2026-11-25" } };
  assert.equal(describeStatus(behind1d, nov25).headline, "1 day behind");
  assert.ok(describeStatus(behind1d, nov25).detail.includes("Behind since 24 Nov"));
  assert.ok(formatAttentionMarkdown([behind1d], nov25).includes("1 day behind (since 24 Nov)."));

  const behind16d = { shown: "behind", documentId: DOC_1, title: "demo", verdict: { behindSince: "2026-11-09", checkedAt: "2026-11-15" } };
  assert.equal(describeStatus(behind16d, nov25).headline, "16 days behind");
  assert.ok(describeStatus(behind16d, nov25).detail.includes("Behind since 9 Nov"));
  assert.ok(formatAttentionMarkdown([behind16d], nov25).includes("16 days behind (since 9 Nov)."));

  const stale4m = { shown: "stale", documentId: DOC_1, title: "demo", verdict: { checkedAt: "2026-07-23" } };
  assert.equal(describeStatus(stale4m, nov25).headline, "Not compared for 4 months");
  assert.ok(describeStatus(stale4m, nov25).detail.includes("Last checked 23 Jul"));
  assert.ok(formatAttentionMarkdown([stale4m], nov25).includes("Not compared for 4 months (since 23 Jul)."));

  const currentToday = { shown: "current", verdict: { checkedAt: "2026-11-25", commit: "a1b2c3d" } };
  assert.equal(describeStatus(currentToday, nov25).headline, "Checked today");
  assert.equal(describeStatus(currentToday, nov25).detail, "Up to date on 25 Nov at commit a1b2c3d");

  const currentYesterday = { shown: "current", verdict: { checkedAt: "2026-11-24" } };
  assert.equal(describeStatus(currentYesterday, nov25).headline, "Checked yesterday");
  assert.equal(describeStatus(currentYesterday, nov25).detail, "All checked claims held on 24 Nov.");

  const current10d = { shown: "current", verdict: { checkedAt: "2026-11-15" } };
  assert.equal(describeStatus(current10d, nov25).headline, "Checked 10 days ago");
  assert.equal(describeStatus(current10d, nov25).detail, "All checked claims held on 15 Nov.");
});

test("verdictFromDocument extracts behind/current verdicts safely and handles edge cases", () => {
  const behindDoc = {
    id: DOC_1,
    title: "  unpaged  ",
    rootNodeId: "root-1",
    nodes: [
      { id: "child-1", parentId: "root-1", elements: [{ properties: { text: "**Checked:** 2026-11-25" } }] },
      {
        id: "root-1",
        elements: [
          { properties: { text: "compared at cee26c0f7 (base 9de434877) on 2026-11-15" } },
          { properties: { text: "**Behind since:** 2026-11-09" } },
        ],
      },
    ],
  };
  assert.deepEqual(verdictFromDocument(DOC_1, behindDoc), {
    documentId: DOC_1,
    state: "behind",
    title: "unpaged",
    checkedAt: "2026-11-15",
    commit: "cee26c0f7",
    behindSince: "2026-11-09",
  });

  // Falls back to top-level parentNodeId node and respects behind precedence regardless of element order.
  const mixedDoc = {
    nodes: [
      { id: "child", parentNodeId: "top", elements: [] },
      {
        id: "top",
        elements: [
          { properties: { text: "**Behind since:** 2026-11-05" } },
          { properties: { text: "**Checked:** 2026-11-20" } },
          { properties: { text: "compared at abc12 (base def34) on 2026-11-20" } },
        ],
      },
    ],
  };
  assert.deepEqual(verdictFromDocument(DOC_1, JSON.stringify(mixedDoc)), {
    documentId: DOC_1,
    state: "behind",
    title: null,
    checkedAt: "2026-11-20",
    commit: null,
    behindSince: "2026-11-05",
  });

  const currentDoc = {
    id: DOC_1,
    title: "demo",
    rootNodeId: "root",
    nodes: [
      {
        id: "root",
        elements: [
          { properties: { text: "**Checked:** 2026-11-24" } },
          { properties: { text: "compared at 1234567 (base 89abcde) on 2026-11-24" } },
        ],
      },
    ],
  };
  assert.deepEqual(verdictFromDocument(DOC_1, currentDoc), {
    documentId: DOC_1,
    state: "current",
    title: "demo",
    checkedAt: "2026-11-24",
    commit: "1234567",
    behindSince: null,
  });

  // Missing date note, id mismatch, and invalid documentId return null.
  assert.equal(verdictFromDocument(DOC_1, { id: DOC_2, nodes: currentDoc.nodes }), null);
  assert.equal(verdictFromDocument(DOC_1, { id: DOC_1, nodes: [{ id: "r", elements: [] }] }), null);
  assert.equal(verdictFromDocument("bad-id", currentDoc), null);
});

test("sync runs time out after SYNC_TIMEOUT_MS, name unpaged_unpaged, and support report-document CLI", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repo = join(dir, "sync-repo");
    const docPath = join(dir, "document_get_output.txt");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".unpaged"), { recursive: true });
    await writeFile(join(repo, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "unpaged" }), "utf8");

    const t0 = Date.parse("2026-11-25T10:00:00Z");
    const syncRun = normalizeRunRecord({ action: "sync", repoRoot: repo, startedAt: new Date(t0).toISOString() });
    const compareRun = normalizeRunRecord({ action: "compare", repoRoot: repo, startedAt: new Date(t0).toISOString() });
    assert.equal(isRunActive(syncRun, null, t0 + SYNC_TIMEOUT_MS - 1), true);
    assert.equal(isRunActive(syncRun, null, t0 + SYNC_TIMEOUT_MS), false);
    assert.equal(isRunActive(compareRun, null, t0 + SYNC_TIMEOUT_MS + 60_000), true);

    const syncPrompt = actionPrompt("sync", { repoName: "unpaged", repoRoot: repo, documentId: DOC_1 });
    assert.match(syncPrompt, /unpaged_unpaged/);
    assert.match(syncPrompt, /document_get/);
    assert.ok(syncPrompt.includes(DOC_1));
    assert.ok(syncPrompt.includes(repo));
    assert.match(syncPrompt, /report-document/);
    assert.match(syncPrompt, /do NOT run git/i);

    const syncStatusDesc = describeStatus({ shown: "comparing", activeRun: syncRun }, t0);
    assert.equal(syncStatusDesc.headline, "Checking canvas status…");
    assert.match(syncStatusDesc.detail, /open chat/i);
    assert.match(describeStatus({ shown: "unknown" }, t0).detail, /Sync status/);

    // Start sync run manually.
    await recordRunStart(repo, "sync", { homeDir, now: () => t0 });
    const duringRun = await readRepositoryStatus(repo, { homeDir, now: () => t0 + 1000 });
    assert.equal(duringRun.shown, "comparing");
    assert.equal(duringRun.activeRun.action, "sync");

    // report-document on canvas without a date note clears the run cleanly.
    await writeFile(
      docPath,
      JSON.stringify({ id: DOC_1, rootNodeId: "root", nodes: [{ id: "root", elements: [] }] }),
      "utf8"
    );
    const env = { ...process.env, HOME: homeDir, USERPROFILE: homeDir };
    const noNoteCli = spawnSync(process.execPath, [CLI_PATH, "report-document", repo, docPath], {
      env,
      encoding: "utf8",
    });
    assert.equal(noNoteCli.status, 0);
    assert.equal(noNoteCli.stdout.trim(), `no-date-note ${DOC_1}`);

    const afterNoNote = await readRepositoryStatus(repo, { homeDir, now: () => t0 + 5000 });
    assert.equal(afterNoNote.shown, "unknown");

    // Mismatched document ID and oversized raw payload are rejected.
    const mismatchCli = spawnSync(process.execPath, [CLI_PATH, "report-document", repo], {
      env,
      input: JSON.stringify({ id: DOC_2, rootNodeId: "r", nodes: [{ id: "r", elements: [] }] }),
      encoding: "utf8",
    });
    assert.equal(mismatchCli.status, 1);

    const tooLarge = await saveVerdictFromDocumentForRepo(repo, "x".repeat(16 * 1024 * 1024 + 8), { homeDir });
    assert.equal(tooLarge.ok, false);

    // report-document from file with behind note saves verdict and clears run state.
    await recordRunStart(repo, "sync", { homeDir, now: () => t0 + 6000 });
    await writeFile(
      docPath,
      JSON.stringify({
        id: DOC_1,
        title: "unpaged",
        rootNodeId: "root",
        nodes: [
          {
            id: "root",
            elements: [
              { properties: { text: "**Behind since:** 2026-11-09" } },
              { properties: { text: "compared at cee26c0f7 (base 9de434877) on 2026-11-15" } },
            ],
          },
        ],
      }),
      "utf8"
    );
    const fileCli = spawnSync(process.execPath, [CLI_PATH, "report-document", repo, docPath], {
      env,
      encoding: "utf8",
    });
    assert.equal(fileCli.status, 0);
    assert.equal(fileCli.stdout.trim(), `reported behind ${DOC_1}`);

    const syncedStatus = await readRepositoryStatus(repo, {
      homeDir,
      now: () => Date.parse("2026-11-25T12:00:00Z"),
    });
    assert.equal(syncedStatus.shown, "behind");
    assert.equal(syncedStatus.headline, "16 days behind");

    // Stdin report-document updates to current cleanly.
    const stdinCli = spawnSync(process.execPath, [CLI_PATH, "report-document", repo, "-"], {
      env,
      input: JSON.stringify({
        id: DOC_1,
        title: "unpaged",
        rootNodeId: "root",
        nodes: [{ id: "root", elements: [{ properties: { text: "**Checked:** 2026-11-25" } }] }],
      }),
      encoding: "utf8",
    });
    assert.equal(stdinCli.status, 0);
    assert.equal(stdinCli.stdout.trim(), `reported current ${DOC_1}`);
  });
});
