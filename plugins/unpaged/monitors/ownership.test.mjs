import assert from "node:assert/strict";
import test from "node:test";
import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireMonitorOwnership, ownershipPorts, probeMonitorOwnership } from "./ownership.mjs";
import { STATUS_DIR_RELATIVE } from "./listen-core.mjs";

const DOCUMENT = "11111111-1111-4111-8111-111111111111";
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 400; i++) { if (predicate()) return; await pause(); }
  assert.fail("condition timed out");
}
async function occupy(port = 0, onSocket = (socket) => socket.destroy()) {
  const server = createServer(onSocket);
  server.listen({ host: "127.0.0.1", port, exclusive: true });
  await once(server, "listening");
  return server;
}
const close = (server) => new Promise((resolve) => server.close(resolve));
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "unpaged-claude-owner-"));
  const guards = await Promise.all(Array.from({ length: 5 }, () => occupy()));
  const ports = guards.map((server) => server.address().port);
  await Promise.all(guards.map(close));
  const owners = [];
  const claim = async (options = {}) => {
    const owner = await acquireMonitorOwnership({ home, documentId: DOCUMENT, ports, timeoutMs: 1000, onTakeover: () => {}, ...options });
    if (owner) owners.push(owner);
    return owner;
  };
  t.after(async () => { for (const owner of owners) await owner.release(); await rm(home, { recursive: true, force: true }); });
  return { home, ports, claim, path: join(home, STATUS_DIR_RELATIVE, "ownership", `${DOCUMENT}.json`) };
}

test("five unique deterministic ports keep separate scopes independent", () => {
  const ports = ownershipPorts("scope-one");
  assert.equal(new Set(ports).size, 5);
  assert.deepEqual(ownershipPorts("scope-one"), ports);
  assert.notDeepEqual(ownershipPorts("scope-two"), ports);
  assert.ok(ports.every((port) => port >= 20000 && port < 60000));
});

test("two unrelated occupied candidates still allow one quorum owner", async (t) => {
  const f = await fixture(t);
  const blockers = await Promise.all(f.ports.slice(0, 2).map((port) => occupy(port)));
  t.after(() => Promise.all(blockers.map(close)));
  const owner = await f.claim();
  assert.ok(owner);
  const record = JSON.parse(await readFile(f.path, "utf8"));
  assert.equal(record.port, f.ports[2]);
  assert.equal(record.capability.length, 64);
  await owner.release();
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).capability, record.capability, "release never removes a possibly replaced owner record");
});

test("concurrent starts cannot pass a paused owner's unpublished quorum", async (t) => {
  const f = await fixture(t);
  let publish;
  let publishing = false;
  let first;
  let takeovers = 0;
  const firstClaim = f.claim({ beforePublish: async () => { publishing = true; await new Promise((resolve) => { publish = resolve; }); },
    onTakeover: () => { takeovers++; void first.release(); } });
  await until(() => publishing);
  let secondEntered = false;
  const secondClaim = f.claim({ beforePublish: () => { secondEntered = true; } });
  await pause(80);
  assert.equal(secondEntered, false, "a missing owner file cannot create a fallback owner");
  publish();
  first = await firstClaim;
  assert.ok(await secondClaim);
  assert.equal(takeovers >= 1, true);
  assert.equal(secondEntered, true);
});

test("three concurrent starts converge with only one active owner", async (t) => {
  const f = await fixture(t);
  let active = 0;
  let maximum = 0;
  const controllers = Array.from({ length: 3 }, () => new AbortController());
  const runs = controllers.map(async (controller) => {
    const owner = await f.claim({ signal: controller.signal, onTakeover: () => controller.abort() });
    if (!owner) return;
    active++;
    maximum = Math.max(maximum, active);
    if (!controller.signal.aborted) await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
    active--;
    await owner.release();
  });
  await until(() => active === 1);
  await pause(180);
  assert.equal(maximum, 1);
  assert.equal(active, 1);
  for (const controller of controllers) controller.abort();
  await Promise.all(runs);
});

