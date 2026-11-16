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

test("offers listening once on canvas create/edit, handles exit_plan_mode, stops on document_delete, and starts no architecture comparison when a pull request opens", async () => {
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
      // A fixed clock: the day label gains the year once the year changes, and a verdict goes stale after three months.
      now: () => Date.parse("2026-11-15T12:00:00Z"),
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

    // Opening a pull request, in the shell or through a GitHub MCP tool, starts no comparison: it is started by hand.
    const prOut = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: "gh pr create --title test --body ok" },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/org/repo/pull/42\n",
      },
      workingDirectory: repoRoot,
    });
    assert.equal(prOut, undefined);
    const mcpPrOut = await controller.hooks.onPostToolUse({
      toolName: "github-create_pull_request",
      toolArgs: { owner: "org", repo: "repo", title: "test" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ number: 43, html_url: "https://github.com/org/repo/pull/43" }),
      },
      workingDirectory: repoRoot,
    });
    assert.equal(mcpPrOut, undefined);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(prompts.length, 0);

    const archTool = controller.tools.find((t) => t.name === "mcp__unpaged__architecture_report");
    const reportOut = await archTool.handler({
      documentId: DOC_B,
      state: "current",
      checkedAt: "2026-11-12",
      commit: "abc1234",
      title: "Service Arch",
    });
    assert.match(reportOut, /status: checked 12 Nov\./);

    // The session-start status says how to start a comparison, since nothing starts one on its own.
    await controller.hooks.onSessionStart({ cwd: repoRoot, source: "startup" });
    assert.ok(
      logs.some((l) => l.includes("Architecture (Service Arch): checked 12 Nov · /unpaged:architecture compare checks it against the code"))
    );
    assert.equal(prompts.length, 0);

    await controller.hooks.onSessionEnd();
  });
});

test("keeps a multi-event poll in one prompt even when session.log is slower than flushDelayMs", async () => {
  await withTempDir(async (dir) => {
    const store = createCopilotStore({ copilotHome: join(dir, "copilot") });
    const prompts = [];
    const logs = [];
    let pollCount = 0;

    const controller = createUnpagedCopilotController({
      executeTool: async (name) => {
        if (name === "unpaged-agent_listener_key_create") {
          return {
            resultType: "success",
            textResultForLlm: JSON.stringify(mintPayload(DOC_A, KEY_1, "k_slow_log", "Slow Log Canvas")),
          };
        }
        return { resultType: "success", textResultForLlm: "{}" };
      },
      log: async (msg) => {
        await new Promise((r) => setTimeout(r, 80));
        logs.push(msg);
      },
      sendPrompt: async (p) => prompts.push(p),
      getCwd: async () => dir,
      store,
      flushDelayMs: 20,
      poll: async (_cfg, { signal }) => {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            events: [sampleEvent(DOC_A, "evt_slow_1"), sampleEvent(DOC_A, "evt_slow_2")],
            nextCursor: "cur_slow",
            cadence: { intervalMs: 5000 },
          };
        }
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throw new Error("poll_aborted");
      },
    });

    const armTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_arm");
    await armTool.handler({ documentId: DOC_A, title: "Slow Log Canvas" });
    await new Promise((r) => setTimeout(r, 140));

    assert.equal(prompts.length, 1);
    const lines = prompts[0].split("\n");
    assert.equal(lines[0], "The unpaged plugin sent a message:");
    assert.equal(lines[1], PROTOCOL_PREAMBLE);
    assert.equal(lines.length, 4);
    assert.ok(lines[2].includes('"id":"evt_slow_1"'));
    assert.ok(lines[3].includes('"id":"evt_slow_2"'));
    assert.equal(logs.filter((l) => l.includes("@agent on Slow Log Canvas")).length, 2);

    controller.shutdown();
  });
});

