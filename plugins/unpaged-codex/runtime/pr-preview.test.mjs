import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderPrPlanSection as renderClaudeSection } from "../../unpaged/monitors/pr-preview-core.mjs";
import { controlInputSchema, executeControl } from "./control.mjs";
import { renderPrPlanSection } from "./pr-preview.mjs";

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

test("executeControl supports plan_record, plan_lookup, and pr_splice without opening reviews.sqlite", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unpaged-codex-pr-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const codexHome = join(root, "codex-home");
  const repo = join(root, "repo");
  const sub = join(repo, "src");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(sub, { recursive: true });
  await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/codex-pr\n", "utf8");

  const context = { threadId: THREAD_1, cwd: sub };
  const options = { env: { ...process.env, CODEX_HOME: codexHome } };

  const initial = await executeControl({ operation: "plan_lookup" }, context, options);
  assert.deepEqual(initial, { recorded: false });

  const saved = await executeControl(
    { operation: "plan_record", documentId: DOC_1, payload: { title: "codex: Visual plan" } },
    context,
    options
  );
  assert.deepEqual(saved, {
    recorded: true,
    documentId: DOC_1,
    title: "codex: Visual plan",
    branch: "feat/codex-pr",
  });

  const planDir = join(codexHome, "unpaged", "plans");
  const files = await readdir(planDir);
  assert.equal(files.length, 1);
  if (process.platform !== "win32") {
    const st = await stat(join(planDir, files[0]));
    assert.equal(st.mode & 0o777, 0o600);
  }
  // reviews.sqlite was never created by plan_record or plan_lookup.
  await assert.rejects(() => stat(join(codexHome, "unpaged", "reviews.sqlite")), { code: "ENOENT" });

  const found = await executeControl({ operation: "plan_lookup" }, { threadId: THREAD_1, cwd: repo }, options);
  assert.equal(found.recorded, true);
  assert.equal(found.documentId, DOC_1);
  assert.equal(found.title, "codex: Visual plan");

  const spliced = await executeControl(
    {
      operation: "pr_splice",
      payload: {
        url: JOIN_URL,
        previewUrl: PREVIEW_URL,
        title: "codex: Visual plan",
        body: "Existing summary.\n",
      },
    },
    context,
    options
  );
  assert.equal(spliced.url, JOIN_URL);
  assert.equal(spliced.previewUrl, PREVIEW_URL);
  assert.ok(spliced.body.startsWith("Existing summary.\n\n<!-- unpaged-plan:start -->\n"));
  assert.ok(spliced.body.includes("[Open visual plan on Unpaged (Can view)]"));
  assert.ok(pathToFileURL(repo).href.startsWith("file://"));
});
