import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POINTER_RELATIVE, SYNC_COOLDOWN_MS } from "../../monitors/architecture-core.mjs";
import { canonicalPath, saveVerdictForRepo } from "../../monitors/architecture.mjs";
import {
  createArchitectureSidecarServer,
  createDefaultAgentApi,
  parseFileWorkspaceUris,
} from "./app.mjs";

const DOC_1 = "21655eba-fa32-4a7d-8249-4ee28c8f1157";
const DOC_2 = "2a12a251-35ae-47d1-9426-4ab7e4b0dc9b";
const PANEL_JS = fileURLToPath(new URL("./panel.js", import.meta.url));
const PANEL_HTML = fileURLToPath(new URL("./panel.html", import.meta.url));

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

      // CORS headers, OPTIONS preflight, HEAD support, and validated HTML token injection.
      const optionsRes = await fetch(`${base}/api/status`, { method: "OPTIONS" });
      assert.equal(optionsRes.status, 204);
      assert.equal(optionsRes.headers.get("access-control-allow-origin"), "*");
      assert.ok((optionsRes.headers.get("access-control-allow-headers") || "").includes("X-Sidecar-Token"));

      const headJs = await fetch(`${base}/panel.js`, { method: "HEAD" });
      assert.equal(headJs.status, 200);
      assert.equal(await headJs.text(), "");

      const tokenizedHtmlRes = await fetch(`${base}/?token=secret-token&conversationId=conv-42`);
      assert.equal(tokenizedHtmlRes.status, 200);
      assert.equal(tokenizedHtmlRes.headers.get("access-control-allow-origin"), "*");
      const tokenizedHtml = await tokenizedHtmlRes.text();
      assert.ok(tokenizedHtml.includes('/panel.css?token=secret-token&conversationId=conv-42'));
      assert.ok(tokenizedHtml.includes('/preload.js?token=secret-token&conversationId=conv-42'));
      assert.ok(tokenizedHtml.includes('/panel.js?token=secret-token&conversationId=conv-42'));

      const wrongTokenHtmlRes = await fetch(`${base}/?token=wrong-token`);
      assert.equal(wrongTokenHtmlRes.status, 200);
      const wrongTokenHtml = await wrongTokenHtmlRes.text();
      assert.ok(!wrongTokenHtml.includes("wrong-token"));

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

      const newConvRes = await fetch(`${base}/_sidecar/new-conversation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sidecar-Token": "secret-token",
        },
        body: JSON.stringify({ message: "hello", model: "flash_lite", title: "Demo Title", projectId: "proj-1" }),
      });
      assert.equal(newConvRes.status, 200);
      assert.equal(agentCalls.length, 2);
      assert.equal(agentCalls[1].kind, "startConversation");
      assert.equal(agentCalls[1].opts.title, "Demo Title");
    } finally {
      await app.close();
    }
  });
});

test("createDefaultAgentApi passes --model, sanitized --title, and -- before prompt", async () => {
  const seen = [];
  const api = createDefaultAgentApi(async (args, opts) => {
    seen.push({ args, opts });
    return { conversationId: "c-1" };
  });

  await api.startConversation("--help me", {
    model: "flash_lite",
    title: "Unpaged Architecture · demo\nrepo",
    projectId: "proj-1",
  });
  await api.startConversation("hi", { model: "flash", title: "--leading-dash" });

  assert.deepEqual(seen[0], {
    args: ["new-conversation", "--model", "flash_lite", "--title", "Unpaged Architecture · demo repo", "--", "--help me"],
    opts: { projectId: "proj-1" },
  });
  assert.deepEqual(seen[1], {
    args: ["new-conversation", "--model", "flash", "--", "hi"],
    opts: { projectId: undefined },
  });
});

test("/api/sync-status auto-syncs unknown repos once, deduplicates concurrent calls, handles failures cleanly, and honors 6h cooldown", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repoUnknown = join(dir, "repo-unknown");
    const repoCurrent = join(dir, "repo-current");
    const repoNone = join(dir, "repo-none");
    const outsideRepo = join(dir, "outside");
    for (const r of [repoUnknown, repoCurrent, repoNone, outsideRepo]) {
      await mkdir(join(r, ".git"), { recursive: true });
      await mkdir(join(r, ".unpaged"), { recursive: true });
    }
    await writeFile(join(repoUnknown, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "beta" }), "utf8");
    await writeFile(join(repoCurrent, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_2, title: "gamma" }), "utf8");
    await saveVerdictForRepo(
      repoCurrent,
      { documentId: DOC_2, state: "current", checkedAt: "2026-11-25", commit: "abcdef1" },
      { homeDir, now: () => Date.parse("2026-11-25T10:00:00Z") }
    );

    let nowMs = Date.parse("2026-11-25T12:00:00Z");
    const workspaceUris = [
      pathToFileURL(repoUnknown).href,
      pathToFileURL(repoCurrent).href,
      pathToFileURL(repoNone).href,
    ];

    let startBehavior = "succeed";
    let releaseDeferred = null;
    const startCalls = [];
    const metaCalls = [];
    const mockAgentApi = {
      async sendMessage() {
        return { success: true };
      },
      async getConversationMetadata(conversationId) {
        metaCalls.push(conversationId);
        return { response: { conversationMetadata: { metadata: { projectId: "proj-from-meta" } } } };
      },
      async startConversation(message, opts) {
        startCalls.push({ message, opts });
        if (startBehavior === "fail") {
          return { error: "no active project" };
        }
        if (startBehavior === "deferred") {
          await new Promise((resolve) => {
            releaseDeferred = resolve;
          });
        }
        return { conversationId: `sync-conv-${startCalls.length}` };
      },
    };

    const app = createArchitectureSidecarServer({
      port: 0,
      token: "secret-token",
      preloadJs: "// preload\n",
      agentApi: mockAgentApi,
      homeDir,
      defaultProjectId: "",
      now: () => nowMs,
    });
    const boundPort = await app.listen();
    const base = `http://127.0.0.1:${boundPort}`;
    const post = (path, body) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": "secret-token" },
        body: JSON.stringify(body),
      });

    try {
      // 1. Unauthorized repo outside workspace -> 403.
      assert.equal(
        (await post("/api/sync-status", { repoRoot: outsideRepo, workspaceUris })).status,
        403
      );

      // 2. Non-unknown repos (current / none) do not start background chats.
      const currentRes = await (await post("/api/sync-status", { repoRoot: repoCurrent, workspaceUris })).json();
      assert.equal(currentRes.started, false);
      assert.equal(currentRes.reason, "not-unknown");
      const noneRes = await (await post("/api/sync-status", { repoRoot: repoNone, workspaceUris })).json();
      assert.equal(noneRes.started, false);
      assert.equal(startCalls.length, 0);

      // 3. Failure to start conversation clears active run without triggering cooldown.
      startBehavior = "fail";
      const failRes = await (
        await post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris, conversationId: "conv-parent" })
      ).json();
      assert.equal(failRes.ok, false);
      assert.equal(failRes.started, false);
      assert.equal(failRes.error, "no active project");
      assert.equal(failRes.status.shown, "unknown");
      assert.equal(failRes.status.syncCooldownActive, false);
      assert.deepEqual(metaCalls, ["conv-parent"]);

      // 4. Concurrent sync-status requests deduplicate to one flash_lite conversation.
      startBehavior = "deferred";
      const p1 = post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris, conversationId: "conv-parent" });
      while (!releaseDeferred) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const p2 = post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris, conversationId: "conv-parent" });
      const res2 = await (await p2).json();
      assert.equal(res2.started, false);
      assert.equal(res2.reason, "in-flight");
      releaseDeferred();
      const res1 = await (await p1).json();
      assert.equal(res1.ok, true);
      assert.equal(res1.started, true);
      assert.equal(res1.status.shown, "comparing");
      assert.equal(res1.status.activeRun.action, "sync");
      assert.equal(startCalls.length, 2);
      assert.equal(startCalls[1].opts.model, "flash_lite");
      assert.equal(startCalls[1].opts.title, "Unpaged Architecture · repo-unknown");
      assert.equal(startCalls[1].opts.projectId, "proj-from-meta");

      // 5. While comparing, another call is a no-op; after clear-run, cooldown blocks auto-retry until force or 6h.
      const whileBusy = await (await post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris })).json();
      assert.equal(whileBusy.started, false);
      assert.equal(whileBusy.reason, "not-unknown");

      const cleared = await (await post("/api/clear-run", { repoRoot: repoUnknown, workspaceUris })).json();
      assert.equal(cleared.status.shown, "unknown");
      assert.equal(cleared.status.syncCooldownActive, true);

      const duringCooldown = await (await post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris })).json();
      assert.equal(duringCooldown.started, false);
      assert.equal(duringCooldown.reason, "cooldown");

      startBehavior = "succeed";
      const forced = await (
        await post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris, force: true, conversationId: "conv-parent" })
      ).json();
      assert.equal(forced.started, true);
      assert.equal(startCalls.length, 3);

      // Cooldown expires after 6h.
      await post("/api/clear-run", { repoRoot: repoUnknown, workspaceUris });
      nowMs += SYNC_COOLDOWN_MS + 1;
      const afterCooldown = await (
        await post("/api/sync-status", { repoRoot: repoUnknown, workspaceUris, conversationId: "conv-parent" })
      ).json();
      assert.equal(afterCooldown.started, true);
      assert.equal(startCalls.length, 4);
      assert.ok(startCalls[3].message.includes(canonicalPath(repoUnknown)));
    } finally {
      await app.close();
    }
  });
});

