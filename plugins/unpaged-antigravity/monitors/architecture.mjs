#!/usr/bin/env node
// Local architecture-verdict and active-run store for the Unpaged Antigravity
// plugin. Provides both shared async functions (used by session-start.mjs and
// the sidecar server) and plain CLI verbs for the architecture skill:
//
//   node architecture.mjs status [path]
//   node architecture.mjs report [path]             (verdict JSON on stdin)
//   node architecture.mjs start-run <action> [path]
//   node architecture.mjs clear-run [path]
//
// Files live under ~/.gemini/unpaged/architecture/ (mode 0600, atomic
// tmp + rename) and never write inside the repository working tree.

import { createHash, randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  POINTER_RELATIVE,
  RUN_ACTIONS,
  RUN_DIR_RELATIVE,
  VERDICT_DIR_RELATIVE,
  actionPrompt,
  availableActions,
  boardUrlFor,
  describeStatus,
  isRunActive,
  lightColor,
  needsAttention,
  normalizeRunRecord,
  normalizeVerdict,
  parseArchitecturePointer,
  shownState,
} from "./architecture-core.mjs";

const MAX_POINTER_BYTES = 256 * 1024;
const MAX_VERDICT_BYTES = 64 * 1024;

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

export function canonicalPath(pathStr) {
  const resolved = resolve(String(pathStr || ""));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function runKeyForRepo(repoRoot) {
  return createHash("sha256").update(canonicalPath(repoRoot)).digest("hex");
}

export async function findRepositoryRoot(startDir, fs = { access }) {
  if (typeof startDir !== "string" || !startDir.trim()) return null;
  let folder = resolve(startDir);
  for (let depth = 0; depth < 64; depth++) {
    try {
      await fs.access(join(folder, ".git"));
      return folder;
    } catch {
      // Keep walking upward until the root directory.
    }
    const parent = dirname(folder);
    if (parent === folder) return null;
    folder = parent;
  }
  return null;
}

async function writeAtomicJson(rootDir, targetDir, filePath, value, { fs, pid }) {
  await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(targetDir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${pid}-${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function pathsFor(homeDir) {
  const unpagedRoot = join(homeDir, ".gemini", "unpaged");
  const verdictDir = join(homeDir, VERDICT_DIR_RELATIVE);
  const runDir = join(homeDir, RUN_DIR_RELATIVE);
  return { unpagedRoot, verdictDir, runDir };
}

export async function readRepositoryStatus(
  targetPath,
  {
    homeDir = homedir(),
    fs = { access, readFile },
    now = () => Date.now(),
  } = {}
) {
  const nowMs = now();
  const repoRoot = await findRepositoryRoot(targetPath, fs);
  if (!repoRoot) {
    return {
      isGitRepo: false,
      repoRoot: null,
      repoName: null,
      documentId: null,
      title: null,
      boardUrl: null,
      pointer: null,
      pointerInvalid: false,
      verdict: null,
      activeRun: null,
      shown: "none",
      color: "gray",
      headline: "Not a git repository",
      detail: "Open a git repository to track its architecture document.",
      needsAttention: false,
      actions: [],
    };
  }

  const repoName = basename(repoRoot);
  const { verdictDir, runDir } = pathsFor(homeDir);
  let pointer = null;
  let pointerInvalid = false;

  try {
    const rawPointer = await fs.readFile(join(repoRoot, POINTER_RELATIVE), "utf8");
    if (Buffer.byteLength(rawPointer, "utf8") > MAX_POINTER_BYTES) {
      pointerInvalid = true;
    } else {
      pointer = parseArchitecturePointer(rawPointer);
      if (!pointer) pointerInvalid = true;
    }
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      pointerInvalid = true;
    }
  }

  let verdict = null;
  if (pointer) {
    try {
      const rawVerdict = await fs.readFile(join(verdictDir, `${pointer.documentId}.json`), "utf8");
      if (Buffer.byteLength(rawVerdict, "utf8") <= MAX_VERDICT_BYTES) {
        verdict = normalizeVerdict(rawVerdict, pointer.documentId);
      }
    } catch {
      verdict = null;
    }
  }

  let activeRun = null;
  try {
    const rawRun = await fs.readFile(join(runDir, `${runKeyForRepo(repoRoot)}.json`), "utf8");
    const parsedRun = normalizeRunRecord(rawRun);
    if (isRunActive(parsedRun, verdict, nowMs)) {
      activeRun = parsedRun;
    }
  } catch {
    activeRun = null;
  }

  const shown = shownState(pointer, verdict, activeRun, nowMs);
  const title = verdict?.title || pointer?.title || repoName;
  const statusObj = {
    isGitRepo: true,
    repoRoot,
    repoName,
    documentId: pointer?.documentId ?? null,
    title,
    boardUrl: boardUrlFor(pointer?.documentId),
    pointer,
    pointerInvalid,
    verdict,
    activeRun,
    shown,
    color: lightColor(shown),
    needsAttention: needsAttention(shown),
    actions: availableActions(shown),
  };
  const described = describeStatus(statusObj, nowMs);
  return { ...statusObj, ...described };
}

export async function saveVerdictForRepo(
  targetPath,
  rawVerdict,
  {
    homeDir = homedir(),
    fs = { access, mkdir, readFile, rename, rm, writeFile },
    now = () => Date.now(),
    pid = process.pid,
  } = {}
) {
  const repoRoot = await findRepositoryRoot(targetPath, fs);
  if (!repoRoot) {
    return { ok: false, error: "not inside a git repository" };
  }
  let pointerRaw;
  try {
    pointerRaw = await fs.readFile(join(repoRoot, POINTER_RELATIVE), "utf8");
  } catch {
    return { ok: false, error: `missing ${POINTER_RELATIVE}; write the pointer file before reporting` };
  }
  const pointer = parseArchitecturePointer(pointerRaw);
  if (!pointer) {
    return { ok: false, error: `invalid ${POINTER_RELATIVE}; expected valid documentId` };
  }
  const normalized = normalizeVerdict(rawVerdict, pointer.documentId);
  if (!normalized) {
    return {
      ok: false,
      error: `invalid verdict JSON or documentId mismatch (expected ${pointer.documentId})`,
    };
  }
  const saved = {
    ...normalized,
    title: normalized.title || pointer.title || basename(repoRoot),
    reportedAt: new Date(now()).toISOString(),
  };
  const { unpagedRoot, verdictDir, runDir } = pathsFor(homeDir);
  await writeAtomicJson(unpagedRoot, verdictDir, join(verdictDir, `${pointer.documentId}.json`), saved, {
    fs,
    pid,
  });
  await fs.rm(join(runDir, `${runKeyForRepo(repoRoot)}.json`), { force: true }).catch(() => {});
  return { ok: true, verdict: saved, repoRoot };
}

export async function recordRunStart(
  targetPath,
  action,
  {
    homeDir = homedir(),
    fs = { access, mkdir, readFile, rename, writeFile },
    now = () => Date.now(),
    pid = process.pid,
  } = {}
) {
  const cleanAction = typeof action === "string" ? action.trim() : "";
  if (!RUN_ACTIONS.includes(cleanAction)) {
    return { ok: false, error: `invalid action: ${String(action)}` };
  }
  const repoRoot = await findRepositoryRoot(targetPath, fs);
  if (!repoRoot) {
    return { ok: false, error: "not inside a git repository" };
  }
  const before = await readRepositoryStatus(repoRoot, { homeDir, fs, now });
  const record = {
    action: cleanAction,
    repoRoot,
    startedAt: new Date(now()).toISOString(),
  };
  const { unpagedRoot, runDir } = pathsFor(homeDir);
  await writeAtomicJson(unpagedRoot, runDir, join(runDir, `${runKeyForRepo(repoRoot)}.json`), record, {
    fs,
    pid,
  });
  const after = await readRepositoryStatus(repoRoot, { homeDir, fs, now });
  const prompt = actionPrompt(cleanAction, {
    repoName: before.repoName || basename(repoRoot),
    documentId: before.documentId,
  });
  return { ok: true, record, status: after, prompt };
}

export async function clearRunState(
  targetPath,
  {
    homeDir = homedir(),
    fs = { access, rm },
  } = {}
) {
  const repoRoot = await findRepositoryRoot(targetPath, fs);
  if (!repoRoot) {
    return { ok: false, error: "not inside a git repository" };
  }
  const { runDir } = pathsFor(homeDir);
  await fs.rm(join(runDir, `${runKeyForRepo(repoRoot)}.json`), { force: true });
  return { ok: true, repoRoot };
}

async function runCli() {
  const [verb, first, second] = process.argv.slice(2);
  switch (verb) {
    case "status": {
      const target = resolve(first || process.cwd());
      const status = await readRepositoryStatus(target);
      say(JSON.stringify(status, null, 2));
      return 0;
    }
    case "report": {
      const target = resolve(first || process.cwd());
      const raw = await readStdin();
      const result = await saveVerdictForRepo(target, raw);
      if (!result.ok) {
        process.stderr.write(`architecture.mjs report: ${result.error}\n`);
        return 1;
      }
      say(`reported ${result.verdict.state} ${result.verdict.documentId}`);
      return 0;
    }
    case "start-run": {
      const target = resolve(second || process.cwd());
      const result = await recordRunStart(target, first);
      if (!result.ok) {
        process.stderr.write(`architecture.mjs start-run: ${result.error}\n`);
        return 1;
      }
      say(`started ${result.record.action}`);
      return 0;
    }
    case "clear-run": {
      const target = resolve(first || process.cwd());
      const result = await clearRunState(target);
      if (!result.ok) {
        process.stderr.write(`architecture.mjs clear-run: ${result.error}\n`);
        return 1;
      }
      say("cleared");
      return 0;
    }
    default:
      process.stderr.write(
        "usage: architecture.mjs status [path] | report [path] | start-run <compare|update|create> [path] | clear-run [path]\n"
      );
      return 1;
  }
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`architecture.mjs: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
