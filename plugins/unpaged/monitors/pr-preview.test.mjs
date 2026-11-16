import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AMBIGUOUS_PR_SECTION_MESSAGE,
  PR_SECTION_END,
  PR_SECTION_START,
  escapeMarkdownText,
  extractCreatedPullRequest,
  normalizePullRequestHeadRef,
  parseGitHeadBranch,
  parseJoinLinkUrls,
  planStoreKey,
  prPlanAttachContext,
  renderPrPlanSection,
  resolveGitDirPointer,
  splicePrPlanSection,
} from "./pr-preview-core.mjs";

const PLANS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "plans.mjs");
const DOC_1 = "11111111-2222-3333-4444-555555555555";
const DOC_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const JOIN_TOKEN = "a".repeat(32);
const JOIN_URL = `https://unpaged.io/join/${JOIN_TOKEN}`;
const PREVIEW_URL = `${JOIN_URL}/preview.png`;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "unpaged-pr-preview-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseGitHeadBranch accepts named refs/heads branches and rejects detached or unsafe refs", () => {
  assert.equal(parseGitHeadBranch("ref: refs/heads/feat/pr-invite-preview\n"), "feat/pr-invite-preview");
  assert.equal(parseGitHeadBranch("ref: refs/heads/main"), "main");
  assert.equal(parseGitHeadBranch("071470bab9f43211122233344455566677788899\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/tags/v1.0.0\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/heads/../escape\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/heads/bad.lock\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/heads/bad.lock/sub\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/heads/.invalid\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/heads/feat/.hidden\n"), null);
  assert.equal(parseGitHeadBranch("ref: refs/heads/has space\n"), null);
  assert.equal(parseGitHeadBranch(""), null);
});

test("resolveGitDirPointer resolves relative and absolute worktree gitdir pointers", () => {
  assert.equal(
    resolveGitDirPointer("gitdir: ../.git/worktrees/feature-a\n", "/Users/dev/worktrees/feature-a"),
    "/Users/dev/worktrees/.git/worktrees/feature-a"
  );
  assert.equal(
    resolveGitDirPointer("gitdir: /var/repos/main/.git/worktrees/wt1\n", "/tmp/wt1"),
    "/var/repos/main/.git/worktrees/wt1"
  );
  assert.equal(resolveGitDirPointer("not-a-gitdir-file\n", "/repo"), null);
});

test("parseJoinLinkUrls enforces HTTPS Unpaged /join/<token> and matching /preview.png", () => {
  assert.deepEqual(parseJoinLinkUrls({ url: JOIN_URL }), {
    url: JOIN_URL,
    previewUrl: PREVIEW_URL,
    token: JOIN_TOKEN,
  });
  assert.deepEqual(
    parseJoinLinkUrls({
      url: `https://staging.unpaged.io/join/${JOIN_TOKEN}/`,
      previewUrl: `https://staging.unpaged.io/join/${JOIN_TOKEN}/preview.png`,
    }),
    {
      url: `https://staging.unpaged.io/join/${JOIN_TOKEN}`,
      previewUrl: `https://staging.unpaged.io/join/${JOIN_TOKEN}/preview.png`,
      token: JOIN_TOKEN,
    }
  );
  assert.equal(parseJoinLinkUrls({ url: `http://unpaged.io/join/${JOIN_TOKEN}` }), null);
  assert.equal(parseJoinLinkUrls({ url: `https://evil.example.com/join/${JOIN_TOKEN}` }), null);
  assert.equal(parseJoinLinkUrls({ url: `https://unpaged.io:8443/join/${JOIN_TOKEN}` }), null);
  assert.equal(parseJoinLinkUrls({ url: `https://user@unpaged.io/join/${JOIN_TOKEN}` }), null);
  assert.equal(parseJoinLinkUrls({ url: `${JOIN_URL}?extra=1` }), null);
  assert.equal(
    parseJoinLinkUrls({
      url: JOIN_URL,
      previewUrl: `https://unpaged.io/join/${"b".repeat(32)}/preview.png`,
    }),
    null
  );
});

