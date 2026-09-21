import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_PREAMBLE,
  SUBPROTOCOL,
  backoffMs,
  closePolicy,
  frameLine,
  isDocumentId,
  keyFileFor,
  parseListenerConfig,
  rejectedKeyLine,
  retireKeyFile,
  sameListenerConfig,
  shouldWriteStatus
} from "./listen-core.mjs";

const DOC = "b0d8599c-93e6-4ebd-b63d-e0d0dfc3ce36";
const KEY = "A".repeat(43);
const POLL_URL = "https://mcp.unpaged.io/events/poll";

test("parseListenerConfig accepts the per-board shape and rejects the rest", () => {
  const good = JSON.stringify({
    url: "wss://mcp.unpaged.io/events",
    protocols: [SUBPROTOCOL, KEY],
    documentId: DOC
  });
  assert.deepEqual(parseListenerConfig(good), {
    pollUrl: POLL_URL,
    key: KEY,
    documentId: DOC,
    keyId: null,
    title: "",
    cwd: null,
    createdAt: null
  });
  const full = parseListenerConfig(
    JSON.stringify({
      pollUrl: POLL_URL,
      key: KEY,
      documentId: DOC,
      keyId: "k1",
      title: "acme: plan",
      cwd: "/repo",
      createdAt: "2026-09-03T00:00:00.000Z"
    })
  );
  assert.equal(full.keyId, "k1");
  assert.equal(full.title, "acme: plan");
  assert.equal(full.cwd, "/repo");
  assert.equal(parseListenerConfig("not json"), null);
  // The v1 shape (no board) is not a listener any more.
  assert.equal(parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: [SUBPROTOCOL, "k"] })), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "https://x", protocols: [SUBPROTOCOL, "k"], documentId: DOC })), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: ["k"], documentId: DOC })), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: [SUBPROTOCOL, ""], documentId: DOC })), null);
  assert.equal(parseListenerConfig(JSON.stringify({ url: "wss://x", protocols: [SUBPROTOCOL, "k"], documentId: "../etc" })), null);
});

test("legacy and direct configurations normalize consistently while mismatched mixed fields fail closed", () => {
  const direct = { pollUrl: POLL_URL, key: KEY, documentId: DOC };
  const legacy = { url: "wss://mcp.unpaged.io/events", protocols: [SUBPROTOCOL, KEY], documentId: DOC };
  const normalize = (value) => parseListenerConfig(JSON.stringify(value));
  assert.deepEqual(normalize(direct), normalize(legacy));
  assert.deepEqual(normalize({ ...legacy, key: KEY }), normalize(direct));
  assert.deepEqual(normalize({ ...legacy, ...direct }), normalize(direct));
  assert.deepEqual(normalize({ ...direct, pollUrl: "https://MCP.UNPAGED.IO:443/events/poll" }), normalize(direct));
  for (const config of [
    { ...legacy, ...direct, key: "B".repeat(43) },
    { ...legacy, ...direct, pollUrl: "https://mcp.staging.unpaged.io/events/poll" },
    { ...legacy, url: "wss://user@mcp.unpaged.io/events" },
    { ...legacy, url: "wss://mcp.unpaged.io/events?key=secret" },
    { ...legacy, url: "wss://mcp.unpaged.io/events/" },
    { ...legacy, url: "wss://mcp.unpaged.io:8443/events" },
    { ...legacy, protocols: [KEY, SUBPROTOCOL] },
    { ...legacy, protocols: [SUBPROTOCOL, KEY, "extra"] },
    { ...legacy, protocols: [SUBPROTOCOL, "short"] },
    { ...direct, key: KEY + "\r\n" },
    { ...direct, key: "A".repeat(42) + "=" },
    { ...direct, key: null }, { ...direct, key: undefined }
  ]) assert.equal(normalize(config), null, JSON.stringify(config));
});

test("document ids are path-safe before they become file names", () => {
  assert.equal(isDocumentId(DOC), true);
  assert.equal(isDocumentId("short"), false);
  assert.equal(isDocumentId("../../.ssh/id_rsa"), false);
  assert.equal(isDocumentId("a b c d e f g h"), false);
  assert.equal(keyFileFor("/home/u/.claude/unpaged/listeners", DOC), `/home/u/.claude/unpaged/listeners/${DOC}.json`);
  assert.equal(keyFileFor("/dir", "../x"), null);
});

test("backoff doubles from 1s and caps at 60s", () => {
  assert.equal(backoffMs(0), 1000);
  assert.equal(backoffMs(1), 2000);
  assert.equal(backoffMs(5), 32000);
  assert.equal(backoffMs(20), 60000);
});

test("HTTP policy stops on 401 (retiring the key file) and 409, retries transient failures", () => {
  assert.equal(closePolicy(401, DOC).action, "stop");
  assert.equal(closePolicy(401, DOC).deleteKeyFile, true);
  assert.equal(closePolicy(401, DOC).line, undefined); // worded by rejectedKeyLine(outcome) only
  assert.match(rejectedKeyLine("removed", DOC), new RegExp(`/unpaged:listen arm ${DOC}`));
  assert.match(rejectedKeyLine("absent"), /\/unpaged:visual-plan/);
  assert.equal(closePolicy(409, DOC).action, "stop");
  assert.equal(closePolicy(409, DOC).deleteKeyFile, undefined);
  assert.equal(closePolicy(409, DOC).superseded, true);
  assert.equal(closePolicy(401, DOC).superseded, undefined);
  assert.match(closePolicy(409, DOC).line, /newer Unpaged listener key superseded/);
  assert.match(closePolicy(409, DOC).line, /check \/unpaged:listen status to see whether a Monitor is listening/);
  assert.doesNotMatch(closePolicy(409, DOC).line, /Another session took over|that session is listening/);
  assert.match(closePolicy(409, DOC).line, new RegExp(DOC));
  for (const status of [429, 503, 500, 502, 504, 0]) assert.deepEqual(closePolicy(status), { action: "reconnect" });
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
  const a = { url: "wss://mcp.unpaged.io/events", protocols: [SUBPROTOCOL, KEY], documentId: DOC, keyId: null };
  assert.equal(sameListenerConfig(a, { ...a }), true);
  assert.equal(sameListenerConfig(a, { pollUrl: POLL_URL, key: KEY, documentId: DOC }), true);
  assert.equal(sameListenerConfig(a, { ...a, protocols: [SUBPROTOCOL, "B".repeat(43)] }), false);
  assert.equal(sameListenerConfig(a, { pollUrl: "https://mcp.staging.unpaged.io/events/poll", key: KEY, documentId: DOC }), false);
  assert.equal(sameListenerConfig(a, {}), false);
  assert.equal(sameListenerConfig(a, null), false);
});

