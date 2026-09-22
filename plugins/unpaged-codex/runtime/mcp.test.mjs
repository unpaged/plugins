import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHandler, nativeContext, serve } from "./mcp.mjs";
import { executeControl } from "./control.mjs";

const threadId = "11111111-1111-4111-8111-111111111111";
const meta = { threadId, "codex/sandbox-state-meta": { sandboxCwd: "file:///tmp/Review%20workspace" } };
const request = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });

async function ready(handler) {
  const init = await handler(request(1, "initialize", { protocolVersion: "2025-06-18" }));
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities.experimental, { "codex/sandbox-state-meta": {} });
  await handler({ jsonrpc: "2.0", method: "notifications/initialized" });
}

test("native context uses envelope task and local workspace metadata only", () => {
  assert.deepEqual(nativeContext(meta), { threadId, cwd: "/tmp/Review workspace" });
  for (const invalid of [undefined, {}, { ...meta, threadId: "another task" },
    { threadId, cwd: "/tmp" },
    ...["/tmp", "https://example.com/path", "file://foreign/tmp", "file:///tmp?q=x", "file:///tmp#fragment", "file:///tmp/%00"].map((sandboxCwd) =>
      ({ ...meta, "codex/sandbox-state-meta": { sandboxCwd } }))]) {
    assert.throws(() => nativeContext(invalid), /native_(task|workspace)_context_required/);
  }
});

test("handshake and fixed tool inventory precede operations; unsupported clients fail closed", async () => {
  let calls = 0;
  const handler = createHandler({ control: async () => { calls++; return {}; } });
  assert.equal((await handler(request(0, "tools/list"))).error.code, -32002);
  await ready(handler);
  const tools = (await handler(request(2, "tools/list"))).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["review"]);
  assert.equal(tools[0].inputSchema.additionalProperties, false);
  const output = await handler(request(3, "tools/call", { name: "review", arguments: { operation: "doctor" } }));
  assert.equal(output.result.isError, true);
  assert.equal(JSON.parse(output.result.content[0].text).error, "native_task_context_required");
  assert.equal(calls, 0);
  assert.equal((await handler(request(4, "shell", {}))).error.code, -32601);
  assert.equal((await handler(request(5, "initialize", { protocolVersion: "2025-06-18" }))).error.code, -32602);
});

