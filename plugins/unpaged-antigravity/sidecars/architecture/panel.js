// Frontend controller for the Unpaged Architecture side-pane panel.
// Security invariant: never assign innerHTML with dynamic data — build all UI
// nodes via createElement + textContent and validate canvas links against
// https://unpaged.io/.

const VISIBLE_POLL_MS = 2500;
const RUNNING_POLL_MS = 1500;

const appEl = document.getElementById("app");

let workspaceUris = [];
let repos = [];
let selectedRepoRoot = null;
let lastError = null;
let pendingSubmit = false;
let pollTimer = null;
let refreshInFlight = false;

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
      const btn = el("button", toneClass, pendingSubmit ? "Starting…" : label);
      btn.type = "button";
      btn.disabled = pendingSubmit;
      btn.addEventListener("click", () => handleAction(repo, action));
      actionsWrap.appendChild(btn);
    });
  }
  card.appendChild(actionsWrap);

  if (lastError) {
    card.appendChild(el("p", "error-banner", lastError));
  }

  const footer = el(
    "footer",
    "panel-footer",
    repo.shown === "comparing"
      ? "Settles automatically once the open chat finishes."
      : repo.shown === "none"
        ? "Reads the code and draws a new canvas in your open chat."
        : "Runs in your currently open chat (starts a new chat if none is open)."
  );
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
  } catch (error) {
    lastError = error?.message || "Could not read architecture status.";
    renderPanel();
  } finally {
    refreshInFlight = false;
  }
}

async function handleAction(repo, action) {
  if (pendingSubmit) return;
  pendingSubmit = true;
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
    pendingSubmit = false;
    renderPanel();
  }
}

function parseLuminance(color) {
  if (typeof color !== "string") return null;
  const s = color.trim();
  let r, g, b;
  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) {
      r = parseInt(h[0] + h[0], 16);
      g = parseInt(h[1] + h[1], 16);
      b = parseInt(h[2] + h[2], 16);
    } else {
      r = parseInt(h.slice(0, 2), 16);
      g = parseInt(h.slice(2, 4), 16);
      b = parseInt(h.slice(4, 6), 16);
    }
  } else {
    const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (!rgb) return null;
    r = Number(rgb[1]);
    g = Number(rgb[2]);
    b = Number(rgb[3]);
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function syncHostTheme(vars) {
  const root = document.documentElement;
  const bg = vars?.["--background"] || getComputedStyle(root).getPropertyValue("--background");
  const lum = parseLuminance(bg);
  if (lum !== null) {
    root.dataset.followHost = "true";
    root.dataset.theme = lum < 0.45 ? "dark" : "light";
    return;
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  root.dataset.theme = prefersDark ? "dark" : "light";
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

  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((nextUris) => {
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

  if (window.sidecar?.getWorkspaceUris) {
    workspaceUris = await window.sidecar.getWorkspaceUris();
  }
  await refreshStatus();
}

init();
