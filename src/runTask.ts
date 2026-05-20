import { eventType, taskStatus } from "../drizzle/schema.js";
import { sandboxEnvAllowlist, smokeMarker } from "./config.js";
import type { Agent } from "./agents.js";
import * as agents from "./agents.js";
import * as sandbox from "./daytonaProvider.js";
import * as events from "./events.js";
import * as gitRun from "./gitRun.js";
import { materializeAsk, runAgentEntrypoint, runCommandStep, type AgentTaskSpec, type CommandSpec } from "./steps.js";
import type { Task } from "./tasks.js";
import * as tasks from "./tasks.js";

const WORKSPACE_DIR = "workspace";
const REPO_DIR = "workspace/repo";

type CommandTaskSpec = {
  repo?: { url: string; branch?: string; commit?: string };
  setup?: CommandSpec[];
  main: CommandSpec;
  verify?: CommandSpec[];
};

export async function runTask(task: Task) {
  if (task.agentId) return runAgentTask(task);
  return runCommandTask(task);
}

async function runCommandTask(task: Task) {
  let sandboxId: string | undefined;
  const spec = task.spec as CommandTaskSpec;
  const defaultCwd = spec.repo ? REPO_DIR : WORKSPACE_DIR;
  const env = sandboxEnv();

  try {
    await startTask(task.id);
    sandboxId = await createSandbox(task.id, env);

    if (spec.repo) {
      await sandbox.cloneRepo(sandboxId, spec.repo.url, spec.repo.branch, spec.repo.commit);
      await events.appendEvent(task.id, eventType.repoCloned, sandboxId, { repo: spec.repo });
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
  const spec = task.spec as AgentTaskSpec;
  const branch = task.runBranch ?? `runs/${task.id}`;
  const env = sandboxEnv();

  try {
    await startTask(task.id);
    sandboxId = await createSandbox(task.id, env);

    await sandbox.cloneRepo(sandboxId, agent.repoUrl, agent.defaultBranch);
    await events.appendEvent(task.id, eventType.repoCloned, sandboxId, { repo: { url: agent.repoUrl, branch: agent.defaultBranch }, agentId: agent.id });

    await gitRun.createRunBranch(task, sandboxId, REPO_DIR, branch);
    await materializeAsk(task.id, sandboxId, spec, REPO_DIR, env);
    await runAgentEntrypoint(task.id, sandboxId, REPO_DIR, env);
    await gitRun.commitRun(task, sandboxId, REPO_DIR);
    await gitRun.pushRunBranch(task, sandboxId, REPO_DIR, branch, agent.repoUrl, env);

    await completeTask(task.id);
  } catch (error) {
    await failTask(task.id, error);
  } finally {
    await deleteSandbox(task.id, sandboxId);
  }
}

async function loadAgent(task: Task): Promise<Agent> {
  if (!task.agentId) throw new Error(`task ${task.id} missing agentId`);
  const agent = await agents.getAgent(task.agentId);
  if (!agent) throw new Error(`agent not found: ${task.agentId}`);
  return agent;
}

async function startTask(taskId: string) {
  await tasks.updateTaskStatus(taskId, taskStatus.running);
  await events.appendEvent(taskId, eventType.taskStarted, "worker");
}

async function createSandbox(taskId: string, env: Record<string, string>) {
  const sandboxId = await sandbox.createSandbox(env);
  await events.appendEvent(taskId, eventType.sandboxCreated, sandboxId, { sandboxId });
  return sandboxId;
}

async function completeTask(taskId: string) {
  await tasks.updateTaskStatus(taskId, taskStatus.succeeded);
  await events.appendEvent(taskId, eventType.taskCompleted, "worker", { status: taskStatus.succeeded });
}

async function failTask(taskId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  await tasks.updateTaskStatus(taskId, taskStatus.failed, message);
  await events.appendEvent(taskId, eventType.taskFailed, "worker", { error: message });
}

async function deleteSandbox(taskId: string, sandboxId: string | undefined) {
  if (!sandboxId) return;
  try {
    await sandbox.deleteSandbox(sandboxId);
    await events.appendEvent(taskId, eventType.sandboxDeleted, sandboxId, { sandboxId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await events.appendEvent(taskId, eventType.sandboxDeleteFailed, sandboxId, { error: message, sandboxId });
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
