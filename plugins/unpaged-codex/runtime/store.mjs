import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acceptsPlan, boundedText, pollUrlForLegacyBinding, requireDigest, requireId, requireUuid,
  validTime, validateBinding, validateEvidence, validateRoutingEvent
} from "./protocol.mjs";
import { processIdentity, workerIsAlive } from "./process-identity.mjs";

const now = () => new Date().toISOString();
const EVENT_STATES = ["received", "dispatching", "queued", "processing", "completed", "queue_uncertain", "effect_uncertain"];
// The matched human comment's server timestamp and the local version timestamp
// can differ slightly. Inbox emission time is not the comment creation time.
export const ACCEPTANCE_CLOCK_SKEW_MS = 5000;
const fail = (reason) => { const error = new Error(reason); error.code = reason === "worker_fenced" ? "OWNERSHIP_LOST" : reason.toUpperCase(); throw error; };

export class Store {
  constructor(path) {
    this.path = path;
    this._assertPaths();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this._assertPaths();
    chmodSync(dirname(path), 0o700);
    if (!existsSync(path)) closeSync(openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
    this._assertPaths();
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    try { this._tx(() => {
      const columns = this._all("PRAGMA table_info(bindings)");
      if (columns.length && !columns.some((column) => column.name === "plan_phase")) {
        // Old retained executables do not understand plan phases. A trusted
        // SessionStart can open this store before the skill is read, so enforce
        // the upgrade boundary here, before altering any legacy schema.
        if (this._all("SELECT * FROM bindings").some((binding) =>
          binding.worker_pid && workerIsAlive(binding.worker_pid, binding.worker_identity))) fail("legacy_worker_upgrade_required");
        if (this._get("SELECT name FROM sqlite_master WHERE type='table' AND name='events'") &&
          this._get("SELECT event_id FROM events WHERE state<>'completed' LIMIT 1")) fail("legacy_events_upgrade_required");
      }
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS bindings (
        document_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, key_id TEXT NOT NULL,
        url TEXT, protocols TEXT, poll_url TEXT, last_successful_poll_at TEXT, last_event_at TEXT,
        codex_path TEXT NOT NULL, plan_digest TEXT NOT NULL, plan_version_at TEXT NOT NULL, status_element_ids TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'active', plan_phase TEXT NOT NULL DEFAULT 'proposed', phase_evidence TEXT,
        connection TEXT NOT NULL DEFAULT 'stopped', connection_reason TEXT,
        reconciliation_required INTEGER NOT NULL DEFAULT 0, reconciliation_evidence TEXT,
        worker_pid INTEGER, worker_identity TEXT, worker_token TEXT, worker_started INTEGER NOT NULL DEFAULT 0,
        worker_transport TEXT, worker_transport_token TEXT,
        upgrade_signaled_token TEXT, upgrade_signaled_pid INTEGER, upgrade_signaled_identity TEXT,
        accepted_event_id TEXT, accepted_digest TEXT, accepted_at TEXT,
        revoke_pending INTEGER NOT NULL DEFAULT 0, revocation_evidence TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        document_id TEXT NOT NULL REFERENCES bindings(document_id), event_id TEXT NOT NULL,
        routing TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('received','dispatching','queued','processing','completed','queue_uncertain','effect_uncertain')),
        operation_token TEXT, queue_id TEXT, evidence TEXT, recovery_evidence TEXT,
        received_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(document_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS acceptance_receipts (
        receipt_id INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES bindings(document_id),
        event_id TEXT, plan_digest TEXT NOT NULL, accepted_at TEXT NOT NULL,
        source TEXT NOT NULL, evidence TEXT
      );
      CREATE TABLE IF NOT EXISTS worker_upgrades (
        document_id TEXT PRIMARY KEY REFERENCES bindings(document_id),
        token TEXT NOT NULL, pid INTEGER NOT NULL, identity TEXT NOT NULL, requested_at INTEGER NOT NULL
      );`);
      if (!this._all("PRAGMA table_info(bindings)").some((column) => column.name === "status_element_ids")) {
        this.db.exec("ALTER TABLE bindings ADD COLUMN status_element_ids TEXT NOT NULL DEFAULT '[]'");
      }
      if (!this._all("PRAGMA table_info(bindings)").some((column) => column.name === "plan_version_at")) {
        this.db.exec("ALTER TABLE bindings ADD COLUMN plan_version_at TEXT NOT NULL DEFAULT ''");
        this._run("UPDATE bindings SET plan_version_at=?", now());
      }
      if (!this._all("PRAGMA table_info(bindings)").some((column) => column.name === "worker_identity")) {
        this.db.exec("ALTER TABLE bindings ADD COLUMN worker_identity TEXT");
      }
      if (!this._all("PRAGMA table_info(bindings)").some((column) => column.name === "plan_phase")) {
        this.db.exec("ALTER TABLE bindings ADD COLUMN plan_phase TEXT NOT NULL DEFAULT 'proposed'");
        // Earlier adapters ended the listener at acceptance. Preserve that stop
        // and any pending revocation; an upgrade must never resurrect a key.
        this._run("UPDATE bindings SET plan_phase='accepted',state='stopped' WHERE state='accepted'");
      }
      if (!this._all("PRAGMA table_info(bindings)").some((column) => column.name === "phase_evidence")) {
        this.db.exec("ALTER TABLE bindings ADD COLUMN phase_evidence TEXT");
      }
      // Add fields without changing the legacy state enum or credential shape:
      // queued tasks may still use retained helpers against this same ledger.
      const bindingColumns = new Set(this._all("PRAGMA table_info(bindings)").map((column) => column.name));
      for (const column of ["poll_url", "last_successful_poll_at", "last_event_at", "worker_transport", "worker_transport_token", "upgrade_signaled_token", "upgrade_signaled_identity"]) {
        if (!bindingColumns.has(column)) this.db.exec(`ALTER TABLE bindings ADD COLUMN ${column} TEXT`);
      }
      if (!bindingColumns.has("upgrade_signaled_pid")) this.db.exec("ALTER TABLE bindings ADD COLUMN upgrade_signaled_pid INTEGER");
      for (const binding of this._all("SELECT document_id,url,protocols FROM bindings WHERE poll_url IS NULL")) {
        let protocols;
        try { protocols = JSON.parse(binding.protocols); } catch { continue; }
        const pollUrl = pollUrlForLegacyBinding(binding.url, protocols);
        if (pollUrl) this._run("UPDATE bindings SET poll_url=? WHERE document_id=?", pollUrl, binding.document_id);
      }
      this._run(`INSERT INTO acceptance_receipts(document_id,event_id,plan_digest,accepted_at,source)
        SELECT document_id,accepted_event_id,accepted_digest,accepted_at,'legacy' FROM bindings b
        WHERE accepted_digest IS NOT NULL AND accepted_at IS NOT NULL AND NOT EXISTS
        (SELECT 1 FROM acceptance_receipts r WHERE r.document_id=b.document_id AND r.plan_digest=b.accepted_digest AND r.accepted_at=b.accepted_at)`);
    }); } catch (error) { this.db.close(); throw error; }
  }
  _assertPaths() {
    for (const path of [dirname(this.path), this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      let info;
      try { info = lstatSync(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (info.isSymbolicLink() || (path === dirname(this.path) ? !info.isDirectory() : !info.isFile())) fail("unsafe_store_path");
    }
  }
  _permissions() {
    this._assertPaths();
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) if (existsSync(path)) chmodSync(path, 0o600);
  }
  _get(sql, ...args) { return this.db.prepare(sql).get(...args); }
  _all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  _run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  _tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); this._permissions(); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
  _binding(id) { requireUuid(id); return this._get("SELECT * FROM bindings WHERE document_id=?", id) ?? fail("binding_missing"); }
  _event(id, eventId) {
    requireId(eventId);
    return this._get("SELECT * FROM events WHERE document_id=? AND event_id=?", id, eventId) ?? fail("event_missing");
  }
  _fence(id, token) {
    const binding = this._binding(id);
    if (typeof token !== "string" || token !== binding.worker_token) fail("worker_fenced");
    return binding;
  }
  _active(binding) { if (binding.state !== "active") fail("review_inactive"); }
  _ready(binding) { this._active(binding); if (binding.reconciliation_required) fail("reconciliation_required"); }
  _idle(id, binding) {
    this._ready(binding);
    if (this._get("SELECT event_id FROM events WHERE document_id=? AND state<>'completed' LIMIT 1", id)) fail("outstanding_events");
  }
  _eventView(row) {
    if (!EVENT_STATES.includes(row.state)) fail("unknown_event_state");
    return { ...JSON.parse(row.routing), state: row.state, queueId: row.queue_id,
      evidence: row.evidence ? JSON.parse(row.evidence) : null,
      recoveryEvidence: row.recovery_evidence ? JSON.parse(row.recovery_evidence) : [], receivedAt: row.received_at, updatedAt: row.updated_at };
  }
  _outstanding(id, except = "") {
    return this._get("SELECT event_id FROM events WHERE document_id=? AND event_id<>? AND state NOT IN ('received','completed') LIMIT 1", id, except);
  }
  _processing(id, eventId, token) {
    const event = this._event(id, eventId);
    if (event.state !== "processing" || typeof token !== "string" || event.operation_token !== token) fail("operation_fenced");
    return event;
  }
  bind(input) {
    const binding = validateBinding(input);
    return this._tx(() => {
      const old = this._get("SELECT * FROM bindings WHERE document_id=?", binding.documentId);
      if (old) {
        if (old.thread_id !== binding.threadId || old.key_id !== binding.keyId || old.codex_path !== binding.codexPath ||
          old.protocols !== JSON.stringify(binding.protocols) || old.url !== binding.url ||
          (old.poll_url ?? pollUrlForLegacyBinding(old.url, JSON.parse(old.protocols))) !== binding.pollUrl ||
          old.status_element_ids !== JSON.stringify(binding.statusElementIds)) fail("rebind_refused");
        return this.getBinding(binding.documentId);
      }
      this._run("INSERT INTO bindings(document_id,thread_id,key_id,url,protocols,poll_url,codex_path,plan_digest,plan_version_at,status_element_ids,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        binding.documentId, binding.threadId, binding.keyId, binding.url, JSON.stringify(binding.protocols), binding.pollUrl, binding.codexPath, binding.planDigest, now(), JSON.stringify(binding.statusElementIds), now());
      return this.getBinding(binding.documentId);
    });
  }
  getBinding(id, { includeSecrets = false } = {}) {
    const b = this._binding(id);
    if (!["active", "stopped"].includes(b.state)) fail("unknown_binding_state");
    if (!["proposed", "accepted", "executing", "built"].includes(b.plan_phase)) fail("unknown_plan_phase");
    if (!validTime(b.plan_version_at)) fail("invalid_plan_version_time");
    const counts = Object.fromEntries(EVENT_STATES.map((state) => [state, 0]));
    for (const row of this._all("SELECT state,COUNT(*) AS count FROM events WHERE document_id=? GROUP BY state", id)) {
      if (!EVENT_STATES.includes(row.state)) fail("unknown_event_state"); counts[row.state] = row.count;
    }
    if (!["connecting", "connected", "reconnecting", "stopped"].includes(b.connection)) fail("unknown_connection_state");
    const result = { documentId: id, threadId: b.thread_id, keyId: b.key_id, codexPath: b.codex_path,
      pollUrl: b.poll_url ?? pollUrlForLegacyBinding(b.url, b.protocols ? JSON.parse(b.protocols) : null),
      lastSuccessfulPollAt: b.last_successful_poll_at, lastEventAt: b.last_event_at,
      workerTransport: b.worker_token && b.worker_transport_token === b.worker_token ? b.worker_transport : null,
      upgradePending: Boolean(this._get("SELECT document_id FROM worker_upgrades WHERE document_id=?", id)),
      planDigest: b.plan_digest, planVersionAt: b.plan_version_at, statusElementIds: JSON.parse(b.status_element_ids), status: b.state, connectionState: b.connection, connectionReason: b.connection_reason,
      reconciliationRequired: Boolean(b.reconciliation_required), workerPid: b.worker_pid, workerIdentity: b.worker_identity,
      acceptedEventId: b.accepted_event_id, acceptedDigest: b.accepted_digest, acceptedAt: b.accepted_at,
      planPhase: b.plan_phase, phaseEvidence: b.phase_evidence ? JSON.parse(b.phase_evidence) : [],
      acceptanceReceipts: this._all("SELECT event_id AS eventId,plan_digest AS planDigest,accepted_at AS acceptedAt,source,evidence FROM acceptance_receipts WHERE document_id=? ORDER BY receipt_id", id),
      cleanupRequired: Boolean(b.revoke_pending), credentialsPresent: b.protocols !== null, eventCounts: counts, updatedAt: b.updated_at };
    if (includeSecrets) Object.assign(result, { url: b.url, protocols: b.protocols ? JSON.parse(b.protocols) : null, workerToken: b.worker_token });
    return result;
  }
  listBindings() { return this._all("SELECT document_id FROM bindings ORDER BY document_id").map((row) => this.getBinding(row.document_id)); }
  listEvents(id) { this._binding(id); return this._all("SELECT * FROM events WHERE document_id=? ORDER BY rowid", id).map((row) => this._eventView(row)); }
  claimUpgrade(id, { pid, identity = processIdentity(pid), isAlive: alive = workerIsAlive, at = Date.now() } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("invalid_pid");
    if (typeof identity !== "string" || !identity || identity.length > 1000) fail("invalid_worker_identity");
    if (!Number.isSafeInteger(at) || at < 0) fail("invalid_upgrade_time");
    if (typeof alive !== "function") fail("invalid_worker_probe");
    return this._tx(() => {
      this._active(this._binding(id));
      const old = this._get("SELECT * FROM worker_upgrades WHERE document_id=?", id);
      // This grace limits coordination retries. The separate signal reservation
      // survives lease takeover so expiry never permits a second SIGTERM.
      if (old && (alive(old.pid, old.identity) || at - old.requested_at < 60_000)) return null;
      const token = randomUUID();
      this._run("INSERT INTO worker_upgrades(document_id,token,pid,identity,requested_at) VALUES(?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET token=excluded.token,pid=excluded.pid,identity=excluded.identity,requested_at=excluded.requested_at", id, token, pid, identity, at);
      return token;
    });
  }
  releaseUpgrade(id, token) {
    requireUuid(id);
    if (typeof token !== "string" || !token) fail("invalid_upgrade_token");
    return this._tx(() => this._run("DELETE FROM worker_upgrades WHERE document_id=? AND token=?", id, token).changes === 1);
  }
  claimUpgradeSignal(id, leaseToken, { workerToken, pid, identity } = {}) {
    if (typeof leaseToken !== "string" || !leaseToken) fail("invalid_upgrade_token");
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("invalid_pid");
    if (typeof identity !== "string" || !identity || identity.length > 1000) fail("invalid_worker_identity");
    return this._tx(() => {
      const b = this._fence(id, workerToken); this._active(b);
      if (this._get("SELECT token FROM worker_upgrades WHERE document_id=?", id)?.token !== leaseToken) fail("upgrade_fenced");
      if (b.worker_pid !== pid || b.worker_identity !== identity) fail("worker_fenced");
      if (b.upgrade_signaled_token === workerToken && b.upgrade_signaled_pid === pid && b.upgrade_signaled_identity === identity) return false;
      // Commit intent before the OS signal. A crash between these two actions
      // must leave handover pending, not risk replaying a once-only signal.
      this._run("UPDATE bindings SET upgrade_signaled_token=?,upgrade_signaled_pid=?,upgrade_signaled_identity=? WHERE document_id=?", workerToken, pid, identity, id);
      return true;
    });
  }
  claimWorker(id, { pid, identity = processIdentity(pid), isAlive: alive, transport } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("invalid_pid");
    if (identity !== null && identity !== undefined && (typeof identity !== "string" || !identity || identity.length > 1000)) fail("invalid_worker_identity");
    if (!alive && !identity) fail("worker_identity_unavailable");
    if (transport !== undefined && transport !== "poll-v1") fail("invalid_worker_transport");
    return this._tx(() => {
      const b = this._binding(id); this._active(b);
      if (!b.protocols) fail("credentials_missing");
      if (b.worker_pid && (alive ? alive(b.worker_pid, b.worker_identity) : workerIsAlive(b.worker_pid, b.worker_identity))) fail("worker_alive");
      const recovered = Boolean(b.worker_started);
      if (recovered) {
        this._run("UPDATE events SET state='queue_uncertain',updated_at=? WHERE document_id=? AND state='dispatching'", now(), id);
        this._run("UPDATE events SET state='effect_uncertain',updated_at=? WHERE document_id=? AND state='processing'", now(), id);
      }
      const token = randomUUID();
      this._run("UPDATE bindings SET worker_pid=?,worker_identity=?,worker_token=?,worker_transport=?,worker_transport_token=?,upgrade_signaled_token=NULL,upgrade_signaled_pid=NULL,upgrade_signaled_identity=NULL,worker_started=1,reconciliation_required=CASE WHEN worker_started=1 THEN 1 ELSE reconciliation_required END,connection='connecting',updated_at=? WHERE document_id=?", pid, identity ?? null, token, transport ?? null, transport ? token : null, now(), id);
      this._run("DELETE FROM worker_upgrades WHERE document_id=?", id);
      return { token, recovered };
    });
  }
  releaseWorker(id, token) { return this._tx(() => { this._fence(id, token); this._run("UPDATE bindings SET worker_pid=NULL,worker_identity=NULL,worker_token=NULL,connection='stopped',updated_at=? WHERE document_id=?", now(), id); }); }
  setConnection(id, token, state, reason = null) {
    if (!["connecting", "connected", "reconnecting", "stopped"].includes(state)) fail("invalid_connection_state");
    if (reason !== null) boundedText(reason, 200);
    return this._tx(() => {
      this._fence(id, token);
      const terminal = state === "stopped" && ["terminal_close_4401", "terminal_close_4409", "terminal_close_1003", "terminal_http_401", "terminal_http_409"].includes(reason);
      this._run("UPDATE bindings SET connection=?,connection_reason=?,state=CASE WHEN ? THEN 'stopped' ELSE state END,revoke_pending=CASE WHEN ? AND protocols IS NOT NULL THEN 1 ELSE revoke_pending END,updated_at=? WHERE document_id=?", state, reason, Number(terminal), Number(terminal), now(), id);
    });
  }
  recordPollSuccess(id, token, { at, newEvents } = {}) {
    if (!validTime(at)) fail("invalid_poll_time");
    if (typeof newEvents !== "boolean") fail("invalid_poll_activity");
    return this._tx(() => {
      this._active(this._fence(id, token));
      // Successful reads do not prove that an earlier gap was reconciled, and
      // empty/replayed batches do not fabricate new human activity.
      this._run("UPDATE bindings SET connection='connected',connection_reason=NULL,last_successful_poll_at=?,last_event_at=CASE WHEN ? THEN ? ELSE last_event_at END,updated_at=? WHERE document_id=?", at, Number(newEvents), at, now(), id);
      return this.getBinding(id);
    });
  }
  markReconciliationRequired(id, token, reason) {
    boundedText(reason, 200);
    return this._tx(() => { this._fence(id, token); this._run("UPDATE bindings SET reconciliation_required=1,reconciliation_evidence=NULL,connection_reason=?,updated_at=? WHERE document_id=?", reason, now(), id); });
  }
  reconcile(id, { evidence, token } = {}) {
    boundedText(evidence);
    return this._tx(() => {
      const b = token === undefined ? this._binding(id) : this._fence(id, token); this._active(b);
      this._run("UPDATE bindings SET reconciliation_required=0,reconciliation_evidence=?,updated_at=? WHERE document_id=?", evidence, now(), id);
      return this.getBinding(id);
    });
  }
  receive(id, raw, token) {
    const event = validateRoutingEvent(raw, id);
    return this._tx(() => {
      this._active(this._fence(id, token));
      const result = this._run("INSERT OR IGNORE INTO events(document_id,event_id,routing,state,received_at,updated_at) VALUES(?,?,?,'received',?,?)", id, event.id, JSON.stringify(event), now(), now());
      return { inserted: result.changes === 1, event: this._eventView(this._event(id, event.id)) };
    });
  }
  nextEvent(id, token) {
    const b = this._fence(id, token);
    if (b.state !== "active" || this._outstanding(id)) return null;
    const row = this._get("SELECT * FROM events WHERE document_id=? AND state='received' ORDER BY rowid LIMIT 1", id);
    return row ? this._eventView(row) : null;
  }
  markDispatching(id, eventId, token) {
    return this._tx(() => {
      this._active(this._fence(id, token));
      const next = this.nextEvent(id, token);
      if (!next || next.id !== eventId) fail("event_not_dispatchable");
      this._run("UPDATE events SET state='dispatching',updated_at=? WHERE document_id=? AND event_id=?", now(), id, eventId);
    });
  }
  markQueued(id, eventId, token, queueId) {
    requireUuid(queueId);
    return this._tx(() => {
      this._fence(id, token); const event = this._event(id, eventId);
      if (!["dispatching", "queue_uncertain", "queued", "processing", "completed", "effect_uncertain"].includes(event.state)) fail("event_not_dispatched");
      if (event.queue_id && event.queue_id !== queueId) fail("queue_id_conflict");
      const state = ["dispatching", "queue_uncertain"].includes(event.state) ? "queued" : event.state;
      this._run("UPDATE events SET state=?,queue_id=?,updated_at=? WHERE document_id=? AND event_id=?", state, queueId, now(), id, eventId);
    });
  }
  markQueueUncertain(id, eventId, token) {
    return this._tx(() => {
      this._fence(id, token); const event = this._event(id, eventId);
      if (event.state === "dispatching") this._run("UPDATE events SET state='queue_uncertain',updated_at=? WHERE document_id=? AND event_id=?", now(), id, eventId);
      else if (!["queue_uncertain", "queued", "processing", "completed", "effect_uncertain"].includes(event.state)) fail("event_not_dispatched");
    });
  }
  begin(id, eventId, { expectedThreadId } = {}) {
    return this._tx(() => {
      const b = this._binding(id); requireUuid(expectedThreadId);
      if (expectedThreadId !== b.thread_id) fail("wrong_task");
      this._active(b);
      const event = this._event(id, eventId);
      if (!["queued", "dispatching", "queue_uncertain"].includes(event.state) || this._outstanding(id, eventId)) fail("event_not_beginable");
      const operationToken = event.operation_token ?? randomUUID();
      this._run("UPDATE events SET state='processing',operation_token=?,updated_at=? WHERE document_id=? AND event_id=?", operationToken, now(), id, eventId);
      return { operationToken, event: this._eventView(this._event(id, eventId)), reconciliationRequired: Boolean(b.reconciliation_required) };
    });
  }
  _complete(id, eventId, evidence) {
    const b = this._binding(id);
    if (evidence.planDigest) {
      // Acceptance's own reply must attest exactly the accepted version, even
      // after an interrupted turn. Later execution records have a separate
      // current digest and never rewrite the immutable acceptance receipt.
      if (b.accepted_event_id === eventId && evidence.planDigest !== b.accepted_digest) fail("accepted_plan_changed");
      this._run("UPDATE bindings SET plan_digest=?,plan_version_at=CASE WHEN plan_digest<>? THEN ? ELSE plan_version_at END,plan_phase=CASE WHEN plan_phase='accepted' AND plan_digest<>? THEN 'proposed' ELSE plan_phase END,updated_at=? WHERE document_id=?", evidence.planDigest, evidence.planDigest, now(), evidence.planDigest, now(), id);
    }
    this._run("UPDATE events SET state='completed',evidence=?,updated_at=? WHERE document_id=? AND event_id=?", JSON.stringify(evidence), now(), id, eventId);
    return this._eventView(this._event(id, eventId));
  }
  complete(id, eventId, { operationToken, evidence, planDigest } = {}) {
    const proof = validateEvidence(evidence);
    if (planDigest !== undefined && planDigest !== proof.planDigest) fail("digest_mismatch");
    return this._tx(() => { this._processing(id, eventId, operationToken); return this._complete(id, eventId, proof); });
  }
  accept(id, eventId, { operationToken, humanText, humanCreatedAt, currentDigest, submittedPlanDigest } = {}) {
    requireDigest(currentDigest); requireDigest(submittedPlanDigest);
    if (!validTime(humanCreatedAt)) fail("invalid_acceptance_time");
    if (Date.parse(humanCreatedAt) > Date.now() + ACCEPTANCE_CLOCK_SKEW_MS) fail("acceptance_time_in_future");
    return this._tx(() => {
      const b = this._binding(id); this._ready(b);
      if (b.plan_phase !== "proposed") fail("plan_already_approved");
      const event = this._processing(id, eventId, operationToken);
      const routing = JSON.parse(event.routing);
      if (routing.authorRole !== "owner") fail("owner_acceptance_required");
      // Receipt and version timestamps share this local clock. A later plan
      // change invalidates queued acceptance without any server-skew allowance.
      // The routing timestamp is inbox emission, so delayed triggers also need
      // the actual matched human message creation time read through MCP.
      if (!validTime(b.plan_version_at) || !validTime(event.received_at) ||
        Date.parse(event.received_at) < Date.parse(b.plan_version_at) ||
        Date.parse(humanCreatedAt) < Date.parse(b.plan_version_at) - ACCEPTANCE_CLOCK_SKEW_MS) fail("acceptance_predates_plan_version");
      if (this._get("SELECT event_id FROM events WHERE document_id=? AND event_id<>? AND state<>'completed' LIMIT 1", id, eventId)) fail("outstanding_events");
      if (currentDigest !== submittedPlanDigest || currentDigest !== b.plan_digest) fail("digest_mismatch");
      if (!acceptsPlan(humanText, currentDigest)) fail("explicit_acceptance_required");
      const at = now();
      this._run("UPDATE bindings SET plan_phase='accepted',accepted_event_id=?,accepted_digest=?,accepted_at=?,updated_at=? WHERE document_id=?", eventId, currentDigest, at, at, id);
      this._run("INSERT INTO acceptance_receipts(document_id,event_id,plan_digest,accepted_at,source) VALUES(?,?,?,?,?)", id, eventId, currentDigest, at, "board-owner");
      return this.getBinding(id);
    });
  }
  // These transitions record decisions from the person in the assigned Codex
  // task. Board-event processing cannot use them: all events must be completed.
  // The caller must verify task-user authorization; evidence is an audit record,
  // not a parser that turns collaborator prose into permission to run code.
  transition(id, command, { evidence, currentDigest, recordNodeId, openTasks } = {}) {
    boundedText(evidence); requireDigest(currentDigest);
    if (!["submit", "approve", "execute", "checkpoint", "built"].includes(command)) fail("invalid_phase_transition");
    if (command === "built") {
      requireUuid(recordNodeId);
      if (openTasks !== 0) fail("open_plan_tasks");
    }
    return this._tx(() => {
      const b = this._binding(id); this._idle(id, b);
      const phase = b.plan_phase;
      if (command === "submit" && !["proposed", "accepted"].includes(phase)) fail("implementation_already_started");
      if (command === "approve" && phase !== "proposed") fail("plan_already_approved");
      if (command === "execute" && phase !== "accepted") fail("plan_acceptance_required");
      if (command === "checkpoint" && !["executing", "built"].includes(phase)) fail("implementation_not_started");
      if (command === "built" && phase !== "executing") fail("implementation_not_started");
      if (["approve", "execute"].includes(command) && currentDigest !== b.plan_digest) fail("digest_mismatch");
      if (command === "execute" && currentDigest !== b.accepted_digest) fail("accepted_plan_changed");
      const next = { submit: "proposed", approve: "accepted", execute: "executing", checkpoint: phase, built: "built" }[command];
      const history = b.phase_evidence ? JSON.parse(b.phase_evidence) : [];
      if (!Array.isArray(history)) fail("invalid_phase_history");
      const at = now();
      history.push({ command, phase: next, evidence, planDigest: currentDigest, at,
        ...(command === "built" ? { recordNodeId, openTasks } : {}) });
      this._run("UPDATE bindings SET plan_phase=?,phase_evidence=?,plan_digest=?,plan_version_at=CASE WHEN plan_digest<>? THEN ? ELSE plan_version_at END,updated_at=? WHERE document_id=?",
        next, JSON.stringify(history), currentDigest, currentDigest, at, at, id);
      // A deliberate resubmission requires fresh acceptance even when the
      // content hash is unchanged; earlier queued approval cannot count again.
      if (command === "submit") this._run("UPDATE bindings SET plan_version_at=? WHERE document_id=?", at, id);
      if (command === "approve") {
        this._run("UPDATE bindings SET accepted_event_id=NULL,accepted_digest=?,accepted_at=? WHERE document_id=?", currentDigest, at, id);
        this._run("INSERT INTO acceptance_receipts(document_id,plan_digest,accepted_at,source,evidence) VALUES(?,?,?,?,?)", id, currentDigest, at, "task-user", evidence);
      }
      return this.getBinding(id);
    });
  }
  recover(id, eventId, { decision, evidence } = {}) {
    return this._tx(() => {
      const event = this._event(id, eventId);
      const record = (proof) => {
        const history = event.recovery_evidence ? JSON.parse(event.recovery_evidence) : [];
        if (!Array.isArray(history)) fail("invalid_recovery_history");
        history.push({ decision, evidence: proof, at: now() });
        this._run("UPDATE events SET recovery_evidence=? WHERE document_id=? AND event_id=?", JSON.stringify(history), id, eventId);
      };
      if (decision === "retry" && event.state === "queue_uncertain") {
        this._active(this._binding(id)); boundedText(evidence);
        record(evidence);
        this._run("UPDATE events SET state='received',operation_token=NULL,queue_id=NULL,updated_at=? WHERE document_id=? AND event_id=?", now(), id, eventId);
        return this._eventView(this._event(id, eventId));
      }
      if (decision === "interrupt" && event.state === "processing") {
        boundedText(evidence); record(evidence);
        this._run("UPDATE events SET state='effect_uncertain',updated_at=? WHERE document_id=? AND event_id=?", now(), id, eventId);
        return this._eventView(this._event(id, eventId));
      }
      if (decision === "continue" && event.state === "effect_uncertain") {
        const b = this._binding(id);
        if (b.state !== "active" || this._outstanding(id, eventId)) fail("review_inactive");
        boundedText(evidence); record(evidence);
        const operationToken = randomUUID();
        this._run("UPDATE events SET state='processing',operation_token=?,updated_at=? WHERE document_id=? AND event_id=?", operationToken, now(), id, eventId);
        return { operationToken, event: this._eventView(this._event(id, eventId)), reconciliationRequired: Boolean(b.reconciliation_required) };
      }
      if (decision === "complete" && event.state === "effect_uncertain") {
        const proof = validateEvidence(evidence); record(proof); return this._complete(id, eventId, proof);
      }
      fail("invalid_recovery_decision");
    });
  }
  requestStop(id) {
    return this._tx(() => {
      this._binding(id);
      this._run("UPDATE bindings SET state='stopped',revoke_pending=CASE WHEN protocols IS NULL THEN 0 ELSE 1 END,updated_at=? WHERE document_id=?", now(), id);
      return this.getBinding(id);
    });
  }
  confirmRevoked(id, { keyId, evidence } = {}) {
    requireId(keyId); boundedText(evidence);
    return this._tx(() => {
      const b = this._binding(id);
      if (keyId !== b.key_id || b.state === "active") fail("revocation_confirmation_refused");
      this._run("UPDATE bindings SET protocols=NULL,url=NULL,poll_url=NULL,revoke_pending=0,revocation_evidence=?,updated_at=? WHERE document_id=?", evidence, now(), id);
      return this.getBinding(id);
    });
  }
  close() { this.db.close(); }
}
