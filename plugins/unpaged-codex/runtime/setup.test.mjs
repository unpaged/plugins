import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { inspectSetup, queryHookInventory } from "./setup.mjs";

const cwd = "/tmp/exact-task-folder";
const pluginRoot = "/tmp/plugins/unpaged-codex/current";
const codexPath = "/tmp/verified-native-codex";
const SECRET = "private unrelated plugin credential";
const hook = (changes = {}) => ({
  key: "unpaged-codex@personal:hooks/hooks.json:session_start:0:0", eventName: "sessionStart",
  handlerType: "command", source: "plugin", pluginId: "unpaged-codex@personal", enabled: true,
  trustStatus: "trusted", currentHash: `sha256:${"a".repeat(64)}`, async: false, isManaged: false,
  sourcePath: `${pluginRoot}/hooks/hooks.json`, command: `node "${pluginRoot}/runtime/cli.mjs" session-start`,
  matcher: "startup|resume|compact", timeoutSec: 30, displayOrder: 0, ...changes
});
const inventory = (hooks = [hook()], changes = {}) => ({ data: [{ cwd, hooks, errors: [], warnings: [], ...changes }] });
const inspect = (value) => inspectSetup({ codexPath, cwd, pluginRoot, query: async () => value });

function processFixture(onMessage, { ignoreTerm = false, ignoreKill = false } = {}) {
  const child = new EventEmitter();
  child.pid = 123456;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const messages = []; const signals = []; const calls = [];
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(chunk.toString()); messages.push(message);
    queueMicrotask(() => onMessage?.(message, child)); callback();
  } });
  child.kill = (signal) => {
    signals.push(signal);
    if (!(signal === "SIGTERM" ? ignoreTerm : ignoreKill)) {
      child.emit("exit", null, signal); child.emit("close", null, signal);
    }
    return true;
  };
  child.unref = () => {};
  const spawn = (...args) => { calls.push(args); return child; };
  return { child, messages, signals, calls, spawn };
}

function reply(child, id, result) { child.stdout.write(`${JSON.stringify({ id, result })}\n`); }
const options = (fixture, extra = {}) => ({ codexPath, cwd, spawn: fixture.spawn, timeoutMs: 100,
  shutdownTimeoutMs: 5, ...extra });

