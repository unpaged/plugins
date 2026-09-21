import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Store } from "./store.mjs";
import { DatabaseSync } from "node:sqlite";
import { executeCli } from "./cli.mjs";
import { POLL_URL } from "./protocol.mjs";
import { runWorker } from "./worker.mjs";

const DOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RECORD = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY = "K".repeat(43);
const DIGEST = "a".repeat(64), CHANGED = "b".repeat(64), BUILT = "c".repeat(64);
const proof = (currentDigest = DIGEST) => ({ evidence: "Verified the explicit request in the assigned Codex task.", currentDigest });
const input = (value) => Readable.from([JSON.stringify(value)]);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "unpaged-lifecycle-test-"));
  const path = join(directory, "reviews.sqlite");
  const store = new Store(path);
  store.bind({ documentId: DOC, threadId: TASK, keyId: "key", pollUrl: POLL_URL,
    key: KEY, codexPath: process.execPath, planDigest: DIGEST });
  const { token } = store.claimWorker(DOC, { pid: process.pid, transport: "poll-v1" });
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const receive = (id) => store.receive(DOC, { id, documentId: DOC, nodeId: "root", threadId: `thread-${id}`,
    commentId: `comment-${id}`, reason: "mention", authorRole: "owner", resolved: false, createdAt: new Date().toISOString() }, token);
  const begin = (id) => { receive(id); store.markDispatching(DOC, id, token); return store.begin(DOC, id, { expectedThreadId: TASK }); };
  const complete = (id, operationToken, planDigest = DIGEST) => store.complete(DOC, id, { operationToken, evidence: { replyId: `reply-${id}`, planDigest } });
  return { directory, path, store, token, receive, begin, complete };
}

test("task-user approval and implementation are separate, and build requires a verified complete record", (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.transition(DOC, "execute", proof()), /plan_acceptance_required/);
  assert.throws(() => store.transition(DOC, "approve", proof(CHANGED)), /digest_mismatch/);
  assert.throws(() => store.transition(DOC, "approve", { currentDigest: DIGEST }), /invalid_evidence/);
  assert.throws(() => store.transition(DOC, "approve", { ...proof(), evidence: "x".repeat(1001) }), /invalid_evidence/);
  const accepted = store.transition(DOC, "approve", proof());
  assert.equal(accepted.planPhase, "accepted");
  assert.equal(accepted.status, "active");
  assert.equal(accepted.acceptanceReceipts[0].source, "task-user");
  assert.throws(() => store.transition(DOC, "built", { ...proof(), recordNodeId: RECORD, openTasks: 0 }), /implementation_not_started/);
  assert.throws(() => store.transition(DOC, "execute", proof(CHANGED)), /digest_mismatch/);
  const executing = store.transition(DOC, "execute", proof());
  assert.equal(executing.planPhase, "executing");
  assert.throws(() => store.transition(DOC, "built", { ...proof(), recordNodeId: RECORD, openTasks: 1 }), /open_plan_tasks/);
  assert.throws(() => store.transition(DOC, "built", { ...proof(), recordNodeId: RECORD }), /open_plan_tasks/);
  assert.throws(() => store.transition(DOC, "built", { ...proof(), recordNodeId: "not-a-node", openTasks: 0 }), /invalid_uuid/);
  const built = store.transition(DOC, "built", { ...proof(BUILT), recordNodeId: RECORD, openTasks: 0 });
  assert.equal(built.planPhase, "built");
  assert.equal(built.planDigest, BUILT);
  assert.equal(built.acceptedDigest, DIGEST);
  assert.equal(built.cleanupRequired, false);
  assert.deepEqual(built.phaseEvidence.map((entry) => entry.command), ["approve", "execute", "built"]);
  assert.throws(() => store.transition(DOC, "built", { ...proof(BUILT), recordNodeId: RECORD, openTasks: 0 }), /implementation_not_started/);
});

