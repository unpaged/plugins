import assert from "node:assert/strict";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const pluginName = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function component(root, path) {
  assert.equal(typeof path, "string", "component path must be a string");
  assert.ok(path.startsWith("./"), "component path must start with ./");
  const target = await realpath(resolve(root, path));
  const local = relative(root, target);
  assert.ok(local && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local),
    "component must stay inside its package");
  return target;
}

// Validate this repository's local Codex catalog, without installing or authenticating.
export async function validateCodexMarketplace(root = repository) {
  root = await realpath(root);
  const catalog = await json(join(root, ".agents/plugins/marketplace.json"));
  assert.match(catalog.name, /^[A-Za-z0-9_-]+$/, "invalid marketplace name");
  assert.ok(catalog.interface?.displayName?.trim(), "marketplace display name is required");
  assert.ok(Array.isArray(catalog.plugins) && catalog.plugins.length, "catalog needs plugins");
  const listed = new Set();
  for (const entry of catalog.plugins) {
    assert.match(entry.name, pluginName, "invalid plugin name");
    assert.ok(!listed.has(entry.name), "duplicate plugin entry");
    listed.add(entry.name);
    assert.equal(entry.source?.source, "local", "repository entries must use local sources");
    assert.equal(entry.source.path, `./plugins/${entry.name}`, "source must match its plugin directory");
    assert.ok(["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry.policy?.installation),
      "valid installation policy is required");
    assert.ok(["ON_INSTALL", "ON_USE"].includes(entry.policy?.authentication),
      "valid authentication policy is required");
    assert.ok(typeof entry.category === "string" && entry.category.trim(), "category is required");
    const source = await component(root, entry.source.path);
    const manifest = await json(await component(source, "./.codex-plugin/plugin.json"));
    assert.equal(manifest.name, entry.name, "catalog and manifest names must match");
    assert.ok(typeof manifest.version === "string" && manifest.version.trim(), "plugin version is required");
    for (const key of ["skills", "mcpServers", "apps"]) {
      if (manifest[key] === undefined) continue;
      const target = await component(source, manifest[key]);
      if (key !== "skills") await json(target);
    }
    const hooks = join(source, "hooks/hooks.json");
    if (await exists(hooks)) await json(await component(source, "./hooks/hooks.json"));
  }
  for (const directory of await readdir(join(root, "plugins"), { withFileTypes: true })) {
    if (directory.isDirectory() && await exists(join(root, "plugins", directory.name, ".codex-plugin/plugin.json"))) {
      assert.ok(listed.has(directory.name), `Codex plugin missing from catalog: ${directory.name}`);
    }
  }
  return [...listed];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const names = await validateCodexMarketplace();
    process.stdout.write(`Codex marketplace valid: ${names.join(", ")}\n`);
  } catch (error) {
    process.stderr.write(`Codex marketplace invalid: ${error.message}\n`);
    process.exitCode = 1;
  }
}
