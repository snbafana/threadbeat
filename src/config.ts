import "dotenv/config";

import path from "node:path";
import { boolEnv, intEnv, stringEnv } from "./env.js";
import { buildModalImageCommands } from "./modalImage.js";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_FLASH_MODEL, DEEPSEEK_PROVIDER } from "./piModels.js";

export type ModalMode = "dry-run" | "live";
export type HostedGitProviderSetting = "code-storage" | "github";
export type GitHubOwnerType = "auto" | "org" | "user";

export type Settings = {
  projectRoot: string;
  dbUrl: string;
  host: string;
  port: number;
  modalMode: ModalMode;
  modalAppName: string;
  modalImage: string;
  modalInstallSandboxPi?: boolean;
  modalImageCommands?: string[];
  sandboxEnv?: Record<string, string>;
  sandboxEnvNames?: string[];
  sandboxExecTimeoutMs?: number;
  agentBootTimeoutMs?: number;
  agentPiCommand?: string;
  agentPiProvider?: string;
  agentPiModel?: string;
  agentPiApiKeyEnv?: string;
  hostedGitProvider?: HostedGitProviderSetting;
  githubOwner?: string;
  githubOwnerType?: GitHubOwnerType;
  githubToken?: string;
  codeStorageName?: string;
  codeStoragePrivateKey?: string;
};

export const loadSettings = (): Settings => {
  const projectRoot = process.cwd();
  const modalMode = stringEnv("THREADBEAT_MODAL_MODE", "dry-run");
  if (modalMode !== "dry-run" && modalMode !== "live") {
    throw new Error("THREADBEAT_MODAL_MODE must be dry-run or live");
  }
  const hostedGitProvider = stringEnv("THREADBEAT_GIT_PROVIDER", "code-storage");
  if (hostedGitProvider !== "code-storage" && hostedGitProvider !== "github") {
    throw new Error("THREADBEAT_GIT_PROVIDER must be code-storage or github");
  }
  const githubOwnerType = stringEnv("THREADBEAT_GITHUB_OWNER_TYPE", "auto");
  if (githubOwnerType !== "auto" && githubOwnerType !== "org" && githubOwnerType !== "user") {
    throw new Error("THREADBEAT_GITHUB_OWNER_TYPE must be auto, org, or user");
  }

  const modalInstallSandboxPi = boolEnv("THREADBEAT_MODAL_INSTALL_SANDBOX_PI", false);
  const modalImageCommands = buildModalImageCommands({
    installSandboxPi: modalInstallSandboxPi,
    extraCommands: linesEnv("THREADBEAT_MODAL_IMAGE_COMMANDS"),
  });
  const sandboxEnvNames = listEnv("THREADBEAT_SANDBOX_ENV_ALLOWLIST");
  const sandboxEnv = collectAllowedEnv(sandboxEnvNames, process.env);

  return {
    projectRoot,
    dbUrl: stringEnv(
      "THREADBEAT_DB_URL",
      `file:${path.join(projectRoot, ".threadbeat", "threadbeat.db")}`,
    ),
    host: stringEnv("THREADBEAT_HOST", "127.0.0.1"),
    port: intEnv("THREADBEAT_PORT", intEnv("PORT", 8000)),
    modalMode,
    modalAppName: stringEnv("THREADBEAT_MODAL_APP_NAME", "threadbeat-sandboxes"),
    modalImage: stringEnv("THREADBEAT_MODAL_IMAGE", "python:3.13-slim"),
    modalInstallSandboxPi,
    modalImageCommands,
    sandboxEnv,
    sandboxEnvNames,
    sandboxExecTimeoutMs: intEnv("THREADBEAT_SANDBOX_EXEC_TIMEOUT_MS", 120_000),
    agentBootTimeoutMs: intEnv("THREADBEAT_AGENT_BOOT_TIMEOUT_MS", 600_000),
    agentPiCommand: stringEnv("THREADBEAT_AGENT_PI_COMMAND", "pi"),
    agentPiProvider: stringEnv("THREADBEAT_AGENT_PI_PROVIDER", DEEPSEEK_PROVIDER),
    agentPiModel: stringEnv("THREADBEAT_AGENT_PI_MODEL", DEEPSEEK_FLASH_MODEL),
    agentPiApiKeyEnv: stringEnv("THREADBEAT_AGENT_PI_API_KEY_ENV", DEEPSEEK_API_KEY_ENV),
    hostedGitProvider,
    githubOwner: process.env.THREADBEAT_GITHUB_OWNER,
    githubOwnerType,
    githubToken: process.env.THREADBEAT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN,
    codeStorageName: process.env.CODE_STORAGE_NAME ?? process.env.PIERRE_CODE_STORAGE_NAME,
    codeStoragePrivateKey:
      process.env.CODE_STORAGE_PRIVATE_KEY
      ?? process.env.PIERRE_PRIVATE_KEY
      ?? process.env.PIERRE_CODE_STORAGE_PRIVATE_KEY,
  };
};

const linesEnv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const listEnv = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);

const collectAllowedEnv = (names: string[], source: NodeJS.ProcessEnv): Record<string, string> =>
  Object.fromEntries(names.flatMap((name) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid sandbox env name: ${name}`);
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