test("preserves the server refusal reason when an extension-initiated mint fails through onPostToolUse", async () => {
  await withTempDir(async (dir) => {
    const store = createCopilotStore({ copilotHome: join(dir, "copilot") });
    const postOutputs = [];
    let nextMintResult = {
      resultType: "failure",
      textResultForLlm: "Listener key limit reached (max 20)",
      sessionLog: "Listener key limit reached (max 20)",
    };

    let controller;
    const executeThroughHooks = async (name, args) => {
      const pre = await controller.hooks.onPreToolUse({
        toolName: name,
        toolArgs: args,
        workingDirectory: dir,
      });
      const effectiveArgs = pre?.modifiedArgs ?? args;
      const rawResult = nextMintResult;
      const post = await controller.hooks.onPostToolUse({
        toolName: name,
        toolArgs: effectiveArgs,
        toolResult: rawResult,
        workingDirectory: dir,
      });
      postOutputs.push(post);
      return post?.modifiedResult ?? rawResult;
    };

    controller = createUnpagedCopilotController({
      executeTool: executeThroughHooks,
      getCwd: async () => dir,
      store,
      poll: async () => ({ events: [], nextCursor: null, cadence: {} }),
    });

    const armTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_arm");
    const refusedReply = await armTool.handler({ documentId: DOC_A, title: "Capped Canvas" });
    assert.equal(
      refusedReply,
      "Push is not armed: the server refused to mint a listener key: Listener key limit reached (max 20)"
    );
    assert.equal(postOutputs[0], undefined);

    nextMintResult = {
      resultType: "success",
      textResultForLlm: `Listener key created: key=${KEY_2} pollUrl=https://mcp.unpaged.io/events/poll`,
      sessionLog: `Listener key created: key=${KEY_2} pollUrl=https://mcp.unpaged.io/events/poll`,
    };
    const unparsedReply = await armTool.handler({ documentId: DOC_A, title: "Capped Canvas" });
    assert.equal(unparsedReply, "Push is not armed: the mint result carried no listener key");
    assert.ok(!unparsedReply.includes(KEY_2));
    assert.ok(postOutputs[1]?.modifiedResult);
    assert.ok(!JSON.stringify(postOutputs[1]).includes(KEY_2));

    const agentUnparsed = await controller.hooks.onPostToolUse({
      toolName: "unpaged-agent_listener_key_create",
      toolArgs: { documentId: DOC_A },
      toolResult: nextMintResult,
      workingDirectory: dir,
    });
    assert.ok(agentUnparsed?.modifiedResult);
    assert.ok(!JSON.stringify(agentUnparsed).includes(KEY_2));

    controller.shutdown();
  });
});