test("sidecar POST routes fail closed with 401 when no token is configured, without calling agentApi", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    let agentCalls = 0;
    const mockAgentApi = {
      async sendMessage() {
        agentCalls++;
        return { success: true };
      },
      async startConversation() {
        agentCalls++;
        return { conversationId: "should-not-start" };
      },
      async getConversationMetadata() {
        agentCalls++;
        return {};
      },
    };

    for (const badToken of ["", "   "]) {
      const app = createArchitectureSidecarServer({
        port: 0,
        token: badToken,
        preloadJs: "// preload\n",
        agentApi: mockAgentApi,
        homeDir,
      });
      const boundPort = await app.listen();
      const base = `http://127.0.0.1:${boundPort}`;
      try {
        assert.equal((await fetch(`${base}/`)).status, 200);
        for (const [route, payload] of [
          ["/api/status", { workspaceUris: [pathToFileURL(repo).href] }],
          ["/api/start-run", { repoRoot: repo, action: "compare", workspaceUris: [pathToFileURL(repo).href] }],
          ["/api/sync-status", { repoRoot: repo, workspaceUris: [pathToFileURL(repo).href] }],
          ["/_sidecar/new-conversation", { message: "ATTACKER PROMPT" }],
        ]) {
          const res = await fetch(`${base}${route}`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(payload),
          });
          assert.equal(res.status, 401, `${route} should fail closed for empty token`);
        }
      } finally {
        await app.close();
      }
    }
    assert.equal(agentCalls, 0);
  });
});

