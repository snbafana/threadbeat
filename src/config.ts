import "dotenv/config";

import path from "node:path";
import { collectPresentEnv, hasModalCredentials, resolveGitHubToken } from "./auth.js";
import { buildModalImageCommands } from "./modalImage.js";
import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_FLASH_MODEL, DEEPSEEK_PROVIDER } from "./piModels.js";

export type ModalMode = "dry-run" | "live";

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
  githubOwner?: string;
  githubOwnerType?: "auto" | "org" | "user";
  githubToken?: string;
};

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8000;
export const DEFAULT_MODAL_APP_NAME = "threadbeat-sandboxes";
export const DEFAULT_MODAL_IMAGE = "python:3.13-slim";
export const DEFAULT_GITHUB_OWNER = "snbafana";
export const DEFAULT_GITHUB_OWNER_TYPE = "auto";
export const DEFAULT_SANDBOX_EXEC_TIMEOUT_MS = 120_000;
export const DEFAULT_AGENT_BOOT_TIMEOUT_MS = 600_000;

export const loadSettings = (): Settings => {
  const projectRoot = process.cwd();
  const modalInstallSandboxPi = true;
  const modalImageCommands = buildModalImageCommands({
    installSandboxPi: modalInstallSandboxPi,
  });
  const sandboxEnvNames = [DEEPSEEK_API_KEY_ENV];
  const sandboxEnv = collectPresentEnv(sandboxEnvNames, process.env);

  return {
    projectRoot,
    dbUrl: `file:${path.join(projectRoot, ".threadbeat", "threadbeat.db")}`,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    modalMode: hasModalCredentials(process.env) ? "live" : "dry-run",
    modalAppName: DEFAULT_MODAL_APP_NAME,
    modalImage: DEFAULT_MODAL_IMAGE,
    modalInstallSandboxPi,
    modalImageCommands,
    sandboxEnv,
    sandboxEnvNames,
    sandboxExecTimeoutMs: DEFAULT_SANDBOX_EXEC_TIMEOUT_MS,
    agentBootTimeoutMs: DEFAULT_AGENT_BOOT_TIMEOUT_MS,
    agentPiCommand: "pi",
    agentPiProvider: DEEPSEEK_PROVIDER,
    agentPiModel: DEEPSEEK_FLASH_MODEL,
    agentPiApiKeyEnv: DEEPSEEK_API_KEY_ENV,
    githubOwner: DEFAULT_GITHUB_OWNER,
    githubOwnerType: DEFAULT_GITHUB_OWNER_TYPE,
    githubToken: resolveGitHubToken(),
  };
};
