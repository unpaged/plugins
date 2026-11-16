// Local state for the GitHub Copilot session extension: per-canvas listener
// keys, architecture verdicts, and feature-branch visual plans under
// <copilotHome>/unpaged/ (mode 0700 dirs, mode 0600 files written via tmp +
// rename), plus reading .unpaged/architecture.json at the git repository root.
// Never writes to stdout.
import { access, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isDocumentId,
  isUnpagedListenerUrl,
  keyFileFor,
  parseListenerConfig,
  retireKeyFile,
} from "../../monitors/listen-core.mjs";
import {
  isDefaultBranchName,
  normalizePlanRecord,
  parseGitHeadBranch,
  parseOriginHeadBranch,
  planStoreKey,
  resolveCommonGitDir,
  resolveGitDirPointer,
} from "../../monitors/pr-preview-core.mjs";

export const POINTER_RELATIVE = join(".unpaged", "architecture.json");
const VERDICT_STATES = new Set(["current", "behind", "lost"]);
const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/;

function validDay(value) {
  return typeof value === "string" && DAY_SHAPE.test(value.trim()) ? value.trim() : null;
}

function validCommit(value) {
  return typeof value === "string" && COMMIT_SHAPE.test(value.trim()) ? value.trim() : null;
}

export function parseArchitecturePointer(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !isDocumentId(parsed.documentId)) {
      return null;
    }
    return {
      documentId: String(parsed.documentId),
      title: typeof parsed.title === "string" && parsed.title ? parsed.title : null,
    };
  } catch {
    return null;
  }
}

