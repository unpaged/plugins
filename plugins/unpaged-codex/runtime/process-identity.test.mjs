import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { processIdentity, workerIsAlive } from "./process-identity.mjs";

test("PID reuse and reboot identities do not block a replacement, but unknown inspection stays fenced", () => {
  assert.equal(workerIsAlive(10, "boot-a:start-a", () => "boot-a:start-a"), true);
  assert.equal(workerIsAlive(10, "boot-a:start-a", () => "boot-a:start-b"), false);
  assert.equal(workerIsAlive(10, "boot-a:start-a", () => "boot-b:start-a"), false);
  assert.equal(workerIsAlive(10, "old", () => null), false);
  assert.equal(workerIsAlive(10, "old", () => undefined), true);
  assert.equal(workerIsAlive(10, null, () => "some-live-process"), true);
  assert.equal(workerIsAlive(null, null), false);
});

test("Linux identity reads kernel start ticks even when comm contains spaces or parentheses", () => {
  const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const stat = `123 (worker (with spaces)) S ${Array(18).fill("0").join(" ")} 9876 0`;
  const read = (path) => path.endsWith("boot_id") ? boot : stat;
  assert.equal(processIdentity(123, { platform: "linux", read }), `linux:${boot}:9876`);
  assert.equal(processIdentity(123, { platform: "linux", read: (path) => read(path).replace(") S ", ") Z ") }), null);
});

test("macOS identity combines boot time and process start time without reading command arguments", () => {
  const calls = [];
  const exec = (path, args) => {
    calls.push([path, args]);
    return path.endsWith("sysctl") ? "{ sec = 100, usec = 22 }" : "Sat Sep  5 10:20:30 2026 S+\n";
  };
  assert.equal(processIdentity(123, { platform: "darwin", exec }), "darwin:100.22:Sat Sep 5 10:20:30 2026");
  assert.deepEqual(calls[1][1], ["-p", "123", "-o", "lstart=", "-o", "stat="]);
});

test("denied inspection is unknown and confirmed missing process is absent", () => {
  const fail = () => { throw Object.assign(new Error("private-details"), { code: "EPERM" }); };
  assert.equal(processIdentity(123, { platform: "linux", read: fail, kill: fail }), undefined);
  assert.equal(processIdentity(123, { platform: "linux", read: fail, kill: () => { throw Object.assign(new Error(), { code: "ESRCH" }); } }), null);
});

test("real process identity is stable while alive and absent after its owned child exits", async (t) => {
  const own = processIdentity(process.pid);
  assert.equal(typeof own, "string", "Host must permit inspection of its own processes");
  assert.equal(processIdentity(process.pid), own);
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", shell: false });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, "spawn");
  const identity = processIdentity(child.pid);
  assert.equal(typeof identity, "string");
  assert.equal(workerIsAlive(child.pid, identity), true);
  const exited = once(child, "exit");
  child.kill();
  await exited;
  assert.equal(processIdentity(child.pid), null);
});
