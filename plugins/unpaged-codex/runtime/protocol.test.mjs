import test from "node:test";
import assert from "node:assert/strict";
import { acceptancePhrase, acceptsPlan, EVENTS_URL, parseEvent, validateBinding, validateEvidence } from "./protocol.mjs";

const binding = { documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", threadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  keyId: "listener-key", url: EVENTS_URL, protocols: ["unpaged-listener.v1", "TEST_SECRET"], codexPath: "/test/bin/codex", planDigest: "a".repeat(64) };
const frame = { type: "agent-inbox-event", id: "event-1", documentId: binding.documentId, nodeId: "root",
  threadId: "comment-thread", commentId: "comment-1", reason: "mention", authorRole: "owner", resolved: false,
  createdAt: "2026-09-05T12:00:00.000Z", documentTitle: "PRIVATE_TITLE", nodeTitle: "PRIVATE_NODE",
  authorName: "PRIVATE_AUTHOR", textPreview: "PRIVATE_RAW_TEXT", boardUrl: "https://evil.example/PRIVATE_URL", anchorElementId: null };

test("bindings require exact endpoints, UUID board/task, private protocol shape and a version digest", () => {
  const normalized = validateBinding(binding);
  assert.notEqual(normalized.protocols, binding.protocols);
  for (const change of [{ threadId: "name" }, { documentId: "../board" }, { keyId: undefined },
    { url: EVENTS_URL + "?key=secret" }, { url: "wss://evil.example/events" }, { codexPath: "relative/codex" },
    { codexPath: "/bin/codex\n--injected" }, { codexPath: "/bin/codex\0" },
    { protocols: ["unpaged-listener.v1", "secret\nheader"] }, { planDigest: "unversioned" },
    { statusElementIds: ["not-uuid"] }, { statusElementIds: [binding.documentId, binding.documentId] }]) {
    assert.throws(() => validateBinding({ ...binding, ...change }));
  }
  assert.equal(validateBinding({ ...binding, codexPath: "/verified/other-install/codex" }).codexPath, "/verified/other-install/codex");
});
test("event parsing strips every collaborator-controlled prose field and rejects unsupported contracts", () => {
  const result = parseEvent(JSON.stringify(frame), binding);
  assert.equal(result.id, frame.id);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
  for (const change of [{ documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, { authorRole: "admin" },
    { reason: "agent_reply" }, { schemaVersion: 2 }, { resolved: "false" }, { id: "bad\ncommand" },
    { commentId: "../path" }, { createdAt: "invalid" }, { textPreview: null }]) {
    assert.equal(parseEvent(JSON.stringify({ ...frame, ...change }), binding), null);
  }
  assert.equal(parseEvent("not-json", binding), null);
  assert.equal(parseEvent("null", binding), null);
});
test("completion evidence is either a reply plus digest or a bounded explicit skip, never arbitrary JSON", () => {
  assert.deepEqual(validateEvidence({ replyId: "reply-id", planDigest: binding.planDigest }), { replyId: "reply-id", planDigest: binding.planDigest });
  assert.deepEqual(validateEvidence({ skippedReason: "Human withdrew request." }), { skippedReason: "Human withdrew request." });
  for (const proof of [{}, { replyId: "reply" }, { skippedReason: "" }, { skippedReason: "x".repeat(501) },
    { skippedReason: "skip", planDigest: binding.planDigest }, { replyId: "reply", planDigest: binding.planDigest, protocols: [] }]) {
    assert.throws(() => validateEvidence(proof));
  }
  assert.equal(acceptancePhrase(binding.planDigest), `I accept plan version ${binding.planDigest.slice(0, 12)}`);
});

test("standalone acceptance allows ordinary spacing, punctuation and mentions with legacy version compatibility", () => {
  const phrase = acceptancePhrase(binding.planDigest);
  for (const text of ["I accept this plan", " I accept this plan.\n", "@agent: I accept this plan!",
    "@agent :\tI  accept\nthis plan.  ", "@AGENT I ACCEPT THIS PLAN", phrase,
    `\n@agent: ${phrase}.\n`, phrase.toLowerCase(), `  ${phrase}!  `]) {
    assert.equal(acceptsPlan(text, binding.planDigest), true, text);
  }
});

test("acceptance refuses negation, conditions, quotes, questions, ambiguous scope and another version", () => {
  for (const text of ["I do not accept this plan", "I don't accept this plan", "I accept this plan if tests pass",
    "If approved, I accept this plan", "I accept this plan, but change phase two", "I accept this plan?",
    '"I accept this plan"', "“I accept this plan”", "> I accept this plan", "`I accept this plan`",
    "He said: I accept this plan", "I accept this plan. Start implementing now.", "Looks good", "I accept",
    "@agent:I accept this plan\0", "I accept this plan" + " ".repeat(1000),
    acceptancePhrase("b".repeat(64)), null, 42]) {
    assert.equal(acceptsPlan(text, binding.planDigest), false, String(text));
  }
});
