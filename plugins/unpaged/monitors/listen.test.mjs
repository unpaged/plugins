import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_DIR_RELATIVE, PROTOCOL_PREAMBLE, STATUS_DIR_RELATIVE, SUBPROTOCOL } from "./listen-core.mjs";
import { runCommand, runListener, runMonitor } from "./listen.mjs";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const SECRET = "k".repeat(43);
const POLL_URL = "https://mcp.unpaged.io/events/poll";
const config = { pollUrl: POLL_URL, key: SECRET, documentId: DOCUMENT };
const frame = (id = "event-1", changes = {}) => ({
  type: "agent-inbox-event", id, documentId: DOCUMENT, nodeId: "node", threadId: "thread", commentId: "comment",
  reason: "mention", authorRole: "owner", resolved: false, createdAt: "2026-09-21T00:00:00.000Z",
  documentTitle: "private-board", nodeTitle: "private-node", authorName: "private-author", textPreview: "private-text",
  boardUrl: "https://unpaged.io/private", anchorElementId: null, ...changes
});
const response = (events = [], changes = {}) => new Response(JSON.stringify({ events, nextCursor: null, ...changes }));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(); }
  assert.fail("condition timed out");
}
function fixture(t, options = {}) {
  const controller = new AbortController();
  const requests = [], lines = [], statuses = [], sleeps = [];
  let retired = 0;
  const pending = async () => { await until(() => requests.some((r) => !r.done)); return requests.find((r) => !r.done); };
  const fetch = (url, settings) => new Promise((resolve, reject) => { requests.push({ url, settings, resolve, reject, done: false }); });
  const run = runListener(config, {
    signal: controller.signal, fetch,
    say: (line) => lines.push(line),
    reportStatus: async (state, reason, metadata) => statuses.push({ state, reason, ...metadata }),
    retireKey: async () => { retired++; return "removed"; },
    sleep: async (delay) => { sleeps.push(delay); },
    ...options
  });
  t.after(async () => { controller.abort(); await run; });
  const reply = async (value) => { const r = await pending(); r.done = true; r.resolve(value); await tick(); return r; };
  return { controller, requests, lines, statuses, sleeps, run, pending, reply, get retired() { return retired; } };
}

test("authenticated empty polls remain connected, dedupe replay, and print the preamble once", async (t) => {
  const f = fixture(t);
  await f.reply(response());
  assert.equal(f.statuses.at(-1).state, "connected");
  assert.ok(f.statuses.at(-1).lastSuccessfulPollAt);
  assert.equal(f.lines.length, 0);
  await f.reply(response([frame(), frame()]));
  await f.reply(response([frame(), frame("event-2")]));
  assert.deepEqual(f.lines, [PROTOCOL_PREAMBLE, JSON.stringify(frame()), JSON.stringify(frame("event-2"))]);
  assert.ok(f.requests.every((r) => r.url === POLL_URL && r.settings.headers.Authorization === `Bearer ${SECRET}`));
  assert.deepEqual(f.sleeps, [30000, 30000, 30000]);
});

test("only newly emitted events reset the idle hour, while empty and replay polls keep sixty seconds", async (t) => {
  const origin = Date.parse("2026-09-21T00:00:00.000Z");
  let now = origin;
  const f = fixture(t, { now: () => now });
  await f.reply(response());
  now += 3599999;
  await f.reply(response());
  now++;
  await f.reply(response());
  assert.deepEqual(f.sleeps, [30000, 30000, 60000]);
  await f.reply(response([frame()]));
  assert.equal(f.sleeps.at(-1), 30000);
  now += 3600000;
  await f.reply(response([frame()]));
  assert.equal(f.sleeps.at(-1), 60000);
  assert.equal(f.lines.length, 2);
});

test("retryable outcomes retain key, cursor and last successful timestamp with capped backoff", async (t) => {
  const f = fixture(t);
  await f.reply(response([], { nextCursor: "page_200" }));
  const success = f.statuses.at(-1).lastSuccessfulPollAt;
  for (const status of [429, 503, 500]) await f.reply(new Response("private diagnostics", { status }));
  const request = await f.pending(); request.done = true; request.reject(new Error(SECRET)); await tick();
  assert.deepEqual(f.sleeps, [30000, 30000, 60000, 60000, 60000]);
  assert.equal(f.statuses.at(-1).state, "reconnecting");
  assert.equal(f.statuses.at(-1).lastSuccessfulPollAt, success);
  assert.equal(f.lines.length, 0);
  assert.ok(f.requests.slice(1).every((r) => r.url === `${POLL_URL}?cursor=page_200`));
  await f.reply(response());
  assert.equal((await f.pending()).url, POLL_URL);
  assert.equal(f.sleeps.at(-1), 30000);
  assert.equal(JSON.stringify(f.statuses).includes(SECRET), false);
});

