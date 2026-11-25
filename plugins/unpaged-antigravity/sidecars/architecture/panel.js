(() => {
"use strict";

// Frontend controller for the Unpaged Architecture side-pane panel.
// Security invariant: never assign innerHTML with dynamic data — build all UI
// nodes via createElement + textContent and validate canvas links against
// https://unpaged.io/.

const VISIBLE_POLL_MS = 2500;
const RUNNING_POLL_MS = 1500;
const WORKSPACE_TIMEOUT_MS = 2000;

const appEl = document.getElementById("app");

let workspaceUris = [];
let repos = [];
let selectedRepoRoot = null;
let lastError = null;
let pendingAction = null;
let syncInFlight = false;
let pollTimer = null;
let refreshInFlight = false;
const autoSyncAttempted = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (typeof text === "string") node.textContent = text;
  return node;
}

function isSafeBoardUrl(url) {
  return typeof url === "string" && /^https:\/\/unpaged\.io\/document\/[A-Za-z0-9_-]{8,128}\/edit$/.test(url);
}

function clearElement(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function buttonLabel(action) {
  if (action === "compare") return "Compare with code";
  if (action === "update") return "Update canvas";
  if (action === "create") return "Create architecture canvas";
  return action;
}

function secondaryButtonLabel(action, shown) {
  if (action === "compare" && (shown === "behind" || shown === "stale")) {
    return "Compare again";
  }
  return buttonLabel(action);
}

function currentRepo() {
  if (!repos.length) return null;
  if (selectedRepoRoot) {
    const match = repos.find((r) => r.repoRoot === selectedRepoRoot);
    if (match) return match;
  }
  selectedRepoRoot = repos[0].repoRoot;
  return repos[0];
}

function renderEmpty(title, subtitle) {
  clearElement(appEl);
  const card = el("section", "panel-card");
  const header = el("header", "panel-header");
  header.appendChild(el("span", "eyebrow", "UNPAGED ARCHITECTURE"));
  card.appendChild(header);

  const body = el("div", "empty-state");
  body.appendChild(el("h2", "status-headline", title));
  body.appendChild(el("p", "status-detail", subtitle));
  card.appendChild(body);
  appEl.appendChild(card);
}

function renderPanel() {
  if (!workspaceUris.length) {
    renderEmpty("No project open", "Open a git repository in Antigravity to check or draw its architecture canvas.");
    return;
  }
  const repo = currentRepo();
  if (!repo) {
    renderEmpty("No git repository found", "Open a folder inside a git repository to track its architecture document.");
    return;
  }

  clearElement(appEl);
  const card = el("section", `panel-card state-${repo.shown}`);

  // Header + repo badge or switcher
  const header = el("header", "panel-header");
  header.appendChild(el("span", "eyebrow", "UNPAGED ARCHITECTURE"));

  if (repos.length > 1) {
    const select = el("select", "repo-select");
    select.setAttribute("aria-label", "Select repository");
    repos.forEach((item, index) => {
      const option = document.createElement("option");
      option.value = item.repoRoot;
      option.textContent = `${item.repoName} (${index + 1}/${repos.length})`;
      if (item.repoRoot === repo.repoRoot) option.selected = true;
      select.appendChild(option);
    });
    select.addEventListener("change", (event) => {
      selectedRepoRoot = event.target.value;
      lastError = null;
      renderPanel();
      maybeAutoSync(currentRepo());
    });
    header.appendChild(select);
  } else {
    header.appendChild(el("span", "repo-badge", repo.repoName));
  }
  card.appendChild(header);

  // Status light row
  const statusRow = el("div", "status-row");
  const dotWrap = el("span", "dot-wrap");
  dotWrap.appendChild(el("span", `status-dot dot-${repo.color}${repo.shown === "comparing" ? " pulsing" : ""}`));
  statusRow.appendChild(dotWrap);

  const statusText = el("div", "status-text");
  statusText.appendChild(el("h2", `status-headline tone-${repo.color}`, repo.headline));
  statusText.appendChild(el("p", "status-detail", repo.detail));
  statusRow.appendChild(statusText);
  card.appendChild(statusRow);

  // Canvas link card when pointer exists
  if (repo.documentId && isSafeBoardUrl(repo.boardUrl)) {
    const canvasRow = el("div", `canvas-row tone-surface-${repo.color}`);
    canvasRow.appendChild(el("span", "canvas-title", repo.title || repo.repoName));
    const link = el("a", "canvas-link", "Open canvas ↗");
    link.href = repo.boardUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    canvasRow.appendChild(link);
    card.appendChild(canvasRow);
  }

  // Action buttons
  const actionsWrap = el("div", "actions");
  if (repo.shown === "comparing") {
    const busyBtn = el("button", "btn btn-disabled", repo.headline);
    busyBtn.type = "button";
    busyBtn.disabled = true;
    actionsWrap.appendChild(busyBtn);
  } else {
    repo.actions.forEach((action, idx) => {
      const isPrimary = idx === 0;
      const label = isPrimary ? buttonLabel(action) : secondaryButtonLabel(action, repo.shown);
      const toneClass =
        isPrimary && (repo.shown === "behind" || repo.shown === "stale")
          ? "btn btn-amber"
          : isPrimary
            ? "btn btn-primary"
            : "btn btn-secondary";
      const btn = el("button", toneClass, pendingAction === action ? "Starting…" : label);
      btn.type = "button";
      btn.disabled = pendingAction !== null || syncInFlight;
      btn.addEventListener("click", () => handleAction(repo, action));
      actionsWrap.appendChild(btn);
    });
  }
  card.appendChild(actionsWrap);

  if (repo.shown === "unknown" && repo.syncCooldownActive) {
    const retryRow = el("div", "sync-retry-row");
    const retryBtn = el("button", "btn-link", syncInFlight ? "Checking…" : "Retry status sync");
    retryBtn.type = "button";
    retryBtn.disabled = pendingAction !== null || syncInFlight;
    retryBtn.addEventListener("click", () => maybeAutoSync(repo, { force: true }));
    retryRow.appendChild(retryBtn);
    card.appendChild(retryRow);
  }

  if (lastError) {
    card.appendChild(el("p", "error-banner", lastError));
  }

  const footerText =
    repo.shown === "comparing"
      ? repo.activeRun?.action === "sync"
        ? "Settles automatically once the background status check finishes."
        : "Settles automatically once the open chat finishes."
      : repo.shown === "none"
        ? "Reads the code and draws a new canvas in your open chat."
        : "Runs in your currently open chat (starts a new chat if none is open).";
  const footer = el("footer", "panel-footer", footerText);
  card.appendChild(footer);
  appEl.appendChild(card);
}

async function sidecarFetch(path, body) {
  const fetcher = window.sidecar?.fetch || ((u, opts) => fetch(u, opts));
  const res = await fetcher(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const errData = await res.json();
      if (errData?.error) msg = errData.error;
    } catch {
      // Keep status message.
    }
    throw new Error(msg);
  }
  return res.json();
}

function canAutoSyncHost() {
  return Boolean(window.sidecar?.conversationId) || window.parent !== window;
}

async function maybeAutoSync(repo, { force = false } = {}) {
  if (!repo || repo.shown !== "unknown" || !repo.documentId || pendingAction !== null || syncInFlight) {
    return;
  }
  const attemptKey = `${repo.repoRoot}::${repo.documentId}`;
  if (!force) {
    if (!canAutoSyncHost() || repo.syncCooldownActive || autoSyncAttempted.has(attemptKey)) {
      return;
    }
    autoSyncAttempted.add(attemptKey);
  }

  syncInFlight = true;
  if (force) {
    lastError = null;
    renderPanel();
  }
  try {
    const result = await sidecarFetch("/api/sync-status", {
      repoRoot: repo.repoRoot,
      workspaceUris,
      conversationId: window.sidecar?.conversationId || "",
      force,
    });
    if (result?.status) {
      repos = repos.map((item) => (item.repoRoot === repo.repoRoot ? result.status : item));
      renderPanel();
      scheduleNextPoll();
    }
    if (force && !result?.started && result?.error) {
      lastError = String(result.error);
      renderPanel();
    }
  } catch (error) {
    if (force) {
      lastError = error?.message || "Could not sync canvas status.";
      renderPanel();
    }
  } finally {
    syncInFlight = false;
    renderPanel();
  }
}

async function refreshStatus() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    if (!workspaceUris.length) {
      repos = [];
      renderPanel();
      return;
    }
    const data = await sidecarFetch("/api/status", { workspaceUris });
    repos = Array.isArray(data?.repos) ? data.repos : [];
    renderPanel();
    scheduleNextPoll();
    maybeAutoSync(currentRepo());
  } catch (error) {
    lastError = error?.message || "Could not read architecture status.";
    renderPanel();
  } finally {
    refreshInFlight = false;
  }
}

