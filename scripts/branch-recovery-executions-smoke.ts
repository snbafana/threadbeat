import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { writeWorkerSessionBranchRecoveryExecutionRecord } from "../src/workerSessionBranchRecovery.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-branch-recovery-executions-smoke-"));
const sessionName = `branch-recovery-executions-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-branch-recovery-executions-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-branch-recovery-executions-smoke",
};

const { app } = await buildServer(settings);

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;
  const older = await writeBranchRecoveryExecution({
    executionId: `branch-recovery-execution-older-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T10:00:00.000Z",
    completedAt: "2026-05-13T10:00:01.000Z",
    status: "noop",
    runId: "run-b",
    skipped: true,
  });
  const newer = await writeBranchRecoveryExecution({
    executionId: `branch-recovery-execution-newer-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T11:00:00.000Z",
    completedAt: "2026-05-13T11:00:01.000Z",
    status: "executed",
    runId: "run-a",
    skipped: false,
  });

  const byExecution = await cliJson<BranchRecoveryExecutionsResponse>(baseUrl, [
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--execution",
    older.executionId,
    "--limit",
    "10",
  ]);
  assert.deepEqual(byExecution.filter.executionIds, [older.executionId]);
  assert.deepEqual(byExecution.executions.map((execution) => execution.executionId), [older.executionId]);

  const byRun = await cliJson<BranchRecoveryExecutionsResponse>(baseUrl, [
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--run",
    "run-a",
    "--limit",
    "10",
  ]);
  assert.deepEqual(byRun.executions.map((execution) => execution.executionId), [newer.executionId]);

  const byStatus = await cliJson<BranchRecoveryExecutionsResponse>(baseUrl, [
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--status",
    "noop",
    "--limit",
    "10",
  ]);
  assert.deepEqual(byStatus.executions.map((execution) => execution.executionId), [older.executionId]);

  const commandQueue = await cliJson<{
    commands: Array<{ action: string; executionId: string; runId: string | null; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--execution",
    older.executionId,
    "--commands-only",
    "--checkout-dir",
    "./checkouts/branch-recovery-smoke",
  ]);
  assert.deepEqual(commandQueue.commands.map((command) => command.action), ["inspect_execution", "inspect_branch"]);
  assert.deepEqual(commandQueue.commands.map((command) => command.executionId), [older.executionId, older.executionId]);
  assert.deepEqual(commandQueue.commands.map((command) => command.runId), [null, "run-b"]);
  assert.deepEqual(commandQueue.commands[0]?.command, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--execution",
    older.executionId,
  ]);

  const { stdout: shellCommands } = await cli(baseUrl, [
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--execution",
    newer.executionId,
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(shellCommands, new RegExp(`runs session-branch-recovery-executions ${sessionName} --server --execution ${newer.executionId}`));
  assert.match(shellCommands, /runs inspect run-a/);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", "branch-recovery-executions", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("branch recovery executions smoke passed");

type BranchRecoveryExecutionsResponse = {
  ok: true;
  session: string;
  count: number;
  filter: {
    executionIds: string[];
    runIds: string[];
    status: string[];
    limit: number;
  };
  executions: Array<{
    executionId: string;
    status: "executed" | "partial" | "noop";
    resumed: Array<{ runId: string }>;
    skipped: Array<{ runId: string }>;
  }>;
};

async function writeBranchRecoveryExecution(options: {
  executionId: string;
  observedAt: string;
  completedAt: string;
  status: "executed" | "partial" | "noop";
  runId: string;
  skipped: boolean;
}): Promise<{ executionId: string }> {
  const run = {
    agentId: "agent-branch-recovery-smoke",
    runId: options.runId,
    objective: `branch recovery execution smoke ${options.runId}`,
    branchName: `threadbeat/runs/${options.runId}`,
    resultCommit: null,
    workerId: null,
  };
  await writeWorkerSessionBranchRecoveryExecutionRecord(settings.projectRoot, {
    executionId: options.executionId,
    session: sessionName,
    observedAt: options.observedAt,
    completedAt: options.completedAt,
    status: options.status,
    filter: { action: "recover_session", runIds: [options.runId] },
    selected: 1,
    resumed: options.skipped ? [] : [{ ...run, status: "planned" }],
    skipped: options.skipped ? [{ ...run, reason: "running_sandbox_present" }] : [],
  });
  return { executionId: options.executionId };
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await cli(baseUrl, args);
  return JSON.parse(stdout) as T;
}

async function cli(baseUrl: string, args: string[]): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return { stdout };
}
