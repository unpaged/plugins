import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
// A retained review needs both its executable dependency closure and the skill
// linked by queued prompts. Never copy connection configuration or runtime data.
const files = [
  "runtime/cli.mjs", "runtime/process-identity.mjs", "runtime/protocol.mjs", "runtime/snapshot.mjs",
  "runtime/store.mjs", "runtime/worker.mjs",
  "skills/review-plan/SKILL.md", "skills/visual-plan/SKILL.md"
];

async function directory(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("unsafe_runtime_directory");
}

async function readFile(root, name) {
  let parent = dirname(join(root, name));
  while (parent !== root) {
    await directory(parent);
    parent = dirname(parent);
  }
  const handle = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("unsafe_runtime_file");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function verify(root, contents) {
  await directory(root);
  for (const [name, expected] of contents) {
    if (!(await readFile(root, name)).equals(expected)) throw new Error("runtime_snapshot_changed");
  }
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

// Content-addressed snapshots are retained indefinitely: queued events can
// reference an older version after its worker exits or the plugin is updated.
// A fresh worker uses the current version; an already-live worker is not replaced.
export async function retainRuntime(dataDir, source = pluginRoot) {
  if (!isAbsolute(dataDir) || !isAbsolute(source)) throw new Error("absolute_runtime_directory_required");
  await directory(dataDir);
  await directory(source);
  const root = await realpath(source);
  const contents = await Promise.all(files.map(async (name) => [name, await readFile(root, name)]));
  const digest = createHash("sha256").update("unpaged-runtime-v1\0");
  for (const [name, bytes] of contents) digest.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  const releases = join(await realpath(dataDir), "runtimes");
  await mkdir(releases, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  await directory(releases);
  await syncDirectory(dirname(releases));
  const destination = join(releases, digest.digest("hex"));
  let existing = false;
  try { await lstat(destination); existing = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing) {
    await verify(destination, contents);
    await syncDirectory(releases);
    return join(destination, "runtime/worker.mjs");
  }
  const staging = await mkdtemp(join(releases, ".staging-"));
  try {
    const directories = new Set([staging]);
    for (const [name, bytes] of contents) {
      await mkdir(dirname(join(staging, name)), { recursive: true, mode: 0o700 });
      for (let parent = dirname(join(staging, name)); parent !== staging; parent = dirname(parent)) directories.add(parent);
      const handle = await open(join(staging, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
    }
    // Persist the files and directory entries before publishing an executable
    // path. The snapshot must outlive both cache deletion and a process crash.
    for (const path of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(path);
    try { await rename(staging, destination); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      // A concurrent publisher can win. Reuse it only if every file matches.
    }
    await verify(destination, contents);
    await syncDirectory(releases);
    return join(destination, "runtime/worker.mjs");
  } finally { await rm(staging, { recursive: true, force: true }); }
}
