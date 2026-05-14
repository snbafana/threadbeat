import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { writeWorkerSessionControlPlaneAdvanceRecord } from "../src/workerSessionControlPlaneAdvances.js";

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
    nextActions: Array<{
      surface: string;
      action: string;
      reason: string;
      count: number;
      command: string[];
      workerId?: string;
    }>;
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
  assert.ok(statusSummary.nextActions.some((action) => (
    action.surface === "worker_recovery"
    && action.action === "restart_control_plane_advance_worker"
    && action.workerId === workerId
  )));
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

  const recoverNextMissingMode = await cliFailure(baseUrl, [
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
  ]);
  assert.match(
    recoverNextMissingMode.stderr || recoverNextMissingMode.message,
    /requires exactly one of --dry-run or --confirm/,
  );

  const recoverNextConflictingMode = await cliFailure(baseUrl, [
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
    "--dry-run",
    "--confirm",
  ]);
  assert.match(
    recoverNextConflictingMode.stderr || recoverNextConflictingMode.message,
    /requires exactly one of --dry-run or --confirm/,
  );

  const recoverNextDryRun = await cliJson<{
    ok: boolean;
    session: string;
    dryRun: boolean;
    advanceId: string;
    advancePath: string;
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
    "--dry-run",
  ]);
  assert.equal(recoverNextDryRun.ok, true);
  assert.equal(recoverNextDryRun.session, sessionName);
  assert.equal(recoverNextDryRun.dryRun, true);
  assert.match(recoverNextDryRun.advancePath, /control-plane-advances/);
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
    advanceId: string;
    advancePath: string;
    loopAdvanceId: string;
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
    "--dry-run",
  ]);
  assert.equal(recoverNextLoopDryRun.ok, true);
  assert.equal(recoverNextLoopDryRun.session, sessionName);
  assert.equal(recoverNextLoopDryRun.dryRun, true);
  assert.match(recoverNextLoopDryRun.advancePath, /control-plane-advances/);
  assert.equal(recoverNextLoopDryRun.loopAdvanceId, recoverNextLoopDryRun.advanceId);
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

  const statusAfterRecoverNext = await cliJson<{
    recovery: {
      recoverNext: {
        attempts: { total: number; dryRun: number; executed: number; failed: number };
        recent: Array<{
          advanceId: string;
          detailCommand: string | null;
          dryRun: boolean;
          untilEmpty: boolean;
          stoppedReason: string | null;
          executedSteps: number | null;
          selectedAction: string | null;
          selectedKind: string | null;
          command: string[];
        }>;
        loopSteps: {
          attempts: { total: number; dryRun: number; executed: number; failed: number };
          recent: Array<{
            advanceId: string;
            loopAdvanceId: string | null;
            stepIndex: number | null;
            detailCommand: string | null;
            dryRun: boolean;
            selectedAction: string | null;
            selectedKind: string | null;
            executedExitCode: number | null;
            command: string[];
          }>;
        };
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.attempts.total, 2);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.attempts.dryRun, 2);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.attempts.executed, 1);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.attempts.failed, 0);
  const recentRecoverLoop = statusAfterRecoverNext.recovery.recoverNext.recent.find((attempt) => (
    attempt.advanceId === recoverNextLoopDryRun.advanceId
  ));
  assert.equal(recentRecoverLoop?.detailCommand, "recover_next_loop");
  assert.equal(recentRecoverLoop?.dryRun, true);
  assert.equal(recentRecoverLoop?.untilEmpty, true);
  assert.equal(recentRecoverLoop?.stoppedReason, "dry_run");
  assert.equal(recentRecoverLoop?.executedSteps, 1);
  assert.equal(recentRecoverLoop?.selectedKind, "confirmation_queue");
  assert.equal(recentRecoverLoop?.selectedAction, "drain_control_plane_confirmations");
  assert.deepEqual(recentRecoverLoop?.command, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--advance",
    recoverNextLoopDryRun.advanceId,
  ]);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.loopSteps.attempts.total, 1);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.loopSteps.attempts.dryRun, 1);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.loopSteps.attempts.executed, 1);
  assert.equal(statusAfterRecoverNext.recovery.recoverNext.loopSteps.attempts.failed, 0);
  const recentRecoverLoopStep = statusAfterRecoverNext.recovery.recoverNext.loopSteps.recent[0];
  assert.equal(recentRecoverLoopStep?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(recentRecoverLoopStep?.stepIndex, 1);
  assert.equal(recentRecoverLoopStep?.detailCommand, "recover_next_loop_step");
  assert.equal(recentRecoverLoopStep?.dryRun, true);
  assert.equal(recentRecoverLoopStep?.selectedKind, "confirmation_queue");
  assert.equal(recentRecoverLoopStep?.selectedAction, "drain_control_plane_confirmations");
  assert.equal(recentRecoverLoopStep?.executedExitCode, 0);
  assert.match(recentRecoverLoopStep?.advanceId ?? "", new RegExp(`^${recoverNextLoopDryRun.advanceId}`));

  const statusSummaryText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(statusSummaryText, /control-plane status summary/);
  assert.match(statusSummaryText, /next_recovery:/);
  assert.match(statusSummaryText, /next_actions:/);
  assert.match(statusSummaryText, /surface: worker_recovery/);
  assert.match(statusSummaryText, new RegExp(`command: npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id ${workerId}`));
  assert.match(statusSummaryText, /pending_confirmations: 1/);
  assert.match(statusSummaryText, /recover_next_loop_steps: total=1 dry_run=1 executed=1 failed=0/);
  assert.match(statusSummaryText, /recent_recover_next_loop_steps:/);
  assert.match(statusSummaryText, new RegExp(`advance: ${recoverNextLoopDryRun.advanceId}`));
  assert.match(statusSummaryText, new RegExp(`loop: ${recoverNextLoopDryRun.advanceId}`));
  assert.match(statusSummaryText, /inspect: npm run cli -- runs session-control-plane-advances/);

  const statusSummaryShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
    "--format",
    "shell",
  ]);
  const statusSummaryShellLines = statusSummaryShell.trim().split("\n").filter(Boolean);
  assert.ok(statusSummaryShellLines.some((line) => line.includes("session-control-plane-recover-next")));
  assert.ok(statusSummaryShellLines.some((line) => line.includes("--dry-run")));
  assert.ok(statusSummaryShellLines.some((line) => line === `npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id ${workerId}`));
  assert.ok(statusSummaryShellLines.some((line) => line.includes(`--advance ${recoverNextLoopDryRun.advanceId}`)));
  assert.ok(statusSummaryShellLines.some((line) => line.includes(`--advance ${recentRecoverLoopStep?.advanceId}`)));

  await fs.rm(recoverNextLoopDryRun.advancePath, { force: true });
  const statusAfterRecoverNextInterruption = await cliJson<{
    recovery: {
      recoverNext: {
        incompleteLoops: {
          count: number;
          recent: Array<{
            loopAdvanceId: string;
            steps: number;
            dryRun: boolean;
            lastStepIndex: number | null;
            maxSteps: number | null;
            intervalMs: number | null;
            resumeCommand: string[];
            inspectLastStepCommand: string[];
            inspectHistoryCommand: string[];
            executeResumeCommand: string[];
          }>;
        };
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(statusAfterRecoverNextInterruption.recovery.recoverNext.incompleteLoops.count, 1);
  const interruptedLoop = statusAfterRecoverNextInterruption.recovery.recoverNext.incompleteLoops.recent[0];
  assert.equal(interruptedLoop?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(interruptedLoop?.steps, 1);
  assert.equal(interruptedLoop?.dryRun, true);
  assert.equal(interruptedLoop?.lastStepIndex, 1);
  assert.equal(interruptedLoop?.maxSteps, 3);
  assert.equal(interruptedLoop?.intervalMs, 0);
  assert.deepEqual(interruptedLoop?.resumeCommand, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
    "--until-empty",
    "--resume-loop",
    recoverNextLoopDryRun.advanceId,
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
    "--dry-run",
  ]);
  assert.deepEqual(interruptedLoop?.inspectLastStepCommand, recentRecoverLoopStep?.command);
  assert.deepEqual(interruptedLoop?.inspectHistoryCommand, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
  ]);
  assert.deepEqual(interruptedLoop?.executeResumeCommand, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
    "--execute-resume",
    "--confirm",
  ]);

  const recoverNextAlerts = await cliJson<{
    summary: { total: number; errors: number; warnings: number };
    alerts: Array<{
      surface: string;
      severity: string;
      reason: string;
      action?: string;
      count: number;
      loopAdvanceId?: string;
      command: string[];
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
  ]);
  assert.equal(recoverNextAlerts.summary.total, 1);
  assert.equal(recoverNextAlerts.summary.errors, 0);
  assert.equal(recoverNextAlerts.summary.warnings, 1);
  assert.equal(recoverNextAlerts.alerts[0]?.surface, "recover_next");
  assert.equal(recoverNextAlerts.alerts[0]?.severity, "warning");
  assert.equal(recoverNextAlerts.alerts[0]?.reason, "incomplete_recover_next_loop");
  assert.equal(recoverNextAlerts.alerts[0]?.action, "resume_recover_next_loop");
  assert.equal(recoverNextAlerts.alerts[0]?.count, 1);
  assert.equal(recoverNextAlerts.alerts[0]?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.deepEqual(recoverNextAlerts.alerts[0]?.command, interruptedLoop?.resumeCommand);

  const recoverNextAlertPreview = await cliJson<{
    alert: { surface: string; loopAdvanceId?: string; action?: string; command: string[] } | null;
    details: {
      kind: "recover_next_loop";
      loop: { loopAdvanceId: string; steps: number; dryRun: boolean; lastStepIndex: number | null };
      commands: { resumeLoop: string[]; inspectLastStep: string[]; inspectHistory: string[]; executeResumeHistory: string[]; inspectStatus: string[] };
    } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
  ]);
  assert.equal(recoverNextAlertPreview.alert?.surface, "recover_next");
  assert.equal(recoverNextAlertPreview.alert?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(recoverNextAlertPreview.alert?.action, "resume_recover_next_loop");
  assert.deepEqual(recoverNextAlertPreview.alert?.command, interruptedLoop?.resumeCommand);
  assert.equal(recoverNextAlertPreview.details?.kind, "recover_next_loop");
  assert.equal(recoverNextAlertPreview.details?.loop.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(recoverNextAlertPreview.details?.loop.steps, 1);
  assert.equal(recoverNextAlertPreview.details?.loop.dryRun, true);
  assert.equal(recoverNextAlertPreview.details?.loop.lastStepIndex, 1);
  assert.deepEqual(recoverNextAlertPreview.details?.commands.resumeLoop, interruptedLoop?.resumeCommand);
  assert.deepEqual(recoverNextAlertPreview.details?.commands.inspectLastStep, interruptedLoop?.inspectLastStepCommand);
  assert.deepEqual(recoverNextAlertPreview.details?.commands.inspectHistory, interruptedLoop?.inspectHistoryCommand);
  assert.deepEqual(recoverNextAlertPreview.details?.commands.executeResumeHistory, interruptedLoop?.executeResumeCommand);
  assert.deepEqual(recoverNextAlertPreview.details?.commands.inspectStatus, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);

  const recoverNextAlertCommands = await cliJson<{
    commands: Array<{ action: string; loopAdvanceId?: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--commands-only",
  ]);
  assert.ok(recoverNextAlertCommands.commands.some((command) => (
    command.action === "resume_recover_next_loop"
    && command.loopAdvanceId === recoverNextLoopDryRun.advanceId
    && command.command.join(" ") === interruptedLoop?.resumeCommand.join(" ")
  )));
  assert.ok(recoverNextAlertCommands.commands.some((command) => (
    command.action === "inspect_recover_next_loop_step"
    && command.loopAdvanceId === recoverNextLoopDryRun.advanceId
    && command.command.join(" ") === interruptedLoop?.inspectLastStepCommand.join(" ")
  )));
  assert.ok(recoverNextAlertCommands.commands.some((command) => (
    command.action === "inspect_recover_next_loop_history"
    && command.loopAdvanceId === recoverNextLoopDryRun.advanceId
    && command.command.join(" ") === interruptedLoop?.inspectHistoryCommand.join(" ")
  )));
  assert.ok(recoverNextAlertCommands.commands.some((command) => (
    command.action === "execute_recover_next_loop_history_resume"
    && command.loopAdvanceId === recoverNextLoopDryRun.advanceId
    && command.command.join(" ") === interruptedLoop?.executeResumeCommand.join(" ")
  )));

  const recoverNextAlertText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--format",
    "text",
  ]);
  assert.match(recoverNextAlertText, /surface: recover_next/);
  assert.match(recoverNextAlertText, /reason: incomplete_recover_next_loop/);
  assert.match(recoverNextAlertText, new RegExp(`loop: ${recoverNextLoopDryRun.advanceId}`));
  assert.match(recoverNextAlertText, /recover_next_loop:/);
  assert.match(recoverNextAlertText, /resume_recover_next_loop: npm run cli -- runs session-control-plane-recover-next/);
  assert.match(recoverNextAlertText, /inspect_recover_next_loop_history: npm run cli -- runs session-control-plane-advances/);
  assert.match(recoverNextAlertText, /execute_recover_next_loop_history_resume: npm run cli -- runs session-control-plane-advances/);

  const recoverNextResumeDryRun = await cliJson<{
    advanceId: string;
    dryRun: boolean;
    detailCommand: string;
    selected: { surface: string; action: string; loopAdvanceId?: string; command: string[] } | null;
    alert: { surface: string; reason: string; loopAdvanceId?: string } | null;
    executed: null;
    executionSafety: {
      blocked: boolean;
      mutating: boolean;
      confirmationRequired: boolean;
      confirmed: boolean;
      confirmationCommand: string[] | null;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--detail-command",
    "resume_recover_next_loop",
    "--dry-run",
  ]);
  assert.equal(recoverNextResumeDryRun.dryRun, true);
  assert.equal(recoverNextResumeDryRun.detailCommand, "resume_recover_next_loop");
  assert.equal(recoverNextResumeDryRun.selected?.surface, "recover_next");
  assert.equal(recoverNextResumeDryRun.selected?.action, "resume_recover_next_loop");
  assert.equal(recoverNextResumeDryRun.selected?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.deepEqual(recoverNextResumeDryRun.selected?.command, interruptedLoop?.resumeCommand);
  assert.equal(recoverNextResumeDryRun.executed, null);
  assert.equal(recoverNextResumeDryRun.executionSafety.blocked, false);
  assert.equal(recoverNextResumeDryRun.executionSafety.mutating, true);
  assert.equal(recoverNextResumeDryRun.executionSafety.confirmationRequired, true);
  assert.equal(recoverNextResumeDryRun.executionSafety.confirmed, false);
  assert.equal(recoverNextResumeDryRun.executionSafety.confirmationCommand, null);

  const statusAfterRecoverNextResumeAttempt = await cliJson<{
    recovery: {
      recoverNext: {
        resumeAttempts: {
          attempts: { total: number; dryRun: number; executed: number; failed: number };
          recent: Array<{
            advanceId: string;
            detailCommand: string | null;
            dryRun: boolean;
            executed: boolean;
            failed: boolean;
            selectedSurface: string | null;
            selectedAction: string | null;
            command: string[];
          }>;
          failedRecent: Array<{ advanceId: string }>;
        };
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.attempts.total, 1);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.attempts.dryRun, 1);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.attempts.executed, 0);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.attempts.failed, 0);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.advanceId, recoverNextResumeDryRun.advanceId);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.detailCommand, "resume_recover_next_loop");
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.dryRun, true);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.executed, false);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.failed, false);
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.selectedSurface, "recover_next");
  assert.equal(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.selectedAction, "resume_recover_next_loop");
  assert.deepEqual(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.recent[0]?.command, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--advance",
    recoverNextResumeDryRun.advanceId,
    "--alert-surface",
    "recover_next",
    "--detail-command",
    "resume_recover_next_loop",
  ]);
  assert.deepEqual(statusAfterRecoverNextResumeAttempt.recovery.recoverNext.resumeAttempts.failedRecent, []);

  const recoverNextResumeHistory = await cliJson<{
    filter: { loopAdvanceIds: string[]; alertSurfaces: string[]; detailCommands: string[] };
    advances: Array<{
      advanceId: string;
      detailCommand?: string;
      selected: { surface: string; action: string; loopAdvanceId?: string } | null;
      alert?: { surface: string; reason: string; loopAdvanceId?: string } | null;
      executionSafety?: { blocked: boolean; mutating: boolean; confirmationRequired: boolean; confirmed: boolean };
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--alert-surface",
    "recover_next",
    "--detail-command",
    "resume_recover_next_loop",
  ]);
  assert.deepEqual(recoverNextResumeHistory.filter.loopAdvanceIds, [recoverNextLoopDryRun.advanceId]);
  assert.deepEqual(recoverNextResumeHistory.filter.alertSurfaces, ["recover_next"]);
  assert.deepEqual(recoverNextResumeHistory.filter.detailCommands, ["resume_recover_next_loop"]);
  const recoverNextResumeHistoryRecord = recoverNextResumeHistory.advances.find((advance) => advance.advanceId === recoverNextResumeDryRun.advanceId);
  assert.equal(recoverNextResumeHistoryRecord?.detailCommand, "resume_recover_next_loop");
  assert.equal(recoverNextResumeHistoryRecord?.selected?.surface, "recover_next");
  assert.equal(recoverNextResumeHistoryRecord?.selected?.action, "resume_recover_next_loop");
  assert.equal(recoverNextResumeHistoryRecord?.selected?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(recoverNextResumeHistoryRecord?.alert?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(recoverNextResumeHistoryRecord?.executionSafety?.mutating, true);
  assert.equal(recoverNextResumeHistoryRecord?.executionSafety?.confirmationRequired, true);

  const recoverNextResumeHistoryText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--alert-surface",
    "recover_next",
    "--detail-command",
    "resume_recover_next_loop",
    "--format",
    "text",
  ]);
  assert.match(recoverNextResumeHistoryText, new RegExp(`loops=${recoverNextLoopDryRun.advanceId}`));
  assert.match(recoverNextResumeHistoryText, /detail_command: resume_recover_next_loop/);
  assert.match(recoverNextResumeHistoryText, /alert: recover_next incomplete_recover_next_loop/);
  assert.match(recoverNextResumeHistoryText, new RegExp(`loop: ${recoverNextLoopDryRun.advanceId}`));

  const recoverNextLoopHistory = await cliJson<{
    loopAdvanceId: string;
    count: number;
    summary: { completed: boolean; steps: number; resumeAttempts: number; failedExecutions: number; dryRunRecords: number; stoppedReasons: string[] };
    commands: { inspectRaw: string[]; resumeLoop: string[] | null; executeResume: string[] | null };
    records: Array<{
      kind: string;
      advanceId: string;
      detailCommand: string | null;
      stepIndex: number | null;
      stoppedReason: string | null;
      selectedAction: string | null;
      executedExitCode: number | null;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
  ]);
  assert.equal(recoverNextLoopHistory.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(recoverNextLoopHistory.count, 2);
  assert.equal(recoverNextLoopHistory.summary.completed, false);
  assert.equal(recoverNextLoopHistory.summary.steps, 1);
  assert.equal(recoverNextLoopHistory.summary.resumeAttempts, 1);
  assert.equal(recoverNextLoopHistory.summary.failedExecutions, 0);
  assert.equal(recoverNextLoopHistory.summary.dryRunRecords, 2);
  assert.deepEqual(recoverNextLoopHistory.summary.stoppedReasons, ["dry_run"]);
  assert.deepEqual(recoverNextLoopHistory.commands.inspectRaw, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
  ]);
  assert.deepEqual(recoverNextLoopHistory.commands.resumeLoop, interruptedLoop?.resumeCommand);
  assert.deepEqual(recoverNextLoopHistory.commands.executeResume, interruptedLoop?.executeResumeCommand);
  assert.ok(recoverNextLoopHistory.records.some((record) => (
    record.kind === "step"
    && record.advanceId === `${recoverNextLoopDryRun.advanceId}-step-001`
    && record.detailCommand === "recover_next_loop_step"
    && record.stepIndex === 1
    && record.stoppedReason === "dry_run"
  )));
  assert.ok(recoverNextLoopHistory.records.some((record) => (
    record.kind === "resume_attempt"
    && record.advanceId === recoverNextResumeDryRun.advanceId
    && record.detailCommand === "resume_recover_next_loop"
    && record.selectedAction === "resume_recover_next_loop"
  )));

  const recoverNextLoopHistoryText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
    "--format",
    "text",
  ]);
  assert.match(recoverNextLoopHistoryText, /recover-next loop history/);
  assert.match(recoverNextLoopHistoryText, /summary: completed=false steps=1 resume_attempts=1 failed=0 dry_run_records=2 stopped_reasons=dry_run/);
  assert.match(recoverNextLoopHistoryText, /resume: npm run cli -- runs session-control-plane-recover-next/);
  assert.match(recoverNextLoopHistoryText, /execute_resume: npm run cli -- runs session-control-plane-advances/);
  assert.match(recoverNextLoopHistoryText, /- step:/);
  assert.match(recoverNextLoopHistoryText, /- resume_attempt:/);

  const interruptedSummaryText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(interruptedSummaryText, /recover_next_resume_attempts: total=1 dry_run=1 executed=0 failed=0/);
  assert.match(interruptedSummaryText, /recent_recover_next_resume_attempts:/);
  assert.match(interruptedSummaryText, new RegExp(`advance: ${recoverNextResumeDryRun.advanceId}`));
  assert.match(interruptedSummaryText, /detail_command: resume_recover_next_loop/);
  assert.match(interruptedSummaryText, /recover_next_incomplete_loops: 1/);
  assert.match(interruptedSummaryText, /incomplete_recover_next_loops:/);
  assert.match(interruptedSummaryText, new RegExp(`resume: npm run cli -- runs session-control-plane-recover-next ${sessionName} --server --until-empty --resume-loop ${recoverNextLoopDryRun.advanceId}`));
  assert.match(interruptedSummaryText, new RegExp(`inspect_history: npm run cli -- runs session-control-plane-advances ${sessionName} --server --loop-advance-id ${recoverNextLoopDryRun.advanceId} --recover-next-loop-history`));
  assert.match(interruptedSummaryText, new RegExp(`execute_resume: npm run cli -- runs session-control-plane-advances ${sessionName} --server --loop-advance-id ${recoverNextLoopDryRun.advanceId} --recover-next-loop-history --execute-resume --confirm`));
  const interruptedSummaryShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
    "--format",
    "shell",
  ]);
  const interruptedSummaryShellLines = interruptedSummaryShell.trim().split("\n").filter(Boolean);
  assert.ok(interruptedSummaryShellLines.some((line) => line.includes(`--resume-loop ${recoverNextLoopDryRun.advanceId}`)));
  assert.ok(interruptedSummaryShellLines.some((line) => line.includes(`--advance ${recoverNextResumeDryRun.advanceId}`)));
  assert.ok(interruptedSummaryShellLines.some((line) => line.includes(`--loop-advance-id ${recoverNextLoopDryRun.advanceId} --recover-next-loop-history --execute-resume --confirm`)));

  const resumedRecoverNextLoopExecution = await cliJson<{
    ok: boolean;
    session: string;
    loopAdvanceId: string;
    command: string[];
    before: { summary: { completed: boolean; steps: number; resumeAttempts: number }; commands: { resumeLoop: string[] | null } };
    executed: {
      exitCode: number | null;
      output: {
        ok: boolean;
        session: string;
        dryRun: boolean;
        untilEmpty: boolean;
        resumed: boolean;
        previousSteps: number;
        executedSteps: number;
        advanceId: string;
        loopAdvanceId: string;
        cycles: Array<{ selected: { kind: string; action: string } | null }>;
      };
    };
    after: {
      summary: { completed: boolean; steps: number; resumeAttempts: number; failedExecutions: number };
      commands: { resumeLoop: string[] | null };
      records: Array<{ kind: string; advanceId: string; stepIndex: number | null }>;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
    "--execute-resume",
    "--confirm",
  ]);
  assert.equal(resumedRecoverNextLoopExecution.ok, true);
  assert.equal(resumedRecoverNextLoopExecution.session, sessionName);
  assert.equal(resumedRecoverNextLoopExecution.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.deepEqual(resumedRecoverNextLoopExecution.command, interruptedLoop?.resumeCommand);
  assert.equal(resumedRecoverNextLoopExecution.before.summary.completed, false);
  assert.equal(resumedRecoverNextLoopExecution.before.summary.steps, 1);
  assert.equal(resumedRecoverNextLoopExecution.before.summary.resumeAttempts, 1);
  assert.deepEqual(resumedRecoverNextLoopExecution.before.commands.resumeLoop, interruptedLoop?.resumeCommand);
  assert.equal(resumedRecoverNextLoopExecution.executed.exitCode, 0);
  const resumedRecoverNextLoopDryRun = resumedRecoverNextLoopExecution.executed.output;
  assert.equal(resumedRecoverNextLoopDryRun.ok, true);
  assert.equal(resumedRecoverNextLoopDryRun.session, sessionName);
  assert.equal(resumedRecoverNextLoopDryRun.dryRun, true);
  assert.equal(resumedRecoverNextLoopDryRun.untilEmpty, true);
  assert.equal(resumedRecoverNextLoopDryRun.resumed, true);
  assert.equal(resumedRecoverNextLoopDryRun.previousSteps, 1);
  assert.equal(resumedRecoverNextLoopDryRun.executedSteps, 2);
  assert.equal(resumedRecoverNextLoopDryRun.advanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(resumedRecoverNextLoopDryRun.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(resumedRecoverNextLoopDryRun.cycles.length, 1);
  assert.equal(resumedRecoverNextLoopDryRun.cycles[0]?.selected?.kind, "confirmation_queue");
  assert.equal(resumedRecoverNextLoopDryRun.cycles[0]?.selected?.action, "drain_control_plane_confirmations");
  assert.equal(resumedRecoverNextLoopExecution.after.summary.completed, true);
  assert.equal(resumedRecoverNextLoopExecution.after.summary.steps, 2);
  assert.equal(resumedRecoverNextLoopExecution.after.summary.resumeAttempts, 1);
  assert.equal(resumedRecoverNextLoopExecution.after.summary.failedExecutions, 0);
  assert.equal(resumedRecoverNextLoopExecution.after.commands.resumeLoop, null);
  assert.ok(resumedRecoverNextLoopExecution.after.records.some((record) => (
    record.kind === "loop"
    && record.advanceId === recoverNextLoopDryRun.advanceId
  )));
  assert.ok(resumedRecoverNextLoopExecution.after.records.some((record) => (
    record.kind === "step"
    && record.stepIndex === 2
    && record.advanceId === `${recoverNextLoopDryRun.advanceId}-step-002`
  )));
  const statusAfterRecoverNextResume = await cliJson<{
    recovery: {
      recoverNext: {
        loopSteps: { attempts: { total: number; dryRun: number; executed: number; failed: number }; recent: Array<{ advanceId: string; loopAdvanceId: string | null; stepIndex: number | null }> };
        incompleteLoops: { count: number };
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(statusAfterRecoverNextResume.recovery.recoverNext.loopSteps.attempts.total, 2);
  assert.equal(statusAfterRecoverNextResume.recovery.recoverNext.loopSteps.attempts.dryRun, 2);
  assert.equal(statusAfterRecoverNextResume.recovery.recoverNext.loopSteps.attempts.executed, 2);
  assert.equal(statusAfterRecoverNextResume.recovery.recoverNext.loopSteps.attempts.failed, 0);
  assert.equal(statusAfterRecoverNextResume.recovery.recoverNext.incompleteLoops.count, 0);
  assert.ok(statusAfterRecoverNextResume.recovery.recoverNext.loopSteps.recent.some((step) => (
    step.loopAdvanceId === recoverNextLoopDryRun.advanceId
      && step.stepIndex === 2
      && step.advanceId === `${recoverNextLoopDryRun.advanceId}-step-002`
  )));

  const failedResumeAdvanceId = `failed-resume-${Date.now().toString(36)}`;
  await writeWorkerSessionControlPlaneAdvanceRecord(path.resolve("."), {
    advanceId: failedResumeAdvanceId,
    session: sessionName,
    observedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    dryRun: false,
    selected: {
      surface: "recover_next",
      action: "resume_recover_next_loop",
      reason: "incomplete_recover_next_loop",
      loopAdvanceId: recoverNextLoopDryRun.advanceId,
      command: interruptedLoop?.resumeCommand,
    },
    alert: {
      surface: "recover_next",
      severity: "warning",
      reason: "incomplete_recover_next_loop",
      action: "resume_recover_next_loop",
      loopAdvanceId: recoverNextLoopDryRun.advanceId,
    },
    detailCommand: "resume_recover_next_loop",
    recovery: null,
    executed: { command: interruptedLoop?.resumeCommand, exitCode: 1, stdout: "", stderr: "resume failed" },
    executionSafety: { detailCommand: "resume_recover_next_loop", mutating: true, confirmationRequired: true, confirmed: true, blocked: false },
    before: null,
    after: null,
  });

  const failedRecoverNextResumeAlerts = await cliJson<{
    summary: { total: number; errors: number; warnings: number };
    alerts: Array<{ surface: string; severity: string; reason: string; action?: string; advanceId?: string; loopAdvanceId?: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--reason",
    "failed_recover_next_resume_attempt",
  ]);
  assert.equal(failedRecoverNextResumeAlerts.summary.total, 1);
  assert.equal(failedRecoverNextResumeAlerts.summary.errors, 1);
  assert.equal(failedRecoverNextResumeAlerts.summary.warnings, 0);
  assert.equal(failedRecoverNextResumeAlerts.alerts[0]?.surface, "recover_next");
  assert.equal(failedRecoverNextResumeAlerts.alerts[0]?.severity, "error");
  assert.equal(failedRecoverNextResumeAlerts.alerts[0]?.reason, "failed_recover_next_resume_attempt");
  assert.equal(failedRecoverNextResumeAlerts.alerts[0]?.action, "inspect_recover_next_resume_attempt");
  assert.equal(failedRecoverNextResumeAlerts.alerts[0]?.advanceId, failedResumeAdvanceId);
  assert.equal(failedRecoverNextResumeAlerts.alerts[0]?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.ok(failedRecoverNextResumeAlerts.alerts[0]?.command.includes(failedResumeAdvanceId));

  const failedRecoverNextResumeAlert = await cliJson<{
    alert: { reason: string; action?: string; advanceId?: string; loopAdvanceId?: string; command: string[] } | null;
    details: {
      kind: "recover_next_resume_attempt";
      attempt: { advanceId: string; loopAdvanceId: string | null; failed: boolean; executedExitCode: number | null };
      commands: { inspectAttempt: string[]; inspectHistory: string[] | null; inspectStatus: string[] };
    } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--reason",
    "failed_recover_next_resume_attempt",
  ]);
  assert.equal(failedRecoverNextResumeAlert.alert?.advanceId, failedResumeAdvanceId);
  assert.equal(failedRecoverNextResumeAlert.alert?.action, "inspect_recover_next_resume_attempt");
  assert.equal(failedRecoverNextResumeAlert.details?.kind, "recover_next_resume_attempt");
  assert.equal(failedRecoverNextResumeAlert.details?.attempt.advanceId, failedResumeAdvanceId);
  assert.equal(failedRecoverNextResumeAlert.details?.attempt.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(failedRecoverNextResumeAlert.details?.attempt.failed, true);
  assert.equal(failedRecoverNextResumeAlert.details?.attempt.executedExitCode, 1);
  assert.deepEqual(failedRecoverNextResumeAlert.details?.commands.inspectAttempt, failedRecoverNextResumeAlert.alert?.command);
  assert.deepEqual(failedRecoverNextResumeAlert.details?.commands.inspectHistory, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
  ]);

  const failedRecoverNextResumeAlertText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--reason",
    "failed_recover_next_resume_attempt",
    "--format",
    "text",
  ]);
  assert.match(failedRecoverNextResumeAlertText, /reason: failed_recover_next_resume_attempt/);
  assert.match(failedRecoverNextResumeAlertText, /recover_next_resume_attempt:/);
  assert.match(failedRecoverNextResumeAlertText, new RegExp(`advance: ${failedResumeAdvanceId}`));
  assert.match(failedRecoverNextResumeAlertText, /inspect_recover_next_resume_attempt: npm run cli -- runs session-control-plane-advances/);

  const failedRecoverNextResumeAdvances = await cliJson<{
    count: number;
    summary: { total: number; failed: number; executed: number };
    filter: { detailCommands: string[] };
    advances: Array<{
      advanceId: string;
      detailCommand?: string;
      executed: { exitCode: number | null } | null;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--failed-recover-next-resumes",
  ]);
  assert.equal(failedRecoverNextResumeAdvances.count, 1);
  assert.equal(failedRecoverNextResumeAdvances.summary.total, 1);
  assert.equal(failedRecoverNextResumeAdvances.summary.failed, 1);
  assert.equal(failedRecoverNextResumeAdvances.summary.executed, 1);
  assert.deepEqual(failedRecoverNextResumeAdvances.filter.detailCommands, ["resume_recover_next_loop"]);
  assert.equal(failedRecoverNextResumeAdvances.advances[0]?.advanceId, failedResumeAdvanceId);
  assert.equal(failedRecoverNextResumeAdvances.advances[0]?.detailCommand, "resume_recover_next_loop");
  assert.equal(failedRecoverNextResumeAdvances.advances[0]?.executed?.exitCode, 1);

  const failedRecoverNextResumeAdvancesText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--failed-recover-next-resumes",
    "--format",
    "text",
  ]);
  assert.match(failedRecoverNextResumeAdvancesText, /count: 1/);
  assert.match(failedRecoverNextResumeAdvancesText, new RegExp(`advance: ${failedResumeAdvanceId}`));
  assert.match(failedRecoverNextResumeAdvancesText, /detail_command: resume_recover_next_loop/);
  assert.match(failedRecoverNextResumeAdvancesText, /executed: exit_code=1/);

  const failedRecoverNextResumeCommands = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--failed-recover-next-resumes",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(failedRecoverNextResumeCommands, new RegExp(`--advance ${failedResumeAdvanceId}`));
  assert.match(failedRecoverNextResumeCommands, /--alert-surface recover_next --detail-command resume_recover_next_loop/);

  const statusAfterFailedRecoverNextResume = await cliJson<{
    recovery: {
      failedRecoverNextResumeLoops: {
        count: number;
        recent: Array<{
          loopAdvanceId: string | null;
          failedAttempts: number;
          latestFailedAdvanceId: string;
          latestFailedExitCode: number | null;
          incomplete: boolean;
          commands: {
            inspectFailedResumes: string[];
            inspectHistory: string[] | null;
            resumeLoop: string[] | null;
            executeResumeHistory: string[] | null;
          };
        }>;
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.count, 1);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.loopAdvanceId, recoverNextLoopDryRun.advanceId);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.failedAttempts, 1);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.latestFailedAdvanceId, failedResumeAdvanceId);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.latestFailedExitCode, 1);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.incomplete, false);
  assert.deepEqual(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.commands.inspectFailedResumes, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--failed-recover-next-resumes",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
  ]);
  assert.deepEqual(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.commands.inspectHistory, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    recoverNextLoopDryRun.advanceId,
    "--recover-next-loop-history",
  ]);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.commands.resumeLoop, null);
  assert.equal(statusAfterFailedRecoverNextResume.recovery.failedRecoverNextResumeLoops.recent[0]?.commands.executeResumeHistory, null);

  const statusAfterFailedRecoverNextResumeText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(statusAfterFailedRecoverNextResumeText, /failed_recover_next_resumes: npm run cli -- runs session-control-plane-advances/);
  assert.match(statusAfterFailedRecoverNextResumeText, /--failed-recover-next-resumes/);
  assert.match(statusAfterFailedRecoverNextResumeText, /failed_recover_next_resume_loops:/);
  assert.match(statusAfterFailedRecoverNextResumeText, new RegExp(`loop: ${recoverNextLoopDryRun.advanceId}`));
  assert.match(statusAfterFailedRecoverNextResumeText, new RegExp(`latest_failed_advance: ${failedResumeAdvanceId}`));
  assert.match(statusAfterFailedRecoverNextResumeText, /incomplete: false/);
  assert.match(statusAfterFailedRecoverNextResumeText, new RegExp(`inspect_failed_resumes: npm run cli -- runs session-control-plane-advances ${sessionName} --server --failed-recover-next-resumes --loop-advance-id ${recoverNextLoopDryRun.advanceId}`));
  assert.match(statusAfterFailedRecoverNextResumeText, new RegExp(`inspect_history: npm run cli -- runs session-control-plane-advances ${sessionName} --server --loop-advance-id ${recoverNextLoopDryRun.advanceId} --recover-next-loop-history`));

  const statusAfterFailedRecoverNextResumeShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
    "--format",
    "shell",
  ]);
  const statusAfterFailedRecoverNextResumeShellLines = statusAfterFailedRecoverNextResumeShell.trim().split("\n");
  assert.ok(statusAfterFailedRecoverNextResumeShellLines.some((line) => line.includes("--failed-recover-next-resumes")));
  assert.ok(statusAfterFailedRecoverNextResumeShellLines.some((line) => line.includes(`--failed-recover-next-resumes --loop-advance-id ${recoverNextLoopDryRun.advanceId}`)));
  assert.ok(statusAfterFailedRecoverNextResumeShellLines.some((line) => line.includes(`--loop-advance-id ${recoverNextLoopDryRun.advanceId} --recover-next-loop-history`)));
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

async function cliFailure(
  baseUrl: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; message: string }> {
  try {
    await cliText(baseUrl, args);
  } catch (error) {
    const typed = error as Error & { stdout?: string; stderr?: string };
    return { stdout: typed.stdout ?? "", stderr: typed.stderr ?? "", message: typed.message };
  }
  throw new Error(`expected CLI command to fail: ${args.join(" ")}`);
}
