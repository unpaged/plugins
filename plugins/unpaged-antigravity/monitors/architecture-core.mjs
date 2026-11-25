// Pure helpers for the Unpaged Architecture workflow, SessionStart notice, and
// Antigravity auxiliary side-pane panel. Zero node:fs or timer imports so
// unit tests, the hook, and the sidecar server share one source of truth.
import { isDocumentId } from "./listen-core.mjs";

export const POINTER_RELATIVE = ".unpaged/architecture.json";
export const VERDICT_DIR_RELATIVE = ".gemini/unpaged/architecture";
export const RUN_DIR_RELATIVE = ".gemini/unpaged/architecture/runs";
export const SYNC_DIR_RELATIVE = ".gemini/unpaged/architecture/sync-attempts";
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const SYNC_TIMEOUT_MS = 2 * 60 * 1000;
export const SYNC_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const SIDECAR_PILL_URL = "sidecar://unpaged/architecture/";
export const CHECKED_PREFIX = "**Checked:**";
export const BEHIND_PREFIX = "**Behind since:**";
export const COMMIT_PREFIX = "compared at ";

export const VERDICT_STATES = Object.freeze(["current", "behind", "lost"]);
export const RUN_ACTIONS = Object.freeze(["compare", "update", "create", "sync"]);

const DAY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const COMMIT_SHAPE = /^[0-9a-f]{7,40}$/;
const SKIP_PATTERN_SHAPE = /^[A-Za-z0-9._\-\/*?\[\]!@+]+$/;
const MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

export function boardUrlFor(documentId) {
  return isDocumentId(documentId) ? `https://unpaged.io/document/${documentId}/edit` : null;
}

export function validDay(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DAY_SHAPE.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10) === trimmed ? trimmed : null;
}

export function dayMs(isoDay) {
  const clean = validDay(isoDay);
  if (!clean) return null;
  return Date.parse(`${clean}T00:00:00Z`);
}

export function validCommit(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return COMMIT_SHAPE.test(trimmed) ? trimmed : null;
}

export function filterSkipPatterns(list) {
  const accepted = [];
  const rejected = [];
  if (!Array.isArray(list)) return { accepted, rejected };
  for (const entry of list) {
    if (typeof entry === "string" && entry.length > 0 && SKIP_PATTERN_SHAPE.test(entry)) {
      accepted.push(entry);
    } else if (entry !== undefined && entry !== null) {
      rejected.push(String(entry));
    }
  }
  return { accepted, rejected };
}

export function parseArchitecturePointer(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!isDocumentId(parsed.documentId)) return null;
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null;
  const { accepted: skip, rejected: rejectedSkip } = filterSkipPatterns(parsed.skip);
  return {
    documentId: String(parsed.documentId),
    title,
    skip,
    rejectedSkip,
  };
}

export function normalizeVerdict(raw, expectedDocumentId = null) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const documentId = typeof parsed.documentId === "string" ? parsed.documentId.trim() : "";
  if (!isDocumentId(documentId)) return null;
  if (expectedDocumentId && documentId !== expectedDocumentId) return null;
  const state = typeof parsed.state === "string" ? parsed.state.trim() : "";
  if (!VERDICT_STATES.includes(state)) return null;
  const checkedAt = validDay(parsed.checkedAt);
  const behindSince =
    state === "behind" ? (validDay(parsed.behindSince) ?? checkedAt) : null;
  const commit = validCommit(parsed.commit);
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : null;
  const reportedAt =
    typeof parsed.reportedAt === "string" && Number.isFinite(Date.parse(parsed.reportedAt))
      ? parsed.reportedAt
      : "";
  return {
    documentId,
    state,
    title,
    checkedAt,
    commit,
    behindSince,
    reportedAt,
  };
}

export function normalizeRunRecord(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const action = typeof parsed.action === "string" ? parsed.action.trim() : "";
  if (!RUN_ACTIONS.includes(action)) return null;
  const repoRoot = typeof parsed.repoRoot === "string" ? parsed.repoRoot.trim() : "";
  if (!repoRoot) return null;
  const startedAt = typeof parsed.startedAt === "string" ? parsed.startedAt : "";
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;
  return {
    action,
    repoRoot,
    startedAt: new Date(startedMs).toISOString(),
  };
}

export function isRunActive(runRecord, verdict, nowMs = Date.now()) {
  if (!runRecord) return false;
  const startedMs = Date.parse(runRecord.startedAt);
  if (!Number.isFinite(startedMs)) return false;
  const timeoutMs = runRecord.action === "sync" ? SYNC_TIMEOUT_MS : RUN_TIMEOUT_MS;
  if (nowMs - startedMs >= timeoutMs) return false;
  if (verdict?.reportedAt) {
    const reportedMs = Date.parse(verdict.reportedAt);
    if (Number.isFinite(reportedMs) && reportedMs > startedMs) {
      return false;
    }
  }
  return true;
}

export function verdictFromDocument(documentId, value) {
  if (!isDocumentId(documentId)) return null;
  let doc;
  try {
    doc = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return null;
  if (typeof doc.id === "string" && doc.id.trim() && doc.id.trim() !== documentId) return null;
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const root =
    nodes.find((n) => n && n.id === doc.rootNodeId) ??
    nodes.find((n) => n && !n.parentId && !n.parentNodeId) ??
    nodes[0];
  if (!root || typeof root !== "object") return null;

  let state = null;
  let noteDay = null;
  let commitDay = null;
  let behindSince = null;
  let commit = null;
  for (const element of Array.isArray(root.elements) ? root.elements : []) {
    const content = typeof element?.properties?.text === "string" ? element.properties.text.trim() : "";
    if (content.startsWith(CHECKED_PREFIX)) {
      if (state !== "behind") state = "current";
      noteDay = validDay(content.slice(CHECKED_PREFIX.length)) ?? noteDay;
    } else if (content.startsWith(BEHIND_PREFIX)) {
      state = "behind";
      behindSince = validDay(content.slice(BEHIND_PREFIX.length)) ?? behindSince;
    } else if (content.startsWith(COMMIT_PREFIX)) {
      const rest = content.slice(COMMIT_PREFIX.length).trim();
      const sha = rest.split(/\s+/)[0];
      commit = validCommit(sha) ?? commit;
      commitDay = validDay(rest.match(/\bon\s+(\d{4}-\d{2}-\d{2})\s*$/)?.[1]) ?? commitDay;
    }
  }
  if (!state) return null;

  const checkedAt = commitDay ?? noteDay ?? null;
  const resolvedBehindSince = state === "behind" ? (behindSince ?? checkedAt) : null;
  const title = typeof doc.title === "string" && doc.title.trim() ? doc.title.trim() : null;
  return {
    documentId,
    state,
    title,
    checkedAt,
    commit,
    behindSince: resolvedBehindSince,
  };
}

export function normalizeSyncAttempt(raw) {
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const documentId = typeof parsed.documentId === "string" ? parsed.documentId.trim() : "";
  if (!isDocumentId(documentId)) return null;
  const attemptedAt = typeof parsed.attemptedAt === "string" ? parsed.attemptedAt : "";
  const attemptedMs = Date.parse(attemptedAt);
  if (!Number.isFinite(attemptedMs)) return null;
  return {
    documentId,
    attemptedAt: new Date(attemptedMs).toISOString(),
  };
}

export function isSyncCooldownActive(attempt, documentId, nowMs = Date.now()) {
  if (!attempt || !isDocumentId(documentId) || attempt.documentId !== documentId) return false;
  const ms = Date.parse(attempt.attemptedAt);
  if (!Number.isFinite(ms)) return false;
  return nowMs - ms < SYNC_COOLDOWN_MS && nowMs >= ms - 60_000;
}

export function shownState(pointer, verdict, runRecord, nowMs = Date.now()) {
  if (isRunActive(runRecord, verdict, nowMs)) return "comparing";
  if (!pointer) return "none";
  if (!verdict) return "unknown";
  if (verdict.state === "lost") return "lost";
  const checked = dayMs(verdict.checkedAt);
  if ((verdict.state === "current" || verdict.state === "behind") && checked !== null && nowMs - checked > STALE_AFTER_MS) {
    return "stale";
  }
  if (verdict.state === "behind") return "behind";
  return "current";
}

export function lightColor(shown) {
  if (shown === "current") return "green";
  if (shown === "behind" || shown === "comparing") return "yellow";
  if (shown === "lost" || shown === "stale") return "red";
  return "gray";
}

export function dayLabel(isoDay, nowMs = Date.now()) {
  const ms = dayMs(isoDay);
  if (ms === null) return null;
  const d = new Date(ms);
  const label = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date(nowMs).getUTCFullYear()
    ? label
    : `${label} ${d.getUTCFullYear()}`;
}

export function elapsedDays(isoDay, nowMs = Date.now()) {
  const ms = dayMs(isoDay);
  if (ms === null || !Number.isFinite(nowMs)) return null;
  const d = new Date(nowMs);
  const todayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(0, Math.floor((todayUtc - ms) / (24 * 60 * 60 * 1000)));
}

export function durationLabel(days) {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return null;
  const whole = Math.floor(days);
  if (whole === 0) return "today";
  if (whole === 1) return "1 day";
  if (whole < 30) return `${whole} days`;
  if (whole < 60) return `${Math.floor(whole / 7)} weeks`;
  if (whole < 365) return `${Math.min(11, Math.floor(whole / 30))} months`;
  const years = Math.floor(whole / 365);
  return years === 1 ? "1 year" : `${years} years`;
}

export function describeStatus(status, nowMs = Date.now()) {
  const shown = status?.shown ?? "none";
  const verdict = status?.verdict ?? null;
  const activeRun = status?.activeRun ?? null;
  if (shown === "none") {
    return {
      headline: "No architecture document yet",
      detail: status?.pointerInvalid
        ? "Pointer file is malformed; fix or recreate it."
        : "Draw an architecture canvas from the code.",
    };
  }
  if (shown === "comparing") {
    if (activeRun?.action === "sync") {
      return {
        headline: "Checking canvas status…",
        detail: "Reading the last check date from Unpaged in a background chat.",
      };
    }
    if (activeRun?.action === "update") {
      return {
        headline: "Updating canvas…",
        detail: "Re-checking claims and updating cards in your open chat.",
      };
    }
    if (activeRun?.action === "create") {
      return {
        headline: "Creating architecture canvas…",
        detail: "Reading the code and drawing the overview in your open chat.",
      };
    }
    return {
      headline: "Comparing with code…",
      detail: "Running a clean-slate check in your open chat.",
    };
  }
  if (shown === "unknown") {
    return {
      headline: "Not compared from this machine yet",
      detail: status?.syncCooldownActive
        ? "Automatic status check did not finish. Click Compare, or retry sync below."
        : "Click Compare to check claims against today's code.",
    };
  }
  if (shown === "lost") {
    return {
      headline: "Canvas deleted or unreachable",
      detail: "Ask its owner for access or sign in with the right Unpaged account.",
    };
  }
  if (shown === "stale") {
    const checkedDay = verdict?.checkedAt ?? null;
    const label = dayLabel(checkedDay, nowMs);
    const days = elapsedDays(checkedDay, nowMs);
    const duration = durationLabel(days);
    if (duration && days > 0) {
      return {
        headline: `Not compared for ${duration}`,
        detail: label ? `Last checked ${label} — over three months ago.` : "Last checked over three months ago.",
      };
    }
    return {
      headline: `Not compared since ${label ?? "an unknown day"}`,
      detail: "Last checked over three months ago.",
    };
  }
  if (shown === "behind") {
    const sinceDay = verdict?.behindSince ?? verdict?.checkedAt ?? null;
    const label = dayLabel(sinceDay, nowMs);
    const days = elapsedDays(sinceDay, nowMs);
    const duration = durationLabel(days);
    const detail = label
      ? `Behind since ${label} · Code changed after the last check.`
      : "Code changed after the last architecture check.";
    if (days === 0) {
      return { headline: "Behind since today", detail };
    }
    if (duration) {
      return { headline: `${duration} behind`, detail };
    }
    return {
      headline: `Behind since ${label ?? "an unknown day"}`,
      detail: "Code changed after the last architecture check.",
    };
  }
  const checkedDay = verdict?.checkedAt ?? null;
  const checked = dayLabel(checkedDay, nowMs);
  const days = elapsedDays(checkedDay, nowMs);
  const duration = durationLabel(days);
  const headline =
    days === 0
      ? "Checked today"
      : days === 1
        ? "Checked yesterday"
        : duration
          ? `Checked ${duration} ago`
          : checked
            ? `Checked ${checked}`
            : "Up to date when last compared";
  const detail = verdict?.commit
    ? `${checked ? `Up to date on ${checked}` : "Up to date"} at commit ${verdict.commit}`
    : checked
      ? `All checked claims held on ${checked}.`
      : "All checked claims held on last check.";
  return { headline, detail };
}

export function needsAttention(shown) {
  return shown === "behind" || shown === "stale" || shown === "lost";
}

export function availableActions(shown) {
  if (shown === "comparing") return [];
  if (shown === "none" || shown === "lost") return ["create"];
  if (shown === "behind" || shown === "stale") return ["update", "compare"];
  return ["compare", "update"];
}

export function sanitizeRepoLabel(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, " ")
    .replace(/["`]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
}

export function syncChatTitle(repoName) {
  const clean = sanitizeRepoLabel(repoName);
  return clean ? `Unpaged Architecture · ${clean}`.slice(0, 120) : "Unpaged Architecture";
}

export function actionPrompt(action, { repoName = "", documentId = null } = {}) {
  const cleanName = sanitizeRepoLabel(repoName);
  const target = cleanName ? `repository "${cleanName}"` : "this repository";
  if (action === "sync") {
    const idClause = isDocumentId(documentId) ? ` (canvas id ${documentId})` : "";
    return `Automatic status sync from the Unpaged Architecture side panel for ${target}${idClause}. Run the \`architecture\` skill in \`sync\` mode now: do NOT run git or read codebase files, and do NOT edit the canvas or post comments. Call ONLY \`document_get\` on the \`unpaged\` MCP server for the canvas in \`.unpaged/architecture.json\`, pass its output file (or JSON on stdin) to \`monitors/architecture.mjs report-document\` (or \`clear-run\` if Unpaged sign-in is missing, a network error occurred, or the canvas has no date note yet; report \`lost\` only when Unpaged confirms the canvas is not found or inaccessible), then reply in one short sentence.`;
  }
  if (action === "compare") {
    return `The user clicked Compare in the Unpaged Architecture side panel for ${target}. Run the \`architecture\` skill in \`compare\` mode now: run a clean-slate check in a separate helper, mark the canvas without rewriting cards, and finish by saving the verdict with \`monitors/architecture.mjs report\`.`;
  }
  if (action === "update") {
    return `The user clicked Update in the Unpaged Architecture side panel for ${target}. Run the \`architecture\` skill in \`update\` mode now: re-check the whole canvas in a separate helper, rewrite outdated cards and redraw changed flows with open comments, and finish by saving the verdict with \`monitors/architecture.mjs report\`.`;
  }
  if (action === "create") {
    const existing = isDocumentId(documentId)
      ? ` Note: \`.unpaged/architecture.json\` already names canvas ${documentId}; verify whether it is deleted or belongs to a teammate and ask before overwriting the pointer.`
      : "";
    return `The user clicked Create in the Unpaged Architecture side panel for ${target}. Run the \`architecture\` skill in \`create\` mode now: read the code alone, draw the architecture canvas organized by a new engineer's questions, write \`.unpaged/architecture.json\`, and finish by saving the verdict with \`monitors/architecture.mjs report\`.${existing}`;
  }
  throw new Error(`Unsupported architecture action: ${String(action)}`);
}

export function sanitizeMarkdownLabel(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .replace(/[\\[\]()*_`<>]/g, "\\$&");
}

export function formatAttentionMarkdown(statuses, nowMs = Date.now()) {
  if (!Array.isArray(statuses) || statuses.length === 0) return "";
  const items = statuses.filter((s) => s && needsAttention(s.shown));
  if (items.length === 0) return "";
  const parts = items.map((item) => {
    const title = sanitizeMarkdownLabel(item.title || item.repoName || item.documentId || "Architecture");
    const url = boardUrlFor(item.documentId);
    const { headline } = describeStatus(item, nowMs);
    const sinceDay =
      item.shown === "behind"
        ? (item.verdict?.behindSince ?? item.verdict?.checkedAt)
        : item.shown === "stale"
          ? item.verdict?.checkedAt
          : null;
    const sinceLabel = sinceDay ? dayLabel(sinceDay, nowMs) : null;
    const suffix = sinceLabel
      ? (headline.toLowerCase().includes("since") ? ` (${sinceLabel})` : ` (since ${sinceLabel})`)
      : "";
    const titlePart = url ? `[${title}](${url})` : title;
    return `**Unpaged Architecture** (${titlePart}): ${headline}${suffix}.`;
  });
  return `${parts.join(" ")} [Unpaged Architecture](${SIDECAR_PILL_URL})`;
}
