import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_PREAMBLE } from "../../monitors/listen-core.mjs";
import { createCopilotStore } from "./store.mjs";
import {
  MINT_DENIED,
  createUnpagedCopilotController,
  parseUnpagedToolName,
  resolveUnpagedMcpToolName,
  scrubToolResult,
} from "./copilot-core.mjs";

const DOC_A = "11111111-2222-3333-4444-555555555555";
const DOC_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KEY_1 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";
const KEY_2 = "ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkj";

function mintPayload(documentId = DOC_A, key = KEY_1, keyId = "key_one", documentTitle = "Sprint Plan") {
  return {
    pollUrl: "https://mcp.unpaged.io/events/poll",
    key,
    documentId,
    keyId,
    documentTitle,
  };
}

function sampleEvent(documentId = DOC_A, id = "evt_1") {
  return {
    type: "agent-inbox-event",
    schemaVersion: 1,
    id,
    reason: "mention",
    documentId,
    nodeId: "node_root",
    threadId: "thread_12345678",
    commentId: "comment_1",
    anchorElementId: null,
    resolved: false,
    documentTitle: "Sprint Plan",
    nodeTitle: "Overview",
    authorName: "Ada",
    authorRole: "editor",
    textPreview: "@agent split phase 2 into backend and UI",
    boardUrl: `https://unpaged.io/document/${documentId}/edit`,
    createdAt: "2026-11-12T00:00:00.000Z",
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "unpaged-copilot-ext-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("store writes mode-0600 listener configs, retires safely on 401, and walks up to .unpaged/architecture.json", async () => {
  await withTempDir(async (dir) => {
    const copilotHome = join(dir, "copilot-home");
    const store = createCopilotStore({ copilotHome, pid: 4242 });

    const cfg1 = {
      pollUrl: "https://mcp.unpaged.io/events/poll",
      key: KEY_1,
      documentId: DOC_A,
      keyId: "key_1",
      title: "Plan A",
      cwd: "/repo/a",
      createdAt: "2026-11-12T00:00:00.000Z",
    };
    await store.saveListener(cfg1);

    const fileStat = await stat(join(store.keyDir, `${DOC_A}.json`));
    if (process.platform !== "win32") {
      assert.equal(fileStat.mode & 0o777, 0o600);
    }

    const loaded = await store.loadListener(DOC_A);
    assert.equal(loaded?.key, KEY_1);
    assert.equal((await store.listListeners()).length, 1);

    // If another session saved a newer key before 401 retirement runs, keep the newer key.
    const cfg2 = { ...cfg1, key: KEY_2, keyId: "key_2" };
    await store.saveListener(cfg2);
    assert.equal(await store.retireListener(DOC_A, cfg1), "kept-newer");
    assert.equal((await store.loadListener(DOC_A))?.keyId, "key_2");

    // Retiring the matching config removes it.
    assert.equal(await store.retireListener(DOC_A, cfg2), "removed");
    assert.equal(await store.loadListener(DOC_A), null);

    // Refuses non-Unpaged polling URLs.
    await assert.rejects(
      () => store.saveListener({ ...cfg1, pollUrl: "https://evil.example.com/events/poll" }),
      /invalid_listener_config/
    );

    // Walks up from nested monorepo folder to find .git and .unpaged/architecture.json.
    const repoRoot = join(dir, "monorepo");
    const nested = join(repoRoot, "apps", "web", "src");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(join(repoRoot, ".unpaged"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(repoRoot, ".unpaged", "architecture.json"),
      JSON.stringify({ documentId: DOC_B, title: "Monorepo Arch" })
    );
    const pointer = await store.readArchitecturePointer(nested);
    assert.deepEqual(pointer, { documentId: DOC_B, title: "Monorepo Arch" });
  });
});

test("parseUnpagedToolName matches Copilot hyphenated, custom-server, and Claude names without matching extension tools", () => {
  assert.equal(parseUnpagedToolName("unpaged-agent_listener_key_create"), "agent_listener_key_create");
  assert.equal(parseUnpagedToolName("unpaged-staging-batch_create_elements"), "batch_create_elements");
  assert.equal(parseUnpagedToolName("mcp__plugin_unpaged_unpaged__document_create"), "document_create");
  assert.equal(parseUnpagedToolName("mcp__unpaged__listen_arm"), null);
  assert.equal(parseUnpagedToolName("mcp__unpaged__listen_status"), null);

  const meta = [{ name: "custom-create-key", mcpServerName: "unpaged_eu", mcpToolName: "agent_listener_key_create" }];
  assert.equal(parseUnpagedToolName("custom-create-key", meta), "agent_listener_key_create");
  assert.equal(resolveUnpagedMcpToolName("agent_listener_key_create", meta), "custom-create-key");
  assert.equal(resolveUnpagedMcpToolName("agent_listener_key_revoke", meta), "unpaged-agent_listener_key_revoke");
});

test("listen_arm captures raw key, scrubs all toolResult fields in onPostToolUse, replaces old key, and delivers @agent events", async () => {
  await withTempDir(async (dir) => {
    const store = createCopilotStore({ copilotHome: join(dir, "copilot") });
    await store.saveListener({
      pollUrl: "https://mcp.unpaged.io/events/poll",
      key: KEY_1,
      documentId: DOC_A,
      keyId: "old_key_id",
      title: "Old Title",
      cwd: dir,
      createdAt: "2026-11-11T00:00:00.000Z",
    });

    const executed = [];
    const postOutputs = [];
    const prompts = [];
    const logs = [];
    let pollCount = 0;

    let controller;
    const executeThroughHooks = async (name, args) => {
      executed.push({ name, args });
      const pre = await controller.hooks.onPreToolUse({
        toolName: name,
        toolArgs: args,
        workingDirectory: dir,
      });
      assert.equal(pre?.permissionDecision, undefined);
      const effectiveArgs = pre?.modifiedArgs ?? args;

      let rawResult;
      if (name === "unpaged-agent_listener_key_create") {
        const rawJson = JSON.stringify(mintPayload(effectiveArgs.documentId, KEY_2, "new_key_id", "Sprint Plan"));
        rawResult = {
          textResultForLlm: rawJson,
          resultType: "success",
          sessionLog: rawJson,
          contents: [{ type: "text", text: rawJson }],
        };
      } else {
        rawResult = {
          textResultForLlm: JSON.stringify({ revoked: true }),
          resultType: "success",
          sessionLog: "ok",
          contents: [{ type: "text", text: "ok" }],
        };
      }

      const post = await controller.hooks.onPostToolUse({
        toolName: name,
        toolArgs: effectiveArgs,
        toolResult: rawResult,
        workingDirectory: dir,
      });
      if (post) postOutputs.push(post);
      return post?.modifiedResult ?? rawResult;
    };

    controller = createUnpagedCopilotController({
      executeTool: executeThroughHooks,
      log: async (msg) => logs.push(msg),
      sendPrompt: async (p) => prompts.push(p),
      getCwd: async () => dir,
      store,
      hostName: "macbook.local",
      flushDelayMs: 5,
      poll: async (_cfg, { signal }) => {
        pollCount += 1;
        if (pollCount === 1) {
          return { events: [sampleEvent(DOC_A, "evt_100")], nextCursor: "cur_1", cadence: { intervalMs: 5000 } };
        }
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("poll_aborted");
      },
    });

    const armTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_arm");
    const statusTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_status");
    const stopTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_stop");

    const armReply = await armTool.handler({ documentId: DOC_A, title: "Sprint Plan" });
    assert.match(armReply, /Listening on Sprint Plan/);
    assert.match(armReply, /connected/);
    assert.ok(!armReply.includes(KEY_2));

    // Verify every field of modifiedResult in onPostToolUse was scrubbed of KEY_2!
    assert.equal(postOutputs.length, 1);
    const serializedPost = JSON.stringify(postOutputs[0]);
    assert.ok(!serializedPost.includes(KEY_2), "scrubbed output must never contain secret key");
    assert.deepEqual(Object.keys(scrubToolResult("ok")).sort(), ["contents", "resultType", "sessionLog", "textResultForLlm"]);

    // Wait for batched event prompt flush and background old-key revoke.
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].startsWith("The unpaged plugin sent a message:\n"));
    assert.ok(prompts[0].includes(PROTOCOL_PREAMBLE));
    assert.ok(prompts[0].includes('"id":"evt_100"'));
    assert.ok(!prompts[0].includes(KEY_2));

    assert.ok(executed.some((c) => c.name === "unpaged-agent_listener_key_revoke" && c.args.keyId === "old_key_id"));

    const statusReply = await statusTool.handler({});
    assert.match(statusReply, /Sprint Plan/);
    assert.match(statusReply, /this folder, key new_key_id/);
    assert.match(statusReply, /This machine's key label: copilot on macbook/);
    assert.ok(!statusReply.includes(KEY_2));

    // Duplicate agent mint while listening is denied in onPreToolUse so it cannot kill the active listener.
    const dupPre = await controller.hooks.onPreToolUse({
      toolName: "unpaged-agent_listener_key_create",
      toolArgs: { documentId: DOC_A },
      workingDirectory: dir,
    });
    assert.equal(dupPre?.permissionDecision, "deny");

    // Stop revokes new_key_id and retires stored config.
    const stopReply = await stopTool.handler({ documentId: DOC_A });
    assert.match(stopReply, /Sprint Plan: stopped, key revoked/);
    assert.equal(await store.loadListener(DOC_A), null);
    controller.shutdown();
  });
});

