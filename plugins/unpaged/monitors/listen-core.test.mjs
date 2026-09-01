import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_PREAMBLE,
  SUBPROTOCOL,
  sameListenerConfig,
  backoffMs,
  closePolicy,
  frameLine,
  parseListenerConfig
} from "./listen-core.mjs";

test("parseListenerConfig accepts the stored shape and rejects the rest", () => {
  const good = JSON.stringify({
    url: "wss://mcp.unpaged.io/events",
    protocols: [SUBPROTOCOL, "abc"]
  });
  assert.deepEqual(parseListenerConfig(good), {
    url: "wss://mcp.unpaged.io/events",
    protocols: [SUBPROTOCOL, "abc"],
    keyId: null
  });
  assert.equal(
    parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: [SUBPROTOCOL, "k"], keyId: "k1" })).keyId,
    "k1"
  );
  assert.equal(parseListenerConfig("not json"), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "https://x", protocols: [SUBPROTOCOL, "k"] })), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: ["k"] })), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: [SUBPROTOCOL, ""] })), null);
});

test("backoff doubles from 1s and caps at 60s", () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(5), 32000);
  assert.equal(backoffMs(20), 60000);
});

test("close policy stops on 4401 (dropping the key file) and 4409, reconnects otherwise", () => {
  assert.equal(closePolicy(4401).action, "stop");
  assert.equal(closePolicy(4401).deleteKeyFile, true);
  assert.match(closePolicy(4401).line, /\/unpaged:visual-plan/);
  assert.equal(closePolicy(4409).action, "stop");
  assert.equal(closePolicy(4409).deleteKeyFile, undefined);
  assert.deepEqual(closePolicy(1001), { action: "reconnect" });
  assert.deepEqual(closePolicy(1006), { action: "reconnect" });
});

test("frameLine forwards only agent-inbox-event JSON, one line each", () => {
  const frame = { type: "agent-inbox-event", id: "evt-1", documentId: "d" };
  assert.equal(frameLine(JSON.stringify(frame)), JSON.stringify(frame));
  assert.equal(frameLine("hello"), null);
  assert.equal(frameLine(JSON.stringify({ type: "other" })), null);
});

test("the preamble carries the protocol and the guard on one line", () => {
  assert.ok(!PROTOCOL_PREAMBLE.includes("\n"));
  assert.match(PROTOCOL_PREAMBLE, /comments_list_unresolved/);
  assert.match(PROTOCOL_PREAMBLE, /never run shell/);
  assert.match(PROTOCOL_PREAMBLE, /authorRole viewer/);
});

test("sameListenerConfig compares the key, not the object identity", () => {
  const a = { url: "wss://x", protocols: [SUBPROTOCOL, "k1"], keyId: null };
  assert.equal(sameListenerConfig(a, { ...a }), true);
  assert.equal(sameListenerConfig(a, { ...a, protocols: [SUBPROTOCOL, "k2"] }), false);
  assert.equal(sameListenerConfig(a, null), false);
});