test("malformed envelopes and foreign-board frames never emit a partial batch or report connected", async (t) => {
  const f = fixture(t);
  await f.reply(response([frame(), frame("foreign", { documentId: "22222222-2222-4222-8222-222222222222" })]));
  assert.equal(f.lines.length, 0);
  assert.equal(f.statuses.some((s) => s.state === "connected"), false);
  assert.equal(f.statuses.at(-1).state, "reconnecting");
});

test("HTTP 401 retires only through the existing race-safe helper and stops", async (t) => {
  const f = fixture(t);
  await f.reply(new Response("private", { status: 401 }));
  assert.deepEqual(await f.run, { reason: "http-401" });
  assert.equal(f.retired, 1);
  assert.equal(f.statuses.at(-1).state, "stopped");
  assert.equal(f.statuses.at(-1).reason, "http-401");
  assert.match(f.lines[0], /revoked/);
  assert.equal(f.requests.length, 1);
});

test("HTTP 409 does not retire a key or overwrite status after supersession", async (t) => {
  const f = fixture(t);
  await f.reply(response());
  const before = f.statuses.length;
  await f.reply(new Response("private", { status: 409 }));
  assert.deepEqual(await f.run, { reason: "http-409" });
  assert.equal(f.retired, 0);
  assert.equal(f.statuses.length, before);
  assert.match(f.lines[0], /newer Unpaged listener key/);
});

test("shutdown cancels pending requests and ignores late events", async (t) => {
  const f = fixture(t);
  const request = await f.pending();
  f.controller.abort();
  assert.deepEqual(await f.run, { reason: "shutdown" });
  assert.equal(request.settings.signal.aborted, true);
  request.resolve(response([frame()]));
  await tick();
  assert.equal(f.lines.length, 0);
  assert.deepEqual(f.statuses.map((s) => s.state), ["connecting", "stopped"]);
});

test("shutdown during status publication prevents all event and preamble output", async (t) => {
  const controller = new AbortController();
  const f = fixture(t, { signal: controller.signal, reportStatus: async (state) => { if (state === "connected") controller.abort(); } });
  await f.reply(response([frame()]));
  await f.run;
  assert.equal(f.lines.length, 0);
});

test("the local ID cache is bounded and does not grow with a long-lived monitor", async (t) => {
  const f = fixture(t, { dedupeLimit: 2 });
  await f.reply(response([frame("one"), frame("two"), frame("three")]));
  await f.reply(response([frame("two"), frame("one")]));
  assert.deepEqual(f.lines.slice(1).map((line) => JSON.parse(line).id), ["one", "two", "three", "one"]);
});

test("the runner reads legacy config without rewriting the key and persists last-success status", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "unpaged-claude-monitor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, KEY_DIR_RELATIVE), { recursive: true });
  const keyFile = join(home, KEY_DIR_RELATIVE, `${DOCUMENT}.json`);
  const raw = JSON.stringify({ url: "wss://mcp.unpaged.io/events", protocols: [SUBPROTOCOL, SECRET], documentId: DOCUMENT });
  await writeFile(keyFile, raw, { mode: 0o600 });
  const controller = new AbortController();
  const lines = [];
  await runMonitor(DOCUMENT, { home, signal: controller.signal, say: (line) => lines.push(line),
    fetch: async () => response(), sleep: async () => controller.abort() });
  assert.equal(await readFile(keyFile, "utf8"), raw);
  const status = JSON.parse(await readFile(join(home, STATUS_DIR_RELATIVE, `${DOCUMENT}.json`), "utf8"));
  assert.equal(status.state, "stopped");
  assert.equal(status.reason, "shutdown");
  assert.deepEqual(lines, []);
  assert.ok(status.lastSuccessfulPollAt);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test("same-key takeover drains old stdout before the replacement can poll or publish status", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "unpaged-claude-handover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, KEY_DIR_RELATIVE), { recursive: true });
  await writeFile(join(home, KEY_DIR_RELATIVE, `${DOCUMENT}.json`), JSON.stringify(config), { mode: 0o600 });
  const a = new AbortController(), b = new AbortController();
  let releaseWrite;
  let releaseNotice;
  let writing = false;
  let noticing = false;
  let replacementRequests = 0;
  const output = [];
  const first = runMonitor(DOCUMENT, { home, signal: a.signal, fetch: async () => response([frame()]),
    say: async (line) => {
      if (line === PROTOCOL_PREAMBLE) return;
      if (line.startsWith("{")) {
        writing = true;
        await new Promise((resolve) => { releaseWrite = resolve; });
      } else {
        noticing = true;
        await new Promise((resolve) => { releaseNotice = resolve; });
      }
      output.push(line);
    }
  });
  await until(() => writing);
  const second = runMonitor(DOCUMENT, { home, signal: b.signal,
    now: () => Date.parse("2027-01-01T00:00:00.000Z"),
    fetch: async () => { replacementRequests++; return response(); }
  });
  t.after(async () => { a.abort(); b.abort(); releaseWrite?.(); releaseNotice?.(); await Promise.all([first, second]); });
  await pause(80);
  assert.equal(replacementRequests, 0, "the old output drain still owns the quorum");
  releaseWrite();
  await until(() => noticing);
  assert.equal(replacementRequests, 0, "the supersession notice must also drain before releasing ownership");
  const stopped = JSON.parse(await readFile(join(home, STATUS_DIR_RELATIVE, `${DOCUMENT}.json`), "utf8"));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.reason, "local-superseded");
  releaseNotice();
  assert.deepEqual(await first, { reason: "local-superseded" });
  await until(() => replacementRequests === 1);
  let status;
  for (let i = 0; i < 100; i++) {
    status = JSON.parse(await readFile(join(home, STATUS_DIR_RELATIVE, `${DOCUMENT}.json`), "utf8"));
    if (status.lastSuccessfulPollAt === "2027-01-01T00:00:00.000Z") break;
    await pause();
  }
  assert.equal(status.state, "connected");
  assert.equal(status.lastSuccessfulPollAt, "2027-01-01T00:00:00.000Z");
  assert.notEqual(status.ownerId, stopped.ownerId);
  assert.equal(output.length, 2);
  assert.match(output[1], /Another local Monitor/);
  assert.match(output[1], /do not mint another key/);
  assert.equal(output[1].includes(SECRET), false);
  assert.equal(await readFile(join(home, KEY_DIR_RELATIVE, `${DOCUMENT}.json`), "utf8"), JSON.stringify(config));
  b.abort();
  await second;
});

