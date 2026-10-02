#!/usr/bin/env node
// Listener key files for the Unpaged plugin — the ONE script the commands
// call for every key-file step, so no inline `node -e` ever runs:
//
//   node keys.mjs check <documentId>          armed <keyId> | missing   (+ host <name>)
//   node keys.mjs hook                         PostToolUse hook on agent_listener_key_create:
//                                              stores the mint from stdin, tells the model
//   node keys.mjs store <documentId>           fallback: raw mint JSON on stdin → stored <keyId>
//   node keys.mjs list                         one row per key file (never the key)
//   node keys.mjs alive <documentId>           monitor:connected|<state>|unverified|dead|absent
//                                              (a mod-v1 status file counts as connected while
//                                              its last successful poll is under three minutes old)
//   node keys.mjs forget <documentId>|all      remove key files (server revoke already done)
//   node keys.mjs retire <documentId> [keyId]  after HTTP 401 or a stop: retire the file only if it
//                                              still holds the key that was rejected or revoked —
//                                              matched on the loaded config given as JSON on stdin
//                                              (the Monitor's own rule), or on the keyId when no
//                                              config is given → removed|kept-newer|superseded|
//                                              absent|unmatched (nothing to match on: kept)
//   node keys.mjs status <documentId>          the in-session listener's status JSON on stdin →
//                                              written tmp + rename, mode 600, like the Monitor's
//
// Prints no key material on any path. Files: ~/.claude/unpaged/listeners/
// <documentId>.json, mode 600, written tmp + rename. Plain Node ≥ 22.

import { link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import {
  KEY_DIR_RELATIVE,
  LEGACY_KEY_FILE_RELATIVE,
  STATUS_DIR_RELATIVE,
  boardRow,
  extractMint,
  hookStoredContext,
  isDocumentId,
  isUnpagedListenerUrl,
  keyFileFor,
  listenerConfigFromMint,
  monitorLine,
  parseListenerConfig,
  printableKeyId,
  retireKeyFile
} from "./listen-core.mjs";
import { probeMonitorOwnership } from "./ownership.mjs";

const home = homedir();
const keyDir = join(home, KEY_DIR_RELATIVE);
const statusDir = join(home, STATUS_DIR_RELATIVE);
const legacyKeyFile = join(home, LEGACY_KEY_FILE_RELATIVE);

function say(line) {
  process.stdout.write(`${line}\n`);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

/** The v1 single-key file is moved aside, never deleted; the server refuses v1 keys anyway. */
async function retireLegacyFile() {
  try {
    await rename(legacyKeyFile, `${legacyKeyFile}.retired-v1`);
  } catch {
    // Absent, or already retired.
  }
}

async function loadConfig(documentId) {
  const keyFile = keyFileFor(keyDir, documentId);
  if (!keyFile) return null;
  try {
    const config = parseListenerConfig(await readFile(keyFile, "utf8"));
    // Same gate listen.mjs applies at load: a file naming an endpoint that
    // is not TLS to an Unpaged host is not armed, whoever wrote it.
    return config && config.documentId === documentId && isUnpagedListenerUrl(config.pollUrl)
      ? config
      : null;
  } catch {
    return null;
  }
}

/** tmp (mode 600) + rename, so a reader never sees a torn or world-readable file. */
async function storeConfig(config) {
  await mkdir(join(home, ".claude", "unpaged"), { recursive: true, mode: 0o700 });
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const keyFile = keyFileFor(keyDir, config.documentId);
  const tmp = `${keyFile}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, keyFile);
  return keyFile;
}

async function check(documentId) {
  const host = `host ${hostname().split(".")[0]}`;
  if (!isDocumentId(documentId)) {
    say("missing");
    say(host);
    say("error not a document id");
    return;
  }
  await retireLegacyFile();
  const config = await loadConfig(documentId);
  say(config ? `armed ${printableKeyId(config.keyId)}`.trimEnd() : "missing");
  say(host);
}

async function storeFromStdin(documentId, asHook) {
  const raw = await readStdin();
  let input = raw;
  try {
    input = JSON.parse(raw);
  } catch {
    input = raw;
  }
  const mint = extractMint(input);
  if (!mint) {
    // A hook fires on every result of the mint tool, refusals included:
    // nothing to store, nothing to say.
    if (!asHook) say("error no mint result on stdin");
    return asHook ? 0 : 1;
  }
  const cwd =
    asHook && input && typeof input === "object" && typeof input.cwd === "string"
      ? input.cwd
      : process.cwd();
  const config = listenerConfigFromMint(mint, { cwd, createdAt: new Date().toISOString() });
  if (!config) {
    if (asHook) {
      process.stderr.write("Unpaged listener key hook: the mint result is not a valid listener config (it must name an Unpaged HTTPS polling endpoint); nothing was stored. Push is off for this canvas.\n");
      return 2;
    }
    say("error mint result is not a valid listener config (it must name an Unpaged HTTPS polling endpoint)");
    return 1;
  }
  // The board the caller asked for is the only board this mint may arm:
  // the `store` verb takes it as an argument, the hook reads it from the
  // tool call that produced the result — and fails closed when the call
  // carries none, so a payload without tool_input can never arm anything.
  const expected = asHook
    ? input && typeof input === "object" && input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input.documentId
      : undefined
    : documentId;
  if (asHook && typeof expected !== "string") {
    process.stderr.write("Unpaged listener key hook: the tool call carries no documentId, so the mint cannot be matched to a canvas; nothing was stored.\n");
    return 2;
  }
  if (typeof expected === "string" && config.documentId !== expected) {
    if (asHook) {
      process.stderr.write(`Unpaged listener key hook: the mint names canvas ${config.documentId} but the tool was called for ${expected}; nothing was stored. Push is off for this canvas.\n`);
      return 2;
    }
    say(`error mint is for canvas ${config.documentId}, not ${documentId}`);
    return 1;
  }
  try {
    await storeConfig(config);
  } catch (error) {
    const reason = error && error.message ? error.message : String(error);
    if (asHook) {
      process.stderr.write(`Unpaged listener key hook could not write ~/${KEY_DIR_RELATIVE}/${config.documentId}.json (${reason}); store the mint with \`keys.mjs store ${config.documentId}\` (mint JSON on stdin).\n`);
      return 2;
    }
    say(`error ${reason}`);
    return 1;
  }
  if (asHook) {
    say(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: hookStoredContext(config)
        }
      })
    );
  } else {
    say(`stored ${printableKeyId(config.keyId)}`.trimEnd());
  }
  return 0;
}

