#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { executeControl, controlInputSchema } from "./control.mjs";
import { UUID } from "./protocol.mjs";

// Control payloads remain capped at 2 MiB; allow bounded native context/envelope overhead.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024 + 256 * 1024;
const VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const NODE_ACTION = "Make Node.js 24 or newer available in the environment used to launch Codex, then restart the Unpaged review connection. Reinstalling the plugin or changing hook trust does not change its Node runtime.";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (code) => { throw new Error(code); };

// Codex supplies these fields on the protocol envelope, not in model arguments.
// This extension is required: ordinary MCP clients cannot choose an owning task.
export function nativeContext(meta) {
  if (!object(meta) || typeof meta.threadId !== "string" || !UUID.test(meta.threadId)) fail("native_task_context_required");
  const workspace = meta["codex/sandbox-state-meta"]?.sandboxCwd;
  if (typeof workspace !== "string" || workspace.length > 8192) fail("native_workspace_context_required");
  let uri;
  try { uri = new URL(workspace); } catch { fail("native_workspace_context_required"); }
  if (uri.protocol !== "file:" || uri.hostname || uri.search || uri.hash || uri.username || uri.password) fail("native_workspace_context_required");
  let cwd;
  try { cwd = fileURLToPath(uri); } catch { fail("native_workspace_context_required"); }
  if (/[\0\r\n]/.test(cwd)) fail("native_workspace_context_required");
  return { threadId: meta.threadId, cwd };
}

const tool = {
  name: "review",
  description: "Manage this Codex task's Unpaged review listener and durable review state. Use doctor before minting a listener key. Task and workspace are supplied by Codex; never supply executable paths or another task. Canvas reads and edits use the remote Unpaged tools. Read the bundled review-plan skill before review operations.",
  inputSchema: controlInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
};

export function createHandler({ control = executeControl, env = process.env, nodeVersion = process.versions.node } = {}) {
  let initialized = false;
  let ready = false;
  const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
  return async (message) => {
    if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
        (Object.hasOwn(message, "id") && !(Number.isSafeInteger(message.id) || (typeof message.id === "string" && message.id.length <= 128)))) {
      return error(null, -32600, "Invalid request");
    }
    if (!Object.hasOwn(message, "id")) {
      if (message.method === "notifications/initialized" && initialized) ready = true;
      // Notifications never execute a review operation. A cancelled mutation
      // may already have committed; clients must inspect its durable receipt.
      return null;
    }
    const { id, method, params } = message;
    if (method === "ping") return result(id, {});
    if (method === "initialize") {
      if (initialized || !object(params) || typeof params.protocolVersion !== "string") return error(id, -32602, "Invalid initialization");
      initialized = true;
      return result(id, {
        protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS.at(-1),
        capabilities: { tools: {}, experimental: { "codex/sandbox-state-meta": {} } },
        serverInfo: { name: "unpaged_review", version: "0.5.0" }
      });
    }
    if (!ready) return error(id, -32002, "Server not initialized");
    if (method === "tools/list") return result(id, { tools: [tool] });
    if (method !== "tools/call") return error(id, -32601, "Method not found");
    if (!object(params) || params.name !== "review" || !object(params.arguments)) return error(id, -32602, "Invalid tool call");
    try {
      if (!(Number(nodeVersion.split(".")[0]) >= 24)) fail("node_24_required");
      const context = nativeContext(params._meta);
      const output = await control(params.arguments, context, { env });
      return result(id, { content: [{ type: "text", text: JSON.stringify(output) }] });
    } catch (cause) {
      const code = /^[a-z][a-z0-9_]{2,80}$/.test(cause.message ?? "") ? cause.message : "review_operation_failed";
      return result(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code,
        ...(code === "node_24_required" ? { action: NODE_ACTION } : {}),
        ...(code === "setup_not_ready" ? { setup: cause.setup } : {}) }) }] });
    }
  };
}

// A private stdio pipe only: no listening port, alternate task, shell command
// interface, credentials in logs, or unbounded request queue. Serial handling
// also keeps lifecycle mutations ordered within this client connection.
export async function serve({ input = process.stdin, output = process.stdout, handler = createHandler() } = {}) {
  let buffered = Buffer.alloc(0);
  let discarding = false;
  const send = async (message) => {
    if (message === null) return;
    const line = JSON.stringify(message) + "\n";
    await new Promise((resolve, reject) => output.write(line, (error) => error ? reject(error) : resolve()));
  };
  for await (const chunk of input) {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (bytes.length) {
      const end = bytes.indexOf(10);
      const part = end < 0 ? bytes : bytes.subarray(0, end);
      if (discarding || buffered.length + part.length > MAX_MESSAGE_BYTES) {
        if (!discarding) {
          buffered = Buffer.alloc(0);
          // The bounded prefix cannot safely identify the request. Do not guess its id or execute it.
          await send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "input_too_large" } });
        }
        discarding = end < 0;
        if (end < 0) break;
        bytes = bytes.subarray(end + 1);
        continue;
      }
      buffered = Buffer.concat([buffered, part]);
      if (end < 0) break;
      bytes = bytes.subarray(end + 1);
      if (buffered.length) {
        let request;
        try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffered)); }
        catch { await send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
        if (request !== undefined) await send(await handler(request));
      }
      buffered = Buffer.alloc(0);
    }
  }
  // EOF closes the server after the last complete operation. Detached workers
  // keep private file-backed stdio and their own process group.
  if (buffered.length) fail("incomplete_message");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.umask(0o077);
  try { await serve(); }
  catch { process.stderr.write("unpaged_review_transport_failed\n"); process.exitCode = 1; }
}
