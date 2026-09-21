import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateCodexMarketplace } from "./validate-codex-marketplace.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "unpaged-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repository, ".agents"), join(root, ".agents"), { recursive: true });
  await cp(join(repository, "plugins"), join(root, "plugins"), { recursive: true });
  return root;
}

async function edit(root, path, change) {
  const file = join(root, path);
  const value = JSON.parse(await readFile(file, "utf8"));
  change(value);
  await writeFile(file, JSON.stringify(value));
}

const catalog = ".agents/plugins/marketplace.json";
const manifest = "plugins/unpaged-codex/.codex-plugin/plugin.json";

test("repository catalog resolves the Codex source package without listing Claude as Codex", async () => {
  assert.deepEqual(await validateCodexMarketplace(), ["unpaged-codex"]);
});

test("missing install/auth policies and duplicate entries fail validation", async (t) => {
  for (const property of ["installation", "authentication"]) {
    const root = await fixture(t);
    await edit(root, catalog, (value) => { delete value.plugins[0].policy[property]; });
    await assert.rejects(validateCodexMarketplace(root), new RegExp(`${property} policy`));
  }
  const root = await fixture(t);
  await edit(root, catalog, (value) => value.plugins.push(value.plugins[0]));
  await assert.rejects(validateCodexMarketplace(root), /duplicate plugin/);
});

test("wrong source paths and mismatched manifest names fail validation", async (t) => {
  const root = await fixture(t);
  await edit(root, catalog, (value) => { value.plugins[0].source.path = "./plugins/unpaged"; });
  await assert.rejects(validateCodexMarketplace(root), /source must match/);
  const other = await fixture(t);
  await edit(other, manifest, (value) => { value.name = "wrong-name"; });
  await assert.rejects(validateCodexMarketplace(other), /names must match/);
});

test("a new Codex directory must be listed and a Claude directory cannot substitute for it", async (t) => {
  const root = await fixture(t);
  await cp(join(root, "plugins/unpaged-codex"), join(root, "plugins/another-codex-plugin"), { recursive: true });
  await assert.rejects(validateCodexMarketplace(root), /missing from catalog: another-codex-plugin/);
  const other = await fixture(t);
  await edit(other, catalog, (value) => {
    value.plugins[0].name = "unpaged";
    value.plugins[0].source.path = "./plugins/unpaged";
  });
  await assert.rejects(validateCodexMarketplace(other), { code: "ENOENT" });
});

test("missing or unparseable bundled connection files fail validation", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "plugins/unpaged-codex/.mcp.json"));
  await assert.rejects(validateCodexMarketplace(root), { code: "ENOENT" });
  const other = await fixture(t);
  await writeFile(join(other, "plugins/unpaged-codex/.mcp.json"), "invalid json");
  await assert.rejects(validateCodexMarketplace(other), SyntaxError);
});

test("Unpaged requires its declared direct server, transport and production endpoint", async (t) => {
  const invalid = [
    {},
    { mcpServers: {} },
    { mcpServers: { unpaged: { type: "http", url: "https://example.com/mcp" } } },
    { mcpServers: { unpaged: { type: "http", url: "http://mcp.unpaged.io/mcp" } } },
    { mcpServers: { unpaged: { type: "stdio", url: "https://mcp.unpaged.io/mcp" } } }
  ];
  for (const value of invalid) {
    const root = await fixture(t);
    if (value.mcpServers?.unpaged) {
      const current = JSON.parse(await readFile(join(root, "plugins/unpaged-codex/.mcp.json"), "utf8"));
      value.mcpServers.unpaged_review = current.mcpServers.unpaged_review;
    }
    await writeFile(join(root, "plugins/unpaged-codex/.mcp.json"), JSON.stringify(value));
    await assert.rejects(validateCodexMarketplace(root), /Unpaged (must bundle|MCP)/);
  }
  const root = await fixture(t);
  await edit(root, manifest, (value) => { delete value.mcpServers; });
  await assert.rejects(validateCodexMarketplace(root), /must declare its bundled MCP/);
});

test("local review adapter cannot change its executable, profile, working folder or tool entry point", async (t) => {
  for (const change of [
    (value) => { delete value.mcpServers.unpaged_review; },
    (value) => { value.mcpServers.unpaged_review.command = "sh"; },
    (value) => { value.mcpServers.unpaged_review.cwd = "/tmp"; },
    (value) => { value.mcpServers.unpaged_review.args = ["another-script.mjs"]; },
    (value) => { value.mcpServers.unpaged_review.env = { CODEX_HOME: "/tmp/foreign-profile" }; },
    (value) => { value.mcpServers.unpaged_review.env_vars = []; }
  ]) {
    const root = await fixture(t);
    await edit(root, "plugins/unpaged-codex/.mcp.json", change);
    await assert.rejects(validateCodexMarketplace(root), /Unpaged (must bundle|local adapter)/);
  }
  const root = await fixture(t);
  await rm(join(root, "plugins/unpaged-codex/runtime/mcp.mjs"));
  await assert.rejects(validateCodexMarketplace(root), { code: "ENOENT" });
});

test("Unpaged requires a parseable recovery hook, its SessionStart command and helper", async (t) => {
  for (const content of [null, "invalid json"]) {
    const root = await fixture(t);
    const path = join(root, "plugins/unpaged-codex/hooks/hooks.json");
    if (content === null) await rm(path);
    else await writeFile(path, content);
    await assert.rejects(validateCodexMarketplace(root), content === null ? { code: "ENOENT" } : SyntaxError);
  }
  for (const value of [{}, { hooks: { SessionStart: [] } }]) {
    const root = await fixture(t);
    await writeFile(join(root, "plugins/unpaged-codex/hooks/hooks.json"), JSON.stringify(value));
    await assert.rejects(validateCodexMarketplace(root), /SessionStart hook/);
  }
  for (const change of [
    (value) => { value.hooks.Stop = value.hooks.SessionStart; },
    (value) => { value.hooks.SessionStart.push(value.hooks.SessionStart[0]); },
    (value) => { value.hooks.SessionStart[0].hooks.push({ type: "command", command: "extra-command" }); },
    (value) => { value.hooks.SessionStart[0].matcher = "startup"; },
    (value) => { value.hooks.SessionStart[0].hooks[0].command = "wrong-command"; }
  ]) {
    const root = await fixture(t);
    await edit(root, "plugins/unpaged-codex/hooks/hooks.json", change);
    await assert.rejects(validateCodexMarketplace(root), /SessionStart hook/);
  }
  const root = await fixture(t);
  await rm(join(root, "plugins/unpaged-codex/runtime/cli.mjs"));
  await assert.rejects(validateCodexMarketplace(root), { code: "ENOENT" });
});

test("component references cannot escape the installed package, including through symlinks", async (t) => {
  for (const useSymlink of [false, true]) {
    const root = await fixture(t);
    await writeFile(join(root, "outside.json"), "{}");
    if (useSymlink) {
      await symlink(join(root, "outside.json"), join(root, "plugins/unpaged-codex/escape.json"));
    }
    await edit(root, manifest, (value) => {
      value.mcpServers = useSymlink ? "./escape.json" : "./../../outside.json";
    });
    await assert.rejects(validateCodexMarketplace(root), /must stay inside/);
  }
});