async function list() {
  const rows = [];
  let names = [];
  try {
    names = await readdir(keyDir);
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const documentId = name.slice(0, -".json".length);
    const config = await loadConfig(documentId);
    if (config) rows.push(boardRow(config, process.cwd()));
  }
  say(rows.length ? rows.join("\n") : "none");
}

/** A poll at most this old proves the in-session listener still runs (it polls every 30–60 s). */
export const MOD_STATUS_FRESH_MS = 3 * 60 * 1000;

/** The in-session listener's status line, from the file the mod writes (transport mod-v1). */
export function modMonitorLine(status, documentId, now) {
  if (!status || status.documentId !== documentId || typeof status.sessionId !== "string" || !status.sessionId) {
    return "monitor:unverified";
  }
  const lastPoll = status.lastSuccessfulPollAt;
  const fresh = typeof lastPoll === "string" && Number.isFinite(Date.parse(lastPoll)) &&
    new Date(lastPoll).toISOString() === lastPoll && now - Date.parse(lastPoll) < MOD_STATUS_FRESH_MS;
  if (status.state === "connected") return fresh ? "monitor:connected" : "monitor:unverified";
  return `monitor:${typeof status.state === "string" && status.state ? status.state : "unknown"}`;
}

async function alive(documentId) {
  if (!isDocumentId(documentId)) {
    say("monitor:absent");
    return;
  }
  try {
    const status = JSON.parse(await readFile(join(statusDir, `${documentId}.json`), "utf8"));
    if (status && status.transport === "mod-v1") {
      // The listener inside Claude Code has no process to probe and no port
      // owner: its word is good while its last successful poll is recent.
      say(modMonitorLine(status, documentId, Date.now()));
      return;
    }
    if (!status || !Number.isSafeInteger(status.pid) || status.pid <= 0) {
      say("monitor:absent");
      return;
    }
    const owner = await probeMonitorOwnership({ home, documentId });
    // A saved PID can belong to another process after restart. Only the live
    // capability owner can substantiate this polling monitor's status file.
    if (!owner || typeof owner.ownerId !== "string" || owner.pid !== status.pid || owner.ownerId !== status.ownerId ||
      status.documentId !== documentId || status.transport !== "poll-v1") {
      say(owner || isAlive(status.pid) ? "monitor:unverified" : "monitor:dead");
      return;
    }
    const lastPoll = status.lastSuccessfulPollAt;
    if (status.state === "connected" && (typeof lastPoll !== "string" || !Number.isFinite(Date.parse(lastPoll)) ||
      new Date(lastPoll).toISOString() !== lastPoll)) {
      say("monitor:unverified");
      return;
    }
    say(monitorLine(status, () => true));
  } catch {
    say("monitor:absent");
  }
}