async function handleAction(repo, action) {
  if (pendingAction || syncInFlight) return;
  pendingAction = action;
  lastError = null;
  renderPanel();

  try {
    const started = await sidecarFetch("/api/start-run", {
      repoRoot: repo.repoRoot,
      action,
      workspaceUris,
    });
    if (started?.status) {
      repos = repos.map((item) => (item.repoRoot === repo.repoRoot ? started.status : item));
      renderPanel();
    }

    const prompt = started?.prompt;
    if (!prompt) {
      throw new Error("Missing action prompt from sidecar server.");
    }

    let sendResult;
    if (window.sidecar?.conversationId) {
      sendResult = await window.sidecar.agent.sendMessage(prompt);
    } else if (window.sidecar?.agent?.startConversation) {
      sendResult = await window.sidecar.agent.startConversation(prompt, "Unpaged Architecture");
    } else {
      throw new Error("Antigravity agent bridge is not available.");
    }

    if (sendResult && typeof sendResult === "object" && sendResult.error) {
      throw new Error(String(sendResult.error));
    }
    scheduleNextPoll();
  } catch (error) {
    lastError = error?.message || "Could not send action to the chat.";
    await sidecarFetch("/api/clear-run", {
      repoRoot: repo.repoRoot,
      workspaceUris,
    }).catch(() => {});
    await refreshStatus();
  } finally {
    pendingAction = null;
    renderPanel();
  }
}

