import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-branch-status-smoke-"));
const sessionName = `branch-status-${Date.now().toString(36)}`;
const workerId = "branch-status-worker";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-branch-status-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-branch-status-smoke",
};

const { app, db } = await buildServer(settings);

try {
  const agent = await db.createAgent({
    name: "branch-status-agent",
    repoUrl: "https://github.com/threadbeat-branch-status-smoke/agent.git",
    currentRef: "main",
  });
  await writeWorkerSessionRecord(agent.id);
  const run = await db.createAgentRun({
    agentId: agent.id,
    objective: "control-plane branch resume command queue",
    inputRef: "main",
    runBranch: `threadbeat/runs/${sessionName}`,
  });
  await db.updateAgentRunCompleted({ id: run.id, status: "stopped" });

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const branchResumeQueueCommand = `npm run cli -- runs session-branches ${sessionName} --server --resumable --branch-action resume_branch --limit 5 --commands-only --format shell`;
  const resumeBranchCommand = `npm run cli -- runs resume-branch ${run.id}`;

  const summary = await cliJson<{
    branches: {
      counts: { ready: number };
      inspection: { count: number; nextSteps: Array<{ runId: string; commands: { resumeBranch: string[] | null } }> };
    };
    commands: { branchResumeCommandQueue: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(summary.branches.counts.ready, 1);
  assert.equal(summary.branches.inspection.count, 1);
  assert.equal(summary.branches.inspection.nextSteps[0]?.runId, run.id);
  assert.equal(summary.branches.inspection.nextSteps[0]?.commands.resumeBranch?.join(" "), resumeBranchCommand);
  assert.equal(summary.commands.branchResumeCommandQueue.join(" "), branchResumeQueueCommand);

  const commandSummary = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === branchResumeQueueCommand));

  const textSummary = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(textSummary, /branch_inspection:/);
  assert.match(textSummary, new RegExp(`resume_queue: ${branchResumeQueueCommand}`));
  assert.match(textSummary, new RegExp(`resume: ${resumeBranchCommand}`));

  const branchQueueShell = await cliText(baseUrl, [
    "runs",
    "session-branches",
    sessionName,
    "--server",
    "--resumable",
    "--branch-action",
    "resume_branch",
    "--limit",
    "5",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(branchQueueShell, new RegExp(`^${resumeBranchCommand}$`, "m"));
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.out.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.err.log`), { force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane branch status smoke passed");

async function writeWorkerSessionRecord(agentId: string): Promise<void> {
  const sessionDir = path.join(".threadbeat", "worker-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const stdoutPath = path.join(sessionDir, `${sessionName}.out.log`);
  const stderrPath = path.join(sessionDir, `${sessionName}.err.log`);
  await fs.writeFile(stdoutPath, "");
  await fs.writeFile(stderrPath, "");
  await fs.writeFile(path.join(sessionDir, `${sessionName}.json`), `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-14T00:00:00.000Z",
    command: ["runs", "work", "--agent", agentId],
    workers: [{ workerId, pid: null, stdoutPath, stderrPath }],
    stoppedAt: "2026-05-14T00:00:01.000Z",
  }, null, 2)}\n`);
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

async function cliText(baseUrl: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
