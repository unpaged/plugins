// HTTP server for the Unpaged Architecture auxiliary side-pane panel.
// Binds strictly to 127.0.0.1, requires X-Sidecar-Token (or ?token=) on all
// non-GET requests when configured, serves panel assets plus Antigravity's
// /preload.js bridge, implements /_sidecar/* via execFile (never shell: true),
// and delegates repo status/run bookkeeping to monitors/architecture.mjs.
// Never writes external network requests and never handles Unpaged OAuth tokens.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUN_ACTIONS } from "../../monitors/architecture-core.mjs";
import {
  clearRunState,
  findRepositoryRoot,
  readRepositoryStatus,
  recordRunStart,
} from "../../monitors/architecture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIND_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const AGENTAPI_TIMEOUT_MS = 15 * 1000;
const AGENTAPI_MAX_BUFFER = 4 * 1024 * 1024;
const SAFE_ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;

const FALLBACK_PRELOAD_JS = `// Fallback preload stub outside Antigravity
(function() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const conversationId = params.get('conversationId') || '';
  function secureFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('X-Sidecar-Token', token);
    return fetch(url, { ...options, headers });
  }
  window.sidecar = {
    conversationId,
    fetch: secureFetch,
    getWorkspaceUris: async () => [],
    onWorkspaceChange: () => () => {},
    agent: {
      sendMessage: async () => ({ error: 'Antigravity host bridge unavailable' }),
      startConversation: async () => ({ error: 'Antigravity host bridge unavailable' }),
      getConversationMetadata: async () => ({})
    },
    ui: { toggleAuxPane() {}, toggleConversation() {}, addArtifactComment() {} },
    auth: { requestCredentialRefresh() {} }
  };
})();
`;

export function loadPreloadScript({ appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR, homeDir = homedir() } = {}) {
  const candidates = [];
  if (typeof appDataDir === "string" && appDataDir.trim()) {
    candidates.push(join(appDataDir.trim(), "lib", "node_modules", "sidecar_sdk", "preload.js"));
  }
  candidates.push(join(homeDir, ".gemini", "antigravity", "lib", "node_modules", "sidecar_sdk", "preload.js"));
  for (const path of candidates) {
    try {
      if (existsSync(path)) {
        const text = readFileSync(path, "utf8");
        if (text) return text;
      }
    } catch {
      // Try next location.
    }
  }
  return FALLBACK_PRELOAD_JS;
}

function defaultExecAgentApi(args, { projectId } = {}) {
  return new Promise((resolvePromise) => {
    const env = { ...process.env };
    if (typeof projectId === "string" && projectId.trim()) {
      env.ANTIGRAVITY_PROJECT_ID = projectId.trim();
    }
    const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
    const file = exe || "agentapi";
    const isDirectAgentApi = !exe || basename(exe).toLowerCase().startsWith("agentapi");
    const execArgs = isDirectAgentApi ? args : ["agentapi", ...args];

    execFile(
      file,
      execArgs,
      { encoding: "utf8", env, timeout: AGENTAPI_TIMEOUT_MS, maxBuffer: AGENTAPI_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          resolvePromise({ error: error.message, stderr: stderr ? String(stderr) : undefined });
          return;
        }
        const trimmed = stdout ? String(stdout).trim() : "";
        if (!trimmed) {
          resolvePromise({ success: true });
          return;
        }
        try {
          resolvePromise(JSON.parse(trimmed));
        } catch {
          resolvePromise({ success: true, raw: trimmed });
        }
      }
    );
  });
}

export function createDefaultAgentApi(execFn = defaultExecAgentApi) {
  return {
    async sendMessage(conversationId, message, { title, projectId } = {}) {
      if (!SAFE_ID_SHAPE.test(String(conversationId || ""))) {
        return { error: "invalid conversationId" };
      }
      if (typeof message !== "string" || !message.trim()) {
        return { error: "message must be a non-empty string" };
      }
      const args = ["send-message"];
      if (typeof title === "string" && title.trim() && !title.startsWith("-")) {
        args.push("--title", title.trim());
      }
      args.push(conversationId, message);
      return execFn(args, { projectId });
    },
    async startConversation(message, { model = "flash", projectId } = {}) {
      if (typeof message !== "string" || !message.trim()) {
        return { error: "message must be a non-empty string" };
      }
      const cleanModel = typeof model === "string" && SAFE_ID_SHAPE.test(model) ? model : "flash";
      return execFn(["new-conversation", "--model", cleanModel, message], { projectId });
    },
    async getConversationMetadata(conversationId) {
      if (!SAFE_ID_SHAPE.test(String(conversationId || ""))) {
        return { error: "invalid conversationId" };
      }
      return execFn(["get-conversation-metadata", conversationId]);
    },
  };
}

export function parseFileWorkspaceUris(workspaceUris) {
  if (!Array.isArray(workspaceUris)) return [];
  const paths = [];
  for (const raw of workspaceUris) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("file://")) {
      try {
        paths.push(fileURLToPath(trimmed));
      } catch {
        // Ignore malformed file URIs.
      }
    }
  }
  return paths;
}