test("renderPrPlanSection escapes Markdown characters, appends ?v=, and uses no banned wording", () => {
  const section = renderPrPlanSection({
    title: "shop-api: [Phase 1] Rate `limiting` <draft>",
    url: JOIN_URL,
    previewUrl: PREVIEW_URL,
    version: 1763280000,
  });
  assert.ok(section.startsWith(PR_SECTION_START));
  assert.ok(section.endsWith(PR_SECTION_END));
  assert.ok(
    section.includes(
      `[![${escapeMarkdownText("shop-api: [Phase 1] Rate `limiting` <draft>")}](${PREVIEW_URL}?v=1763280000)](${JOIN_URL})`
    )
  );
  assert.ok(section.includes(`[Open visual plan on Unpaged (Can view)](${JOIN_URL})`));
  assert.ok(!/\bboard\b/i.test(section));
  assert.ok(!/\bbox\b/i.test(section));
});

test("splicePrPlanSection appends cleanly and replaces an existing block byte-for-byte in place", () => {
  const first = renderPrPlanSection({ title: "Plan v1", url: JOIN_URL, version: 100 });
  const second = renderPrPlanSection({ title: "Plan v2", url: JOIN_URL, version: 200 });

  assert.equal(splicePrPlanSection("", first), `${first}\n`);

  const authorBody = "## Summary\n\nImplements `$HOME` check and `gh` support.\n\n## Verification\n- Ran unit tests";
  const withFirst = splicePrPlanSection(authorBody, first);
  assert.equal(withFirst, `${authorBody}\n\n${first}\n`);

  const withTrailing = `${withFirst}\n### Notes below\nKeep this footer exact.`;
  const updated = splicePrPlanSection(withTrailing, second);
  assert.equal(updated, `${authorBody}\n\n${second}\n\n### Notes below\nKeep this footer exact.`);
  // Re-running with the same section is idempotent.
  assert.equal(splicePrPlanSection(updated, second), updated);

  // Markers quoted in inline backticks, fenced code blocks, or 4-space/tab-indented code blocks are ignored.
  const proseWithQuotedMarkers = [
    "## Summary",
    `Documents \`${PR_SECTION_START} ... ${PR_SECTION_END}\` in prose.`,
    "",
    "```markdown",
    PR_SECTION_START,
    "Example inside code fence",
    PR_SECTION_END,
    "```",
  ].join("\n");
  const appendedAfterQuoted = splicePrPlanSection(proseWithQuotedMarkers, first);
  assert.equal(appendedAfterQuoted, `${proseWithQuotedMarkers}\n\n${first}\n`);
  assert.equal(splicePrPlanSection(appendedAfterQuoted, second), `${proseWithQuotedMarkers}\n\n${second}\n`);

  for (const indentedExample of [
    `Use these markers:\n\n    ${PR_SECTION_START}\n    your text\n    ${PR_SECTION_END}\n\nThanks.`,
    `Use these markers:\n\n\t${PR_SECTION_START}\n\tyour text\n\t${PR_SECTION_END}\n\nThanks.`,
    `Single quoted start marker:\n\n    ${PR_SECTION_START}\n\nKeep prose.`,
  ]) {
    const withIndented = splicePrPlanSection(indentedExample, first);
    assert.equal(withIndented, `${indentedExample}\n\n${first}\n`);
    assert.equal(splicePrPlanSection(withIndented, second), `${indentedExample}\n\n${second}\n`);
  }

  // A trailing unclosed code fence is closed before appending so the section renders outside it and refreshes in place.
  const unclosedFenceBody = "## Logs\n\n````text\nline 1\nline 2";
  const afterUnclosed = splicePrPlanSection(unclosedFenceBody, first);
  assert.equal(afterUnclosed, `${unclosedFenceBody}\n\`\`\`\`\n\n${first}\n`);
  assert.equal(splicePrPlanSection(afterUnclosed, second), `${unclosedFenceBody}\n\`\`\`\`\n\n${second}\n`);

  // Indented unclosed fences inside `- ` / `1. ` list items preserve their indentation on close (including CRLF),
  // while a list-scoped fence already ended by unindented text emits no extra fence.
  const bulletFenceBody = "- Ran the suite:\n  ```text\n  ok\n";
  const afterBullet = splicePrPlanSection(bulletFenceBody, first);
  assert.equal(afterBullet, `- Ran the suite:\n  \`\`\`text\n  ok\n  \`\`\`\n\n${first}\n`);
  assert.equal(splicePrPlanSection(afterBullet, second), `- Ran the suite:\n  \`\`\`text\n  ok\n  \`\`\`\n\n${second}\n`);

  const orderedCrlfBody = "1. Output:\r\n   ~~~text\r\n   pass\r\n";
  const afterOrdered = splicePrPlanSection(orderedCrlfBody, first);
  assert.equal(afterOrdered, `1. Output:\r\n   ~~~text\r\n   pass\n   ~~~\n\n${first}\n`);
  assert.equal(splicePrPlanSection(afterOrdered, second), `1. Output:\r\n   ~~~text\r\n   pass\n   ~~~\n\n${second}\n`);

  const endedByUnindented = "- Ran the suite:\n  ```text\n  ok\n\nSummary outside list.";
  const afterEnded = splicePrPlanSection(endedByUnindented, first);
  assert.equal(afterEnded, `${endedByUnindented}\n\n${first}\n`);

  // Lazy continuation lines or nested list items before an unclosed indented fence followed by top-level text
  // place the section at the top of the description (author text unchanged) and replace in place on refresh.
  for (const trickyBody of [
    "- Ran the full suite after the\nfix:\n  ```text\n  ok\nSummary at top level.\n",
    "- Tests\n  - unit: pass\n  ```text\n  log\nSummary.\n",
  ]) {
    const splicedOnce = splicePrPlanSection(trickyBody, first);
    assert.equal(splicedOnce, `${first}\n\n${trickyBody}`);
    assert.equal(splicePrPlanSection(splicedOnce, second), `${second}\n\n${trickyBody}`);
  }

  // Unpaired or reversed standalone markers throw rather than swallowing author text on refresh.
  assert.throws(
    () => splicePrPlanSection(`Intro\n\n${PR_SECTION_START}\nAuthor prose after stray marker`, first),
    /ambiguous_pr_plan_section/
  );
  assert.throws(
    () => splicePrPlanSection(`${PR_SECTION_END}\n\n${PR_SECTION_START}`, first),
    /ambiguous_pr_plan_section/
  );
});

