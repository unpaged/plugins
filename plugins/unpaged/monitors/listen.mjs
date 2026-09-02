#!/usr/bin/env node
// UnPaged @agent comment listener — a plugin background monitor.
//
// Reads the listener config that /unpaged:visual-plan (or /unpaged:listen)
// stored, holds the /events WebSocket open, and prints each event frame as
// ONE line on stdout — Claude Code turns every line into a notification the
// model reacts to. No key file ⇒ exits silently (nothing to do, and the
// session that minted the key holds its own socket via the Monitor tool).
// Reconnects with backoff on transient closes; stops on 4401 (key gone)
// and 4409 (a newer listener took over). Plain Node ≥ 22, no dependencies.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  KEY_FILE_RELATIVE,
  PROTOCOL_PREAMBLE,
  STATUS_FILE_RELATIVE,
  backoffMs,
  closePolicy,
  frameLine,
  monitorStatus,
  parseListenerConfig,
  retireKeyFile
} from "./listen-core.mjs";

const keyFile = join(homedir(), KEY_FILE_RELATIVE);
const statusFile = join(homedir(), STATUS_FILE_RELATIVE);

async function reportStatus(state, reason) {
  try {
    await mkdir(dirname(statusFile), { recursive: true, mode: 0o700 });
    await writeFile(statusFile, JSON.stringify(monitorStatus(state, reason)), { mode: 0o600 });
  } catch {
    // Status is advisory; the socket does not depend on it.
  }
}

async function loadConfig() {
  try {
    return parseListenerConfig(await readFile(keyFile, "utf8"));
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
  const config = await loadConfig();
  if (!config) {
    return; // Not armed yet — /unpaged:visual-plan arms it. Stay silent.
  }
  if (typeof WebSocket !== "function") {
    await reportStatus("stopped", "no-websocket");
    say("UnPaged listener needs Node 22 or newer (no WebSocket client) — push stays off on this machine.");
    return;
  }
  let attempt = 0;
  for (;;) {
    const { code, opened } = await connectOnce(config);
    const policy = closePolicy(code);
    if (policy.action === "stop") {
      if (policy.deleteKeyFile) {
        await retireKeyFile({ rename, readFile, rm }, keyFile, config);
      }
      await reportStatus("stopped", `close-${code}`);
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
