import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { UUID, boundedText, requireDigest, requireId, requireUuid, validTime, validateBinding, validateEvidence } from "./protocol.mjs";
import { processIdentity } from "./process-identity.mjs";

const fail = (message) => { throw new Error(message); };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const uuid = (value) => { if (typeof value !== "string") fail("invalid_uuid"); return requireUuid(value); };
const idSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" };
const uuidSchema = { type: "string", pattern: UUID.source.replaceAll("a-f", "a-fA-F") };
const textSchema = { type: "string", minLength: 1, maxLength: 1000 };
const digestSchema = { type: "string", pattern: "^[a-f0-9]{64}$" };
const shape = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const proofSchema = { oneOf: [shape({ replyId: idSchema, planDigest: digestSchema }),
  shape({ skippedReason: { type: "string", minLength: 1, maxLength: 500 } })] };
const phaseSchema = shape({ evidence: textSchema, currentDigest: digestSchema });
const definitions = {
  doctor: {}, info: {},
  digest: { payload: shape({ document: { type: "object" }, statusElementIds: { type: "array", items: uuidSchema, maxItems: 128 } }, ["document"]) },
  status: { document: "optional" },
  arm: { document: "required", payload: shape({ keyId: idSchema, key: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    pollUrl: { const: "https://mcp.unpaged.io/events/poll" }, url: { const: "wss://mcp.unpaged.io/events" },
    protocols: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    planDigest: digestSchema, statusElementIds: { type: "array", items: uuidSchema, maxItems: 128, uniqueItems: true } }, ["keyId", "planDigest"]) },
  resume: { document: "required" }, pending: { document: "required" },
  begin: { document: "required", event: true },
  complete: { document: "required", event: true, payload: shape({ operationToken: uuidSchema, evidence: proofSchema,
    planDigest: digestSchema }, ["operationToken", "evidence"]) },
  accept: { document: "required", event: true, payload: shape({ operationToken: uuidSchema, humanText: textSchema,
    humanCreatedAt: { type: "string" }, currentDigest: digestSchema, submittedPlanDigest: digestSchema }) },
  submit: { document: "required", payload: phaseSchema }, approve: { document: "required", payload: phaseSchema },
  execute: { document: "required", payload: phaseSchema }, checkpoint: { document: "required", payload: phaseSchema },
  built: { document: "required", payload: shape({ ...phaseSchema.properties, recordNodeId: uuidSchema, openTasks: { const: 0 } }) },
  stop: { document: "required" },
  revoked: { document: "required", payload: shape({ keyId: idSchema, evidence: textSchema }) },
  reconcile: { document: "required", payload: shape({ evidence: textSchema }) },
  recover: { document: "required", event: true, payload: shape({ decision: { enum: ["retry", "interrupt", "continue", "complete"] },
    evidence: { oneOf: [textSchema, proofSchema] } }) }
};

// Per-operation shapes keep executable, path, environment and task overrides out of model arguments.
export const controlInputSchema = { type: "object", properties: {
  operation: { type: "string", enum: Object.keys(definitions) }, documentId: uuidSchema,
  eventId: idSchema, payload: { type: "object" }
}, required: ["operation"], additionalProperties: false, oneOf: Object.entries(definitions).map(([operation, definition]) => {
  const properties = { operation: { const: operation } };
  const required = ["operation"];
  if (definition.document) properties.documentId = uuidSchema;
  if (definition.document === "required") required.push("documentId");
  if (definition.event) { properties.eventId = idSchema; required.push("eventId"); }
  if (definition.payload) { properties.payload = definition.payload; required.push("payload"); }
  return shape(properties, required);
}) };

function requireShape(value, schema) {
  if (!object(value) || Object.keys(value).some((key) => !has(schema.properties, key)) ||
      schema.required.some((key) => !has(value, key))) fail("invalid_control_arguments");
}

function validatePayload(operation, payload, documentId, threadId) {
  if (operation === "arm") {
    if (has(payload, "statusElementIds")) {
      if (!Array.isArray(payload.statusElementIds)) fail("invalid_status_elements");
      payload.statusElementIds.forEach(uuid);
    }
    // Validation only: the real executable is selected by the trusted host CLI, never this argument.
    validateBinding({ ...payload, documentId, threadId, codexPath: "/native-codex" });
  } else if (operation === "digest") {
    if (!object(payload.document) || (has(payload, "statusElementIds") &&
        (!Array.isArray(payload.statusElementIds) || payload.statusElementIds.length > 128 ||
          !payload.statusElementIds.every((id) => typeof id === "string" && UUID.test(id))))) fail("invalid_document_snapshot");
  } else if (operation === "complete") {
    uuid(payload.operationToken); validateEvidence(payload.evidence);
    if (has(payload, "planDigest")) requireDigest(payload.planDigest);
  } else if (operation === "accept") {
    uuid(payload.operationToken); boundedText(payload.humanText);
    if (!validTime(payload.humanCreatedAt)) fail("invalid_acceptance_time");
    requireDigest(payload.currentDigest); requireDigest(payload.submittedPlanDigest);
  } else if (["submit", "approve", "execute", "checkpoint", "built"].includes(operation)) {
    boundedText(payload.evidence); requireDigest(payload.currentDigest);
    if (operation === "built") { uuid(payload.recordNodeId); if (payload.openTasks !== 0) fail("open_plan_tasks"); }
  } else if (operation === "revoked") {
    requireId(payload.keyId); boundedText(payload.evidence);
  } else if (operation === "reconcile") boundedText(payload.evidence);
  else if (operation === "recover") {
    if (!["retry", "interrupt", "continue", "complete"].includes(payload.decision)) fail("invalid_recovery_decision");
    if (payload.decision === "complete") validateEvidence(payload.evidence); else boundedText(payload.evidence);
  }
}