function measureColorLuminance(cssColor) {
  if (typeof cssColor !== "string" || !cssColor.trim()) return null;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;";
  probe.style.color = cssColor.trim();
  if (!probe.style.color) return null;
  const mount = document.body || document.documentElement;
  mount.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const nums = (resolved.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const scale = resolved.startsWith("color(") ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function syncHostTheme(vars) {
  const root = document.documentElement;
  const bg = vars?.["--background"] || getComputedStyle(root).getPropertyValue("--background");
  const lum = measureColorLuminance(bg);
  if (lum !== null) {
    root.dataset.followHost = "true";
    root.dataset.theme = lum < 0.45 ? "dark" : "light";
    return;
  }
  delete root.dataset.followHost;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  root.dataset.theme = prefersDark ? "dark" : "light";
}

function extractWorkspaceUrisFromMetadata(data) {
  const meta =
    data?.response?.conversationMetadata?.metadata ||
    data?.response?.conversation_metadata?.metadata ||
    data?.metadata ||
    null;
  if (!meta || typeof meta !== "object") return [];
  const seen = new Set();
  const uris = [];
  const addUri = (raw) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      uris.push(trimmed);
    }
  };
  if (Array.isArray(meta.workspaceUris)) {
    for (const uri of meta.workspaceUris) addUri(uri);
  }
  if (Array.isArray(meta.workspaces)) {
    for (const ws of meta.workspaces) {
      addUri(ws?.gitRootAbsoluteUri || ws?.workspaceFolderAbsoluteUri);
    }
  }
  return uris;
}

async function resolveInitialWorkspaceUris() {
  let uris = [];
  if (window.sidecar?.getWorkspaceUris) {
    let timerId = null;
    try {
      const result = await Promise.race([
        window.sidecar.getWorkspaceUris(),
        new Promise((resolveTimeout) => {
          timerId = setTimeout(() => resolveTimeout(null), WORKSPACE_TIMEOUT_MS);
        }),
      ]);
      if (Array.isArray(result)) {
        uris = result;
      }
    } catch {
      uris = [];
    } finally {
      if (timerId !== null) clearTimeout(timerId);
    }
  }
  if (!uris.length && window.sidecar?.conversationId && window.sidecar?.agent?.getConversationMetadata) {
    try {
      const metaRes = await window.sidecar.agent.getConversationMetadata(window.sidecar.conversationId);
      const fallback = extractWorkspaceUrisFromMetadata(metaRes);
      if (fallback.length) uris = fallback;
    } catch {
      // Keep empty list until the host pushes workspace URIs.
    }
  }
  return uris;
}

function scheduleNextPoll() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (document.visibilityState === "hidden") return;
  const active = repos.some((r) => r.shown === "comparing");
  const delay = active ? RUNNING_POLL_MS : VISIBLE_POLL_MS;
  pollTimer = setTimeout(() => {
    refreshStatus();
  }, delay);
}

async function init() {
  syncHostTheme();
  window.addEventListener("message", (event) => {
    if (event.data?.type === "theme-change") {
      syncHostTheme(event.data.payload?.cssVariables);
    }
  });
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    syncHostTheme();
  });

  renderEmpty("Loading architecture status…", "Checking workspace repositories.");

  let sawWorkspacePush = false;
  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((nextUris) => {
      sawWorkspacePush = true;
      workspaceUris = Array.isArray(nextUris) ? nextUris : [];
      refreshStatus();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      refreshStatus();
    } else if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  });

  const resolvedUris = await resolveInitialWorkspaceUris();
  if (!sawWorkspacePush || !workspaceUris.length) {
    workspaceUris = resolvedUris;
  }
  await refreshStatus();
}

init();
})();
