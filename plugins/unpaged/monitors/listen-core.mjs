// Pure helpers for the listener monitor — kept apart from the runner so
// they can be tested with node:test and no network.

export const KEY_FILE_RELATIVE = ".claude/unpaged/listener.json";
export const SUBPROTOCOL = "unpaged-listener.v1";
export const CLOSE_INVALID_KEY = 4401;
export const CLOSE_SUPERSEDED = 4409;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60000;

/**
 * Parses the stored listener config. Returns null for anything that is
 * not `{ url, protocols: [SUBPROTOCOL, key] }` — the monitor then exits
 * silently, exactly as when the file is missing.
 */
export function parseListenerConfig(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { url, protocols } = value;
  if (typeof url !== "string" || !/^wss?:\/\//.test(url)) return null;
  if (!Array.isArray(protocols) || protocols.length < 2) return null;
  if (!protocols.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return null;
  }
  if (!protocols.includes(SUBPROTOCOL)) return null;
  return { url, protocols };
}

/** Exponential backoff, capped: 1s, 2s, 4s … 60s. */
export function backoffMs(attempt) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt));
}

/**
 * What to do after a close: `stop` with a line for the model, or
 * `reconnect` (silently). 4401 = the key is gone (re-arm via the command);
 * 4409 = a newer listener of this user took over — reconnecting would only
 * fight it, so this session stops listening.
 */
export function closePolicy(code) {
  if (code === CLOSE_INVALID_KEY) {
    return {
      action: "stop",
      line: "UnPaged listener key rejected — run /unpaged:listen to mint a new one."
    };
  }
  if (code === CLOSE_SUPERSEDED) {
    return {
      action: "stop",
      line: "Another UnPaged listener took over for this account; this session stops listening."
    };
  }
  return { action: "reconnect" };
}

/** One event per stdout line: a frame that is not JSON is dropped. */
export function frameLine(data) {
  const text = typeof data === "string" ? data : String(data);
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    if (parsed.type !== "agent-inbox-event") return null;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}
