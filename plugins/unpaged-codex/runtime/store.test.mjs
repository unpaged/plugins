import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "./store.mjs";
import { acceptancePhrase, CODEX_PATH, EVENTS_URL } from "./protocol.mjs";

const doc = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", task = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const digest = "a".repeat(64), changedDigest = "b".repeat(64), queueId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const binding = { documentId: doc, threadId: task, keyId: "key-1", url: EVENTS_URL,
  protocols: ["unpaged-listener.v1", "TEST_SECRET_CREDENTIAL"], codexPath: CODEX_PATH, planDigest: digest };
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
function acceptArgs(operationToken, extras = {}) {
  return { operationToken, humanText: acceptancePhrase(digest), currentDigest: digest, submittedPlanDigest: digest, ...extras };
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
test("acceptance requires owner, exact full phrase, unchanged digest, current operation and no gap", (t) => {
  const { store, token } = fixture(t); const started = processing(store, token);
  for (const humanText of ["Looks good", "I accept", acceptancePhrase(digest) + "\n", acceptancePhrase(digest).toLowerCase()]) {
    assert.throws(() => store.accept(doc, "event-1", acceptArgs(started.operationToken, { humanText })), /explicit_acceptance_required/);
  }
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started.operationToken, { currentDigest: changedDigest })), /digest_mismatch/);
  store.markReconciliationRequired(doc, token, "socket_reconnected");
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started.operationToken)), /reconciliation_required/);
  assert.throws(() => store.reconcile(doc, { evidence: "" }), /invalid_evidence/);
  store.reconcile(doc, { evidence: "MCP thread sweep checked current owner comments; no unhandled gap remains." });
  const accepted = store.accept(doc, "event-1", acceptArgs(started.operationToken, { humanText: `@agent ${acceptancePhrase(digest)}` }));
  assert.equal(accepted.status, "accepted"); assert.equal(accepted.acceptedDigest, digest); assert.equal(accepted.cleanupRequired, true);
  assert.equal(store.nextEvent(doc, token), null);
  assert.throws(() => store.complete(doc, "event-1", { operationToken: started.operationToken, evidence: { replyId: "reply", planDigest: changedDigest } }), /accepted_plan_changed/);
  store.complete(doc, "event-1", { operationToken: started.operationToken, evidence: { replyId: "accept-reply", planDigest: digest } });
});
test("editor/viewer comments and outstanding received events cannot accept a plan", (t) => {
  for (const role of ["editor", "viewer"]) {
    const { store, token } = fixture(t); const started = processing(store, token, "event-1", role);
    assert.throws(() => store.accept(doc, "event-1", acceptArgs(started.operationToken)), /owner_acceptance_required/);
  }
  const { store, token } = fixture(t); const started = processing(store, token);
  store.receive(doc, event("event-2"), token);
  assert.throws(() => store.accept(doc, "event-1", acceptArgs(started.operationToken)), /outstanding_events/);
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
test("owner acceptance created before this plan version cannot accept even an identical hash", (t) => {
  const { store, token } = fixture(t);
  const old = { ...event(), createdAt: new Date(Date.parse(store.getBinding(doc).planVersionAt) - 1).toISOString() };
  store.receive(doc, old, token); store.markDispatching(doc, old.id, token);
  const started = store.begin(doc, old.id, { expectedThreadId: task });
  assert.throws(() => store.accept(doc, old.id, acceptArgs(started.operationToken)), /acceptance_predates_plan_version/);
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
  for (const suffix of ["", "-wal", "-shm"]) {
    const directory = join(base, `case-${suffix || "db"}`); mkdirSync(directory);
    const path = join(directory, "reviews.sqlite"); symlinkSync(target, path + suffix);
    assert.throws(() => new Store(path), /unsafe_store_path/);
    assert.equal(readFileSync(target, "utf8"), "unchanged");
    assert.equal(statSync(target).mode & 0o777, 0o644);
  }
  const targetDirectory = join(base, "target-directory"); mkdirSync(targetDirectory); chmodSync(targetDirectory, 0o755);
  const link = join(base, "directory-link"); symlinkSync(targetDirectory, link);
  assert.throws(() => new Store(join(link, "reviews.sqlite")), /unsafe_store_path/);
  assert.equal(statSync(targetDirectory).mode & 0o777, 0o755);
});
