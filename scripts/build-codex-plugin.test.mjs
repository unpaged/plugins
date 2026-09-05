import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildPlugin } from "./build-codex-plugin.mjs";

// Fixture only; never a personal or production registration.
const connectionId = "plugin_asdk_app_00000000000000000000000000000000";
const source = fileURLToPath(new URL("../plugins/unpaged-codex", import.meta.url));

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "unpaged-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("registered artifact has one connection and executes the packaged helper without source mutation", async (t) => {
  const root = await temporary(t);
  const output = join(root, "unpaged-codex");
  const before = await readFile(join(source, ".codex-plugin/plugin.json"), "utf8");
  await buildPlugin({ connectionId, output });
  const manifest = JSON.parse(await readFile(join(output, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.apps, "./.app.json");
  assert.equal(manifest.mcpServers, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(output, ".app.json"), "utf8")), { apps: { unpaged: { id: connectionId } } });
  await assert.rejects(lstat(join(output, ".mcp.json")), { code: "ENOENT" });
  await assert.rejects(lstat(join(output, "runtime/cli.test.mjs")), { code: "ENOENT" });
  for (const name of ["visual-plan", "review-plan"]) {
    assert.ok((await readFile(join(output, "skills", name, "SKILL.md"), "utf8")).startsWith("---\n"));
  }
  const info = spawnSync(process.execPath, [join(output, "runtime/cli.mjs"), "info", "--data", join(root, "state")], {
    shell: false, encoding: "utf8", timeout: 10000
  });
  assert.equal(info.status, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).dataDirectory, join(root, "state"));
  const alias = join(root, "helper-alias.mjs");
  await symlink(join(output, "runtime/cli.mjs"), alias);
  const viaAlias = spawnSync(process.execPath, [alias, "info", "--data", join(root, "state")], {
    shell: false, encoding: "utf8", timeout: 10000
  });
  assert.equal(viaAlias.status, 0, viaAlias.stderr);
  assert.equal(JSON.parse(viaAlias.stdout).dataDirectory, join(root, "state"));
  await assert.rejects(lstat(join(root, "state")), { code: "ENOENT" });
  assert.equal(await readFile(join(source, ".codex-plugin/plugin.json"), "utf8"), before);
});

test("invalid connection and in-repository output are refused before writing", async (t) => {
  const root = await temporary(t);
  const output = join(root, "invalid");
  await assert.rejects(buildPlugin({ connectionId: "https://example.com/private", output }), /registered_connection_id_required/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
  await assert.rejects(buildPlugin({ connectionId, output: join(source, "build") }), /outside_source_repository/);
});

test("existing output and symlink targets are never replaced", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "existing"), "keep me");
  await assert.rejects(buildPlugin({ connectionId, output: join(root, "existing") }), { code: "EEXIST" });
  assert.equal(await readFile(join(root, "existing"), "utf8"), "keep me");
  await symlink(join(root, "existing"), join(root, "linked"));
  await assert.rejects(buildPlugin({ connectionId, output: join(root, "linked") }), { code: "EEXIST" });
});

test("another Git worktree cannot receive a personal connection artifact", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, ".git"), "gitdir: /not-needed-for-this-test\n");
  const output = join(root, "artifact");
  await assert.rejects(buildPlugin({ connectionId, output }), /outside_git_worktrees/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});

test("a source symlink fails the build and removes the incomplete artifact", async (t) => {
  const root = await temporary(t);
  const copy = join(root, "source");
  await cp(source, copy, { recursive: true });
  await writeFile(join(root, "private.md"), "not package material");
  await symlink(join(root, "private.md"), join(copy, "skills/private.md"));
  const output = join(root, "output");
  await assert.rejects(buildPlugin({ connectionId, output, source: copy }), /symlinks_not_supported/);
  await assert.rejects(lstat(output), { code: "ENOENT" });
});
