import { host, port } from "./config.js";
import { createApp } from "./api/app.js";
import { close } from "./db/client.js";
import { startWorkerLoop } from "./worker/loop.js";

const app = createApp();
const stopWorker = startWorkerLoop();

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

await app.listen({ host, port });
console.log(`threadbeat listening on http://${host}:${port}`);

async function shutdown(code: number) {
  await stopWorker();
  await app.close();
  await close();
  process.exit(code);
}
