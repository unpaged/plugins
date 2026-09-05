import { isAbsolute } from "node:path";

export const EVENTS_URL = "wss://mcp.unpaged.io/events";
export const SUBPROTOCOL = "unpaged-listener.v1";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/;

export function requireId(value) {
  if (typeof value !== "string" || !ID.test(value)) throw new Error("invalid_id");
  return value;
}
export function requireUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("invalid_uuid");
  return value;
}
export function validDigest(value) { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
export function requireDigest(value) {
  if (!validDigest(value)) throw new Error("invalid_plan_digest");
  return value;
}
export function boundedText(value, maximum = 1000) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
    throw new Error("invalid_evidence");
  }
  return value;
}
export function validTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
export function validateBinding(value) {
  if (!value || typeof value !== "object") throw new Error("invalid_binding");
  const { documentId, threadId, keyId, url, protocols, codexPath, planDigest } = value;
  requireUuid(documentId); requireUuid(threadId); requireId(keyId); requireDigest(planDigest);
  // The trusted arm command has already verified this executable's version and
  // queue capability; persist its absolute path without a platform-specific default.
  if (url !== EVENTS_URL || typeof codexPath !== "string" || codexPath.length > 4096 ||
    !isAbsolute(codexPath) || /[\0\r\n]/.test(codexPath)) throw new Error("invalid_endpoint");
  if (!Array.isArray(protocols) || protocols.length !== 2 || protocols[0] !== SUBPROTOCOL ||
    typeof protocols[1] !== "string" || protocols[1].length > 4096 || protocols[1] === SUBPROTOCOL ||
    !TOKEN.test(protocols[1])) throw new Error("invalid_protocols");
  const statusElementIds = value.statusElementIds ?? [];
  if (!Array.isArray(statusElementIds) || statusElementIds.length > 128 || new Set(statusElementIds).size !== statusElementIds.length) throw new Error("invalid_status_elements");
  for (const id of statusElementIds) requireUuid(id);
  return { documentId, threadId, keyId, url, protocols: [...protocols], codexPath, planDigest, statusElementIds: [...statusElementIds].sort() };
}

// Current AgentInboxFrame has no required schemaVersion. Store only routing
// facts; never retain author names, titles, URLs, or comment preview text.
export function parseEvent(raw, binding) {
  let event;
  try {
    if (typeof raw !== "string" || raw.length > 65536) return null;
    event = JSON.parse(raw);
    if (!event || typeof event !== "object" || event.type !== "agent-inbox-event" ||
      (event.schemaVersion !== undefined && event.schemaVersion !== 1) ||
      !["mention", "reply"].includes(event.reason) || !["owner", "editor", "viewer"].includes(event.authorRole) ||
      typeof event.resolved !== "boolean") return null;
    for (const key of ["id", "documentId", "nodeId", "threadId", "commentId"]) requireId(event[key]);
    for (const key of ["documentTitle", "nodeTitle", "authorName", "textPreview", "boardUrl"]) {
      if (typeof event[key] !== "string") return null;
    }
    if (event.anchorElementId !== null) requireId(event.anchorElementId);
    if (event.documentId !== binding.documentId || !validTime(event.createdAt)) return null;
    return validateRoutingEvent(event, binding.documentId);
  } catch { return null; }
}

export function validateRoutingEvent(event, documentId) {
  for (const key of ["id", "documentId", "nodeId", "threadId", "commentId"]) requireId(event?.[key]);
  if (event.documentId !== documentId || !["mention", "reply"].includes(event.reason) ||
    !["owner", "editor", "viewer"].includes(event.authorRole) || typeof event.resolved !== "boolean" ||
    !validTime(event.createdAt)) throw new Error("invalid_event");
  return Object.fromEntries(["id", "documentId", "nodeId", "threadId", "commentId", "reason", "authorRole", "resolved", "createdAt"]
    .map((key) => [key, event[key]]));
}
export function acceptancePhrase(digest) { return `I accept plan version ${requireDigest(digest).slice(0, 12)}`; }
export function acceptsPlan(text, digest) {
  const versioned = acceptancePhrase(digest).toLowerCase();
  if (typeof text !== "string" || text.length > 1000 || text.includes("\0")) return false;
  // Only standalone explicit acceptance is normalized. Quotes, questions,
  // conditions, negation and additional clauses remain ambiguous feedback.
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase()
    .replace(/^@agent(?:\s*:\s*|\s+)/, "").replace(/[.!]+$/, "").trim();
  return normalized === "i accept this plan" || normalized === versioned;
}
export function validateEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_evidence");
  if (value.skippedReason !== undefined) {
    if (Object.keys(value).length !== 1) throw new Error("invalid_evidence");
    return { skippedReason: boundedText(value.skippedReason, 500) };
  }
  if (Object.keys(value).sort().join(",") !== "planDigest,replyId") throw new Error("invalid_evidence");
  return { replyId: requireId(value.replyId), planDigest: requireDigest(value.planDigest) };
}
