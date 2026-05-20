import { Daytona, Image } from "@daytona/sdk";

import { daytonaApiKey, daytonaApiUrl, daytonaTarget } from "./config.js";

const daytona = new Daytona({
  apiKey: daytonaApiKey,
  apiUrl: daytonaApiUrl,
  target: daytonaTarget,
});
const sandboxImage = Image.debianSlim("3.12").runCommands("apt-get install -y zsh bash git nodejs npm");

const sandboxes = new Map<string, DaytonaSandbox>();

type DaytonaSandbox = {
  id: string;
  git: {
    clone(url: string, path: string, branch?: string, commit?: string): Promise<void>;
  };
  process: {
    createSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      request: { command: string; suppressInputEcho?: boolean },
      timeout?: number,
    ): Promise<{ exitCode?: number; output?: string; stdout?: string; stderr?: string }>;
  };
  delete(timeout?: number): Promise<void>;
};

export async function createSandbox(env: Record<string, string>) {
  const sandbox = (await daytona.create({
    image: sandboxImage,
    language: "typescript",
    envVars: env,
    autoDeleteInterval: 60,
  }, { timeout: 180 })) as DaytonaSandbox;
  sandboxes.set(sandbox.id, sandbox);
  return sandbox.id;
}

export async function cloneRepo(sandboxId: string, url: string, branch?: string, commit?: string) {
  await lookup(sandboxId).git.clone(url, "workspace/repo", branch, commit);
}

export async function runCommand(sandboxId: string, cmd: string, cwd: string, env: Record<string, string>, timeoutSeconds: number) {
  const sessionId = `threadbeat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const exitMarker = `__THREADBEAT_EXIT_CODE_${Math.random().toString(36).slice(2).toUpperCase()}__`;
  const process = lookup(sandboxId).process;
  await process.createSession(sessionId);
  try {
    const response = await process.executeSessionCommand(sessionId, {
      command: commandWithContext(cmd, cwd, env, exitMarker),
      suppressInputEcho: true,
    }, timeoutSeconds + 5);
    const stdout = response.stdout ?? response.output ?? "";
    const stderr = response.stderr ?? "";
    return {
      exitCode: parseExitCode(stdout, exitMarker),
      stdout: stripExitCode(stdout, exitMarker),
      stderr,
    };
  } finally {
    await process.deleteSession(sessionId);
  }
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

function commandWithContext(command: string, cwd: string, env: Record<string, string>, exitMarker: string) {
  const exports = Object.entries(env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid environment variable name: ${name}`);
    return `export ${name}=${shellQuote(value)}`;
  });
  return [
    `mkdir -p ${shellQuote(cwd)} && cd ${shellQuote(cwd)}`,
    ...exports,
    `(${command})`,
    `code=$?`,
    `printf '\\n${exitMarker}=%s\\n' "$code"`,
  ].join("; ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseExitCode(stdout: string, exitMarker: string) {
  const match = stdout.match(new RegExp(`${escapeRegExp(exitMarker)}=(\\d+)`));
  return match ? Number(match[1]) : 1;
}

function stripExitCode(stdout: string, exitMarker: string) {
  return stdout.replace(new RegExp(`\\n?${escapeRegExp(exitMarker)}=\\d+\\n?`, "g"), "");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
