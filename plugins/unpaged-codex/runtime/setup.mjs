import { spawn as spawnProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";

const EVIDENCE_LIMIT = "Persisted setup configuration only; does not verify the running app, listener, or recovery.";
const ACTIONS = {
  ready: "The current Unpaged setup is approved. Listening and recovery still require separate verification.",
  missing: "Install or enable the current Unpaged plugin, then check its SessionStart hook in Codex Hooks settings for this folder.",
  disabled: "Enable the current Unpaged SessionStart hook in Codex Hooks settings, then check setup again.",
  untrusted: "Review the current Unpaged SessionStart hook in Codex Hooks settings and click Trust, then check setup again.",
  modified: "The Unpaged hook changed since approval. Review its current version in Codex Hooks settings and click Trust, then check setup again.",
  unknown: "Check the current Unpaged installation and its SessionStart hook in Codex Hooks settings for this folder, then check setup again.",
  unsupported: "Use a Codex version that supports the public hooks/list API, then check setup again.",
  query_failed: "Codex hook setup could not be checked. Confirm Codex is available and retry the setup check."
};

function report(status, reason, hook) {
  return { setupReady: status === "ready", status, reason, action: ACTIONS[status], evidenceScope: "native_hook_inventory", evidenceLimit: EVIDENCE_LIMIT,
    ...(hook ? { hook } : {}) };
}

function queryError(reason) {
  const error = new Error("Unpaged setup query failed");
  error.code = reason === "unsupported" ? "SETUP_UNSUPPORTED" : "SETUP_QUERY_FAILED";
  error.reason = reason;
  return error;
}

function absolutePath(value) {
  return typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/.test(value);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The caller supplies an already verified, absolute native Codex executable. No tasks or hooks are invoked. */
export async function queryHookInventory({ codexPath, cwd, env = process.env, spawn = spawnProcess,
  timeoutMs = 10000, maxOutputBytes = 1024 * 1024, shutdownTimeoutMs = 1000 }) {
  if (!absolutePath(codexPath) || !absolutePath(cwd) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 4 * 1024 * 1024 ||
      !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 2000) {
    throw queryError("invalid_options");
  }
  let child;
  let exited = false;
  let finished = false;
  let timer;
  let notifyExit;
  const exit = new Promise((resolve) => { notifyExit = resolve; });
  const markExited = () => { exited = true; notifyExit(); };
  try {
    return await new Promise((resolve, reject) => {
      let bytes = 0;
      let buffered = Buffer.alloc(0);
      let expectedId = 0;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const fail = (reason) => finish(queryError(reason));
      const count = (chunk) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) { fail("output_limit"); return false; }
        return true;
      };
      const send = (message) => {
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { fail("write_failed"); }
      };
      const receive = (line) => {
        let message;
        try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); }
        catch { fail("malformed_response"); return; }
        if (!object(message)) { fail("malformed_response"); return; }
        if (!("id" in message) && typeof message.method === "string") return;
        if (message.id !== expectedId || ("error" in message) === ("result" in message)) {
          fail("malformed_response"); return;
        }
        if ("error" in message) {
          fail(message.error?.code === -32601 ? "unsupported" : "rpc_error"); return;
        }
        if (!object(message.result)) { fail("malformed_response"); return; }
        if (expectedId === 0) {
          expectedId = 1;
          send({ method: "initialized", params: {} });
          if (!finished) send({ id: 1, method: "hooks/list", params: { cwds: [cwd] } });
        } else finish(null, message.result);
      };
      try {
        child = spawn(codexPath, ["app-server", "--stdio"], { cwd, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
        child.once("exit", () => { markExited(); if (!finished) fail("early_exit"); });
        child.once("close", () => { markExited(); if (!finished) fail("early_exit"); });
        child.on("error", () => {
          // Failed spawn has no process to terminate. Later process errors still require cleanup.
          if (!child.pid) markExited();
          fail("process_error");
        });
        child.stdin.on("error", () => fail("write_failed"));
        child.stdout.on("error", () => fail("read_failed"));
        child.stderr.on("error", () => fail("read_failed"));
        child.stderr.on("data", (chunk) => { if (!finished) count(chunk); });
        child.stdout.on("data", (chunk) => {
          if (finished || !count(chunk)) return;
          buffered = Buffer.concat([buffered, chunk]);
          let newline;
          while (!finished && (newline = buffered.indexOf(10)) !== -1) {
            const line = buffered.subarray(0, newline);
            buffered = buffered.subarray(newline + 1);
            if (line.length) receive(line);
          }
        });
        timer = setTimeout(() => fail("timeout"), timeoutMs);
        send({ id: 0, method: "initialize", params: {
          clientInfo: { name: "unpaged_setup_check", title: "Unpaged setup check", version: "0.1.0" }
        } });
      } catch { fail("process_error"); }
    });
  } finally {
    clearTimeout(timer);
    if (child && !exited) {
      try { child.stdin?.end(); } catch { /* Termination below also closes the input pipe. */ }
      const waitForExit = async () => {
        let shutdownTimer;
        try { await Promise.race([exit, new Promise((resolve) => { shutdownTimer = setTimeout(resolve, shutdownTimeoutMs); })]); }
        finally { clearTimeout(shutdownTimer); }
      };
      try { child.kill("SIGTERM"); } catch { /* Try a bounded forceful termination next. */ }
      if (!exited) await waitForExit();
      if (!exited) {
        try { child.kill("SIGKILL"); } catch { /* Report that cleanup could not be confirmed. */ }
        if (!exited) await waitForExit();
      }
      if (!exited) {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.();
        throw queryError("cleanup_unconfirmed");
      }
    }
  }
}

