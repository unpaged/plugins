import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeControl, controlInputSchema } from "./control.mjs";
import { readJson } from "./cli.mjs";
import { Store } from "./store.mjs";
import { POLL_URL } from "./protocol.mjs";

const DOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOKEN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DIGEST = "a".repeat(64);
const KEY = "K".repeat(43);
const NATIVE = "/native/installed/codex";
const context = { threadId: TASK, cwd: "/task/project" };
const armPayload = () => ({ keyId: "key-1", key: KEY, pollUrl: POLL_URL, planDigest: DIGEST, statusElementIds: [OTHER] });
const binding = (threadId = TASK, documentId = DOC) => ({ documentId, threadId, codexPath: NATIVE,
  status: "active", connectionState: "connected", lastSuccessfulPollAt: "2026-09-22T00:00:00.000Z" });
function fixture(result = {}) {
  const calls = [];
  let resolutions = 0;
  const env = { CODEX_HOME: "/host/private/codex", CODEX_THREAD_ID: OTHER, HOST_ONLY: "preserved" };
  return { calls, env, get resolutions() { return resolutions; }, options: { env,
    resolveCodex: async () => { resolutions++; return NATIVE; },
    executeCli: async (argv, options) => {
      const payload = await readJson(options.input);
      calls.push({ argv, payload, env: options.env, cwd: options.cwd });
      return typeof result === "function" ? result(argv, payload) : result;
    }
  } };
}

test("native task and absolute folder are required before execution or binary discovery", async () => {
  const fake = fixture();
  for (const value of [undefined, null, {}, { ...context, threadId: "not-a-task" },
    { ...context, cwd: "relative" }, { ...context, cwd: "/task\0project" }]) {
    await assert.rejects(executeControl({ operation: "doctor" }, value, fake.options), /native_task_context_required/);
  }
  assert.equal(fake.calls.length, 0); assert.equal(fake.resolutions, 0);
});

test("model arguments cannot select commands, task context, executable, environment or storage", async () => {
  const fake = fixture();
  for (const operation of ["session-start", "queue", "claimWorker", "arm; touch /tmp/anything", "__proto__", ["arm"]]) {
    await assert.rejects(executeControl({ operation }, context, fake.options), /invalid_control_operation/);
  }
  for (const name of ["argv", "data", "codex", "cwd", "env", "threadId", "_meta", "executeCli", "resolveCodex"]) {
    await assert.rejects(executeControl({ operation: "doctor", [name]: "/model/override" }, context, fake.options), /invalid_control_arguments/);
  }
  for (const name of ["codexPath", "documentId", "threadId", "cwd", "data", "env", "_meta", "workerToken", "__proto__"]) {
    const payload = { ...armPayload(), [name]: "/model/override" };
    await assert.rejects(executeControl({ operation: "arm", documentId: DOC, payload }, context, fake.options), /invalid_control_arguments/);
  }
  assert.equal(fake.calls.length, 0); assert.equal(fake.resolutions, 0);
});

