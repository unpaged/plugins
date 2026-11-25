import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPrPlanSection as renderClaudeSection } from "../../unpaged/monitors/pr-preview-core.mjs";
import {
  AMBIGUOUS_PR_SECTION_MESSAGE,
  PR_SECTION_END,
  PR_SECTION_START,
  renderPrPlanSection,
  splicePrPlanSection,
} from "./pr-preview-core.mjs";

const PLANS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "plans.mjs");
const DOC_1 = "11111111-2222-3333-4444-555555555555";
const PLAN_DOCUMENT_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const PUBLIC_URL = `https://unpaged.io/share/${PLAN_DOCUMENT_ID}`;
const PREVIEW_URL = `${PUBLIC_URL}/preview.png`;

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
    url: PUBLIC_URL,
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

  const listUnclosed = "- Ran the suite:\n  ```text\n  ok\n";
  const listOnce = splicePrPlanSection(listUnclosed, section);
  assert.equal(listOnce, `- Ran the suite:\n  \`\`\`text\n  ok\n  \`\`\`\n\n${section}\n`);
  assert.equal(splicePrPlanSection(listOnce, section), listOnce);

  for (const trickyBody of [
    "- Ran the full suite after the\nfix:\n  ```text\n  ok\nSummary at top level.\n",
    "- Tests\n  - unit: pass\n  ```text\n  log\nSummary.\n",
  ]) {
    const onceTop = splicePrPlanSection(trickyBody, section);
    assert.equal(onceTop, `${section}\n\n${trickyBody}`);
    assert.equal(splicePrPlanSection(onceTop, section), onceTop);
  }

  for (const indentedExample of [
    `Use these markers:\n\n    ${PR_SECTION_START}\n    your text\n    ${PR_SECTION_END}\n\nThanks.`,
    `Use these markers:\n\n\t${PR_SECTION_START}\n\tyour text\n\t${PR_SECTION_END}\n\nThanks.`,
    `Single quoted start:\n\n    ${PR_SECTION_START}\n\nThanks.`,
  ]) {
    const onceIndented = splicePrPlanSection(indentedExample, section);
    assert.equal(onceIndented, `${indentedExample}\n\n${section}\n`);
    assert.equal(splicePrPlanSection(onceIndented, section), onceIndented);
  }
});

test("Antigravity plans.mjs spends mode-0600 records under ~/.gemini/unpaged/plans once, handles branch renames, expires stale entries, and prints clear splice stderr reasons", async () => {
  await withTempDir(async (dir) => {
    const home = join(dir, "home");
    const repo = join(dir, "repo");
    const otherRepo = join(dir, "other-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(otherRepo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(join(otherRepo, ".git", "HEAD"), "ref: refs/heads/feat/other\n", "utf8");

    const env = { ...process.env, HOME: home, USERPROFILE: home, UNPAGED_PREVIEW_VERSION: "1763281111" };
    const planDir = join(home, ".gemini", "unpaged", "plans");

    const pending = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1], {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    assert.equal(pending.status, 0);
    assert.equal(pending.stdout.trim(), "recorded pending-branch");

    const files = await readdir(planDir);
    assert.equal(files.length, 1);
    if (process.platform !== "win32") {
      const st = await stat(join(planDir, files[0]));
      assert.equal(st.mode & 0o777, 0o600);
    }

    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/agy-pr\n", "utf8");
    const chk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(chk.stdout.trim(), `plan ${DOC_1}`);
    assert.equal((await readdir(planDir)).length, 0);

    // Reusing `feat/agy-pr` after spending attaches nothing.
    const chkAgain = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(chkAgain.stdout.trim(), "missing");

    // Branch rename (`claude/<folder>` -> `feat/renamed`) attaches once and never leaks to another repository.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/claude/wt-folder\n", "utf8");
    const recOnStart = spawnSync(process.execPath, [PLANS_SCRIPT, "record", DOC_1], { cwd: repo, env, encoding: "utf8" });
    assert.equal(recOnStart.stdout.trim(), "recorded claude/wt-folder");
    const otherChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: otherRepo, env, encoding: "utf8" });
    assert.equal(otherChk.stdout.trim(), "missing");

    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/renamed\n", "utf8");
    const renamedChk = spawnSync(process.execPath, [PLANS_SCRIPT, "check"], { cwd: repo, env, encoding: "utf8" });
    assert.equal(renamedChk.stdout.trim(), `plan ${DOC_1}`);
    assert.equal((await readdir(planDir)).length, 0);

    const emptyStdin = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", PUBLIC_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "",
      encoding: "utf8",
    });
    assert.equal(emptyStdin.status, 1);

    const stray = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", PUBLIC_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: `${PR_SECTION_START}\nstray\n`,
      encoding: "utf8",
    });
    assert.equal(stray.status, 1);
    assert.ok(stray.stderr.includes(AMBIGUOUS_PR_SECTION_MESSAGE));

    const spliced = spawnSync(process.execPath, [PLANS_SCRIPT, "splice", PUBLIC_URL, PREVIEW_URL], {
      cwd: repo,
      env,
      input: "Summary text",
      encoding: "utf8",
    });
    assert.equal(spliced.status, 0);
    assert.ok(spliced.stdout.includes(`${PREVIEW_URL}?v=1763281111`));
  });
});
