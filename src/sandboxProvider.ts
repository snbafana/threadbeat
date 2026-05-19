import type { CommandSpec, RepoSpec } from "./types.js";

export type SandboxHandle = {
  id: string;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
};

export interface SandboxProvider {
  createSandbox(env: Record<string, string>): Promise<SandboxHandle>;
  cloneRepo(sandbox: SandboxHandle, repo: RepoSpec): Promise<void>;
  runCommand(sandbox: SandboxHandle, command: CommandSpec, defaultCwd: string, env: Record<string, string>): Promise<CommandResult>;
  deleteSandbox(sandbox: SandboxHandle): Promise<void>;
}