function memFs(files) {
  return {
    files,
    async rename(from, to) {
      if (!(from in files)) throw new Error("ENOENT");
      files[to] = files[from];
      delete files[from];
    },
    async readFile(path) {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    },
    async rm(path) {
      delete files[path];
    },
    async link(from, to) {
      if (!(from in files)) throw new Error("ENOENT");
      if (to in files) throw new Error("EEXIST");
      files[to] = files[from];
    }
  };
}

const cfg = (key, keyId) => ({ pollUrl: POLL_URL, key: key.padEnd(43, "k"), documentId: DOC, keyId });

test("rejected-key line follows the retire outcome: re-arm only when this session's file is gone", () => {
  for (const outcome of ["removed", "absent"]) {
    const line = rejectedKeyLine(outcome, DOC);
    assert.match(line, /the stored key file was retired/);
    assert.match(line, /do not mint a key here/);
    assert.match(line, new RegExp(`/unpaged:listen arm ${DOC}`));
    assert.match(line, /\/unpaged:visual-plan/);
  }
  for (const outcome of ["kept-newer", "superseded"]) {
    const line = rejectedKeyLine(outcome, DOC);
    assert.match(line, /newer key for this canvas is already stored/);
    assert.doesNotMatch(line, /\/unpaged:listen arm/);
    assert.doesNotMatch(line, /was retired/);
  }
});

test("retireKeyFile removes the rejected config but restores a newer one", async () => {
  const loaded = cfg("old", "k1");
  const same = memFs({ "/k": JSON.stringify(loaded) });
  assert.equal(await retireKeyFile(same, "/k", loaded), "removed");
  assert.deepEqual(Object.keys(same.files), []);

  const fresh = cfg("new", "k2");
  const replaced = memFs({ "/k": JSON.stringify(fresh) });
  assert.equal(await retireKeyFile(replaced, "/k", loaded), "kept-newer");
  assert.deepEqual(JSON.parse(replaced.files["/k"]), fresh);

  assert.equal(await retireKeyFile(memFs({}), "/k", loaded), "absent");
});

test("HTTP 401 retires the same key across old/new file formats without removing a newer key", async () => {
  const legacy = { url: "wss://mcp.unpaged.io/events", protocols: [SUBPROTOCOL, KEY], documentId: DOC, keyId: "old" };
  const normalized = parseListenerConfig(JSON.stringify(legacy));
  const stillLegacy = memFs({ "/k": JSON.stringify(legacy) });
  assert.equal(await retireKeyFile(stillLegacy, "/k", normalized), "removed");
  const reformatted = memFs({ "/k": JSON.stringify(normalized) });
  assert.equal(await retireKeyFile(reformatted, "/k", legacy), "removed");
  const newer = { ...normalized, key: "B".repeat(43), keyId: "new" };
  const changed = memFs({ "/k": JSON.stringify(newer) });
  assert.equal(await retireKeyFile(changed, "/k", legacy), "kept-newer");
  assert.deepEqual(JSON.parse(changed.files["/k"]), newer);
});

test("retireKeyFile never clobbers a third key installed while the file was aside", async () => {
  const loaded = cfg("A", "a");
  const b = cfg("B", "b");
  const c = cfg("C", "c");
  const fs = memFs({ "/k": JSON.stringify(b) });
  // Simulate a third session installing C the moment B is moved aside.
  const realRead = fs.readFile.bind(fs);
  fs.readFile = async (path) => {
    fs.files["/k"] = JSON.stringify(c);
    return realRead(path);
  };
  assert.equal(await retireKeyFile(fs, "/k", loaded), "superseded");
  assert.deepEqual(JSON.parse(fs.files["/k"]), c);
  assert.deepEqual(Object.keys(fs.files), ["/k"]);
});

test("a displaced listener never paints over a live newer listener's connected status", () => {
  const alive = (pid) => pid === 200;
  const live = { pid: 200, state: "connected" };
  // The newer process (200) is connected; the displaced one (100) reports stopped.
  assert.equal(shouldWriteStatus(live, 100, "stopped", alive), false);
  assert.equal(shouldWriteStatus(live, 100, "reconnecting", alive), false);
  // Its own file, a dead process, a non-connected file, or a connected report: write.
  assert.equal(shouldWriteStatus(live, 200, "stopped", alive), true);
  assert.equal(shouldWriteStatus({ pid: 300, state: "connected" }, 100, "stopped", alive), true);
  assert.equal(shouldWriteStatus({ pid: 200, state: "reconnecting" }, 100, "stopped", alive), true);
  assert.equal(shouldWriteStatus(live, 100, "connected", alive), true);
  assert.equal(shouldWriteStatus(null, 100, "stopped", alive), true);
});
