// The poll contract, Node-free: the one request a poll makes and the whole
// validation of its response. Both hosts use it — poll.mjs (the Monitor
// script, Node streams) and the Claude Code mod (the host's fetch) — so one
// body of rules governs what a listener accepts. No node: imports, no
// timers, no Buffer: web-standard JavaScript only.
import { frameLine, isUnpagedListenerUrl, parseListenerConfig } from "./listen-core.mjs";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
// A response contains at most 200 frames of at most 64 KiB each. The whole
// response also has a 16 MiB byte ceiling, including whitespace and its envelope.
export const MAX_POLL_BYTES = 16 * 1024 * 1024;
export const MAX_POLL_EVENTS = 200;
export const MAX_FRAME_BYTES = 65536;
export const POLL_TIMEOUT_MS = 15000;
/** HTTP statuses that end a listener: 401 the key is gone, 409 a newer key owns the board. */
export const TERMINAL_STATUSES = Object.freeze([401, 409]);
// A successful poll names the polling interval in two headers, in whole
// seconds (ADR-043 v7): the next poll, and the next one after an idle hour.
export const POLL_INTERVAL_HEADER = "unpaged-poll-interval";
export const IDLE_POLL_INTERVAL_HEADER = "unpaged-idle-poll-interval";
export const MIN_POLL_INTERVAL_SECONDS = 5;
export const MAX_POLL_INTERVAL_SECONDS = 60;

export const failure = (reason) => Object.assign(new Error(reason), { reason });
export const validCursor = (value) => value === null || (typeof value === "string" && ID.test(value));
export const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);
/** UTF-8 bytes of a text, for the response ceiling where the body arrives as text. */
export const byteLength = (text) => new TextEncoder().encode(text).byteLength;

export function validFrame(frame, documentId) {
  if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.type !== "agent-inbox-event" ||
      (frame.schemaVersion !== undefined && frame.schemaVersion !== 1) || frame.documentId !== documentId ||
      !["mention", "reply"].includes(frame.reason) || !["owner", "editor", "viewer"].includes(frame.authorRole) ||
      typeof frame.resolved !== "boolean") return false;
  for (const key of ["id", "documentId", "nodeId", "threadId", "commentId"]) {
    if (typeof frame[key] !== "string" || !ID.test(frame[key])) return false;
  }
  for (const key of ["documentTitle", "nodeTitle", "authorName", "textPreview", "boardUrl"]) {
    if (typeof frame[key] !== "string") return false;
  }
  if (frame.anchorElementId !== null && (typeof frame.anchorElementId !== "string" || !ID.test(frame.anchorElementId))) return false;
  return typeof frame.createdAt === "string" && Number.isFinite(Date.parse(frame.createdAt)) &&
    new Date(frame.createdAt).toISOString() === frame.createdAt;
}

function intervalMs(value) {
  if (typeof value !== "string" || !/^\d{1,2}$/.test(value)) return undefined;
  const seconds = Number(value);
  return seconds >= MIN_POLL_INTERVAL_SECONDS && seconds <= MAX_POLL_INTERVAL_SECONDS ? seconds * 1000 : undefined;
}

/**
 * The cadence a successful response names, each header read through
 * `header(name)`. A missing value, or one that is not a whole number of
 * seconds from 5 to 60, is left out, and the loop keeps its own default.
 */
export function pollCadence(header) {
  const cadence = {};
  const normal = intervalMs(header(POLL_INTERVAL_HEADER));
  const idle = intervalMs(header(IDLE_POLL_INTERVAL_HEADER));
  if (normal !== undefined) cadence.intervalMs = normal;
  if (idle !== undefined) cadence.idleIntervalMs = idle;
  return cadence;
}

/**
 * The request a poll makes: the canonical endpoint with the page cursor as
 * its only query value, and the credential in a header, never in the URL.
 * Throws `invalid_poll_configuration` before any request can be made.
 */
export function pollRequest(binding, cursor = null) {
  try {
    if (!isUnpagedListenerUrl(binding?.pollUrl) || !parseListenerConfig(JSON.stringify(binding)) || !validCursor(cursor)) {
      throw failure("invalid_poll_configuration");
    }
  } catch {
    throw failure("invalid_poll_configuration");
  }
  const url = new URL(binding.pollUrl);
  if (cursor !== null) url.searchParams.set("cursor", cursor);
  return { url: url.href, headers: { Authorization: `Bearer ${binding.key}`, Accept: "application/json" } };
}

/**
 * The response body as text, validated whole before any event is returned:
 * the envelope's shape, the page cursor, every frame's size, shape and
 * board. Throws `poll_invalid_response`; never includes response text in it.
 */
export function parseEnvelope(text, documentId) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw failure("poll_invalid_response");
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).some((key) => !["events", "nextCursor"].includes(key)) ||
      !Array.isArray(envelope.events) || envelope.events.length > MAX_POLL_EVENTS ||
      (Object.hasOwn(envelope, "nextCursor") && !validCursor(envelope.nextCursor))) {
    throw failure("poll_invalid_response");
  }
  const events = envelope.events.map((frame) => {
    const raw = JSON.stringify(frame);
    if (byteLength(raw ?? "") > MAX_FRAME_BYTES) throw failure("poll_invalid_response");
    if (!validFrame(frame, documentId) || !frameLine(raw)) throw failure("poll_invalid_response");
    return frame;
  });
  return { events, nextCursor: envelope.nextCursor ?? null };
}
