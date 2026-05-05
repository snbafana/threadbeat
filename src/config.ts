import "dotenv/config";

import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const boolEnv = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const intEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export type Settings = {
  projectRoot: string;
  repoRoot: string;
  dbUrl: string;
  dbAuthToken?: string;
  pollSeconds: number;
  maxDuePerPoll: number;
  runTimeoutMs: number;
  piDryRun: boolean;
  piDryRunDelayMs: number;
  piProvider: string;
  piModel: string;
  piThinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  deepseekApiKey?: string;
  port: number;
};

export const loadSettings = (): Settings => {
  const repoRoot = path.resolve(process.env.THREADBEAT_REPO_ROOT ?? projectRoot);
  return {
    projectRoot,
    repoRoot,
    dbUrl: process.env.THREADBEAT_DB_URL ?? `file:${path.join(repoRoot, ".threadbeat", "threadbeat.db")}`,
    dbAuthToken: process.env.THREADBEAT_DB_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN,
    pollSeconds: intEnv("THREADBEAT_POLL_SECONDS", 10),
    maxDuePerPoll: intEnv("THREADBEAT_MAX_DUE_PER_POLL", 5),
    runTimeoutMs: intEnv("THREADBEAT_RUN_TIMEOUT_SECONDS", 300) * 1000,
    piDryRun: boolEnv("THREADBEAT_PI_DRY_RUN", false),
    piDryRunDelayMs: intEnv("THREADBEAT_PI_DRY_RUN_DELAY_MS", 0),
    piProvider: process.env.THREADBEAT_PI_PROVIDER ?? "deepseek",
    piModel: process.env.THREADBEAT_PI_MODEL ?? "deepseek-v4-flash",
    piThinking: (process.env.THREADBEAT_PI_THINKING ?? "off") as Settings["piThinking"],
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    port: intEnv("PORT", 8000),
  };
};
