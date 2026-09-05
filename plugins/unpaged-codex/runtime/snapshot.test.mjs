import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { retainRuntime } from "./snapshot.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "unpaged-snapshot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const plugin = join(root, "plugin");
  await mkdir(data, { mode: 0o700 });
  await cp(source, plugin, { recursive: true });
  return { root, data, plugin };
}

test("concurrent publishers retain one complete private runtime without connection or state files", async (t) => {
  const { data, plugin } = await fixture(t);
  await writeFile(join(plugin, "runtime/private.sqlite"), "not code");
  const results = await Promise.all(Array.from({ length: 8 }, () => retainRuntime(data, plugin)));
  assert.equal(new Set(results).size, 1);
  const root = dirname(dirname(results[0]));
  assert.match(root, /runtimes\/[a-f0-9]{64}$/);
  assert.equal((await lstat(root)).mode & 0o077, 0);
  assert.equal((await lstat(results[0])).mode & 0o077, 0);
  assert.deepEqual((await readdir(join(data, "runtimes"))), [root.split("/").at(-1)]);
  assert.deepEqual((await readdir(root)).sort(), ["runtime", "skills"]);
  assert.deepEqual((await readdir(join(root, "runtime"))).sort(), ["cli.mjs", "process-identity.mjs", "protocol.mjs", "snapshot.mjs", "store.mjs", "worker.mjs"]);
  assert.equal(await readFile(join(root, "skills/review-plan/SKILL.md"), "utf8"), await readFile(join(plugin, "skills/review-plan/SKILL.md"), "utf8"));
});

test("skill and executable updates retain distinct versions without modifying earlier releases", async (t) => {
  const { data, plugin } = await fixture(t);
  const first = await retainRuntime(data, plugin);
  const original = await readFile(first, "utf8");
  const skill = join(plugin, "skills/visual-plan/SKILL.md");
  await writeFile(skill, (await readFile(skill, "utf8")) + "\nUpdated review guidance.\n");
  const second = await retainRuntime(data, plugin);
  assert.notEqual(first, second);
  const worker = join(plugin, "runtime/worker.mjs");
  await writeFile(worker, (await readFile(worker, "utf8")) + "\n// Updated implementation.\n");
  const third = await retainRuntime(data, plugin);
  assert.notEqual(second, third);
  assert.equal(await readFile(first, "utf8"), original);
  assert.equal(await readFile(second, "utf8"), original);
  assert.equal((await readdir(join(data, "runtimes"))).length, 3);
});

test("corrupt and incomplete retained releases are refused without replacement", async (t) => {
  const { data, plugin } = await fixture(t);
  const worker = await retainRuntime(data, plugin);
  await writeFile(worker, "keep this evidence");
  await assert.rejects(retainRuntime(data, plugin), /runtime_snapshot_changed/);
  assert.equal(await readFile(worker, "utf8"), "keep this evidence");
  await rm(worker);
  await assert.rejects(retainRuntime(data, plugin), { code: "ENOENT" });
  await assert.rejects(lstat(worker), { code: "ENOENT" });
});

test("interrupted staging is never used as an executable release or removed by another publisher", async (t) => {
  const { data, plugin } = await fixture(t);
  const interrupted = join(data, "runtimes/.staging-interrupted");
  await mkdir(interrupted, { recursive: true, mode: 0o700 });
  await writeFile(join(interrupted, "partial"), "unfinished");
  const worker = await retainRuntime(data, plugin);
  assert.ok(!worker.includes(".staging-"));
  assert.equal(await readFile(join(interrupted, "partial"), "utf8"), "unfinished");
  assert.ok((await readFile(worker, "utf8")).includes("runWorker"));
});

test("source symlinks and redirected release directories cannot import or overwrite outside files", async (t) => {
  const { root, data, plugin } = await fixture(t);
  const external = join(root, "external");
  await mkdir(external);
  await symlink(external, join(data, "runtimes"));
  await assert.rejects(retainRuntime(data, plugin), /unsafe_runtime_directory/);
  assert.deepEqual(await readdir(external), []);
  await rm(join(data, "runtimes"));
  const worker = join(plugin, "runtime/worker.mjs");
  await rm(worker);
  await symlink(join(source, "runtime/worker.mjs"), worker);
  await assert.rejects(retainRuntime(data, plugin), { code: "ELOOP" });
  await assert.rejects(lstat(join(data, "runtimes")), { code: "ENOENT" });
});

test("retained file and nested directory symlinks are rejected rather than followed", async (t) => {
  const { root, data, plugin } = await fixture(t);
  const worker = await retainRuntime(data, plugin);
  const copied = join(root, "copy.mjs");
  await writeFile(copied, await readFile(worker));
  await rm(worker);
  await symlink(copied, worker);
  await assert.rejects(retainRuntime(data, plugin), { code: "ELOOP" });
  await rm(dirname(worker), { recursive: true });
  await symlink(join(plugin, "runtime"), dirname(worker));
  await assert.rejects(retainRuntime(data, plugin), /unsafe_runtime_directory/);
});
