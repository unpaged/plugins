import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderPrPlanSection as renderClaudeSection } from "../../unpaged/monitors/pr-preview-core.mjs";
import { controlInputSchema, executeControl } from "./control.mjs";
import { AMBIGUOUS_PR_SECTION_MESSAGE, PR_SECTION_END, PR_SECTION_START, renderPrPlanSection } from "./pr-preview.mjs";

const PR_PREVIEW_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pr-preview.mjs");
const DOC_1 = "11111111-2222-3333-4444-555555555555";
const DOC_2 = "22222222-3333-4444-8555-666666666666";
const THREAD_1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const THREAD_2 = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const JOIN_TOKEN = "a".repeat(32);
const JOIN_URL = `https://unpaged.io/join/${JOIN_TOKEN}`;
const PREVIEW_URL = `${JOIN_URL}/preview.png`;

test("Codex PR section matches Claude/Copilot/Antigravity format byte-for-byte and keeps schema compact", () => {
  const opts = {
    title: "shop-api: [Phase 1] Rate limiting",
    url: JOIN_URL,
    previewUrl: PREVIEW_URL,
    version: 1763289999,
  };
  assert.equal(renderPrPlanSection(opts), renderClaudeSection(opts));
  assert.ok(Buffer.byteLength(JSON.stringify(controlInputSchema)) < 4000);
});

test("runtime/pr-preview.mjs CLI splices large PR descriptions directly via stdin/stdout and rejects 0-byte stdin", () => {
  const env = { ...process.env, UNPAGED_PREVIEW_VERSION: "1763282222" };

  const emptyStdin = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: "",
    encoding: "utf8",
  });
  assert.equal(emptyStdin.status, 1);
  assert.equal(emptyStdin.stdout, "");

  const badPreview = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, "https://evil.example.com/p.png"], {
    env,
    input: "Body\n",
    encoding: "utf8",
  });
  assert.equal(badPreview.status, 1);
  assert.ok(badPreview.stderr.includes("previewUrl must be"));

  const strayMarker = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: `${PR_SECTION_START}\nstray\n`,
    encoding: "utf8",
  });
  assert.equal(strayMarker.status, 1);
  assert.ok(strayMarker.stderr.includes(AMBIGUOUS_PR_SECTION_MESSAGE));

  // 350-line (> 14 KiB) PR body stays completely intact without passing through model context.
  const longLines = Array.from({ length: 350 }, (_, idx) => `- [x] Verification item #${idx + 1}: checked end-to-end`);
  const longBody = `## Summary\n\n${longLines.join("\n")}\n`;
  const spliced = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: longBody,
    encoding: "utf8",
  });
  assert.equal(spliced.status, 0);
  assert.ok(spliced.stdout.includes("- [x] Verification item #175: checked end-to-end"));
  assert.ok(spliced.stdout.includes("- [x] Verification item #350: checked end-to-end"));
  assert.ok(spliced.stdout.includes(`${PREVIEW_URL}?v=1763282222`));

  // Trailing unclosed code fence is closed before appending so a second splice updates in place.
  const unclosed = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: "```text\nunclosed log line\n",
    encoding: "utf8",
  });
  assert.equal(unclosed.status, 0);
  assert.ok(unclosed.stdout.startsWith("```text\nunclosed log line\n```\n\n<!-- unpaged-plan:start -->\n"));
  const unclosedAgain = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: unclosed.stdout,
    encoding: "utf8",
  });
  assert.equal(unclosedAgain.status, 0);
  assert.equal(unclosedAgain.stdout, unclosed.stdout);

  const listUnclosed = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: "- Ran the suite:\n  ```text\n  ok\n",
    encoding: "utf8",
  });
  assert.equal(listUnclosed.status, 0);
  assert.ok(listUnclosed.stdout.startsWith("- Ran the suite:\n  ```text\n  ok\n  ```\n\n<!-- unpaged-plan:start -->\n"));
  const listUnclosedAgain = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
    env,
    input: listUnclosed.stdout,
    encoding: "utf8",
  });
  assert.equal(listUnclosedAgain.status, 0);
  assert.equal(listUnclosedAgain.stdout, listUnclosed.stdout);

  for (const trickyBody of [
    "- Ran the full suite after the\nfix:\n  ```text\n  ok\nSummary at top level.\n",
    "- Tests\n  - unit: pass\n  ```text\n  log\nSummary.\n",
  ]) {
    const onceTop = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      env,
      input: trickyBody,
      encoding: "utf8",
    });
    assert.equal(onceTop.status, 0);
    assert.ok(onceTop.stdout.startsWith("<!-- unpaged-plan:start -->\n"));
    assert.ok(onceTop.stdout.endsWith(`\n\n${trickyBody}`));
    const twiceTop = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      env,
      input: onceTop.stdout,
      encoding: "utf8",
    });
    assert.equal(twiceTop.status, 0);
    assert.equal(twiceTop.stdout, onceTop.stdout);
  }

  for (const indentedExample of [
    `Use these markers:\n\n    ${PR_SECTION_START}\n    your text\n    ${PR_SECTION_END}\n\nThanks.\n`,
    `Use these markers:\n\n\t${PR_SECTION_START}\n\tyour text\n\t${PR_SECTION_END}\n\nThanks.\n`,
    `Single quoted start:\n\n    ${PR_SECTION_START}\n\nThanks.\n`,
  ]) {
    const onceInd = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      env,
      input: indentedExample,
      encoding: "utf8",
    });
    assert.equal(onceInd.status, 0);
    assert.ok(onceInd.stdout.startsWith(`${indentedExample.trimEnd()}\n\n<!-- unpaged-plan:start -->\n`));
    const twiceInd = spawnSync(process.execPath, [PR_PREVIEW_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      env,
      input: onceInd.stdout,
      encoding: "utf8",
    });
    assert.equal(twiceInd.status, 0);
    assert.equal(twiceInd.stdout, onceInd.stdout);
  }
});

