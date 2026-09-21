import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ACCEPTANCE_CLOCK_SKEW_MS, Store } from "./store.mjs";
import { acceptancePhrase, EVENTS_URL, POLL_URL, SUBPROTOCOL } from "./protocol.mjs";
import { processIdentity } from "./process-identity.mjs";

const doc = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", task = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const digest = "a".repeat(64), changedDigest = "b".repeat(64), queueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const binding = { documentId: doc, threadId: task, keyId: "key-1", url: EVENTS_URL,
  protocols: ["unpaged-listener.v1", "TEST_SECRET_CREDENTIAL"], codexPath: "/test/bin/codex", planDigest: digest };
const event = (id = "event-1", role = "owner") => ({ id, documentId: doc, nodeId: "root", threadId: `thread-${id}`,
  commentId: `comment-${id}`, reason: "mention", authorRole: role, resolved: false, createdAt: new Date().toISOString() });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "unpaged-store-test-"));
  const path = join(directory, "reviews.sqlite"); const store = new Store(path);
  t.after(() => { try { store.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  store.bind(binding); const { token } = store.claimWorker(doc, { pid: 101, isAlive: () => false });
  return { store, token, path, directory };
}
function processing(store, token, id = "event-1", role = "owner") {
  store.receive(doc, event(id, role), token); store.markDispatching(doc, id, token);
  return store.begin(doc, id, { expectedThreadId: task });
}
function acceptArgs({ operationToken, event }, extras = {}) {
  return { operationToken, humanCreatedAt: event.createdAt, humanText: acceptancePhrase(digest), currentDigest: digest, submittedPlanDigest: digest, ...extras };
}

test("WAL/FULL store and sidecars remain private; default status never exposes credential or worker token", (t) => {
  const { store, path, directory, token } = fixture(t);
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.db.prepare("PRAGMA synchronous").get().synchronous, 2);
  assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const suffix of ["", "-wal", "-shm"]) assert.equal(statSync(path + suffix).mode & 0o777, 0o600);
  const status = JSON.stringify(store.listBindings());
  assert.ok(!status.includes("TEST_SECRET")); assert.ok(!status.includes(token));
  assert.equal(store.getBinding(doc, { includeSecrets: true }).protocols[1], binding.protocols[1]);
  assert.equal(store.getBinding(doc).reconciliationRequired, false);
  assert.throws(() => store.bind({ ...binding, threadId: queueId }), /rebind_refused/);
  assert.throws(() => store.bind({ ...binding, keyId: "new-key" }), /rebind_refused/);
});
test("journal deduplicates by board/event, strips extra text, and serializes pending work", (t) => {
  const { store, token, path } = fixture(t);
  assert.equal(store.receive(doc, { ...event(), textPreview: "DO_NOT_STORE_RAW_TEXT" }, token).inserted, true);
  assert.equal(store.receive(doc, event(), token).inserted, false);
  store.receive(doc, event("event-2"), token);
  assert.equal(store.nextEvent(doc, token).id, "event-1");
  assert.throws(() => store.markDispatching(doc, "event-2", token), /event_not_dispatchable/);
  store.markDispatching(doc, "event-1", token);
  assert.equal(store.nextEvent(doc, token), null);
  store.markQueueUncertain(doc, "event-1", token);
  assert.equal(store.nextEvent(doc, token), null);
  assert.equal(store.getBinding(doc).eventCounts.queue_uncertain, 1);
  assert.ok(!readFileSync(path + "-wal").includes(Buffer.from("DO_NOT_STORE_RAW_TEXT")));
});
test("worker ownership is atomic across connections, only dead owner transfers, and stale writes are fenced", (t) => {
  const { store, token, path } = fixture(t);
  const second = new Store(path); t.after(() => second.close());
  assert.throws(() => second.claimWorker(doc, { pid: 102, isAlive: () => true }), /worker_alive/);
  const claimed = second.claimWorker(doc, { pid: 102, isAlive: () => false });
  assert.notEqual(claimed.token, token); assert.equal(claimed.recovered, true);
  assert.throws(() => store.receive(doc, event(), token), { code: "OWNERSHIP_LOST" });
  assert.throws(() => store.setConnection(doc, token, "connected"), { code: "OWNERSHIP_LOST" });
  assert.equal(second.getBinding(doc).reconciliationRequired, true);
});
test("worker claims persist process identity and recover a reused PID while fencing the prior token", (t) => {
  const { store, token } = fixture(t);
  store.releaseWorker(doc, token);
  const identity = processIdentity(process.pid);
  assert.equal(typeof identity, "string", "the current process must have a verifiable identity");
  const first = store.claimWorker(doc, { pid: process.pid });
  assert.equal(store.getBinding(doc).workerIdentity, identity);
  assert.throws(() => store.claimWorker(doc, { pid: process.pid }), /worker_alive/);

  // Simulate a persisted claim from an earlier process with the same PID.
  store.db.prepare("UPDATE bindings SET worker_identity=? WHERE document_id=?").run("earlier-boot-and-start", doc);
  const replacement = store.claimWorker(doc, { pid: process.pid });
  assert.notEqual(replacement.token, first.token);
  assert.equal(store.getBinding(doc).workerIdentity, identity);
  assert.equal(store.getBinding(doc).reconciliationRequired, true);
  assert.throws(() => store.setConnection(doc, first.token, "connected"), { code: "OWNERSHIP_LOST" });
  store.releaseWorker(doc, replacement.token);
  assert.equal(store.getBinding(doc).workerPid, null);
  assert.equal(store.getBinding(doc).workerIdentity, null);
});
test("legacy databases gain a nullable identity without taking over a live unverified worker", (t) => {
  const { store, token, path } = fixture(t);
  store.db.prepare("UPDATE bindings SET worker_pid=? WHERE document_id=?").run(process.pid, doc);
  store.db.exec("ALTER TABLE bindings DROP COLUMN worker_identity");
  store.close();
  const migrated = new Store(path); t.after(() => migrated.close());
  assert.equal(migrated.getBinding(doc).workerIdentity, null);
  assert.equal(migrated.getBinding(doc, { includeSecrets: true }).workerToken, token);
  assert.equal(migrated.getBinding(doc).planDigest, digest);
  assert.throws(() => migrated.claimWorker(doc, { pid: process.pid }), /worker_alive/);
  assert.equal(migrated.getBinding(doc, { includeSecrets: true }).workerToken, token);
});
test("production worker claims require a verified own identity before changing the binding", (t) => {
  const { store, token } = fixture(t);
  store.releaseWorker(doc, token);
  assert.throws(() => store.claimWorker(doc, { pid: process.pid, identity: null }), /worker_identity_unavailable/);
  assert.throws(() => store.claimWorker(doc, { pid: process.pid, identity: "" }), /invalid_worker_identity/);
  assert.equal(store.getBinding(doc).workerPid, null);
});
test("wakeup can begin before queue commit but duplicate begin cannot replay board effects", (t) => {
  const { store, token } = fixture(t);
  const first = processing(store, token);
  assert.throws(() => store.begin(doc, "event-1", { expectedThreadId: queueId }), /wrong_task/);
  assert.throws(() => store.begin(doc, "event-1", { expectedThreadId: task }), /event_not_beginable/);
  store.markQueued(doc, "event-1", token, queueId);
  assert.equal(store.listEvents(doc)[0].state, "processing");
  assert.equal(store.listEvents(doc)[0].queueId, queueId);
  assert.throws(() => store.complete(doc, "event-1", { operationToken: "wrong", evidence: { skippedReason: "No action" } }), /operation_fenced/);
  store.complete(doc, "event-1", { operationToken: first.operationToken, evidence: { replyId: "reply-1", planDigest: changedDigest } });
  store.markQueueUncertain(doc, "event-1", token);
  assert.equal(store.listEvents(doc)[0].state, "completed");
  assert.equal(store.getBinding(doc).planDigest, changedDigest);
});
test("dead worker recovery preserves uncertain dispatch without automatic retry and supports wakeup already in flight", (t) => {
  const { store, token } = fixture(t);
  store.receive(doc, event(), token); store.markDispatching(doc, "event-1", token);
  const next = store.claimWorker(doc, { pid: 102, isAlive: () => false });
  assert.equal(store.listEvents(doc)[0].state, "queue_uncertain");
  assert.equal(store.nextEvent(doc, next.token), null);
  assert.throws(() => store.recover(doc, "event-1", { decision: "retry" }), /invalid_evidence/);
  const started = store.begin(doc, "event-1", { expectedThreadId: task });
  assert.ok(started.operationToken); assert.equal(started.reconciliationRequired, true);
});
test("processing after worker death becomes effect uncertainty and only explicit verified effect completion unblocks next", (t) => {
  const { store, token } = fixture(t);
  const started = processing(store, token); store.receive(doc, event("event-2"), token);
  const next = store.claimWorker(doc, { pid: 102, isAlive: () => false });
  assert.equal(store.listEvents(doc)[0].state, "effect_uncertain");
  assert.throws(() => store.begin(doc, "event-1", { expectedThreadId: task }), /event_not_beginable/);
  assert.throws(() => store.complete(doc, "event-1", { operationToken: started.operationToken, evidence: { skippedReason: "No action" } }), /operation_fenced/);
  assert.throws(() => store.recover(doc, "event-1", { decision: "retry", evidence: "Please retry" }), /invalid_recovery_decision/);
  store.recover(doc, "event-1", { decision: "complete", evidence: { replyId: "verified-reply", planDigest: changedDigest } });
  assert.equal(store.nextEvent(doc, next.token).id, "event-2");
});
test("explicit retry requires queue uncertainty and keeps journal identity", (t) => {
  const { store, token } = fixture(t);
  store.receive(doc, event(), token); store.markDispatching(doc, "event-1", token); store.markQueueUncertain(doc, "event-1", token);
  store.recover(doc, "event-1", { decision: "retry", evidence: "Human confirmed no queued turn exists and authorized retry." });
  assert.equal(store.nextEvent(doc, token).id, "event-1");
  assert.equal(store.receive(doc, event(), token).inserted, false);
  assert.equal(store.listEvents(doc).length, 1);
});
test("acceptance requires standalone owner approval, unchanged digest, current operation and no gap", (t) => {
  const { store, token } = fixture(t); const started = processing(store, token);
  for (const humanText of ["Looks good", "I accept", "I accept this plan if tests pass", '"I accept this plan"']) {
    assert.throws(() => store.accept(doc, "event-1", acceptArgs(started, { humanText })), /explicit_acceptance_required/);
  }
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started, { currentDigest: changedDigest })), /digest_mismatch/);
  store.markReconciliationRequired(doc, token, "socket_reconnected");
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started)), /reconciliation_required/);
  assert.throws(() => store.reconcile(doc, { evidence: "" }), /invalid_evidence/);
  store.reconcile(doc, { evidence: "MCP thread sweep checked current owner comments; no unhandled gap remains." });
  const accepted = store.accept(doc, "event-1", acceptArgs(started, { humanText: "\n@agent: I accept this plan.\n" }));
  assert.equal(accepted.status, "active"); assert.equal(accepted.planPhase, "accepted"); assert.equal(accepted.acceptedDigest, digest); assert.equal(accepted.cleanupRequired, false);
  assert.equal(store.nextEvent(doc, token), null);
  assert.throws(() => store.complete(doc, "event-1", { operationToken: started.operationToken, evidence: { replyId: "reply", planDigest: changedDigest } }), /accepted_plan_changed/);
  store.complete(doc, "event-1", { operationToken: started.operationToken, evidence: { replyId: "accept-reply", planDigest: digest } });
});
test("editor/viewer comments and outstanding received events cannot accept a plan", (t) => {
  for (const role of ["editor", "viewer"]) {
    const { store, token } = fixture(t); const started = processing(store, token, "event-1", role);
    assert.throws(() => store.accept(doc, "event-1", acceptArgs(started)), /owner_acceptance_required/);
  }
  const { store, token } = fixture(t); const started = processing(store, token);
  store.receive(doc, event("event-2"), token);
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started)), /outstanding_events/);
});
test("stop preserves journal and credential until matching explicit remote revocation confirmation", (t) => {
  const { store, token } = fixture(t); store.receive(doc, event(), token);
  const stopped = store.requestStop(doc);
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.cleanupRequired, true);
  assert.equal(store.getBinding(doc, { includeSecrets: true }).protocols[1], binding.protocols[1]);
  assert.throws(() => store.confirmRevoked(doc, { keyId: "wrong", evidence: "Confirmed" }), /revocation_confirmation_refused/);
  store.confirmRevoked(doc, { keyId: binding.keyId, evidence: "MCP revoke returned success for this key." });
  assert.equal(store.getBinding(doc).credentialsPresent, false); assert.equal(store.getBinding(doc).cleanupRequired, false);
  assert.equal(store.listEvents(doc).length, 1);
  assert.throws(() => store.setConnection(doc, token, "unknown"), /invalid_connection_state/);
});

