import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_PREAMBLE } from "./listen-core.mjs";
import { runListener } from "./listen-loop.mjs";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const SECRET = "k".repeat(43);
const config = { pollUrl: "https://mcp.unpaged.io/events/poll", key: SECRET, documentId: DOCUMENT };
const frame = (id = "event-1") => ({
  type: "agent-inbox-event", id, documentId: DOCUMENT, nodeId: "node", threadId: "thread", commentId: "comment",
  reason: "mention", authorRole: "owner", resolved: false, createdAt: "2026-09-21T00:00:00.000Z",
  documentTitle: "private-board", nodeTitle: "private-node", authorName: "private-author", textPreview: "private-text",
  boardUrl: "https://unpaged.io/private", anchorElementId: null
});
const page = (events = [], nextCursor = null) => ({ events, nextCursor });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(); }
  assert.fail("condition timed out");
}

function fixture(t, options = {}) {
  const controller = new AbortController();
  const polls = [], lines = [], statuses = [], sleeps = [];
  let retired = 0;
  const pending = async () => { await until(() => polls.some((p) => !p.done)); return polls.find((p) => !p.done); };
  const poll = (binding, settings) => new Promise((resolve, reject) => {
    const entry = { binding, settings, resolve, reject, done: false };
    polls.push(entry);
    settings.signal?.addEventListener("abort", () => { entry.done = true; reject(Object.assign(new Error("poll_aborted"), { reason: "poll_aborted" })); }, { once: true });
  });
  const run = runListener(config, {
    signal: controller.signal, poll,
    say: async (line) => { lines.push(line); },
    reportStatus: async (state, reason, metadata) => statuses.push({ state, reason, ...metadata }),
    retireKey: async () => { retired++; return "removed"; },
    sleep: async (delay) => { sleeps.push(delay); },
    ...options
  });
  t.after(async () => { controller.abort(); await run; });
  const answer = async (value) => { const p = await pending(); p.done = true; p.resolve(value); await tick(); return p; };
  const fail = async () => { const p = await pending(); p.done = true; p.reject(new Error(SECRET)); await tick(); return p; };
  return { controller, polls, lines, statuses, sleeps, run, pending, answer, fail, get retired() { return retired; } };
}

test("the loop refuses to start without its three boundaries", async () => {
  for (const options of [{}, { poll() {} }, { poll() {}, sleep() {} }, { sleep() {}, say() {} }]) {
    await assert.rejects(runListener(config, options), /listener_configuration_invalid/);
  }
});

test("each poll carries the binding, the cursor and the deadline; empty pages stay connected at thirty seconds", async (t) => {
  const f = fixture(t);
  await f.answer(page([], "page_2"));
  assert.equal(f.polls[0].binding, config);
  assert.deepEqual([f.polls[0].settings.cursor, f.polls[0].settings.timeoutMs], [null, 15000]);
  assert.equal(f.statuses.at(-1).state, "connected");
  assert.ok(f.statuses.at(-1).lastSuccessfulPollAt);
  assert.equal((await f.pending()).settings.cursor, "page_2");
  assert.deepEqual(f.sleeps, [30000]);
  assert.equal(f.lines.length, 0);
});

test("events are said once each after one preamble, and replays are dropped", async (t) => {
  const f = fixture(t);
  await f.answer(page([frame(), frame()]));
  await f.answer(page([frame(), frame("event-2")]));
  assert.deepEqual(f.lines, [PROTOCOL_PREAMBLE, JSON.stringify(frame()), JSON.stringify(frame("event-2"))]);
});

test("only a new event resets the idle hour", async (t) => {
  let now = Date.parse("2026-09-21T00:00:00.000Z");
  const f = fixture(t, { now: () => now });
  await f.answer(page());
  now += 3600000;
  await f.answer(page());
  assert.deepEqual(f.sleeps, [30000, 60000]);
  await f.answer(page([frame()]));
  assert.equal(f.sleeps.at(-1), 30000);
});

test("the latest page's cadence sets the next sleep, and a value it leaves out falls back", async (t) => {
  let now = Date.parse("2026-09-21T00:00:00.000Z");
  const f = fixture(t, { now: () => now });
  const fast = { intervalMs: 10000, idleIntervalMs: 20000 };
  await f.answer({ ...page(), cadence: fast });
  await f.answer(page());
  now += 3600000;
  await f.answer({ ...page(), cadence: fast });
  await f.answer({ ...page(), cadence: { intervalMs: 10000 } });
  await f.answer({ ...page([frame()]), cadence: { intervalMs: 15000 } });
  assert.deepEqual(f.sleeps, [10000, 30000, 20000, 60000, 15000]);
});

test("a rejected poll reports reconnecting, keeps the cursor and backs off to the cap", async (t) => {
  const f = fixture(t);
  await f.answer(page([], "page_9"));
  const success = f.statuses.at(-1).lastSuccessfulPollAt;
  await f.fail();
  await f.fail();
  assert.deepEqual(f.sleeps, [30000, 30000, 60000]);
  assert.equal(f.statuses.at(-1).state, "reconnecting");
  assert.equal(f.statuses.at(-1).lastSuccessfulPollAt, success);
  assert.equal((await f.pending()).settings.cursor, "page_9");
  assert.equal(JSON.stringify(f.statuses).includes(SECRET), false);
  assert.equal(JSON.stringify(f.lines).includes(SECRET), false);
});