test("/api/start-run distinguishes workspace repos sharing the same folder name by full path", async () => {
  await withTempDir(async (dir) => {
    const homeDir = join(dir, "home");
    const repoA = join(dir, "team-a", "app");
    const repoB = join(dir, "team-b", "app");
    for (const r of [repoA, repoB]) {
      await mkdir(join(r, ".git"), { recursive: true });
      await mkdir(join(r, ".unpaged"), { recursive: true });
      await writeFile(join(r, POINTER_RELATIVE), JSON.stringify({ documentId: DOC_1, title: "app" }), "utf8");
    }
    const workspaceUris = [pathToFileURL(repoA).href, pathToFileURL(repoB).href];
    const app = createArchitectureSidecarServer({
      port: 0,
      token: "secret-token",
      preloadJs: "// preload\n",
      homeDir,
    });
    const boundPort = await app.listen();
    const base = `http://127.0.0.1:${boundPort}`;
    try {
      const startB = await fetch(`${base}/api/start-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Sidecar-Token": "secret-token" },
        body: JSON.stringify({ repoRoot: repoB, action: "compare", workspaceUris }),
      });
      assert.equal(startB.status, 200);
      const dataB = await startB.json();
      assert.ok(dataB.prompt.includes(canonicalPath(repoB)));
      assert.ok(!dataB.prompt.includes(canonicalPath(repoA)));
    } finally {
      await app.close();
    }
  });
});

test("panel.html loads panel.js as a classic script, avoids inline code, and renders a loading fallback", async () => {
  const html = await readFile(PANEL_HTML, "utf8");
  assert.ok(html.includes('<script src="/panel.js"></script>'));
  assert.ok(!html.includes('type="module"'));
  assert.ok(/<main\b[^>]*id="app"[^>]*>[\s\S]*Loading architecture status/.test(html));
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.equal(scriptTags.length, 2);
  for (const [, attrs, inlineBody] of scriptTags) {
    assert.ok(/\bsrc=/.test(attrs));
    assert.equal(inlineBody.trim(), "");
  }
});
