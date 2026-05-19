import { config } from "./config.js";
import * as sandbox from "./daytonaProvider.js";
import * as db from "./db.js";

const WORKSPACE_DIR = "workspace";
const REPO_DIR = "workspace/repo";

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

async function runTask(task: { id: string; spec: Record<string, unknown> }) {
  const run = await db.createRun(task.id);
  let sandboxId: string | undefined;
  const spec = task.spec as { repo?: { url: string; branch?: string; commit?: string }; setup?: { cmd: string; cwd?: string; timeoutSeconds?: number }[]; main: { cmd: string; cwd?: string; timeoutSeconds?: number }; verify?: { cmd: string; cwd?: string; timeoutSeconds?: number }[] };
  const defaultCwd = spec.repo ? REPO_DIR : WORKSPACE_DIR;
  const env = sandboxEnv();

  try {
    await db.updateTaskStatus(task.id, "running");
    await db.appendEvent(task.id, "run_started", "worker", run.id, "Run started");

    sandboxId = await sandbox.createSandbox(env);
    await db.updateRun(run.id, { sandboxId });
    await db.appendEvent(task.id, "sandbox_created", "daytona", run.id, "Sandbox created", { sandboxId });

    if (spec.repo) {
      await sandbox.cloneRepo(sandboxId, spec.repo.url, spec.repo.branch, spec.repo.commit);
      await db.appendEvent(task.id, "repo_cloned", "daytona", run.id, "Repository cloned");
    }

    for (const cmd of spec.setup ?? []) await runCommand(task.id, run.id, sandboxId, cmd, defaultCwd, env);
    await runCommand(task.id, run.id, sandboxId, spec.main, defaultCwd, env);
    for (const cmd of spec.verify ?? []) await runCommand(task.id, run.id, sandboxId, cmd, defaultCwd, env);

    await db.updateRun(run.id, { status: "succeeded" });
    await db.updateTaskStatus(task.id, "succeeded");
    await db.appendEvent(task.id, "run_succeeded", "worker", run.id, "Run succeeded");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.updateRun(run.id, { status: "failed", error: message });
    await db.updateTaskStatus(task.id, "failed", message);
    await db.appendEvent(task.id, "run_failed", "worker", run.id, message);
  } finally {
    if (sandboxId) {
      try {
        await sandbox.deleteSandbox(sandboxId);
        await db.appendEvent(task.id, "sandbox_deleted", "daytona", run.id, "Sandbox deleted");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await db.appendEvent(task.id, "sandbox_delete_failed", "daytona", run.id, message);
      }
    }
  }
}

async function runCommand(
  taskId: string,
  runId: string,
  sandboxId: string,
  cmd: { cmd: string; cwd?: string; timeoutSeconds?: number },
  defaultCwd: string,
  env: Record<string, string>,
) {
  const cwd = cmd.cwd ?? defaultCwd;
  const timeout = cmd.timeoutSeconds ?? config.commandTimeoutSeconds;
  await db.appendEvent(taskId, "command_started", "command", runId, cmd.cmd, { cwd, timeout });
  const result = await sandbox.runCommand(sandboxId, cmd.cmd, cwd, env, timeout);
  if (result.stdout) {
    await db.appendEvent(taskId, "command_stdout", "command", runId, result.stdout);
  }
  await db.appendEvent(taskId, "command_finished", "command", runId, `exit ${result.exitCode}`, { exitCode: result.exitCode });
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
