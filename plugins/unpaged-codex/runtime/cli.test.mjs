import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dataDirectory, executeCli, findCodex, parseArgs, planDigest } from "./cli.mjs";
import { Store } from "./store.mjs";
import { EVENTS_URL, SUBPROTOCOL } from "./protocol.mjs";

const DOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NODE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ELEMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const STATUS = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const OTHER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const DIGEST = "a".repeat(64);
const SECRET = "test-private-listener-credential";
const binding = { documentId: DOC, threadId: TASK, keyId: "key1", url: EVENTS_URL,
  protocols: [SUBPROTOCOL, SECRET], codexPath: process.execPath, planDigest: DIGEST, statusElementIds: [STATUS] };
const event = { id: "event1", documentId: DOC, nodeId: NODE, threadId: "comment-thread", commentId: "comment1",
  reason: "mention", authorRole: "owner", resolved: false, createdAt: new Date().toISOString() };
const input = (value) => Readable.from([JSON.stringify(value)]);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "unpaged-cli-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "reviews.sqlite"));
  t.after(() => store.close());
  return { directory, store, options: { env: { CODEX_THREAD_ID: TASK }, input: input({}) } };
}
function snapshot() {
  return { document: { id: DOC, title: "Plan", schemaVersion: 4, rootNodeId: NODE, nodeCount: 1,
    nodes: [{ id: NODE, title: "Review", content: "Goal", canvasWidth: 1000, canvasHeight: 800,
      parentNodeId: null, level: 0, elements: [
        { id: ELEMENT, elementType: "text", x: 1, properties: { text: "Review for 24 hours" }, revision: "old" },
        { id: STATUS, elementType: "text", properties: { text: "PROPOSED · version old" } }
      ] }] }, statusElementIds: [STATUS] };
}

test("argument paths are absolute and unknown options are refused", () => {
  assert.deepEqual(parseArgs(["status", DOC, "--data", "/tmp/data"]), { command: "status", positionals: [DOC], data: "/tmp/data" });
  assert.throws(() => parseArgs(["status", "--data", "relative"]), /absolute_option/);
  assert.throws(() => parseArgs(["arm", "--dangerously-bypass-hook-trust"]), /unknown_option/);
  assert.equal(dataDirectory({}, { CODEX_HOME: "/tmp/codex-custom" }), "/tmp/codex-custom/unpaged");
});

test("plan digest changes with content, hierarchy, canvas, root, and document schema", () => {
  const baseline = snapshot();
  const digest = planDigest(baseline);
  for (const change of [
    (x) => { x.document.nodes[0].elements[0].properties.text = "Review for 48 hours"; },
    (x) => { x.document.nodes[0].canvasWidth = 10; },
    (x) => { x.document.nodes[0].parentNodeId = OTHER; },
    (x) => { x.document.schemaVersion = 5; },
    (x) => { x.document.nodes.push({ id: OTHER, elements: [] }); x.document.nodeCount = 2; x.document.rootNodeId = OTHER; }
  ]) {
    const modified = structuredClone(baseline); change(modified);
    assert.notEqual(planDigest(modified), digest);
  }
});

test("digest ignores only volatile metadata and declared status, rejects incomplete/invalid snapshots", () => {
  const baseline = snapshot();
  const same = structuredClone(baseline);
  same.document.nodes[0].elements[0].revision = "new";
  same.document.nodes[0].updatedAt = "later";
  same.document.nodes[0].elementWriters = { something: "new" };
  same.document.nodes[0].elements[1].properties.text = "ACCEPTED · version latest";
  assert.equal(planDigest(same), planDigest(baseline));
  assert.throws(() => planDigest({ ...baseline, statusElementIds: [ELEMENT] }), /invalid_status/);
  assert.throws(() => planDigest({ ...baseline, statusElementIds: [OTHER] }), /invalid_document/);
  baseline.document.nodeCount = 2;
  assert.throws(() => planDigest(baseline), /partial_document/);
});

test("digest ignores new envelope metadata but preserves all domain content and arbitrary plugin properties", () => {
  const baseline = snapshot();
  const same = structuredClone(baseline);
  same.document.transportVersion = 2;
  same.document.nodes[0].serverReadAt = "later";
  same.document.nodes[0].elements[0].collaborationMetadata = { users: 2 };
  assert.equal(planDigest(same), planDigest(baseline));
  for (const change of [
    (x) => { x.document.nodes[0].content = "Changed goal"; },
    (x) => { x.document.nodes[0].backgroundColor = "#111111"; },
    (x) => { x.document.nodes[0].elements[0].linkTarget = OTHER; },
    (x) => { x.document.nodes[0].elements[0].locked = true; },
    (x) => { x.document.nodes[0].elements[0].zOrder = 2; },
    (x) => { x.document.nodes[0].elements[0].properties.futurePluginPayload = { text: "Meaningful content" }; }
  ]) {
    const modified = structuredClone(baseline); change(modified);
    assert.notEqual(planDigest(modified), planDigest(baseline));
  }
});

