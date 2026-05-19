import dotenv from "dotenv";

import { csvEnv, intEnv, requiredEnv } from "./env.js";

dotenv.config();

export type Settings = {
  host: string;
  port: number;
  databaseUrl: string;
  daytonaApiKey?: string;
  daytonaApiUrl?: string;
  daytonaTarget?: string;
  maxSandboxes: number;
  runTimeoutSeconds: number;
  commandTimeoutSeconds: number;
  sandboxEnvAllowlist: string[];
};

export const loadSettings = (): Settings => ({
  host: process.env.THREADBEAT_HOST ?? "127.0.0.1",
  port: intEnv("THREADBEAT_PORT", 8000),
  databaseUrl: requiredEnv("DATABASE_URL"),
  daytonaApiKey: process.env.DAYTONA_API_KEY,
  daytonaApiUrl: process.env.DAYTONA_API_URL,
  daytonaTarget: process.env.DAYTONA_TARGET,
  maxSandboxes: intEnv("THREADBEAT_MAX_SANDBOXES", 1),
  runTimeoutSeconds: intEnv("THREADBEAT_RUN_TIMEOUT_SECONDS", 600),
  commandTimeoutSeconds: intEnv("THREADBEAT_COMMAND_TIMEOUT_SECONDS", 120),
  sandboxEnvAllowlist: csvEnv("THREADBEAT_SANDBOX_ENV_ALLOWLIST"),
});

export const sandboxEnvFromAllowlist = (allowlist: string[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};