test("agent-initiated mint injects machine label, scrubs secret key, starts listener, and asks agent to revoke replaced key", async () => {
  await withTempDir(async (dir) => {
    const store = createCopilotStore({ copilotHome: join(dir, "copilot") });
    await store.saveListener({
      pollUrl: "https://mcp.unpaged.io/events/poll",
      key: KEY_1,
      documentId: DOC_A,
      keyId: "prev_key_99",
      title: "Canvas A",
      cwd: dir,
      createdAt: "2026-11-11T00:00:00.000Z",
    });

    const controller = createUnpagedCopilotController({
      executeTool: async () => ({ resultType: "success", textResultForLlm: "{}" }),
      store,
      getCwd: async () => dir,
      hostName: "devbox",
      poll: async (_cfg, { signal }) => {
        if (!signal.aborted) return { events: [], nextCursor: null, cadence: {} };
        throw new Error("aborted");
      },
      sleep: async (_ms, signal) => {
        if (!signal.aborted) await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
      },
    });

    const pre = await controller.hooks.onPreToolUse({
      toolName: "unpaged-agent_listener_key_create",
      toolArgs: { documentId: DOC_A, label: "wrong-label" },
      workingDirectory: dir,
    });
    assert.deepEqual(pre?.modifiedArgs, { documentId: DOC_A, label: "copilot on devbox" });

    const rawJson = JSON.stringify(mintPayload(DOC_A, KEY_2, "fresh_key_77", "Canvas A"));
    const post = await controller.hooks.onPostToolUse({
      toolName: "unpaged-agent_listener_key_create",
      toolArgs: pre.modifiedArgs,
      toolResult: {
        textResultForLlm: rawJson,
        resultType: "success",
        sessionLog: rawJson,
        contents: [{ type: "text", text: rawJson }],
      },
      workingDirectory: dir,
    });

    assert.ok(!JSON.stringify(post).includes(KEY_2));
    assert.match(post.modifiedResult.textResultForLlm, /Listening on Canvas A/);
    assert.match(post.modifiedResult.textResultForLlm, /revoke it now with agent_listener_key_revoke and keyId prev_key_99/);

    // Failed revoke does NOT forget unrevoked key; successful revoke DOES forget it.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-agent_listener_key_revoke",
      toolArgs: { keyId: "prev_key_99" },
      toolResult: { resultType: "failure", textResultForLlm: "network error" },
      cwd: dir,
    });
    assert.match(
      await controller.tools.find((t) => t.name === "mcp__unpaged__listen_status").handler({}),
      /prev_key_99/
    );

    // Once agent revokes prev_key_99, onPostToolUse forgets it from unrevoked.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-agent_listener_key_revoke",
      toolArgs: { keyId: "prev_key_99" },
      toolResult: { resultType: "success", textResultForLlm: "{}" },
      cwd: dir,
    });
    const statusText = await controller.tools.find((t) => t.name === "mcp__unpaged__listen_status").handler({});
    assert.ok(!statusText.includes("prev_key_99"));

    // Even a malformed call without documentId still scrubs any mint secret.
    const badPost = await controller.hooks.onPostToolUse({
      toolName: "unpaged-agent_listener_key_create",
      toolArgs: {},
      toolResult: { textResultForLlm: rawJson, resultType: "success", sessionLog: rawJson },
      workingDirectory: dir,
    });
    assert.ok(!JSON.stringify(badPost).includes(KEY_2));

    controller.shutdown();
  });
});

