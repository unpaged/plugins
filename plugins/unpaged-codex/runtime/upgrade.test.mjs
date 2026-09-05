import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { retainRuntime } from "./snapshot.mjs";
import { Store } from "./store.mjs";

const pluginSource = fileURLToPath(new URL("../", import.meta.url));
const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const DIGEST = "a".repeat(64);
const SECRET = "upgrade-test-listener-secret";
const frame = (id) => JSON.stringify({
  type: "agent-inbox-event", id, documentId: DOCUMENT, nodeId: "node-1",
  threadId: `thread-${id}`, commentId: `comment-${id}`, authorRole: "owner",
  reason: "mention", resolved: false, createdAt: new Date().toISOString(),
  documentTitle: "Test board", nodeTitle: "Test node", authorName: "Test owner",
  textPreview: "Synthetic test feedback", boardUrl: "https://unpaged.io/test", anchorElementId: null
});
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("test condition timed out");
    await pause(5);
  }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "unpaged-upgrade-test-")));
  const data = join(root, "private-data");
  const cache = join(root, "plugin-cache");
  const store = new Store(join(data, "reviews.sqlite"));
  const workers = [];
  t.after(async () => {
    for (const worker of workers) worker.controller.abort();
    await Promise.all(workers.map((worker) => worker.done));
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await cp(pluginSource, cache, { recursive: true });
  store.bind({ documentId: DOCUMENT, threadId: TASK, keyId: "upgrade-test-key",
    url: "wss://mcp.unpaged.io/events", protocols: ["unpaged-listener.v1", SECRET],
    codexPath: process.execPath, planDigest: DIGEST });

  async function start(workerPath) {
    // Execute the actual copied worker and its copied dependencies. Only the
    // socket and Codex queue boundary are fake; no network or model is started.
    const { runWorker } = await import(pathToFileURL(workerPath).href);
    const sockets = [];
    const calls = [];
    const controller = new AbortController();
    class Socket extends EventTarget {
      constructor() { super(); sockets.push(this); }
      open() { this.dispatchEvent(new Event("open")); }
      message(raw) { this.dispatchEvent(new MessageEvent("message", { data: raw })); }
      close() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
    }
    const execFile = (binary, args, options, callback) => {
      const queueId = randomUUID();
      assert.equal(binary, process.execPath);
      assert.equal(options.shell, false);
      assert.deepEqual(args.slice(0, 4), ["queue", "--thread", TASK, "--message"]);
      assert.ok(!args[4].includes(SECRET));
      calls.push({ message: args[4], queueId });
      callback(null, `Queued message ${queueId} for thread ${TASK}.\n`, "");
      return { kill() {} };
    };
    const done = runWorker(DOCUMENT, { dataDir: data, Socket, execFile,
      signal: controller.signal, pollMs: 10 });
    const worker = { controller, done, calls, sockets };
    workers.push(worker);
    assert.equal(sockets.length, 1);
    sockets[0].open();
    return worker;
  }

  async function newerCache() {
    const next = join(root, "new-plugin-cache");
    await cp(pluginSource, next, { recursive: true });
    const skill = join(next, "skills/review-plan/SKILL.md");
    await writeFile(skill, (await readFile(skill, "utf8")) + "\nNew compatible fixture guidance.\n");
    return next;
  }

  async function launch() {
    const { ensureWorker } = await import(pathToFileURL(join(cache, "runtime/cli.mjs")).href);
    let worker;
    let workerPath;
    await ensureWorker(store, DOCUMENT, data, { spawn(binary, args, options) {
      assert.equal(binary, process.execPath);
      assert.equal(options.shell, false);
      assert.equal(options.detached, true);
      assert.deepEqual(args.slice(1), [DOCUMENT, "--data", data]);
      workerPath = args[0];
      const child = new EventEmitter();
      child.unref = () => {};
      start(workerPath).then((started) => {
        worker = started;
        child.emit("spawn");
      }, (error) => child.emit("error", error));
      return child;
    } });
    assert.ok(worker, "normal startup must launch the retained worker");
    return { ...worker, workerPath };
  }
  return { root, data, cache, store, start, newerCache, launch };
}

function queuedPaths(message) {
  const skill = /skill at ("[^\n]+?")\. Use the current Node executable/.exec(message);
  const begin = /shell:false to begin: (\[[^\n]+\])\. Preserve its operation token/.exec(message);
  assert.ok(skill, "queued prompt must identify the retained review skill");
  assert.ok(begin, "queued prompt must identify executable begin arguments");
  return { skill: JSON.parse(skill[1]), begin: JSON.parse(begin[1]) };
}

function command(args, input) {
  const child = spawnSync(process.execPath, args, {
    env: { ...process.env, CODEX_THREAD_ID: TASK }, shell: false,
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: "utf8", timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr.includes(SECRET), false);
  return JSON.parse(child.stdout);
}

function finishQueued(paths, data, eventId) {
  const started = command(paths.begin);
  assert.ok(started.operationToken);
  return command([paths.begin[0], "complete", DOCUMENT, eventId, "--data", data], {
    operationToken: started.operationToken,
    evidence: { replyId: `test-reply-${eventId}`, planDigest: DIGEST }
  });
}

test("queued snapshot CLI and both linked skills survive deletion of the installed plugin cache", async (t) => {
  const f = await fixture(t);
  const worker = await f.launch();
  const { workerPath } = worker;
  assert.ok(workerPath.startsWith(join(f.data, "runtimes") + "/"));
  worker.sockets[0].message(frame("old-event"));
  await until(() => f.store.listEvents(DOCUMENT)[0]?.state === "queued");
  const paths = queuedPaths(worker.calls[0].message);
  assert.equal(paths.begin[0], join(dirname(workerPath), "cli.mjs"));
  assert.equal(paths.skill, join(dirname(dirname(workerPath)), "skills/review-plan/SKILL.md"));
  await rm(f.cache, { recursive: true });
  assert.ok((await readFile(paths.skill, "utf8")).includes("../visual-plan/SKILL.md"));
  assert.ok((await readFile(join(dirname(paths.skill), "../visual-plan/SKILL.md"), "utf8")).includes("name: visual-plan"));
  const completed = finishQueued(paths, f.data, "old-event");
  assert.equal(completed.state, "completed");
  assert.equal(completed.queueId, worker.calls[0].queueId);
  worker.sockets[0].message(frame("old-event"));
  await pause();
  assert.equal(worker.calls.length, 1);
});

test("a newer snapshot preserves an older queued receipt and lets its original CLI finish before dispatching again", async (t) => {
  const f = await fixture(t);
  const oldPath = await retainRuntime(f.data, f.cache);
  const old = await f.start(oldPath);
  old.sockets[0].message(frame("old-event"));
  await until(() => f.store.listEvents(DOCUMENT)[0]?.state === "queued");
  const paths = queuedPaths(old.calls[0].message);
  const queueId = old.calls[0].queueId;
  old.controller.abort();
  await old.done;

  const nextCache = await f.newerCache();
  const nextPath = await retainRuntime(f.data, nextCache);
  assert.notEqual(nextPath, oldPath);
  await rm(f.cache, { recursive: true });
  await rm(nextCache, { recursive: true });
  const next = await f.start(nextPath);
  next.sockets[0].message(frame("old-event"));
  next.sockets[0].message(frame("next-event"));
  await pause();
  assert.equal(next.calls.length, 0);
  assert.equal(f.store.listEvents(DOCUMENT)[0].state, "queued");
  assert.equal(f.store.listEvents(DOCUMENT)[0].queueId, queueId);
  assert.equal(f.store.getBinding(DOCUMENT).reconciliationRequired, true);
  assert.equal(finishQueued(paths, f.data, "old-event").queueId, queueId);
  await until(() => next.calls.length === 1);
  const nextQueued = queuedPaths(next.calls[0].message);
  assert.equal(nextQueued.begin[0], join(dirname(nextPath), "cli.mjs"));
  assert.equal(f.store.listEvents(DOCUMENT)[1].id, "next-event");
  assert.equal(old.calls.length, 1);
});

test("a live legacy worker remains on its cache paths and is not silently replaced by ensureWorker", async (t) => {
  const f = await fixture(t);
  const legacy = await f.start(join(f.cache, "runtime/worker.mjs"));
  const nextCache = await f.newerCache();
  const { ensureWorker } = await import(pathToFileURL(join(nextCache, "runtime/cli.mjs")).href);
  const before = f.store.getBinding(DOCUMENT);
  await rm(f.cache, { recursive: true });
  const after = await ensureWorker(f.store, DOCUMENT, f.data, {
    spawn() { assert.fail("a live worker must not be replaced during installation"); }
  });
  assert.equal(after.workerPid, before.workerPid);
  assert.equal(after.threadId, TASK);
  assert.equal(after.keyId, before.keyId);
  await assert.rejects(lstat(join(f.data, "runtimes")), { code: "ENOENT" });
  legacy.sockets[0].message(frame("legacy-event"));
  await until(() => legacy.calls.length === 1);
  const paths = queuedPaths(legacy.calls[0].message);
  assert.equal(paths.begin[0], join(f.cache, "runtime/cli.mjs"));
  await assert.rejects(lstat(paths.begin[0]), { code: "ENOENT" });
});

test("ensureWorker refuses an identity-less live legacy claim without spawning or changing its binding", async (t) => {
  const f = await fixture(t);
  await f.start(join(f.cache, "runtime/worker.mjs"));
  // Old pilots recorded only a PID, even when that process was still alive.
  f.store.db.prepare("UPDATE bindings SET worker_identity=NULL WHERE document_id=?").run(DOCUMENT);
  const before = f.store.getBinding(DOCUMENT);
  assert.equal(before.workerPid, process.pid);
  assert.equal(before.workerIdentity, null);
  const { ensureWorker } = await import(pathToFileURL(join(f.cache, "runtime/cli.mjs")).href);
  let spawnCalls = 0;
  await assert.rejects(ensureWorker(f.store, DOCUMENT, f.data, {
    spawn() { spawnCalls++; assert.fail("a possibly live legacy worker must not be replaced"); }
  }), /worker_identity_unverifiable/);
  assert.equal(spawnCalls, 0);
  const after = f.store.getBinding(DOCUMENT);
  assert.equal(after.workerPid, before.workerPid);
  assert.equal(after.workerIdentity, null);
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.keyId, before.keyId);
  assert.equal(after.status, before.status);
  await assert.rejects(lstat(join(f.data, "runtimes")), { code: "ENOENT" });
});