test("wrong private capability cannot stop or bypass a live quorum", async (t) => {
  const f = await fixture(t);
  let stopped = 0;
  const owner = await f.claim({ onTakeover: () => { stopped++; } });
  const original = await readFile(f.path, "utf8");
  await writeFile(f.path, JSON.stringify({ ...JSON.parse(original), capability: "0".repeat(64) }), { mode: 0o600 });
  const refused = await f.claim({ timeoutMs: 120 });
  assert.equal(refused, null);
  assert.equal(stopped, 0);
  await writeFile(f.path, original);
  await owner.release();
  assert.ok(await f.claim(), "a stale private record cannot block free kernel locks");
});

test("a stale record pointing at an unrelated service never authorizes a stop request", async (t) => {
  const f = await fixture(t);
  const old = await f.claim();
  const record = JSON.parse(await readFile(f.path, "utf8"));
  await old.release();
  const messages = [];
  const foreign = await occupy(record.port, (socket) => socket.on("data", (data) => {
    messages.push(JSON.parse(data.toString().trim()));
    socket.write(`${JSON.stringify({ scope: record.scope, proof: "0".repeat(64) })}\n`);
  }));
  t.after(() => close(foreign));
  assert.ok(await f.claim());
  assert.deepEqual(messages.map((message) => message.op), ["hello"]);
  assert.equal(JSON.stringify(messages).includes(record.capability), false);
});

test("a crashed process releases its kernel quorum while its owner record remains recoverable", async (t) => {
  const f = await fixture(t);
  const module = new URL("./ownership.mjs", import.meta.url).href;
  const code = `import { acquireMonitorOwnership } from ${JSON.stringify(module)};
    const owner = await acquireMonitorOwnership({home:process.argv[1],documentId:process.argv[2],ports:JSON.parse(process.argv[3]),onTakeover:()=>{}});
    if (!owner) process.exit(2);
    process.stdout.write("ready\\n");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, f.home, DOCUMENT, JSON.stringify(f.ports)], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const output = await once(child.stdout, "data");
  assert.equal(output[0].toString(), "ready\n");
  const original = await readFile(f.path, "utf8");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(await readFile(f.path, "utf8"), original);
  assert.ok(await f.claim());
});

test("the public ownership probe authenticates the current owner without requesting shutdown", async (t) => {
  const f = await fixture(t);
  let stopped = false;
  const owner = await acquireMonitorOwnership({ home: f.home, documentId: DOCUMENT, onTakeover: () => { stopped = true; } });
  t.after(() => owner?.release());
  assert.deepEqual(await probeMonitorOwnership({ home: f.home, documentId: DOCUMENT }), { pid: process.pid, ownerId: owner.ownerId });
  assert.equal(stopped, false);
  await owner.release();
  assert.equal(await probeMonitorOwnership({ home: f.home, documentId: DOCUMENT }), null);
});

test("malformed local control messages cannot crash or stop the owner", async (t) => {
  const f = await fixture(t);
  let stopped = false;
  const owner = await f.claim({ onTakeover: () => { stopped = true; } });
  const record = JSON.parse(await readFile(f.path, "utf8"));
  for (const payload of ["null", "[]", "42", "not-json"]) {
    const socket = createConnection({ host: "127.0.0.1", port: record.port });
    const closed = once(socket, "close");
    await once(socket, "connect");
    socket.write(`${payload}\n`);
    await closed;
  }
  assert.equal(stopped, false);
  await owner.release();
  const foreign = await occupy(record.port, (socket) => socket.on("data", () => socket.write("null\n")));
  t.after(() => close(foreign));
  assert.ok(await f.claim(), "invalid server replies are treated as unrelated occupied ports");
});

test("malformed array capabilities are ignored without contacting a foreign service", async (t) => {
  const f = await fixture(t);
  const old = await f.claim();
  const record = JSON.parse(await readFile(f.path, "utf8"));
  await old.release();
  await writeFile(f.path, JSON.stringify({ ...record, capability: [record.capability] }), { mode: 0o600 });
  let contacted = false;
  const foreign = await occupy(record.port, (socket) => { contacted = true; socket.end("{}\n"); });
  t.after(() => close(foreign));
  assert.ok(await f.claim());
  assert.equal(contacted, false);
});
