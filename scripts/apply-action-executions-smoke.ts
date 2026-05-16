import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { writeWorkerSessionApplyActionExecutionRecord } from "../src/workerSessionDrains.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-apply-action-executions-smoke-"));
const sessionName = `apply-action-executions-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-apply-action-executions-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-apply-action-executions-smoke",
};

const { app } = await buildServer(settings);

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;
  await writeSessionRecord();
  const older = await writeExecution({
    executionId: `apply-action-execution-older-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T10:00:00.000Z",
    completedAt: "2026-05-13T10:00:01.000Z",
    applyId: "apply-a",
    status: "failed",
    exitCode: 1,
  });
  const newer = await writeExecution({
    executionId: `apply-action-execution-newer-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T11:00:00.000Z",
    completedAt: "2026-05-13T11:00:01.000Z",
    applyId: "apply-b",
    status: "executed",
    exitCode: 0,
  });

  const newestPage = await cliJson<ApplyActionExecutionsResponse>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-executions",
    "--limit",
    "1",
  ]);
  assert.deepEqual(newestPage.executions.map((execution) => execution.executionId), [newer.executionId]);

  const byExecution = await cliJson<ApplyActionExecutionsResponse>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-executions",
    "--execution",
    older.executionId,
    "--limit",
    "1",
  ]);
  assert.deepEqual(byExecution.filter.executionIds, [older.executionId]);
  assert.deepEqual(byExecution.executions.map((execution) => execution.executionId), [older.executionId]);

  const timelineCommands = await cliJson<{
    commands: Array<{ action: string; executionId: string | null; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--execution",
    newer.executionId,
    "--commands-only",
    "--limit",
    "1",
  ]);
  assert.ok(timelineCommands.commands.some((command) => (
    command.action === "inspect_apply_action_execution"
    && command.executionId === newer.executionId
    && command.command.includes("--execution")
    && command.command.includes(newer.executionId)
  )));

  const terminals = await cliJson<{
    count: number;
    summary: { failedExecutions: number; recentExecutions: number };
    actions: unknown[];
    failedExecutions: Array<{
      executionId: string;
      applyId: string;
      action: string;
      exitCode: number | null;
      commands: { inspectExecution: string[]; inspectApply: string[]; executeAction: string[] };
    }>;
    commands: { queue: Array<{ command: string[] }> };
  }>(baseUrl, [
    "runs",
    "session-control-plane-apply-action-terminals",
    sessionName,
    "--server",
  ]);
  assert.equal(terminals.count, 1);
  assert.equal(terminals.summary.failedExecutions, 1);
  assert.equal(terminals.summary.recentExecutions, 2);
  assert.deepEqual(terminals.actions, []);
  assert.equal(terminals.failedExecutions[0]?.executionId, older.executionId);
  assert.equal(terminals.failedExecutions[0]?.applyId, "apply-a");
  assert.equal(terminals.failedExecutions[0]?.action, "inspect_drain_continuation_resets");
  assert.equal(terminals.failedExecutions[0]?.exitCode, 1);
  assert.ok(terminals.failedExecutions[0]?.commands.inspectExecution.includes(older.executionId));
  assert.ok(terminals.failedExecutions[0]?.commands.inspectApply.includes("apply-a"));
  assert.ok(terminals.failedExecutions[0]?.commands.executeAction.includes("--execute-next"));
  assert.ok(terminals.commands.queue.some((item) => item.command.includes(older.executionId)));
  assert.ok(terminals.commands.queue.some((item) => item.command.includes("--execute-next")));

  const terminalText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-apply-action-terminals",
    sessionName,
    "--server",
    "--format",
    "text",
  ]);
  assert.match(terminalText, /apply_action_terminals:/);
  assert.match(terminalText, /failed_executions=1/);
  assert.match(terminalText, new RegExp(`execution: ${older.executionId}`));
  assert.match(terminalText, /execute_action: npm run cli -- runs session-applies/);

  const terminalShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-apply-action-terminals",
    sessionName,
    "--server",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(terminalShell, new RegExp(`--action-executions --execution ${older.executionId}`));
  assert.match(terminalShell, /--action-queue --execute-next --apply-id apply-a --apply-action inspect_drain_continuation_resets/);

  const branchNativeApplyShell = await cliText(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--surface",
    "apply_action",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(branchNativeApplyShell, /session-control-plane-apply-action-terminals/);
  assert.match(branchNativeApplyShell, /session-applies .* --action-executions --status failed/);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", "apply-action-executions", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("apply-action executions smoke passed");

async function writeSessionRecord(): Promise<void> {
  const sessionPath = path.join(".threadbeat", "worker-sessions", `${sessionName}.json`);
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-13T10:00:00.000Z",
    command: ["runs", "work", "--agent", "apply-action-executions-smoke"],
    workers: [],
    stoppedAt: "2026-05-13T10:00:01.000Z",
  }, null, 2)}\n`);
}

type ApplyActionExecutionsResponse = {
  filter: { executionIds: string[] };
  executions: Array<{ executionId: string }>;
};

async function writeExecution(options: {
  executionId: string;
  observedAt: string;
  completedAt: string;
  applyId: string;
  status: "executed" | "failed";
  exitCode: number;
}): Promise<{ executionId: string }> {
  await writeWorkerSessionApplyActionExecutionRecord(settings.projectRoot, {
    executionId: options.executionId,
    session: sessionName,
    observedAt: options.observedAt,
    completedAt: options.completedAt,
    status: options.status,
    filter: { action: "inspect_drain_continuation_resets" },
    applyId: options.applyId,
    source: "status",
    action: "inspect_drain_continuation_resets",
    command: ["npm", "run", "cli", "--", "runs", "session-applies", sessionName, "--summary"],
    exitCode: options.exitCode,
    stdout: "{}",
    stderr: "",
    output: { ok: options.status === "executed" },
  });
  return { executionId: options.executionId };
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