test("arm injects only host task and executable while credentials stay out of argv and outputs", async () => {
  const fake = fixture({ ...binding(), key: KEY, protocols: ["private", KEY], workerToken: KEY,
    phaseEvidence: [{ evidence: "Task requested review", key: KEY }], arbitrary: KEY });
  const args = { operation: "arm", documentId: DOC, payload: armPayload() };
  const before = structuredClone(args);
  const result = await executeControl(args, context, fake.options);
  assert.deepEqual(args, before);
  assert.deepEqual(fake.calls[0].argv, ["arm", DOC, "--codex", NATIVE]);
  assert.deepEqual(fake.calls[0].payload, { ...armPayload(), documentId: DOC, threadId: TASK });
  assert.equal(fake.calls[0].env.CODEX_THREAD_ID, TASK);
  assert.equal(fake.calls[0].env.CODEX_HOME, fake.env.CODEX_HOME);
  assert.equal(fake.calls[0].cwd, context.cwd);
  assert.equal(fake.env.CODEX_THREAD_ID, OTHER);
  assert.equal(JSON.stringify(fake.calls[0].argv).includes(KEY), false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  assert.equal(result.lastSuccessfulPollAt, binding().lastSuccessfulPollAt);
});

test("only the trusted resolver selects a native binary and doctor does not claim delivery", async () => {
  const fake = fixture({ setupReady: true, status: "ready", evidenceScope: "native_hook_inventory",
    evidenceLimit: "Does not verify listening", hook: { enabled: true, trustStatus: "trusted", currentHash: "hash", key: KEY } });
  const result = await executeControl({ operation: "doctor" }, context, fake.options);
  assert.deepEqual(fake.calls[0].argv, ["doctor", "--codex", NATIVE]);
  assert.equal(result.launchMethod, "native_mcp");
  assert.equal(result.evidenceScope, "native_hook_inventory");
  assert.equal(result.connectionState, undefined);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  const invalid = fixture();
  await assert.rejects(executeControl({ operation: "doctor" }, context,
    { ...invalid.options, resolveCodex: async () => "relative-codex" }), /native_codex_path_required/);
  assert.equal(invalid.calls.length, 0);
});

test("native setup storage failures report the host blocker without CLI database-grant guidance", async () => {
  const report = { setupReady: false, status: "query_failed", reason: "native_state_initialization_failed",
    action: "Request state directory grants", key: KEY };
  const fake = fixture(report);
  const result = await executeControl({ operation: "doctor" }, context, fake.options);
  assert.equal(result.setupReady, false);
  assert.equal(result.launchMethod, "native_mcp");
  assert.match(result.action, /host setup blocker/);
  assert.match(result.action, /Do not request database grants/);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  const blocked = fixture(() => { const error = new Error("setup_not_ready"); error.setup = report; throw error; });
  await assert.rejects(executeControl({ operation: "arm", documentId: DOC, payload: armPayload() }, context, blocked.options), (error) => {
    assert.equal(error.message, "setup_not_ready");
    assert.deepEqual(error.setup, result);
    return true;
  });
});

test("host status distinguishes a live claimed worker, reused or missing PID, and unknown inspection", async () => {
  const row = { ...binding(), workerPid: 123456, workerIdentity: "same-birth" };
  for (const [current, expected] of [["same-birth", true], ["other-birth", false], [null, false], [undefined, null]]) {
    for (const operation of ["status", "arm", "resume"]) {
      const fake = fixture((argv) => argv[0] === "status" ? [row] : row);
      const result = await executeControl({ operation, documentId: DOC,
        ...(operation === "arm" ? { payload: armPayload() } : {}) }, context,
      { ...fake.options, processIdentity: (pid) => { assert.equal(pid, row.workerPid); return current; } });
      assert.equal((Array.isArray(result) ? result[0] : result).workerAlive, expected);
    }
  }
  const legacy = fixture([{ ...row, workerIdentity: null }]);
  const result = await executeControl({ operation: "status" }, context,
    { ...legacy.options, processIdentity: () => "same-birth" });
  assert.equal(result[0].workerAlive, null);
});

test("status lists only this task and makes missing and foreign explicit boards equally unavailable", async () => {
  const fake = fixture([{ ...binding(), key: KEY, events: [{ id: "event-1", workerToken: KEY }] }, binding(OTHER, OTHER)]);
  const result = await executeControl({ operation: "status" }, context, fake.options);
  assert.equal(result.length, 1); assert.equal(result[0].documentId, DOC);
  assert.deepEqual(result[0].events, [{ id: "event-1" }]);
  assert.equal(JSON.stringify(result).includes(KEY), false);
  for (const rows of [[], [binding(OTHER)]]) {
    await assert.rejects(executeControl({ operation: "status", documentId: DOC }, context, fixture(rows).options), /review_unavailable/);
  }
});

test("resume refuses a foreign binding or a changed executable before launching and never rewrites it", async () => {
  for (const rows of [[], [binding(OTHER)], [{ ...binding(), codexPath: "/model/script" }]]) {
    const fake = fixture(rows);
    await assert.rejects(executeControl({ operation: "resume", documentId: DOC }, context, fake.options),
      /review_unavailable|native_codex_path_mismatch/);
    assert.deepEqual(fake.calls.map((call) => call.argv), [["status", DOC]]);
  }
  const fake = fixture((argv) => argv[0] === "status" ? [binding()] : binding());
  assert.equal((await executeControl({ operation: "resume", documentId: DOC }, context, fake.options)).documentId, DOC);
  assert.deepEqual(fake.calls.map((call) => call.argv), [["status", DOC], ["resume", DOC]]);
});

test("concurrent calls get independent host task environments without mutating process state", async () => {
  const original = process.env.CODEX_THREAD_ID;
  const env = { CODEX_THREAD_ID: "startup-task", CODEX_HOME: "/private/state" };
  const calls = [];
  const options = { env, executeCli: async (_argv, execution) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    calls.push(execution); return { node: "24" };
  } };
  await Promise.all([executeControl({ operation: "info" }, context, options),
    executeControl({ operation: "info" }, { threadId: OTHER, cwd: "/other/project" }, options)]);
  assert.deepEqual(calls.map((call) => call.env.CODEX_THREAD_ID).sort(), [TASK, OTHER].sort());
  assert.notEqual(calls[0].env, calls[1].env);
  assert.equal(env.CODEX_THREAD_ID, "startup-task"); assert.equal(process.env.CODEX_THREAD_ID, original);
});