test("records visual plans per git branch and injects PR preview context on gh pr create or GitHub PR tool", async () => {
  await withTempDir(async (dir) => {
    const copilotHome = join(dir, "copilot-home");
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/pr-preview\n", "utf8");

    const store = createCopilotStore({ copilotHome, pid: 7777 });
    const controller = createUnpagedCopilotController({
      executeTool: async () => ({
        resultType: "success",
        textResultForLlm: JSON.stringify(mintPayload(DOC_A)),
      }),
      getCwd: async () => repo,
      store,
      poll: async () => ({ events: [], nextCursor: null, cadence: {} }),
    });

    // Non-plan document_create (no folderId: "visual-plans") does not record a branch plan.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "Scratchpad" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_B, title: "Scratchpad" }),
      },
      workingDirectory: repo,
    });
    assert.equal(await store.loadBranchPlan(repo), null);

    // Visual-plan creation records the branch plan automatically.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: PR previews", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_A, title: "shop-api: PR previews" }),
      },
      workingDirectory: repo,
    });
    const saved = await store.loadBranchPlan(repo);
    assert.equal(saved?.documentId, DOC_A);
    assert.equal(saved?.branch, "feat/pr-preview");

    // --dry-run produces no context.
    const dryRun = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --dry-run --title "Feat"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "Would have created a Pull Request with:\nhttps://github.com/acme/shop/pull/1\n",
      },
      workingDirectory: repo,
    });
    assert.equal(dryRun, undefined);

    await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github-work:acme/shop.git\n', "utf8");

    // GitHub PR tool targeting another repository — even on an SSH host alias and with the SAME branch name `feat/pr-preview` — produces no context and leaves the plan unspent.
    const wrongRepoSameBranch = await controller.hooks.onPostToolUse({
      toolName: "github-create_pull_request",
      toolArgs: { owner: "acme", repo: "public-docs", head: "feat/pr-preview", title: "Docs" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ html_url: "https://github.com/acme/public-docs/pull/5" }),
      },
      workingDirectory: repo,
    });
    assert.equal(wrongRepoSameBranch, undefined);
    assert.equal((await store.loadBranchPlan(repo))?.documentId, DOC_A);

    const wrongHead = await controller.hooks.onPostToolUse({
      toolName: "github-create_pull_request",
      toolArgs: { owner: "acme", repo: "shop", head: "acme:docs/other", title: "Docs" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ html_url: "https://github.com/acme/shop/pull/6" }),
      },
      workingDirectory: repo,
    });
    assert.equal(wrongHead, undefined);
    assert.equal((await store.loadBranchPlan(repo))?.documentId, DOC_A);

    await writeFile(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://alice:ghp_FAKETOKEN@github.com/acme/shop.git\n',
      "utf8"
    );

    // Real gh pr create injects additionalContext (naming checkout, plans.mjs splice, pre-parsed slug without leaking origin token, and already-attached guard) and spends the plan.
    const prCreated = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'git push -u origin feat/pr-preview && gh pr create --title "Feat" --body "Body"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/acme/shop/pull/55\n",
      },
      workingDirectory: repo,
    });
    assert.ok(prCreated?.additionalContext?.includes(DOC_A));
    assert.ok(prCreated?.additionalContext?.includes("https://github.com/acme/shop/pull/55"));
    assert.ok(prCreated?.additionalContext?.includes('role "viewer"'));
    assert.ok(prCreated?.additionalContext?.includes(`checkout "${repo}"`));
    assert.ok(!prCreated?.additionalContext?.includes("ghp_FAKETOKEN"));
    assert.ok(!prCreated?.additionalContext?.includes("remote get-url origin"));
    assert.ok(prCreated?.additionalContext?.includes('/monitors/plans.mjs" splice "<url>" "<previewUrl>"'));
    assert.ok(prCreated?.additionalContext?.includes("headRepositoryOwner,headRepository,headRefName"));
    assert.ok(prCreated?.additionalContext?.includes('"acme/shop:feat/pr-preview"'));
    assert.ok(prCreated?.additionalContext?.includes("if this session has already attached it to another pull request"));
    assert.equal(await store.loadBranchPlan(repo), null);

    // Reusing `feat/pr-preview` without a new plan attaches nothing.
    const reused = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Reused" --body "Body"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/acme/shop/pull/56\n",
      },
      workingDirectory: repo,
    });
    assert.equal(reused, undefined);

    // GitHub MCP PR creation tool on the matching repository and branch triggers the context and spends its plan.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: MCP PR", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_B, title: "shop-api: MCP PR" }),
      },
      workingDirectory: repo,
    });
    const mcpPrCreated = await controller.hooks.onPostToolUse({
      toolName: "github-create_pull_request",
      toolArgs: { owner: "acme", repo: "shop", head: "feat/pr-preview", title: "Feat" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ html_url: "https://github.com/acme/shop/pull/57" }),
      },
      workingDirectory: repo,
    });
    assert.ok(mcpPrCreated?.additionalContext?.includes(DOC_B));
    assert.ok(mcpPrCreated?.additionalContext?.includes("https://github.com/acme/shop/pull/57"));
    assert.equal(await store.loadBranchPlan(repo), null);

    // Calling `listen_arm` with `plan: false` after an open-PR attachment spends the plan so a follow-up branch gets nothing.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: Attached to open PR", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_B, title: "shop-api: Attached to open PR" }),
      },
      workingDirectory: repo,
    });
    assert.equal((await store.loadBranchPlan(repo))?.documentId, DOC_B);
    const armTool = controller.tools.find((t) => t.name === "mcp__unpaged__listen_arm");
    await armTool.handler({ documentId: DOC_B, title: "shop-api: Attached to open PR", plan: false });
    assert.equal(await store.loadBranchPlan(repo), null);
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/followup\n", "utf8");
    const followupPr = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Followup" --body "Body"' },
      toolResult: { resultType: "success", textResultForLlm: "https://github.com/acme/shop/pull/58\n" },
      workingDirectory: repo,
    });
    assert.equal(followupPr, undefined);
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/pr-preview\n", "utf8");

    // Deleting an unspent plan canvas clears its branch-plan record.
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: To delete", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_A, title: "shop-api: To delete" }),
      },
      workingDirectory: repo,
    });
    assert.equal((await store.loadBranchPlan(repo))?.documentId, DOC_A);
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_delete",
      toolArgs: { documentId: DOC_A },
      toolResult: { resultType: "success", textResultForLlm: '{"deleted":true}' },
      workingDirectory: repo,
    });
    assert.equal(await store.loadBranchPlan(repo), null);

    controller.shutdown();
  });
});

