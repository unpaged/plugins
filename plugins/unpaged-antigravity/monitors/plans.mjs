#!/usr/bin/env node
// Branch-scoped visual-plan records and bounded PR-body splicing for the
// Unpaged Antigravity plugin — plain named CLI verbs (no inline `node -e`):
//
//   node plans.mjs record <documentId> [title]       recorded <branch> | skipped no-branch
//   node plans.mjs check                             plan <documentId>\t<title> | missing
//   node plans.mjs forget <documentId>|all           forgotten <count>
//   node plans.mjs splice <url> [previewUrl] [title] reads PR body on stdin → writes spliced body on stdout
//
// Stores records under ~/.gemini/unpaged/plans/<sha256>.json (mode 0600,
// atomic tmp + rename) and never writes inside the git working tree. Plain Node ≥ 22.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDocumentId } from "./listen-core.mjs";
import {
  normalizePlanRecord,
  parseGitHeadBranch,
  parseJoinLinkUrls,
  planStoreKey,
  renderPrPlanSection,
  resolveGitDirPointer,
  splicePrPlanSection,
} from "./pr-preview-core.mjs";

export const PLAN_DIR_RELATIVE = ".gemini/unpaged/plans";

const home = homedir();
const planDir = join(home, PLAN_DIR_RELATIVE);

function say(line) {
  process.stdout.write(`${line}\n`);
}

function readStdin() {
  return new Promise((resolvePromise) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolvePromise(text));
    process.stdin.on("error", () => resolvePromise(text));
  });
}

export function planFileName(repoTopLevel, branch) {
  const key = planStoreKey(repoTopLevel, branch);
  if (!key) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

export async function resolveRepositoryBranch(startDir, fs = { readFile, stat }) {
  if (typeof startDir !== "string" || !startDir) return null;
  let folder = resolve(startDir);
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = join(folder, ".git");
    try {
      const info = await fs.stat(dotGit);
      let gitDir = null;
      if (info.isDirectory()) {
        gitDir = dotGit;
      } else if (info.isFile()) {
        gitDir = resolveGitDirPointer(await fs.readFile(dotGit, "utf8"), folder);
      }
      if (!gitDir) return null;
      const headRaw = await fs.readFile(join(gitDir, "HEAD"), "utf8");
      const branch = parseGitHeadBranch(headRaw);
      return branch ? { repoTopLevel: folder, branch } : null;
    } catch {
      // Keep walking upward until filesystem root.
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

async function writeAtomicPlan(record) {
  const fileName = planFileName(record.repoTopLevel, record.branch);
  if (!fileName) throw new Error("invalid_branch_plan");
  await mkdir(join(home, ".gemini", "unpaged"), { recursive: true, mode: 0o700 });
  await mkdir(planDir, { recursive: true, mode: 0o700 });
  const target = join(planDir, fileName);
  const tmp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

async function recordPlan(documentId, titleArg) {
  if (!isDocumentId(documentId)) {
    say("error not a document id");
    return 1;
  }
  const branchCtx = await resolveRepositoryBranch(process.cwd());
  if (!branchCtx) {
    say("skipped no-branch");
    return 0;
  }
  const record = normalizePlanRecord({
    documentId,
    title: typeof titleArg === "string" ? titleArg : "",
    repoTopLevel: branchCtx.repoTopLevel,
    branch: branchCtx.branch,
    updatedAt: new Date().toISOString(),
  });
  if (!record) {
    say("skipped no-branch");
    return 0;
  }
  try {
    await writeAtomicPlan(record);
    say(`recorded ${record.branch}`);
    return 0;
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : "write-failed";
    say(`error ${code}`);
    return 1;
  }
}

async function checkPlan() {
  const branchCtx = await resolveRepositoryBranch(process.cwd());
  if (!branchCtx) {
    say("missing");
    return 0;
  }
  const fileName = planFileName(branchCtx.repoTopLevel, branchCtx.branch);
  if (!fileName) {
    say("missing");
    return 0;
  }
  try {
    const raw = await readFile(join(planDir, fileName), "utf8");
    const parsed = normalizePlanRecord(JSON.parse(raw));
    if (
      !parsed ||
      parsed.repoTopLevel !== branchCtx.repoTopLevel ||
      parsed.branch !== branchCtx.branch
    ) {
      say("missing");
      return 0;
    }
    const cleanTitle = parsed.title.replace(/[\t\r\n]+/g, " ").trim();
    say(cleanTitle ? `plan ${parsed.documentId}\t${cleanTitle}` : `plan ${parsed.documentId}`);
    return 0;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      say("missing");
      return 0;
    }
    const code = error && typeof error.code === "string" ? error.code : "read-failed";
    say(`error ${code}`);
    return 1;
  }
}

async function forgetPlan(target) {
  if (target !== "all" && !isDocumentId(target)) {
    say("forgotten 0");
    return 0;
  }
  let names = [];
  try {
    names = await readdir(planDir);
  } catch {
    names = [];
  }
  let count = 0;
  for (const name of names) {
    if (!name.endsWith(".json") && !name.includes(".json.")) continue;
    const full = join(planDir, name);
    if (target === "all") {
      await rm(full, { force: true });
      count += 1;
      continue;
    }
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = normalizePlanRecord(JSON.parse(await readFile(full, "utf8")));
      if (parsed && parsed.documentId === target) {
        await rm(full, { force: true });
        count += 1;
      }
    } catch {
      // Leave unreadable or non-matching files untouched.
    }
  }
  say(`forgotten ${count}`);
  return 0;
}

async function spliceFromStdin(url, previewUrlArg, titleArg) {
  let previewUrl = previewUrlArg;
  let title = titleArg;
  if (typeof previewUrlArg === "string" && previewUrlArg && !previewUrlArg.startsWith("https://") && titleArg === undefined) {
    previewUrl = undefined;
    title = previewUrlArg;
  }
  const validated = parseJoinLinkUrls({ url, previewUrl });
  if (!validated) {
    process.stderr.write("plans.mjs splice: url must be an Unpaged https /join/<token> link\n");
    return 1;
  }
  const existingBody = process.stdin.isTTY ? "" : await readStdin();
  const envVersion = process.env.UNPAGED_PREVIEW_VERSION ? Number(process.env.UNPAGED_PREVIEW_VERSION) : 0;
  const version = Number.isSafeInteger(envVersion) && envVersion > 0 ? envVersion : Math.floor(Date.now() / 1000);
  const section = renderPrPlanSection({
    title: typeof title === "string" ? title : "",
    url: validated.url,
    previewUrl: validated.previewUrl,
    version,
  });
  process.stdout.write(splicePrPlanSection(existingBody, section));
  return 0;
}

async function main() {
  const [verb, first, second, third] = process.argv.slice(2);
  switch (verb) {
    case "record":
      return recordPlan(first, second);
    case "check":
      return checkPlan();
    case "forget":
      return forgetPlan(first);
    case "splice":
      return spliceFromStdin(first, second, third);
    default:
      say(
        "usage: plans.mjs record <documentId> [title] | check | forget <documentId>|all | splice <url> [previewUrl] [title]"
      );
      return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("plans.mjs")) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`plans.mjs: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