test("received events and reconciliation gaps prevent task transitions and cannot be disguised as permission", (t) => {
  const { store, token, receive } = fixture(t);
  store.markReconciliationRequired(DOC, token, "test-gap");
  for (const command of ["submit", "approve"]) assert.throws(() => store.transition(DOC, command, proof()), /reconciliation_required/);
  store.reconcile(DOC, { evidence: "Verified current comments and plan against the task." });
  receive("pending");
  for (const command of ["submit", "approve"]) assert.throws(() => store.transition(DOC, command, proof()), /outstanding_events/);
  store.markDispatching(DOC, "pending", token);
  const { operationToken } = store.begin(DOC, "pending", { expectedThreadId: TASK });
  store.accept(DOC, "pending", { operationToken, humanCreatedAt: store.listEvents(DOC)[0].createdAt, humanText: "I accept this plan", currentDigest: DIGEST, submittedPlanDigest: DIGEST });
  assert.throws(() => store.transition(DOC, "execute", proof()), /outstanding_events/);
  store.complete(DOC, "pending", { operationToken, evidence: { replyId: "reply", planDigest: DIGEST } });
  store.transition(DOC, "execute", proof());
  receive("during-execution");
  assert.throws(() => store.transition(DOC, "checkpoint", proof(CHANGED)), /outstanding_events/);
  assert.throws(() => store.transition(DOC, "built", { ...proof(BUILT), recordNodeId: RECORD, openTasks: 0 }), /outstanding_events/);
});

test("accepted feedback revisions require new approval and retain every prior acceptance receipt", (t) => {
  const { store, begin, complete } = fixture(t);
  const first = begin("acceptance");
  store.accept(DOC, "acceptance", { operationToken: first.operationToken, humanCreatedAt: first.event.createdAt, humanText: "I accept this plan", currentDigest: DIGEST, submittedPlanDigest: DIGEST });
  assert.throws(() => complete("acceptance", first.operationToken, CHANGED), /accepted_plan_changed/);
  complete("acceptance", first.operationToken);
  const revision = begin("revision");
  complete("revision", revision.operationToken, CHANGED);
  const revised = store.getBinding(DOC);
  assert.equal(revised.planPhase, "proposed");
  assert.equal(revised.acceptedDigest, DIGEST);
  assert.throws(() => store.transition(DOC, "execute", proof(CHANGED)), /plan_acceptance_required/);
  const reapproved = store.transition(DOC, "approve", proof(CHANGED));
  assert.equal(reapproved.acceptedDigest, CHANGED);
  assert.deepEqual(reapproved.acceptanceReceipts.map((receipt) => receipt.planDigest), [DIGEST, CHANGED]);
  assert.deepEqual(reapproved.acceptanceReceipts.map((receipt) => receipt.source), ["board-owner", "task-user"]);
});

test("execution and record corrections advance the current digest while preserving the accepted baseline", (t) => {
  const { store, begin, complete } = fixture(t);
  store.transition(DOC, "approve", proof());
  store.transition(DOC, "execute", proof());
  const logged = store.transition(DOC, "checkpoint", proof(CHANGED));
  assert.equal(logged.planPhase, "executing");
  assert.equal(logged.planDigest, CHANGED);
  assert.equal(logged.acceptedDigest, DIGEST);
  assert.throws(() => store.transition(DOC, "submit", proof()), /implementation_already_started/);
  store.transition(DOC, "built", { ...proof(BUILT), recordNodeId: RECORD, openTasks: 0 });
  const correction = begin("record-correction");
  complete("record-correction", correction.operationToken, CHANGED);
  const corrected = store.getBinding(DOC);
  assert.equal(corrected.planPhase, "built");
  assert.equal(corrected.planDigest, CHANGED);
  assert.equal(corrected.acceptedDigest, DIGEST);
  assert.equal(corrected.acceptanceReceipts.length, 1);
});

