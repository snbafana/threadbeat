import { Daytona } from "@daytona/sdk";

import type { Settings } from "./config.js";
import type { SandboxHandle, SandboxProvider, CommandResult } from "./sandboxProvider.js";
import type { CommandSpec, RepoSpec } from "./types.js";

type DaytonaSandbox = {
  id: string;
  git: {
    clone(url: string, path: string, branch?: string, commit?: string): Promise<void>;
  };
  process: {
    codeRun(code: string, params?: { env?: Record<string, string> }, timeout?: number): Promise<{ exitCode: number; result: string }>;
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
  };
  delete(timeout?: number): Promise<void>;
};

export class DaytonaSandboxProvider implements SandboxProvider {
  private readonly daytona: Daytona;
  private readonly sandboxes = new Map<string, DaytonaSandbox>();

  constructor(private readonly settings: Settings) {
    this.daytona = new Daytona({
      apiKey: settings.daytonaApiKey,
      apiUrl: settings.daytonaApiUrl,
      target: settings.daytonaTarget,
    });
  }

  async createSandbox(env: Record<string, string>): Promise<SandboxHandle> {
    const sandbox = (await this.daytona.create({
      language: "typescript",
      envVars: env,
      autoDeleteInterval: 60,
    })) as DaytonaSandbox;
    this.sandboxes.set(sandbox.id, sandbox);
    return { id: sandbox.id };
  }

  async cloneRepo(sandbox: SandboxHandle, repo: RepoSpec): Promise<void> {
    await this.lookup(sandbox).git.clone(repo.url, "workspace/repo", repo.branch, repo.commit);
  }

  async runCommand(
    sandbox: SandboxHandle,
    command: CommandSpec,
    defaultCwd: string,
    env: Record<string, string>,
  ): Promise<CommandResult> {
    const timeoutSeconds = command.timeoutSeconds ?? this.settings.commandTimeoutSeconds;
    const response = await this.lookup(sandbox).process.codeRun(
      shellWrapper(command.cmd, command.cwd ?? defaultCwd, env, timeoutSeconds),
      { env },
      timeoutSeconds + 5,
    );
    return { exitCode: response.exitCode, stdout: response.result };
  }

  async deleteSandbox(sandbox: SandboxHandle): Promise<void> {
    const daytonaSandbox = this.sandboxes.get(sandbox.id) ?? ((await this.daytona.get(sandbox.id)) as DaytonaSandbox);
    await daytonaSandbox.delete(60);
    this.sandboxes.delete(sandbox.id);
  }

  private lookup(sandbox: SandboxHandle): DaytonaSandbox {
    const daytonaSandbox = this.sandboxes.get(sandbox.id);
    if (!daytonaSandbox) throw new Error(`sandbox not found in provider cache: ${sandbox.id}`);
    return daytonaSandbox;
  }
}

const shellWrapper = (
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
): string => `
import fs from "node:fs";
import { spawn } from "node:child_process";

const cwd = ${JSON.stringify(cwd)};
fs.mkdirSync(cwd, { recursive: true });

const child = spawn("/bin/sh", ["-lc", ${JSON.stringify(command)}], {
  cwd,
  env: { ...process.env, ...${JSON.stringify(env)} },
  stdio: ["ignore", "pipe", "pipe"],
});

const timer = setTimeout(() => {
  child.kill("SIGTERM");
}, ${timeoutSeconds * 1000});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stdout.write(chunk));
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (signal) process.exit(124);
  process.exit(code ?? 1);
});
`;