test("extractCreatedPullRequest matches gh pr create and GitHub MCP PR tools, ignoring --dry-run and errors", () => {
  assert.deepEqual(
    extractCreatedPullRequest({
      toolName: "Bash",
      command: 'git push -u origin feat/x && gh pr create --title "Feat" --body "Body"',
      resultText: "Creating pull request for feat/x into main\nhttps://github.com/acme/shop/pull/42\n",
      isError: false,
    }),
    { url: "https://github.com/acme/shop/pull/42", number: 42 }
  );
  assert.equal(
    extractCreatedPullRequest({
      toolName: "Bash",
      command: 'gh pr create --dry-run --title "Feat"',
      resultText: "Would have created a Pull Request with:\nhttps://github.com/acme/shop/pull/1\n",
      isError: false,
    }),
    null
  );
  assert.equal(
    extractCreatedPullRequest({
      toolName: "Bash",
      command: "gh pr view 42",
      resultText: "https://github.com/acme/shop/pull/42",
      isError: false,
    }),
    null
  );
  assert.deepEqual(
    extractCreatedPullRequest({
      toolName: "mcp__plugin_github__create_pull_request",
      resultText: JSON.stringify({ html_url: "https://github.com/acme/shop/pull/99" }),
      isError: false,
    }),
    { url: "https://github.com/acme/shop/pull/99", number: 99 }
  );
  assert.equal(
    extractCreatedPullRequest({
      toolName: "mcp__plugin_github__create_pull_request",
      resultText: "https://github.com/acme/shop/pull/99",
      isError: true,
    }),
    null
  );

  const ctx = prPlanAttachContext({
    documentId: DOC_1,
    title: 'shop-api: `$(touch /tmp/pwn)` "Rate limiting"',
    pullRequestUrl: "https://github.com/acme/shop/pull/42",
    branch: "feat/rate-limit",
    spliceScript: "/opt/unpaged/monitors/plans.mjs",
  });
  assert.ok(ctx.includes(DOC_1));
  assert.ok(ctx.includes('role "viewer"'));
  assert.ok(ctx.includes("https://github.com/acme/shop/pull/42"));
  assert.ok(ctx.includes("never pass a canvas title on a shell command line"));
  assert.ok(ctx.includes('node "/opt/unpaged/monitors/plans.mjs" splice "<url>" "<previewUrl>"'));
  assert.ok(ctx.includes('--json headRefName --jq .headRefName'));
  assert.ok(ctx.includes('"feat/rate-limit"'));
  assert.ok(ctx.includes("only if it is about this pull request's work"));
  assert.ok(ctx.includes("reason splice printed on stderr"));

  const detachedCtx = prPlanAttachContext({
    documentId: DOC_1,
    title: "Detached plan",
    pullRequestUrl: "https://github.com/acme/shop/pull/43",
    branch: null,
    spliceScript: "/opt/unpaged/monitors/plans.mjs",
  });
  assert.ok(!detachedCtx.includes("headRefName"));
  assert.equal(normalizePullRequestHeadRef("acme:docs/rate-limit"), "docs/rate-limit");
  assert.equal(normalizePullRequestHeadRef("refs/heads/feat/x"), "feat/x");
  assert.equal(normalizePullRequestHeadRef(""), null);
  assert.ok(planStoreKey("/repo", "feat/x")?.startsWith("plan:/repo\nfeat/x"));
});

