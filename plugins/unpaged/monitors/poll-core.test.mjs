import assert from "node:assert/strict";
import test from "node:test";
import { MAX_FRAME_BYTES, MAX_POLL_EVENTS, isTerminalStatus, parseEnvelope, pollRequest, validCursor } from "./poll-core.mjs";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const SECRET = "k".repeat(43);
const POLL_URL = "https://mcp.unpaged.io/events/poll";
const binding = { pollUrl: POLL_URL, key: SECRET, documentId: DOCUMENT };
const frame = (id = "event-1", changes = {}) => ({
  type: "agent-inbox-event", id, documentId: DOCUMENT, nodeId: "node", threadId: "thread", commentId: "comment",
  reason: "mention", authorRole: "owner", resolved: false, createdAt: "2026-09-21T00:00:00.000Z",
  documentTitle: "private-board", nodeTitle: "private-node", authorName: "private-author", textPreview: "private-text",
  boardUrl: "https://unpaged.io/private", anchorElementId: null, ...changes
});
const envelope = (events = [], changes = {}) => JSON.stringify({ events, nextCursor: null, ...changes });
const reasonOf = (fn) => { try { fn(); } catch (error) { return error.reason; } return null; };

test("the request is the canonical endpoint with a header credential and the cursor as its only query value", () => {
  const first = pollRequest(binding);
  assert.equal(first.url, POLL_URL);
  assert.deepEqual(first.headers, { Authorization: `Bearer ${SECRET}`, Accept: "application/json" });
  assert.equal(pollRequest(binding, "page_200").url, `${POLL_URL}?cursor=page_200`);
  assert.equal(JSON.stringify(pollRequest(binding, "page_200").url).includes(SECRET), false);
});

test("an invalid binding or cursor is refused before any request, with no credential in the error", () => {
  for (const bad of [
    { ...binding, pollUrl: "https://elsewhere.example/events/poll" },
    { ...binding, key: "short" },
    { ...binding, documentId: "nope" },
    null
  ]) assert.equal(reasonOf(() => pollRequest(bad)), "invalid_poll_configuration");
  for (const cursor of ["", "a b", "x".repeat(129), 5]) assert.equal(reasonOf(() => pollRequest(binding, cursor)), "invalid_poll_configuration");
  assert.equal(validCursor(null), true);
  assert.equal(validCursor("page_1"), true);
});

test("only 401 and 409 are terminal", () => {
  assert.deepEqual([401, 409, 200, 429, 500, 503].map(isTerminalStatus), [true, true, false, false, false, false]);
});

test("a valid envelope yields its frames unchanged and an absent cursor wraps to null", () => {
  assert.deepEqual(parseEnvelope(envelope([frame(), frame("event-2")], { nextCursor: "page_2" }), DOCUMENT),
    { events: [frame(), frame("event-2")], nextCursor: "page_2" });
  assert.deepEqual(parseEnvelope(JSON.stringify({ events: [] }), DOCUMENT), { events: [], nextCursor: null });
});

test("the entire envelope must validate before any event is returned", () => {
  const cases = [
    "not json",
    JSON.stringify([]),
    JSON.stringify({ events: [], extra: 1 }),
    JSON.stringify({ events: "no" }),
    JSON.stringify({ events: [], nextCursor: "a b" }),
    envelope(Array.from({ length: MAX_POLL_EVENTS + 1 }, (_, i) => frame(`e${i}`))),
    envelope([frame(), frame("foreign", { documentId: "22222222-2222-4222-8222-222222222222" })]),
    envelope([frame("bad-role", { authorRole: "admin" })]),
    envelope([frame("bad-date", { createdAt: "2026-09-21" })]),
    envelope([frame("big", { textPreview: "x".repeat(MAX_FRAME_BYTES) })])
  ];
  for (const text of cases) assert.equal(reasonOf(() => parseEnvelope(text, DOCUMENT)), "poll_invalid_response", text.slice(0, 40));
});
