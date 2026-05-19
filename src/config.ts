import dotenv from "dotenv";

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const port = Number(process.env.THREADBEAT_PORT ?? 8000);
const maxSandboxes = Number(process.env.THREADBEAT_MAX_SANDBOXES ?? 1);
const commandTimeoutSeconds = Number(process.env.THREADBEAT_COMMAND_TIMEOUT_SECONDS ?? 120);

if (!Number.isInteger(port)) throw new Error("THREADBEAT_PORT must be an integer");
if (!Number.isInteger(maxSandboxes)) throw new Error("THREADBEAT_MAX_SANDBOXES must be an integer");
if (!Number.isInteger(commandTimeoutSeconds)) throw new Error("THREADBEAT_COMMAND_TIMEOUT_SECONDS must be an integer");

export const config = {
  host: process.env.THREADBEAT_HOST ?? "127.0.0.1",
  port,
  databaseUrl,
  daytonaApiKey: process.env.DAYTONA_API_KEY,
  daytonaApiUrl: process.env.DAYTONA_API_URL,
  daytonaTarget: process.env.DAYTONA_TARGET,
  maxSandboxes,
  commandTimeoutSeconds,
};
