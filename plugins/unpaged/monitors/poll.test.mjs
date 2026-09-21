import assert from "node:assert/strict";
import test from "node:test";
const POLL_URL = "https://mcp.unpaged.io/events/poll";
import { MAX_POLL_EVENTS, pollInbox } from "./poll.mjs";

const SECRET = "k".repeat(43);
const binding = { documentId: "11111111-1111-4111-8111-111111111111", threadId: "22222222-2222-4222-8222-222222222222",
  keyId: "key-id", pollUrl: POLL_URL, key: SECRET };
const frame = (id = "event-1", changes = {}) => ({
  type: "agent-inbox-event", id, documentId: binding.documentId, nodeId: "node", threadId: "thread", commentId: "comment",
  reason: "mention", authorRole: "owner", resolved: false, createdAt: "2026-09-21T00:00:00.000Z",
  documentTitle: "private-board", nodeTitle: "private-node", authorName: "private-author", textPreview: "private-text",
  boardUrl: "https://unpaged.io/private", anchorElementId: null, ...changes
});
const response = (value, options = {}) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...options });

test("poll uses only the canonical endpoint and a header credential, returning the unchanged event frame", async () => {
  const calls = [];
  const result = await pollInbox(binding, { fetch: async (...args) => { calls.push(args); return response({ events: [frame()] }); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], POLL_URL);
  assert.equal(calls[0][0].includes(SECRET), false);
  assert.equal(calls[0][1].method, "GET");
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].cache, "no-store");
  assert.equal(result.events[0].id, "event-1");
  assert.deepEqual(result.events[0], frame());
  assert.deepEqual(await pollInbox(binding, { fetch: async () => response({ events: [] }) }), { events: [], nextCursor: null });
});

test("only 401 and 409 are terminal, and status error bodies are never read", async () => {
  for (const status of [401, 409, 429, 503, 500, 302]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const call = pollInbox(binding, { fetch: async () => new Response(body, { status }) });
    if ([401, 409].includes(status)) assert.deepEqual(await call, { terminal: status });
    else await assert.rejects(call, { reason: "poll_http_error" });
    assert.equal(cancelled, true);
  }
});

test("invalid endpoints and credentials fail before any request", async () => {
  let requested = false;
  for (const changes of [
    { pollUrl: undefined }, { pollUrl: "https://other.example/events/poll" }, { pollUrl: `${POLL_URL}?key=${SECRET}` },
    { pollUrl: POLL_URL.replace("https:", "http:") }, { key: `${SECRET}\nheader` }
  ]) {
    await assert.rejects(pollInbox({ ...binding, ...changes }, { fetch: async () => { requested = true; } }), { reason: "invalid_poll_configuration" });
  }
  assert.equal(requested, false);
});

test("the entire envelope must validate before any event is returned", async () => {
  for (const value of [null, [], {}, { events: null }, { events: [], extra: true },
    { events: Array.from({ length: MAX_POLL_EVENTS + 1 }, (_, i) => frame(`event-${i}`)) },
    { events: [frame(), frame("foreign", { documentId: binding.threadId })] },
    { events: [frame(), frame("schema", { schemaVersion: 2 })] },
    { events: [frame(), frame("prose", { textPreview: null })] },
    { events: [frame(), frame("large", { textPreview: "a".repeat(65536) })] },
    { events: [JSON.stringify(frame())] }]) {
    await assert.rejects(pollInbox(binding, { fetch: async () => response(value) }), { reason: "poll_invalid_response" });
  }
  const result = await pollInbox(binding, { fetch: async () => response({ events: Array.from({ length: MAX_POLL_EVENTS }, (_, i) => frame(`event-${i}`)) }) });
  assert.equal(result.events.length, MAX_POLL_EVENTS);
});

