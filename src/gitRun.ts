import { eventType } from "../drizzle/schema.js";
import * as events from "./events.js";
import { runCommandStep } from "./steps.js";
import type { Task } from "./tasks.js";

export async function createRunBranch(task: Task, sandboxId: string, cwd: string, branch: string) {
  await runGit(task, sandboxId, cwd, [
    "git config user.email threadbeat-runs@example.com",
    "git config user.name threadbeat",
    `git checkout -B ${shellQuote(branch)}`,
  ].join(" && "), "branch.created", { branch });
}

export async function commitRun(task: Task, sandboxId: string, cwd: string) {
  await runGit(task, sandboxId, cwd, [
    "git add -A",
    `git commit -m ${shellQuote(`run ${task.id}`)} || echo 'no changes to commit'`,
  ].join(" && "), "committed");
}

export async function pushRunBranch(task: Task, sandboxId: string, cwd: string, branch: string, repoUrl: string, env: Record<string, string>) {
  await runGit(task, sandboxId, cwd, [
    authPushUrlCommand(repoUrl),
    `git push origin HEAD:${shellQuote(branch)}`,
  ].join(" && "), "pushed", { branch }, env);
}

async function runGit(
  task: Task,
  sandboxId: string,
  cwd: string,
  cmd: string,
  checkpoint: string,
  data: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  await runCommandStep(task.id, sandboxId, { cmd, timeoutSeconds: 120 }, cwd, env, { checkpoint });
  await events.appendEvent(task.id, eventType.checkpointCreated, "git", { checkpoint: `repo.${checkpoint}`, ...data });
}

function authPushUrlCommand(repoUrl: string) {
  const match = repoUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) return "true";
  const owner = match[1];
  const repo = match[2];
  return [
    "if test -n \"$GITHUB_TOKEN\"; then",
    `git remote set-url --push origin "https://x-access-token:$GITHUB_TOKEN@github.com/${owner}/${repo}.git";`,
    "fi",
  ].join(" ");
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
