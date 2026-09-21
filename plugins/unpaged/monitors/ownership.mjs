// A board's receiver holds a majority of five deterministic loopback ports.
// Any two majorities overlap, so kernel bind exclusivity fences concurrent
// starts even when an owner file is stale, missing, or being published.
import { createServer, createConnection } from "node:net";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDocumentId, STATUS_DIR_RELATIVE } from "./listen-core.mjs";

const HOST = "127.0.0.1";
const HEX = /^[a-f0-9]{64}$/;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proof = (capability, text) => createHmac("sha256", capability).update(text).digest("hex");
const ownerId = (capability) => createHash("sha256").update(capability).digest("hex");
const matches = (a, b) => typeof a === "string" && HEX.test(a) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

export function ownershipPorts(scope) {
  const ports = new Set();
  for (let i = 0; ports.size < 5; i++) {
    ports.add(20000 + createHash("sha256").update(`${scope}:${i}`).digest().readUInt32BE(0) % 40000);
  }
  return [...ports];
}

async function location(home, documentId) {
  if (!isDocumentId(documentId)) throw new Error("invalid_monitor_document");
  const canonicalHome = await realpath(home);
  const scope = createHash("sha256").update(JSON.stringify([canonicalHome, documentId])).digest("hex");
  return { scope, path: join(canonicalHome, STATUS_DIR_RELATIVE, "ownership", `${documentId}.json`) };
}

async function readOwner(path, scope, ports) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 2048 || (info.mode & 0o077) !== 0) return null;
    const owner = JSON.parse(await readFile(path, "utf8"));
    return owner?.scope === scope && typeof owner.capability === "string" && HEX.test(owner.capability) && ports.includes(owner.port) &&
      Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner : null;
  } catch { return null; }
}

// The server proves it knows the private capability before a client authorizes
// shutdown. Neither side sends the capability or listener credential over IPC.
async function contact(owner, stop, timeoutMs = 1000) {
  return new Promise((resolveContact) => {
    const challenge = randomBytes(32).toString("hex");
    const socket = createConnection({ host: HOST, port: owner.port });
    let text = "";
    let authenticated = false;
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolveContact(result); };
    // An absolute deadline also bounds a peer that trickles incomplete JSON.
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ op: "hello", challenge })}\n`));
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.length > 2048) { finish(false); return; }
      const end = text.indexOf("\n");
      if (end < 0) return;
      let message;
      try { message = JSON.parse(text.slice(0, end)); } catch { finish(false); return; }
      if (!message || typeof message !== "object" || Array.isArray(message)) { finish(false); return; }
      text = text.slice(end + 1);
      if (!authenticated) {
        if (message.scope !== owner.scope || !matches(message.proof, proof(owner.capability, `server:${challenge}`))) {
          finish(false); return;
        }
        authenticated = true;
        if (!stop) { finish(true); return; }
        socket.write(`${JSON.stringify({ op: "stop", proof: proof(owner.capability, `stop:${challenge}`) })}\n`);
      } else finish(message.stopping === true);
    });
  });
}

function controlServer(scope, capability, onTakeover, makeServer) {
  const sockets = new Set();
  const server = makeServer((socket) => {
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), 1000);
    socket.on("close", () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on("error", () => socket.destroy());
    let text = "";
    let challenge;
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (text.length > 2048) { socket.destroy(); return; }
      for (;;) {
        const end = text.indexOf("\n");
        if (end < 0) return;
        let message;
        try { message = JSON.parse(text.slice(0, end)); } catch { socket.destroy(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message)) { socket.destroy(); return; }
        text = text.slice(end + 1);
        if (!challenge) {
          if (message.op !== "hello" || !HEX.test(message.challenge ?? "")) { socket.destroy(); return; }
          challenge = message.challenge;
          socket.write(`${JSON.stringify({ scope, proof: proof(capability, `server:${challenge}`) })}\n`);
        } else {
          if (message.op !== "stop" || !matches(message.proof, proof(capability, `stop:${challenge}`))) { socket.destroy(); return; }
          // End the control exchange before shutdown drains and closes the
          // mutex, so server.close cannot deadlock waiting for this socket.
          socket.end(`${JSON.stringify({ stopping: true })}\n`);
          onTakeover();
          return;
        }
      }
    });
  });
  server.maxConnections = 16;
  return { server, sockets };
}

async function bind(port, scope, capability, onTakeover, makeServer) {
  const owner = controlServer(scope, capability, onTakeover, makeServer);
  return new Promise((resolveBind, reject) => {
    const onError = (error) => {
      owner.server.removeListener("listening", onListen);
      if (["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"].includes(error.code)) resolveBind(null);
      else reject(new Error("monitor_lock_unavailable"));
    };
    const onListen = () => { owner.server.removeListener("error", onError); resolveBind({ ...owner, port }); };
    owner.server.once("error", onError);
    owner.server.once("listening", onListen);
    owner.server.listen({ host: HOST, port, exclusive: true });
  });
}

async function closeAll(owners) {
  await Promise.all(owners.map(({ server, sockets }) => new Promise((resolveClose) => {
    server.close(resolveClose);
    for (const socket of sockets) socket.destroy();
  })));
}

export async function probeMonitorOwnership({ home, documentId }) {
  try {
    const { path, scope } = await location(home, documentId);
    const owner = await readOwner(path, scope, ownershipPorts(scope));
    return owner && await contact(owner, false) ? { pid: owner.pid, ownerId: ownerId(owner.capability) } : null;
  } catch { return null; }
}

export async function acquireMonitorOwnership({ home, documentId, signal, onTakeover,
  timeoutMs = 10000, ports: testPorts, beforePublish, createServer: makeServer = createServer } = {}) {
  const { path, scope } = await location(home, documentId);
  const ports = testPorts ?? ownershipPorts(scope);
  if (!Array.isArray(ports) || ports.length !== 5 || new Set(ports).size !== 5 ||
      ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) ||
      typeof onTakeover !== "function" || typeof makeServer !== "function") {
    throw new Error("monitor_lock_configuration_invalid");
  }
  const deadline = Date.now() + timeoutMs;
  const capability = randomBytes(32).toString("hex");
  let claimed = [];
  try {
    while (!signal?.aborted && Date.now() < deadline) {
      const previous = await readOwner(path, scope, ports);
      if (previous) await contact(previous, true);
      if (signal?.aborted) break;
      for (const port of ports) {
        const owner = await bind(port, scope, capability, onTakeover, makeServer);
        if (owner) claimed.push(owner);
        if (claimed.length === 3 || signal?.aborted) break;
      }
      if (claimed.length === 3 && !signal?.aborted) {
        await beforePublish?.();
        if (signal?.aborted) break;
        const folder = dirname(path);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
        await writeFile(temporary, JSON.stringify({ scope, pid: process.pid, port: claimed[0].port, capability }), { mode: 0o600, flag: "wx" });
        await rename(temporary, path);
        let released = false;
        const owned = claimed;
        claimed = [];
        return { ownerId: ownerId(capability), async release() { if (released) return; released = true; await closeAll(owned); } };
      }
      await closeAll(claimed);
      claimed = [];
      await pause(20 + randomBytes(1)[0] % 40);
    }
    return null;
  } finally { await closeAll(claimed); }
}
