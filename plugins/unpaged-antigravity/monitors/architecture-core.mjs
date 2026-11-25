// Pure helpers for the Unpaged Architecture workflow, SessionStart notice, and
// Antigravity auxiliary side-pane panel. Zero node:fs or timer imports so
// unit tests, the hook, and the sidecar server share one source of truth.
import { isDocumentId } from "./listen-core.mjs";

export const POINTER_RELATIVE = ".unpaged/architecture.json";
export const VERDICT_DIR_RELATIVE = ".gemini/unpaged/architecture";
export const RUN_DIR_RELATIVE = ".gemini/unpaged/architecture/runs";
export const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
export const RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const SIDECAR_PILL_URL = "sidecar://unpaged/architecture/";

export const VERDICT_STATES = Object.freeze(["current", "behind", "lost"]);
export const RUN_ACTIONS = Object.freeze(["compare", "update", "create"]);

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
  if (nowMs - startedMs >= RUN_TIMEOUT_MS) return false;
  if (verdict?.reportedAt) {
    const reportedMs = Date.parse(verdict.reportedAt);
    if (Number.isFinite(reportedMs) && reportedMs > startedMs) {
      return false;
    }
  }
  return true;
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
      detail: "Click Compare to check claims against today's code.",
    };
  }
  if (shown === "lost") {
    return {
      headline: "Canvas deleted or unreachable",
      detail: "Ask its owner for access or sign in with the right Unpaged account.",
    };
  }
  if (shown === "stale") {
    const label = dayLabel(verdict?.checkedAt, nowMs);
    return {
      headline: `Not compared since ${label ?? "an unknown day"}`,
      detail: "Last checked over three months ago.",
    };
  }
  if (shown === "behind") {
    const label = dayLabel(verdict?.behindSince ?? verdict?.checkedAt, nowMs);
    return {
      headline: `Behind since ${label ?? "an unknown day"}`,
      detail: "Code changed after the last architecture check.",
    };
  }
  const checked = dayLabel(verdict?.checkedAt, nowMs);
  return {
    headline: checked ? `Checked ${checked}` : "Up to date when last compared",
    detail: verdict?.commit
      ? `Up to date at commit ${verdict.commit}`
      : "All checked claims held on last check.",
  };
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

export function actionPrompt(action, { repoName = "this repository", documentId = null } = {}) {
  const target = repoName ? `repository "${repoName}"` : "this repository";
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
    const titlePart = url ? `[${title}](${url})` : title;
    return `**Unpaged Architecture** (${titlePart}): ${headline}.`;
  });
  return `${parts.join(" ")} [Unpaged Architecture](${SIDECAR_PILL_URL})`;
}
