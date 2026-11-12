// GitHub Copilot session extension for the Unpaged plugin.
// Stdout belongs to the Copilot JSON-RPC channel — never write to stdout here.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { joinSession } from "@github/copilot-sdk/extension";
import { pollInbox } from "../../monitors/poll.mjs";
import { createCopilotStore } from "./store.mjs";
import { createUnpagedCopilotController } from "./copilot-core.mjs";

const architectureCommandPath = fileURLToPath(new URL("../../commands/architecture.md", import.meta.url));
const planApprovedContextPath = fileURLToPath(new URL("../../hooks/plan-approved-context.json", import.meta.url));

async function loadPlanApprovedContext() {
  try {
    const parsed = JSON.parse(await readFile(planApprovedContextPath, "utf8"));
    return typeof parsed?.hookSpecificOutput?.additionalContext === "string"
      ? parsed.hookSpecificOutput.additionalContext
      : "";
  } catch {
    return "";
  }
}

let session = null;

const controller = createUnpagedCopilotController({
  executeTool: async (name, args) => {
    if (!session) throw new Error("session_not_ready");
    return session.rpc.tools.execute({ name, arguments: args });
  },
  listTools: async () => {
    if (!session) return null;
    let response = await session.rpc.tools.getCurrentMetadata();
    if (!response?.tools?.some((t) => t?.mcpServerName)) {
      await session.rpc.tools.initializeAndValidate({}).catch(() => {});
      response = await session.rpc.tools.getCurrentMetadata();
    }
    return response?.tools ?? null;
  },
  log: async (message, options) => {
    if (!session) return;
    await session.log(message, options);
  },
  sendPrompt: async (prompt) => {
    if (!session) throw new Error("session_not_ready");
    await session.send({ prompt });
  },
  getCwd: async () => process.cwd(),
  store: createCopilotStore(),
  poll: (config, settings) => pollInbox(config, settings),
  architectureCommandPath,
  planApprovedContext: await loadPlanApprovedContext(),
});

session = await joinSession({
  tools: controller.tools,
  commands: controller.commands,
  hooks: controller.hooks,
});

session.on("session.idle", () => {
  controller.onSessionIdle();
});

process.once("SIGTERM", () => controller.shutdown());
process.once("SIGINT", () => controller.shutdown());