test("startup stays silent when unarmed and gives safe actionable notices for unsupported hosts or ownership refusal", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "unpaged-claude-startup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const lines = [];
  const options = { home, say: (line) => lines.push(line) };
  assert.deepEqual(await runCommand(DOCUMENT, options), { reason: "not-armed" });
  assert.deepEqual(await runCommand("../invalid", options), { reason: "not-armed" });
  assert.equal(lines.length, 0);
  await mkdir(join(home, KEY_DIR_RELATIVE), { recursive: true });
  await writeFile(join(home, KEY_DIR_RELATIVE, `${DOCUMENT}.json`), JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await runCommand(DOCUMENT, { ...options, nodeVersion: "20.19.0" }), { reason: "unsupported-node" });
  assert.match(lines.pop(), /needs Node 22 or newer/);
  assert.deepEqual(await runCommand(DOCUMENT, { ...options, acquireOwnership: async () => null }), { reason: "ownership-unavailable" });
  assert.match(lines.pop(), /do not mint another key/);
  assert.deepEqual(await runCommand(DOCUMENT, { ...options, acquireOwnership: async () => { throw new Error(SECRET); } }), { reason: "monitor-unavailable" });
  assert.match(lines[0], /could not start or continue safely/);
  assert.equal(JSON.stringify(lines).includes(SECRET), false);
});

test("a key changed during handover is reloaded before the replacement's first poll", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "unpaged-claude-config-race-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, KEY_DIR_RELATIVE), { recursive: true });
  const keyFile = join(home, KEY_DIR_RELATIVE, `${DOCUMENT}.json`);
  await writeFile(keyFile, JSON.stringify(config), { mode: 0o600 });
  const controller = new AbortController();
  let header;
  let released = false;
  await runMonitor(DOCUMENT, { home, signal: controller.signal,
    acquireOwnership: async () => {
      await writeFile(keyFile, JSON.stringify({ ...config, key: "n".repeat(43) }));
      return { ownerId: "test-owner", release: async () => { released = true; } };
    },
    fetch: async (_url, settings) => { header = settings.headers.Authorization; return response(); },
    sleep: async () => controller.abort()
  });
  assert.equal(header, `Bearer ${"n".repeat(43)}`);
  assert.equal(released, true);
});

test("takeover before the first poll emits one notice before releasing ownership", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "unpaged-claude-early-takeover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, KEY_DIR_RELATIVE), { recursive: true });
  await writeFile(join(home, KEY_DIR_RELATIVE, `${DOCUMENT}.json`), JSON.stringify(config), { mode: 0o600 });
  const lines = [];
  let released = false;
  const result = await runMonitor(DOCUMENT, { home,
    acquireOwnership: async ({ onTakeover }) => {
      onTakeover();
      onTakeover();
      return { ownerId: "early-owner", release: async () => { released = true; } };
    },
    fetch: async () => assert.fail("a superseded monitor must not poll"),
    say: async (line) => { assert.equal(released, false); lines.push(line); }
  });
  assert.deepEqual(result, { reason: "local-superseded" });
  assert.equal(released, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Another local Monitor/);
  const status = JSON.parse(await readFile(join(home, STATUS_DIR_RELATIVE, `${DOCUMENT}.json`), "utf8"));
  assert.equal(status.reason, "local-superseded");
  assert.equal(status.ownerId, "early-owner");
});
