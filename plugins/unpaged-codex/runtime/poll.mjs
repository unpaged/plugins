import { POLL_URL, parseEvent, validateBinding } from "./protocol.mjs";

// A response contains at most 200 frames of at most 64 KiB each. The whole
// response also has a 16 MiB byte ceiling, including whitespace and its envelope.
export const MAX_POLL_BYTES = 16 * 1024 * 1024;
export const MAX_POLL_EVENTS = 200;
export const POLL_TIMEOUT_MS = 15000;
const failure = (reason) => Object.assign(new Error(reason), { reason });
const validCursor = (value) => value === null || (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value));

function cancel(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* No remote diagnostics. */ }
}

/** One bounded, receive-only request. Errors never retain credentials or response text. */
export async function pollInbox(binding, { fetch: request = globalThis.fetch, signal,
  cursor = null, timeoutMs = POLL_TIMEOUT_MS, maxBytes = MAX_POLL_BYTES } = {}) {
  try {
    if (binding?.pollUrl !== POLL_URL) throw failure("invalid_poll_configuration");
    validateBinding(binding);
    if (!validCursor(cursor) || typeof request !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > POLL_TIMEOUT_MS ||
        !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_POLL_BYTES) throw failure("invalid_poll_configuration");
  } catch { throw failure("invalid_poll_configuration"); }
  const controller = new AbortController();
  let reader;
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const abort = (reason) => {
    controller.abort();
    cancel(reader);
    rejectAbort(failure(reason));
  };
  const onAbort = () => abort("poll_aborted");
  const timer = setTimeout(() => abort("poll_timeout"), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  const operation = async () => {
    if (signal?.aborted) throw failure("poll_aborted");
    const url = new URL(binding.pollUrl);
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    const response = await request(url.href, {
      method: "GET", headers: { Authorization: `Bearer ${binding.protocols[1]}`, Accept: "application/json" },
      redirect: "error", cache: "no-store", signal: controller.signal
    });
    if (controller.signal.aborted) { cancel(response.body); throw failure("poll_aborted"); }
    if (response.redirected) { cancel(response.body); throw failure("poll_redirected"); }
    if ([401, 409].includes(response.status)) {
      cancel(response.body);
      return { terminal: response.status };
    }
    if (response.status !== 200) { cancel(response.body); throw failure("poll_http_error"); }
    const length = response.headers?.get("content-length");
    if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      cancel(response.body); throw failure("poll_body_limit");
    }
    if (!response.body || typeof response.body.getReader !== "function") throw failure("poll_invalid_response");
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (controller.signal.aborted) throw failure("poll_aborted");
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw failure("poll_invalid_response");
        bytes += result.value.byteLength;
        if (bytes > maxBytes) { cancel(reader); throw failure("poll_body_limit"); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    let envelope;
    try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw failure("poll_invalid_response"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
        Object.keys(envelope).some((key) => !["events", "nextCursor"].includes(key)) ||
        !Array.isArray(envelope.events) || envelope.events.length > MAX_POLL_EVENTS ||
        (Object.hasOwn(envelope, "nextCursor") && !validCursor(envelope.nextCursor))) {
      throw failure("poll_invalid_response");
    }
    const events = envelope.events.map((frame) => {
      const raw = JSON.stringify(frame);
      if (Buffer.byteLength(raw ?? "", "utf8") > 65536) throw failure("poll_invalid_response");
      const event = parseEvent(raw, binding);
      if (!event) throw failure("poll_invalid_response");
      return event;
    });
    return { events, nextCursor: envelope.nextCursor ?? null };
  };
  try {
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    const reason = ["poll_aborted", "poll_timeout", "poll_redirected", "poll_http_error", "poll_body_limit", "poll_invalid_response"].includes(error?.reason)
      ? error.reason : "poll_request_failed";
    controller.abort();
    cancel(reader);
    throw failure(reason);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