async function resolveWorkspaceRepoRoots(workspaceUris) {
  const folderPaths = parseFileWorkspaceUris(workspaceUris);
  const seen = new Set();
  const roots = [];
  for (const folderPath of folderPaths) {
    const repoRoot = await findRepositoryRoot(folderPath);
    if (repoRoot && !seen.has(repoRoot)) {
      seen.add(repoRoot);
      roots.push(repoRoot);
    }
  }
  return roots;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("Payload Too Large");
        err.status = 413;
        rejectPromise(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolvePromise({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          const err = new Error("JSON object body required");
          err.status = 400;
          rejectPromise(err);
          return;
        }
        resolvePromise(parsed);
      } catch {
        const err = new Error("Invalid JSON");
        err.status = 400;
        rejectPromise(err);
      }
    });
    req.on("error", rejectPromise);
  });
}

export function createArchitectureSidecarServer({
  port = 0,
  token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || "",
  preloadJs = loadPreloadScript(),
  agentApi = createDefaultAgentApi(),
  homeDir = homedir(),
  now = () => Date.now(),
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  assetDir = __dirname,
} = {}) {
  const panelHtml = readFileSync(join(assetDir, "panel.html"), "utf8");
  const panelCss = readFileSync(join(assetDir, "panel.css"), "utf8");
  const panelJs = readFileSync(join(assetDir, "panel.js"), "utf8");

  const staticPages = new Map([
    ["/", { body: panelHtml, contentType: "text/html; charset=utf-8" }],
    ["/index.html", { body: panelHtml, contentType: "text/html; charset=utf-8" }],
    ["/panel.css", { body: panelCss, contentType: "text/css; charset=utf-8" }],
    ["/panel.js", { body: panelJs, contentType: "application/javascript; charset=utf-8" }],
    ["/preload.js", { body: preloadJs, contentType: "application/javascript; charset=utf-8" }],
  ]);

  function validateToken(req, url) {
    if (!token) return true;
    const provided = req.headers["x-sidecar-token"] || url.searchParams.get("token");
    return provided === token;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${BIND_HOST}:${port || 80}`);

    if (req.method === "GET") {
      const asset = staticPages.get(url.pathname);
      if (!asset) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": asset.contentType,
        "Cache-Control": "no-store",
      });
      res.end(asset.body);
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }

    if (!validateToken(req, url)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      sendJson(res, error?.status || 400, { error: error?.message || "Invalid request" });
      return;
    }

    try {
      switch (url.pathname) {
        case "/_sidecar/send-message": {
          const result = await agentApi.sendMessage(body.conversationId, body.message, {
            title: body.title,
            projectId: body.projectId,
          });
          sendJson(res, 200, result);
          return;
        }
        case "/_sidecar/new-conversation": {
          const result = await agentApi.startConversation(body.message, {
            model: body.model,
            projectId: body.projectId,
          });
          sendJson(res, 200, result);
          return;
        }
        case "/_sidecar/get-conversation-metadata": {
          const result = await agentApi.getConversationMetadata(body.conversationId);
          sendJson(res, 200, result);
          return;
        }
        case "/api/status": {
          const roots = await resolveWorkspaceRepoRoots(body.workspaceUris);
          const repos = await Promise.all(
            roots.map((repoRoot) => readRepositoryStatus(repoRoot, { homeDir, now }))
          );
          sendJson(res, 200, { repos, now: now() });
          return;
        }
        case "/api/start-run": {
          const action = typeof body.action === "string" ? body.action.trim() : "";
          if (!RUN_ACTIONS.includes(action)) {
            sendJson(res, 400, { error: `Invalid action: ${String(body.action || "")}` });
            return;
          }
          const roots = await resolveWorkspaceRepoRoots(body.workspaceUris);
          const targetRoot = typeof body.repoRoot === "string" ? resolve(body.repoRoot) : "";
          if (!targetRoot || !roots.includes(targetRoot)) {
            sendJson(res, 403, { error: "repoRoot must match an active workspace repository" });
            return;
          }
          const started = await recordRunStart(targetRoot, action, { homeDir, now });
          if (!started.ok) {
            sendJson(res, 400, { error: started.error });
            return;
          }
          sendJson(res, 200, { ok: true, prompt: started.prompt, status: started.status });
          return;
        }
        case "/api/clear-run": {
          const roots = await resolveWorkspaceRepoRoots(body.workspaceUris);
          const targetRoot = typeof body.repoRoot === "string" ? resolve(body.repoRoot) : "";
          if (!targetRoot || !roots.includes(targetRoot)) {
            sendJson(res, 403, { error: "repoRoot must match an active workspace repository" });
            return;
          }
          await clearRunState(targetRoot, { homeDir });
          const status = await readRepositoryStatus(targetRoot, { homeDir, now });
          sendJson(res, 200, { ok: true, status });
          return;
        }
        default:
          sendJson(res, 404, { error: "Not found" });
      }
    } catch (error) {
      sendJson(res, 500, { error: error?.message || "Internal server error" });
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(port, BIND_HOST, () => {
          server.removeListener("error", rejectPromise);
          const addr = server.address();
          resolvePromise(addr && typeof addr === "object" ? addr.port : port);
        });
      });
    },
    close() {
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise());
      });
    },
  };
}
