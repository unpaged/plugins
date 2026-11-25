#!/usr/bin/env node
// Antigravity SessionStart hook for the Unpaged Architecture plugin.
// Completely silent ({}) outside git repositories, when no pointer exists,
// when the canvas is current or unchecked on this machine, or during an active
// run. Emits one zero-token user-only banner + side-panel pill ONLY when the
// architecture canvas is behind, stale (> 90 days), or unreachable (lost).
// Never touches network, never throws non-zero, and never blocks session start.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { formatAttentionMarkdown } from "./architecture-core.mjs";
import { findRepositoryRoot, readRepositoryStatus } from "./architecture.mjs";

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

function normalizeCandidatePath(entry) {
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  return trimmed;
}

export async function buildSessionStartOutput(
  input,
  {
    homeDir = homedir(),
    now = () => Date.now(),
    findRoot = findRepositoryRoot,
    readStatus = (repoRoot) => readRepositoryStatus(repoRoot, { homeDir, now }),
  } = {}
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const candidates = [];
  if (Array.isArray(input.workspacePaths)) {
    for (const entry of input.workspacePaths) {
      const clean = normalizeCandidatePath(entry);
      if (clean) candidates.push(clean);
    }
  }
  const cwd = normalizeCandidatePath(input.cwd);
  if (cwd) candidates.push(cwd);

  if (candidates.length === 0) return {};

  const seenRoots = new Set();
  const statuses = [];

  for (const candidate of candidates) {
    try {
      const root = await findRoot(candidate);
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      const status = await readStatus(root);
      if (status) statuses.push(status);
    } catch {
      // Fail open on any unreadable workspace path.
    }
  }

  const markdown = formatAttentionMarkdown(statuses, now());
  if (!markdown) return {};

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: "",
          metadata: {
            user_markdown: markdown,
          },
        },
      },
    ],
  };
}

async function main() {
  try {
    const raw = process.stdin.isTTY ? "" : await readStdin();
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    const out = await buildSessionStartOutput(parsed);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    process.stdout.write("{}\n");
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
  main();
}
