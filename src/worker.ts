import { eventType, taskStatus } from "../drizzle/schema.js";
import { config } from "./config.js";
import * as sandbox from "./daytonaProvider.js";
import * as db from "./db.js";

const WORKSPACE_DIR = "workspace";
const REPO_DIR = "workspace/repo";

type CommandSpec = { cmd: string; cwd?: string; timeoutSeconds?: number };
type TaskSpec = {
  repo?: { url: string; branch?: string; commit?: string };
  setup?: CommandSpec[];
  main: CommandSpec;
  verify?: CommandSpec[];
};
type ClaimedTask = { id: string; spec: Record<string, unknown> };

export async function drainOnce(limit = config.maxSandboxes) {
  const processed: string[] = [];
  const count = Math.max(1, Math.min(limit, config.maxSandboxes));
  for (let i = 0; i < count; i++) {
    const task = await db.claimNextTask();
    if (!task) break;
    await runTask(task);
    processed.push(task.id);
  }
  return { processed: processed.length, taskIds: processed };
}

async function runTask(task: ClaimedTask) {
  let sandboxId: string | undefined;
  const spec = task.spec as TaskSpec;
  const defaultCwd = spec.repo ? REPO_DIR : WORKSPACE_DIR;
  const env = sandboxEnv();

  try {
    await db.updateTaskStatus(task.id, taskStatus.running);
    await db.appendEvent(task.id, eventType.taskStarted, "worker");

    sandboxId = await sandbox.createSandbox(env);
    await db.appendEvent(task.id, eventType.sandboxCreated, sandboxId, { sandboxId });

    if (spec.repo) {
      await sandbox.cloneRepo(sandboxId, spec.repo.url, spec.repo.branch, spec.repo.commit);
      await db.appendEvent(task.id, eventType.repoCloned, sandboxId, { repo: spec.repo });
    }

    for (const cmd of spec.setup ?? []) await runCommand(task.id, sandboxId, cmd, defaultCwd, env);
    await runCommand(task.id, sandboxId, spec.main, defaultCwd, env);
    for (const cmd of spec.verify ?? []) await runCommand(task.id, sandboxId, cmd, defaultCwd, env);

    await db.updateTaskStatus(task.id, taskStatus.succeeded);
    await db.appendEvent(task.id, eventType.taskCompleted, "worker", { status: taskStatus.succeeded });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateTaskStatus(task.id, taskStatus.failed, message);
    await db.appendEvent(task.id, eventType.taskFailed, "worker", { error: message });
  } finally {
    if (sandboxId) {
      try {
        await sandbox.deleteSandbox(sandboxId);
        await db.appendEvent(task.id, eventType.sandboxDeleted, sandboxId, { sandboxId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.appendEvent(task.id, eventType.sandboxDeleteFailed, sandboxId, { error: message, sandboxId });
      }
    }
  }
}

async function runCommand(
  taskId: string,
  sandboxId: string,
  cmd: CommandSpec,
  defaultCwd: string,
  env: Record<string, string>,
) {
  const cwd = cmd.cwd ?? defaultCwd;
  const timeout = cmd.timeoutSeconds ?? config.commandTimeoutSeconds;
  await db.appendEvent(taskId, eventType.commandStarted, sandboxId, { cmd: cmd.cmd, cwd, timeout });
  const result = await sandbox.runCommand(sandboxId, cmd.cmd, cwd, env, timeout);
  if (result.stdout) {
    await db.appendEvent(taskId, eventType.commandStdout, sandboxId, { stdout: result.stdout });
  }
  await db.appendEvent(taskId, eventType.commandCompleted, sandboxId, { exitCode: result.exitCode });
  if (result.exitCode !== 0) throw new Error(`command failed with exit code ${result.exitCode}: ${cmd.cmd}`);
}

function sandboxEnv(): Record<string, string> {
  const allowlist = (process.env.THREADBEAT_SANDBOX_ENV_ALLOWLIST ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const env: Record<string, string> = {};
  for (const name of allowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
