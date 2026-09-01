import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBPROTOCOL,
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
    protocols: [SUBPROTOCOL, "abc"]
  });
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

test("close policy stops on 4401 and 4409, reconnects otherwise", () => {
  assert.equal(closePolicy(4401).action, "stop");
  assert.match(closePolicy(4401).line, /\/unpaged:listen/);
  assert.equal(closePolicy(4409).action, "stop");
  assert.deepEqual(closePolicy(1001), { action: "reconnect" });
  assert.deepEqual(closePolicy(1006), { action: "reconnect" });
});

test("frameLine forwards only agent-inbox-event JSON, one line each", () => {
  const frame = { type: "agent-inbox-event", id: "evt-1", documentId: "d" };
  assert.equal(frameLine(JSON.stringify(frame)), JSON.stringify(frame));
  assert.equal(frameLine("hello"), null);
  assert.equal(frameLine(JSON.stringify({ type: "other" })), null);
});