test("HTTP 401 retires the key through the injected helper, stops, and says so", async (t) => {
  const f = fixture(t);
  await f.answer({ terminal: 401 });
  assert.deepEqual(await f.run, { reason: "http-401" });
  assert.equal(f.retired, 1);
  assert.deepEqual([f.statuses.at(-1).state, f.statuses.at(-1).reason], ["stopped", "http-401"]);
  assert.match(f.lines[0], /revoked/);
  assert.equal(f.polls.length, 1);
});

test("HTTP 409 keeps the key and the status file of the newer listener", async (t) => {
  const f = fixture(t);
  await f.answer(page());
  const before = f.statuses.length;
  await f.answer({ terminal: 409 });
  assert.deepEqual(await f.run, { reason: "http-409" });
  assert.equal(f.retired, 0);
  assert.equal(f.statuses.length, before);
  assert.match(f.lines[0], /newer Unpaged listener key/);
});

test("abort ends the loop quietly and late pages are ignored", async (t) => {
  const f = fixture(t);
  const p = await f.pending();
  f.controller.abort();
  assert.deepEqual(await f.run, { reason: "shutdown" });
  assert.equal(p.settings.signal.aborted, true);
  p.resolve(page([frame()]));
  await tick();
  assert.equal(f.lines.length, 0);
  assert.deepEqual(f.statuses.map((s) => s.state), ["connecting", "stopped"]);
});

test("the dedupe set is bounded", async (t) => {
  const f = fixture(t, { dedupeLimit: 2 });
  await f.answer(page([frame("one"), frame("two"), frame("three")]));
  await f.answer(page([frame("two"), frame("one")]));
  assert.deepEqual(f.lines.slice(1).map((line) => JSON.parse(line).id), ["one", "two", "three", "one"]);
});

test("once mode keeps polling across empty and replay-only pages, then exits after the first unseen event batch", async (t) => {
  const f = fixture(t, {
    once: true,
    initialCursor: "page_1",
    initialSeen: ["already-delivered"]
  });
  await f.answer(page([], "page_2"));
  assert.equal(f.polls[0].settings.cursor, "page_1");
  assert.equal(f.lines.length, 0);
  assert.deepEqual(f.sleeps, [30000]);

  // A page holding only already-seen events does not trigger an exit.
  await f.answer(page([frame("already-delivered")], "page_3"));
  assert.equal(f.lines.length, 0);
  assert.deepEqual(f.sleeps, [30000, 30000]);

  // A page with a new unseen event emits the preamble + new event and exits immediately without sleeping again.
  await f.answer(page([frame("already-delivered"), frame("fresh-event")], "page_4"));
  assert.deepEqual(await f.run, { reason: "events", nextCursor: "page_4" });
  assert.deepEqual(f.lines, [PROTOCOL_PREAMBLE, JSON.stringify(frame("fresh-event"))]);
  assert.deepEqual(f.sleeps, [30000, 30000]);
  assert.equal(f.statuses.at(-1).state, "stopped");
  assert.equal(f.statuses.at(-1).reason, "events-delivered");
  assert.equal(f.statuses.at(-1).cursor, "page_4");
  assert.deepEqual(f.statuses.at(-1).seen, ["already-delivered", "fresh-event"]);
});

test("once mode exits with poll-failed when its first poll fails, and retries transient failures after a connected poll", async (t) => {
  const f1 = fixture(t, { once: true });
  await f1.fail();
  assert.deepEqual(await f1.run, { reason: "poll-failed" });
  assert.equal(f1.sleeps.length, 0);
  assert.deepEqual([f1.statuses.at(-1).state, f1.statuses.at(-1).reason], ["stopped", "poll-failed"]);
  assert.equal(f1.lines.length, 1);
  assert.match(f1.lines[0], /could not reach Unpaged on its first poll/);
  assert.match(f1.lines[0], /BypassSandbox: true/);
  assert.equal(f1.lines[0].includes(SECRET), false);

  const f2 = fixture(t, { once: true });
  await f2.answer(page([], "page_2"));
  await f2.fail();
  assert.equal(f2.statuses.at(-1).state, "reconnecting");
  assert.deepEqual(f2.sleeps, [30000, 30000]);
  await f2.answer(page([frame("event-after-retry")], "page_3"));
  assert.deepEqual(await f2.run, { reason: "events", nextCursor: "page_3" });
});

test("abort during preamble output does not mark the undelivered event as seen or advance cursor", async (t) => {
  const controller = new AbortController();
  const lines = [];
  const f = fixture(t, {
    once: true,
    signal: controller.signal,
    initialCursor: "page_1",
    say: async (line) => {
      lines.push(line);
      if (line === PROTOCOL_PREAMBLE) controller.abort();
    }
  });
  await f.answer(page([frame("undelivered-event")], "page_2"));
  assert.deepEqual(await f.run, { reason: "shutdown" });
  assert.deepEqual(lines, [PROTOCOL_PREAMBLE]);
  assert.equal(f.statuses.at(-1).state, "stopped");
  assert.equal(f.statuses.at(-1).cursor, "page_1");
  assert.deepEqual(f.statuses.at(-1).seen, []);
});
