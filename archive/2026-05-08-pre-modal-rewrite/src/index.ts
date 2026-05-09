import { loadSettings } from "./config.js";
import { buildServer } from "./server.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});

const settings = loadSettings();
const { app } = await buildServer(settings);

await app.listen({ host: "0.0.0.0", port: settings.port });
