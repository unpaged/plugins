import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrPlanSection as renderClaudeSection } from "../../unpaged/monitors/pr-preview-core.mjs";
import { renderPrPlanSection, splicePrPlanSection } from "./pr-preview-core.mjs";

const PLANS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "plans.mjs");
const DOC_1 = "11111111-2222-3333-4444-555555555555";
const JOIN_TOKEN = "a".repeat(32);
const JOIN_URL = `https://unpaged.io/join/${JOIN_TOKEN}`;
const PREVIEW_URL = `${JOIN_URL}/preview.png`;

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "unpaged-agy-pr-preview-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Antigravity PR section matches Claude/Copilot format byte-for-byte", () => {
  const opts = {
    title: "shop-api: [Phase 1] Rate limiting",
    url: JOIN_URL,
    previewUrl: PREVIEW_URL,
    version: 1763289999,
  };
  assert.equal(renderPrPlanSection(opts), renderClaudeSection(opts));
  const merged = splicePrPlanSection("Intro\n", renderPrPlanSection(opts));
  assert.ok(merged.startsWith("Intro\n\n<!-- unpaged-plan:start -->\n"));
});

test("Antigravity plans.mjs stores mode-0600 records under ~/.gemini/unpaged/plans and splices PR bodies", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/agy-pr\n", "utf8");

    const env = { ...process.env, HOME: home, USERPROFILE: home, UNPAGED_PREVIEW_VERSION: "1763281111" };
    const rec = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1, "agy: Plan"], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    assert.equal(rec.status, 0);
    assert.equal(rec.stdout.trim(), "recorded feat/agy-pr");

    const planDir = join(home, ".gemini", "unpaged", "plans");
    const files = await readdir(planDir);
    assert.equal(files.length, 1);
    if (process.platform !== "win32") {
      const st = await stat(join(planDir, files[0]));
      assert.equal(st.mode & 0o777, 0o600);
    }

    const chk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(chk.stdout.trim(), `plan ${DOC_1}\tagy: Plan`);

    const spliced = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL, "agy: Plan"], {
      cwd: repo,
      env,
      input: "Summary text",
      encoding: "utf8",
    });
    assert.equal(spliced.status, 0);
    assert.ok(spliced.stdout.includes(`${PREVIEW_URL}?v=1763281111`));
  });
});
