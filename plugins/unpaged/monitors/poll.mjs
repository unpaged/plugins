// One bounded, receive-only HTTP poll for the Monitor script: Node's fetch
// with a streamed, byte-capped body. The request it makes and the validation
// of what comes back live in poll-core.mjs, shared with the Claude Code mod.
import { failure, isTerminalStatus, MAX_POLL_BYTES, MAX_POLL_EVENTS, parseEnvelope, pollRequest, POLL_TIMEOUT_MS } from "./poll-core.mjs";

export { MAX_POLL_BYTES, MAX_POLL_EVENTS, POLL_TIMEOUT_MS };

function cancel(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* No remote diagnostics. */ }
}

/** One bounded, receive-only request. Errors never retain credentials or response text. */
export async function pollInbox(binding, { fetch: request = globalThis.fetch, signal,
  cursor = null, timeoutMs = POLL_TIMEOUT_MS, maxBytes = MAX_POLL_BYTES } = {}) {
  let target;
  try {
    target = pollRequest(binding, cursor);
    if (typeof request !== "function" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > POLL_TIMEOUT_MS ||
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
    const response = await request(target.url, {
      method: "GET", headers: target.headers,
      redirect: "error", cache: "no-store", signal: controller.signal
    });
    if (controller.signal.aborted) { cancel(response.body); throw failure("poll_aborted"); }
    if (response.redirected) { cancel(response.body); throw failure("poll_redirected"); }
    if (isTerminalStatus(response.status)) {
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
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)); }
    catch { throw failure("poll_invalid_response"); }
    return parseEnvelope(text, binding.documentId);
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
