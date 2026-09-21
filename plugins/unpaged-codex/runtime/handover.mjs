import { processIdentity, workerIsAlive } from "./process-identity.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs inside the new detached receiver, not the 30-second SessionStart hook.
// The predecessor may need 45 seconds to record an in-flight queue outcome.
export async function prepareHandover(documentId, options) {
  const { store, signal } = options;
  const pid = options.pid ?? process.pid;
  const identify = options.identify ?? processIdentity;
  const alive = options.isAlive ?? ((id, identity) => workerIsAlive(id, identity, identify));
  const kill = options.kill ?? process.kill;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 150000);
  let lease;
  let signaled = false;
  let predecessor;
  try {
    while (!signal?.aborted && now() < deadline) {
      const binding = store.getBinding(documentId);
      if (binding.status !== "active") return false;
      if (!alive(binding.workerPid, binding.workerIdentity)) return true;
      // Any already-running polling receiver keeps ownership. A runtime update
      // must not restart it merely because its retained content hash changed.
      if (binding.workerTransport === "poll-v1") return false;
      if (typeof binding.workerIdentity !== "string" ||
          identify(binding.workerPid) !== binding.workerIdentity) {
        throw new Error("worker_identity_unverifiable");
      }
      if (!lease) {
        const identity = identify(pid);
        if (typeof identity !== "string") throw new Error("worker_identity_unverifiable");
        lease = store.claimUpgrade(documentId, { pid, identity, isAlive: alive, at: now() });
        if (!lease) { await sleep(250); continue; }
        predecessor = { pid: binding.workerPid, identity: binding.workerIdentity };
        // Re-read both the private claim and kernel birth identity immediately
        // before signalling; a recycled PID or a replacement is never killed.
        const current = store.getBinding(documentId);
        if (current.workerPid !== predecessor.pid || current.workerIdentity !== predecessor.identity ||
            current.workerTransport === "poll-v1" || current.status !== "active") return false;
        if (identify(predecessor.pid) !== predecessor.identity) continue;
        try { kill(predecessor.pid, "SIGTERM"); signaled = true; }
        catch (error) { if (error.code !== "ESRCH") throw new Error("worker_handover_unavailable"); }
      }
      // Do not send SIGTERM twice: old runtimes use a once-only handler, and a
      // second signal could cut off their pending queue receipt.
      if (!alive(predecessor.pid, predecessor.identity)) return true;
      await sleep(100);
    }
    return false;
  } finally {
    // A crash/abort after the signal leaves a short durable grace period. A
    // later receiver waits for the predecessor instead of signalling it again.
    if (lease && (!signaled || !alive(predecessor.pid, predecessor.identity))) {
      store.releaseUpgrade(documentId, lease);
    }
  }
}
