import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderPrPlanSection as renderClaudeSection } from "../../unpaged/monitors/pr-preview-core.mjs";
import { controlInputSchema, executeControl } from "./control.mjs";
import { PR_SECTION_END, PR_SECTION_START, renderPrPlanSection } from "./pr-preview.mjs";

const PR_PREVIEW_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "pr-preview.mjs");
const DOC_1 = "11111111-2222-3333-4444-555555555555";
const THREAD_1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
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

  // A Git reftable `.invalid` HEAD stub is rejected so no permanent `.invalid` branch record is ever saved.
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/.invalid\n", "utf8");
  const reftableSaved = await executeControl(
    { operation: "plan_record", documentId: DOC_1, payload: { title: "codex: Reftable" } },
    context,
    options
  );
  assert.deepEqual(reftableSaved, { recorded: false });
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
  const onMainLookup = await executeControl({ operation: "plan_lookup" }, context, options);
  assert.deepEqual(onMainLookup, { recorded: false });

  // Switching to a feature branch promotes the pending plan once.
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/codex-pr\n", "utf8");
  const found = await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options);
  assert.equal(found.recorded, true);
  assert.equal(found.documentId, DOC_1);
  assert.equal(found.title, "codex: Visual plan");
  assert.equal(found.branch, "feat/codex-pr");

  const planDir = join(codexHome, "unpaged", "plans");
  const files = await readdir(planDir);
  assert.equal(files.length, 1);
  if (process.platform !== "win32") {
    const st = await stat(join(planDir, files[0]));
    assert.equal(st.mode & 0o777, 0o600);
  }
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
