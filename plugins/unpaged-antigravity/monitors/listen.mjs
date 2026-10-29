#!/usr/bin/env node
// Receive one board's @agent comments through short authenticated HTTP polls.
// In Antigravity, running with `--once` polls quietly in the background until
// at least one new unseen event arrives (or a terminal status ends the key),
// prints the preamble + event line(s), persists cursor and seen IDs for the
// next run, and exits 0 so Antigravity wakes the session immediately.
// The listener never starts itself, mints keys, or changes a board.

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  KEY_DIR_RELATIVE, STATUS_DIR_RELATIVE, isDocumentId, keyFileFor, monitorStatus, parseListenerConfig, retireKeyFile
} from "./listen-core.mjs";
import { validCursor } from "./poll-core.mjs";
import { pollInbox } from "./poll.mjs";
import { DEDUPE_LIMIT, LOCAL_SUPERSEDED, runListener as runLoop } from "./listen-loop.mjs";
import { acquireMonitorOwnership } from "./ownership.mjs";

export { DEDUPE_LIMIT };

const scriptPath = fileURLToPath(import.meta.url);

export function parseListenArgs(argv = []) {
  let once = false;
  let documentId;
  for (const arg of argv) {
    if (arg === "--once") once = true;
    else if (documentId === undefined) documentId = arg;
    else return { documentId: null, once: false };
  }
  return { documentId, once };
}

function hashConfig(config) {
  return createHash("sha256").update(`${config.pollUrl}\n${config.key}`).digest("hex");
}

function wait(ms, signal) {
  return new Promise((resolveWait) => {
    if (signal?.aborted) { resolveWait(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolveWait(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const stdoutLine = (line) => new Promise((resolveWrite, reject) => {
  process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolveWrite());
});

// Injectable boundaries keep transport, cadence and stdout behavior testable
// without credentials, a live board, or a session. `fetch`, `sleep`
// and `say` default to Node's; a caller may inject `poll` whole instead.
export function runListener(config, options = {}) {
  const poll = options.poll ?? ((binding, settings) => pollInbox(binding, { ...settings, fetch: options.fetch }));
  return runLoop(config, { sleep: wait, say: stdoutLine, ...options, poll });
}

export async function runMonitor(documentId, options = {}) {
  if (!isDocumentId(documentId)) return { reason: "not-armed" };
  const home = options.home ?? homedir();
  const keyFile = keyFileFor(join(home, KEY_DIR_RELATIVE), documentId);
  let config;
  try { config = parseListenerConfig(await readFile(keyFile, "utf8")); } catch { return { reason: "not-armed" }; }
  if (!config || config.documentId !== documentId) return { reason: "not-armed" };
  if (Number((options.nodeVersion ?? process.versions.node).split(".")[0]) < 22 ||
      typeof (options.fetch ?? globalThis.fetch) !== "function") return { reason: "unsupported-node" };
  const statusFile = join(home, STATUS_DIR_RELATIVE, `${documentId}.json`);
  let configHash = hashConfig(config);
  const reportStatus = async (state, reason, metadata) => {
    try {
      await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 });
      const tmp = `${statusFile}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...monitorStatus(state, reason, scriptPath, documentId, process.pid),
        transport: "poll-v1", ownerId: ownership?.ownerId, configHash, ...metadata }), { mode: 0o600 });
      await rename(tmp, statusFile);
    } catch { /* Advisory state never prints credential-bearing diagnostics. */ }
  };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const onTakeover = () => controller.abort(LOCAL_SUPERSEDED);
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let ownership;
  try {
    ownership = await (options.acquireOwnership ?? acquireMonitorOwnership)({
      home, documentId, signal: controller.signal, onTakeover
    });
    if (!ownership) return { reason: "ownership-unavailable" };
    // A new key may have been stored while the previous monitor drained.
    // Always start the receiver for the latest still-armed config.
    try { config = parseListenerConfig(await readFile(keyFile, "utf8")); } catch { return { reason: "not-armed" }; }
    if (!config || config.documentId !== documentId) return { reason: "not-armed" };
    configHash = hashConfig(config);
    let initialCursor = options.initialCursor;
    let initialSeen = options.initialSeen;
    let initialLastEventAt = options.initialLastEventAt;
    try {
      const prev = JSON.parse(await readFile(statusFile, "utf8"));
      if (prev && prev.documentId === documentId && prev.configHash === configHash) {
        if (initialCursor === undefined && validCursor(prev.cursor ?? null)) initialCursor = prev.cursor ?? null;
        if (initialSeen === undefined && Array.isArray(prev.seen)) initialSeen = prev.seen;
        if (initialLastEventAt === undefined && typeof prev.lastEventAt === "string" && Number.isFinite(Date.parse(prev.lastEventAt))) {
          initialLastEventAt = Date.parse(prev.lastEventAt);
        }
      }
    } catch { /* Missing or unreadable previous status starts fresh. */ }
    return await runListener(config, {
      ...options,
      initialCursor,
      initialSeen,
      initialLastEventAt,
      signal: controller.signal,
      reportStatus,
      retireKey: () => retireKeyFile({ rename, readFile, rm, link }, keyFile, config, process.pid)
    });
  } finally {
    // A replacement cannot obtain its kernel quorum until every old HTTP,
    // stdout and advisory-status operation has finished.
    await ownership?.release();
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export async function runCommand(documentId, options = {}) {
  const say = options.say ?? stdoutLine;
  let result;
  try { result = await runMonitor(documentId, options); }
  catch { result = { reason: "monitor-unavailable" }; }
  if (result.reason === "unsupported-node") {
    await say("Unpaged listener needs Node 22 or newer with an HTTP client — push stays off on this machine.");
  } else if (result.reason === "ownership-unavailable" && !options.signal?.aborted) {
    await say("Unpaged listener could not take ownership of this canvas's local monitor: another Monitor may still be draining, or too few local ports are usable. Push is off for this canvas on this machine. Check /unpaged:listen status and local port restrictions before retrying; do not mint another key.");
  } else if (result.reason === "monitor-unavailable" && !options.signal?.aborted) {
    await say("Unpaged listener could not start or continue safely. Check /unpaged:listen status; the stored listener key has not been replaced.");
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const { documentId, once } = parseListenArgs(process.argv.slice(2));
  runCommand(documentId, { once, signal: controller.signal }).catch(() => {
    // A monitor failure must not print remote response or credential material.
  }).finally(() => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  });
}