test("explicit resubmission refreshes even an identical baseline without erasing acceptance", (t) => {
  const baseline = Date.parse("2026-09-19T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseline });
  const { store } = fixture(t);
  store.transition(DOC, "approve", proof());
  t.mock.timers.setTime(baseline + 1000);
  const resubmitted = store.transition(DOC, "submit", proof());
  assert.equal(resubmitted.planPhase, "proposed");
  assert.equal(resubmitted.acceptanceReceipts.length, 1);
  assert.equal(resubmitted.acceptedDigest, DIGEST);
  assert.equal(Date.parse(resubmitted.planVersionAt), baseline + 1000);
  assert.throws(() => store.transition(DOC, "execute", proof()), /plan_acceptance_required/);
});

test("stopping an accepted listener fences recovery from producing more board effects", (t) => {
  const { store, begin } = fixture(t);
  const started = begin("acceptance");
  store.accept(DOC, "acceptance", { operationToken: started.operationToken, humanCreatedAt: started.event.createdAt, humanText: "I accept this plan", currentDigest: DIGEST, submittedPlanDigest: DIGEST });
  store.recover(DOC, "acceptance", { decision: "interrupt", evidence: "The acceptance turn was interrupted." });
  store.requestStop(DOC);
  assert.throws(() => store.recover(DOC, "acceptance", { decision: "continue", evidence: "A reply remains missing." }), /review_inactive/);
  // Read-only inspection can still attest effects already performed before stop.
  store.recover(DOC, "acceptance", { decision: "complete", evidence: { replyId: "verified-existing-reply", planDigest: DIGEST } });
  assert.equal(store.getBinding(DOC).status, "stopped");
});

test("the assigned task can invoke every lifecycle CLI command with JSON evidence", async (t) => {
  const { directory, store } = fixture(t);
  const call = (command, payload) => executeCli([command, DOC, "--data", directory], {
    env: { CODEX_THREAD_ID: TASK }, input: input(payload)
  });
  assert.equal((await call("submit", proof(CHANGED))).planPhase, "proposed");
  assert.equal((await call("approve", proof(CHANGED))).planPhase, "accepted");
  assert.equal((await call("execute", proof(CHANGED))).planPhase, "executing");
  assert.equal((await call("checkpoint", proof(BUILT))).planDigest, BUILT);
  assert.equal((await call("built", { ...proof(BUILT), recordNodeId: RECORD, openTasks: 0 })).planPhase, "built");
  assert.equal(store.getBinding(DOC).acceptanceReceipts.length, 1);
  assert.equal(store.getBinding(DOC).acceptedDigest, CHANGED);
});

test("legacy terminal acceptance migrates to stopped without losing its receipt or revocation requirement", (t) => {
  const { store, path, token } = fixture(t);
  store.releaseWorker(DOC, token);
  store.db.prepare("UPDATE bindings SET state='accepted',accepted_event_id='legacy',accepted_digest=?,accepted_at=?,revoke_pending=1").run(DIGEST, new Date().toISOString());
  store.db.exec("ALTER TABLE bindings DROP COLUMN plan_phase; ALTER TABLE bindings DROP COLUMN phase_evidence; DROP TABLE acceptance_receipts");
  store.close();
  const restored = new Store(path); t.after(() => restored.close());
  const binding = restored.getBinding(DOC);
  assert.equal(binding.status, "stopped");
  assert.equal(binding.planPhase, "accepted");
  assert.equal(binding.cleanupRequired, true);
  assert.equal(binding.acceptanceReceipts.length, 1);
  assert.equal(binding.acceptanceReceipts[0].source, "legacy");
  assert.throws(() => restored.claimWorker(DOC, { pid: process.pid, isAlive: () => false }), /review_inactive/);
  assert.throws(() => restored.transition(DOC, "execute", proof()), /review_inactive/);
  restored.confirmRevoked(DOC, { keyId: "key", evidence: "MCP confirmed revocation." });
  assert.equal(restored.getBinding(DOC).credentialsPresent, false);
});

test("a live or unverifiable legacy worker prevents migration before any schema or state change", (t) => {
  const { store, path } = fixture(t);
  store.db.exec("ALTER TABLE bindings DROP COLUMN plan_phase; ALTER TABLE bindings DROP COLUMN phase_evidence; DROP TABLE acceptance_receipts");
  store.close();
  for (const unknownIdentity of [false, true]) {
    const legacy = new DatabaseSync(path);
    if (unknownIdentity) legacy.prepare("UPDATE bindings SET worker_identity=NULL").run();
    const before = legacy.prepare("SELECT * FROM bindings").get();
    assert.throws(() => new Store(path), /legacy_worker_upgrade_required/);
    assert.deepEqual(legacy.prepare("SELECT * FROM bindings").get(), before);
    assert.equal(legacy.prepare("PRAGMA table_info(bindings)").all().some((column) => column.name === "plan_phase"), false);
    assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name='acceptance_receipts'").get(), undefined);
    legacy.close();
  }
});

test("every unfinished legacy event blocks migration until the old helper completes its receipt", (t) => {
  const { store, path, token, begin } = fixture(t);
  begin("unfinished");
  store.releaseWorker(DOC, token);
  store.db.exec("ALTER TABLE bindings DROP COLUMN plan_phase; ALTER TABLE bindings DROP COLUMN phase_evidence; DROP TABLE acceptance_receipts");
  store.close();
  const legacy = new DatabaseSync(path);
  for (const state of ["received", "dispatching", "queued", "processing", "queue_uncertain", "effect_uncertain"]) {
    legacy.prepare("UPDATE events SET state=?").run(state);
    assert.throws(() => new Store(path), /legacy_events_upgrade_required/);
    assert.equal(legacy.prepare("SELECT state FROM events").get().state, state);
    assert.equal(legacy.prepare("PRAGMA table_info(bindings)").all().some((column) => column.name === "plan_phase"), false);
  }
  // This models the old helper's verified completion; migration itself never
  // acknowledges, drops or retries a pending event.
  legacy.prepare("UPDATE events SET state='completed',evidence=?").run(JSON.stringify({ replyId: "verified-old-reply", planDigest: DIGEST }));
  legacy.close();
  const upgraded = new Store(path); t.after(() => upgraded.close());
  assert.equal(upgraded.getBinding(DOC).planPhase, "proposed");
  assert.equal(upgraded.listEvents(DOC)[0].evidence.replyId, "verified-old-reply");
});

test("restart and compaction retain implementation evidence and phase without auto-approving a different task", async (t) => {
  const { store, path, token, directory } = fixture(t);
  store.transition(DOC, "approve", proof());
  store.transition(DOC, "execute", proof());
  store.transition(DOC, "checkpoint", proof(CHANGED));
  store.recordPollSuccess(DOC, token, { at: new Date().toISOString(), newEvents: false });
  const before = store.getBinding(DOC);
  const report = await executeCli(["session-start", "--data", directory], {
    env: { CODEX_THREAD_ID: TASK }, input: input({ hook_event_name: "SessionStart", source: "compact", session_id: TASK }),
    spawn() { assert.fail("live worker must not restart on compaction"); }
  });
  const context = report.hookSpecificOutput.additionalContext;
  assert.ok(context.includes('"planPhase":"executing"'));
  assert.ok(context.includes("Decision log"));
  assert.ok(context.includes(proof().evidence));
  for (const command of ["submit", "approve", "execute", "checkpoint", "built"]) {
    await assert.rejects(executeCli([command, DOC, "--data", directory], {
      env: { CODEX_THREAD_ID: RECORD }, input: input(proof())
    }), /wrong_codex_task/);
  }
  store.releaseWorker(DOC, token);
  store.close();
  const restored = new Store(path); t.after(() => restored.close());
  restored.claimWorker(DOC, { pid: process.pid, transport: "poll-v1" });
  const after = restored.getBinding(DOC);
  assert.equal(after.planPhase, "executing");
  assert.equal(after.planDigest, CHANGED);
  assert.equal(after.lastSuccessfulPollAt, before.lastSuccessfulPollAt);
  assert.equal(after.lastEventAt, null);
  assert.deepEqual(after.phaseEvidence, before.phaseEvidence);
  assert.deepEqual(after.acceptanceReceipts, before.acceptanceReceipts);
  assert.equal(after.reconciliationRequired, true);
  assert.throws(() => restored.transition(DOC, "checkpoint", proof(BUILT)), /reconciliation_required/);
});

test("polling a built review preserves approval and completion receipts while routing new feedback", async (t) => {
  const { store, directory, token, begin, complete } = fixture(t);
  store.transition(DOC, "approve", proof());
  store.transition(DOC, "execute", proof());
  store.transition(DOC, "built", { ...proof(BUILT), recordNodeId: RECORD, openTasks: 0 });
  const previous = begin("previous-feedback");
  complete(previous.event.id, previous.operationToken, BUILT);
  const before = store.getBinding(DOC);
  const receipt = store.listEvents(DOC)[0];
  const credentials = store.getBinding(DOC, { includeSecrets: true }).protocols;
  store.releaseWorker(DOC, token);

  const frame = (id) => ({ type: "agent-inbox-event", id, documentId: DOC,
    nodeId: "root", threadId: `thread-${id}`, commentId: `comment-${id}`,
    reason: "mention", authorRole: "owner", resolved: false, createdAt: new Date().toISOString(),
    documentTitle: "Plan", nodeTitle: "Overview", authorName: "Owner",
    textPreview: "@agent review", boardUrl: "https://unpaged.io/board", anchorElementId: null });
  const frames = [frame("previous-feedback"), frame("new-feedback")];
  const controller = new AbortController();
  const calls = [];
  let polls = 0;
  const done = runWorker(DOC, { store, dataDir: directory, signal: controller.signal,
    pollMs: 10, pollIntervalMs: 10, idlePollIntervalMs: 10,
    async fetch(url, options) {
      assert.equal(url, POLL_URL);
      assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
      polls++;
      return Response.json({ events: polls === 1 ? frames : [] });
    },
    execFile(path, args, options, callback) {
      calls.push({ path, args, options });
      callback(null, `Queued message ${RECORD} for thread ${TASK}`);
    }
  });
  const until = async (condition) => {
    const deadline = Date.now() + 2000;
    while (!condition()) {
      assert.ok(Date.now() < deadline, "polling lifecycle condition timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  try {
    await until(() => polls >= 2 && store.listEvents(DOC).some((event) => event.id === "new-feedback" && event.state === "queued"));
    const active = store.getBinding(DOC);
    assert.equal(active.status, "active");
    assert.equal(active.connectionState, "connected");
    assert.equal(active.planPhase, "built");
    assert.equal(active.planDigest, BUILT);
    assert.equal(active.acceptedDigest, DIGEST);
    assert.equal(active.workerTransport, "poll-v1");
    assert.ok(active.lastSuccessfulPollAt);
    assert.ok(active.lastEventAt);
    assert.equal(active.reconciliationRequired, true, "successful polling must retain the restart gap");
    assert.deepEqual(active.acceptanceReceipts, before.acceptanceReceipts);
    assert.deepEqual(active.phaseEvidence, before.phaseEvidence);
    assert.deepEqual(store.listEvents(DOC)[0], receipt);
    assert.equal(calls.length, 1, "completed replay must not queue a second review");
    assert.deepEqual(calls[0].args.slice(0, 3), ["queue", "--thread", TASK]);
    const next = store.begin(DOC, "new-feedback", { expectedThreadId: TASK });
    complete("new-feedback", next.operationToken, BUILT);
  } finally {
    controller.abort();
    await done;
  }
  const stopped = store.getBinding(DOC);
  assert.equal(stopped.status, "active", "graceful shutdown preserves the review");
  assert.equal(stopped.planPhase, "built");
  assert.equal(stopped.keyId, before.keyId);
  assert.equal(stopped.threadId, before.threadId);
  assert.equal(stopped.credentialsPresent, true);
  assert.deepEqual(store.getBinding(DOC, { includeSecrets: true }).protocols, credentials);
  assert.equal(stopped.eventCounts.completed, 2);
});