test("native discovery supplies usable digest, arm and receipt guidance without a skill-file read", async () => {
  const handler = createHandler({ control: () => assert.fail("discovery must not execute") });
  const init = await handler(request(1, "initialize", { protocolVersion: "2025-11-25" }));
  const guide = init.result.instructions;
  assert.match(guide, /digest payload: \{document:/);
  assert.match(guide, /statusElementIds:\[/);
  assert.match(guide, /arm payload: \{keyId:<mint keyId>,key:<mint key>,pollUrl:<mint pollUrl>,planDigest:/);
  assert.match(guide, /require setupReady:true before minting/);
  assert.match(guide, /complete payload: \{operationToken:<from begin>,evidence:\{replyId:/);
  assert.match(guide, /acceptance alone never authorizes implementation/);
  assert.match(guide, /Never replay completed or uncertain effects/);
  await handler({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tool = (await handler(request(2, "tools/list"))).result.tools[0];
  assert.match(tool.description, /Native server instructions/);
  assert.equal(tool.inputSchema.properties.payload.properties.document.type, "object");
  assert.ok(Buffer.byteLength(JSON.stringify(tool.inputSchema)) < 4000);
});

test("unsupported Node versions keep discovery available and refuse every operation before native execution", async () => {
  for (const nodeVersion of ["18.20.8", "20.18.2", "22.13.1", "23.7.0"]) {
    const handler = createHandler({ nodeVersion, control: () => assert.fail("unsupported Node must not execute") });
    await ready(handler);
    const tool = (await handler(request(2, "tools/list"))).result.tools[0];
    assert.equal(tool.name, "review");
    for (const operation of tool.inputSchema.properties.operation.enum) {
      const output = await handler(request(3, "tools/call", { name: "review", _meta: meta, arguments: { operation } }));
      assert.equal(output.result.isError, true);
      const diagnosis = JSON.parse(output.result.content[0].text);
      assert.equal(diagnosis.error, "node_24_required");
      assert.match(diagnosis.action, /Node\.js 24 or newer/);
      assert.match(diagnosis.action, /environment used to launch Codex/);
    }
  }
});

test("unsupported Node stdio discovery never imports the unavailable native CLI dependency", async () => {
  const root = mkdtempSync(join(tmpdir(), "unpaged-mcp-node-"));
  let child;
  let timeout;
  try {
    // Deliberately omit cli.mjs and SQLite. The real stdio startup must not import
    // that dependency closure before returning the supported runtime diagnosis.
    for (const file of ["mcp.mjs", "control.mjs", "protocol.mjs", "process-identity.mjs"]) {
      copyFileSync(new URL(file, import.meta.url), join(root, file));
    }
    child = spawn(process.execPath, ["--input-type=module", "--eval",
      'Object.defineProperty(process.versions, "node", { value: "20.18.2" }); await (await import("./mcp.mjs")).serve();'],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.stdin.end([
      request(1, "initialize", { protocolVersion: "2025-11-25" }),
      { jsonrpc: "2.0", method: "notifications/initialized" }, request(2, "tools/list"),
      request(3, "tools/call", { name: "review", _meta: meta, arguments: { operation: "doctor" } })
    ].map((value) => JSON.stringify(value) + "\n").join(""));
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    assert.equal(code, 0, stderr);
    const replies = stdout.trim().split("\n").map(JSON.parse);
    assert.equal(replies[0].result.serverInfo.name, "unpaged_review");
    assert.equal(replies[1].result.tools[0].name, "review");
    assert.equal(replies[2].result.isError, true);
    assert.equal(JSON.parse(replies[2].result.content[0].text).error, "node_24_required");
    assert.equal(stderr, "");
  } finally {
    clearTimeout(timeout);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});

test("requests pass independent native context; errors do not echo payloads or raw diagnostics", async () => {
  const seen = [];
  const handler = createHandler({ env: { CODEX_HOME: "/tmp/test-profile" }, control: async (args, context, options) => {
    seen.push({ args, context, options });
    if (args.operation === "arm") throw new Error("Private state path /secret/account.db is blocked");
    return { setupReady: true };
  } });
  await ready(handler);
  const output = await handler(request(2, "tools/call", { name: "review", arguments: { operation: "doctor" }, _meta: meta }));
  assert.deepEqual(JSON.parse(output.result.content[0].text), { setupReady: true });
  assert.deepEqual(seen[0].context, { threadId, cwd: "/tmp/Review workspace" });
  assert.equal(seen[0].options.env.CODEX_HOME, "/tmp/test-profile");
  const secret = "a-private-listener-key";
  const failed = await handler(request(3, "tools/call", { name: "review", arguments: { operation: "arm", payload: { key: secret } }, _meta: meta }));
  assert.equal(failed.result.isError, true);
  assert.deepEqual(JSON.parse(failed.result.content[0].text), { error: "review_operation_failed" });
  assert.ok(!JSON.stringify(failed).includes(secret));
  assert.ok(!JSON.stringify(failed).includes("account.db"));
  await handler({ jsonrpc: "2.0", method: "tools/call", params: { name: "review", arguments: { operation: "stop" }, _meta: meta } });
  assert.equal(seen.length, 2, "notification cannot mutate");
});

test("stdio preserves chunked UTF-8, sequences operations and bounds malformed input", async () => {
  const replies = [];
  const output = new Writable({ write(chunk, _, done) { replies.push(chunk.toString()); done(); } });
  const seen = [];
  const encoded = Buffer.from(JSON.stringify(request(1, "example", { text: "Grăce" })) + "\n" + "not-json\n");
  const split = encoded.indexOf(Buffer.from("ă")) + 1;
  await serve({ input: Readable.from([encoded.subarray(0, split), encoded.subarray(split)]), output,
    handler: async (message) => { seen.push(message); return { jsonrpc: "2.0", id: message.id, result: {} }; } });
  assert.equal(seen[0].params.text, "Grăce");
  assert.equal(JSON.parse(replies[1]).error.code, -32700);
  await serve({ input: Readable.from([Buffer.from([0x22, 0xc3, 0x22, 0x0a])]), output,
    handler: () => assert.fail("invalid UTF-8 must not reach an operation") });
  assert.equal(JSON.parse(replies.at(-1)).error.code, -32700);
  await serve({ input: Readable.from([Buffer.alloc(2 * 1024 * 1024 + 256 * 1024 + 1, 65)]), output });
  assert.deepEqual(JSON.parse(replies.at(-1)), { jsonrpc: "2.0", id: null, error: { code: -32600, message: "input_too_large" } });
  await assert.rejects(serve({ input: Readable.from(["{"]), output }), /incomplete_message/);
});

test("oversized frames are discarded once through newline and later requests still run", async () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024 + 256 * 1024 + 1, 65);
  const following = Buffer.from("\n" + JSON.stringify(request(3, "tools/list")) + "\n");
  for (const chunks of [[Buffer.concat([oversized, following])],
    [oversized.subarray(0, 100), oversized.subarray(100), Buffer.from("more discarded bytes"), following]]) {
    const replies = [], seen = [];
    const output = new Writable({ write(chunk, _, done) { replies.push(JSON.parse(chunk.toString())); done(); } });
    await serve({ input: Readable.from(chunks), output, handler: async (message) => {
      seen.push(message); return { jsonrpc: "2.0", id: message.id, result: { tools: [] } };
    } });
    assert.deepEqual(seen, [{ jsonrpc: "2.0", id: 3, method: "tools/list" }]);
    assert.deepEqual(replies, [
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "input_too_large" } },
      { jsonrpc: "2.0", id: 3, result: { tools: [] } }
    ]);
  }
});

test("bounded envelope overhead lets the payload limit return a correlated tool error without executing", async () => {
  let executions = 0;
  const handler = createHandler({ control: (args, context, options) => executeControl(args, context,
    { ...options, executeCli: async () => { executions++; return {}; } }) });
  await ready(handler);
  const oversized = request(2, "tools/call", { name: "review", _meta: meta,
    arguments: { operation: "digest", payload: { document: { title: "private".repeat(300000) } } } });
  const replies = [];
  const output = new Writable({ write(chunk, _, done) { replies.push(JSON.parse(chunk.toString())); done(); } });
  await serve({ input: Readable.from([JSON.stringify(oversized) + "\n" + JSON.stringify(request(3, "tools/list")) + "\n"]), output, handler });
  assert.equal(executions, 0);
  assert.equal(replies[0].id, 2);
  assert.equal(replies[0].result.isError, true);
  assert.deepEqual(JSON.parse(replies[0].result.content[0].text), { error: "input_too_large" });
  assert.equal(JSON.stringify(replies).includes("private"), false);
  assert.equal(replies[1].id, 3);
  assert.equal(replies[1].result.tools[0].name, "review");
});

test("the packaged stdio process negotiates and exits cleanly on EOF without a task or native state", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./mcp.mjs", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"], shell: false
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.stdin.end([
    request(1, "initialize", { protocolVersion: "2025-11-25" }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    request(2, "tools/list"),
    request(3, "tools/call", { name: "review", arguments: { operation: "doctor" } }),
    request(4, "tools/call", { name: "review", _meta: meta,
      arguments: { operation: "digest", payload: { document: { title: "x".repeat(2 * 1024 * 1024) } } } }),
    request(5, "tools/call", { name: "review", _meta: meta,
      arguments: { operation: "digest", payload: { document: { title: "x".repeat(3 * 1024 * 1024) } } } }),
    request(6, "tools/list")
  ].map((value) => JSON.stringify(value) + "\n").join(""));
  const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  clearTimeout(timeout);
  assert.equal(code, 0, stderr);
  const replies = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(replies[1].result.tools[0].name, "review");
  assert.equal(JSON.parse(replies[2].result.content[0].text).error, "native_task_context_required");
  assert.equal(replies[3].id, 4);
  assert.equal(JSON.parse(replies[3].result.content[0].text).error, "input_too_large");
  assert.deepEqual(replies[4], { jsonrpc: "2.0", id: null, error: { code: -32600, message: "input_too_large" } });
  assert.equal(replies[5].id, 6);
  assert.equal(replies[5].result.tools[0].name, "review");
  assert.doesNotMatch(stderr, /unpaged_review_transport_failed/);
});
