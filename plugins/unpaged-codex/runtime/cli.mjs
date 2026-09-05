#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { constants, existsSync, openSync, closeSync, realpathSync } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Store } from "./store.mjs";

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const fail = (code) => { throw new Error(code); };

export function parseArgs(args) {
  const result = { command: args[0], positionals: [] };
  for (let i = 1; i < args.length; i++) {
    if (["--data", "--codex"].includes(args[i])) {
      const key = args[i].slice(2);
      if (result[key] || !args[i + 1] || !isAbsolute(args[i + 1])) fail("absolute_option_required");
      result[key] = args[++i];
    } else if (args[i].startsWith("--")) fail("unknown_option");
    else result.positionals.push(args[i]);
  }
  return result;
}

export function dataDirectory(args, env = process.env) {
  return args.data ?? join(env.CODEX_HOME || join(homedir(), ".codex"), "unpaged");
}

export async function readJson(input) {
  let raw = "";
  for await (const chunk of input) {
    raw += chunk.toString("utf8");
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) fail("input_too_large");
  }
  try { return JSON.parse(raw); } catch { fail("invalid_json"); }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

// Hash semantic content read with document_get. Explicit status elements are
// excluded so displaying the digest/acceptance phrase does not change itself.
export function planDigest({ document, statusElementIds = [] }) {
  if (!document || !UUID.test(document.id) || !Array.isArray(document.nodes) ||
      !document.nodes.length || !Array.isArray(statusElementIds) ||
      !statusElementIds.every((id) => typeof id === "string" && UUID.test(id))) fail("invalid_document_snapshot");
  const excluded = new Set(statusElementIds);
  const seen = new Set();
  const elementIds = new Set();
  const foundExcluded = new Set();
  const nodes = document.nodes.map((node) => {
    if (!UUID.test(node.id) || seen.has(node.id) || !Array.isArray(node.elements)) fail("invalid_node_snapshot");
    seen.add(node.id);
    const elements = node.elements.filter((element) => {
      if (!UUID.test(element.id) || elementIds.has(element.id)) fail("invalid_element_snapshot");
      elementIds.add(element.id);
      if (excluded.has(element.id)) {
        if (!/^(?:PROPOSED|ACCEPTED|\*\*Status:\*\*)/.test(element.properties?.text || "")) fail("invalid_status_exclusion");
        foundExcluded.add(element.id);
        return false;
      }
      return true;
    }).map((element) => {
      const { revision, createdAt, updatedAt, ...content } = element;
      return content;
    });
    const { revision, createdAt, updatedAt, owner, elementWriters, ...content } = node;
    return { ...content, elements };
  }).sort((a, b) => a.id.localeCompare(b.id));
  if (!seen.has(document.rootNodeId) || foundExcluded.size !== excluded.size) fail("invalid_document_snapshot");
  if (Number.isInteger(document.nodeCount) && document.nodeCount !== nodes.length) fail("partial_document_snapshot");
  return createHash("sha256").update(JSON.stringify(canonical({ id: document.id, title: document.title,
    rootNodeId: document.rootNodeId, schemaVersion: document.schemaVersion, nodes }))).digest("hex");
}

export async function findCodex(explicit, env = process.env, execute = run) {
  const candidates = explicit ? [explicit] : [
    env.UNPAGED_CODEX_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    ...(env.PATH || "").split(delimiter).filter(Boolean).map((dir) => join(dir, "codex"))
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      const path = await realpath(candidate);
      const options = { shell: false, timeout: 10000, maxBuffer: 65536 };
      const version = await execute(path, ["--version"], options);
      const match = version.stdout.match(/codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/);
      if (!match) continue;
      const [major, minor, patch] = match.slice(1).map(Number);
      if (major === 0 && (minor < 153 || (minor === 153 && patch < 1))) continue;
      const help = await execute(path, ["queue", "--help"], options);
      if (!help.stdout.includes("--thread") || !help.stdout.includes("--message")) continue;
      return path;
    } catch { /* Try another installed binary; never print its output. */ }
  }
  fail("supported_codex_queue_not_found");
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export async function ensureWorker(store, documentId, directory, options = {}) {
  let binding = store.getBinding(documentId);
  if (!binding || binding.status !== "active") return binding;
  if (alive(binding.workerPid)) return binding;
  const logPath = join(directory, "worker.log");
  const fd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const child = (options.spawn ?? spawn)(process.execPath,
      [join(scriptDir, "worker.mjs"), documentId, "--data", directory],
      { detached: true, stdio: ["ignore", fd, fd], cwd: directory, shell: false });
    await new Promise((done, reject) => { child.once("spawn", done); child.once("error", reject); });
    child.unref();
  } finally { closeSync(fd); }
  for (let i = 0; i < 30; i++) {
    binding = store.getBinding(documentId);
    if (binding?.workerPid && ["connected", "stopped"].includes(binding.connectionState)) return binding;
    await wait(100);
  }
  return store.getBinding(documentId);
}

