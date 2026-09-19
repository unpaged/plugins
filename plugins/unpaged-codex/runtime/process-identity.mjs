import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function missing(pid, kill) {
  try { kill(pid, 0); return undefined; }
  catch (error) { return error.code === "ESRCH" ? null : undefined; }
}

// A PID alone can belong to a different process after exit or reboot. Combine
// kernel boot identity with process start identity, without reading arguments.
// null means confirmed absent; undefined means inspection was inconclusive.
export function processIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const platform = options.platform ?? process.platform;
  const read = options.read ?? ((path) => readFileSync(path, "utf8"));
  const exec = options.exec ?? ((path, args) => execFileSync(path, args, {
    encoding: "utf8", timeout: 2000, maxBuffer: 4096, shell: false,
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  }));
  try {
    if (platform === "linux") {
      const boot = read("/proc/sys/kernel/random/boot_id").trim();
      const stat = read(`/proc/${pid}/stat`);
      // comm can contain spaces and parentheses. Field 22 is starttime; the
      // portion after the final ')' begins with field 3 (state).
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!/^[a-f0-9-]{36}$/i.test(boot) || !/^\d+$/.test(fields[19] ?? "")) return undefined;
      if (["Z", "X"].includes(fields[0])) return null;
      return `linux:${boot}:${fields[19]}`;
    }
    if (platform === "darwin") {
      const boot = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(exec("/usr/sbin/sysctl", ["-n", "kern.boottime"]));
      const start = exec("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "stat="]).trim().replace(/\s+/g, " ");
      const match = /^([A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}) ([A-Za-z+< >N]+)$/.exec(start);
      if (!boot || !match) return missing(pid, options.kill ?? process.kill);
      if (match[2].startsWith("Z")) return null;
      return `darwin:${boot[1]}.${boot[2]}:${match[1]}`;
    }
  } catch { /* Never expose inspection errors or process metadata in logs. */ }
  return missing(pid, options.kill ?? process.kill);
}

export function workerIsAlive(pid, expectedIdentity, identify = processIdentity) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const current = identify(pid);
  if (current === null) return false;
  if (typeof current === "string" && typeof expectedIdentity === "string") return current === expectedIdentity;
  // Legacy claims and denied inspection must not displace a possibly live worker.
  return true;
}