export function createCopilotStore({
  copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
  fs = { access, link, mkdir, readdir, readFile, rename, rm, writeFile },
  pid = process.pid,
} = {}) {
  const rootDir = join(copilotHome, "unpaged");
  const keyDir = join(rootDir, "listeners");
  const verdictDir = join(rootDir, "architecture");
  const planDir = join(rootDir, "plans");

  function planFileFor(repoTopLevel, branch) {
    const key = planStoreKey(repoTopLevel, branch);
    if (!key) return null;
    const hash = createHash("sha256").update(key).digest("hex");
    return join(planDir, `${hash}.json`);
  }

  async function writeAtomicJson(dir, file, value) {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${pid}-${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  async function loadListener(documentId) {
    const file = keyFileFor(keyDir, documentId);
    if (!file) return null;
    try {
      const config = parseListenerConfig(await fs.readFile(file, "utf8"));
      return config && config.documentId === documentId && isUnpagedListenerUrl(config.pollUrl) ? config : null;
    } catch {
      return null;
    }
  }

  async function saveListener(config) {
    const file = keyFileFor(keyDir, config?.documentId);
    if (!file || !isUnpagedListenerUrl(config?.pollUrl)) {
      throw new Error("invalid_listener_config");
    }
    await writeAtomicJson(keyDir, file, config);
  }

  async function listListeners() {
    let names = [];
    try {
      names = await fs.readdir(keyDir);
    } catch {
      return [];
    }
    const items = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const documentId = name.slice(0, -".json".length);
      const config = await loadListener(documentId);
      if (config) items.push(config);
    }
    return items;
  }

  async function retireListener(documentId, loadedConfig) {
    const file = keyFileFor(keyDir, documentId);
    if (!file || !loadedConfig) return "absent";
    return retireKeyFile(fs, file, loadedConfig, pid);
  }

  async function retireListenerByKeyId(documentId, keyId) {
    if (!keyId) return "absent";
    const current = await loadListener(documentId);
    if (!current) return "absent";
    if (current.keyId !== keyId) return "kept-newer";
    return retireListener(documentId, current);
  }

  async function loadVerdict(documentId) {
    const file = keyFileFor(verdictDir, documentId);
    if (!file) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || parsed.documentId !== documentId || !VERDICT_STATES.has(parsed.state)) {
        return null;
      }
      return {
        documentId,
        state: parsed.state,
        title: typeof parsed.title === "string" && parsed.title ? parsed.title : null,
        checkedAt: validDay(parsed.checkedAt),
        commit: validCommit(parsed.commit),
        behindSince: validDay(parsed.behindSince),
        reportedAt: typeof parsed.reportedAt === "string" ? parsed.reportedAt : "",
      };
    } catch {
      return null;
    }
  }

  async function saveVerdict(verdict) {
    const file = keyFileFor(verdictDir, verdict?.documentId);
    if (!file || !VERDICT_STATES.has(verdict?.state)) {
      throw new Error("invalid_architecture_verdict");
    }
    await writeAtomicJson(verdictDir, file, verdict);
  }

  async function findRepositoryRoot(startDir) {
    if (typeof startDir !== "string" || !startDir) return null;
    let folder = resolve(startDir);
    for (let depth = 0; depth < 64; depth++) {
      try {
        await fs.access(join(folder, ".git"));
        return folder;
      } catch {
        // Keep walking upward.
      }
      const parent = dirname(folder);
      if (parent === folder) return null;
      folder = parent;
    }
    return null;
  }

  async function readArchitecturePointer(startDir) {
    const repoRoot = await findRepositoryRoot(startDir);
    if (!repoRoot) return null;
    try {
      const raw = await fs.readFile(join(repoRoot, POINTER_RELATIVE), "utf8");
      return parseArchitecturePointer(raw);
    } catch {
      return null;
    }
  }

  async function readOriginDefaultBranch(gitDir) {
    const candidates = [join(gitDir, "refs", "remotes", "origin", "HEAD")];
    try {
      const commonRaw = await fs.readFile(join(gitDir, "commondir"), "utf8");
      const commonDir = resolveCommonGitDir(commonRaw, gitDir);
      if (commonDir && commonDir !== gitDir) {
        candidates.push(join(commonDir, "refs", "remotes", "origin", "HEAD"));
      }
    } catch {
      // Standard .git directory has no commondir file.
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

  async function resolveRepositoryBranch(startDir) {
    const repoTopLevel = await findRepositoryRoot(startDir);
    if (!repoTopLevel) return null;
    let gitDir = join(repoTopLevel, ".git");
    let headRaw = null;
    try {
      headRaw = await fs.readFile(join(gitDir, "HEAD"), "utf8");
    } catch {
      try {
        const dotGitRaw = await fs.readFile(gitDir, "utf8");
        const resolved = resolveGitDirPointer(dotGitRaw, repoTopLevel);
        if (resolved) {
          gitDir = resolved;
          headRaw = await fs.readFile(join(gitDir, "HEAD"), "utf8");
        }
      } catch {
        headRaw = null;
      }
    }
    const branch = parseGitHeadBranch(headRaw);
    if (!branch) return { repoTopLevel, branch: null, isDefaultBranch: false };
    const defaultBranch = await readOriginDefaultBranch(gitDir);
    return {
      repoTopLevel,
      branch,
      isDefaultBranch: isDefaultBranchName(branch, defaultBranch),
    };
  }

  async function saveBranchPlan({ cwd, documentId, title = "", updatedAt = "" } = {}) {
    if (!isDocumentId(documentId)) return null;
    const branchCtx = await resolveRepositoryBranch(cwd);
    if (!branchCtx) return null;
    if (!branchCtx.branch || branchCtx.isDefaultBranch) {
      // Never persist a cross-session plan record keyed to the default branch.
      return {
        persisted: false,
        documentId,
        title: typeof title === "string" ? title.replace(/[\r\n\t]+/g, " ").trim() : "",
        repoTopLevel: branchCtx.repoTopLevel,
        branch: branchCtx.branch,
      };
    }
    const record = normalizePlanRecord({
      documentId,
      title,
      repoTopLevel: branchCtx.repoTopLevel,
      branch: branchCtx.branch,
      updatedAt: updatedAt || new Date().toISOString(),
    });
    const file = record ? planFileFor(record.repoTopLevel, record.branch) : null;
    if (!record || !file) return null;
    await writeAtomicJson(planDir, file, record);
    return { ...record, persisted: true };
  }

  async function loadBranchPlan(cwd) {
    const branchCtx = await resolveRepositoryBranch(cwd);
    if (!branchCtx || !branchCtx.branch || branchCtx.isDefaultBranch) return null;
    const file = planFileFor(branchCtx.repoTopLevel, branchCtx.branch);
    if (!file) return null;
    try {
      const parsed = normalizePlanRecord(JSON.parse(await fs.readFile(file, "utf8")));
      if (
        !parsed ||
        parsed.repoTopLevel !== branchCtx.repoTopLevel ||
        parsed.branch !== branchCtx.branch
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async function forgetBranchPlanByDocumentId(documentId) {
    if (!isDocumentId(documentId)) return 0;
    let names = [];
    try {
      names = await fs.readdir(planDir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(planDir, name);
      try {
        const parsed = normalizePlanRecord(JSON.parse(await fs.readFile(file, "utf8")));
        if (parsed && parsed.documentId === documentId) {
          await fs.rm(file, { force: true });
          removed += 1;
        }
      } catch {
        // Keep unreadable or non-matching entries intact.
      }
    }
    return removed;
  }

  return {
    keyDir,
    verdictDir,
    planDir,
    loadListener,
    saveListener,
    listListeners,
    retireListener,
    retireListenerByKeyId,
    loadVerdict,
    saveVerdict,
    findRepositoryRoot,
    readArchitecturePointer,
    resolveRepositoryBranch,
    saveBranchPlan,
    loadBranchPlan,
    forgetBranchPlanByDocumentId,
  };
}
