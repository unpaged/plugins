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
  let signalRecorded = false;
  let predecessor;
  try {
    while (!signal?.aborted && now() < deadline) {
      const binding = store.getBinding(documentId, { includeSecrets: true });
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
        predecessor = { pid: binding.workerPid, identity: binding.workerIdentity, workerToken: binding.workerToken };
        // Re-read both the private claim and kernel birth identity immediately
        // before signalling; a recycled PID or a replacement is never killed.
        const current = store.getBinding(documentId, { includeSecrets: true });
        if (current.workerPid !== predecessor.pid || current.workerIdentity !== predecessor.identity ||
            current.workerToken !== predecessor.workerToken ||
            current.workerTransport === "poll-v1" || current.status !== "active") return false;
        if (identify(predecessor.pid) !== predecessor.identity) {
          store.releaseUpgrade(documentId, lease);
          lease = undefined;
          await sleep(100);
          continue;
        }
        const shouldSignal = store.claimUpgradeSignal(documentId, lease, predecessor);
        signalRecorded = true;
        if (shouldSignal) {
          // SQLite may have waited for another writer. Check the kernel again
          // before kill, but undo only this call's provably unsent reservation
          // if inspection failed or the PID changed during that transaction.
          if (identify(predecessor.pid) !== predecessor.identity) {
            store.cancelUnsentUpgradeSignal(documentId, lease, predecessor);
            signalRecorded = false;
            store.releaseUpgrade(documentId, lease);
            lease = undefined;
            await sleep(100);
            continue;
          }
          try { kill(predecessor.pid, "SIGTERM"); }
          catch (error) { if (error.code !== "ESRCH") throw new Error("worker_handover_unavailable"); }
        }
      }
      // Do not send SIGTERM twice: old runtimes use a once-only handler, and a
      // second signal could cut off their pending queue receipt.
      if (!alive(predecessor.pid, predecessor.identity)) return true;
      await sleep(100);
    }
    return false;
  } finally {
    // A later coordinator may reclaim this lease, but the signal reservation
    // remains on the exact worker claim until a new worker can safely take over.
    if (lease && (!signalRecorded || !alive(predecessor.pid, predecessor.identity))) {
      store.releaseUpgrade(documentId, lease);
    }
  }
}