function ownBinding(store, documentId, env) {
  if (!UUID.test(documentId || "")) fail("invalid_document_id");
  const binding = store.getBinding(documentId);
  if (!binding) fail("board_not_armed");
  if (!UUID.test(env.CODEX_THREAD_ID || "") || binding.threadId !== env.CODEX_THREAD_ID) fail("wrong_codex_task");
  return binding;
}

export async function executeCli(argv, options = {}) {
  const env = options.env ?? process.env;
  const input = options.input ?? process.stdin;
  const args = parseArgs(argv);
  const directory = dataDirectory(args, env);
  if (!isAbsolute(directory)) fail("absolute_data_directory_required");
  if (args.command === "digest") return { planDigest: planDigest(await readJson(input)) };
  if (args.command === "info") return { dataDirectory: directory, node: process.version, minimumNode: "24", minimumCodex: "0.153.1" };
  const allowed = ["arm", "resume", "status", "pending", "begin", "complete", "accept", "stop", "revoked", "reconcile", "recover", "session-start"];
  if (!allowed.includes(args.command)) fail("unknown_command");
  if (Number(process.versions.node.split(".")[0]) < 24) fail("node_24_required");
  const dbPath = join(directory, "reviews.sqlite");
  let hook;
  if (args.command === "session-start") {
    hook = await readJson(input);
    if (hook.agent_id || hook.agent_type || hook.hook_event_name !== "SessionStart" ||
        !["startup", "resume"].includes(hook.source) || !UUID.test(hook.session_id || "") ||
        (env.CODEX_THREAD_ID && hook.session_id !== env.CODEX_THREAD_ID) || !existsSync(dbPath)) return null;
  }
  const store = new Store(dbPath);
  try {
    const [documentId, eventId] = args.positionals;
    if (args.command === "status") {
      const bindings = documentId ? [store.getBinding(documentId)].filter(Boolean) : store.listBindings();
      return bindings.map((binding) => ({ ...binding, events: store.listEvents(binding.documentId) }));
    }
    if (args.command === "session-start") {
      const bindings = store.listBindings().filter((row) => row.threadId === hook.session_id &&
        (row.status === "active" || row.cleanupRequired || row.eventCounts.processing || row.eventCounts.effect_uncertain));
      const results = [];
      for (const binding of bindings) results.push(await ensureWorker(store, binding.documentId, directory, options));
      if (!results.length) return null;
      return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
        "Unpaged has existing review bindings for this task. Use the bundled review-plan skill for events and recovery. No new boards were armed. Read status before claiming listening or completion. " + JSON.stringify(results) } };
    }
    if (args.command === "arm") {
      const config = await readJson(input);
      if (!UUID.test(env.CODEX_THREAD_ID || "") || config.threadId !== env.CODEX_THREAD_ID) fail("wrong_codex_task");
      config.codexPath = await findCodex(args.codex ?? config.codexPath, env, options.run ?? run);
      store.bind(config);
      return await ensureWorker(store, config.documentId, directory, options);
    }
    ownBinding(store, documentId, env);
    if (args.command === "resume") return await ensureWorker(store, documentId, directory, options);
    if (args.command === "pending") return store.listEvents(documentId).filter((event) => event.state !== "completed");
    if (args.command === "begin") return store.begin(documentId, eventId, { expectedThreadId: env.CODEX_THREAD_ID });
    if (args.command === "stop") return store.requestStop(documentId);
    const payload = await readJson(input);
    if (args.command === "complete") return store.complete(documentId, eventId, payload);
    if (args.command === "accept") return store.accept(documentId, eventId, payload);
    if (args.command === "revoked") return store.confirmRevoked(documentId, payload);
    if (args.command === "reconcile") return store.reconcile(documentId, payload);
    if (args.command === "recover") return store.recover(documentId, eventId, payload);
    fail("unknown_command");
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.umask(0o077);
  try {
    const result = await executeCli(process.argv.slice(2));
    if (result !== null && result !== undefined) process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const code = /^[a-z][a-z0-9_]{2,80}$/.test(error.message ?? "") ? error.message : "adapter_command_failed";
    process.stderr.write(JSON.stringify({ error: code }) + "\n");
    process.exitCode = 1;
  }
}