test("setup reports only current trusted and enabled lifecycle hook as ready", async () => {
  const result = await inspect(inventory());
  assert.equal(result.setupReady, true); assert.equal(result.status, "ready");
  assert.match(result.action, /separate verification/);
  assert.equal(result.evidenceScope, "native_hook_inventory");
  assert.match(result.evidenceLimit, /does not verify/);
  for (const trustStatus of ["untrusted", "modified"]) {
    const result = await inspect(inventory([hook({ trustStatus })]));
    assert.match(result.action, /Settings → Hooks → From Plugins → Unpaged for Codex/);
    assert.match(result.action, /review the SessionStart row and click Trust/);
  }
  for (const [changes, status] of [
    [{ trustStatus: "untrusted" }, "untrusted"], [{ trustStatus: "modified" }, "modified"],
    [{ enabled: false }, "disabled"], [{ enabled: false, trustStatus: "modified" }, "disabled"],
    [{ trustStatus: "managed" }, "unknown"], [{ trustStatus: SECRET }, "unknown"],
    [{ currentHash: SECRET }, "unknown"], [{ enabled: "true" }, "unknown"]
  ]) {
    const result = await inspect(inventory([hook(changes)]));
    assert.equal(result.status, status); assert.equal(result.setupReady, false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
});

test("missing, unrelated, stale, ambiguous, or changed hooks cannot approve current setup", async () => {
  assert.equal((await inspect(inventory([]))).status, "missing");
  const unrelated = hook({ pluginId: `other-plugin@${SECRET}`, command: SECRET, statusMessage: SECRET });
  assert.equal((await inspect(inventory([unrelated]))).status, "missing");
  const mixed = await inspect(inventory([unrelated, hook()]));
  assert.equal(mixed.setupReady, true); assert.equal(JSON.stringify(mixed).includes(SECRET), false);
  for (const changes of [
    { command: 'node "/tmp/plugins/unpaged-codex/stale/runtime/cli.mjs" session-start' },
    { matcher: "startup|resume" }, { matcher: ".*" }, { command: `${hook().command}; ${SECRET}` },
    { handlerType: "prompt" }, { async: true }
  ]) {
    const result = await inspect(inventory([hook(changes)]));
    assert.equal(result.status, "unknown"); assert.equal(result.setupReady, false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  assert.equal((await inspect(inventory([hook(), hook()]))).reason, "ambiguous_hook");
});

test("current source is selected before comparing copies from other marketplaces", async () => {
  const otherMarketplace = hook({ pluginId: "unpaged-codex@other-marketplace",
    sourcePath: "/tmp/plugins/other-marketplace/unpaged-codex/hooks/hooks.json",
    command: 'node "/tmp/plugins/other-marketplace/unpaged-codex/runtime/cli.mjs" session-start' });
  for (const hooks of [[hook(), otherMarketplace], [otherMarketplace, hook()]]) {
    assert.equal((await inspect(inventory(hooks))).setupReady, true);
  }
  const staleOnly = await inspect(inventory([otherMarketplace]));
  assert.equal(staleOnly.setupReady, false);
  assert.equal(staleOnly.status, "missing");
  assert.equal(staleOnly.reason, "hook_missing");
  const duplicateSource = hook({ pluginId: "unpaged-codex@other-marketplace" });
  assert.equal((await inspect(inventory([hook(), duplicateSource]))).reason, "ambiguous_hook");
});

test("setup requires inventory for exact cwd and never echoes loading errors or arbitrary response fields", async () => {
  for (const value of [null, [], {}, { data: [] }, inventory([], { cwd: "/tmp/other" }),
    { data: [...inventory().data, ...inventory().data] }, inventory([], { errors: null })]) {
    const result = await inspect(value);
    assert.equal(result.setupReady, false); assert.equal(result.status, "unknown");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  const result = await inspectSetup({ codexPath, cwd, pluginRoot, query: async () => { throw new Error(SECRET); } });
  assert.equal(result.status, "query_failed"); assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test("folder-wide load warnings and errors keep setup blocked with configuration guidance", async () => {
  for (const changes of [
    { errors: [{ path: "/tmp/unrelated-plugin/hooks.json", message: SECRET }] },
    { warnings: [SECRET] },
    { warnings: [`${SECRET} /tmp/unrelated-plugin/hooks.json`] }
  ]) {
    const result = await inspect(inventory([hook()], changes));
    assert.equal(result.setupReady, false);
    assert.equal(result.status, "configuration_problem");
    assert.equal(result.reason, "folder_hook_configuration_problem");
    assert.match(result.action, /this folder/);
    assert.match(result.action, /configuration errors or warnings/);
    assert.doesNotMatch(result.action, /Unpaged|Trust/);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes("unrelated-plugin"), false);
  }
});

test("native inventory query uses exactly initialize, initialized and hooks/list, then terminates its process", async () => {
  const fixture = processFixture((message, child) => {
    if (message.method === "initialize") reply(child, 0, { userAgent: "codex-test" });
    if (message.method === "hooks/list") {
      child.stdout.write(`${JSON.stringify({ method: "notification", params: { text: SECRET } })}\n`);
      const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: inventory([hook({ statusMessage: "✅" })]) })}\n`);
      for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
    }
  });
  const env = { PATH: "/tmp/native-path" };
  const result = await inspectSetup({ ...options(fixture), pluginRoot, env });
  assert.equal(result.setupReady, true); assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(fixture.messages.map((message) => message.method), ["initialize", "initialized", "hooks/list"]);
  assert.deepEqual(fixture.messages[2].params, { cwds: [cwd] });
  assert.deepEqual(fixture.calls, [[codexPath, ["app-server", "--stdio"], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] }]]);
  assert.deepEqual(fixture.signals, ["SIGTERM"]);
});

test("unsupported native method is distinct and raw RPC diagnostics stay private", async () => {
  const fixture = processFixture((message, child) => {
    if (message.method === "initialize") reply(child, 0, {});
    if (message.method === "hooks/list") child.stdout.write(`${JSON.stringify({ id: 1, error: { code: -32601, message: SECRET } })}\n`);
  });
  const result = await inspectSetup({ ...options(fixture), pluginRoot });
  assert.equal(result.status, "unsupported"); assert.equal(result.setupReady, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false); assert.deepEqual(fixture.signals, ["SIGTERM"]);
});

test("timeout escalates termination only for the owned process and never reports readiness", async () => {
  const fixture = processFixture(null, { ignoreTerm: true });
  const result = await inspectSetup({ ...options(fixture, { timeoutMs: 5 }), pluginRoot });
  assert.equal(result.status, "query_failed"); assert.equal(result.reason, "timeout");
  assert.deepEqual(fixture.signals, ["SIGTERM", "SIGKILL"]);
});

test("malformed, out-of-order and incomplete native responses fail closed with cleanup", async () => {
  for (const payload of [SECRET, "[]", '{"id":1,"result":{}}', '{"id":0,"result":{},"error":{}}',
    '{"id":0,"result":null}', '{"id":0,"error":{"code":-1,"message":"private"}}',
    Buffer.from([123, 34, 255, 34, 58, 49, 125])]) {
    const fixture = processFixture((_message, child) => child.stdout.write(Buffer.concat([Buffer.from(payload), Buffer.from("\n")])));
    const result = await inspectSetup({ ...options(fixture), pluginRoot });
    assert.equal(result.status, "query_failed"); assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.deepEqual(fixture.signals, ["SIGTERM"]);
  }
  const fixture = processFixture((_message, child) => {
    child.stdout.write('{"id":0'); child.emit("exit", 1); child.emit("close", 1);
  });
  const result = await inspectSetup({ ...options(fixture), pluginRoot });
  assert.equal(result.reason, "early_exit");
});

test("native SQLite startup failure gets constant guidance without exposing paths or diagnostics", async () => {
  const diagnostic = `Error: failed to initialize sqlite state runtime under /private/${SECRET}: readonly database\n`;
  for (const afterExit of [false, true]) {
    const fixture = processFixture((_message, child) => {
      if (afterExit) child.emit("exit", 1);
      // Real stderr can split the marker across chunks or drain after process exit.
      for (const byte of Buffer.from(diagnostic)) child.stderr.write(Buffer.from([byte]));
      if (!afterExit) child.emit("exit", 1);
      child.emit("close", 1);
    });
    const result = await inspectSetup({ ...options(fixture), pluginRoot });
    assert.equal(result.setupReady, false);
    assert.equal(result.status, "query_failed");
    assert.equal(result.reason, "native_state_initialization_failed");
    assert.match(result.action, /native approval/);
    assert.match(result.action, /directories.*database files/);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes("readonly database"), false);
    assert.deepEqual(fixture.signals, []);
  }
});

test("unrelated stderr and stdout cannot claim a native SQLite startup failure", async () => {
  for (const diagnostic of [SECRET, "readonly database", "failed to initialize sqlite", "failed to initialize other runtime"]) {
    const fixture = processFixture((_message, child) => {
      child.stderr.write(diagnostic); child.emit("exit", 1); child.emit("close", 1);
    });
    const result = await inspectSetup({ ...options(fixture), pluginRoot });
    assert.equal(result.reason, "early_exit");
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  const fixture = processFixture((message, child) => {
    if (message.method === "initialize") {
      child.stderr.write(SECRET);
      child.stdout.write(`${JSON.stringify({ method: "notification", params: { text: "failed to initialize sqlite state runtime under /private" } })}\n`);
      reply(child, 0, {});
    }
    if (message.method === "hooks/list") reply(child, 1, inventory());
  });
  const result = await inspectSetup({ ...options(fixture), pluginRoot });
  assert.equal(result.setupReady, true);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(fixture.signals, ["SIGTERM"]);
});

test("native startup diagnostic scanning preserves the shared output limit and cleanup", async () => {
  const fixture = processFixture((_message, child) => {
    child.stderr.write("failed to initialize sqlite state runtime under ");
    child.stderr.write(SECRET.repeat(10));
  });
  const result = await inspectSetup({ ...options(fixture, { maxOutputBytes: 64 }), pluginRoot });
  assert.equal(result.setupReady, false);
  assert.equal(result.reason, "output_limit");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(fixture.signals, ["SIGTERM"]);
});

test("an exited native child with open inherited pipes remains deadline-bounded", async () => {
  const fixture = processFixture((_message, child) => child.emit("exit", 1));
  const result = await inspectSetup({ ...options(fixture, { timeoutMs: 5 }), pluginRoot });
  assert.equal(result.setupReady, false);
  assert.equal(result.reason, "timeout");
  assert.deepEqual(fixture.signals, []);
  for (const stream of ["stdin", "stdout", "stderr"]) assert.equal(fixture.child[stream].destroyed, true);
});

test("the deadline preserves a native SQLite diagnosis when the child exits without close or hangs", async () => {
  for (const exited of [true, false]) {
    const fixture = processFixture((_message, child) => {
      child.stderr.write(`failed to initialize sqlite state runtime under /private/${SECRET}: readonly database`);
      if (exited) child.emit("exit", 1);
    });
    const result = await inspectSetup({ ...options(fixture, { timeoutMs: 5 }), pluginRoot });
    assert.equal(result.setupReady, false);
    assert.equal(result.status, "query_failed");
    assert.equal(result.reason, "native_state_initialization_failed");
    assert.match(result.action, /native approval/);
    assert.match(result.action, /directories.*database files/);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    assert.equal(JSON.stringify(result).includes("readonly database"), false);
    assert.deepEqual(fixture.signals, exited ? [] : ["SIGTERM"]);
    for (const stream of ["stdin", "stdout", "stderr"]) assert.equal(fixture.child[stream].destroyed, true);
  }
});

test("unconfirmed cleanup takes precedence over a diagnosed native SQLite failure", async () => {
  const fixture = processFixture((_message, child) => {
    child.stderr.write(`failed to initialize sqlite state runtime under /private/${SECRET}`);
  }, { ignoreTerm: true, ignoreKill: true });
  const result = await inspectSetup({ ...options(fixture, { timeoutMs: 5 }), pluginRoot });
  assert.equal(result.setupReady, false);
  assert.equal(result.reason, "cleanup_unconfirmed");
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.deepEqual(fixture.signals, ["SIGTERM", "SIGKILL"]);
  for (const stream of ["stdin", "stdout", "stderr"]) assert.equal(fixture.child[stream].destroyed, true);
});

test("stdout and stderr share a raw byte budget including unterminated lines", async () => {
  for (const stream of ["stdout", "stderr"]) {
    const fixture = processFixture((_message, child) => child[stream].write("é".repeat(33)));
    const result = await inspectSetup({ ...options(fixture, { maxOutputBytes: 64 }), pluginRoot });
    assert.equal(result.reason, "output_limit"); assert.deepEqual(fixture.signals, ["SIGTERM"]);
  }
  const fixture = processFixture((_message, child) => { child.stderr.write("x".repeat(32)); child.stdout.write("x".repeat(33)); });
  assert.equal((await inspectSetup({ ...options(fixture, { maxOutputBytes: 64 }), pluginRoot })).reason, "output_limit");
});

test("spawn errors, stream failures and unconfirmed cleanup cannot produce readiness or leak details", async () => {
  const failed = await inspectSetup({ codexPath, cwd, pluginRoot, spawn: () => { throw new Error(SECRET); } });
  assert.equal(failed.reason, "process_error"); assert.equal(JSON.stringify(failed).includes(SECRET), false);
  const fixture = processFixture((_message, child) => child.emit("error", new Error(SECRET)));
  assert.equal((await inspectSetup({ ...options(fixture), pluginRoot })).reason, "process_error");
  assert.deepEqual(fixture.signals, ["SIGTERM"]);
  for (const stream of ["stdin", "stdout", "stderr"]) {
    const fixture = processFixture((_message, child) => child[stream].emit("error", new Error(SECRET)));
    const result = await inspectSetup({ ...options(fixture), pluginRoot });
    assert.equal(result.reason, stream === "stdin" ? "write_failed" : "read_failed");
    assert.deepEqual(fixture.signals, ["SIGTERM"]);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  }
  const notStarted = processFixture((_message, child) => { child.pid = undefined; child.emit("error", new Error(SECRET)); });
  assert.equal((await inspectSetup({ ...options(notStarted), pluginRoot })).reason, "process_error");
  assert.deepEqual(notStarted.signals, []);
  const stuck = processFixture((message, child) => {
    if (message.method === "initialize") reply(child, 0, {});
    if (message.method === "hooks/list") reply(child, 1, inventory());
  }, { ignoreTerm: true, ignoreKill: true });
  assert.equal((await inspectSetup({ ...options(stuck), pluginRoot })).reason, "cleanup_unconfirmed");
  assert.deepEqual(stuck.signals, ["SIGTERM", "SIGKILL"]);
});

test("invalid paths or resource bounds fail without starting a native process", async () => {
  let spawned = false;
  const spawn = () => { spawned = true; throw new Error("should not spawn"); };
  for (const changes of [{ codexPath: "codex" }, { cwd: "relative" }, { timeoutMs: 0 }, { maxOutputBytes: Infinity },
    { shutdownTimeoutMs: 3000 }]) {
    await assert.rejects(queryHookInventory({ codexPath, cwd, spawn, ...changes }), { reason: "invalid_options" });
  }
  assert.equal((await inspectSetup({ codexPath, cwd, pluginRoot: "relative", spawn })).reason, "invalid_options");
  assert.equal(spawned, false);
});
