import { eventType } from "../../drizzle/schema.js";
import { commandTimeoutSeconds } from "../config.js";
import { runCommand } from "./daytona.js";
import type { Command } from "../input.js";
import { appendEvent } from "../db/events.js";

export async function runCommandStep(
  taskId: string,
  sandboxId: string,
  step: Command,
  defaultCwd: string,
  env: Record<string, string>,
  data: Record<string, unknown> = {},
) {
  const cwd = step.cwd ?? defaultCwd;
  const timeout = step.timeoutSeconds ?? commandTimeoutSeconds;
  await appendEvent(taskId, eventType.commandStarted, sandboxId, { cmd: step.cmd, cwd, timeout, ...data });
  const result = await runCommand(sandboxId, step.cmd, cwd, env, timeout);
  if (result.stdout) {
    await appendEvent(taskId, eventType.commandStdout, sandboxId, { stdout: result.stdout });
  }
  if (result.stderr) {
    await appendEvent(taskId, eventType.commandStderr, sandboxId, { stderr: result.stderr });
  }
  await appendEvent(taskId, eventType.commandCompleted, sandboxId, { exitCode: result.exitCode, ...data });
  if (result.exitCode !== 0) {
    await appendEvent(taskId, eventType.commandFailed, sandboxId, { exitCode: result.exitCode, cmd: step.cmd, ...data });
    throw new Error(`command failed with exit code ${result.exitCode}: ${step.cmd}`);
  }
}
