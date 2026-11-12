// Local state for the GitHub Copilot session extension: per-canvas listener
// keys and architecture verdicts under <copilotHome>/unpaged/ (mode 0700 dirs,
// mode 0600 files written via tmp + rename), plus reading .unpaged/architecture.json
// at the git repository root. Never writes to stdout.
import { access, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  isDocumentId,
  isUnpagedListenerUrl,
  keyFileFor,
  parseListenerConfig,
  retireKeyFile,
} from "../../monitors/listen-core.mjs";

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

  return {
    keyDir,
    verdictDir,
    loadListener,
    saveListener,
    listListeners,
    retireListener,
    retireListenerByKeyId,
    loadVerdict,
    saveVerdict,
    findRepositoryRoot,
    readArchitecturePointer,
  };
}
