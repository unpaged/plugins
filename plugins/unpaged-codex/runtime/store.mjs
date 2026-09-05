import { DatabaseSync } from "node:sqlite";
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acceptsPlan, boundedText, requireDigest, requireId, requireUuid,
  validTime, validateBinding, validateEvidence, validateRoutingEvent
} from "./protocol.mjs";
import { processIdentity, workerIsAlive } from "./process-identity.mjs";

const now = () => new Date().toISOString();
const EVENT_STATES = ["received", "dispatching", "queued", "processing", "completed", "queue_uncertain", "effect_uncertain"];
// Server-authored comment timestamps and local version timestamps can differ
// slightly. Older feedback remains stale beyond this explicit bounded allowance.
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
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bindings (
        document_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, key_id TEXT NOT NULL,
        url TEXT, protocols TEXT, codex_path TEXT NOT NULL, plan_digest TEXT NOT NULL, plan_version_at TEXT NOT NULL, status_element_ids TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'active', connection TEXT NOT NULL DEFAULT 'stopped', connection_reason TEXT,
        reconciliation_required INTEGER NOT NULL DEFAULT 0, reconciliation_evidence TEXT,
        worker_pid INTEGER, worker_identity TEXT, worker_token TEXT, worker_started INTEGER NOT NULL DEFAULT 0,
        accepted_event_id TEXT, accepted_digest TEXT, accepted_at TEXT,
        revoke_pending INTEGER NOT NULL DEFAULT 0, revocation_evidence TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        document_id TEXT NOT NULL REFERENCES bindings(document_id), event_id TEXT NOT NULL,
        routing TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('received','dispatching','queued','processing','completed','queue_uncertain','effect_uncertain')),
        operation_token TEXT, queue_id TEXT, evidence TEXT, recovery_evidence TEXT,
        received_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(document_id,event_id)
      );`);
    this._tx(() => {
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
    });
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
          old.status_element_ids !== JSON.stringify(binding.statusElementIds)) fail("rebind_refused");
        return this.getBinding(binding.documentId);
      }
      this._run("INSERT INTO bindings(document_id,thread_id,key_id,url,protocols,codex_path,plan_digest,plan_version_at,status_element_ids,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        binding.documentId, binding.threadId, binding.keyId, binding.url, JSON.stringify(binding.protocols), binding.codexPath, binding.planDigest, now(), JSON.stringify(binding.statusElementIds), now());
      return this.getBinding(binding.documentId);
    });
  }
  getBinding(id, { includeSecrets = false } = {}) {
    const b = this._binding(id);
    if (!["active", "accepted", "stopped"].includes(b.state)) fail("unknown_binding_state");
    if (!validTime(b.plan_version_at)) fail("invalid_plan_version_time");
    const counts = Object.fromEntries(EVENT_STATES.map((state) => [state, 0]));
    for (const row of this._all("SELECT state,COUNT(*) AS count FROM events WHERE document_id=? GROUP BY state", id)) {
      if (!EVENT_STATES.includes(row.state)) fail("unknown_event_state"); counts[row.state] = row.count;
    }
    if (!["connecting", "connected", "reconnecting", "stopped"].includes(b.connection)) fail("unknown_connection_state");
    const result = { documentId: id, threadId: b.thread_id, keyId: b.key_id, codexPath: b.codex_path,
      planDigest: b.plan_digest, planVersionAt: b.plan_version_at, statusElementIds: JSON.parse(b.status_element_ids), status: b.state, connectionState: b.connection, connectionReason: b.connection_reason,
      reconciliationRequired: Boolean(b.reconciliation_required), workerPid: b.worker_pid, workerIdentity: b.worker_identity,
      acceptedEventId: b.accepted_event_id, acceptedDigest: b.accepted_digest, acceptedAt: b.accepted_at,
      cleanupRequired: Boolean(b.revoke_pending), credentialsPresent: b.protocols !== null, eventCounts: counts, updatedAt: b.updated_at };
    if (includeSecrets) Object.assign(result, { url: b.url, protocols: b.protocols ? JSON.parse(b.protocols) : null, workerToken: b.worker_token });
    return result;
  }
  listBindings() { return this._all("SELECT document_id FROM bindings ORDER BY document_id").map((row) => this.getBinding(row.document_id)); }
  listEvents(id) { this._binding(id); return this._all("SELECT * FROM events WHERE document_id=? ORDER BY rowid", id).map((row) => this._eventView(row)); }
  claimWorker(id, { pid, identity = processIdentity(pid), isAlive: alive } = {}) {
    if (!Number.isSafeInteger(pid) || pid <= 0) fail("invalid_pid");
    if (identity !== null && identity !== undefined && (typeof identity !== "string" || !identity || identity.length > 1000)) fail("invalid_worker_identity");
    if (!alive && !identity) fail("worker_identity_unavailable");
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
      this._run("UPDATE bindings SET worker_pid=?,worker_identity=?,worker_token=?,worker_started=1,reconciliation_required=CASE WHEN worker_started=1 THEN 1 ELSE reconciliation_required END,connection='connecting',updated_at=? WHERE document_id=?", pid, identity ?? null, token, now(), id);
      return { token, recovered };
    });
  }
  releaseWorker(id, token) { return this._tx(() => { this._fence(id, token); this._run("UPDATE bindings SET worker_pid=NULL,worker_identity=NULL,worker_token=NULL,connection='stopped',updated_at=? WHERE document_id=?", now(), id); }); }
  setConnection(id, token, state, reason = null) {
    if (!["connecting", "connected", "reconnecting", "stopped"].includes(state)) fail("invalid_connection_state");
    if (reason !== null) boundedText(reason, 200);
    return this._tx(() => {
      this._fence(id, token);
      const terminal = state === "stopped" && ["terminal_close_4401", "terminal_close_4409", "terminal_close_1003"].includes(reason);
      this._run("UPDATE bindings SET connection=?,connection_reason=?,state=CASE WHEN ? THEN 'stopped' ELSE state END,revoke_pending=CASE WHEN ? AND protocols IS NOT NULL THEN 1 ELSE revoke_pending END,updated_at=? WHERE document_id=?", state, reason, Number(terminal), Number(terminal), now(), id);
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
      if (b.state === "accepted" && evidence.planDigest !== b.accepted_digest) fail("accepted_plan_changed");
      this._run("UPDATE bindings SET plan_digest=?,plan_version_at=CASE WHEN plan_digest<>? THEN ? ELSE plan_version_at END,updated_at=? WHERE document_id=?", evidence.planDigest, evidence.planDigest, now(), now(), id);
    }
    this._run("UPDATE events SET state='completed',evidence=?,updated_at=? WHERE document_id=? AND event_id=?", JSON.stringify(evidence), now(), id, eventId);
    return this._eventView(this._event(id, eventId));
  }
  complete(id, eventId, { operationToken, evidence, planDigest } = {}) {
    const proof = validateEvidence(evidence);
    if (planDigest !== undefined && planDigest !== proof.planDigest) fail("digest_mismatch");
    return this._tx(() => { this._processing(id, eventId, operationToken); return this._complete(id, eventId, proof); });
  }
  accept(id, eventId, { operationToken, humanText, currentDigest, submittedPlanDigest } = {}) {
    requireDigest(currentDigest); requireDigest(submittedPlanDigest);
    return this._tx(() => {
      const b = this._binding(id); this._ready(b);
      const event = this._processing(id, eventId, operationToken);
      const routing = JSON.parse(event.routing);
      if (routing.authorRole !== "owner") fail("owner_acceptance_required");
      // Receipt and version timestamps share this local clock. A later plan
      // change invalidates queued acceptance without any server-skew allowance.
      if (!validTime(b.plan_version_at) || !validTime(event.received_at) ||
        Date.parse(event.received_at) < Date.parse(b.plan_version_at) ||
        Date.parse(routing.createdAt) < Date.parse(b.plan_version_at) - ACCEPTANCE_CLOCK_SKEW_MS) fail("acceptance_predates_plan_version");
      if (this._get("SELECT event_id FROM events WHERE document_id=? AND event_id<>? AND state<>'completed' LIMIT 1", id, eventId)) fail("outstanding_events");
      if (currentDigest !== submittedPlanDigest || currentDigest !== b.plan_digest) fail("digest_mismatch");
      if (!acceptsPlan(humanText, currentDigest)) fail("explicit_acceptance_required");
      this._run("UPDATE bindings SET state='accepted',accepted_event_id=?,accepted_digest=?,accepted_at=?,revoke_pending=1,updated_at=? WHERE document_id=?", eventId, currentDigest, now(), now(), id);
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
        if ((b.state !== "active" && !(b.state === "accepted" && b.accepted_event_id === eventId)) || this._outstanding(id, eventId)) fail("review_inactive");
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
      this._run("UPDATE bindings SET protocols=NULL,url=NULL,revoke_pending=0,revocation_evidence=?,updated_at=? WHERE document_id=?", evidence, now(), id);
      return this.getBinding(id);
    });
  }
  close() { this.db.close(); }
}