test("executeControl supports plan_record, default-branch promotion on plan_lookup, and length-checked pr_splice without opening reviews.sqlite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unpaged-codex-pr-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const codexHome = join(root, "codex-home");
  const repo = join(root, "repo");
  const sub = join(repo, "src");
  await mkdir(join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
  await mkdir(sub, { recursive: true });
  await writeFile(join(repo, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n", "utf8");
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

  const context = { threadId: THREAD_1, cwd: sub };
  const options = { env: { ...process.env, CODEX_HOME: codexHome } };

  const initial = await executeControl({ operation: "plan_lookup" }, context, options);
  assert.deepEqual(initial, { recorded: false });

  // A Git reftable `.invalid` HEAD stub writes only a one-shot pending plan (never a permanent `.invalid` branch record).
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/.invalid\n", "utf8");
  const reftableSaved = await executeControl(
    { operation: "plan_record", documentId: DOC_1, payload: { title: "codex: Reftable" } },
    context,
    options
  );
  assert.deepEqual(reftableSaved, { recorded: true, documentId: DOC_1, title: "codex: Reftable", branch: null });
  const reftableFirst = await executeControl({ operation: "plan_lookup" }, context, options);
  assert.equal(reftableFirst.recorded, true);
  assert.equal(reftableFirst.documentId, DOC_1);
  assert.deepEqual(await executeControl({ operation: "plan_lookup" }, context, options), { recorded: false });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

  // Recording on `main` stores a one-shot pending plan rather than polluting `main`.
  const savedOnMain = await executeControl(
    { operation: "plan_record", documentId: DOC_1, payload: { title: "codex: Visual plan" } },
    context,
    options
  );
  assert.deepEqual(savedOnMain, {
    recorded: true,
    documentId: DOC_1,
    title: "codex: Visual plan",
    branch: "main",
  });
  const planDir = join(codexHome, "unpaged", "plans");
  const files = await readdir(planDir);
  assert.equal(files.length, 1);
  if (process.platform !== "win32") {
    const st = await stat(join(planDir, files[0]));
    assert.equal(st.mode & 0o777, 0o600);
  }
  const onMainLookup = await executeControl({ operation: "plan_lookup" }, context, options);
  assert.deepEqual(onMainLookup, { recorded: false });

  // Another Codex task (`THREAD_2`) never consumes `THREAD_1`'s pending plan.
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/codex-pr\n", "utf8");
  assert.deepEqual(
    await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_2, cwd: repo }, options),
    { recorded: false }
  );

  // `THREAD_1` consumes and spends the pending plan once.
  const found = await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options);
  assert.equal(found.recorded, true);
  assert.equal(found.documentId, DOC_1);
  assert.equal(found.title, "codex: Visual plan");
  assert.equal(found.branch, "feat/codex-pr");
  assert.equal((await readdir(planDir)).length, 0);
  assert.deepEqual(await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options), {
    recorded: false,
  });

  // Branch rename (`claude/<folder>` -> `feat/renamed`) attaches once, spends both files, and never crosses repositories.
  const otherRepo = join(root, "other-repo");
  await mkdir(join(otherRepo, ".git"), { recursive: true });
  await writeFile(join(otherRepo, ".git", "HEAD"), "ref: refs/heads/feat/other\n", "utf8");
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/claude/wt-start\n", "utf8");
  await executeControl(
    { operation: "plan_record", documentId: DOC_2, payload: { title: "codex: Renamed" } },
    { threadId: THREAD_1, cwd: repo },
    options
  );
  assert.deepEqual(
    await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: otherRepo }, options),
    { recorded: false }
  );
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/renamed\n", "utf8");
  const renamedFound = await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options);
  assert.equal(renamedFound.recorded, true);
  assert.equal(renamedFound.documentId, DOC_2);
  assert.equal((await readdir(planDir)).length, 0);
  assert.deepEqual(
    await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options),
    { recorded: false }
  );

  // Unused branch record older than 14 days expires on lookup.
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/fix/stale-typo\n", "utf8");
  await executeControl(
    { operation: "plan_record", documentId: DOC_2, payload: { title: "codex: Stale" } },
    { threadId: THREAD_1, cwd: repo },
    options
  );
  const staleStamp = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
  for (const f of await readdir(planDir)) {
    const p = join(planDir, f);
    const raw = JSON.parse(await (await import("node:fs/promises")).readFile(p, "utf8"));
    raw.updatedAt = staleStamp;
    await writeFile(p, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  }
  assert.deepEqual(
    await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options),
    { recorded: false }
  );
  assert.equal((await readdir(planDir)).length, 0);
  // reviews.sqlite was never created by plan_record or plan_lookup.
  await assert.rejects(() => stat(join(codexHome, "unpaged", "reviews.sqlite")), { code: "ENOENT" });

  // pr_splice requires both `body` and `bodyLength`, and refuses shortened bodies.
  await assert.rejects(
    () => executeControl({ operation: "pr_splice", payload: { url: JOIN_URL } }, context, options),
    /invalid_control_arguments/
  );
  await assert.rejects(
    () =>
      executeControl(
        {
          operation: "pr_splice",
          payload: { url: JOIN_URL, body: "Shortened … omitted 120 of 300 lines … tail", bodyLength: 9400 },
        },
        context,
        options
      ),
    /truncated_pr_body/
  );

  // pr_splice ignores markers quoted in inline code and rejects unpaired standalone start markers.
  const existingBody = `Existing summary 🎯 mentioning \`${PR_SECTION_START} ... ${PR_SECTION_END}\`.\n`;
  const spliced = await executeControl(
    {
      operation: "pr_splice",
      payload: {
        url: JOIN_URL,
        previewUrl: PREVIEW_URL,
        title: "codex: Visual plan",
        body: existingBody,
        bodyLength: [...existingBody].length,
      },
    },
    context,
    options
  );
  assert.equal(spliced.url, JOIN_URL);
  assert.equal(spliced.previewUrl, PREVIEW_URL);
  assert.ok(spliced.body.startsWith(`${existingBody}\n<!-- unpaged-plan:start -->\n`));
  assert.ok(spliced.body.includes("[Open visual plan on Unpaged (Can view)]"));

  const ambiguousBody = `Intro\n\n${PR_SECTION_START}\nAuthor text`;
  await assert.rejects(
    () =>
      executeControl(
        {
          operation: "pr_splice",
          payload: {
            url: JOIN_URL,
            body: ambiguousBody,
            bodyLength: [...ambiguousBody].length,
          },
        },
        context,
        options
      ),
    /ambiguous_pr_plan_section/
  );

  assert.ok(pathToFileURL(repo).href.startsWith("file://"));
});
