import { eventType } from "../drizzle/schema.js";
import { commandTimeoutSeconds } from "./config.js";
import { runCommand } from "./daytonaProvider.js";
import type { AgentTask, Command } from "./input.js";
import { appendEvent } from "./store/events.js";

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

export async function materializeAsk(
  taskId: string,
  sandboxId: string,
  spec: AgentTask,
  cwd: string,
  env: Record<string, string>,
) {
  await runCommandStep(taskId, sandboxId, {
    cmd: `mkdir -p .threadbeat && printf '%s' ${shellQuote(JSON.stringify(spec))} > .threadbeat/task.json`,
  }, cwd, env);

  for (const file of spec.inputs?.files ?? []) {
    const content = shellQuote(file.content);
    const path = shellQuote(file.path);
    await runCommandStep(taskId, sandboxId, {
      cmd: `mkdir -p "$(dirname ${path})" && printf '%s' ${content} > ${path}`,
    }, cwd, env);
  }

  if (spec.inputs?.repo) {
    const input = spec.inputs.repo;
    const branch = input.branch ? ` --branch ${shellQuote(input.branch)}` : "";
    const path = shellQuote(input.path ?? ".threadbeat/input-repo");
    await runCommandStep(taskId, sandboxId, {
      cmd: `mkdir -p "$(dirname ${path})" && git clone${branch} ${shellQuote(input.url)} ${path}`,
      timeoutSeconds: 120,
    }, cwd, env);
  }
}

export async function runAgentEntrypoint(
  taskId: string,
  sandboxId: string,
  cwd: string,
  env: Record<string, string>,
) {
  await runCommandStep(taskId, sandboxId, {
    cmd: [
      "if test -f threadbeat-agent.mjs; then node threadbeat-agent.mjs .threadbeat/task.json;",
      "elif test -f threadbeat-agent.sh; then sh threadbeat-agent.sh .threadbeat/task.json;",
      "else echo 'missing threadbeat-agent.mjs or threadbeat-agent.sh' >&2; exit 2;",
      "fi",
    ].join(" "),
    timeoutSeconds: 300,
  }, cwd, env);
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
