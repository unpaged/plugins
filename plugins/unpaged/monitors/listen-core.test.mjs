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

test("parseListenerConfig accepts the per-board shape and rejects the rest", () => {
  const good = JSON.stringify({
    url: "wss://mcp.unpaged.io/events",
    protocols: [SUBPROTOCOL, "abc"],
    documentId: DOC
  });
  assert.deepEqual(parseListenerConfig(good), {
    url: "wss://mcp.unpaged.io/events",
    protocols: [SUBPROTOCOL, "abc"],
    documentId: DOC,
    keyId: null,
    title: "",
    cwd: null,
    createdAt: null
  });
  const full = parseListenerConfig(
    JSON.stringify({
      url: "wss://x",
      protocols: [SUBPROTOCOL, "k"],
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

test("close policy stops on 4401 (dropping the key file) and 4409, reconnects otherwise", () => {
  assert.equal(closePolicy(4401, DOC).action, "stop");
  assert.equal(closePolicy(4401, DOC).deleteKeyFile, true);
  assert.match(closePolicy(4401, DOC).line, new RegExp(`/unpaged:listen arm ${DOC}`));
  assert.match(closePolicy(4401).line, /\/unpaged:visual-plan/);
  assert.equal(closePolicy(4409, DOC).action, "stop");
  assert.equal(closePolicy(4409, DOC).deleteKeyFile, undefined);
  assert.equal(closePolicy(4409, DOC).superseded, true);
  assert.equal(closePolicy(4401, DOC).superseded, undefined);
  assert.match(closePolicy(4409, DOC).line, /took over/);
  assert.match(closePolicy(4409, DOC).line, new RegExp(DOC));
  assert.equal(closePolicy(1003).action, "stop");
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
  const a = { url: "wss://x", protocols: [SUBPROTOCOL, "k1"], documentId: DOC, keyId: null };
  assert.equal(sameListenerConfig(a, { ...a }), true);
  assert.equal(sameListenerConfig(a, { ...a, protocols: [SUBPROTOCOL, "k2"] }), false);
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

const cfg = (key, keyId) => ({ url: "wss://x/events", protocols: [SUBPROTOCOL, key], documentId: DOC, keyId });

test("rejected-key line follows the retire outcome: re-arm only when this session's file is gone", () => {
  for (const outcome of ["removed", "absent"]) {
    const line = rejectedKeyLine(outcome, DOC);
    assert.match(line, /the stored key file was retired/);
    assert.match(line, new RegExp(`/unpaged:listen arm ${DOC}`));
    assert.match(line, /\/unpaged:visual-plan/);
  }
  for (const outcome of ["kept-newer", "superseded"]) {
    const line = rejectedKeyLine(outcome, DOC);
    assert.match(line, /newer key for this canvas is already stored/);
    assert.doesNotMatch(line, /\/unpaged:listen arm/);
    assert.doesNotMatch(line, /was retired/);
  }
  assert.equal(closePolicy(4401, DOC).line, rejectedKeyLine("removed", DOC));
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