test("event and lifecycle operations preserve their existing bounded payload contracts", async () => {
  const phase = { evidence: "Verified task-user instruction", currentDigest: DIGEST };
  const complete = { operationToken: TOKEN, evidence: { replyId: "reply-1", planDigest: DIGEST } };
  const cases = [
    ["pending"], ["begin", undefined, "event-1"], ["stop"],
    ["complete", complete, "event-1"],
    ["accept", { operationToken: TOKEN, humanText: "I accept this plan", humanCreatedAt: "2026-09-22T00:00:00.000Z",
      currentDigest: DIGEST, submittedPlanDigest: DIGEST }, "event-1"],
    ...["submit", "approve", "execute", "checkpoint"].map((operation) => [operation, phase]),
    ["built", { ...phase, recordNodeId: OTHER, openTasks: 0 }],
    ["revoked", { keyId: "key-1", evidence: "Remote revocation confirmed" }],
    ["reconcile", { evidence: "Unresolved comments checked" }],
    ["recover", { decision: "complete", evidence: { skippedReason: "Resolved by human" } }, "event-1"]
  ];
  for (const [operation, payload, eventId] of cases) {
    const fake = fixture({ operationToken: TOKEN });
    const result = await executeControl({ operation, documentId: DOC,
      ...(payload ? { payload } : {}), ...(eventId ? { eventId } : {}) }, context, fake.options);
    assert.deepEqual(fake.calls[0].argv, [operation, DOC, ...(eventId ? [eventId] : [])]);
    assert.deepEqual(fake.calls[0].payload, payload ?? {});
    assert.equal(result.operationToken, TOKEN);
  }
});

test("invalid IDs, unexpected payloads and nested worker capabilities fail before CLI execution", async () => {
  const fake = fixture();
  for (const args of [
    { operation: "stop", documentId: "--data" },
    { operation: "stop", documentId: [DOC] },
    { operation: "begin", documentId: DOC, eventId: "event; command" },
    { operation: "begin", documentId: DOC },
    { operation: "stop", documentId: DOC, payload: {} },
    { operation: "reconcile", documentId: DOC, payload: { evidence: "checked", token: TOKEN } },
    { operation: "complete", documentId: DOC, eventId: "event-1", payload: {
      operationToken: TOKEN, evidence: { replyId: "reply-1", planDigest: DIGEST, workerToken: TOKEN } } },
    { operation: "complete", documentId: DOC, eventId: "event-1", payload: {
      operationToken: [TOKEN], evidence: { skippedReason: "Verified" } } },
    { operation: "built", documentId: DOC, payload: { evidence: "Partial", currentDigest: DIGEST, recordNodeId: OTHER, openTasks: 1 } },
    { operation: "arm", documentId: DOC, payload: { ...armPayload(), pollUrl: "https://foreign.example/events/poll" } },
    { operation: "arm", documentId: DOC, payload: { ...armPayload(), statusElementIds: [[OTHER]] } }
  ]) await assert.rejects(executeControl(args, context, fake.options));
  assert.equal(fake.calls.length, 0); assert.equal(fake.resolutions, 0);
});

test("the transport payload limit is applied before invocation, and schemas expose only fixed operations", async () => {
  const fake = fixture();
  await assert.rejects(executeControl({ operation: "digest", payload: { document: { title: "x".repeat(2 * 1024 * 1024) } } },
    context, fake.options), /input_too_large/);
  assert.equal(fake.calls.length, 0);
  assert.equal(controlInputSchema.type, "object");
  assert.equal(controlInputSchema.additionalProperties, false);
  assert.deepEqual(controlInputSchema.required, ["operation"]);
  assert.equal(controlInputSchema.properties.threadId, undefined);
  assert.equal(controlInputSchema.properties.cwd, undefined);
  assert.equal(controlInputSchema.properties.payload.additionalProperties, false);
});

