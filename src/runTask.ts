import { eventType, taskStatus } from "../drizzle/schema.js";
import { sandboxEnvAllowlist, smokeMarker } from "./config.js";
import { cloneRepo, createSandbox as openSandbox, deleteSandbox as closeSandbox } from "./daytonaProvider.js";
import { saveRunBranch } from "./gitRun.js";
import type { AgentTask, CommandTask } from "./input.js";
import { materializeAsk, runAgentEntrypoint, runCommandStep } from "./steps.js";
import { getAgent } from "./store/agents.js";
import { appendEvent } from "./store/events.js";
import type { Task } from "./store/tasks.js";
import { updateTaskStatus } from "./store/tasks.js";

const WORKSPACE_DIR = "workspace";
const REPO_DIR = "workspace/repo";

export async function runTask(task: Task) {
  if (task.agentId) return runAgentTask(task);
  return runCommandTask(task);
}

async function runCommandTask(task: Task) {
  let sandboxId: string | undefined;
  const spec = task.spec as CommandTask;
  const defaultCwd = spec.repo ? REPO_DIR : WORKSPACE_DIR;
  const env = sandboxEnv();

  try {
    await startTask(task.id);
    sandboxId = await createSandbox(task.id, env);

    if (spec.repo) {
      await cloneRepo(sandboxId, spec.repo.url, spec.repo.branch, spec.repo.commit);
      await appendEvent(task.id, eventType.repoCloned, sandboxId, { repo: spec.repo });
    }

    for (const cmd of spec.setup ?? []) await runCommandStep(task.id, sandboxId, cmd, defaultCwd, env);
    await runCommandStep(task.id, sandboxId, spec.main, defaultCwd, env);
    for (const cmd of spec.verify ?? []) await runCommandStep(task.id, sandboxId, cmd, defaultCwd, env);

    await completeTask(task.id);
  } catch (error) {
    await failTask(task.id, error);
  } finally {
    await deleteSandbox(task.id, sandboxId);
  }
}

async function runAgentTask(task: Task) {
  let sandboxId: string | undefined;
  const agent = await loadAgent(task);
  const spec = task.spec as AgentTask;
  const branch = task.runBranch ?? `runs/${task.id}`;
  const env = sandboxEnv();

  try {
    await startTask(task.id);
    sandboxId = await createSandbox(task.id, env);

    await cloneRepo(sandboxId, agent.repoUrl, agent.defaultBranch);
    await appendEvent(task.id, eventType.repoCloned, sandboxId, { repo: { url: agent.repoUrl, branch: agent.defaultBranch }, agentId: agent.id });

    await materializeAsk(task.id, sandboxId, spec, REPO_DIR, env);
    await runAgentEntrypoint(task.id, sandboxId, REPO_DIR, env);
    await saveRunBranch(task, sandboxId, REPO_DIR, branch, agent.repoUrl, env);

    await completeTask(task.id);
  } catch (error) {
    await failTask(task.id, error);
  } finally {
    await deleteSandbox(task.id, sandboxId);
  }
}

async function loadAgent(task: Task) {
  if (!task.agentId) throw new Error(`task ${task.id} missing agentId`);
  const agent = await getAgent(task.agentId);
  if (!agent) throw new Error(`agent not found: ${task.agentId}`);
  return agent;
}

async function startTask(taskId: string) {
  await updateTaskStatus(taskId, taskStatus.running);
  await appendEvent(taskId, eventType.taskStarted, "worker");
}

async function createSandbox(taskId: string, env: Record<string, string>) {
  const sandboxId = await openSandbox(env);
  await appendEvent(taskId, eventType.sandboxCreated, sandboxId, { sandboxId });
  return sandboxId;
}

async function completeTask(taskId: string) {
  await updateTaskStatus(taskId, taskStatus.succeeded);
  await appendEvent(taskId, eventType.taskCompleted, "worker", { status: taskStatus.succeeded });
}

async function failTask(taskId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await updateTaskStatus(taskId, taskStatus.failed, message);
  await appendEvent(taskId, eventType.taskFailed, "worker", { error: message });
}

async function deleteSandbox(taskId: string, sandboxId: string | undefined) {
  if (!sandboxId) return;
  try {
    await closeSandbox(sandboxId);
    await appendEvent(taskId, eventType.sandboxDeleted, sandboxId, { sandboxId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendEvent(taskId, eventType.sandboxDeleteFailed, sandboxId, { error: message, sandboxId });
  }
}

function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of sandboxEnvAllowlist) {
    if (name === "THREADBEAT_SMOKE_MARKER") {
      env[name] = smokeMarker;
      continue;
    }
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}