test("plans.mjs CLI spends plans once on check, handles branch renames and detached HEADs, expires stale entries after 14 days, and prints clear splice stderr reasons", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    const otherRepo = join(dir, "other-repo");
    const subDir = join(repo, "packages", "api");
    await mkdir(join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
    await mkdir(join(otherRepo, ".git"), { recursive: true });
    await mkdir(subDir, { recursive: true });
    await writeFile(join(repo, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/develop\n", "utf8");
    await writeFile(join(otherRepo, ".git", "HEAD"), "ref: refs/heads/feat/other-repo\n", "utf8");

    const env = { ...process.env, HOME: home, USERPROFILE: home, UNPAGED_PREVIEW_VERSION: "1763281234" };
    const planDir = join(home, ".claude", "unpaged", "plans");

    // Planning on the remote default branch (`develop`) records a pending entry without polluting `develop`.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/develop\n", "utf8");
    const pendingRec = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1], {
      cwd: subDir,
      env,
      encoding: "utf8",
    });
    assert.equal(pendingRec.status, 0);
    assert.equal(pendingRec.stdout.trim(), "recorded pending-branch");

    const pendingFiles = await readdir(planDir);
    assert.equal(pendingFiles.length, 1);
    if (process.platform !== "win32") {
      const st = await stat(join(planDir, pendingFiles[0]));
      assert.equal(st.mode & 0o777, 0o600);
    }

    const onDefaultChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(onDefaultChk.stdout.trim(), "missing");

    // Another repository never sees this checkout's pending plan.
    const otherRepoChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: otherRepo, env, encoding: "utf8" });
    assert.equal(otherRepoChk.stdout.trim(), "missing");

    // Switching to a feature branch consumes and spends the pending plan once.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/pr-preview\n", "utf8");
    const promotedChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: subDir, env, encoding: "utf8" });
    assert.equal(promotedChk.status, 0);
    assert.equal(promotedChk.stdout.trim(), `plan ${DOC_1}`);
    assert.equal((await readdir(planDir)).length, 0);

    // Reusing `feat/pr-preview` or switching to another branch after spending gets `missing`.
    const reusedChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(reusedChk.stdout.trim(), "missing");
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/other\n", "utf8");
    const otherChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(otherChk.stdout.trim(), "missing");

    // Branch rename (`claude/<folder>` -> `feat/descriptive`) keeps the plan for one use, then spends both files.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/claude/session-wt\n", "utf8");
    const renameRec = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1], { cwd: repo, env, encoding: "utf8" });
    assert.equal(renameRec.stdout.trim(), "recorded claude/session-wt");
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/descriptive\n", "utf8");
    const afterRenameChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(afterRenameChk.stdout.trim(), `plan ${DOC_1}`);
    assert.equal((await readdir(planDir)).length, 0);
    const secondAfterRename = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(secondAfterRename.stdout.trim(), "missing");

    // Unused branch record older than 14 days expires on lookup instead of attaching to a reused branch name.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/fix/typo\n", "utf8");
    spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1], { cwd: repo, env, encoding: "utf8" });
    const staleStamp = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    for (const f of await readdir(planDir)) {
      const p = join(planDir, f);
      const raw = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
      raw.updatedAt = staleStamp;
      await writeFile(p, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    }
    const staleChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(staleChk.stdout.trim(), "missing");
    assert.equal((await readdir(planDir)).length, 0);

    // Worktree with `.git` pointer file resolves its own branch cleanly, and `forget` removes matching documentId.
    const worktree = join(dir, "wt");
    const wtGitDir = join(dir, "main-git", "worktrees", "wt");
    await mkdir(worktree, { recursive: true });
    await mkdir(wtGitDir, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
    await writeFile(join(wtGitDir, "HEAD"), "ref: refs/heads/feat/wt-branch\n", "utf8");

    const wtRec = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_2], {
      cwd: worktree,
      env,
      encoding: "utf8",
    });
    assert.equal(wtRec.status, 0);
    assert.equal(wtRec.stdout.trim(), "recorded feat/wt-branch");
    const forgot = spawnSync(process.execPath, [PLANS_SCRIPT, "forget", DOC_2], { cwd: worktree, env, encoding: "utf8" });
    assert.equal(forgot.stdout.trim(), "forgotten 2");
    const chkAfterForget = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: worktree, env, encoding: "utf8" });
    assert.equal(chkAfterForget.stdout.trim(), "missing");

    // Detached HEAD and Git reftable `.invalid` HEAD stubs write only a one-shot pending entry (never a permanent `.invalid` branch record).
    await writeFile(join(wtGitDir, "HEAD"), "0123456789abcdef0123456789abcdef01234567\n", "utf8");
    const detachedRec = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_2], {
      cwd: worktree,
      env,
      encoding: "utf8",
    });
    assert.equal(detachedRec.status, 0);
    assert.equal(detachedRec.stdout.trim(), "recorded pending-branch");
    const detachedFirstChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: worktree, env, encoding: "utf8" });
    assert.equal(detachedFirstChk.stdout.trim(), `plan ${DOC_2}`);
    const detachedSecondChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: worktree, env, encoding: "utf8" });
    assert.equal(detachedSecondChk.stdout.trim(), "missing");

    await writeFile(join(wtGitDir, "HEAD"), "ref: refs/heads/.invalid\n", "utf8");
    const reftableRec = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_2], {
      cwd: worktree,
      env,
      encoding: "utf8",
    });
    assert.equal(reftableRec.status, 0);
    assert.equal(reftableRec.stdout.trim(), "recorded pending-branch");
    const reftableFirstChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: worktree, env, encoding: "utf8" });
    assert.equal(reftableFirstChk.stdout.trim(), `plan ${DOC_2}`);
    const reftableSecondChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: worktree, env, encoding: "utf8" });
    assert.equal(reftableSecondChk.stdout.trim(), "missing");

    // 0-byte stdin, bad url vs bad previewUrl, and unpaired markers print distinct human-readable stderr messages.
    const emptyStdin = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "",
      encoding: "utf8",
    });
    assert.equal(emptyStdin.status, 1);
    assert.equal(emptyStdin.stdout, "");
    assert.ok(emptyStdin.stderr.includes("0 bytes received"));

    const badUrl = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", "http://localhost/join/abc", PREVIEW_URL], {
      cwd: repo,
      env,
      input: "Body\n",
      encoding: "utf8",
    });
    assert.equal(badUrl.status, 1);
    assert.ok(badUrl.stderr.includes("url must be"));

    const badPreview = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, "https://evil.example.com/p.png"], {
      cwd: repo,
      env,
      input: "Body\n",
      encoding: "utf8",
    });
    assert.equal(badPreview.status, 1);
    assert.ok(badPreview.stderr.includes("previewUrl must be"));

    const strayMarker = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: `Intro\n${PR_SECTION_START}\nUnclosed section\n`,
      encoding: "utf8",
    });
    assert.equal(strayMarker.status, 1);
    assert.ok(strayMarker.stderr.includes(AMBIGUOUS_PR_SECTION_MESSAGE));

    // Empty PR body from `gh pr view --json body --jq .body` arrives as "\n" and succeeds.
    const newlineOnly = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "\n",
      encoding: "utf8",
    });
    assert.equal(newlineOnly.status, 0);
    assert.ok(newlineOnly.stdout.startsWith("<!-- unpaged-plan:start -->\n"));

    // Splice reads stdin and preserves backticks / $variables untouched.
    const spliced = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "Existing PR summary with `$PATH` and `<!-- unpaged-plan:start -->`.\n",
      encoding: "utf8",
    });
    assert.equal(spliced.status, 0);
    assert.ok(
      spliced.stdout.startsWith(
        "Existing PR summary with `$PATH` and `<!-- unpaged-plan:start -->`.\n\n<!-- unpaged-plan:start -->\n"
      )
    );
    assert.ok(spliced.stdout.includes(`${PREVIEW_URL}?v=1763281234`));
  });
});
