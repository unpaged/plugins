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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  KEY_FILE_RELATIVE,
  backoffMs,
  closePolicy,
  frameLine,
  parseListenerConfig
} from "./listen-core.mjs";

const keyFile = join(homedir(), KEY_FILE_RELATIVE);

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
    });
    socket.addEventListener("message", (event) => {
      const line = frameLine(event.data);
      if (line) say(line);
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
  if (typeof WebSocket !== "function") {
    say("UnPaged listener needs Node 22 or newer (no WebSocket client).");
    return;
  }
  const config = await loadConfig();
  if (!config) {
    return; // Not armed yet — /unpaged:visual-plan arms it.
  }
  let attempt = 0;
  for (;;) {
    const { code, opened } = await connectOnce(config);
    const policy = closePolicy(code);
    if (policy.action === "stop") {
      say(policy.line);
      return;
    }
    attempt = opened ? 0 : attempt + 1;
    await new Promise((wake) => setTimeout(wake, backoffMs(attempt)));
  }
}

main().catch(() => {
  // A crash here must not spam the session; the monitor simply ends.
});
