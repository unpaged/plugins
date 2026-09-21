import assert from "node:assert/strict";
import test from "node:test";
import { prepareHandover } from "./handover.mjs";

function fixture() {
  let clock = 0;
  const processes = new Map([[10, "old-birth"], [20, "new-birth"]]);
  const binding = { status: "active", workerPid: 10, workerIdentity: "old-birth", workerTransport: null };
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

test("aborting after a signal keeps the lease grace period while the old queue may settle", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.options.signal = controller.signal;
  f.options.sleep = async () => controller.abort();
  assert.equal(await prepareHandover("board", f.options), false);
  assert.deepEqual(f.signals, [[10, "SIGTERM"]]);
  assert.deepEqual(f.releases, []);
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
