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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-worker-alert-smoke-"));
const sessionName = `worker-alert-${Date.now().toString(36)}`;
const workerId = "worker-alert-advance";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-worker-alert-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-worker-alert-smoke",
};

const { app } = await buildServer(settings);

try {
  await writeSessionRecord();
  await writeAdvanceWorker(workerId);

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const preview = await cliJson<{
    alert: { surface: string; workerId?: string; action?: string } | null;
    details: {
      kind: "worker_recovery";
      workerId: string;
      target: {
        kind: string;
        worker: { workerId: string; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } } | null;
      };
      commands: { inspectWorker: string[] | null; restartWorker: string[]; retireWorker: string[] | null };
    } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "worker_recovery",
    "--worker",
    workerId,
    "--action",
    "restart_control_plane_advance_worker",
  ]);
  assert.equal(preview.alert?.surface, "worker_recovery");
  assert.equal(preview.alert?.workerId, workerId);
  assert.equal(preview.details?.kind, "worker_recovery");
  assert.equal(preview.details?.workerId, workerId);
  assert.equal(preview.details?.target.kind, "control_plane_advance_worker");
  assert.equal(preview.details?.target.worker?.workerId, workerId);
  assert.deepEqual(preview.details?.target.worker?.stdout.lines, ["advance stdout"]);
  assert.deepEqual(preview.details?.target.worker?.stderr.lines, ["advance stderr"]);
  assert.equal(
    preview.details?.commands.inspectWorker?.join(" "),
    `npm run cli -- runs session-control-plane-advance-workers ${sessionName} --server --worker-id ${workerId}`,
  );
  assert.equal(
    preview.details?.commands.restartWorker.join(" "),
    `npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id ${workerId}`,
  );
  assert.equal(
    preview.details?.commands.retireWorker?.join(" "),
    `npm run cli -- runs stop-control-plane-advance-workers ${sessionName} --server --worker-id ${workerId} --retire`,
  );

  const textPreview = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "worker_recovery",
    "--worker",
    workerId,
    "--action",
    "restart_control_plane_advance_worker",
    "--format",
    "text",
  ]);
  assert.match(textPreview, /control-plane alert/);
  assert.match(textPreview, /surface: worker_recovery/);
  assert.match(textPreview, /target_kind: control_plane_advance_worker/);
  assert.match(textPreview, new RegExp(`target_worker: ${workerId}`));
  assert.match(textPreview, /stdout_tail:\n    advance stdout/);
  assert.match(textPreview, /stderr_tail:\n    advance stderr/);
  assert.match(textPreview, /restart_worker_recovery: npm run cli -- runs restart-control-plane-advance-workers/);

  const commandPreview = await cliJson<{
    commands: Array<{ action: string; workerId?: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "worker_recovery",
    "--worker",
    workerId,
    "--action",
    "restart_control_plane_advance_worker",
    "--commands-only",
  ]);
  assert.ok(commandPreview.commands.some((command) => (
    command.action === "inspect_worker_recovery"
    && command.workerId === workerId
    && command.command.includes("session-control-plane-advance-workers")
  )));
  assert.ok(commandPreview.commands.some((command) => (
    command.action === "restart_worker_recovery"
    && command.workerId === workerId
    && command.command.includes("restart-control-plane-advance-workers")
  )));
  assert.ok(commandPreview.commands.some((command) => (
    command.action === "retire_worker_recovery"
    && command.workerId === workerId
    && command.command.includes("stop-control-plane-advance-workers")
  )));

  const blocked = await cliJson<{
    detailCommand: string;
    selected: { action: string; workerId?: string; command: string[] } | null;
    executed: null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmed: boolean; confirmationCommand: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--surface",
    "worker_recovery",
    "--worker",
    workerId,
    "--detail-command",
    "restart_worker_recovery",
  ]);
  assert.equal(blocked.detailCommand, "restart_worker_recovery");
  assert.equal(blocked.selected?.action, "restart_worker_recovery");
  assert.equal(blocked.selected?.workerId, workerId);
  assert.equal(blocked.executed, null);
  assert.equal(blocked.executionSafety.blocked, true);
  assert.equal(blocked.executionSafety.mutating, true);
  assert.equal(blocked.executionSafety.confirmed, false);
  assert.ok(blocked.executionSafety.confirmationCommand?.includes("--confirm"));

  const confirmedDryRun = await cliJson<{
    dryRun: boolean;
    advanceId: string;
    detailCommand: string;
    selected: { action: string; workerId?: string; command: string[] } | null;
    executed: null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmed: boolean };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--surface",
    "worker_recovery",
    "--worker",
    workerId,
    "--detail-command",
    "restart_worker_recovery",
    "--dry-run",
    "--confirm",
  ]);
  assert.equal(confirmedDryRun.dryRun, true);
  assert.equal(confirmedDryRun.detailCommand, "restart_worker_recovery");
  assert.equal(confirmedDryRun.selected?.workerId, workerId);
  assert.equal(
    confirmedDryRun.selected?.command.join(" "),
    `npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id ${workerId}`,
  );
  assert.equal(confirmedDryRun.executed, null);
  assert.equal(confirmedDryRun.executionSafety.blocked, false);
  assert.equal(confirmedDryRun.executionSafety.mutating, true);
  assert.equal(confirmedDryRun.executionSafety.confirmed, true);

  const recoveryAttemptHistory = await cliJson<{
    filter: { alertSurfaces: string[]; detailCommands: string[] };
    advances: Array<{
      advanceId: string;
      alert?: { surface: string; workerId?: string } | null;
      details?: {
        kind: string;
        workerId?: string;
        target?: { kind: string; worker?: { workerId: string } | null };
      } | null;
      detailCommand?: string;
      executionSafety?: { mutating: boolean; confirmed: boolean; blocked: boolean };
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--advance",
    confirmedDryRun.advanceId,
    "--alert-surface",
    "worker_recovery",
    "--detail-command",
    "restart_worker_recovery",
  ]);
  assert.deepEqual(recoveryAttemptHistory.filter.alertSurfaces, ["worker_recovery"]);
  assert.deepEqual(recoveryAttemptHistory.filter.detailCommands, ["restart_worker_recovery"]);
  const recoveryAttempt = recoveryAttemptHistory.advances[0];
  assert.equal(recoveryAttempt?.advanceId, confirmedDryRun.advanceId);
  assert.equal(recoveryAttempt?.alert?.surface, "worker_recovery");
  assert.equal(recoveryAttempt?.alert?.workerId, workerId);
  assert.equal(recoveryAttempt?.details?.kind, "worker_recovery");
  assert.equal(recoveryAttempt?.details?.workerId, workerId);
  assert.equal(recoveryAttempt?.details?.target?.kind, "control_plane_advance_worker");
  assert.equal(recoveryAttempt?.details?.target?.worker?.workerId, workerId);
  assert.equal(recoveryAttempt?.detailCommand, "restart_worker_recovery");
  assert.equal(recoveryAttempt?.executionSafety?.mutating, true);
  assert.equal(recoveryAttempt?.executionSafety?.confirmed, true);
  assert.equal(recoveryAttempt?.executionSafety?.blocked, false);

  const recoveryAttemptText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--advance",
    confirmedDryRun.advanceId,
    "--alert-surface",
    "worker_recovery",
    "--detail-command",
    "restart_worker_recovery",
    "--format",
    "text",
  ]);
  assert.match(recoveryAttemptText, /control-plane advances/);
  assert.match(recoveryAttemptText, new RegExp(`advance: ${confirmedDryRun.advanceId}`));
  assert.match(recoveryAttemptText, /detail_command: restart_worker_recovery/);
  assert.match(recoveryAttemptText, /alert: worker_recovery stopped_control_plane_advance_worker/);
  assert.match(recoveryAttemptText, new RegExp(`target_worker: ${workerId}`));

  const statusSummary = await cliJson<{
    queues: {
      controlPlaneConfirmations: {
        summary: { advances: number; groups: number; commands: number };
        groups: Array<{
          surface: string | null;
          action: string | null;
          detailCommand: string | null;
          reason: string | null;
          count: number;
          workerIds: string[];
          commands: Array<{ advanceId: string; command: string[] }>;
        }>;
        commands: {
          inspectQueue: string[];
          drainConfirmations: string[];
          drainConfirmationsDryRun: string[];
        };
      };
    };
    needsAction: boolean;
    nextRecovery: {
      kind: string;
      action: string;
      reason: string;
      count: number;
      command: string[];
      dryRunCommand: string[];
    } | null;
    recovery: {
      attempts: {
        total: number;
        dryRun: number;
        executed: number;
        failed: number;
        blocked: number;
        mutating: number;
      };
      recentAttempts: Array<{
        advanceId: string;
        detailCommand: string | null;
        workerId: string | null;
        action: string | null;
        reason: string | null;
        dryRun: boolean;
        executed: boolean;
        failed: boolean;
        blocked: boolean | null;
        mutating: boolean | null;
        confirmed: boolean | null;
        command: string[];
      }>;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(statusSummary.recovery.attempts.total, 2);
  assert.equal(statusSummary.recovery.attempts.dryRun, 1);
  assert.equal(statusSummary.recovery.attempts.executed, 0);
  assert.equal(statusSummary.recovery.attempts.failed, 0);
  assert.equal(statusSummary.recovery.attempts.blocked, 1);
  assert.equal(statusSummary.recovery.attempts.mutating, 2);
  assert.equal(statusSummary.queues.controlPlaneConfirmations.summary.advances, 1);
  assert.equal(statusSummary.queues.controlPlaneConfirmations.summary.groups, 1);
  assert.equal(statusSummary.queues.controlPlaneConfirmations.summary.commands, 1);
  assert.equal(statusSummary.needsAction, true);
  assert.equal(statusSummary.nextRecovery?.kind, "confirmation_queue");
  assert.equal(statusSummary.nextRecovery?.action, "drain_control_plane_confirmations");
  assert.equal(statusSummary.nextRecovery?.reason, "blocked_mutating_control_plane_confirmations");
  assert.equal(statusSummary.nextRecovery?.count, 1);
  assert.deepEqual(statusSummary.queues.controlPlaneConfirmations.commands.inspectQueue, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--confirmation-queue",
  ]);
  assert.deepEqual(statusSummary.queues.controlPlaneConfirmations.commands.drainConfirmationsDryRun, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--drain-confirmations",
    "--confirm",
    "--dry-run",
  ]);
  assert.deepEqual(statusSummary.nextRecovery?.command, statusSummary.queues.controlPlaneConfirmations.commands.drainConfirmations);
  assert.deepEqual(statusSummary.nextRecovery?.dryRunCommand, statusSummary.queues.controlPlaneConfirmations.commands.drainConfirmationsDryRun);
  const confirmationGroup = statusSummary.queues.controlPlaneConfirmations.groups[0];
  assert.equal(confirmationGroup?.surface, "worker_recovery");
  assert.equal(confirmationGroup?.action, "restart_worker_recovery");
  assert.equal(confirmationGroup?.detailCommand, "restart_worker_recovery");
  assert.equal(confirmationGroup?.reason, "mutating detail command requires confirm=true");
  assert.equal(confirmationGroup?.count, 1);
  assert.deepEqual(confirmationGroup?.workerIds, [workerId]);
  assert.ok(confirmationGroup?.commands[0]?.command.includes("--confirm"));
  assert.equal(statusSummary.recovery.recentAttempts.length, 2);
  const statusConfirmedAttempt = statusSummary.recovery.recentAttempts.find((attempt) => (
    attempt.advanceId === confirmedDryRun.advanceId
  ));
  assert.equal(statusConfirmedAttempt?.detailCommand, "restart_worker_recovery");
  assert.equal(statusConfirmedAttempt?.workerId, workerId);
  assert.equal(statusConfirmedAttempt?.action, "restart_control_plane_advance_worker");
  assert.equal(statusConfirmedAttempt?.reason, "stopped_control_plane_advance_worker");
  assert.equal(statusConfirmedAttempt?.dryRun, true);
  assert.equal(statusConfirmedAttempt?.executed, false);
  assert.equal(statusConfirmedAttempt?.failed, false);
  assert.equal(statusConfirmedAttempt?.blocked, false);
  assert.equal(statusConfirmedAttempt?.mutating, true);
  assert.equal(statusConfirmedAttempt?.confirmed, true);
  assert.deepEqual(statusConfirmedAttempt?.command, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--advance",
    confirmedDryRun.advanceId,
    "--alert-surface",
    "worker_recovery",
    "--detail-command",
    "restart_worker_recovery",
  ]);
  const statusBlockedAttempt = statusSummary.recovery.recentAttempts.find((attempt) => attempt.blocked);
  assert.equal(statusBlockedAttempt?.detailCommand, "restart_worker_recovery");
  assert.equal(statusBlockedAttempt?.workerId, workerId);
  assert.equal(statusBlockedAttempt?.confirmed, false);

  const recoverNextDryRun = await cliJson<{
    ok: boolean;
    session: string;
    dryRun: boolean;
    selected: { kind: string; action: string; count: number } | null;
    command: string[] | null;
    result: {
      dryRun: boolean;
      availableConfirmations: number;
      attemptedConfirmations: number;
      results: Array<{ sourceAdvanceId: string; dryRun: boolean; executionSafety: { confirmed: boolean; blocked: boolean } }>;
    } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
  ]);
  assert.equal(recoverNextDryRun.ok, true);
  assert.equal(recoverNextDryRun.session, sessionName);
  assert.equal(recoverNextDryRun.dryRun, true);
  assert.equal(recoverNextDryRun.selected?.kind, "confirmation_queue");
  assert.equal(recoverNextDryRun.selected?.action, "drain_control_plane_confirmations");
  assert.equal(recoverNextDryRun.selected?.count, 1);
  assert.deepEqual(recoverNextDryRun.command, statusSummary.queues.controlPlaneConfirmations.commands.drainConfirmationsDryRun);
  assert.equal(recoverNextDryRun.result?.dryRun, true);
  assert.equal(recoverNextDryRun.result?.availableConfirmations, 1);
  assert.equal(recoverNextDryRun.result?.attemptedConfirmations, 1);
  assert.equal(recoverNextDryRun.result?.results[0]?.sourceAdvanceId, statusBlockedAttempt?.advanceId);
  assert.equal(recoverNextDryRun.result?.results[0]?.dryRun, true);
  assert.equal(recoverNextDryRun.result?.results[0]?.executionSafety.confirmed, true);
  assert.equal(recoverNextDryRun.result?.results[0]?.executionSafety.blocked, false);

  const recoverNextLoopDryRun = await cliJson<{
    ok: boolean;
    session: string;
    dryRun: boolean;
    untilEmpty: boolean;
    maxSteps: number;
    intervalMs: number;
    executedSteps: number;
    stoppedReason: "empty" | "dry_run" | "failed" | "max_steps";
    cycles: Array<{
      ok: boolean;
      selected: { kind: string; action: string; count: number } | null;
      result: { dryRun: boolean; attemptedConfirmations: number } | null;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
    "--until-empty",
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
  ]);
  assert.equal(recoverNextLoopDryRun.ok, true);
  assert.equal(recoverNextLoopDryRun.session, sessionName);
  assert.equal(recoverNextLoopDryRun.dryRun, true);
  assert.equal(recoverNextLoopDryRun.untilEmpty, true);
  assert.equal(recoverNextLoopDryRun.maxSteps, 3);
  assert.equal(recoverNextLoopDryRun.intervalMs, 0);
  assert.equal(recoverNextLoopDryRun.executedSteps, 1);
  assert.equal(recoverNextLoopDryRun.stoppedReason, "dry_run");
  assert.equal(recoverNextLoopDryRun.cycles.length, 1);
  assert.equal(recoverNextLoopDryRun.cycles[0]?.ok, true);
  assert.equal(recoverNextLoopDryRun.cycles[0]?.selected?.kind, "confirmation_queue");
  assert.equal(recoverNextLoopDryRun.cycles[0]?.selected?.action, "drain_control_plane_confirmations");
  assert.equal(recoverNextLoopDryRun.cycles[0]?.result?.dryRun, true);
  assert.equal(recoverNextLoopDryRun.cycles[0]?.result?.attemptedConfirmations, 1);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane worker alert smoke passed");

