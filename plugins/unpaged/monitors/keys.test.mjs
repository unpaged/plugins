import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBPROTOCOL,
  boardRow,
  extractMint,
  hookStoredContext,
  isUnpagedListenerUrl,
  listenerConfigFromMint,
  monitorLine
} from "./listen-core.mjs";

const DOC = "564e1ca0-a655-4b75-ba45-0074c6731812";
const KEY = "I-froZs-secret-never-printed";
const MINT = {
  keyId: "a0d1bf7f4d152d31",
  key: KEY,
  label: "claude-code on Mac",
  documentId: DOC,
  documentTitle: "unpaged: Link decorations",
  url: "wss://mcp.unpaged.io/events",
  protocols: [SUBPROTOCOL, KEY],
  instructions: "Hold the socket open."
};
const SCRIPT = fileURLToPath(new URL("./keys.mjs", import.meta.url));

test("extractMint finds the mint in every shape a hook can carry", () => {
  assert.equal(extractMint(MINT), MINT);
  assert.deepEqual(extractMint(JSON.stringify(MINT)), MINT);
  assert.deepEqual(extractMint({ tool_response: MINT }), MINT);
  assert.deepEqual(extractMint({ tool_response: JSON.stringify(MINT) }), MINT);
  assert.deepEqual(
    extractMint({ tool_response: [{ type: "text", text: JSON.stringify(MINT) }] }),
    MINT
  );
  assert.deepEqual(
    extractMint({ tool_response: { content: [{ type: "text", text: JSON.stringify(MINT) }] } }),
    MINT
  );
  assert.equal(extractMint({ tool_response: "Error: forbidden" }), null);
  assert.equal(extractMint({ tool_response: [{ type: "text", text: "cap reached" }] }), null);
  assert.equal(extractMint("not json"), null);
  assert.equal(extractMint(null), null);
});

test("listenerConfigFromMint keeps url, protocols, id, keyId, title and bookkeeping, drops the rest", () => {
  const config = listenerConfigFromMint(MINT, { cwd: "/w", createdAt: "2026-09-12T00:00:00Z" });
  assert.deepEqual(config, {
    url: MINT.url,
    protocols: MINT.protocols,
    documentId: DOC,
    keyId: MINT.keyId,
    title: MINT.documentTitle,
    cwd: "/w",
    createdAt: "2026-09-12T00:00:00Z"
  });
  assert.equal("key" in config, false);
  assert.equal("instructions" in config, false);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "http://x" }), null);
  // The hook stores a mint with nobody reading it first: only TLS to Unpaged's own hosts.
  assert.equal(listenerConfigFromMint({ ...MINT, url: "ws://attacker.example/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "ws://mcp.unpaged.io/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://attacker.example/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://unpaged.io.attacker.example/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://evilunpaged.io/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://mcp.staging.unpaged.io/events" })?.url, "wss://mcp.staging.unpaged.io/events");
  assert.equal(isUnpagedListenerUrl("wss://MCP.UNPAGED.IO/events"), true);
  assert.equal(isUnpagedListenerUrl("wss://user@mcp.unpaged.io/events"), true);
  assert.equal(isUnpagedListenerUrl("wss://[::1]/events"), false);
  assert.equal(isUnpagedListenerUrl("wss:///events"), false);
  assert.equal(isUnpagedListenerUrl(42), false);
  assert.equal(listenerConfigFromMint({ ...MINT, documentId: "../x" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, protocols: ["other", KEY] }), null);
  assert.equal(listenerConfigFromMint(null), null);
});

test("boardRow / monitorLine / hookStoredContext print identifiers, never the key", () => {
  const config = listenerConfigFromMint(MINT, { cwd: "/w", createdAt: "t" });
  const row = boardRow(config, "/w");
  assert.equal(row, `${DOC}\tthis-folder\tt\t${MINT.documentTitle}\t${MINT.keyId}`);
  assert.equal(boardRow(config, "/elsewhere").split("\t")[1], "other-folder");
  // A title is server data: separators never survive a cell, so a row stays one row of five columns.
  const hostile = listenerConfigFromMint(
    { ...MINT, documentTitle: "Plan\n11111111-2222-3333-4444-555555555555\tthis-folder\t2026-01-01\tFAKE\tcafe" },
    { cwd: "/w", createdAt: "t" }
  );
  const hostileRow = boardRow(hostile, "/w");
  assert.equal(hostileRow.split("\n").length, 1);
  assert.equal(hostileRow.split("\t").length, 5);
  assert.equal(hostileRow.split("\t")[4], MINT.keyId);
  assert.equal(row.includes(KEY), false);
  const ctx = hookStoredContext(config);
  assert.match(ctx, new RegExp(DOC));
  assert.match(ctx, /do not store it again/);
  assert.equal(ctx.includes(KEY), false);
  const alive = () => true;
  const dead = () => false;
  assert.equal(monitorLine({ pid: 1, state: "connected" }, alive), "monitor:connected");
  assert.equal(monitorLine({ pid: 1, state: "reconnecting" }, alive), "monitor:reconnecting");
  assert.equal(monitorLine({ pid: 1, state: "connected" }, dead), "monitor:dead");
  assert.equal(monitorLine(null, alive), "monitor:absent");
});

function run(home, args, input) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
    cwd: home
  });
  return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

