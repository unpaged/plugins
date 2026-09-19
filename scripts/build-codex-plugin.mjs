#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const pluginSource = join(repository, "plugins/unpaged-codex");
const connectionPattern = /^plugin_asdk_app_[a-f0-9]{32}$/;
const components = ["skills", "hooks", "runtime", "README.md", "ARCHITECTURE.md"];

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function requireOutsideGit(directory) {
  for (let current = directory; ; current = dirname(current)) {
    let gitEntry;
    try { gitEntry = await lstat(join(current, ".git")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (gitEntry) throw new Error("output_must_be_outside_git_worktrees");
    if (dirname(current) === current) return;
  }
}

// Produce a local/distribution artifact, never write a personal registration
// into the source manifest. Runtime data and OAuth credentials are not inputs.
export async function buildPlugin({ connectionId, output, source = pluginSource }) {
  if (!connectionPattern.test(connectionId ?? "")) throw new Error("registered_connection_id_required");
  if (!isAbsolute(output ?? "")) throw new Error("absolute_output_required");
  const sourceRoot = await realpath(source);
  const parent = await realpath(dirname(output));
  const destination = join(parent, relative(dirname(output), output));
  if (within(await realpath(repository), destination) || within(sourceRoot, destination)) {
    throw new Error("output_must_be_outside_source_repository");
  }
  await requireOutsideGit(parent);
  // mkdir is exclusive: an existing artifact or symlink is never overwritten.
  await mkdir(destination, { mode: 0o700 });
  try {
    const manifest = JSON.parse(await readFile(join(sourceRoot, ".codex-plugin/plugin.json"), "utf8"));
    if (manifest.name !== "unpaged-codex" || manifest.skills !== "./skills/") {
      throw new Error("unexpected_plugin_manifest");
    }
    for (const component of components) {
      await cp(join(sourceRoot, component), join(destination, component), {
        recursive: true,
        filter: async (path) => {
          const entry = await lstat(path);
          if (entry.isSymbolicLink()) throw new Error("plugin_symlinks_not_supported");
          if (entry.isDirectory()) return true;
          // Only the expected component file types enter the artifact.
          if (component === "runtime") return path.endsWith(".mjs") && !path.endsWith(".test.mjs");
          if (component === "hooks") return path === join(sourceRoot, "hooks/hooks.json");
          return path.endsWith(".md");
        }
      });
    }
    delete manifest.mcpServers;
    manifest.apps = "./.app.json";
    await mkdir(join(destination, ".codex-plugin"));
    await writeFile(join(destination, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    await writeFile(join(destination, ".app.json"), JSON.stringify({ apps: { unpaged: { id: connectionId } } }, null, 2) + "\n");
    return { plugin: manifest.name, version: manifest.version, output: destination, connection: "registered" };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const [flag, connectionId, outputFlag, output, ...extra] = process.argv.slice(2);
    if (flag !== "--connection-id" || outputFlag !== "--output" || extra.length) {
      throw new Error("usage: build-codex-plugin.mjs --connection-id ID --output /absolute/new-directory");
    }
    console.log(JSON.stringify(await buildPlugin({ connectionId, output })));
  } catch (error) {
    // Avoid printing arbitrary filesystem paths or a malformed connection value.
    const message = /^[a-z_ :/-]+$/.test(error.message ?? "") ? error.message : "plugin_build_failed";
    console.error(message);
    process.exitCode = 1;
  }
}
