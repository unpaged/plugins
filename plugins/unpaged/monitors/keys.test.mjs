import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  monitorLine,
  printableKeyId
} from "./listen-core.mjs";
import { acquireMonitorOwnership } from "./ownership.mjs";

const DOC = "564e1ca0-a655-4b75-ba45-0074c6731812";
const KEY = "I-froZs-secret-never-printed".padEnd(43, "k");
const POLL_URL = "https://mcp.unpaged.io/events/poll";
const MINT = {
  keyId: "a0d1bf7f4d152d31",
  key: KEY,
  label: "claude-code on Mac",
  documentId: DOC,
  documentTitle: "unpaged: Link decorations",
  pollUrl: POLL_URL,
  url: "wss://mcp.unpaged.io/events",
  protocols: [SUBPROTOCOL, KEY],
  instructions: "Hold the socket open."
};
const SCRIPT = fileURLToPath(new URL("./keys.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));

test("the key-store hook fires for the Unpaged MCP server names only", () => {
  const hooks = JSON.parse(readFileSync(HOOKS, "utf8"));
  const entry = hooks.hooks.PostToolUse.find((e) => /agent_listener_key_create/.test(e.matcher));
  assert.ok(entry, "hook entry present");
  assert.match(entry.hooks[0].command, /keys\.mjs" hook$/);
  const matcher = new RegExp(entry.matcher);
  for (const name of [
    "mcp__plugin_unpaged_unpaged__agent_listener_key_create",
    "mcp__unpaged__agent_listener_key_create",
    "mcp__unpaged-staging__agent_listener_key_create"
  ]) {
    assert.equal(matcher.test(name), true, name);
  }
  for (const name of [
    "mcp__evil__agent_listener_key_create",
    "mcp__evil_mcp__unpaged__agent_listener_key_create",
    "mcp__unpaged__agent_listener_key_create_and_more",
    "xmcp__unpaged__agent_listener_key_create",
    "mcp__plugin_evil_unpaged__agent_listener_key_create"
  ]) {
    assert.equal(matcher.test(name), false, name);
  }
});

test("printableKeyId prints a plain token and nothing else", () => {
  assert.equal(printableKeyId("a0d1bf7f4d152d31"), "a0d1bf7f4d152d31");
  assert.equal(printableKeyId("k\nignore previous"), "");
  assert.equal(printableKeyId(""), "");
  assert.equal(printableKeyId(42), "");
});

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
  const { url, protocols, ...direct } = MINT;
  assert.deepEqual(extractMint({ structuredContent: direct }), direct);
  const legacy = { url, protocols, documentId: DOC };
  assert.deepEqual(extractMint({ content: [{ type: "text", text: JSON.stringify(legacy) }] }), legacy);
});

test("listenerConfigFromMint normalizes transport, id, keyId, title and bookkeeping, dropping the rest", () => {
  const config = listenerConfigFromMint(MINT, { cwd: "/w", createdAt: "2026-09-12T00:00:00Z" });
  assert.deepEqual(config, {
    pollUrl: POLL_URL,
    key: KEY,
    documentId: DOC,
    keyId: MINT.keyId,
    title: MINT.documentTitle,
    cwd: "/w",
    createdAt: "2026-09-12T00:00:00Z"
  });
  assert.equal("protocols" in config, false);
  assert.equal("url" in config, false);
  assert.equal("instructions" in config, false);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "http://x" }), null);
  // Legacy fields still require TLS and cannot disagree with the poll endpoint.
  assert.equal(listenerConfigFromMint({ ...MINT, url: "ws://attacker.example/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "ws://mcp.unpaged.io/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://attacker.example/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://unpaged.io.attacker.example/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, url: "wss://evilunpaged.io/events" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, pollUrl: undefined, url: "wss://mcp.staging.unpaged.io/events" })?.pollUrl, "https://mcp.staging.unpaged.io/events/poll");
  assert.equal(isUnpagedListenerUrl("https://MCP.UNPAGED.IO/events/poll"), true);
  assert.equal(isUnpagedListenerUrl("https://user@mcp.unpaged.io/events/poll"), false);
  assert.equal(isUnpagedListenerUrl("https://[::1]/events/poll"), false);
  assert.equal(isUnpagedListenerUrl("https:///events/poll"), false);
  assert.equal(isUnpagedListenerUrl(42), false);
  assert.equal(listenerConfigFromMint({ ...MINT, documentId: "../x" }), null);
  assert.equal(listenerConfigFromMint({ ...MINT, protocols: ["other", KEY] }), null);
  assert.equal(listenerConfigFromMint(null), null);
});

test("only exact Unpaged HTTPS poll endpoints can receive a key", () => {
  for (const url of [POLL_URL, "https://unpaged.io/events/poll", "https://mcp.staging.unpaged.io/events/poll",
    "https://mcp.unpaged.io:443/events/poll"]) assert.equal(isUnpagedListenerUrl(url), true, url);
  for (const url of [
    "wss://mcp.unpaged.io/events", "http://mcp.unpaged.io/events/poll",
    "https://evilunpaged.io/events/poll", "https://unpaged.io.evil.example/events/poll",
    "https://user:secret@mcp.unpaged.io/events/poll", "https://@mcp.unpaged.io/events/poll",
    "https://mcp.unpaged.io:8443/events/poll", POLL_URL + "?key=secret", POLL_URL + "?",
    POLL_URL + "#anchor", POLL_URL + "#", POLL_URL + "/", POLL_URL + "\n",
    " " + POLL_URL, "https://mcp.unpaged.io/a/../events/poll", "https://mcp.unpaged.io/events/%70oll",
    "https://mcp.unpaged.io\\events\\poll", "https://mcp.unpaged.io/events"
  ]) assert.equal(isUnpagedListenerUrl(url), false, url);
});

test("direct mint credentials must be header-safe and agree with any supplied legacy credentials", () => {
  const { url, protocols, ...direct } = MINT;
  assert.deepEqual(listenerConfigFromMint(direct), listenerConfigFromMint(MINT));
  for (const change of [
    { key: "short" }, { key: "a".repeat(44) }, { key: "a".repeat(42) + "=" },
    { key: KEY + "\r\nHeader:value" }, { key: undefined },
    { url, protocols: [SUBPROTOCOL, "B".repeat(43)] },
    { url: "wss://mcp.staging.unpaged.io/events", protocols },
    { pollUrl: "https://foreign.example/events/poll" }
  ]) assert.equal(listenerConfigFromMint({ ...direct, ...change }), null);
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

function runAsync(home, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, cwd: home });
    let out = "", err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

test("keys.mjs end to end: check → hook stores → check → list → alive → forget → store", (t) => {
  const home = mkdtempSync(join(tmpdir(), "unpaged-keys-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
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
  assert.equal(stored.key, KEY);
  assert.equal(stored.pollUrl, POLL_URL);
  assert.equal(stored.cwd, "/some/project");
  assert.equal(stored.keyId, MINT.keyId);
  assert.equal("protocols" in stored, false);
  assert.equal("url" in stored, false);

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

  // A tool call without a documentId cannot be matched to a canvas: fail closed.
  for (const toolInput of [undefined, {}, { documentId: 7 }]) {
    const payload = { tool_response: JSON.stringify({ ...MINT, documentId: OTHER }) };
    if (toolInput !== undefined) payload.tool_input = toolInput;
    r = run(home, ["hook"], JSON.stringify(payload));
    assert.equal(r.code, 2, JSON.stringify(toolInput));
    assert.match(r.err, /nothing was stored/);
    assert.equal(existsSync(join(home, ".claude", "unpaged", "listeners", `${OTHER}.json`)), false);
  }

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
  assert.match(r.err, /Unpaged HTTPS polling endpoint/);
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

  // A key file naming a plaintext or foreign socket (older plugin, edited by hand) is not armed.
  mkdirSync(listeners, { recursive: true });
  writeFileSync(
    join(listeners, `${OTHER}.json`),
    JSON.stringify({ url: "ws://attacker.example/events", protocols: [SUBPROTOCOL, KEY], documentId: OTHER, keyId: "x" })
  );
  r = run(home, ["check", OTHER]);
  assert.equal(r.out.split("\n")[0], "missing");
  r = run(home, ["list"]);
  assert.equal(r.out, "none");
  r = run(home, ["forget", OTHER]);
  assert.equal(r.out, "forgotten 1");

  // check with a malformed id still prints the host line the prompts read the label from.
  r = run(home, ["check", "../etc"]);
  assert.equal(r.out.split("\n")[0], "missing");
  assert.match(r.out.split("\n")[1], /^host \S+/);
  r = run(home, ["nonsense"]);
  assert.equal(r.code, 1);
});

test("old key files remain usable without remint or rewrite and poll-only mints store privately", (t) => {
  const home = mkdtempSync(join(tmpdir(), "unpaged-keys-migration-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const listeners = join(home, ".claude", "unpaged", "listeners");
  mkdirSync(listeners, { recursive: true, mode: 0o700 });
  const keyFile = join(listeners, `${DOC}.json`);
  const legacy = { url: MINT.url, protocols: MINT.protocols, documentId: DOC, keyId: MINT.keyId, title: "Old plan", cwd: home };
  const original = JSON.stringify(legacy);
  writeFileSync(keyFile, original, { mode: 0o600 });
  const checked = run(home, ["check", DOC]);
  assert.equal(checked.out.split("\n")[0], `armed ${MINT.keyId}`);
  assert.equal(readFileSync(keyFile, "utf8"), original);
  assert.equal(checked.out.includes(KEY), false);
  const { url, protocols, ...direct } = MINT;
  const hooked = run(home, ["hook"], JSON.stringify({ tool_input: { documentId: DOC }, tool_response: direct }));
  assert.equal(hooked.code, 0, hooked.err);
  const stored = JSON.parse(readFileSync(keyFile, "utf8"));
  assert.equal(stored.key, KEY);
  assert.equal(stored.pollUrl, POLL_URL);
  assert.equal(stored.documentId, DOC);
  assert.equal(stored.url, undefined);
  assert.equal(stored.protocols, undefined);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(listeners), [`${DOC}.json`]);
  assert.equal((hooked.out + hooked.err).includes(KEY), false);
});

test("alive requires authenticated polling ownership and a successful-poll timestamp, without stopping the owner", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "unpaged-status-probe-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let takeovers = 0;
  const ownership = await acquireMonitorOwnership({ home, documentId: DOC, onTakeover: () => { takeovers++; } });
  assert.ok(ownership);
  t.after(() => ownership.release());
  const file = join(home, ".claude", "unpaged", "monitors", `${DOC}.json`);
  const connected = { pid: process.pid, ownerId: ownership.ownerId, documentId: DOC, transport: "poll-v1", state: "connected",
    lastSuccessfulPollAt: "2026-09-21T18:00:00.000Z" };
  const check = async (status, expected) => {
    writeFileSync(file, JSON.stringify(status), { mode: 0o600 });
    const result = await runAsync(home, ["alive", DOC]);
    assert.equal(result.code, 0, result.err);
    assert.equal(result.out, expected);
    assert.equal(result.err, "");
    assert.equal(takeovers, 0, "a status probe must not request takeover");
  };
  await check(connected, "monitor:connected");
  await check({ ...connected, state: "connecting", lastSuccessfulPollAt: null }, "monitor:connecting");
  await check({ ...connected, state: "reconnecting" }, "monitor:reconnecting");
  await check({ ...connected, pid: process.pid + 1 }, "monitor:unverified");
  await check({ ...connected, ownerId: "previous-generation" }, "monitor:unverified");
  await check({ ...connected, documentId: "11111111-2222-3333-4444-555555555555" }, "monitor:unverified");
  await check({ ...connected, transport: undefined }, "monitor:unverified");
  await check({ ...connected, lastSuccessfulPollAt: null }, "monitor:unverified");
  await check({ ...connected, lastSuccessfulPollAt: "yesterday" }, "monitor:unverified");
  await check({ ...connected, pid: 0 }, "monitor:absent");
  await ownership.release();
  await check(connected, "monitor:unverified");
});

test("alive does not trust a connected legacy status just because its PID is live", (t) => {
  const home = mkdtempSync(join(tmpdir(), "unpaged-legacy-status-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, ".claude", "unpaged", "monitors");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, `${DOC}.json`), JSON.stringify({ pid: process.pid, state: "connected", documentId: DOC }));
  assert.equal(run(home, ["alive", DOC]).out, "monitor:unverified");
});