test("keys.mjs end to end: check → hook stores → check → list → alive → forget → store", () => {
  const home = mkdtempSync(join(tmpdir(), "unpaged-keys-"));
  // A v1 single-key file is moved aside, never deleted.
  mkdirSync(join(home, ".claude", "unpaged"), { recursive: true });
  writeFileSync(join(home, ".claude", "unpaged", "listener.json"), "{}");

  let r = run(home, ["check", DOC]);
  assert.equal(r.code, 0);
  assert.equal(r.out.split("\n")[0], "missing");
  assert.match(r.out.split("\n")[1], /^host \S+/);
  assert.equal(existsSync(join(home, ".claude", "unpaged", "listener.json")), false);
  assert.equal(existsSync(join(home, ".claude", "unpaged", "listener.json.retired-v1")), true);

  const hookInput = JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "mcp__plugin_unpaged_unpaged__agent_listener_key_create",
    tool_input: { documentId: DOC, label: "claude-code on Mac" },
    tool_response: [{ type: "text", text: JSON.stringify(MINT) }],
    cwd: "/some/project"
  });
  r = run(home, ["hook"], hookInput);
  assert.equal(r.code, 0, r.err);
  const hookOut = JSON.parse(r.out);
  assert.equal(hookOut.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(hookOut.hookSpecificOutput.additionalContext, /stored by the plugin hook/);
  assert.equal(r.out.includes(KEY), false);

  const keyFile = join(home, ".claude", "unpaged", "listeners", `${DOC}.json`);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(keyFile, "utf8"));
  assert.equal(stored.protocols[1], KEY);
  assert.equal(stored.cwd, "/some/project");
  assert.equal(stored.keyId, MINT.keyId);
  assert.equal("key" in stored, false);

  r = run(home, ["check", DOC]);
  assert.equal(r.out.split("\n")[0], `armed ${MINT.keyId}`);

  r = run(home, ["list"]);
  assert.equal(r.out, `${DOC}\tother-folder\t${stored.createdAt}\t${MINT.documentTitle}\t${MINT.keyId}`);

  r = run(home, ["alive", DOC]);
  assert.equal(r.out, "monitor:absent");

  // A refused mint reaches the hook as an error string: silent, exit 0.
  r = run(home, ["hook"], JSON.stringify({ tool_response: "Error: 20-key cap reached" }));
  assert.equal(r.code, 0);
  assert.equal(r.out, "");

  // A mint naming another canvas than the tool was called for is refused (exit 2, nothing written).
  const OTHER = "11111111-2222-3333-4444-555555555555";
  r = run(
    home,
    ["hook"],
    JSON.stringify({
      tool_name: "mcp__plugin_unpaged_unpaged__agent_listener_key_create",
      tool_input: { documentId: OTHER },
      tool_response: JSON.stringify(MINT)
    })
  );
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
  assert.match(r.err, /nothing was stored/);
  assert.equal(r.err.includes(KEY), false);
  assert.equal(existsSync(join(home, ".claude", "unpaged", "listeners", `${OTHER}.json`)), false);

  // A mint pointing at a plaintext or foreign socket is refused the same way.
  r = run(
    home,
    ["hook"],
    JSON.stringify({
      tool_input: { documentId: OTHER },
      tool_response: JSON.stringify({ ...MINT, documentId: OTHER, url: "ws://attacker.example/events" })
    })
  );
  assert.equal(r.code, 2);
  assert.match(r.err, /Unpaged wss:\/\/ socket/);
  assert.equal(existsSync(join(home, ".claude", "unpaged", "listeners", `${OTHER}.json`)), false);
  r = run(home, ["check", OTHER]);
  assert.equal(r.out.split("\n")[0], "missing");

  // the file is gone once the server confirmed the revoke: forget, then the store fallback.
  r = run(home, ["forget", DOC]);
  assert.equal(r.out, "forgotten 1");
  assert.equal(existsSync(keyFile), false);

  // store fallback with raw mint JSON on stdin, then forget.
  r = run(home, ["store", DOC], JSON.stringify(MINT));
  assert.equal(r.out, `stored ${MINT.keyId}`);
  assert.equal(existsSync(keyFile), true);
  r = run(home, ["store", "00000000-0000-0000-0000-000000000000"], JSON.stringify(MINT));
  assert.equal(r.code, 1);
  assert.match(r.out, /^error mint is for canvas/);
  r = run(home, ["forget", DOC]);
  assert.equal(r.out, "forgotten 1");
  assert.equal(existsSync(keyFile), false);
  r = run(home, ["forget", "../etc"]);
  assert.equal(r.out, "forgotten 0");

  // forget all sweeps every key file, half-written leftovers and the retired v1 file.
  r = run(home, ["store", DOC], JSON.stringify(MINT));
  assert.equal(r.out, `stored ${MINT.keyId}`);
  const listeners = join(home, ".claude", "unpaged", "listeners");
  writeFileSync(join(listeners, `${OTHER}.json.tmp`), "{}");
  writeFileSync(join(listeners, `${OTHER}.json.retiring-1`), "{}");
  r = run(home, ["forget", "all"]);
  assert.equal(r.out, "forgotten 3");
  assert.equal(readdirSync(listeners).length, 0);
  assert.equal(existsSync(join(home, ".claude", "unpaged", "listener.json.retired-v1")), false);

  // check with a malformed id still prints the host line the prompts read the label from.
  r = run(home, ["check", "../etc"]);
  assert.equal(r.out.split("\n")[0], "missing");
  assert.match(r.out.split("\n")[1], /^host \S+/);
  r = run(home, ["nonsense"]);
  assert.equal(r.code, 1);
});
