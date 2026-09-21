#!/usr/bin/env node
// Receive one board's @agent comments through short authenticated HTTP polls.
// Claude Code's session Monitor turns stdout lines into model notifications.
// The listener never starts itself, mints keys, or changes a board.

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  KEY_DIR_RELATIVE, PROTOCOL_PREAMBLE, STATUS_DIR_RELATIVE, closePolicy,
  isDocumentId, keyFileFor, monitorStatus, parseListenerConfig, rejectedKeyLine, retireKeyFile
} from "./listen-core.mjs";
import { pollInbox, POLL_TIMEOUT_MS } from "./poll.mjs";
import { acquireMonitorOwnership } from "./ownership.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export const DEDUPE_LIMIT = 4096;
const LOCAL_SUPERSEDED = "local-superseded";

function duration(value, fallback, maximum) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error("listener_configuration_invalid");
  return result;
}

function wait(ms, signal) {
  return new Promise((resolveWait) => {
    if (signal?.aborted) { resolveWait(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolveWait(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

// Injectable boundaries keep transport, cadence and stdout behavior testable
// without credentials, a live board, or a Claude session.
export async function runListener(config, options = {}) {
  const intervalMs = duration(options.pollIntervalMs, 30000, 60000);
  const idleIntervalMs = duration(options.idlePollIntervalMs, 60000, 60000);
  const idleAfterMs = duration(options.idleAfterMs, 3600000, 3600000);
  const retryBaseMs = duration(options.retryBaseMs, 30000, 60000);
  const maxRetryMs = duration(options.maxRetryMs, 60000, 60000);
  const timeoutMs = duration(options.requestTimeoutMs, POLL_TIMEOUT_MS, POLL_TIMEOUT_MS);
  const dedupeLimit = duration(options.dedupeLimit, DEDUPE_LIMIT, DEDUPE_LIMIT);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const say = options.say ?? ((line) => new Promise((resolveWrite, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolveWrite());
  }));
  const report = options.reportStatus ?? (async () => {});
  const signal = options.signal;
  const seen = new Set();
  let lastEventAt = now();
  let lastSuccessfulPollAt = null;
  let attempt = 0;
  let cursor = null;
  let preambleSent = false;
  const interval = () => now() - lastEventAt >= idleAfterMs ? idleIntervalMs : intervalMs;
  const reportStatus = async (state, reason) => {
    if (!signal?.aborted) await report(state, reason, { lastSuccessfulPollAt });
  };
  const finish = async () => {
    const reason = signal?.reason === LOCAL_SUPERSEDED ? LOCAL_SUPERSEDED : "shutdown";
    await report("stopped", reason, { lastSuccessfulPollAt });
    if (reason === LOCAL_SUPERSEDED) {
      await say("Another local Monitor requested this canvas's Unpaged listener, so this session stops listening. Leave the stored key in place; do not mint another key. Use /unpaged:listen status to check the replacement.");
    }
    return { reason };
  };
  if (signal?.aborted) return signal.reason === LOCAL_SUPERSEDED ? finish() : { reason: "shutdown" };
  await reportStatus("connecting");
  while (!signal?.aborted) {
    let result;
    try {
      result = await pollInbox(config, { fetch: options.fetch, signal, cursor, timeoutMs });
    } catch {
      if (signal?.aborted) break;
      await reportStatus("reconnecting", "poll-failed");
      await sleep(Math.min(maxRetryMs, Math.max(interval(), retryBaseMs * 2 ** Math.min(attempt++, 16))), signal);
      continue;
    }
    if (signal?.aborted) break;
    if (result.terminal) {
      const policy = closePolicy(result.terminal, config.documentId);
      let line = policy.line;
      if (policy.deleteKeyFile) {
        const outcome = await options.retireKey();
        line = rejectedKeyLine(outcome, config.documentId);
      }
      if (signal?.aborted) break;
      // A newer key's monitor owns this board's status. HTTP 409 never retires
      // credentials or writes a terminal status over that monitor.
      if (!policy.superseded) await reportStatus("stopped", `http-${result.terminal}`);
      if (!signal?.aborted && line) await say(line);
      return { reason: `http-${result.terminal}` };
    }
    lastSuccessfulPollAt = new Date(now()).toISOString();
    await reportStatus("connected");
    if (signal?.aborted) break;
    for (const event of result.events) {
      if (signal?.aborted) break;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (seen.size > dedupeLimit) seen.delete(seen.values().next().value);
      lastEventAt = now();
      if (!preambleSent) { preambleSent = true; await say(PROTOCOL_PREAMBLE); }
      if (!signal?.aborted) await say(JSON.stringify(event));
    }
    cursor = result.nextCursor;
    attempt = 0;
    await sleep(interval(), signal);
  }
  // The local ownership gate remains held until the final status and any
  // supersession notice drain. Ordinary external shutdown stays silent.
  return finish();
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
  const say = options.say ?? ((line) => new Promise((resolveWrite, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolveWrite());
  }));
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