test("binary capability check uses absolute argv, enforces version, and exposes no command output", async () => {
  const calls = [];
  const execute = async (path, args, options) => {
    calls.push({ path, args, options });
    return { stdout: args[0] === "--version" ? "codex-cli 0.153.1" : "--thread ID --message MESSAGE" };
  };
  assert.ok(await findCodex(process.execPath, {}, execute));
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.options.shell === false));
  await assert.rejects(findCodex(process.execPath, {}, async () => ({ stdout: "codex-cli 0.144.1" })), /supported_codex_queue_not_found/);
});

test("arm persists binding then waits for connected worker without leaking or passing credentials as argv", async (t) => {
  const { directory, store } = fixture(t);
  let spawned;
  const fakeSpawn = (binary, args, options) => {
    spawned = { binary, args, options };
    const child = new EventEmitter(); child.unref = () => {};
    queueMicrotask(() => {
      const { token } = store.claimWorker(DOC, { pid: process.pid });
      store.setConnection(DOC, token, "connected");
      child.emit("spawn");
    });
    return child;
  };
  const result = await executeCli(["arm", "--data", directory, "--codex", process.execPath], {
    env: { CODEX_THREAD_ID: TASK }, input: input(binding), spawn: fakeSpawn,
    run: async (_path, args) => ({ stdout: args[0] === "--version" ? "codex-cli 0.153.1" : "--thread --message" })
  });
  assert.equal(result.connectionState, "connected");
  assert.equal(result.threadId, TASK);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.shell, false);
  assert.equal(JSON.stringify({ result, spawned }).includes(SECRET), false);
});

test("task binding protects begin and CLI completion follows the actual receipt contract", async (t) => {
  const { directory, store, options } = fixture(t);
  store.bind(binding);
  const { token } = store.claimWorker(DOC, { pid: process.pid });
  store.receive(DOC, event, token); store.markDispatching(DOC, event.id, token); store.markQueued(DOC, event.id, token, OTHER);
  await assert.rejects(executeCli(["begin", DOC, event.id, "--data", directory], { env: { CODEX_THREAD_ID: OTHER } }), /wrong_codex_task/);
  const started = await executeCli(["begin", DOC, event.id, "--data", directory], options);
  assert.ok(started.operationToken);
  const finished = await executeCli(["complete", DOC, event.id, "--data", directory], {
    ...options, input: input({ operationToken: started.operationToken, evidence: { replyId: "reply1", planDigest: DIGEST } })
  });
  assert.equal(finished.state, "completed");
  const status = await executeCli(["status", DOC, "--data", directory], options);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test("SessionStart ignores subagents/unrelated tasks and reports stopped cleanup without restarting", async (t) => {
  const { directory, store, options } = fixture(t);
  store.bind(binding); store.requestStop(DOC);
  const hook = { hook_event_name: "SessionStart", source: "resume", session_id: TASK };
  const noSpawn = () => assert.fail("must not start a stopped or unrelated review");
  assert.equal(await executeCli(["session-start", "--data", directory], {
    ...options, input: input({ ...hook, agent_id: "child" }), spawn: noSpawn
  }), null);
  assert.equal(await executeCli(["session-start", "--data", directory], {
    ...options, env: { CODEX_THREAD_ID: OTHER }, input: input({ ...hook, session_id: OTHER }), spawn: noSpawn
  }), null);
  const report = await executeCli(["session-start", "--data", directory], { ...options, input: input(hook), spawn: noSpawn });
  assert.ok(report.hookSpecificOutput.additionalContext.includes("cleanupRequired"));
  assert.equal(JSON.stringify(report).includes(SECRET), false);
});

test("plugin packages only native SessionStart repair and has no external review dependencies", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hooks = JSON.parse(readFileSync(join(root, "hooks/hooks.json")));
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
  assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume");
  const manifest = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json")));
  assert.equal(manifest.name, "unpaged-codex");
  const skill = readFileSync(join(root, "skills/review-plan/SKILL.md"), "utf8");
  assert.ok(!skill.includes("plan-exit-review"));
});
