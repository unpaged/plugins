import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareHandover } from "./handover.mjs";
import { Store } from "./store.mjs";
import { EVENTS_URL, SUBPROTOCOL } from "./protocol.mjs";

const documentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fixture() {
  let clock = 0;
  const processes = new Map([[10, "old-birth"], [20, "new-birth"]]);
  const binding = { status: "active", workerPid: 10, workerIdentity: "old-birth", workerToken: "old-claim", workerTransport: null };
  const signals = [];
  const releases = [];
  let claims = 0;
  const options = {
    pid: 20,
    identify: (pid) => processes.get(pid) ?? null,
    isAlive: (pid, identity) => processes.get(pid) === identity && typeof identity === "string",
    now: () => clock,
    sleep: async (ms) => { clock += ms; processes.delete(10); },
    kill: (pid, signal) => signals.push([pid, signal]),
    store: {
      getBinding: () => ({ ...binding }),
      claimUpgrade: () => { claims++; return "lease-token"; },
      claimUpgradeSignal: () => true,
      releaseUpgrade: (id, token) => releases.push([id, token])
    }
  };
  return { options, binding, signals, processes, releases, advance: (ms) => { clock += ms; }, get claims() { return claims; } };
}

test("verified legacy handover signals once and waits for the predecessor before releasing its lease", async () => {
  const f = fixture();
  let waited = 0;
  f.options.sleep = async (ms) => {
    waited++;
    f.advance(ms);
    if (waited === 5) f.processes.delete(10);
  };
  assert.equal(await prepareHandover("board", f.options), true);
  assert.equal(waited, 5);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.deepEqual(f.releases, [["board", "lease-token"]]);
});

test("a live polling receiver is preserved without a lease or signal", async () => {
  const f = fixture();
  f.binding.workerTransport = "poll-v1";
  assert.equal(await prepareHandover("board", f.options), false);
  assert.equal(f.claims, 0);
  assert.deepEqual(f.signals, []);
});

test("a missing or recycled predecessor needs no signal", async () => {
  for (const actual of [null, "different-birth"]) {
    const f = fixture();
    f.processes.set(10, actual);
    assert.equal(await prepareHandover("board", f.options), true);
    assert.deepEqual(f.signals, []);
  }
});

test("unknown kernel identity refuses to signal or claim a replacement", async () => {
  const f = fixture();
  f.options.isAlive = () => true;
  f.options.identify = () => undefined;
  await assert.rejects(prepareHandover("board", f.options), /worker_identity_unverifiable/);
  assert.equal(f.claims, 0);
  assert.deepEqual(f.signals, []);
});

test("a changed private claim is rechecked immediately before signalling", async () => {
  const f = fixture();
  f.options.store.claimUpgrade = () => { f.binding.workerPid = 30; return "lease-token"; };
  assert.equal(await prepareHandover("board", f.options), false);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.releases, [["board", "lease-token"]]);
});

test("a competing handover is waited out without a duplicate signal", async () => {
  const f = fixture();
  f.options.store.claimUpgrade = () => null;
  f.options.sleep = async (ms) => {
    f.advance(ms);
    f.binding.workerTransport = "poll-v1";
  };
  assert.equal(await prepareHandover("board", f.options), false);
  assert.deepEqual(f.signals, []);
  assert.deepEqual(f.releases, []);
});

test("aborting after a signal keeps the upgrade pending while the old queue may settle", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.sleep = async () => controller.abort();
  assert.equal(await prepareHandover("board", f.options), false);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.deepEqual(f.releases, []);
});