test("plans created on the default branch stay out of persistent main storage and promote onto the feature branch on gh pr create", async () => {
  await withTempDir(async (dir) => {
    const copilotHome = join(dir, "copilot-home");
    const repo = join(dir, "repo");
    await mkdir(join(repo, ".git", "refs", "remotes", "origin"), { recursive: true });
    await writeFile(join(repo, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n", "utf8");
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    const store = createCopilotStore({ copilotHome, pid: 7778 });
    const controller = createUnpagedCopilotController({
      executeTool: async () => ({
        resultType: "success",
        textResultForLlm: JSON.stringify(mintPayload(DOC_A)),
      }),
      getCwd: async () => repo,
      store,
      poll: async () => ({ events: [], nextCursor: null, cadence: {} }),
    });

    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: Planned on main", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_A, title: "shop-api: Planned on main" }),
      },
      workingDirectory: repo,
    });
    // Nothing persisted under `main`.
    assert.equal(await store.loadBranchPlan(repo), null);

    // Checkout feature branch in the same session and create PR -> attaches once and spends the plan.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/from-main\n", "utf8");
    const prCreated = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Feat" --body "Body"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/acme/shop/pull/88\n",
      },
      workingDirectory: repo,
    });
    assert.ok(prCreated?.additionalContext?.includes(DOC_A));
    assert.equal(await store.loadBranchPlan(repo), null);

    // Switching back to `main` still has no persistent plan record.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    assert.equal(await store.loadBranchPlan(repo), null);

    // Switching to a second unrelated branch in the same session attaches nothing and writes no record.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/fix/readme-typo\n", "utf8");
    const unrelatedPr = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Typo" --body "Body"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/acme/shop/pull/89\n",
      },
      workingDirectory: repo,
    });
    assert.equal(unrelatedPr, undefined);
    assert.equal(await store.loadBranchPlan(repo), null);

    // A plan created on a starting branch (`claude/<folder>`) survives `git branch -m` for one PR, never leaks to another repository, and is spent after that PR.
    const otherRepo = join(dir, "other-repo");
    await mkdir(join(otherRepo, ".git"), { recursive: true });
    await writeFile(join(otherRepo, ".git", "HEAD"), "ref: refs/heads/feat/other\n", "utf8");

    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/claude/wt-start\n", "utf8");
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: Renamed branch plan", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_B, title: "shop-api: Renamed branch plan" }),
      },
      workingDirectory: repo,
    });

    // Opening a PR in `otherRepo` gets nothing and leaves `repo`'s plan unspent.
    const crossRepoPr = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Other" --body "Body"' },
      toolResult: { resultType: "success", textResultForLlm: "https://github.com/acme/other/pull/1\n" },
      workingDirectory: otherRepo,
    });
    assert.equal(crossRepoPr, undefined);

    // Rename `claude/wt-start` -> `feat/renamed` (`git branch -m`) and open PR -> attaches once and spends both branch files.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/renamed\n", "utf8");
    const renamedPr = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Renamed" --body "Body"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/acme/shop/pull/90\n",
      },
      workingDirectory: repo,
    });
    assert.ok(renamedPr?.additionalContext?.includes(DOC_B));
    assert.equal(await store.loadBranchPlan(repo), null);
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/claude/wt-start\n", "utf8");
    assert.equal(await store.loadBranchPlan(repo), null);

    // A second PR on another branch gets nothing.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/fix/another-unrelated\n", "utf8");
    const secondAfterRenamed = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Fix" --body "Body"' },
      toolResult: {
        resultType: "success",
        textResultForLlm: "https://github.com/acme/shop/pull/901\n",
      },
      workingDirectory: repo,
    });
    assert.equal(secondAfterRenamed, undefined);

    // Unused branch record older than 14 days expires on lookup.
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/fix/stale-typo\n", "utf8");
    await store.saveBranchPlan({
      cwd: repo,
      documentId: DOC_B,
      title: "Stale plan",
      updatedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(await store.loadBranchPlan(repo), null);

    // Reftable `.invalid` HEAD stub never writes a permanent `.invalid` branch plan and fires at most once (with no headRefName check).
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/.invalid\n", "utf8");
    await controller.hooks.onPostToolUse({
      toolName: "unpaged-document_create",
      toolArgs: { title: "shop-api: Reftable plan", folderId: "visual-plans" },
      toolResult: {
        resultType: "success",
        textResultForLlm: JSON.stringify({ id: DOC_A, title: "shop-api: Reftable plan" }),
      },
      workingDirectory: repo,
    });
    assert.equal(await store.loadBranchPlan(repo), null);
    const reftableFirst = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "First" --body "Body"' },
      toolResult: { resultType: "success", textResultForLlm: "https://github.com/acme/shop/pull/91\n" },
      workingDirectory: repo,
    });
    assert.ok(reftableFirst?.additionalContext?.includes(DOC_A));
    assert.ok(!reftableFirst?.additionalContext?.includes("headRefName"));
    assert.equal(await store.loadBranchPlan(repo), null);
    const reftableSecond = await controller.hooks.onPostToolUse({
      toolName: "bash",
      toolArgs: { command: 'gh pr create --title "Second" --body "Body"' },
      toolResult: { resultType: "success", textResultForLlm: "https://github.com/acme/shop/pull/92\n" },
      workingDirectory: repo,
    });
    assert.equal(reftableSecond, undefined);

    controller.shutdown();
  });
});
