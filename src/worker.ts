import { sandboxEnvFromAllowlist, type Settings } from "./config.js";
import type { TaskRepository } from "./db.js";
import type { SandboxProvider } from "./sandboxProvider.js";
import { commandLabel } from "./taskSpec.js";
import type { CommandSpec, EventType, TaskRow } from "./types.js";
import { REPO_DIR, WORKSPACE_DIR } from "./types.js";

export type DrainResult = {
  processed: number;
  taskIds: string[];
};

export class TaskWorker {
  constructor(
    private readonly repository: TaskRepository,
    private readonly sandboxProvider: SandboxProvider,
    private readonly settings: Settings,
  ) {}

  async drainOnce(limit = this.settings.maxSandboxes): Promise<DrainResult> {
    const processed: string[] = [];
    const count = Math.max(1, Math.min(limit, this.settings.maxSandboxes));
    for (let index = 0; index < count; index += 1) {
      const task = await this.repository.claimNextTask();
      if (!task) break;
      await this.runTask(task);
      processed.push(task.id);
    }
    return { processed: processed.length, taskIds: processed };
  }

  private async runTask(task: TaskRow): Promise<void> {
    const run = await this.repository.createRun(task.id);
    let sandbox: { id: string } | null = null;
    const sandboxEnv = sandboxEnvFromAllowlist(this.settings.sandboxEnvAllowlist);
    const defaultCwd = task.spec.repo ? REPO_DIR : WORKSPACE_DIR;
    try {
      await this.repository.markTaskRunning(task.id);
      await this.event(task.id, run.id, "task_claimed", "worker", "Task claimed by worker");
      await this.event(task.id, run.id, "run_started", "worker", "Run started");

      sandbox = await this.sandboxProvider.createSandbox(sandboxEnv);
      await this.repository.setRunSandbox(run.id, sandbox.id);
      await this.event(task.id, run.id, "sandbox_created", "daytona", "Daytona sandbox created", {
        sandboxId: sandbox.id,
      });

      if (task.spec.repo) {
        await this.event(task.id, run.id, "repo_clone_started", "daytona", "Repository clone started", task.spec.repo);
        await this.sandboxProvider.cloneRepo(sandbox, task.spec.repo);
        await this.event(task.id, run.id, "repo_clone_finished", "daytona", "Repository clone finished");
      }

      await this.runPhase(task, run.id, "setup", task.spec.setup ?? [], defaultCwd, sandbox, sandboxEnv);
      await this.runPhase(task, run.id, "main", [task.spec.main], defaultCwd, sandbox, sandboxEnv);
      await this.runPhase(task, run.id, "verify", task.spec.verify ?? [], defaultCwd, sandbox, sandboxEnv);

      await this.repository.markRunSucceeded(run.id);
      await this.repository.markTaskSucceeded(task.id);
      await this.event(task.id, run.id, "run_succeeded", "worker", "Run succeeded");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.markRunFailed(run.id, message);
      await this.repository.markTaskFailed(task.id, message);
      await this.event(task.id, run.id, "run_failed", "worker", message);
    } finally {
      if (sandbox) {
        try {
          await this.sandboxProvider.deleteSandbox(sandbox);
          await this.event(task.id, run.id, "sandbox_deleted", "daytona", "Daytona sandbox deleted", {
            sandboxId: sandbox.id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.event(task.id, run.id, "run_failed", "daytona", `Sandbox delete failed: ${message}`, {
            sandboxId: sandbox.id,
          });
        }
      }
    }
  }

  private async runPhase(
    task: TaskRow,
    runId: string,
    phase: "setup" | "main" | "verify",
    commands: CommandSpec[],
    defaultCwd: string,
    sandbox: { id: string },
    env: Record<string, string>,
  ): Promise<void> {
    if (commands.length === 0) return;
    await this.event(task.id, runId, "phase_started", "worker", `${phase} phase started`, { phase });
    for (const [index, command] of commands.entries()) {
      const label = commandLabel(phase, index);
      await this.event(task.id, runId, "command_started", "command", `${label}: ${command.cmd}`, {
        phase,
        index,
        cwd: command.cwd ?? defaultCwd,
        timeoutSeconds: command.timeoutSeconds ?? this.settings.commandTimeoutSeconds,
      });
      const result = await this.sandboxProvider.runCommand(sandbox, command, defaultCwd, env);
      await this.appendOutput(task.id, runId, result.stdout);
      await this.event(task.id, runId, "command_finished", "command", `${label}: exit ${result.exitCode}`, {
        phase,
        index,
        exitCode: result.exitCode,
      });
      if (result.exitCode !== 0) throw new Error(`${label} failed with exit code ${result.exitCode}`);
    }
  }

  private async appendOutput(taskId: string, runId: string, output: string): Promise<void> {
    for (const chunk of chunks(output, 8_000)) {
      await this.event(taskId, runId, "command_stdout", "command", chunk);
    }
  }

  private async event(
    taskId: string,
    runId: string | null,
    type: EventType,
    source: "worker" | "daytona" | "command",
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.appendEvent({ taskId, runId, type, source, message, data });
  }
}

const chunks = (text: string, size: number): string[] => {
  if (text.length === 0) return [];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += size) parts.push(text.slice(index, index + size));
  return parts;
};
