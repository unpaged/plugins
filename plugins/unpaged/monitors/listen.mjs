#!/usr/bin/env node
// Receive one board's @agent comments through short authenticated HTTP polls.
// Claude Code's session Monitor turns stdout lines into model notifications.
// The listener never starts itself, mints keys, or changes a board.
//
// The loop itself lives in listen-loop.mjs, shared with the plugin's Claude
// Code mod; this script is the Node host for it: fetch, stdout, timers, the
// key and status files, and the local ownership gate.

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  KEY_DIR_RELATIVE, STATUS_DIR_RELATIVE, isDocumentId, keyFileFor, monitorStatus, parseListenerConfig, retireKeyFile
} from "./listen-core.mjs";
import { pollInbox } from "./poll.mjs";
import { DEDUPE_LIMIT, LOCAL_SUPERSEDED, runListener as runLoop } from "./listen-loop.mjs";
import { acquireMonitorOwnership } from "./ownership.mjs";

export { DEDUPE_LIMIT };

const scriptPath = fileURLToPath(import.meta.url);

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
// without credentials, a live board, or a Claude session. `fetch`, `sleep`
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
  const reportStatus = async (state, reason, metadata) => {
    try {
      await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 });
      const tmp = `${statusFile}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(tmp, JSON.stringify({ ...monitorStatus(state, reason, scriptPath, documentId),
        transport: "poll-v1", ownerId: ownership?.ownerId, ...metadata }), { mode: 0o600 });
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
    return await runListener(config, { ...options, signal: controller.signal, reportStatus,
      retireKey: () => retireKeyFile({ rename, readFile, rm, link }, keyFile, config) });
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
  runCommand(process.argv[2], { signal: controller.signal }).catch(() => {
    // A monitor failure must not print remote response or credential material.
  }).finally(() => {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  });
}
