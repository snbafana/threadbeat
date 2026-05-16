import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { writeWorkerSessionDrainContinuationRecord } from "../src/workerSessionDrains.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-alert-continuations-smoke-"));
const sessionName = `alert-continuations-${Date.now().toString(36)}`;
const selectedContinuationId = `alert-continuation-selected-${Date.now().toString(36)}`;
const otherContinuationId = `alert-continuation-other-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-alert-continuations-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-alert-continuations-smoke",
};

const { app } = await buildServer(settings);

try {
  await writeSessionRecord();
  await writeFailedContinuation(selectedContinuationId);
  await writeFailedContinuation(otherContinuationId);

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const alerts = await cliJson<{
    filter: { continuationIds: string[] };
    alerts: Array<{ continuationIds?: string[]; count: number; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--surface",
    "drain_continuation",
    "--continuation",
    selectedContinuationId,
  ]);
  assert.deepEqual(alerts.filter.continuationIds, [selectedContinuationId]);
  assert.equal(alerts.alerts.length, 1);
  assert.deepEqual(alerts.alerts[0]?.continuationIds, [selectedContinuationId]);
  assert.equal(alerts.alerts[0]?.count, 1);
  assert.equal(
    alerts.alerts[0]?.command.join(" "),
    `npm run cli -- runs session-drain-continuations ${sessionName} --status failed --continuation ${selectedContinuationId}`,
  );

  const preview = await cliJson<{
    filter: { continuationIds: string[] };
    alert: { continuationIds?: string[] } | null;
    details: {
      kind: "drain_continuations";
      totalFailed: number;
      continuations: Array<{ continuationId: string }>;
      commands: { inspectFailed: string[]; resetFailed: string[]; resetSelectedFailed: string[] | null };
    } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "drain_continuation",
    "--continuation",
    selectedContinuationId,
  ]);
  assert.deepEqual(preview.filter.continuationIds, [selectedContinuationId]);
  assert.deepEqual(preview.alert?.continuationIds, [selectedContinuationId]);
  assert.equal(preview.details?.kind, "drain_continuations");
  assert.equal(preview.details?.totalFailed, 1);
  assert.deepEqual(preview.details?.continuations.map((continuation) => continuation.continuationId), [selectedContinuationId]);
  assert.equal(
    preview.details?.commands.inspectFailed.join(" "),
    `npm run cli -- runs session-drain-continuations ${sessionName} --status failed --continuation ${selectedContinuationId}`,
  );
  assert.equal(
    preview.details?.commands.resetFailed.join(" "),
    `npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed --continuation ${selectedContinuationId}`,
  );

  const drainTerminals = await cliJson<{
    count: number;
    summary: { failed: number; terminal: number };
    continuations: Array<{
      continuationId: string;
      status: string | null;
      failed: number;
      commands: { inspectContinuation: string[]; resetSelectedFailed: string[] | null };
    }>;
    commands: { queue: Array<{ command: string[] }> };
  }>(baseUrl, [
    "runs",
    "session-control-plane-drain-terminals",
    sessionName,
    "--server",
    "--continuation",
    selectedContinuationId,
  ]);
  assert.equal(drainTerminals.count, 1);
  assert.equal(drainTerminals.summary.failed, 2);
  assert.equal(drainTerminals.summary.terminal, 1);
  assert.equal(drainTerminals.continuations[0]?.continuationId, selectedContinuationId);
  assert.equal(drainTerminals.continuations[0]?.status, "failed");
  assert.equal(drainTerminals.continuations[0]?.failed, 1);
  assert.deepEqual(drainTerminals.continuations[0]?.commands.inspectContinuation, [
    "npm", "run", "cli", "--", "runs", "session-drain-continuations", sessionName, "--status", "failed", "--continuation", selectedContinuationId,
  ]);
  assert.deepEqual(drainTerminals.continuations[0]?.commands.resetSelectedFailed, [
    "npm", "run", "cli", "--", "runs", "session-drain-continuations", sessionName, "--reset-failed", "--continuation", selectedContinuationId,
  ]);
  assert.ok(drainTerminals.commands.queue.some((item) => item.command.join(" ") === `npm run cli -- runs session-drain-continuations ${sessionName} --status failed --continuation ${selectedContinuationId}`));
  assert.ok(drainTerminals.commands.queue.some((item) => item.command.join(" ") === `npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed --continuation ${selectedContinuationId}`));

  const drainTerminalText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-drain-terminals",
    sessionName,
    "--server",
    "--continuation",
    selectedContinuationId,
    "--format",
    "text",
  ]);
  assert.match(drainTerminalText, /drain_terminals:/);
  assert.match(drainTerminalText, /summary: queued=0 running=0 failed=2 terminal=1/);
  assert.match(drainTerminalText, new RegExp(`continuation: ${selectedContinuationId}`));
  assert.match(drainTerminalText, /reset_failed: npm run cli -- runs session-drain-continuations/);

  const drainTerminalShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-drain-terminals",
    sessionName,
    "--server",
    "--continuation",
    selectedContinuationId,
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(drainTerminalShell, new RegExp(`--status failed --continuation ${selectedContinuationId}`));
  assert.match(drainTerminalShell, new RegExp(`--reset-failed --continuation ${selectedContinuationId}`));

  const branchNativeDrainShell = await cliText(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--surface",
    "drain_continuation",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(branchNativeDrainShell, /session-control-plane-drain-terminals/);
  assert.match(branchNativeDrainShell, /session-drain-continuations .* --reset-failed/);

  const execute = await cliJson<{
    dryRun: boolean;
    detailCommand: string;
    selected: { continuationIds?: string[]; command: string[] } | null;
    executed: null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmed: boolean };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--surface",
    "drain_continuation",
    "--continuation",
    selectedContinuationId,
    "--detail-command",
    "reset_selected_failed_drain_continuations",
    "--dry-run",
    "--confirm",
  ]);
  assert.equal(execute.dryRun, true);
  assert.equal(execute.detailCommand, "reset_selected_failed_drain_continuations");
  assert.deepEqual(execute.selected?.continuationIds, [selectedContinuationId]);
  assert.equal(
    execute.selected?.command.join(" "),
    `npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed --continuation ${selectedContinuationId}`,
  );
  assert.equal(execute.executed, null);
  assert.equal(execute.executionSafety.blocked, false);
  assert.equal(execute.executionSafety.mutating, true);
  assert.equal(execute.executionSafety.confirmed, true);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "drain-continuations", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane alert continuations smoke passed");

async function writeSessionRecord(): Promise<void> {
  const sessionPath = path.join(".threadbeat", "worker-sessions", `${sessionName}.json`);
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", "alert-continuations-smoke"],
    workers: [],
    stoppedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

async function writeFailedContinuation(continuationId: string): Promise<void> {
  await writeWorkerSessionDrainContinuationRecord(settings.projectRoot, {
    continuationId,
    session: sessionName,
    observedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "failed",
    error: "control-plane alert continuation smoke failed drain",
    dryRun: false,
    filter: {},
    readinessSource: "server",
    readinessCounts: {
      total: 1,
      needsContinuation: 1,
      done: 0,
      stoppedOnFailure: 1,
    },
    continueDrains: {
      dryRun: false,
      selected: 1,
      succeeded: 0,
      failed: 1,
    },
    drains: [{
      prefix: continuationId,
      nextApplyId: `${continuationId}-next`,
      command: ["npm", "run", "cli", "--", "runs", "session-apply", sessionName, "--source", "watch"],
      exitCode: 1,
      stderr: "control-plane alert continuation smoke failed drain",
    }],
  });
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
