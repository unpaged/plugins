#!/usr/bin/env node
// Branch-scoped visual-plan records and bounded PR-body splicing for the
// Unpaged Antigravity plugin — plain named CLI verbs so skills never run inline
// `node -e` and never pass collaborator-editable titles on argv:
//
//   node plans.mjs record <documentId>       recorded <branch>|pending-branch | skipped no-branch
//   node plans.mjs check                     plan <documentId> | missing
//   node plans.mjs forget <documentId>|all   forgotten <count>
//   node plans.mjs splice <url> [previewUrl] reads non-empty PR body on stdin → writes spliced body on stdout
//
// Stores records under ~/.gemini/unpaged/plans/<sha256>.json (mode 0600,
// atomic tmp + rename) and never writes inside the git working tree. Plain Node ≥ 22.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDocumentId } from "./listen-core.mjs";
import {
  AMBIGUOUS_PR_SECTION_MESSAGE,
  BRANCH_PLAN_MAX_AGE_MS,
  describeJoinLinkError,
  isDefaultBranchName,
  isPlanRecordFresh,
  normalizePlanRecord,
  parseGitHeadBranch,
  parseJoinLinkUrls,
  parseOriginHeadBranch,
  pendingPlanStoreKey,
  planStoreKey,
  renderPrPlanSection,
  resolveCommonGitDir,
  resolveGitDirPointer,
  splicePrPlanSection,
} from "./pr-preview-core.mjs";

export const PLAN_DIR_RELATIVE = ".gemini/unpaged/plans";
export const PENDING_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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

export function pendingPlanFileName(repoTopLevel) {
  const key = pendingPlanStoreKey(repoTopLevel);
  if (!key) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  return `${hash}.json`;
}

