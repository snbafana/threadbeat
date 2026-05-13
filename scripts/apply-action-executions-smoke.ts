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
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", "apply-action-executions", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("apply-action executions smoke passed");

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
