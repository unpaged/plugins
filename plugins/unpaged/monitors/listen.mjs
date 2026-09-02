#!/usr/bin/env node
// UnPaged @agent comment listener for ONE board — run as a session Monitor.
//
//   node listen.mjs <documentId>
//
// Reads the per-board listener config that /unpaged:visual-plan (or
// /unpaged:listen) stored under ~/.claude/unpaged/listeners/, holds that
// board's /events WebSocket open, and prints each event frame as ONE line
// on stdout — Claude Code turns every line into a notification the model
// reacts to. No argument or no key file ⇒ exits silently. Nothing starts
// this script by itself: a session listens only to boards it armed
// (ruling 2026-09-02, option B). Reconnects with backoff on transient
// closes; stops on 4401 (key gone) and 4409 (a newer listener took over
// this board). Plain Node ≥ 22, no dependencies.

import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  KEY_DIR_RELATIVE,
  PROTOCOL_PREAMBLE,
  STATUS_DIR_RELATIVE,
  backoffMs,
  closePolicy,
  frameLine,
  isDocumentId,
  keyFileFor,
  monitorStatus,
  parseListenerConfig,
  retireKeyFile,
  shouldWriteStatus
} from "./listen-core.mjs";

const documentId = process.argv[2];
const keyDir = join(homedir(), KEY_DIR_RELATIVE);
const statusDir = join(homedir(), STATUS_DIR_RELATIVE);
/** Recorded in the status file so a command can re-run this very script in the foreground. */
const scriptPath = fileURLToPath(import.meta.url);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reportStatus(state, reason) {
  try {
    const statusFile = join(statusDir, `${documentId}.json`);
    await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 });
    let existing = null;
    try {
      existing = JSON.parse(await readFile(statusFile, "utf8"));
    } catch {
      existing = null;
    }
    // A displaced listener must not paint over the newer listener's
    // "connected" for the same board (see shouldWriteStatus); the write is
    // tmp + rename so a reader never sees a torn file. The remaining
    // read-then-rename window only matters while two listeners share a
    // board, and the displaced one never reports its 4409 at all.
    if (!shouldWriteStatus(existing, process.pid, state, isAlive)) return;
    const tmp = `${statusFile}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(monitorStatus(state, reason, scriptPath, documentId)),
      { mode: 0o600 }
    );
    await rename(tmp, statusFile);
  } catch {
    // Status is advisory; the socket does not depend on it.
  }
}

async function loadConfig(keyFile) {
  try {
    const config = parseListenerConfig(await readFile(keyFile, "utf8"));
    return config && config.documentId === documentId ? config : null;
  } catch {
    return null;
  }
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

let preambleSent = false;
function sayEvent(line) {
  if (!preambleSent) {
    preambleSent = true;
    say(PROTOCOL_PREAMBLE);
  }
  say(line);
}

function connectOnce(config) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(config.url, config.protocols);
    } catch {
      resolve({ code: 0, opened: false });
      return;
    }
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      void reportStatus("connected");
    });
    socket.addEventListener("message", (event) => {
      const line = frameLine(event.data);
      if (line) sayEvent(line);
    });
    socket.addEventListener("error", () => {
      // The close event follows; nothing to print for a transient error.
    });
    socket.addEventListener("close", (event) => {
      resolve({ code: event.code, opened });
    });
  });
}

async function main() {
  if (!isDocumentId(documentId)) {
    return; // Not a board — nothing to listen to. Stay silent.
  }
  const keyFile = keyFileFor(keyDir, documentId);
  const config = await loadConfig(keyFile);
  if (!config) {
    return; // Not armed for this board — /unpaged:listen arm <documentId>. Stay silent.
  }
  if (typeof WebSocket !== "function") {
    await reportStatus("stopped", "no-websocket");
    say("UnPaged listener needs Node 22 or newer (no WebSocket client) — push stays off on this machine.");
    return;
  }
  let attempt = 0;
  for (;;) {
    const { code, opened } = await connectOnce(config);
    const policy = closePolicy(code, documentId);
    if (policy.action === "stop") {
      if (policy.deleteKeyFile) {
        await retireKeyFile({ rename, readFile, rm, link }, keyFile, config);
      }
      // Superseded (4409): the newer listener owns this board's status file
      // from now on — this process writes nothing more to it.
      if (!policy.superseded) {
        await reportStatus("stopped", `close-${code}`);
      }
      say(policy.line);
      return;
    }
    await reportStatus("reconnecting", `close-${code}`);
    attempt = opened ? 0 : attempt + 1;
    await new Promise((wake) => setTimeout(wake, backoffMs(attempt)));
  }
}

main().catch(() => {
  // A crash here must not spam the session; the monitor simply ends.
});