test("HTTP 401 retires key without revoking on stop; HTTP 409 preserves stored key; denied mint returns MINT_DENIED", async () => {
  await withTempDir(async (dir) => {
    const store = createCopilotStore({ copilotHome: join(dir, "copilot") });
    const revokes = [];
    let terminalStatus = 401;
    let mintResultType = "success";
    const prompts = [];

    const controller = createUnpagedCopilotController({
      executeTool: async (name) => {
        if (name === "unpaged-agent_listener_key_create") {
          if (mintResultType !== "success") return { resultType: mintResultType, textResultForLlm: "denied" };
          return { resultType: "success", textResultForLlm: JSON.stringify(mintPayload(DOC_A, KEY_1, "k401", "Auth Doc")) };
        }
        revokes.push(name);
        return { resultType: "success", textResultForLlm: "{}" };
      },
      sendPrompt: async (p) => prompts.push(p),
      store,
      getCwd: async () => dir,
      flushDelayMs: 5,
      poll: async () => ({ terminal: terminalStatus }),
    });

    const armTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_arm");
    const stopTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_stop");

    await armTool.handler({ documentId: DOC_A });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(await store.loadListener(DOC_A), null, "401 retires stored key");
    assert.ok(prompts.some((p) => p.includes("HTTP 401")));

    // Stopping after HTTP 401 makes no unnecessary revoke call.
    await stopTool.handler({ documentId: DOC_A });
    assert.equal(revokes.length, 0);

    // HTTP 409 stops without deleting stored key.
    terminalStatus = 409;
    await armTool.handler({ documentId: DOC_A });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal((await store.loadListener(DOC_A))?.keyId, "k401", "409 keeps stored key intact");
    assert.ok(prompts.some((p) => p.includes("HTTP 409")));

    // Denied mint returns MINT_DENIED.
    mintResultType = "denied";
    const deniedReply = await armTool.handler({ documentId: DOC_B });
    assert.equal(deniedReply, MINT_DENIED);

    controller.shutdown();
  });
});

