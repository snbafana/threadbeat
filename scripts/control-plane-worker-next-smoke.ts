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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-worker-next-smoke-"));
const sessionName = `worker-next-${Date.now().toString(36)}`;
const replayStatusSessionName = `${sessionName}-replay-status`;
const selectedAdvanceWorkerId = "advance-worker-selected";
const otherAdvanceWorkerId = "advance-worker-other";
const exitedAdvanceWorkerId = "advance-worker-exited";
const selectedTickWorkerId = "tick-worker-selected";
const otherTickWorkerId = "tick-worker-other";
const exitedTickWorkerId = "tick-worker-exited";
const replayLoopWorkerId = "replay-loop-worker-selected";
const statusReplayLoopWorkerId = "replay-loop-worker-status";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-worker-next-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-worker-next-smoke",
};

const { app } = await buildServer(settings);

try {
  await writeWorkerSessionRecord(sessionName);
  await writeAdvanceWorker(selectedAdvanceWorkerId);
  await writeAdvanceWorker(otherAdvanceWorkerId);
  await writeAdvanceWorker(exitedAdvanceWorkerId, { stopped: false });
  await writeTickWorker(selectedTickWorkerId);
  await writeTickWorker(otherTickWorkerId);
  await writeTickWorker(exitedTickWorkerId, { stopped: false });

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const advanceAll = await cliJson<WorkerNextResponse>(baseUrl, [
    "runs",
    "session-control-plane-advance-workers-next",
    sessionName,
    "--server",
  ]);
  assert.equal(advanceAll.count, 3);

  const advanceSelected = await cliJson<WorkerNextResponse>(baseUrl, [
    "runs",
    "session-control-plane-advance-workers-next",
    sessionName,
    "--server",
    "--worker-id",
    selectedAdvanceWorkerId,
  ]);
  assert.equal(advanceSelected.count, 1);
  assert.equal(advanceSelected.actions.restart_control_plane_advance_worker, 1);
  assert.deepEqual(advanceSelected.nextSteps.map((step) => step.workerId), [selectedAdvanceWorkerId]);
  assert.equal(
    advanceSelected.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id ${selectedAdvanceWorkerId}`,
  );

  const advanceExited = await cliJson<WorkerNextResponse>(baseUrl, [
    "runs",
    "session-control-plane-advance-workers-next",
    sessionName,
    "--server",
    "--worker-id",
    exitedAdvanceWorkerId,
  ]);
  assert.equal(advanceExited.count, 1);
  assert.equal(advanceExited.nextSteps[0]?.reason, "worker_exited_without_stop_or_completion_record");
  assert.equal(
    advanceExited.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id ${exitedAdvanceWorkerId}`,
  );
  const advanceExitedTimeline = await cliJson<WorkerTimelineResponse>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--event",
    "worker_exited_unrecorded",
    "--worker",
    exitedAdvanceWorkerId,
  ]);
  assert.equal(advanceExitedTimeline.count, 1);
  assert.equal(advanceExitedTimeline.counts.worker_exited_unrecorded, 1);
  assert.equal(advanceExitedTimeline.events[0]?.source, "control_plane_advance_worker");
  assert.equal(advanceExitedTimeline.events[0]?.event, "worker_exited_unrecorded");
  assert.equal(advanceExitedTimeline.events[0]?.state, "exited_unrecorded");
  assert.equal(advanceExitedTimeline.events[0]?.restartable, true);
  assert.equal(advanceExitedTimeline.events[0]?.reason, "worker_exited_without_stop_or_completion_record");

  const tickAll = await cliJson<WorkerNextResponse>(baseUrl, [
    "runs",
    "session-control-plane-tick-workers-next",
    sessionName,
    "--server",
  ]);
  assert.equal(tickAll.count, 3);

  const tickSelected = await cliJson<WorkerNextResponse>(baseUrl, [
    "runs",
    "session-control-plane-tick-workers-next",
    sessionName,
    "--server",
    "--worker-id",
    selectedTickWorkerId,
  ]);
  assert.equal(tickSelected.count, 1);
  assert.equal(tickSelected.actions.restart_control_plane_tick_worker, 1);
  assert.deepEqual(tickSelected.nextSteps.map((step) => step.workerId), [selectedTickWorkerId]);
  assert.equal(
    tickSelected.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-tick-workers ${sessionName} --server --worker-id ${selectedTickWorkerId}`,
  );

  const tickExited = await cliJson<WorkerNextResponse>(baseUrl, [
    "runs",
    "session-control-plane-tick-workers-next",
    sessionName,
    "--server",
    "--worker-id",
    exitedTickWorkerId,
  ]);
  assert.equal(tickExited.count, 1);
  assert.equal(tickExited.nextSteps[0]?.reason, "worker_exited_without_stop_or_completion_record");
  assert.equal(
    tickExited.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-tick-workers ${sessionName} --server --worker-id ${exitedTickWorkerId}`,
  );
  const tickExitedTimeline = await cliJson<WorkerTimelineResponse>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--event",
    "worker_exited_unrecorded",
    "--worker",
    exitedTickWorkerId,
  ]);
  assert.equal(tickExitedTimeline.count, 1);
  assert.equal(tickExitedTimeline.counts.worker_exited_unrecorded, 1);
  assert.equal(tickExitedTimeline.events[0]?.source, "control_plane_tick_worker");
  assert.equal(tickExitedTimeline.events[0]?.event, "worker_exited_unrecorded");
  assert.equal(tickExitedTimeline.events[0]?.state, "exited_unrecorded");
  assert.equal(tickExitedTimeline.events[0]?.restartable, true);
  assert.equal(tickExitedTimeline.events[0]?.reason, "worker_exited_without_stop_or_completion_record");

  const aggregate = await cliJson<WorkerAggregateResponse>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
  ]);
  assert.equal(aggregate.summary.exitedUnrecorded, 2);
  assert.equal(aggregate.summary.advance.exitedUnrecorded, 1);
  assert.equal(aggregate.summary.tick.exitedUnrecorded, 1);
  assert.equal(
    aggregate.commands.reconcileDryRun.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --dry-run`,
  );
  assert.equal(
    aggregate.commands.reconcileConfirm.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --confirm`,
  );
  assert.equal(
    aggregate.commands.reconcileUntilEmptyConfirm.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --confirm`,
  );
  const reconcileLoopPreview = await cliJson<WorkerReconcileLoopResponse>(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--dry-run",
    "--until-empty",
    "--max-steps",
    "3",
    "--interval-ms",
    "1",
  ]);
  assert.equal(reconcileLoopPreview.ok, true);
  assert.equal(reconcileLoopPreview.untilEmpty, true);
  assert.equal(reconcileLoopPreview.dryRun, true);
  assert.equal(reconcileLoopPreview.confirmed, false);
  assert.equal(reconcileLoopPreview.passed, null);
  assert.equal(reconcileLoopPreview.stoppedReason, "dry_run");
  assert.equal(reconcileLoopPreview.summary.iterations, 1);
  assert.equal(reconcileLoopPreview.summary.lastPlannedCount, 6);
  assert.equal(reconcileLoopPreview.summary.totalExecuted, 0);
  assert.equal(
    reconcileLoopPreview.commands.confirm.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 3 --interval-ms 1 --confirm`,
  );
  assert.match(reconcileLoopPreview.reconciliationRecord.reconciliationId, /^[0-9A-Za-z-]+$/);
  const reconcileTimeline = await cliJson<WorkerTimelineResponse>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--source",
    "worker_reconcile_execution",
    "--event",
    "worker_reconcile_executed",
    "--execution",
    reconcileLoopPreview.reconciliationRecord.reconciliationId,
  ]);
  assert.equal(reconcileTimeline.count, 1);
  assert.equal(reconcileTimeline.counts.worker_reconcile_executed, 1);
  assert.equal(reconcileTimeline.events[0]?.source, "worker_reconcile_execution");
  assert.equal(reconcileTimeline.events[0]?.event, "worker_reconcile_executed");
  assert.equal(reconcileTimeline.events[0]?.executionId, reconcileLoopPreview.reconciliationRecord.reconciliationId);
  assert.equal(reconcileTimeline.events[0]?.status, "dry_run");
  assert.equal(reconcileTimeline.events[0]?.reason, "dry_run");
  assert.equal(reconcileTimeline.events[0]?.iterations, 1);
  assert.equal(reconcileTimeline.events[0]?.totalPlanned, 6);
  assert.equal(reconcileTimeline.events[0]?.totalExecuted, 0);
  const statusSummary = await cliJson<WorkerStatusSummaryResponse>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "5",
  ]);
  assert.equal(statusSummary.needsAction, true);
  assert.equal(statusSummary.nextRecovery?.surface, "worker_recovery");
  assert.equal(statusSummary.nextRecovery?.action, "reconcile_control_plane_workers");
  assert.equal(statusSummary.nextRecovery?.reason, "restartable_workers_pending_reconcile");
  assert.equal(statusSummary.nextRecovery?.count, 6);
  assert.equal(
    statusSummary.nextRecovery?.dryRunCommand.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --dry-run`,
  );
  assert.equal(
    statusSummary.nextRecovery?.command.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --confirm`,
  );
  assert.equal(statusSummary.recovery.workerReconciliations.counts.total, 1);
  assert.equal(statusSummary.recovery.workerReconciliations.counts.dryRun, 1);
  assert.equal(statusSummary.recovery.workerReconciliations.counts.untilEmpty, 1);
  assert.equal(
    statusSummary.recovery.workerReconciliations.recent[0]?.reconciliationId,
    reconcileLoopPreview.reconciliationRecord.reconciliationId,
  );
  const statusSummaryText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "5",
    "--format",
    "text",
  ]);
  assert.match(statusSummaryText, /worker_reconciliations: total=1 dry_run=1 executed=0 noop=0 failed=0 max_steps=0 until_empty=1/);
  assert.match(statusSummaryText, new RegExp(`inspect: npm run cli -- runs session-control-plane-worker-reconciliations ${sessionName} --server`));
  assert.match(statusSummaryText, new RegExp(`reconciliation: ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`));
  assert.match(statusSummaryText, /action: reconcile_control_plane_workers/);
  assert.match(statusSummaryText, /reason: restartable_workers_pending_reconcile/);
  assert.match(statusSummaryText, new RegExp(`command: npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --confirm`));
  const statusSummaryShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "5",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(
    statusSummaryShell,
    new RegExp(`npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 3 --interval-ms 1 --confirm`),
  );
  assert.match(
    statusSummaryShell,
    new RegExp(`npm run cli -- runs session-control-plane-worker-reconciliations ${sessionName} --server`),
  );
  assert.match(
    statusSummaryShell,
    new RegExp(`npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --dry-run`),
  );
  assert.match(
    statusSummaryShell,
    new RegExp(`npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --confirm`),
  );
  const workerReconciliations = await cliJson<WorkerReconciliationsResponse>(baseUrl, [
    "runs",
    "session-control-plane-worker-reconciliations",
    sessionName,
    "--server",
    "--limit",
    "5",
  ]);
  assert.equal(workerReconciliations.counts.total, 1);
  assert.equal(workerReconciliations.counts.dryRun, 1);
  assert.equal(workerReconciliations.records.length, 1);
  assert.equal(workerReconciliations.latest?.reconciliationId, reconcileLoopPreview.reconciliationRecord.reconciliationId);
  assert.equal(workerReconciliations.records[0]?.reconciliationId, reconcileLoopPreview.reconciliationRecord.reconciliationId);
  assert.equal(workerReconciliations.records[0]?.commands.inspectRecord.join(" "), `npm run cli -- runs session-control-plane-worker-reconciliations ${sessionName} --server --reconciliation ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`);
  assert.equal(workerReconciliations.records[0]?.commands.timeline.join(" "), `npm run cli -- runs session-control-plane-timeline ${sessionName} --server --source worker_reconcile_execution --execution ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`);
  assert.equal(workerReconciliations.records[0]?.commands.confirm.join(" "), `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 3 --interval-ms 1 --confirm`);
  const workerReconciliationsText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-worker-reconciliations",
    sessionName,
    "--server",
    "--latest",
    "--format",
    "text",
  ]);
  assert.match(workerReconciliationsText, /control_plane_worker_reconciliations:/);
  assert.match(workerReconciliationsText, new RegExp(`reconciliation: ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`));
  assert.match(workerReconciliationsText, new RegExp(`timeline: npm run cli -- runs session-control-plane-timeline ${sessionName} --server --source worker_reconcile_execution --execution ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`));
  const workerReconciliationsShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-worker-reconciliations",
    sessionName,
    "--server",
    "--latest",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(workerReconciliationsShell, new RegExp(`npm run cli -- runs session-control-plane-worker-reconciliations ${sessionName} --server --reconciliation ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`));
  assert.match(workerReconciliationsShell, new RegExp(`npm run cli -- runs session-control-plane-timeline ${sessionName} --server --source worker_reconcile_execution --execution ${reconcileLoopPreview.reconciliationRecord.reconciliationId}`));
  const watchedWorkerRecovery = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--watch",
    "--until-action",
    "--execute-action",
    "--dry-run",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  const watchedWorkerRecoveryLines = watchedWorkerRecovery.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    executedAction?: {
      advanceId: string;
      reason: string;
      command: string[];
      executed: { command: string[]; exitCode: number | null };
    };
  });
  assert.equal(watchedWorkerRecoveryLines.length, 1);
  assert.equal(watchedWorkerRecoveryLines[0]?.executedAction?.reason, "control_plane_action:reconcile_control_plane_workers");
  assert.deepEqual(
    watchedWorkerRecoveryLines[0]?.executedAction?.command,
    ["npm", "run", "cli", "--", "runs", "session-control-plane-reconcile-workers", sessionName, "--server", "--lines", "20", "--until-empty", "--max-steps", "10", "--interval-ms", "2000", "--dry-run"],
  );
  assert.equal(watchedWorkerRecoveryLines[0]?.executedAction?.executed.exitCode, 0);
  const workerRecoveryStatusWatchAdvances = await cliJson<{
    count: number;
    filter: { selectedSurfaces: string[]; selectedActions: string[]; detailCommands: string[] };
    advances: Array<{ advanceId: string; detailCommand: string; selected: { surface: string; action: string }; executed: { command: string[]; exitCode: number | null } }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--status-watch-executions",
    "--selected-surface",
    "worker_recovery",
    "--selected-action",
    "reconcile_control_plane_workers",
  ]);
  assert.equal(workerRecoveryStatusWatchAdvances.count, 1);
  assert.deepEqual(workerRecoveryStatusWatchAdvances.filter.selectedSurfaces, ["worker_recovery"]);
  assert.deepEqual(workerRecoveryStatusWatchAdvances.filter.selectedActions, ["reconcile_control_plane_workers"]);
  assert.deepEqual(workerRecoveryStatusWatchAdvances.filter.detailCommands, ["status_watch_execute_action"]);
  assert.equal(workerRecoveryStatusWatchAdvances.advances[0]?.advanceId, watchedWorkerRecoveryLines[0]?.executedAction?.advanceId);
  assert.equal(workerRecoveryStatusWatchAdvances.advances[0]?.detailCommand, "status_watch_execute_action");
  assert.equal(workerRecoveryStatusWatchAdvances.advances[0]?.selected.surface, "worker_recovery");
  assert.equal(workerRecoveryStatusWatchAdvances.advances[0]?.selected.action, "reconcile_control_plane_workers");
  assert.equal(workerRecoveryStatusWatchAdvances.advances[0]?.executed.exitCode, 0);
  const workerRecoveryStatusWatchText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--status-watch-executions",
    "--selected-surface",
    "worker_recovery",
    "--selected-action",
    "reconcile_control_plane_workers",
    "--format",
    "text",
  ]);
  assert.match(workerRecoveryStatusWatchText, /selected_surfaces=worker_recovery/);
  assert.match(workerRecoveryStatusWatchText, /selected_actions=reconcile_control_plane_workers/);
  const reconcileLoopText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--dry-run",
    "--until-empty",
    "--max-steps",
    "3",
    "--interval-ms",
    "1",
    "--format",
    "text",
  ]);
  assert.match(reconcileLoopText, /control_plane_worker_reconcile_loop:/);
  assert.match(reconcileLoopText, /stopped_reason: dry_run/);
  assert.match(reconcileLoopText, /summary: iterations=1 total_planned=6 total_executed=0 last_planned=6/);
  assert.match(reconcileLoopText, new RegExp(`confirm: npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 3 --interval-ms 1 --confirm`));
  const aggregateText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--format",
    "text",
  ]);
  assert.match(aggregateText, /all: total=6 alive=0 stopped=4 completed=0 retired=0 exited_unrecorded=2 restartable=6/);
  assert.match(aggregateText, /advance: total=3 alive=0 stopped=2 completed=0 retired=0 exited_unrecorded=1 restartable=3/);
  assert.match(aggregateText, /tick: total=3 alive=0 stopped=2 completed=0 retired=0 exited_unrecorded=1 restartable=3/);
  assert.match(aggregateText, new RegExp(`reconcile_dry_run: npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --dry-run`));
  assert.match(aggregateText, new RegExp(`reconcile_confirm: npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --confirm`));
  assert.match(aggregateText, new RegExp(`reconcile_until_empty_confirm: npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --confirm`));

  await cliJson(baseUrl, [
    "runs",
    "start-terminal-overview-replay-loop-worker",
    sessionName,
    "--server",
    "--worker-id",
    replayLoopWorkerId,
    "--dry-run",
    "--max-steps",
    "1",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop-terminal-overview-replay-loop-workers",
    sessionName,
    "--server",
    "--worker-id",
    replayLoopWorkerId,
    "--lines",
    "1",
  ]);
  const replayLoopAggregate = await cliJson<WorkerAggregateResponse>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--worker-id",
    replayLoopWorkerId,
    "--include-retired",
    "--lines",
    "1",
  ]);
  assert.equal(replayLoopAggregate.summary.terminalOverviewReplayLoop.total, 1);
  assert.equal(replayLoopAggregate.summary.terminalOverviewReplayLoop.stopped, 1);
  assert.equal(replayLoopAggregate.summary.terminalOverviewReplayLoop.restartable, 1);
  assert.equal(replayLoopAggregate.nextSteps.length, 1);
  assert.equal(replayLoopAggregate.nextSteps[0]?.kind, "terminal_overview_replay_loop");
  assert.equal(replayLoopAggregate.nextSteps[0]?.action, "restart_terminal_overview_replay_loop_worker");
  assert.equal(replayLoopAggregate.nextSteps[0]?.workerId, replayLoopWorkerId);
  assert.equal(
    replayLoopAggregate.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-terminal-overview-replay-loop-worker ${sessionName} --server --worker-id ${replayLoopWorkerId} --include-retired`,
  );
  const replayLoopReconcilePreview = await cliJson<WorkerReconcileResponse>(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--kind",
    "terminal-overview-replay-loop",
    "--worker-id",
    replayLoopWorkerId,
    "--include-retired",
    "--dry-run",
    "--lines",
    "1",
  ]);
  assert.equal(replayLoopReconcilePreview.dryRun, true);
  assert.equal(replayLoopReconcilePreview.confirmed, false);
  assert.equal(replayLoopReconcilePreview.plan.count, 1);
  assert.equal(replayLoopReconcilePreview.plan.steps[0]?.kind, "terminal_overview_replay_loop");
  assert.deepEqual(replayLoopReconcilePreview.plan.commands[0], replayLoopAggregate.nextSteps[0]?.command);
  const replayLoopReconcileConfirm = await cliJson<WorkerReconcileResponse>(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--kind",
    "terminal-overview-replay-loop",
    "--worker-id",
    replayLoopWorkerId,
    "--include-retired",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(replayLoopReconcileConfirm.dryRun, false);
  assert.equal(replayLoopReconcileConfirm.confirmed, true);
  assert.equal(replayLoopReconcileConfirm.passed, true);
  assert.equal(replayLoopReconcileConfirm.plan.count, 1);
  assert.equal(replayLoopReconcileConfirm.executed.length, 1);
  assert.equal(replayLoopReconcileConfirm.executed[0]?.kind, "terminal_overview_replay_loop");
  assert.equal(replayLoopReconcileConfirm.executed[0]?.restartCount, 1);
  assert.equal(replayLoopReconcileConfirm.remaining?.length, 0);
  await cliJson(baseUrl, [
    "runs",
    "stop-terminal-overview-replay-loop-workers",
    sessionName,
    "--server",
    "--worker-id",
    replayLoopWorkerId,
    "--retire",
    "--lines",
    "1",
  ]);

  await writeWorkerSessionRecord(replayStatusSessionName);
  await cliJson(baseUrl, [
    "runs",
    "start-terminal-overview-replay-loop-worker",
    replayStatusSessionName,
    "--server",
    "--worker-id",
    statusReplayLoopWorkerId,
    "--dry-run",
    "--max-steps",
    "1",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop-terminal-overview-replay-loop-workers",
    replayStatusSessionName,
    "--server",
    "--worker-id",
    statusReplayLoopWorkerId,
    "--lines",
    "1",
  ]);
  const replayStatusSummary = await cliJson<WorkerStatusSummaryResponse>(baseUrl, [
    "runs",
    "session-control-plane-status",
    replayStatusSessionName,
    "--server",
    "--summary",
    "--lines",
    "5",
  ]);
  assert.equal(replayStatusSummary.needsAction, true);
  assert.equal(replayStatusSummary.nextRecovery?.surface, "worker_recovery");
  assert.equal(replayStatusSummary.nextRecovery?.action, "reconcile_control_plane_workers");
  assert.equal(replayStatusSummary.nextRecovery?.count, 1);
  assert.equal(replayStatusSummary.nextActions[0]?.surface, "worker_recovery");
  assert.equal(replayStatusSummary.nextActions[0]?.workerKind, "terminal_overview_replay_loop");
  assert.equal(replayStatusSummary.nextActions[0]?.workerId, statusReplayLoopWorkerId);
  assert.equal(
    replayStatusSummary.nextRecovery?.dryRunCommand.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${replayStatusSessionName} --server --kind terminal-overview-replay-loop --worker-id ${statusReplayLoopWorkerId} --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --dry-run`,
  );
  assert.equal(
    replayStatusSummary.nextRecovery?.command.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${replayStatusSessionName} --server --kind terminal-overview-replay-loop --worker-id ${statusReplayLoopWorkerId} --lines 20 --until-empty --max-steps 10 --interval-ms 2000 --confirm`,
  );
  const replayStatusWatch = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    replayStatusSessionName,
    "--server",
    "--summary",
    "--watch",
    "--until-action",
    "--execute-action",
    "--dry-run",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  const replayStatusWatchLines = replayStatusWatch.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    executedAction?: {
      reason: string;
      command: string[];
      executed: { command: string[]; exitCode: number | null };
    };
  });
  assert.equal(replayStatusWatchLines.length, 1);
  assert.equal(replayStatusWatchLines[0]?.executedAction?.reason, "control_plane_action:reconcile_control_plane_workers");
  assert.deepEqual(
    replayStatusWatchLines[0]?.executedAction?.command,
    [
      "npm", "run", "cli", "--", "runs", "session-control-plane-reconcile-workers", replayStatusSessionName, "--server",
      "--kind", "terminal-overview-replay-loop", "--worker-id", statusReplayLoopWorkerId,
      "--lines", "20", "--until-empty", "--max-steps", "10", "--interval-ms", "2000", "--dry-run",
    ],
  );
  assert.equal(replayStatusWatchLines[0]?.executedAction?.executed.exitCode, 0);
  await cliJson(baseUrl, [
    "runs",
    "stop-terminal-overview-replay-loop-workers",
    replayStatusSessionName,
    "--server",
    "--worker-id",
    statusReplayLoopWorkerId,
    "--retire",
    "--lines",
    "1",
  ]);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${replayStatusSessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-tick-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "terminal-overview-replay-loop-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "terminal-overview-replay-loop-workers", replayStatusSessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "terminal-overview-replay-loops", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "terminal-overview-replay-loops", replayStatusSessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-worker-reconciliations", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-worker-reconciliations", replayStatusSessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", replayStatusSessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane worker next smoke passed");

type WorkerNextResponse = {
  count: number;
  actions: Record<string, number>;
  nextSteps: Array<{ workerId: string; reason: string; command: string[] }>;
};

type WorkerTimelineResponse = {
  count: number;
  counts: Record<string, number>;
  events: Array<{
    source: string;
    event: string;
    executionId?: string;
    status?: string;
    state?: string;
    restartable?: boolean;
    reason?: string;
    iterations?: number;
    totalPlanned?: number;
    totalExecuted?: number;
  }>;
};

type WorkerAggregateResponse = {
  summary: {
    exitedUnrecorded: number;
    advance: { exitedUnrecorded: number };
    tick: { exitedUnrecorded: number };
    terminalOverviewReplayLoop: { total: number; stopped: number; restartable: number };
  };
  nextSteps: Array<{ kind: string; action: string | null; workerId: string | null; command: string[] }>;
  commands: {
    reconcileDryRun: string[];
    reconcileConfirm: string[];
    reconcileUntilEmptyConfirm: string[];
  };
};

type WorkerReconcileResponse = {
  dryRun: boolean;
  confirmed: boolean;
  passed: boolean | null;
  plan: {
    count: number;
    steps: Array<{ kind: string; workerId: string; command: string[] }>;
    commands: string[][];
  };
  executed: Array<{ kind: string; workerId: string; restartCount: number | null }>;
  remaining: Array<{ kind: string; workerId: string }> | null;
};

type WorkerStatusSummaryResponse = {
  needsAction: boolean;
  nextRecovery: {
    surface: string;
    action: string;
    reason: string;
    count: number;
    command: string[];
    dryRunCommand: string[];
  } | null;
  nextActions: Array<{
    surface: string;
    workerKind?: string;
    workerId?: string;
  }>;
  recovery: {
    workerReconciliations: {
      counts: {
        total: number;
        dryRun: number;
        executed: number;
        noop: number;
        failed: number;
        maxSteps: number;
        untilEmpty: number;
      };
      recent: Array<{ reconciliationId: string }>;
    };
  };
};

type WorkerReconciliationsResponse = {
  counts: {
    total: number;
    dryRun: number;
  };
  latest: { reconciliationId: string } | null;
  records: Array<{
    reconciliationId: string;
    commands: {
      inspectRecord: string[];
      timeline: string[];
      confirm: string[];
    };
  }>;
};

type WorkerReconcileLoopResponse = {
  ok: true;
  untilEmpty: true;
  dryRun: boolean;
  confirmed: boolean;
  passed: boolean | null;
  stoppedReason: string;
  summary: {
    iterations: number;
    lastPlannedCount: number | null;
    totalExecuted: number;
  };
  commands: {
    confirm: string[];
  };
  reconciliationRecord: {
    reconciliationId: string;
  };
};

async function writeWorkerSessionRecord(recordSessionName: string): Promise<void> {
  const sessionDir = path.join(".threadbeat", "worker-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `${recordSessionName}.json`), `${JSON.stringify({
    session: recordSessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-14T00:00:00.000Z",
    command: ["runs", "work", "--agent", "agt_worker_next"],
    workers: [],
    stoppedAt: "2026-05-14T00:00:01.000Z",
  }, null, 2)}\n`);
}

async function writeAdvanceWorker(workerId: string, options: { stopped?: boolean } = {}): Promise<void> {
  const dir = path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName);
  await fs.mkdir(dir, { recursive: true });
  const recordPath = path.join(dir, `${workerId}.json`);
  const stdoutPath = path.join(dir, `${workerId}.out.log`);
  const stderrPath = path.join(dir, `${workerId}.err.log`);
  await fs.writeFile(stdoutPath, "");
  await fs.writeFile(stderrPath, "");
  const stopped = options.stopped ?? true;
  await fs.writeFile(recordPath, `${JSON.stringify({
    session: sessionName,
    workerId,
    mode: "advance_loop",
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-13T10:00:00.000Z",
    command: ["runs", "session-control-plane-advance-loop", sessionName, "--server"],
    pid: null,
    stdoutPath,
    stderrPath,
    ...(stopped ? {
      stoppedAt: "2026-05-13T10:01:00.000Z",
      stopResult: { stopped: true, signalSent: false, forced: false, alive: false, aliveBefore: false },
    } : {}),
    latestResult: null,
  }, null, 2)}\n`);
}

async function writeTickWorker(workerId: string, options: { stopped?: boolean } = {}): Promise<void> {
  const dir = path.join(".threadbeat", "worker-sessions", "control-plane-tick-workers", sessionName);
  await fs.mkdir(dir, { recursive: true });
  const recordPath = path.join(dir, `${workerId}.json`);
  const stdoutPath = path.join(dir, `${workerId}.out.log`);
  const stderrPath = path.join(dir, `${workerId}.err.log`);
  await fs.writeFile(stdoutPath, "");
  await fs.writeFile(stderrPath, "");
  const stopped = options.stopped ?? true;
  await fs.writeFile(recordPath, `${JSON.stringify({
    session: sessionName,
    workerId,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-13T10:00:00.000Z",
    command: ["runs", "session-control-plane-tick-loop", sessionName, "--server"],
    pid: null,
    stdoutPath,
    stderrPath,
    ...(stopped ? {
      stoppedAt: "2026-05-13T10:01:00.000Z",
      stopResult: { stopped: true, signalSent: false, forced: false, alive: false, aliveBefore: false },
    } : {}),
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
