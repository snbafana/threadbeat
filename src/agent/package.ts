import type { AgentTask } from "../input.js";
import { runCommandStep } from "../sandbox/commands.js";

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