function persistedFixture(t) {
  const f = fixture();
  const directory = mkdtempSync(join(tmpdir(), "unpaged-handover-test-"));
  const path = join(directory, "reviews.sqlite");
  const stores = [];
  const open = () => { const store = new Store(path); stores.push(store); return store; };
  const store = open();
  t.after(() => { for (const db of stores) { try { db.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  store.bind({ documentId, threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", keyId: "key-1",
    url: EVENTS_URL, protocols: [SUBPROTOCOL, "TEST_SECRET_CREDENTIAL"], codexPath: "/test/codex", planDigest: "a".repeat(64) });
  const { token } = store.claimWorker(documentId, { pid: 10, identity: "old-birth", isAlive: () => false });
  f.options.store = store;
  f.options.sleep = async (ms) => f.advance(ms);
  return { ...f, store, token, open };
}

test("a 150-second timeout and expired coordinator lease never re-signal the same persisted worker", async (t) => {
  const f = persistedFixture(t);
  f.store.receive(documentId, { id: "pending-event", documentId, nodeId: "root", threadId: "comment-thread",
    commentId: "comment", reason: "mention", authorRole: "owner", resolved: false, createdAt: new Date().toISOString() }, f.token);
  f.store.markDispatching(documentId, "pending-event", f.token);
  const pending = f.store.listEvents(documentId);
  assert.equal(await prepareHandover(documentId, f.options), false);
  assert.equal(f.options.now(), 150000);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.equal(f.store.getBinding(documentId).upgradePending, true);
  f.store.close();
  f.processes.delete(20);
  f.processes.set(30, "second-coordinator");
  f.advance(10000);
  const reopened = f.open();
  assert.equal(await prepareHandover(documentId, { ...f.options, store: reopened, pid: 30 }), false);
  assert.equal(f.options.now(), 310000, "the later coordinator also has a bounded 150-second wait");
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.equal(reopened.getBinding(documentId, { includeSecrets: true }).workerToken, f.token);
  assert.equal(reopened.getBinding(documentId).status, "active");
  assert.equal(reopened.getBinding(documentId).credentialsPresent, true);
  assert.deepEqual(reopened.listEvents(documentId), pending);
  reopened.markQueued(documentId, "pending-event", f.token, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(reopened.listEvents(documentId)[0].state, "queued", "the predecessor can still finish its receipt");
});

test("a coordinator crash after signalling lets its successor observe exit without a second signal", async (t) => {
  const f = persistedFixture(t);
  f.options.sleep = async () => { throw new Error("coordinator-crashed"); };
  await assert.rejects(prepareHandover(documentId, f.options), /coordinator-crashed/);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  f.processes.delete(20);
  f.processes.set(30, "second-coordinator");
  f.advance(60000);
  const reopened = f.open();
  assert.equal(await prepareHandover(documentId, { ...f.options, store: reopened, pid: 30,
    sleep: async (ms) => { f.advance(ms); f.processes.delete(10); }
  }), true);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.equal(reopened.getBinding(documentId).upgradePending, false);
});

test("a crash after signal reservation but before OS delivery stays pending instead of replaying intent", async (t) => {
  const f = persistedFixture(t);
  f.options.kill = () => { throw new Error("coordinator-crashed-before-signal"); };
  await assert.rejects(prepareHandover(documentId, f.options), /worker_handover_unavailable/);
  f.processes.delete(20);
  f.processes.set(30, "second-coordinator");
  f.advance(60000);
  const reopened = f.open();
  assert.equal(await prepareHandover(documentId, { ...f.options, store: reopened, pid: 30, timeoutMs: 200,
    kill: (pid, signal) => f.signals.push([pid, signal])
  }), false);
  assert.equal(f.options.now(), 60200);
  assert.deepEqual(f.signals, []);
  assert.equal(reopened.getBinding(documentId).upgradePending, true);
});

test("handover timeout and explicit review stop never force-kill the old worker", async () => {
  for (const stop of [false, true]) {
    const f = fixture();
    f.options.timeoutMs = 200;
    f.options.sleep = async (ms) => { f.advance(ms); if (stop) f.binding.status = "stopped"; };
    assert.equal(await prepareHandover("board", f.options), false);
    assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
    assert.deepEqual(f.releases, []);
  }
});