test("offers listening once on canvas create/edit, handles exit_plan_mode, stops on document_delete, and runs PR architecture comparison", async () => {
  await withTempDir(async (dir) => {
    const repoRoot = join(dir, "repo");
    await mkdir(join(repoRoot, ".git"), { recursive: true });
    await mkdir(join(repoRoot, ".unpaged"), { recursive: true });
    await writeFile(
      join(repoRoot, ".unpaged", "architecture.json"),
      JSON.stringify({ documentId: DOC_B, title: "Service Arch" })
    );

    const store = createCopilotStore({ copilotHome: join(dir, "copilot") });
    const prompts = [];
    const logs = [];

    const controller = createUnpagedCopilotController({
      executeTool: async (name, args) => {
        if (name === "unpaged-agent_listener_key_create") {
          return { resultType: "success", textResultForLlm: JSON.stringify(mintPayload(args.documentId, KEY_1, "k_del", "Temp")) };
        }
        return { resultType: "success", textResultForLlm: "{}" };
      },
      sendPrompt: async (p) => prompts.push(p),
      log: async (m) => logs.push(m),
      getCwd: async () => repoRoot,
      store,
      submitDelayMs: 5,
      architectureCommandPath: "/plugins/unpaged/commands/architecture.md",
      planApprovedContext: "STAMP_EXECUTING_CONTEXT",
      poll: async (_cfg, { signal }) => {
        if (!signal.aborted) return { events: [], nextCursor: null, cadence: {} };
        throw new Error("aborted");
      },
      sleep: async (_ms, signal) => {
        if (!signal.aborted) await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
      },
    });

    // Rejected exit_plan_mode does NOT inject plan-approved context; accepted exit_plan_mode does.
    const rejectedPlanOut = await controller.hooks.onPostToolUse({
      toolName: "exit_plan_mode",
      toolArgs: {},
      toolResult: { resultType: "rejected", textResultForLlm: "revise phase 1" },
      cwd: repoRoot,
    });
    assert.equal(rejectedPlanOut, undefined);

    const planOut = await controller.hooks.onPostToolUse({
      toolName: "exit_plan_mode",
      toolArgs: {},
      toolResult: { resultType: "success", textResultForLlm: "approved" },
      cwd: repoRoot,
    });
    assert.equal(planOut?.additionalContext, "STAMP_EXECUTING_CONTEXT");

    // document_create offers listening once, then subsequent edits on same canvas do not repeat.
    const createOut = await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "Roadmap" },
      toolResult: { resultType: "success", textResultForLlm: JSON.stringify({ id: DOC_A, title: "Roadmap" }) },
      workingDirectory: repoRoot,
    });
    assert.match(createOut?.additionalContext ?? "", /offer that in one short question/);

    const editOut = await controller.hooks.onPostToolUse({
      toolName: "unpaged-batch_create_elements",
      toolArgs: { documentId: DOC_A },
      toolResult: { resultType: "success", textResultForLlm: "{}" },
      workingDirectory: repoRoot,
    });
    assert.equal(editOut, undefined);

    // Slash command /unpaged-listen arms and document_delete stops it.
    const cmd = controller.commands.find((c) => c.name === "unpaged-listen");
    await cmd.handler({ args: `arm ${DOC_A}` });
    assert.ok(logs.some((l) => l.includes(`Listening on`)));

    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_delete",
      toolArgs: { documentId: DOC_A },
      toolResult: { resultType: "success", textResultForLlm: "{}" },
      workingDirectory: repoRoot,
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(await store.loadListener(DOC_A), null);

    // --dry-run gh pr create does NOT trigger architecture comparison.
    await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: "gh pr create --dry-run" },
      toolResult: {
        resultType: "success",
        textResultForLlm: "Would have created a Pull Request with:\nhttps://github.com/org/repo/pull/1",
      },
      workingDirectory: repoRoot,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(prompts.length, 0);

    // Real gh pr create triggers comparison prompt, and architecture_report settles and persists verdict.
    await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: "gh pr create --title test --body ok" },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/org/repo/pull/42\n",
      },
      workingDirectory: repoRoot,
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /https:\/\/github\.com\/org\/repo\/pull\/42/);
    assert.match(prompts[0], /architecture\.md/);

    const archTool = controller.tools.find((t) => t.name === "mcp__unpaged__architecture_report");
    const reportOut = await archTool.handler({
      documentId: DOC_B,
      state: "current",
      checkedAt: "2026-11-12",
      commit: "abc1234",
      title: "Service Arch",
    });
    assert.match(reportOut, /up to date · checked 12 Nov/);

    await controller.hooks.onSessionStart({ cwd: repoRoot, source: "startup" });
    assert.ok(logs.some((l) => l.includes("Architecture (Service Arch): up to date")));

    await controller.hooks.onSessionEnd();
  });
});