/** Return only allowlisted facts about this plugin, never raw native inventory or error output. */
export async function inspectSetup({ codexPath, cwd, pluginRoot, query = queryHookInventory, ...options }) {
  if (!absolutePath(codexPath) || !absolutePath(cwd) || !absolutePath(pluginRoot)) {
    return report("query_failed", "invalid_options");
  }
  let inventory;
  try { inventory = await query({ codexPath, cwd, ...options }); }
  catch (error) {
    if (error?.code === "SETUP_UNSUPPORTED") return report("unsupported", "unsupported");
    const reason = ["invalid_options", "timeout", "output_limit", "malformed_response", "write_failed",
      "read_failed", "process_error", "early_exit", "rpc_error", "cleanup_unconfirmed"].includes(error?.reason)
      ? error.reason : "query_failed";
    return report("query_failed", reason);
  }
  if (!object(inventory) || !Array.isArray(inventory.data)) return report("unknown", "invalid_inventory");
  const entries = inventory.data.filter((entry) => object(entry) && entry.cwd === cwd);
  if (entries.length !== 1) return report("unknown", "cwd_inventory_missing_or_ambiguous");
  const entry = entries[0];
  if (!Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) {
    return report("unknown", "invalid_inventory");
  }
  if (entry.errors.length || entry.warnings.length) return report("unknown", "inventory_load_problem");
  const candidates = entry.hooks.filter((hook) => object(hook) && hook.source === "plugin" &&
    typeof hook.pluginId === "string" && /^unpaged-codex@[^\s]+$/.test(hook.pluginId) && hook.eventName === "sessionStart");
  if (!candidates.length) return report("missing", "hook_missing");
  if (candidates.length !== 1) return report("unknown", "ambiguous_hook");
  const hook = candidates[0];
  if (hook.sourcePath !== join(pluginRoot, "hooks", "hooks.json") || hook.handlerType !== "command" ||
      hook.command !== `node "${join(pluginRoot, "runtime", "cli.mjs")}" session-start` ||
      hook.matcher !== "startup|resume|compact" || (hook.async !== undefined && hook.async !== false)) {
    return report("unknown", "current_hook_mismatch");
  }
  if (typeof hook.enabled !== "boolean" || !["trusted", "untrusted", "modified", "managed"].includes(hook.trustStatus) ||
      typeof hook.currentHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(hook.currentHash)) {
    return report("unknown", "invalid_hook_metadata");
  }
  const safeHook = { enabled: hook.enabled, trustStatus: hook.trustStatus, currentHash: hook.currentHash };
  if (!hook.enabled) return report("disabled", "hook_disabled", safeHook);
  if (hook.trustStatus === "untrusted" || hook.trustStatus === "modified") return report(hook.trustStatus, "hook_approval_required", safeHook);
  if (hook.trustStatus !== "trusted") return report("unknown", "hook_trust_not_supported", safeHook);
  return report("ready", "current_hook_trusted", safeHook);
}