test("bounded streaming preserves split UTF-8 while refusing invalid JSON or byte sequences", async () => {
  const bytes = Buffer.from(JSON.stringify({ events: [frame("unicode", { textPreview: "café 漢字 📝" })] }));
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  assert.equal((await pollInbox(binding, { fetch: async () => new Response(body) })).events[0].id, "unicode");
  for (const bytes of [Buffer.from("not-json"), Buffer.from([123, 34, 255, 34, 58, 49, 125])]) {
    await assert.rejects(pollInbox(binding, { fetch: async () => new Response(bytes) }), { reason: "poll_invalid_response" });
  }
});

test("both advertised length and streamed bytes obey the response limit", async () => {
  const text = JSON.stringify({ events: [] });
  assert.deepEqual(await pollInbox(binding, { maxBytes: Buffer.byteLength(text), fetch: async () => new Response(text) }), { events: [], nextCursor: null });
  for (const advertise of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from("x".repeat(65))); }, cancel() { cancelled = true; } });
    await assert.rejects(pollInbox(binding, { maxBytes: 64, fetch: async () => new Response(body,
      advertise ? { headers: { "content-length": "65" } } : {}) }), { reason: "poll_body_limit" });
    assert.equal(cancelled, true);
  }
});

test("the deadline bounds both a stuck request and a stuck response body", async () => {
  let requestSignal;
  await assert.rejects(pollInbox(binding, { timeoutMs: 5, fetch: (_url, options) => {
    requestSignal = options.signal;
    return new Promise(() => {});
  } }), { reason: "poll_timeout" });
  assert.equal(requestSignal.aborted, true);
  let cancelled = false;
  await assert.rejects(pollInbox(binding, { timeoutMs: 5, fetch: async () =>
    new Response(new ReadableStream({ cancel() { cancelled = true; } })) }), { reason: "poll_timeout" });
  assert.equal(cancelled, true);
});

test("shutdown aborts an in-flight request and late response bodies are discarded", async () => {
  const controller = new AbortController();
  let resolveFetch;
  let requestSignal;
  const call = pollInbox(binding, { signal: controller.signal, fetch: (_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve) => { resolveFetch = resolve; });
  } });
  controller.abort();
  await assert.rejects(call, { reason: "poll_aborted" });
  assert.equal(requestSignal.aborted, true);
  let cancelled = false;
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("network errors and unexpected redirects never expose arbitrary diagnostics", async () => {
  await assert.rejects(pollInbox(binding, { fetch: () => { throw new Error(SECRET); } }), (error) => {
    assert.equal(error.reason, "poll_request_failed");
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    assert.equal(error.message.includes(SECRET), false);
    return true;
  });
  const redirected = response({ events: [] });
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(pollInbox(binding, { fetch: async () => redirected }), { reason: "poll_redirected" });
});

test("a bounded page cursor is the only permitted query value and absent responses wrap", async () => {
  const calls = [];
  const result = await pollInbox(binding, { cursor: "event_200-end", fetch: async (url, settings) => {
    calls.push({ url, settings });
    return response({ events: [], nextCursor: "event_400-end" });
  } });
  assert.equal(calls[0].url, `${POLL_URL}?cursor=event_200-end`);
  assert.equal(calls[0].settings.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(result, { events: [], nextCursor: "event_400-end" });
  for (const nextCursor of [undefined, null]) {
    assert.deepEqual(await pollInbox(binding, { cursor: "last-page", fetch: async () => response({ events: [], nextCursor }) }),
      { events: [], nextCursor: null });
  }
  for (const cursor of ["", "a".repeat(129), "&key=secret", "a/b", 42, {}]) {
    let called = false;
    await assert.rejects(pollInbox(binding, { cursor, fetch: () => { called = true; } }), { reason: "invalid_poll_configuration" });
    assert.equal(called, false);
    await assert.rejects(pollInbox(binding, { fetch: async () => response({ events: [frame()], nextCursor: cursor }) }),
      { reason: "poll_invalid_response" });
  }
});
