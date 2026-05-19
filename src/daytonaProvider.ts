import { Daytona } from "@daytona/sdk";

import { config } from "./config.js";

const daytona = new Daytona({
  apiKey: config.daytonaApiKey,
  apiUrl: config.daytonaApiUrl,
  target: config.daytonaTarget,
});

const sandboxes = new Map<string, DaytonaSandbox>();

type DaytonaSandbox = {
  id: string;
  git: {
    clone(url: string, path: string, branch?: string, commit?: string): Promise<void>;
  };
  process: {
    codeRun(code: string, params?: { env?: Record<string, string> }, timeout?: number): Promise<{ exitCode: number; result: string }>;
  };
  delete(timeout?: number): Promise<void>;
};

export async function createSandbox(env: Record<string, string>) {
  const sandbox = (await daytona.create({
    language: "typescript",
    envVars: env,
    autoDeleteInterval: 60,
  })) as DaytonaSandbox;
  sandboxes.set(sandbox.id, sandbox);
  return sandbox.id;
}

export async function cloneRepo(sandboxId: string, url: string, branch?: string, commit?: string) {
  await lookup(sandboxId).git.clone(url, "workspace/repo", branch, commit);
}

export async function runCommand(sandboxId: string, cmd: string, cwd: string, env: Record<string, string>, timeoutSeconds: number) {
  const response = await lookup(sandboxId).process.codeRun(
    shellWrapper(cmd, cwd, env, timeoutSeconds),
    { env },
    timeoutSeconds + 5,
  );
  return { exitCode: response.exitCode, stdout: response.result };
}

export async function deleteSandbox(sandboxId: string) {
  const sandbox = sandboxes.get(sandboxId);
  if (!sandbox) throw new Error(`sandbox not found: ${sandboxId}`);
  await sandbox.delete(60);
  sandboxes.delete(sandboxId);
}

function lookup(sandboxId: string): DaytonaSandbox {
  const sandbox = sandboxes.get(sandboxId);
  if (!sandbox) throw new Error(`sandbox not found: ${sandboxId}`);
  return sandbox;
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
