// Executable entrypoint for the Unpaged Architecture Antigravity sidecar.
import { createArchitectureSidecarServer } from "./app.mjs";

const envPort = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT;
const parsedPort = envPort ? Number.parseInt(envPort, 10) : Number.NaN;
const port = Number.isFinite(parsedPort) ? parsedPort : 8000;

const app = createArchitectureSidecarServer({ port });
const boundPort = await app.listen();
console.log(`[unpaged-architecture] listening on 127.0.0.1:${boundPort}`);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