async function forget(target) {
  let names = [];
  try {
    names = await readdir(keyDir);
  } catch {
    names = [];
  }
  let count = 0;
  for (const name of names) {
    const wanted =
      target === "all"
        ? name.endsWith(".json") || name.includes(".json.")
        : name === `${target}.json` || name.startsWith(`${target}.json.`);
    if (!wanted) continue;
    await rm(join(keyDir, name), { force: true });
    count += 1;
  }
  if (target === "all") {
    for (const suffix of ["", ".retired-v1"]) {
      await rm(`${legacyKeyFile}${suffix}`, { force: true });
    }
  }
  say(`forgotten ${count}`);
}

/**
 * After HTTP 401 or a stop, the mod's counterpart of the Monitor's own
 * retirement: the file goes only if it still holds the key that was
 * rejected or revoked, through the same race-safe helper. The key to match
 * comes as the loaded config on stdin (so a file that stores no keyId is
 * matched the way the Monitor matches it), or as a keyId on the command
 * line when the caller has no config left. With nothing to match on the
 * file is kept and the outcome says so.
 */
async function retire(documentId, keyId) {
  const keyFile = keyFileFor(keyDir, documentId);
  if (!keyFile) {
    say("absent");
    return;
  }
  const current = await loadConfig(documentId);
  if (!current) {
    say("absent");
    return;
  }
  const raw = process.stdin.isTTY ? "" : await readStdin();
  let loaded = raw.trim() ? parseListenerConfig(raw) : null;
  if (!loaded && typeof keyId === "string" && keyId) {
    if (current.keyId !== keyId) {
      say("kept-newer");
      return;
    }
    loaded = current;
  }
  if (!loaded || loaded.documentId !== documentId) {
    say("unmatched");
    return;
  }
  say(await retireKeyFile({ rename, readFile, rm, link }, keyFile, loaded));
}

/** The in-session listener's status file, written as the Monitor writes its own: tmp + rename, mode 600. */
async function status(documentId) {
  const raw = process.stdin.isTTY ? "" : await readStdin();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.documentId !== documentId) {
    say("refused");
    return;
  }
  await mkdir(statusDir, { recursive: true, mode: 0o700 });
  const file = join(statusDir, `${documentId}.json`);
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...value, pid: 0, transport: "mod-v1", updatedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(tmp, file);
  say("written");
}

async function main() {
  const [verb, first, second] = process.argv.slice(2);
  switch (verb) {
    case "check":
      await check(first);
      return 0;
    case "hook":
      return storeFromStdin(null, true);
    case "store":
      return storeFromStdin(first, false);
    case "list":
      await list();
      return 0;
    case "alive":
      await alive(first);
      return 0;
    case "retire":
      if (!isDocumentId(first)) {
        say("absent");
        return 0;
      }
      await retire(first, second);
      return 0;
    case "status":
      if (!isDocumentId(first)) {
        say("refused");
        return 0;
      }
      await status(first);
      return 0;
    case "forget":
      if (first !== "all" && !isDocumentId(first)) {
        say("forgotten 0");
        return 0;
      }
      await forget(first);
      return 0;
    default:
      say("usage: keys.mjs check <documentId> | hook | store <documentId> | list | alive <documentId> | forget <documentId>|all");
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`keys.mjs: ${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