async function writeSessionRecord(): Promise<void> {
  const sessionPath = path.join(".threadbeat", "worker-sessions", `${sessionName}.json`);
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", "worker-alert-smoke"],
    workers: [],
    stoppedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

async function writeAdvanceWorker(workerId: string): Promise<void> {
  const dir = path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName);
  await fs.mkdir(dir, { recursive: true });
  const stdoutPath = path.join(dir, `${workerId}.out.log`);
  const stderrPath = path.join(dir, `${workerId}.err.log`);
  await fs.writeFile(stdoutPath, "advance stdout\n");
  await fs.writeFile(stderrPath, "advance stderr\n");
  await fs.writeFile(path.join(dir, `${workerId}.json`), `${JSON.stringify({
    session: sessionName,
    workerId,
    mode: "advance_loop",
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-13T10:00:00.000Z",
    command: ["runs", "session-control-plane-advance-loop", sessionName, "--server"],
    pid: null,
    stdoutPath,
    stderrPath,
    stoppedAt: "2026-05-13T10:01:00.000Z",
    stopResult: { stopped: true, signalSent: false, forced: false, alive: false, aliveBefore: false },
    latestResult: null,
  }, null, 2)}\n`);
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  return JSON.parse(await cliText(baseUrl, args)) as T;
}

async function cliText(baseUrl: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
