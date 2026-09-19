import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";

const DOC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const QUEUE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const storeModule = new URL("./store.mjs", import.meta.url).href;
const childCode = `
  import { Store } from ${JSON.stringify(storeModule)};
  const {path,boundary,binding,event}=JSON.parse(await new Promise(resolve=>{
    let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>resolve(s));
  }));
  const store=new Store(path);store.bind(binding);
  const {token}=store.claimWorker(binding.documentId,{pid:process.pid});
  store.receive(binding.documentId,event,token);
  if(boundary!=='received') store.markDispatching(binding.documentId,event.id,token);
  if(boundary==='processing') {
    store.markQueued(binding.documentId,event.id,token,${JSON.stringify(QUEUE)});
    store.begin(binding.documentId,event.id,{expectedThreadId:binding.threadId});
  }
  process.kill(process.pid,'SIGKILL');
`;

for (const [boundary, expected] of [["received", "received"], ["dispatching", "queue_uncertain"], ["processing", "effect_uncertain"]]) {
  test(`actual abrupt process death at ${boundary} preserves durable state as ${expected}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "unpaged-crash-test-"));
    try {
      const path = join(directory, "reviews.sqlite");
      const binding = { documentId: DOC, threadId: TASK, keyId: "testkey", url: "wss://mcp.unpaged.io/events",
        protocols: ["unpaged-listener.v1", "fake-test-credential"], codexPath: process.execPath, planDigest: "a".repeat(64) };
      const event = { id: "durable-event", documentId: DOC, nodeId: "node", threadId: "comment-thread", commentId: "comment",
        reason: "mention", authorRole: "owner", resolved: false, createdAt: "2026-01-01T00:00:00.000Z" };
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", childCode], {
        input: JSON.stringify({ path, boundary, binding, event }), encoding: "utf8", timeout: 10000, shell: false
      });
      assert.equal(child.signal, "SIGKILL", child.stderr);
      assert.equal(child.stdout, "");
      const restored = new Store(path);
      try {
        const { token, recovered } = restored.claimWorker(DOC, { pid: process.pid });
        assert.equal(recovered, true);
        assert.equal(restored.listEvents(DOC)[0].state, expected);
        assert.equal(restored.getBinding(DOC).threadId, TASK);
        assert.equal(restored.getBinding(DOC).reconciliationRequired, true);
        assert.equal(restored.receive(DOC, event, token).inserted, false);
        if (expected !== "received") assert.equal(restored.nextEvent(DOC, token), null);
        restored.releaseWorker(DOC, token);
      } finally { restored.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
