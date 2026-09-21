import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { Store } from "./store.mjs";
import { runWorker } from "./worker.mjs";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const QUEUE = "33333333-3333-4333-8333-333333333333";
const DIGEST = "a".repeat(64);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("handover condition timed out");
    await pause(20);
  }
}

test("real legacy receiver settles its queue receipt before the polling receiver takes over", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "unpaged-real-handover-"));
  const legacy = join(root, "legacy");
  const data = join(root, "data");
  await mkdir(legacy);
  execFileSync("tar", ["-xzf", fileURLToPath(new URL("./fixtures/codex-0.3.2.tar.gz", import.meta.url)), "-C", legacy]);
  const { Store: LegacyStore } = await import(pathToFileURL(join(legacy, "runtime/store.mjs")).href);
  const oldStore = new LegacyStore(join(data, "reviews.sqlite"));
  oldStore.bind({ documentId: DOCUMENT, threadId: TASK, keyId: "fixture-key", planDigest: DIGEST,
    codexPath: process.execPath, url: "wss://mcp.unpaged.io/events", protocols: ["unpaged-listener.v1", "synthetic-fixture-key"] });
  oldStore.close();
  const frame = { type: "agent-inbox-event", id: "old-event", documentId: DOCUMENT, nodeId: "node",
    threadId: "comment-thread", commentId: "comment", reason: "mention", authorRole: "owner", resolved: false,
    createdAt: new Date().toISOString(), documentTitle: "Fixture", nodeTitle: "Fixture", authorName: "Fixture",
    textPreview: "Synthetic test", boardUrl: "https://unpaged.io/test", anchorElementId: null };
  const script = `
    import { runWorker } from ${JSON.stringify(pathToFileURL(join(legacy, "runtime/worker.mjs")).href)};
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort());
    class Socket extends EventTarget {
      constructor() { super(); queueMicrotask(() => {
        this.dispatchEvent(new Event("open"));
        this.dispatchEvent(new MessageEvent("message", { data: ${JSON.stringify(JSON.stringify(frame))} }));
      }); }
      close() { this.dispatchEvent(Object.assign(new Event("close"), { code: 1000 })); }
    }
    const result = await runWorker(${JSON.stringify(DOCUMENT)}, {
      dataDir: ${JSON.stringify(data)}, Socket, signal: controller.signal, pollMs: 10,
      execFile(_binary, _args, _options, callback) {
        process.send("dispatching");
        setTimeout(() => callback(null, ${JSON.stringify(`Queued message ${QUEUE} for thread ${TASK}.\n`)}, ""), 750);
      }
    });
    process.send({ settled: result.reason });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], shell: false
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const messages = [];
  child.on("message", (message) => messages.push(message));
  const exited = once(child, "exit");
  const controller = new AbortController();
  let store;
  let receiver;
  t.after(async () => {
    controller.abort();
    await receiver;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    store?.close();
    await rm(root, { recursive: true, force: true });
  });
  await until(() => messages.includes("dispatching") || child.exitCode !== null);
  assert.equal(child.exitCode, null, stderr);
  store = new Store(join(data, "reviews.sqlite"));
  assert.equal(store.listEvents(DOCUMENT)[0].state, "dispatching");
  const before = store.getBinding(DOCUMENT);
  let polls = 0;
  receiver = runWorker(DOCUMENT, { store, dataDir: data, signal: controller.signal,
    pollIntervalMs: 10, idlePollIntervalMs: 20, pollMs: 10,
    fetch: async () => { polls++; return new Response(JSON.stringify({ events: [] })); },
    execFile() { assert.fail("the historical event already has a queue outcome"); } });
  await until(() => store.getBinding(DOCUMENT).workerTransport === "poll-v1" && polls > 0);
  await exited;
  assert.equal(child.exitCode, 0, stderr);
  assert.deepEqual(messages.at(-1), { settled: "worker_shutdown" });
  assert.equal(store.listEvents(DOCUMENT)[0].state, "queued");
  assert.equal(store.listEvents(DOCUMENT)[0].queueId, QUEUE);
  const after = store.getBinding(DOCUMENT);
  for (const field of ["documentId", "threadId", "keyId", "planDigest", "planPhase"]) assert.equal(after[field], before[field]);
  assert.equal(after.reconciliationRequired, true);
  assert.equal(after.upgradePending, false);
  assert.ok(after.lastSuccessfulPollAt);
});
