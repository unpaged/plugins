import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POINTER_RELATIVE } from "../../monitors/architecture-core.mjs";
import { saveVerdictForRepo } from "../../monitors/architecture.mjs";
import { createArchitectureSidecarServer, parseFileWorkspaceUris } from "./app.mjs";

const DOC_1 = "21655eba-fa32-4a7d-8249-4ee28c8f1157";
const PANEL_JS = fileURLToPath(new URL("./panel.js", import.meta.url));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "unpaged-agy-sidecar-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseFileWorkspaceUris extracts only file:// paths", () => {
  const uris = parseFileWorkspaceUris(["file:///tmp/demo", "https://example.com", "invalid", "", 42]);
  assert.equal(uris.length, 1);
  assert.ok(uris[0].endsWith("demo"));
});

test("panel.js contains zero innerHTML or insertAdjacentHTML calls (DOM safety)", async () => {
  const source = await readFile(PANEL_JS, "utf8");
  assert.equal(/\.innerHTML\s*=|\binsertAdjacentHTML\s*\(/.test(source), false);
});

test("sidecar HTTP server enforces loopback token auth, serves assets, tracks repo status/runs, and bridges agentapi", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repoA = join(dir, "repo-a");
    const repoB = join(dir, "repo-b");
    const outsideRepo = join(dir, "outside");
    for (const r of [repoA, repoB, outsideRepo]) {
      await mkdir(join(r, ".git"), { recursive: true });
      await mkdir(join(r, ".unpaged"), { recursive: true });
    }
    await writeFile(join(repoA, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "alpha" }), "utf8");
    await saveVerdictForRepo(
      repoA,
      { documentId: DOC_1, state: "current", checkedAt: "2026-11-24", commit: "abcdef1" },
      { homeDir, now: () => Date.parse("2026-11-24T12:00:00Z") }
    );

    const agentCalls = [];
    const mockAgentApi = {
      async sendMessage(conversationId, message, opts) {
        agentCalls.push({ kind: "sendMessage", conversationId, message, opts });
        return { success: true };
      },
      async startConversation(message, opts) {
        agentCalls.push({ kind: "startConversation", message, opts });
        return { conversationId: "new-conv-1" };
      },
      async getConversationMetadata(conversationId) {
        agentCalls.push({ kind: "getConversationMetadata", conversationId });
        return { response: { conversationMetadata: { metadata: { projectId: "proj-1" } } } };
      },
    };

    const app = createArchitectureSidecarServer({
      port: 0,
      token: "secret-token",
      preloadJs: "// test preload\n",
      agentApi: mockAgentApi,
      homeDir,
      now: () => Date.parse("2026-11-25T09:00:00Z"),
      maxBodyBytes: 4096,
    });

    const boundPort = await app.listen();
    const base = `http://127.0.0.1:${boundPort}`;
    try {
      // Static assets do not require the POST token.
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      assert.ok((await htmlRes.text()).includes("Unpaged Architecture"));

      const preloadRes = await fetch(`${base}/preload.js`);
      assert.equal(preloadRes.status, 200);
      assert.equal(await preloadRes.text(), "// test preload\n");

      // Token enforced on all POST routes (missing, short, and identical-length wrong tokens).
      const unauth = await fetch(`${base}/api/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceUris: [] }),
      });
      assert.equal(unauth.status, 401);

      const shortWrong = await fetch(`${base}/api/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": "short" },
        body: JSON.stringify({ workspaceUris: [] }),
      });
      assert.equal(shortWrong.status, 401);

      const equalLenWrong = await fetch(`${base}/api/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": "wrong-token!" },
        body: JSON.stringify({ workspaceUris: [] }),
      });
      assert.equal(equalLenWrong.status, 401);

      // Oversized payload returns 413.
      const tooBig = await fetch(`${base}/api/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ workspaceUris: ["file://" + "a".repeat(5000)] }),
      });
      assert.equal(tooBig.status, 413);

      // /api/status resolves both workspace repos (deduping subpaths inside repoA).
      const workspaceUris = [
        pathToFileURL(repoA).href,
        pathToFileURL(join(repoA, "nested")).href,
        pathToFileURL(repoB).href,
      ];
      const statusRes = await fetch(`${base}/api/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ workspaceUris }),
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.repos.length, 2);
      assert.equal(statusData.repos[0].shown, "current");
      assert.equal(statusData.repos[0].color, "green");
      assert.equal(statusData.repos[1].shown, "none");
      assert.equal(statusData.repos[1].color, "gray");

      // /api/start-run rejects repos outside the active workspace.
      const outsideStart = await fetch(`${base}/api/start-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ repoRoot: outsideRepo, action: "compare", workspaceUris }),
      });
      assert.equal(outsideStart.status, 403);

      // /api/start-run records comparing state and returns prompt; /api/clear-run resets it.
      const startRes = await fetch(`${base}/api/start-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ repoRoot: repoA, action: "compare", workspaceUris }),
      });
      assert.equal(startRes.status, 200);
      const startData = await startRes.json();
      assert.equal(startData.status.shown, "comparing");
      assert.equal(startData.status.color, "yellow");
      assert.match(startData.prompt, /compare/i);

      const clearRes = await fetch(`${base}/api/clear-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ repoRoot: repoA, workspaceUris }),
      });
      assert.equal(clearRes.status, 200);
      const clearData = await clearRes.json();
      assert.equal(clearData.status.shown, "current");

      // /_sidecar/* endpoints delegate safely to agentApi.
      const sendRes = await fetch(`${base}/_sidecar/send-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ conversationId: "conv-42", message: "hello", projectId: "proj-1" }),
      });
      assert.equal(sendRes.status, 200);
      assert.equal(agentCalls.length, 1);
      assert.equal(agentCalls[0].conversationId, "conv-42");
    } finally {
      await app.close();
    }
  });
});
