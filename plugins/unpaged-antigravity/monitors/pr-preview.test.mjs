import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrPlanSection as renderClaudeSection } from "../../unpaged/monitors/pr-preview-core.mjs";
import { PR_SECTION_END, PR_SECTION_START, renderPrPlanSection, splicePrPlanSection } from "./pr-preview-core.mjs";

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

test("Antigravity PR section matches Claude/Copilot format byte-for-byte and ignores inline/fenced markers", () => {
  const opts = {
    title: "shop-api: [Phase 1] Rate limiting",
    url: JOIN_URL,
    previewUrl: PREVIEW_URL,
    version: 1763289999,
  };
  const section = renderPrPlanSection(opts);
  assert.equal(section, renderClaudeSection(opts));
  const merged = splicePrPlanSection(`Intro mentioning \`${PR_SECTION_START} ... ${PR_SECTION_END}\`.\n`, section);
  assert.ok(merged.startsWith(`Intro mentioning \`${PR_SECTION_START} ... ${PR_SECTION_END}\`.\n\n<!-- unpaged-plan:start -->\n`));

  const unclosed = "```text\npasted log without closing fence";
  const once = splicePrPlanSection(unclosed, section);
  assert.equal(once, `${unclosed}\n\`\`\`\n\n${section}\n`);
  assert.equal(splicePrPlanSection(once, section), once);
});

test("Antigravity plans.mjs stores mode-0600 records under ~/.gemini/unpaged/plans, promotes default-branch plans, and rejects 0-byte stdin", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const env = { ...process.env, HOME: home, USERPROFILE: home, UNPAGED_PREVIEW_VERSION: "1763281111" };
    const pending = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    assert.equal(pending.status, 0);
    assert.equal(pending.stdout.trim(), "recorded pending-branch");

    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/agy-pr\n", "utf8");
    const chk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(chk.stdout.trim(), `plan ${DOC_1}`);

    const planDir = join(home, ".gemini", "unpaged", "plans");
    const files = await readdir(planDir);
    assert.equal(files.length, 1);
    if (process.platform !== "win32") {
      const st = await stat(join(planDir, files[0]));
      assert.equal(st.mode & 0o777, 0o600);
    }

    const emptyStdin = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "",
      encoding: "utf8",
    });
    assert.equal(emptyStdin.status, 1);

    const spliced = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", JOIN_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "Summary text",
      encoding: "utf8",
    });
    assert.equal(spliced.status, 0);
    assert.ok(spliced.stdout.includes(`${PREVIEW_URL}?v=1763281111`));
  });
});