test("advertised arguments stay below native schema compaction and expose digest and arm fields", () => {
  // Codex 4607249 tools/src/json_schema/compaction.rs starts lossy passes at
  // 5,000 normalized bytes; the old root oneOf became {}. Raw JSON < 4,000
  // leaves room for native defaults while guarding against that regression.
  assert.ok(Buffer.byteLength(JSON.stringify(controlInputSchema)) < 4000);
  assert.equal(controlInputSchema.oneOf, undefined);
  assert.deepEqual(Object.keys(controlInputSchema.properties), ["operation", "documentId", "eventId", "payload"]);
  const payload = controlInputSchema.properties.payload;
  assert.equal(payload.type, "object");
  assert.equal(payload.properties.document.type, "object");
  assert.equal(payload.properties.document.additionalProperties, true);
  for (const name of ["keyId", "key", "planDigest", "operationToken"]) assert.equal(payload.properties[name].type, "string");
  assert.equal(payload.properties.pollUrl.const, POLL_URL);
  assert.equal(payload.properties.statusElementIds.type, "array");
  assert.equal(payload.properties.openTasks.type, "integer");
});

test("the compact field union does not relax required or operation-specific runtime inputs", async () => {
  const fake = fixture();
  for (const args of [
    { operation: "doctor", documentId: DOC },
    { operation: "info", payload: {} },
    { operation: "digest" },
    { operation: "digest", payload: {} },
    { operation: "digest", payload: { document: {}, keyId: "key-1" } },
    { operation: "arm", payload: armPayload() },
    { operation: "arm", documentId: DOC, payload: { ...armPayload(), document: {} } },
    { operation: "complete", documentId: DOC, eventId: "event-1", payload: { evidence: { skippedReason: "verified" } } },
    { operation: "complete", documentId: DOC, eventId: "event-1", payload: { operationToken: TOKEN, evidence: "unverified proof" } },
    { operation: "approve", documentId: DOC, payload: { evidence: { replyId: "reply-1", planDigest: DIGEST }, currentDigest: DIGEST } },
    { operation: "reconcile", documentId: DOC, payload: { evidence: "verified", currentDigest: DIGEST } }
  ]) await assert.rejects(executeControl(args, context, fake.options));
  assert.equal(fake.calls.length, 0); assert.equal(fake.resolutions, 0);
});

test("real CLI storage preserves cross-task mutation fences and scopes status", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "unpaged-control-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "unpaged", "reviews.sqlite"));
  for (const [documentId, threadId] of [[DOC, TASK], [OTHER, OTHER]]) {
    store.bind({ ...armPayload(), documentId, threadId, codexPath: NATIVE });
  }
  store.close();
  const options = { env: { CODEX_HOME: directory } };
  const rows = await executeControl({ operation: "status" }, context, options);
  assert.deepEqual(rows.map((row) => row.documentId), [DOC]);
  await assert.rejects(executeControl({ operation: "status", documentId: OTHER }, context, options), /review_unavailable/);
  await assert.rejects(executeControl({ operation: "stop", documentId: OTHER }, context, options), /wrong_codex_task/);
  const verify = new Store(join(directory, "unpaged", "reviews.sqlite"));
  try { assert.equal(verify.getBinding(OTHER).status, "active"); }
  finally { verify.close(); }
});

test("real lifecycle results preserve complete acceptance receipts and phase evidence", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "unpaged-control-receipt-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(join(directory, "unpaged", "reviews.sqlite"));
  store.bind({ ...armPayload(), documentId: DOC, threadId: TASK, codexPath: NATIVE });
  store.close();
  const options = { env: { CODEX_HOME: directory } };
  const proof = { evidence: "Task user approved this fixture", currentDigest: DIGEST };
  const accepted = await executeControl({ operation: "approve", documentId: DOC, payload: proof }, context, options);
  assert.deepEqual(Object.keys(accepted.acceptanceReceipts[0]).sort(), ["acceptedAt", "eventId", "evidence", "planDigest", "source"]);
  assert.equal(accepted.acceptanceReceipts[0].eventId, null);
  assert.equal(accepted.acceptanceReceipts[0].planDigest, DIGEST);
  assert.equal(accepted.acceptanceReceipts[0].source, "task-user");
  await executeControl({ operation: "execute", documentId: DOC, payload: proof }, context, options);
  const built = await executeControl({ operation: "built", documentId: DOC,
    payload: { ...proof, currentDigest: "b".repeat(64), recordNodeId: OTHER, openTasks: 0 } }, context, options);
  assert.equal(built.planPhase, "built");
  assert.deepEqual(built.acceptanceReceipts, accepted.acceptanceReceipts);
  assert.deepEqual(built.phaseEvidence.map((entry) => entry.command), ["approve", "execute", "built"]);
  const [status] = await executeControl({ operation: "status", documentId: DOC }, context, options);
  assert.deepEqual(status.acceptanceReceipts, accepted.acceptanceReceipts);
  assert.deepEqual(status.phaseEvidence, built.phaseEvidence);
});