// Keep existing public receipts, including task-operation capabilities, but no worker/credential fields.
const outputFields = new Set(("documentId threadId keyId codexPath pollUrl lastSuccessfulPollAt lastEventAt workerTransport upgradePending " +
  "planDigest planVersionAt statusElementIds status connectionState connectionReason reconciliationRequired workerPid workerIdentity " +
  "acceptedEventId acceptedDigest acceptedAt planPhase phaseEvidence acceptanceReceipts cleanupRequired credentialsPresent eventCounts updatedAt " +
  "id eventId nodeId commentId reason authorRole resolved createdAt state queueId evidence recoveryEvidence receivedAt " +
  "operationToken event events replyId skippedReason decision command phase at recordNodeId openTasks source " +
  "received dispatching queue_uncertain queued processing effect_uncertain completed " +
  "setupReady action evidenceScope evidenceLimit hook enabled trustStatus currentHash dataDirectory node minimumNode minimumCodex").split(" "));
function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => outputFields.has(key)).map(([key, item]) => [key, publicResult(item)]));
}

function setupResult(value) {
  const visible = publicResult(value);
  if (visible?.reason === "native_state_initialization_failed") {
    visible.action = "The native Unpaged review service could not initialize Codex runtime storage in the current profile. Preserve the canvas and report this host setup blocker. Do not request database grants, change hook trust or copy native state.";
  }
  return { ...visible, launchMethod: "native_mcp" };
}

function workerResult(value, identify) {
  const visible = publicResult(value);
  if (!object(visible)) fail("invalid_control_result");
  let workerAlive = false;
  if (Number.isSafeInteger(value.workerPid) && value.workerPid > 0) {
    let current;
    try { current = identify(value.workerPid); } catch { /* Unknown inspection is not proof of liveness. */ }
    workerAlive = current === null ? false : typeof current === "string" && typeof value.workerIdentity === "string"
      ? current === value.workerIdentity : null;
  }
  return { ...visible, workerAlive };
}

/** Context and options belong to the native host. Only args are model-supplied. */
export async function executeControl(args, context, options = {}) {
  if (!object(context) || typeof context.threadId !== "string" || !UUID.test(context.threadId) ||
      typeof context.cwd !== "string" || !isAbsolute(context.cwd) || /[\0\r\n]/.test(context.cwd)) fail("native_task_context_required");
  if (!object(args) || typeof args.operation !== "string" || !has(definitions, args.operation)) fail("invalid_control_operation");
  const definition = definitions[args.operation];
  const schema = controlInputSchema.oneOf.find((entry) => entry.properties.operation.const === args.operation);
  requireShape(args, schema);
  if (has(args, "documentId")) uuid(args.documentId);
  if (definition.event) requireId(args.eventId);
  if (definition.payload) {
    requireShape(args.payload, definition.payload);
    validatePayload(args.operation, args.payload, args.documentId, context.threadId);
  }
  let encoded;
  try { encoded = JSON.stringify(args.payload ?? {}); } catch { fail("invalid_control_arguments"); }
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) fail("input_too_large");
  if (args.operation === "arm") encoded = JSON.stringify({ ...args.payload, documentId: args.documentId, threadId: context.threadId });
  const argv = [args.operation, ...(has(args, "documentId") ? [args.documentId] : []), ...(definition.event ? [args.eventId] : [])];
  const env = { ...(options.env ?? process.env), CODEX_THREAD_ID: context.threadId };
  const run = async (command, body = encoded) => {
    try {
      // Discovery must work before loading the Node 24 native/storage dependencies.
      const execute = options.executeCli ?? (await import("./cli.mjs")).executeCli;
      return await execute(command, {
        env: { ...env }, cwd: context.cwd, input: Readable.from([body])
      });
    } catch (error) {
      if (error?.message === "setup_not_ready") {
        const safe = new Error("setup_not_ready"); safe.setup = setupResult(error.setup); throw safe;
      }
      throw error;
    }
  };
  if (["doctor", "arm", "resume"].includes(args.operation)) {
    const resolveCodex = options.resolveCodex ?? (async () => (await import("./cli.mjs")).findCodex(undefined, env));
    const codexPath = await resolveCodex();
    if (typeof codexPath !== "string" || !isAbsolute(codexPath) || /[\0\r\n]/.test(codexPath)) fail("native_codex_path_required");
    if (args.operation === "resume") {
      const bindings = await run(["status", args.documentId], "{}");
      const binding = Array.isArray(bindings) && bindings.find((row) => object(row) &&
        row.documentId === args.documentId && row.threadId === context.threadId);
      if (!binding) fail("review_unavailable");
      if (binding.codexPath !== codexPath) fail("native_codex_path_mismatch");
    } else argv.push("--codex", codexPath);
  }
  const result = await run(argv);
  if (args.operation === "status") {
    if (!Array.isArray(result)) fail("invalid_control_result");
    const owned = result.filter((row) => object(row) && row.threadId === context.threadId &&
      (!has(args, "documentId") || row.documentId === args.documentId));
    if (has(args, "documentId") && owned.length !== 1) fail("review_unavailable");
    return owned.map((binding) => workerResult(binding, options.processIdentity ?? processIdentity));
  }
  if (args.operation === "doctor") return setupResult(result);
  if (["arm", "resume"].includes(args.operation)) return workerResult(result, options.processIdentity ?? processIdentity);
  return publicResult(result);
}
