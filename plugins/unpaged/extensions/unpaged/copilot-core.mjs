// Pure session controller for the GitHub Copilot extension. Keeps all state,
// key scrubbing, polling lifecycle, and hook policies independent of the
// @github/copilot-sdk runtime so node:test exercises every path offline.
import { hostname } from "node:os";
import {
  PROTOCOL_PREAMBLE,
  extractMint,
  isDocumentId,
  listenerConfigFromMint,
  printableKeyId,
} from "../../monitors/listen-core.mjs";
import { runListener } from "../../monitors/listen-loop.mjs";

export const FIRST_POLL_WAIT_MS = 8000;
export const FLUSH_DELAY_MS = 50;
export const SUBMIT_DELAY_MS = 50;
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export const CREATES = Object.freeze(["document_create", "template_clone"]);
export const EDITS = Object.freeze([
  "element_create",
  "element_update",
  "element_delete",
  "checklist_toggle_item",
  "table_append_row",
  "table_update_cell",
  "batch_create_elements",
  "batch_update_elements",
  "batch_delete_elements",
  "batch_reorder_elements",
  "node_create",
  "node_create_with_elements",
  "node_create_with_id",
  "node_update",
  "node_delete",
]);
const TRACKED_UNPAGED_TOOLS = [
  ...CREATES,
  ...EDITS,
  "document_delete",
  "agent_listener_key_create",
  "agent_listener_key_revoke",
];
const UNPAGED_TOOL_PATTERN = new RegExp(
  `^(?:mcp__(?:plugin_unpaged_)?)?unpaged[A-Za-z0-9_-]*?(?:__|-)((?:${TRACKED_UNPAGED_TOOLS.join("|")}))$`
);
const SHELL_TOOLS = new Set(["bash", "powershell", "local_shell", "Bash"]);
export const PR_COMMAND = /(^|[\s;&|(`])gh\s+pr\s+create\b/;
export const DRY_RUN_HEADER = /Would have created a Pull Request with:/;
export const PR_URL = /https?:\/\/[^\s"'<>)\]]+\/pull\/\d+/;
export const GITHUB_PR_TOOL =
  /^(?:mcp__)?[A-Za-z0-9_-]*github[A-Za-z0-9_-]*?(?:__|-)(create_pull_request|open_pull_request|pull_request_create|create_pr)$/i;

export const MINT_DENIED =
  "Push is not armed: the person's permission rules deny agent_listener_key_create, so no listener key can be created for this canvas, by the plugin or by you. Do not call it; say that listening needs that rule lifted.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function str(value) {
  return typeof value === "string" ? value : "";
}

function hookCwd(input) {
  return str(input?.workingDirectory || input?.cwd);
}

function isSuccessfulToolResult(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return true;
  if (toolResult.isError === true) return false;
  const rt = str(toolResult.resultType);
  return !rt || rt === "success";
}

function shortHostName(raw) {
  const clean = str(raw).trim().split(".")[0];
  return clean || "this machine";
}

export function boardUrlFor(documentId) {
  return `https://unpaged.io/document/${documentId}/edit`;
}

export function parseUnpagedToolName(toolName, metadataTools = null) {
  if (typeof toolName !== "string" || !toolName) return null;
  if (Array.isArray(metadataTools)) {
    const entry = metadataTools.find((item) => item && item.name === toolName);
    if (
      entry &&
      typeof entry.mcpToolName === "string" &&
      /^(?:plugin_unpaged_)?unpaged(?:[_-]|$)/i.test(str(entry.mcpServerName))
    ) {
      return entry.mcpToolName;
    }
  }
  const match = toolName.match(UNPAGED_TOOL_PATTERN);
  return match ? match[1] : null;
}

export function resolveUnpagedMcpToolName(mcpToolName, metadataTools = null) {
  if (Array.isArray(metadataTools)) {
    const found = metadataTools.find(
      (item) =>
        item &&
        item.mcpToolName === mcpToolName &&
        /^(?:plugin_unpaged_)?unpaged(?:[_-]|$)/i.test(str(item.mcpServerName)) &&
        typeof item.name === "string"
    );
    if (found) return found.name;
  }
  return `unpaged-${mcpToolName}`;
}

export function scrubToolResult(safeText) {
  return {
    textResultForLlm: safeText,
    resultType: "success",
    sessionLog: safeText,
    contents: [{ type: "text", text: safeText }],
  };
}

export function extractCopilotMint(toolResult) {
  if (!toolResult || typeof toolResult !== "object") return extractMint(toolResult);
  return (
    extractMint(toolResult.textResultForLlm) ??
    extractMint(toolResult.contents) ??
    extractMint(toolResult.sessionLog) ??
    extractMint(toolResult)
  );
}

export function createdDocumentFromResult(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return createdDocumentFromResult(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const found = createdDocumentFromResult(block?.text ?? block);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const key of ["textResultForLlm", "contents", "content", "structuredContent", "result"]) {
    if (key in value) {
      const found = createdDocumentFromResult(value[key]);
      if (found) return found;
    }
  }
  return isDocumentId(value.id) ? { id: String(value.id), title: str(value.title) } : null;
}

export function pullRequestUrlFromResult(toolResult) {
  if (!toolResult) return null;
  const parts =
    typeof toolResult === "string"
      ? [toolResult]
      : [
          str(toolResult.textResultForLlm),
          str(toolResult.sessionLog),
          typeof toolResult.contents === "string" ? toolResult.contents : JSON.stringify(toolResult.contents ?? ""),
        ];
  const match = parts.join("\n").match(PR_URL);
  return match ? match[0] : null;
}

export function offerLine(documentId, title) {
  const name = title ? `"${title}"` : "this whiteboard";
  return `The unpaged plugin can bring @agent comments on ${name} into this session while you work. Unless this turn already arms it with mcp__unpaged__listen_arm (as /unpaged:visual-plan does), offer that in one short question when you hand the whiteboard back. Only if they say yes, call mcp__unpaged__listen_arm with documentId ${documentId}: the plugin keeps the key out of this conversation and starts listening.`;
}

function revokeYourselfLine(keyIds) {
  return ` Its listener key is still live: revoke it now with agent_listener_key_revoke and keyId ${keyIds.join(", then keyId ")}; the plugin forgets it once it is revoked.`;
}

function revokeDeniedLine(keyIds) {
  return ` Its listener key is still live (keyId ${keyIds.join(", ")}): the person's permission rules deny agent_listener_key_revoke, so neither the plugin nor you can revoke it. Do not call it; say that it can be revoked in Unpaged, or once that rule is lifted.`;
}

export function comparePrompt(pullRequest, architectureCommandPath) {
  const where = architectureCommandPath
    ? `Read ${architectureCommandPath} and follow its Compare section to the end`
    : 'Invoke /unpaged:architecture with the argument "compare" and follow its Compare section to the end';
  return `The unpaged plugin sent a message: this session opened a pull request${pullRequest ? ` (${pullRequest})` : ""}, so the repository's architecture document is to be compared with the code now, as the plugin does after every pull request. ${where}: it runs the comparison in a separate helper with a clean slate, marks the canvas, never rewrites a card, and ends by reporting with mcp__unpaged__architecture_report.`;
}

function formatDayLabel(isoDay, nowMs) {
  if (typeof isoDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) return null;
  const ms = Date.parse(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const label = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date(nowMs).getUTCFullYear() ? label : `${label} ${d.getUTCFullYear()}`;
}

export function describeVerdict(verdict, nowMs) {
  if (!verdict) return "not compared from this machine yet";
  if (verdict.state === "lost") return "canvas deleted or unreachable";
  const checkedMs = verdict.checkedAt ? Date.parse(`${verdict.checkedAt}T00:00:00Z`) : null;
  if (
    (verdict.state === "current" || verdict.state === "behind") &&
    checkedMs !== null &&
    !Number.isNaN(checkedMs) &&
    nowMs - checkedMs > STALE_AFTER_MS
  ) {
    return `not compared since ${formatDayLabel(verdict.checkedAt, nowMs) ?? "an unknown day"}`;
  }
  if (verdict.state === "behind") {
    return `behind since ${formatDayLabel(verdict.behindSince, nowMs) ?? "an unknown day"}`;
  }
  const checked = formatDayLabel(verdict.checkedAt, nowMs);
  return `up to date${checked ? ` · checked ${checked}` : ""}`;
}

function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createUnpagedCopilotController({
  executeTool,
  listTools = async () => null,
  log = async () => {},
  sendPrompt = async () => {},
  getCwd = async () => process.cwd(),
  store,
  poll,
  sleep = defaultSleep,
  now = () => Date.now(),
  hostName = hostname(),
  firstPollWaitMs = FIRST_POLL_WAIT_MS,
  flushDelayMs = FLUSH_DELAY_MS,
  submitDelayMs = SUBMIT_DELAY_MS,
  architectureCommandPath = null,
  planApprovedContext = "",
}) {
  if (!store || typeof poll !== "function" || typeof executeTool !== "function") {
    throw new Error("invalid_copilot_controller_dependencies");
  }

  const label = `copilot on ${shortHostName(hostName)}`;
  const canvases = new Map();
  const loops = new Map();
  const arming = new Map();
  const armedBefore = new Set();
  const offered = new Set();
  const unrevoked = new Map();
  const extensionMints = new Map();
  const extensionRevokes = new Set();
  const timers = new Set();
  let cachedMetadata = null;
  let lastWorkingDirectory = null;
  let comparing = false;
  let comparisonTurnStarted = false;
  let closed = false;

  async function currentCwd() {
    return lastWorkingDirectory || (await getCwd());
  }

  function schedule(ms, fn) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!closed) void Promise.resolve(fn()).catch(() => {});
    }, ms);
    timers.add(timer);
    return () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
  }

  async function metadataTools() {
    try {
      const latest = await listTools();
      if (Array.isArray(latest)) cachedMetadata = latest;
    } catch {
      // Keep cached metadata or fall back to canonical names.
    }
    return cachedMetadata;
  }

  function rememberUnrevoked(documentId, keyId) {
    const clean = printableKeyId(keyId);
    if (!clean) return;
    const existing = unrevoked.get(documentId) ?? [];
    if (!existing.includes(clean)) unrevoked.set(documentId, [...existing, clean]);
  }

  function forgetUnrevoked(documentId, keyId) {
    const existing = (unrevoked.get(documentId) ?? []).filter((id) => id !== keyId);
    if (existing.length > 0) unrevoked.set(documentId, existing);
    else unrevoked.delete(documentId);
  }

  async function forgetRevokedEverywhere(keyId) {
    const clean = printableKeyId(keyId);
    if (!clean) return;
    for (const [documentId, ids] of [...unrevoked.entries()]) {
      if (ids.includes(clean)) forgetUnrevoked(documentId, clean);
    }
    for (const stored of await store.listListeners()) {
      if (stored.keyId === clean) {
        await store.retireListenerByKeyId(stored.documentId, clean).catch(() => {});
      }
    }
  }

  function recordCanvas(documentId, changes) {
    const current = canvases.get(documentId);
    if (current) canvases.set(documentId, { ...current, ...changes });
  }

  function describe(canvas, first) {
    if (!canvas) return "nothing armed";
    const state = first === "pending" ? "armed, first poll pending" : canvas.state;
    const unread = canvas.unread ? `, ${canvas.unread} new` : "";
    return `${canvas.title} (${canvas.documentId}): ${state}${canvas.reason ? ` (${canvas.reason})` : ""}${unread}`;
  }

  function isEventLine(line) {
    try {
      const parsed = JSON.parse(line);
      return Boolean(parsed) && parsed.type === "agent-inbox-event";
    } catch {
      return false;
    }
  }

  function sayWith(documentId) {
    return async (line) => {
      const loop = loops.get(documentId);
      const canvas = canvases.get(documentId);
      if (!loop || !canvas || closed) return;
      if (line !== PROTOCOL_PREAMBLE) {
        let event = null;
        try {
          event = JSON.parse(line);
        } catch {
          event = null;
        }
        if (event && event.type === "agent-inbox-event") {
          recordCanvas(documentId, { unread: (canvases.get(documentId)?.unread ?? 0) + 1, lastEventAt: now() });
          const who = str(event.authorName) || "someone";
          const preview = str(event.textPreview).slice(0, 120);
          void log(`${who} @agent on ${canvas.title || documentId}: ${preview}`).catch(() => {});
        } else {
          void log(line.slice(0, 160), { level: "warning" }).catch(() => {});
        }
      }
      loop.pending.push(line);
      if (line !== PROTOCOL_PREAMBLE && isEventLine(line)) loop.pendingEvents += 1;
      if (loop.cancelFlush) loop.cancelFlush();
      loop.cancelFlush = schedule(flushDelayMs, async () => {
        const lines = loop.pending.splice(0);
        const eventCount = loop.pendingEvents;
        loop.pendingEvents = 0;
        loop.cancelFlush = null;
        if (lines.length === 0 || closed) return;
        const header = eventCount > 0 ? "The unpaged plugin sent a message:\n" : "";
        await sendPrompt(`${header}${lines.join("\n")}`);
        if (eventCount > 0) recordCanvas(documentId, { unread: 0 });
      });
    };
  }

  async function startLoop(config) {
    const { documentId } = config;
    const controller = new AbortController();
    let settle = () => {};
    const settled = new Promise((resolve) => {
      settle = resolve;
    });
    const loop = {
      config,
      controller,
      done: Promise.resolve(),
      pending: [],
      pendingEvents: 0,
      cancelFlush: null,
      settled,
    };
    loops.set(documentId, loop);

    const reportStatus = async (state, reason) => {
      const known =
        state === "connecting" || state === "connected" || state === "reconnecting" || state === "stopped"
          ? state
          : "reconnecting";
      recordCanvas(documentId, { state: known, reason: reason ?? null });
      if (state !== "connecting") settle(state);
    };

    loop.done = runListener(config, {
      poll,
      sleep,
      say: sayWith(documentId),
      now,
      reportStatus,
      retireKey: () => store.retireListener(documentId, config),
      signal: controller.signal,
    })
      .catch(() => ({ reason: "failed" }))
      .then((result) => {
        if (loops.get(documentId) === loop) loops.delete(documentId);
        recordCanvas(documentId, { state: "stopped", reason: result?.reason ?? "stopped" });
        settle("stopped");
        return result;
      });
    return loop;
  }

  async function saveValidatedMint(documentId, found, cwdOverride) {
    const cwd = cwdOverride || (await currentCwd());
    const config = listenerConfigFromMint(found, { cwd, createdAt: new Date(now()).toISOString() });
    if (!config) {
      throw new Error("the mint result is not a valid listener config (it must name an Unpaged HTTPS polling endpoint)");
    }
    if (config.documentId !== documentId) {
      throw new Error(`the mint is for canvas ${config.documentId}, not ${documentId}`);
    }
    await store.saveListener(config);
    return config;
  }

  async function mintViaExtension(documentId) {
    const tools = await metadataTools();
    const toolName = resolveUnpagedMcpToolName("agent_listener_key_create", tools);
    const tracker = extensionMints.get(documentId) ?? { count: 0, captured: [] };
    tracker.count += 1;
    extensionMints.set(documentId, tracker);
    let rawResult;
    try {
      rawResult = await executeTool(toolName, { documentId, label });
    } finally {
      tracker.count -= 1;
      if (tracker.count <= 0 && tracker.captured.length === 0) extensionMints.delete(documentId);
    }
    const resultType = str(rawResult?.resultType) || "success";
    if (resultType === "denied") {
      const err = new Error(MINT_DENIED);
      err.code = "denied";
      throw err;
    }
    if (resultType === "rejected") {
      const err = new Error(
        "permission to run agent_listener_key_create was declined; ask Copilot to listen to this canvas when you want to retry"
      );
      err.code = "rejected";
      throw err;
    }
    if (rawResult?.isError === true || resultType !== "success") {
      const detail = str(rawResult?.error || rawResult?.textResultForLlm).slice(0, 200);
      throw new Error(`the server refused to mint a listener key${detail ? `: ${detail}` : ""}`);
    }
    const captured = tracker.captured.shift() ?? extractCopilotMint(rawResult);
    if (tracker.count <= 0 && tracker.captured.length === 0) extensionMints.delete(documentId);
    if (!captured) {
      const detail = str(rawResult?.textResultForLlm).slice(0, 200);
      throw new Error(`the mint result carried no listener key${detail ? `: ${detail}` : ""}`);
    }
    return saveValidatedMint(documentId, captured);
  }

  async function revokeViaExtension(keyId) {
    const clean = printableKeyId(keyId);
    if (!clean) return { resultType: "failure" };
    const tools = await metadataTools();
    const toolName = resolveUnpagedMcpToolName("agent_listener_key_revoke", tools);
    extensionRevokes.add(clean);
    try {
      const result = await executeTool(toolName, { keyId: clean });
      if (result?.isError === true) return { resultType: "failure" };
      return { resultType: str(result?.resultType) || "success" };
    } catch {
      return { resultType: "failure" };
    } finally {
      extensionRevokes.delete(clean);
    }
  }

  async function armWithConfig(documentId, config, title, previous, { leaveReplacedToAgent = false } = {}) {
    armedBefore.add(documentId);
    const name = title || config.title || previous?.title || documentId;
    const replaced = previous?.keyId && previous.keyId !== config.keyId ? printableKeyId(previous.keyId) : "";
    let leftToAgent;
    if (replaced && leaveReplacedToAgent) {
      rememberUnrevoked(documentId, replaced);
      leftToAgent = replaced;
    } else if (replaced) {
      void revokeViaExtension(replaced)
        .then(({ resultType }) => {
          if (resultType === "success") {
            forgetUnrevoked(documentId, replaced);
            return;
          }
          rememberUnrevoked(documentId, replaced);
          return log(
            `Listening on ${name} with a new key; the earlier key (${replaced}) is still live, though shut out of polling.`,
            { level: "warning" }
          );
        })
        .catch(() => {});
    }

    canvases.set(documentId, {
      documentId,
      keyId: printableKeyId(config.keyId) || null,
      title: name,
      boardUrl: boardUrlFor(documentId),
      armedAt: now(),
      state: "connecting",
      reason: null,
      unread: 0,
      lastEventAt: null,
    });

    const loop = await startLoop({ ...config, title: name });
    const first = await Promise.race([
      loop.settled,
      new Promise((resolve) => {
        schedule(firstPollWaitMs, () => resolve("pending"));
      }),
    ]);
    await log(`Listening on ${name} (${documentId}): ${first === "pending" ? "first poll pending" : canvases.get(documentId)?.state}`, {
      ephemeral: true,
    }).catch(() => {});
    return { already: false, canvas: canvases.get(documentId), first, leftToAgent };
  }

  function arm(documentId, title) {
    if (!isDocumentId(documentId)) return Promise.reject(new Error("not a document id"));
    if (loops.has(documentId)) return Promise.resolve({ already: true, canvas: canvases.get(documentId) });
    const inFlight = arming.get(documentId);
    if (inFlight) return inFlight.then((res) => ({ ...res, already: true }));
    const run = (async () => {
      const previous = await store.loadListener(documentId);
      const config = await mintViaExtension(documentId);
      return armWithConfig(documentId, config, title, previous);
    })().finally(() => arming.delete(documentId));
    arming.set(documentId, run);
    return run;
  }

  async function listenWithAgentMint(documentId, found, cwdOverride) {
    const mintedKeyId = printableKeyId(found?.keyId);
    if (loops.has(documentId)) {
      if (mintedKeyId && mintedKeyId !== canvases.get(documentId)?.keyId) rememberUnrevoked(documentId, mintedKeyId);
      return `Already listening: ${describe(canvases.get(documentId))}. The unpaged plugin keeps the key out of this conversation; new @agent comments arrive as a message from it. Never repeat key material.`;
    }
    try {
      const previous = await store.loadListener(documentId);
      const config = await saveValidatedMint(documentId, found, cwdOverride);
      const result = await armWithConfig(documentId, config, null, previous, { leaveReplacedToAgent: true });
      const earlier = result.leftToAgent
        ? ` This canvas's earlier key (keyId ${result.leftToAgent}) is still live, though shut out of polling: revoke it now with agent_listener_key_revoke and keyId ${result.leftToAgent}; the plugin forgets it once it is revoked.`
        : "";
      return `Listening on ${describe(result.canvas, result.first)}. The unpaged plugin keeps the key out of this conversation; new @agent comments arrive as a message from it. Never repeat key material.${earlier}`;
    } catch (err) {
      if (mintedKeyId) rememberUnrevoked(documentId, mintedKeyId);
      return `The listener key was created but listening did not start: ${String(err?.message ?? err)}. The key stays out of this conversation; /unpaged:listen revoke ${documentId} revokes it${mintedKeyId ? ` (keyId ${mintedKeyId})` : ""}.`;
    }
  }

  async function stop(documentId, { leaveToAgent = false } = {}) {
    if (!isDocumentId(documentId)) throw new Error("not a document id");
    const loop = loops.get(documentId);
    const canvas = canvases.get(documentId);
    if (loop) {
      if (loop.cancelFlush) loop.cancelFlush();
      loop.controller.abort();
      await loop.done;
    }
    const rejected = !loop && canvas?.reason === "http-401";
    const current = rejected ? "" : printableKeyId(loop?.config.keyId ?? canvas?.keyId);
    const keyIds = [...new Set([current, ...(unrevoked.get(documentId) ?? [])])].filter(Boolean);
    unrevoked.delete(documentId);

    const toAgent = [];
    const denied = [];
    for (const keyId of keyIds) {
      const { resultType } = await revokeViaExtension(keyId);
      if (resultType === "success") {
        if (loop && keyId === printableKeyId(loop.config.keyId)) {
          await store.retireListener(documentId, loop.config).catch(() => {});
        } else {
          await store.retireListenerByKeyId(documentId, keyId).catch(() => {});
        }
        continue;
      }
      rememberUnrevoked(documentId, keyId);
      if (resultType === "denied") denied.push(keyId);
      else if (leaveToAgent && resultType === "rejected") toAgent.push(keyId);
    }

    canvases.delete(documentId);
    const left = unrevoked.get(documentId) ?? [];
    const title = canvas?.title ?? documentId;
    await log(`Stopped listening on ${title} (${documentId})`, { ephemeral: true }).catch(() => {});
    return {
      title,
      revoked: keyIds.length > 0 && left.length === 0,
      keyId: left[0] ?? keyIds[0] ?? null,
      left,
      toAgent,
      denied,
    };
  }

  async function statusText() {
    const activeLines = [...canvases.values()].map((c) => describe(c));
    const cwd = await currentCwd();
    const storedConfigs = await store.listListeners();
    const storedLines = storedConfigs.map((config) => {
      const folder = config.cwd === cwd ? "this folder" : "other folder";
      const keyPart = printableKeyId(config.keyId) || "with no id";
      return `${config.title || config.documentId} (${config.documentId}): ${folder}, key ${keyPart}, stored ${config.createdAt ?? "at an unknown time"}`;
    });
    const leftLines = [...unrevoked.entries()].map(
      ([docId, ids]) => `${canvases.get(docId)?.title || docId} (${docId}): keyId ${ids.join(", ")}`
    );
    return [
      activeLines.length ? `Listening in this session:\n${activeLines.join("\n")}` : "Nothing is armed in this session.",
      `Keys the plugin stores on this machine:\n${storedLines.join("\n") || "none"}`,
      `Keys this session could not revoke:\n${leftLines.join("\n") || "none"}`,
      `This machine's key label: ${label}`,
    ].join("\n\n");
  }

  function shutdown() {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const loop of loops.values()) {
      if (loop.cancelFlush) loop.cancelFlush();
      loop.controller.abort();
    }
  }

  const tools = [
    {
      name: "mcp__unpaged__listen_arm",
      description:
        "Listen to an Unpaged canvas for @agent comments in this session: mints a fresh listener key through Unpaged, keeps it out of the conversation under ~/.copilot/unpaged/listeners (mode 600), revokes any key it replaces, and polls inside this Copilot session. New comments arrive as a message from the unpaged plugin. Pass documentId (and optional title).",
      parameters: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          title: { type: "string" },
        },
        required: ["documentId"],
      },
      handler: async (args) => {
        const documentId = str(args?.documentId);
        const title = str(args?.title) || null;
        try {
          const result = await arm(documentId, title);
          const line = result.already
            ? `Already listening: ${describe(result.canvas)}`
            : `Listening on ${describe(result.canvas, result.first)}`;
          return `${line}\nNew @agent comments arrive as a message from the unpaged plugin; reply on the canvas with the comment tools and leave threads open. Never repeat key material.`;
        } catch (err) {
          if (err?.code === "denied") return MINT_DENIED;
          return `Push is not armed: ${String(err?.message ?? err)}`;
        }
      },
    },
    {
      name: "mcp__unpaged__listen_stop",
      description:
        "Stop listening to an Unpaged canvas in this session and revoke its listener key (or report its keyId for you to revoke with agent_listener_key_revoke if declined).",
      parameters: {
        type: "object",
        properties: {
          documentId: { type: "string" },
        },
        required: ["documentId"],
      },
      handler: async (args) => {
        const documentId = str(args?.documentId);
        try {
          const result = await stop(documentId, { leaveToAgent: true });
          const failed = result.left.filter((id) => !result.toAgent.includes(id) && !result.denied.includes(id));
          const key = result.revoked
            ? ", key revoked"
            : failed.length > 0
              ? `, key not revoked (the permission check or the server refused, or the server was unreachable): keyId ${failed.join(", ")}`
              : result.keyId
                ? ""
                : ", no key left to revoke here (none was minted for it in this session, or the server already rejected it)";
          const asks = `${result.toAgent.length > 0 ? revokeYourselfLine(result.toAgent) : ""}${result.denied.length > 0 ? revokeDeniedLine(result.denied) : ""}`;
          return `${result.title}: stopped${key}${asks ? `.${asks}` : ""}`;
        } catch (err) {
          return `listen_stop failed: ${String(err?.message ?? err)}`;
        }
      },
    },
    {
      name: "mcp__unpaged__listen_status",
      description: "Which Unpaged canvases this session listens to, and which listener keys this machine stores.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => statusText(),
    },
    {
      name: "mcp__unpaged__architecture_report",
      description:
        "Report the verdict of a comparison between the repository's architecture canvas and its code at the end of /unpaged:architecture (create, compare or update). state is current, behind or lost; documentId must match .unpaged/architecture.json.",
      parameters: {
        type: "object",
        properties: {
          documentId: { type: "string" },
          state: { type: "string", enum: ["current", "behind", "lost"] },
          checkedAt: { type: "string", description: "YYYY-MM-DD" },
          commit: { type: "string" },
          behindSince: { type: "string", description: "YYYY-MM-DD" },
          title: { type: "string" },
        },
        required: ["documentId", "state"],
      },
      handler: async (args) => {
        const documentId = str(args?.documentId);
        const state = str(args?.state);
        if (!isDocumentId(documentId)) {
          return "architecture_report: documentId must be the canvas id the pointer file names.";
        }
        if (!["current", "behind", "lost"].includes(state)) {
          return "architecture_report: state must be current, behind or lost.";
        }
        const pointer = await store.readArchitecturePointer(await currentCwd());
        if (!pointer || pointer.documentId !== documentId) {
          return `architecture_report: .unpaged/architecture.json does not name canvas ${documentId}; write the pointer file first, then report again.`;
        }
        const checkedAt = /^\d{4}-\d{2}-\d{2}$/.test(str(args?.checkedAt).trim()) ? str(args?.checkedAt).trim() : null;
        const behindSince =
          state === "behind"
            ? (/^\d{4}-\d{2}-\d{2}$/.test(str(args?.behindSince).trim()) ? str(args?.behindSince).trim() : checkedAt)
            : null;
        const commit = /^[0-9a-f]{7,40}$/.test(str(args?.commit).trim()) ? str(args?.commit).trim() : null;
        const reported = {
          documentId,
          state,
          title: str(args?.title) || pointer.title,
          checkedAt,
          commit,
          behindSince,
          reportedAt: new Date(now()).toISOString(),
        };
        comparing = false;
        comparisonTurnStarted = false;
        await store.saveVerdict(reported);
        const summary = describeVerdict(reported, now());
        await log(`Architecture (${reported.title || documentId}): ${summary}`).catch(() => {});
        return `Reported. Architecture document status: ${summary}.`;
      },
    },
  ];

  const commands = [
    {
      name: "unpaged-listen",
      description: "Listen to an Unpaged canvas for @agent comments (status | arm <documentId> | stop <documentId|all>)",
      handler: async (ctx) => {
        const [verb = "status", target = ""] = str(ctx?.args).trim().split(/\s+/);
        try {
          if (verb === "status") {
            await log(await statusText());
            return;
          }
          if (verb === "arm") {
            const result = await arm(target, null);
            await log(
              result.already ? `Already listening: ${describe(result.canvas)}` : `Listening on ${describe(result.canvas, result.first)}`
            );
            return;
          }
          if (verb === "stop") {
            const targets = target === "all" ? [...canvases.keys()] : [target];
            const lines = [];
            for (const id of targets) {
              const result = await stop(id);
              const extra = result.revoked
                ? ", key revoked"
                : result.left.length > 0
                  ? `; its key is still live (keyId ${result.left.join(", ")}): ask Copilot to stop listening to ${result.title}, or revoke it in Unpaged.`
                  : "";
              lines.push(`${result.title}: stopped${extra}`);
            }
            await log(lines.join("\n") || "nothing to stop");
            return;
          }
          await log("usage: /unpaged-listen status | arm <documentId> | stop <documentId|all>");
        } catch (err) {
          await log(`unpaged-listen ${verb}: ${String(err?.message ?? err)}`, { level: "warning" });
        }
      },
    },
  ];

  const hooks = {
    onSessionStart: async (input) => {
      const wd = hookCwd(input);
      if (wd) lastWorkingDirectory = wd;
      const pointer = await store.readArchitecturePointer(await currentCwd());
      if (!pointer) return;
      const stored = await store.loadVerdict(pointer.documentId);
      const summary = describeVerdict(stored, now());
      await log(`Architecture (${stored?.title || pointer.title || pointer.documentId}): ${summary}`, {
        ephemeral: true,
      }).catch(() => {});
    },

    onPreToolUse: async (input) => {
      const wd = hookCwd(input);
      if (wd) lastWorkingDirectory = wd;
      const tools = cachedMetadata ?? (await metadataTools());
      const mcpTool = parseUnpagedToolName(input?.toolName, tools);
      if (mcpTool !== "agent_listener_key_create") return;
      const args = input?.toolArgs && typeof input.toolArgs === "object" ? input.toolArgs : {};
      const documentId = str(args.documentId);
      const inFlight = extensionMints.get(documentId);
      if (inFlight && inFlight.count > 0) return;
      if (loops.has(documentId) || arming.has(documentId)) {
        const title = canvases.get(documentId)?.title || documentId;
        return {
          permissionDecision: "deny",
          permissionDecisionReason: `Not minted: this session already listens to ${title} through the unpaged plugin, and a newer key would stop that listener. New @agent comments on it arrive as a message from the unpaged plugin; nothing to do.`,
        };
      }
      if (!isDocumentId(documentId)) return;
      return {
        modifiedArgs: { ...args, label },
      };
    },

    onPostToolUse: async (input) => {
      const wd = hookCwd(input);
      if (wd) lastWorkingDirectory = wd;
      const toolName = str(input?.toolName);
      const succeeded = isSuccessfulToolResult(input?.toolResult);
      if (toolName === "exit_plan_mode") {
        return succeeded && planApprovedContext ? { additionalContext: planApprovedContext } : undefined;
      }

      const tools = cachedMetadata ?? (await metadataTools());
      const mcpTool = parseUnpagedToolName(toolName, tools);
      const args = input?.toolArgs && typeof input.toolArgs === "object" ? input.toolArgs : {};

      if (mcpTool === "agent_listener_key_create") {
        const documentId = str(args.documentId);
        const found = extractCopilotMint(input?.toolResult);
        if (!found) return;
        const inFlight = extensionMints.get(documentId);
        if (inFlight && inFlight.count > 0) {
          inFlight.captured.push(found);
          return {
            modifiedResult: scrubToolResult(
              `Unpaged listener key received by the unpaged plugin for canvas ${isDocumentId(documentId) ? documentId : "<unknown>"}.`
            ),
          };
        }
        if (!isDocumentId(documentId)) {
          return {
            modifiedResult: scrubToolResult(
              "Unpaged listener key response scrubbed because the tool call carried no valid documentId."
            ),
          };
        }
        const message = await listenWithAgentMint(documentId, found, wd || null);
        return { modifiedResult: scrubToolResult(message) };
      }

      if (!succeeded) return;

      if (mcpTool === "agent_listener_key_revoke") {
        const keyId = printableKeyId(args.keyId);
        if (keyId && !extensionRevokes.has(keyId)) {
          await forgetRevokedEverywhere(keyId).catch(() => {});
        }
        return;
      }

      if (mcpTool === "document_delete") {
        const documentId = str(args.documentId);
        if (canvases.has(documentId) || arming.has(documentId)) {
          const pending = canvases.has(documentId) ? Promise.resolve() : arming.get(documentId)?.catch(() => {});
          void Promise.resolve(pending)
            .then(() => (canvases.has(documentId) ? stop(documentId) : undefined))
            .catch(() => {});
        }
        return;
      }

      if (mcpTool && (CREATES.includes(mcpTool) || EDITS.includes(mcpTool))) {
        let documentId = str(args.documentId);
        let title = null;
        if (CREATES.includes(mcpTool)) {
          const created = createdDocumentFromResult(input?.toolResult);
          if (!created) return;
          documentId = created.id;
          title = created.title || str(args.title) || null;
        }
        if (
          !isDocumentId(documentId) ||
          armedBefore.has(documentId) ||
          offered.has(documentId) ||
          arming.has(documentId) ||
          loops.has(documentId)
        ) {
          return;
        }
        offered.add(documentId);
        return { additionalContext: offerLine(documentId, title) };
      }

      const isShellPr =
        SHELL_TOOLS.has(toolName) &&
        PR_COMMAND.test(str(args.command ?? args.cmd)) &&
        !DRY_RUN_HEADER.test(str(input?.toolResult?.textResultForLlm));
      const isMcpPr = GITHUB_PR_TOOL.test(toolName);
      if (isShellPr || isMcpPr) {
        const prUrl = pullRequestUrlFromResult(input?.toolResult);
        if (!prUrl || comparing) return;
        const pointer = await store.readArchitecturePointer(wd || (await currentCwd()));
        if (!pointer) return;
        comparing = true;
        comparisonTurnStarted = false;
        schedule(submitDelayMs, async () => {
          try {
            await sendPrompt(comparePrompt(prUrl, architectureCommandPath));
            comparisonTurnStarted = true;
          } catch {
            comparing = false;
            comparisonTurnStarted = false;
          }
        });
      }
    },

    onSessionEnd: async () => {
      shutdown();
    },
  };

  function onSessionIdle() {
    if (comparing && comparisonTurnStarted) {
      comparing = false;
      comparisonTurnStarted = false;
    }
  }

  return {
    label,
    tools,
    commands,
    hooks,
    onSessionIdle,
    shutdown,
  };
}
