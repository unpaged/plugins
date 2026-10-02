// The receive loop shared by both hosts of a board's listener: the Monitor
// script (listen.mjs — Node's fetch, stdout) and the Claude Code mod (the
// host's fetch, a toast and a prompt). Node-free on purpose: no node:
// imports, no timers, no process — every boundary comes in through options,
// so the cadence, the HTTP rules and the dedupe are one tested body of code.
import { closePolicy, PROTOCOL_PREAMBLE, rejectedKeyLine } from "./listen-core.mjs";
import { POLL_TIMEOUT_MS } from "./poll-core.mjs";

export const DEDUPE_LIMIT = 4096;
export const LOCAL_SUPERSEDED = "local-superseded";

function duration(value, fallback, maximum) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > maximum) throw new Error("listener_configuration_invalid");
  return result;
}

/**
 * Polls one board until the signal aborts or the server ends the key.
 *
 * Required boundaries: `poll(config, { signal, cursor, timeoutMs })` resolves
 * `{ events, nextCursor }` or `{ terminal: 401 | 409 }` and rejects on any
 * retryable failure; `sleep(ms, signal)` resolves after `ms` or on abort;
 * `say(line)` delivers one line (the preamble once, then one JSON event per
 * line). Optional: `now()`, `reportStatus(state, reason, metadata)`,
 * `retireKey()` for HTTP 401, `signal`, and the cadence overrides.
 */
export async function runListener(config, options = {}) {
  const { poll, sleep, say } = options;
  if (typeof poll !== "function" || typeof sleep !== "function" || typeof say !== "function") {
    throw new Error("listener_configuration_invalid");
  }
  const intervalMs = duration(options.pollIntervalMs, 30000, 60000);
  const idleIntervalMs = duration(options.idlePollIntervalMs, 60000, 60000);
  const idleAfterMs = duration(options.idleAfterMs, 3600000, 3600000);
  const retryBaseMs = duration(options.retryBaseMs, 30000, 60000);
  const maxRetryMs = duration(options.maxRetryMs, 60000, 60000);
  const timeoutMs = duration(options.requestTimeoutMs, POLL_TIMEOUT_MS, POLL_TIMEOUT_MS);
  const dedupeLimit = duration(options.dedupeLimit, DEDUPE_LIMIT, DEDUPE_LIMIT);
  const now = options.now ?? Date.now;
  const report = options.reportStatus ?? (async () => {});
  const retireKey = options.retireKey ?? (async () => "absent");
  const signal = options.signal;
  const seen = new Set();
  let lastEventAt = now();
  let lastSuccessfulPollAt = null;
  let attempt = 0;
  let cursor = null;
  let preambleSent = false;
  const interval = () => now() - lastEventAt >= idleAfterMs ? idleIntervalMs : intervalMs;
  const reportStatus = async (state, reason) => {
    if (!signal?.aborted) await report(state, reason, { lastSuccessfulPollAt });
  };
  const finish = async () => {
    const reason = signal?.reason === LOCAL_SUPERSEDED ? LOCAL_SUPERSEDED : "shutdown";
    await report("stopped", reason, { lastSuccessfulPollAt });
    if (reason === LOCAL_SUPERSEDED) {
      await say("Another local Monitor requested this canvas's Unpaged listener, so this session stops listening. Leave the stored key in place; do not mint another key. Use /unpaged:listen status to check the replacement.");
    }
    return { reason };
  };
  if (signal?.aborted) return signal.reason === LOCAL_SUPERSEDED ? finish() : { reason: "shutdown" };
  await reportStatus("connecting");
  while (!signal?.aborted) {
    let result;
    try {
      result = await poll(config, { signal, cursor, timeoutMs });
    } catch {
      if (signal?.aborted) break;
      await reportStatus("reconnecting", "poll-failed");
      await sleep(Math.min(maxRetryMs, Math.max(interval(), retryBaseMs * 2 ** Math.min(attempt++, 16))), signal);
      continue;
    }
    if (signal?.aborted) break;
    if (result.terminal) {
      const policy = closePolicy(result.terminal, config.documentId);
      let line = policy.line;
      if (policy.deleteKeyFile) {
        const outcome = await retireKey();
        line = rejectedKeyLine(outcome, config.documentId);
      }
      if (signal?.aborted) break;
      // A newer key's monitor owns this board's status. HTTP 409 never retires
      // credentials or writes a terminal status over that monitor.
      if (!policy.superseded) await reportStatus("stopped", `http-${result.terminal}`);
      if (!signal?.aborted && line) await say(line);
      return { reason: `http-${result.terminal}` };
    }
    lastSuccessfulPollAt = new Date(now()).toISOString();
    await reportStatus("connected");
    if (signal?.aborted) break;
    for (const event of result.events) {
      if (signal?.aborted) break;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (seen.size > dedupeLimit) seen.delete(seen.values().next().value);
      lastEventAt = now();
      if (!preambleSent) { preambleSent = true; await say(PROTOCOL_PREAMBLE); }
      if (!signal?.aborted) await say(JSON.stringify(event));
    }
    cursor = result.nextCursor;
    attempt = 0;
    await sleep(interval(), signal);
  }
  // The local ownership gate remains held until the final status and any
  // supersession notice drain. Ordinary external shutdown stays silent.
  return finish();
}
