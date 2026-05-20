import { host, port } from "./config.js";
import { createApp } from "./app.js";
import { close } from "./store/db.js";

const app = createApp();

process.on("SIGINT", () => void app.close().then(close).then(() => process.exit(0)));
process.on("SIGTERM", () => void app.close().then(close).then(() => process.exit(0)));

await app.listen({ host, port });
console.log(`threadbeat listening on http://${host}:${port}`);
