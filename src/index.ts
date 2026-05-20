import { host, port } from "./config.js";
import * as db from "./db.js";
import { createApp } from "./server.js";

const app = createApp();

process.on("SIGINT", () => void app.close().then(() => db.close()).then(() => process.exit(0)));
process.on("SIGTERM", () => void app.close().then(() => db.close()).then(() => process.exit(0)));

await app.listen({ host, port });
console.log(`threadbeat listening on http://${host}:${port}`);
