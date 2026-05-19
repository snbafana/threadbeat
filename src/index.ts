import { loadSettings } from "./config.js";
import { PostgresTaskRepository } from "./db.js";
import { DaytonaSandboxProvider } from "./daytonaProvider.js";
import { createApp } from "./server.js";

const settings = loadSettings();
const repository = new PostgresTaskRepository(settings.databaseUrl);
await repository.bootstrap();

const { app } = createApp(settings, repository, new DaytonaSandboxProvider(settings));

const shutdown = async (): Promise<void> => {
  await app.close();
  await repository.close();
};

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await app.listen({ host: settings.host, port: settings.port });
console.log(`threadbeat listening on http://${settings.host}:${settings.port}`);