test("reopening the database preserves deduplication and recovers uncertain work even after a released worker", (t) => {
  const { store, token, path } = fixture(t);
  store.receive(doc, event(), token); store.markDispatching(doc, "event-1", token);
  store.releaseWorker(doc, token); store.close();
  const reopened = new Store(path); t.after(() => reopened.close());
  const claim = reopened.claimWorker(doc, { pid: 103, isAlive: () => false });
  assert.equal(reopened.getBinding(doc).reconciliationRequired, true);
  assert.equal(reopened.listEvents(doc)[0].state, "queue_uncertain");
  assert.equal(reopened.receive(doc, event(), claim.token).inserted, false);
  assert.equal(reopened.nextEvent(doc, claim.token), null);
});
test("unknown persisted binding state fails closed rather than implying active review", (t) => {
  const { store } = fixture(t);
  store.db.prepare("UPDATE bindings SET state='future-state' WHERE document_id=?").run(doc);
  assert.throws(() => store.getBinding(doc), /unknown_binding_state/);
});
test("terminal close atomically stops review and requires key cleanup, preventing automatic restart", (t) => {
  for (const code of [4401, 4409, 1003]) {
    const { store, token } = fixture(t);
    store.setConnection(doc, token, "stopped", `terminal_close_${code}`);
    assert.equal(store.getBinding(doc).status, "stopped");
    assert.equal(store.getBinding(doc).cleanupRequired, true);
    assert.equal(store.getBinding(doc).credentialsPresent, true);
    store.releaseWorker(doc, token);
    assert.equal(store.getBinding(doc).connectionReason, `terminal_close_${code}`);
    assert.throws(() => store.claimWorker(doc, { pid: 102, isAlive: () => false }), /review_inactive/);
  }
});
test("terminal HTTP outcomes stop the same review and retain its key for explicit cleanup", (t) => {
  for (const code of [401, 409]) {
    const { store, token } = fixture(t);
    store.receive(doc, event(), token);
    store.setConnection(doc, token, "stopped", `terminal_http_${code}`);
    const terminal = store.getBinding(doc);
    assert.equal(terminal.status, "stopped");
    assert.equal(terminal.connectionReason, `terminal_http_${code}`);
    assert.equal(terminal.cleanupRequired, true);
    assert.equal(terminal.credentialsPresent, true);
    assert.equal(terminal.planDigest, digest);
    assert.equal(terminal.eventCounts.received, 1);
    assert.throws(() => store.recordPollSuccess(doc, token, { at: new Date().toISOString(), newEvents: false }), /review_inactive/);
    store.releaseWorker(doc, token);
    assert.throws(() => store.claimWorker(doc, { pid: 102, isAlive: () => false, transport: "poll-v1" }), /review_inactive/);
    store.confirmRevoked(doc, { keyId: binding.keyId, evidence: "Exact key revocation confirmed." });
    assert.equal(store.getBinding(doc).pollUrl, null);
    assert.equal(store.getBinding(doc).credentialsPresent, false);
  }
});
test("poll success records connection health without inventing activity or clearing an unreconciled gap", (t) => {
  const { store, token } = fixture(t);
  assert.equal(store.getBinding(doc).pollUrl, POLL_URL);
  assert.equal(store.getBinding(doc).lastSuccessfulPollAt, null);
  assert.equal(store.getBinding(doc).lastEventAt, null);
  const first = "2026-09-21T10:00:00.000Z", second = "2026-09-21T10:00:30.000Z", third = "2026-09-21T10:01:00.000Z";
  store.recordPollSuccess(doc, token, { at: first, newEvents: false });
  assert.equal(store.getBinding(doc).connectionState, "connected");
  assert.equal(store.getBinding(doc).lastSuccessfulPollAt, first);
  assert.equal(store.getBinding(doc).lastEventAt, null);
  assert.equal(store.getBinding(doc).reconciliationRequired, false);
  store.markReconciliationRequired(doc, token, "poll_failed");
  store.recordPollSuccess(doc, token, { at: second, newEvents: true });
  store.recordPollSuccess(doc, token, { at: third, newEvents: false });
  const healthy = store.getBinding(doc);
  assert.equal(healthy.connectionState, "connected");
  assert.equal(healthy.connectionReason, null);
  assert.equal(healthy.lastSuccessfulPollAt, third);
  assert.equal(healthy.lastEventAt, second);
  assert.equal(healthy.reconciliationRequired, true);
  assert.equal(healthy.planDigest, digest);
  assert.equal(healthy.planPhase, "proposed");
});
test("poll metadata writes require valid evidence, an active review and the current worker token", (t) => {
  const { store, token } = fixture(t);
  const at = "2026-09-21T10:00:00.000Z";
  for (const args of [{}, { at: "2026-09-21", newEvents: false }, { at, newEvents: 1 }, { at, newEvents: null }]) {
    assert.throws(() => store.recordPollSuccess(doc, token, args), /invalid_poll_/);
  }
  const replacement = store.claimWorker(doc, { pid: 102, isAlive: () => false, transport: "poll-v1" });
  assert.throws(() => store.recordPollSuccess(doc, token, { at, newEvents: true }), { code: "OWNERSHIP_LOST" });
  assert.throws(() => store.setConnection(doc, token, "stopped", "terminal_http_409"), { code: "OWNERSHIP_LOST" });
  assert.equal(store.getBinding(doc).status, "active");
  assert.equal(store.getBinding(doc).lastSuccessfulPollAt, null);
  store.requestStop(doc);
  assert.throws(() => store.recordPollSuccess(doc, replacement.token, { at, newEvents: false }), /review_inactive/);
});
test("transport identity is paired with the worker claim and an old helper claim invalidates it", (t) => {
  const { store, token } = fixture(t);
  assert.equal(store.getBinding(doc).workerTransport, null);
  assert.throws(() => store.claimWorker(doc, { pid: 102, isAlive: () => false, transport: "socket" }), /invalid_worker_transport/);
  assert.equal(store.getBinding(doc, { includeSecrets: true }).workerToken, token);
  const poll = store.claimWorker(doc, { pid: 102, isAlive: () => false, transport: "poll-v1" });
  assert.equal(store.getBinding(doc).workerTransport, "poll-v1");
  assert.ok(!JSON.stringify(store.getBinding(doc)).includes(poll.token));
  // A retained 0.3.2 helper updates only its known columns, leaving the new
  // marker untouched. It must not inherit the previous polling worker's hint.
  const oldHelperToken = "old-retained-helper-claim";
  store.db.prepare("UPDATE bindings SET worker_token=? WHERE document_id=?").run(oldHelperToken, doc);
  assert.equal(store.getBinding(doc).workerTransport, null);
  assert.equal(store.db.prepare("SELECT worker_transport FROM bindings WHERE document_id=?").get(doc).worker_transport, "poll-v1");
  store.releaseWorker(doc, oldHelperToken);
  const next = store.claimWorker(doc, { pid: 103, isAlive: () => false, transport: "poll-v1" });
  assert.equal(store.getBinding(doc).workerTransport, "poll-v1");
  store.releaseWorker(doc, next.token);
  assert.equal(store.getBinding(doc).workerTransport, null);
});
test("upgrade coordinators use one atomic lease, hide its token and fence stale release", (t) => {
  const { store, path } = fixture(t);
  const second = new Store(path); t.after(() => second.close());
  const at = 100_000;
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator-one", isAlive: () => false, at });
  assert.equal(typeof lease, "string");
  assert.equal(store.getBinding(doc).upgradePending, true);
  assert.ok(!JSON.stringify(store.getBinding(doc)).includes(lease));
  const probes = [];
  assert.equal(second.claimUpgrade(doc, { pid: 202, identity: "coordinator-two", at: at + 120_000,
    isAlive: (pid, identity) => { probes.push([pid, identity]); return true; } }), null);
  assert.deepEqual(probes, [[201, "coordinator-one"]]);
  assert.equal(second.releaseUpgrade(doc, "wrong-token"), false);
  assert.equal(store.getBinding(doc).upgradePending, true);
  const replacement = second.claimUpgrade(doc, { pid: 202, identity: "coordinator-two", isAlive: () => false, at: at + 120_000 });
  assert.notEqual(replacement, lease);
  assert.equal(store.releaseUpgrade(doc, lease), false);
  assert.equal(store.getBinding(doc).upgradePending, true);
  assert.equal(second.releaseUpgrade(doc, replacement), true);
  assert.equal(store.getBinding(doc).upgradePending, false);
});
test("a dead upgrade coordinator retains its lease for exactly the 60-second handover grace", (t) => {
  const { store } = fixture(t);
  const at = 100_000;
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "dead-coordinator", isAlive: () => false, at });
  for (const elapsed of [0, 1, 59_999]) {
    assert.equal(store.claimUpgrade(doc, { pid: 202, identity: "replacement", isAlive: () => false, at: at + elapsed }), null);
  }
  assert.equal(store.db.prepare("SELECT token FROM worker_upgrades WHERE document_id=?").get(doc).token, lease);
  const replacement = store.claimUpgrade(doc, { pid: 202, identity: "replacement", isAlive: () => false, at: at + 60_000 });
  assert.equal(typeof replacement, "string");
  assert.notEqual(replacement, lease);
});
test("only a successful worker claim clears an upgrade lease after proving the prior worker gone", (t) => {
  const { store } = fixture(t);
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator", isAlive: () => false, at: 100_000 });
  assert.throws(() => store.claimWorker(doc, { pid: 102, isAlive: () => true, transport: "poll-v1" }), /worker_alive/);
  assert.equal(store.getBinding(doc).upgradePending, true);
  const next = store.claimWorker(doc, { pid: 102, isAlive: () => false, transport: "poll-v1" });
  assert.equal(store.getBinding(doc).upgradePending, false);
  assert.equal(store.getBinding(doc).workerTransport, "poll-v1");
  assert.equal(store.releaseUpgrade(doc, lease), false);
  assert.equal(store.getBinding(doc, { includeSecrets: true }).workerToken, next.token);
});
test("upgrade leases reject stopped reviews and invalid identities without changing the ledger", (t) => {
  const { store } = fixture(t);
  for (const change of [{ pid: 0 }, { identity: null }, { identity: "" }, { at: -1 }, { at: NaN }, { isAlive: null }]) {
    assert.throws(() => store.claimUpgrade(doc, { pid: 201, identity: "coordinator", at: 100_000, isAlive: () => false, ...change }), /invalid_/);
  }
  assert.equal(store.getBinding(doc).upgradePending, false);
  store.requestStop(doc);
  assert.throws(() => store.claimUpgrade(doc, { pid: 201, identity: "coordinator", at: 100_000, isAlive: () => false }), /review_inactive/);
  assert.equal(store.getBinding(doc).upgradePending, false);
});
test("the signal reservation survives lease replacement and release and is fenced to both owners", (t) => {
  const { store, token, path } = fixture(t);
  store.db.prepare("UPDATE bindings SET worker_identity=? WHERE document_id=?").run("old-birth", doc);
  const predecessor = { workerToken: token, pid: 101, identity: "old-birth" };
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator-one", isAlive: () => false, at: 0 });
  for (const change of [{ workerToken: "stale-worker" }, { pid: 102 }, { identity: "different-birth" }]) {
    assert.throws(() => store.claimUpgradeSignal(doc, lease, { ...predecessor, ...change }), /worker_fenced/);
  }
  assert.throws(() => store.claimUpgradeSignal(doc, "stale-lease", predecessor), /upgrade_fenced/);
  assert.equal(store.db.prepare("SELECT upgrade_signaled_token FROM bindings WHERE document_id=?").get(doc).upgrade_signaled_token, null);
  assert.equal(store.claimUpgradeSignal(doc, lease, predecessor), true);
  assert.equal(store.claimUpgradeSignal(doc, lease, predecessor), false);
  assert.ok(!JSON.stringify(store.getBinding(doc)).includes(token));
  const second = new Store(path); t.after(() => second.close());
  const replacement = second.claimUpgrade(doc, { pid: 202, identity: "coordinator-two", isAlive: () => false, at: 160000 });
  assert.throws(() => store.claimUpgradeSignal(doc, lease, predecessor), /upgrade_fenced/);
  assert.throws(() => store.cancelUnsentUpgradeSignal(doc, lease, predecessor), /upgrade_fenced/);
  assert.throws(() => second.cancelUnsentUpgradeSignal(doc, replacement, predecessor), /upgrade_signal_fenced/);
  assert.equal(second.claimUpgradeSignal(doc, replacement, predecessor), false);
  assert.equal(second.releaseUpgrade(doc, replacement), true);
  const third = store.claimUpgrade(doc, { pid: 203, identity: "coordinator-three", isAlive: () => false, at: 160001 });
  assert.equal(store.claimUpgradeSignal(doc, third, predecessor), false, "lease deletion cannot erase signal history");
});
test("only a new worker claim after predecessor exit clears the signal reservation", (t) => {
  const { store, token } = fixture(t);
  store.db.prepare("UPDATE bindings SET worker_identity=? WHERE document_id=?").run("old-birth", doc);
  const predecessor = { workerToken: token, pid: 101, identity: "old-birth" };
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator-one", isAlive: () => false, at: 0 });
  assert.equal(store.claimUpgradeSignal(doc, lease, predecessor), true);
  assert.throws(() => store.claimWorker(doc, { pid: 102, identity: "new-birth", isAlive: () => true }), /worker_alive/);
  assert.equal(store.claimUpgradeSignal(doc, lease, predecessor), false);
  const next = store.claimWorker(doc, { pid: 102, identity: "new-birth", isAlive: () => false });
  const row = store.db.prepare("SELECT upgrade_signaled_token,upgrade_signaled_pid,upgrade_signaled_identity,upgrade_signaled_lease FROM bindings WHERE document_id=?").get(doc);
  assert.deepEqual({ ...row }, { upgrade_signaled_token: null, upgrade_signaled_pid: null, upgrade_signaled_identity: null, upgrade_signaled_lease: null });
  const nextLease = store.claimUpgrade(doc, { pid: 202, identity: "coordinator-two", isAlive: () => false, at: 160000 });
  assert.throws(() => store.claimUpgradeSignal(doc, nextLease, predecessor), /worker_fenced/);
  assert.equal(store.claimUpgradeSignal(doc, nextLease, { workerToken: next.token, pid: 102, identity: "new-birth" }), true);
});
test("signal reservations reject inactive reviews and malformed identities before mutation", (t) => {
  const { store, token } = fixture(t);
  store.db.prepare("UPDATE bindings SET worker_identity=? WHERE document_id=?").run("old-birth", doc);
  const predecessor = { workerToken: token, pid: 101, identity: "old-birth" };
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator-one", isAlive: () => false, at: 0 });
  for (const change of [{ pid: 0 }, { identity: null }, { identity: "" }]) {
    assert.throws(() => store.claimUpgradeSignal(doc, lease, { ...predecessor, ...change }), /invalid_/);
  }
  assert.throws(() => store.claimUpgradeSignal(doc, null, predecessor), /invalid_upgrade_token/);
  store.requestStop(doc);
  assert.throws(() => store.claimUpgradeSignal(doc, lease, predecessor), /review_inactive/);
  assert.equal(store.db.prepare("SELECT upgrade_signaled_token FROM bindings WHERE document_id=?").get(doc).upgrade_signaled_token, null);
});
test("unsent signal cancellation requires its original lease and exact worker claim", (t) => {
  const { store, token } = fixture(t);
  store.db.prepare("UPDATE bindings SET worker_identity=? WHERE document_id=?").run("old-birth", doc);
  const predecessor = { workerToken: token, pid: 101, identity: "old-birth" };
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator", isAlive: () => false, at: 0 });
  store.claimUpgradeSignal(doc, lease, predecessor);
  for (const change of [{ workerToken: "stale-worker" }, { pid: 102 }, { identity: "different-birth" }]) {
    assert.throws(() => store.cancelUnsentUpgradeSignal(doc, lease, { ...predecessor, ...change }), /worker_fenced/);
  }
  assert.throws(() => store.cancelUnsentUpgradeSignal(doc, "stale-lease", predecessor), /upgrade_fenced/);
  assert.equal(store.claimUpgradeSignal(doc, lease, predecessor), false);
  assert.equal(store.cancelUnsentUpgradeSignal(doc, lease, predecessor), true);
  assert.equal(store.getBinding(doc).upgradePending, true, "cancellation does not release coordination ownership");
  const row = store.db.prepare("SELECT upgrade_signaled_token,upgrade_signaled_pid,upgrade_signaled_identity,upgrade_signaled_lease FROM bindings WHERE document_id=?").get(doc);
  assert.deepEqual({ ...row }, { upgrade_signaled_token: null, upgrade_signaled_pid: null, upgrade_signaled_identity: null, upgrade_signaled_lease: null });
  assert.equal(store.claimUpgradeSignal(doc, lease, predecessor), true, "an unsent reservation may be retried");
});
test("an earlier signal reservation without its writer lease migrates without becoming cancellable", (t) => {
  const { store, token, path } = fixture(t);
  store.db.prepare("UPDATE bindings SET worker_identity=? WHERE document_id=?").run("old-birth", doc);
  const predecessor = { workerToken: token, pid: 101, identity: "old-birth" };
  const lease = store.claimUpgrade(doc, { pid: 201, identity: "coordinator", isAlive: () => false, at: 0 });
  store.claimUpgradeSignal(doc, lease, predecessor);
  store.db.exec("ALTER TABLE bindings DROP COLUMN upgrade_signaled_lease");
  store.close();
  const migrated = new Store(path); t.after(() => migrated.close());
  assert.throws(() => migrated.cancelUnsentUpgradeSignal(doc, lease, predecessor), /upgrade_signal_fenced/);
  assert.equal(migrated.claimUpgradeSignal(doc, lease, predecessor), false);
  assert.equal(migrated.db.prepare("SELECT upgrade_signaled_token FROM bindings WHERE document_id=?").get(doc).upgrade_signaled_token, token);
});
test("poll-only binding persists a legacy-readable credential and refuses credential changes on rebind", (t) => {
  const { store } = fixture(t);
  const { url, protocols, ...base } = binding;
  const direct = { ...base, documentId: queueId, keyId: "poll-key", key: "A".repeat(43), pollUrl: POLL_URL };
  store.bind(direct);
  const read = store.getBinding(queueId, { includeSecrets: true });
  assert.equal(read.url, url);
  assert.equal(read.pollUrl, POLL_URL);
  assert.deepEqual(read.protocols, [SUBPROTOCOL, direct.key]);
  assert.equal("key" in read, false);
  assert.ok(!JSON.stringify(store.getBinding(queueId)).includes(direct.key));
  assert.deepEqual(store.bind({ ...direct, url, protocols: [SUBPROTOCOL, direct.key] }), store.getBinding(queueId));
  assert.throws(() => store.bind({ ...direct, key: "B".repeat(43) }), /rebind_refused/);
  assert.deepEqual(store.getBinding(doc, { includeSecrets: true }).protocols, protocols);
});
test("additive poll migration preserves pending work, receipts, lifecycle and legacy field values", (t) => {
  const { store, token, path } = fixture(t);
  store.transition(doc, "approve", { currentDigest: digest, evidence: "The task user approved this exact plan." });
  store.transition(doc, "execute", { currentDigest: digest, evidence: "The task user authorized implementation." });
  store.transition(doc, "checkpoint", { currentDigest: changedDigest, evidence: "Decision log records the implementation choice." });
  const started = processing(store, token, "completed");
  store.complete(doc, "completed", { operationToken: started.operationToken, evidence: { replyId: "reply-completed", planDigest: changedDigest } });
  processing(store, token, "pending");
  store.db.exec("PRAGMA user_version=32");
  for (const column of ["poll_url", "last_successful_poll_at", "last_event_at", "worker_transport", "worker_transport_token", "upgrade_signaled_token", "upgrade_signaled_pid", "upgrade_signaled_identity", "upgrade_signaled_lease"]) {
    store.db.exec(`ALTER TABLE bindings DROP COLUMN ${column}`);
  }
  store.db.exec("DROP TABLE worker_upgrades");
  const before = store.db.prepare("SELECT * FROM bindings").get();
  const events = store.db.prepare("SELECT * FROM events ORDER BY event_id").all();
  const receipts = store.db.prepare("SELECT * FROM acceptance_receipts").all();
  store.close();
  const migrated = new Store(path); t.after(() => migrated.close());
  const after = migrated.db.prepare("SELECT * FROM bindings").get();
  assert.equal(after.poll_url, POLL_URL);
  assert.equal(after.last_successful_poll_at, null);
  assert.equal(after.last_event_at, null);
  assert.equal(after.worker_transport, null);
  assert.equal(after.worker_transport_token, null);
  assert.equal(after.upgrade_signaled_token, null);
  assert.equal(after.upgrade_signaled_pid, null);
  assert.equal(after.upgrade_signaled_identity, null);
  assert.equal(after.upgrade_signaled_lease, null);
  for (const [key, value] of Object.entries(before)) assert.deepEqual(after[key], value, key);
  assert.deepEqual(migrated.db.prepare("SELECT * FROM events ORDER BY event_id").all(), events);
  assert.deepEqual(migrated.db.prepare("SELECT * FROM acceptance_receipts").all(), receipts);
  assert.equal(migrated.db.prepare("PRAGMA user_version").get().user_version, 32);
  assert.equal(migrated.getBinding(doc).upgradePending, false);
  assert.equal(migrated.getBinding(doc).planPhase, "executing");
  assert.equal(migrated.getBinding(doc).acceptedDigest, digest);
  assert.equal(migrated.getBinding(doc).planDigest, changedDigest);
  assert.equal(migrated.getBinding(doc, { includeSecrets: true }).workerToken, token);
});
test("migration never rewrites foreign legacy endpoints or promotes malformed credentials", (t) => {
  const { store, path } = fixture(t);
  store.bind({ ...binding, documentId: queueId });
  store.db.prepare("UPDATE bindings SET url=?,poll_url=NULL WHERE document_id=?").run("wss://other.example/events", doc);
  store.db.prepare("UPDATE bindings SET protocols=?,poll_url=NULL WHERE document_id=?").run(JSON.stringify([SUBPROTOCOL, "bad\nheader"]), queueId);
  const before = store.db.prepare("SELECT * FROM bindings ORDER BY document_id").all();
  store.close();
  const migrated = new Store(path); t.after(() => migrated.close());
  assert.deepEqual(migrated.db.prepare("SELECT * FROM bindings ORDER BY document_id").all(), before);
  assert.equal(migrated.getBinding(doc).pollUrl, null);
  assert.equal(migrated.getBinding(queueId).pollUrl, null);
});
test("interrupted live task requires explicit inspection and fresh operation token before remaining effects continue", (t) => {
  const { store, token } = fixture(t); const first = processing(store, token);
  assert.throws(() => store.recover(doc, "event-1", { decision: "interrupt" }), /invalid_evidence/);
  store.recover(doc, "event-1", { decision: "interrupt", evidence: "Human confirmed the agent turn ended before its receipt." });
  assert.equal(store.listEvents(doc)[0].state, "effect_uncertain");
  assert.equal(store.nextEvent(doc, token), null);
  assert.throws(() => store.recover(doc, "event-1", { decision: "continue" }), /invalid_evidence/);
  const continued = store.recover(doc, "event-1", { decision: "continue", evidence: "Inspected board: plan is revised; only the missing reply remains authorized." });
  assert.notEqual(continued.operationToken, first.operationToken);
  assert.equal(continued.event.recoveryEvidence.length, 2);
  assert.equal(continued.event.recoveryEvidence[0].decision, "interrupt");
  assert.equal(store.nextEvent(doc, token), null);
  assert.throws(() => store.complete(doc, "event-1", { operationToken: first.operationToken, evidence: { replyId: "reply", planDigest: digest } }), /operation_fenced/);
  store.complete(doc, "event-1", { operationToken: continued.operationToken, evidence: { replyId: "remaining-reply", planDigest: changedDigest } });
  assert.equal(store.listEvents(doc)[0].state, "completed");
});
test("digest status-element exclusions persist and cannot silently change on rebind", (t) => {
  const { store } = fixture(t);
  assert.deepEqual(store.getBinding(doc).statusElementIds, []);
  assert.throws(() => store.bind({ ...binding, statusElementIds: [queueId] }), /rebind_refused/);
  store.bind({ ...binding, documentId: queueId, statusElementIds: [doc] });
  assert.deepEqual(store.getBinding(queueId).statusElementIds, [doc]);
});
test("owner acceptance older than the clock allowance cannot accept even an identical hash", (t) => {
  const { store, token } = fixture(t);
  const old = { ...event(), createdAt: new Date(Date.parse(store.getBinding(doc).planVersionAt) - ACCEPTANCE_CLOCK_SKEW_MS - 1).toISOString() };
  store.receive(doc, old, token); store.markDispatching(doc, old.id, token);
  const started = store.begin(doc, old.id, { expectedThreadId: task });
  assert.throws(() => store.accept(doc, old.id, acceptArgs(started)), /acceptance_predates_plan_version/);
});
test("a delayed inbox emission cannot make an older human comment approve a newer plan", (t) => {
  const baseline = Date.parse("2026-09-19T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseline });
  const { store, token } = fixture(t);
  const humanCreatedAt = new Date(baseline - 60000).toISOString();
  t.mock.timers.setTime(baseline + 1000);
  const started = processing(store, token);
  assert.ok(Date.parse(started.event.createdAt) > Date.parse(store.getBinding(doc).planVersionAt));
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started, { humanCreatedAt })), /acceptance_predates_plan_version/);
  assert.equal(store.getBinding(doc).planPhase, "proposed");
  assert.equal(store.getBinding(doc).acceptanceReceipts.length, 0);
});
test("acceptance refuses a missing or invalid verified human creation timestamp", (t) => {
  const { store, token } = fixture(t);
  const started = processing(store, token);
  for (const humanCreatedAt of [undefined, null, "", "not-a-time", 123, "2026-09-19"]) {
    assert.throws(() => store.accept(doc, "event-1", acceptArgs(started, { humanCreatedAt })), /invalid_acceptance_time/);
  }
  assert.equal(store.getBinding(doc).acceptanceReceipts.length, 0);
});
test("human approval time allows at most five seconds of forward server skew", (t) => {
  const baseline = Date.parse("2026-09-19T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseline });
  const { store, token } = fixture(t);
  const started = processing(store, token);
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started, {
    humanCreatedAt: new Date(baseline + ACCEPTANCE_CLOCK_SKEW_MS + 1).toISOString()
  })), /acceptance_time_in_future/);
  const accepted = store.accept(doc, "event-1", acceptArgs(started, {
    humanCreatedAt: new Date(baseline + ACCEPTANCE_CLOCK_SKEW_MS).toISOString()
  }));
  assert.equal(accepted.planPhase, "accepted");
});
test("owner acceptance tolerates bounded server clock skew without relaxing version checks", (t) => {
  assert.equal(ACCEPTANCE_CLOCK_SKEW_MS, 5000);
  for (const millisecondsBefore of [0, 1, 4999, 5000]) {
    const { store, token } = fixture(t);
    const feedback = { ...event(), createdAt: new Date(Date.parse(store.getBinding(doc).planVersionAt) - millisecondsBefore).toISOString() };
    store.receive(doc, feedback, token); store.markDispatching(doc, feedback.id, token);
    const started = store.begin(doc, feedback.id, { expectedThreadId: task });
    assert.throws(() => store.accept(doc, feedback.id, acceptArgs(started, { currentDigest: changedDigest })), /digest_mismatch/);
    const result = store.accept(doc, feedback.id, acceptArgs(started, { humanText: ` @agent: ${acceptancePhrase(digest)}.\n` }));
    assert.equal(result.status, "active");
    assert.equal(result.planPhase, "accepted");
    assert.equal(result.acceptedDigest, digest);
  }
});
test("acceptance received before a later revision cannot approve that revision inside the server clock allowance", (t) => {
  const baseline = Date.parse("2026-09-05T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseline });
  const { store, token } = fixture(t);
  const revision = processing(store, token, "revision");
  t.mock.timers.setTime(baseline + 1000);
  store.receive(doc, event("acceptance"), token);
  t.mock.timers.setTime(baseline + 2000);
  store.complete(doc, "revision", { operationToken: revision.operationToken, evidence: { replyId: "revision-reply", planDigest: changedDigest } });
  store.markDispatching(doc, "acceptance", token);
  const approval = store.begin(doc, "acceptance", { expectedThreadId: task });
  assert.equal(Date.parse(store.getBinding(doc).planVersionAt) - Date.parse(approval.event.createdAt), 1000);
  assert.throws(() => store.accept(doc, "acceptance", acceptArgs(approval, {
    humanText: "I accept this plan.", currentDigest: changedDigest, submittedPlanDigest: changedDigest
  })), /acceptance_predates_plan_version/);
  assert.equal(store.getBinding(doc).status, "active");
});
test("a prior reply without a digest change does not invalidate already received acceptance", (t) => {
  const baseline = Date.parse("2026-09-05T12:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseline });
  const { store, token } = fixture(t);
  const reply = processing(store, token, "clarification");
  t.mock.timers.setTime(baseline + 1000);
  store.receive(doc, event("acceptance"), token);
  t.mock.timers.setTime(baseline + 2000);
  store.complete(doc, "clarification", { operationToken: reply.operationToken, evidence: { replyId: "clarification-reply", planDigest: digest } });
  store.markDispatching(doc, "acceptance", token);
  const approval = store.begin(doc, "acceptance", { expectedThreadId: task });
  assert.equal(Date.parse(store.getBinding(doc).planVersionAt), baseline);
  assert.equal(store.accept(doc, "acceptance", acceptArgs(approval, { humanText: "I accept this plan." })).planPhase, "accepted");
});
test("plan-version timestamp advances only when completion changes the digest", async (t) => {
  const { store, token } = fixture(t); const initial = store.getBinding(doc).planVersionAt;
  const first = processing(store, token);
  await new Promise((resolve) => setTimeout(resolve, 5));
  store.complete(doc, "event-1", { operationToken: first.operationToken, evidence: { replyId: "reply-1", planDigest: digest } });
  assert.equal(store.getBinding(doc).planVersionAt, initial);
  const second = processing(store, token, "event-2");
  store.complete(doc, "event-2", { operationToken: second.operationToken, evidence: { replyId: "reply-2", planDigest: changedDigest } });
  assert.ok(store.getBinding(doc).planVersionAt > initial);
});
test("store rejects directory/database/WAL/SHM symlinks without chmod or writes to their targets", (t) => {
  const base = mkdtempSync(join(tmpdir(), "unpaged-symlink-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const target = join(base, "sentinel"); writeFileSync(target, "unchanged", { mode: 0o644 });
  const targetBefore = { content: readFileSync(target), mode: statSync(target).mode & 0o777 };
  for (const suffix of ["", "-wal", "-shm"]) {
    const directory = join(base, `case-${suffix || "db"}`); mkdirSync(directory);
    const path = join(directory, "reviews.sqlite"); symlinkSync(target, path + suffix);
    assert.throws(() => new Store(path), /unsafe_store_path/);
    assert.deepEqual(readFileSync(target), targetBefore.content);
    assert.equal(statSync(target).mode & 0o777, targetBefore.mode);
  }
  const targetDirectory = join(base, "target-directory"); mkdirSync(targetDirectory); chmodSync(targetDirectory, 0o755);
  const link = join(base, "directory-link"); symlinkSync(targetDirectory, link);
  assert.throws(() => new Store(join(link, "reviews.sqlite")), /unsafe_store_path/);
  assert.equal(statSync(targetDirectory).mode & 0o777, 0o755);
});