async function readOriginDefaultBranch(gitDir, fs) {
  const candidates = [join(gitDir, "refs", "remotes", "origin", "HEAD")];
  try {
    const commonRaw = await fs.readFile(join(gitDir, "commondir"), "utf8");
    const commonDir = resolveCommonGitDir(commonRaw, gitDir);
    if (commonDir && commonDir !== gitDir) {
      candidates.push(join(commonDir, "refs", "remotes", "origin", "HEAD"));
    }
  } catch {
    // Normal .git directory has no commondir file.
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseOriginHeadBranch(await fs.readFile(candidate, "utf8"));
      if (parsed) return parsed;
    } catch {
      // Try next candidate.
    }
  }
  return null;
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
      if (!branch) {
        return {
          repoTopLevel: folder,
          branch: null,
          isDefaultBranch: false,
        };
      }
      const defaultBranch = await readOriginDefaultBranch(gitDir, fs);
      return {
        repoTopLevel: folder,
        branch,
        isDefaultBranch: isDefaultBranchName(branch, defaultBranch),
      };
    } catch {
      // Keep walking upward until filesystem root.
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

async function writeAtomicJson(fileName, value) {
  await mkdir(join(home, ".gemini", "unpaged"), { recursive: true, mode: 0o700 });
  await mkdir(planDir, { recursive: true, mode: 0o700 });
  const target = join(planDir, fileName);
  const tmp = `${target}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, target);
}

async function removePlansForDocument(documentId) {
  let names = [];
  try {
    names = await readdir(planDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const full = join(planDir, name);
    try {
      const parsed = JSON.parse(await readFile(full, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.documentId === documentId) {
        await rm(full, { force: true }).catch(() => {});
      }
    } catch {
      // Leave unreadable or non-matching files untouched.
    }
  }
}

async function recordPlan(documentId) {
  if (!isDocumentId(documentId)) {
    say("error not a document id");
    return 1;
  }
  const branchCtx = await resolveRepositoryBranch(process.cwd());
  if (!branchCtx) {
    say("skipped no-branch");
    return 0;
  }
  const updatedAt = new Date().toISOString();
  const pendingName = pendingPlanFileName(branchCtx.repoTopLevel);
  try {
    if (pendingName) {
      await writeAtomicJson(pendingName, {
        documentId,
        repoTopLevel: branchCtx.repoTopLevel,
        updatedAt,
      });
    }
    if (!branchCtx.branch || branchCtx.isDefaultBranch) {
      say(pendingName ? "recorded pending-branch" : "skipped no-branch");
      return 0;
    }

    const record = normalizePlanRecord({
      documentId,
      title: "",
      repoTopLevel: branchCtx.repoTopLevel,
      branch: branchCtx.branch,
      updatedAt,
    });
    const fileName = record ? planFileName(record.repoTopLevel, record.branch) : null;
    if (!record || !fileName) {
      say(pendingName ? "recorded pending-branch" : "skipped no-branch");
      return 0;
    }
    await writeAtomicJson(fileName, record);
    say(`recorded ${record.branch}`);
    return 0;
  } catch (error) {
    const code = error && typeof error.code === "string" ? error.code : "write-failed";
    say(`error ${code}`);
    return 1;
  }
}

async function consumePendingPlan(branchCtx) {
  const pendingName = pendingPlanFileName(branchCtx.repoTopLevel);
  if (!pendingName) return { documentId: null, error: null };
  const pendingPath = join(planDir, pendingName);
  try {
    const parsed = JSON.parse(await readFile(pendingPath, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !isDocumentId(parsed.documentId) ||
      parsed.repoTopLevel !== branchCtx.repoTopLevel
    ) {
      return { documentId: null, error: null };
    }
    if (!isPlanRecordFresh(parsed.updatedAt, PENDING_PLAN_MAX_AGE_MS)) {
      await rm(pendingPath, { force: true }).catch(() => {});
      return { documentId: null, error: null };
    }
    await removePlansForDocument(parsed.documentId);
    await rm(pendingPath, { force: true }).catch(() => {});
    return { documentId: parsed.documentId, error: null };
  } catch (error) {
    if (error && error.code === "ENOENT") return { documentId: null, error: null };
    return { documentId: null, error };
  }
}

async function checkPlan() {
  const branchCtx = await resolveRepositoryBranch(process.cwd());
  if (!branchCtx || branchCtx.isDefaultBranch) {
    say("missing");
    return 0;
  }
  const fileName = branchCtx.branch ? planFileName(branchCtx.repoTopLevel, branchCtx.branch) : null;
  if (fileName) {
    const filePath = join(planDir, fileName);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = normalizePlanRecord(JSON.parse(raw));
      if (
        parsed &&
        parsed.repoTopLevel === branchCtx.repoTopLevel &&
        parsed.branch === branchCtx.branch
      ) {
        if (isPlanRecordFresh(parsed.updatedAt, BRANCH_PLAN_MAX_AGE_MS)) {
          await removePlansForDocument(parsed.documentId);
          await rm(filePath, { force: true }).catch(() => {});
          say(`plan ${parsed.documentId}`);
          return 0;
        }
        await rm(filePath, { force: true }).catch(() => {});
      }
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        const code = error && typeof error.code === "string" ? error.code : "read-failed";
        say(`error ${code}`);
        return 1;
      }
    }
  }
  const pending = await consumePendingPlan(branchCtx);
  if (pending.error) {
    const code = pending.error && typeof pending.error.code === "string" ? pending.error.code : "read-failed";
    say(`error ${code}`);
    return 1;
  }
  say(pending.documentId ? `plan ${pending.documentId}` : "missing");
  return 0;
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
      const parsed = JSON.parse(await readFile(full, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.documentId === target) {
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

async function spliceFromStdin(url, previewUrl) {
  const validated = parseJoinLinkUrls({ url, previewUrl });
  if (!validated) {
    process.stderr.write(`plans.mjs splice: ${describeJoinLinkError({ url, previewUrl })}\n`);
    return 1;
  }
  if (process.stdin.isTTY) {
    process.stderr.write("plans.mjs splice: expected existing PR body on stdin (stdin is a TTY)\n");
    return 1;
  }
  const existingBody = await readStdin();
  if (existingBody.length === 0) {
    process.stderr.write(
      "plans.mjs splice: expected existing PR body on stdin (0 bytes received; check that gh pr view succeeded)\n"
    );
    return 1;
  }
  const envVersion = process.env.UNPAGED_PREVIEW_VERSION ? Number(process.env.UNPAGED_PREVIEW_VERSION) : 0;
  const version = Number.isSafeInteger(envVersion) && envVersion > 0 ? envVersion : Math.floor(Date.now() / 1000);
  try {
    const section = renderPrPlanSection({
      title: "",
      url: validated.url,
      previewUrl: validated.previewUrl,
      version,
    });
    process.stdout.write(splicePrPlanSection(existingBody, section));
    return 0;
  } catch (error) {
    const rawReason = error && error.message ? error.message : String(error);
    const reason = rawReason === "ambiguous_pr_plan_section" ? AMBIGUOUS_PR_SECTION_MESSAGE : rawReason;
    process.stderr.write(`plans.mjs splice: ${reason}\n`);
    return 1;
  }
}

async function main() {
  const [verb, first, second] = process.argv.slice(2);
  switch (verb) {
    case "record":
      return recordPlan(first);
    case "check":
      return checkPlan();
    case "forget":
      return forgetPlan(first);
    case "splice":
      return spliceFromStdin(first, second);
    default:
      say("usage: plans.mjs record <documentId> | check | forget <documentId>|all | splice <url> [previewUrl]");
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
