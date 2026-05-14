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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-status-topology-smoke-"));
const sessionName = `status-topology-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-status-topology-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-status-topology-smoke",
};

const { app } = await buildServer(settings);

try {
  await writeWorkerSessionRecord();
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const summary = await cliJson<{
    commands: {
      inspectTopology: string[];
      ensureTopologyDryRun: string[];
      ensureTopologyConfirm: string[];
      ensureTopologyLoopDryRun: string[];
      ensureTopologyLoopConfirm: string[];
      startTopologyWorkerDryRun: string[];
      ensureTopologyWorkerConfirm: string[];
      inspectTopologyWorkers: string[];
      topologyWorkerNextSteps: string[];
      inspectControlPlaneWorkers: string[];
      inspectControlPlaneWorkerProgress: string[];
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(summary.commands.inspectTopology.join(" "), `npm run cli -- runs session-control-plane-topology ${sessionName} --server`);
  assert.equal(summary.commands.ensureTopologyDryRun.join(" "), `npm run cli -- runs ensure-control-plane-topology ${sessionName} --server --dry-run`);
  assert.equal(summary.commands.ensureTopologyConfirm.join(" "), `npm run cli -- runs ensure-control-plane-topology ${sessionName} --server --confirm`);
  assert.equal(summary.commands.ensureTopologyLoopDryRun.join(" "), `npm run cli -- runs ensure-control-plane-topology-loop ${sessionName} --server --dry-run --max-iterations 3 --loop-interval-ms 2000`);
  assert.equal(summary.commands.ensureTopologyLoopConfirm.join(" "), `npm run cli -- runs ensure-control-plane-topology-loop ${sessionName} --server --confirm --max-iterations 3 --loop-interval-ms 2000`);
  assert.equal(summary.commands.startTopologyWorkerDryRun.join(" "), `npm run cli -- runs start-control-plane-topology-worker ${sessionName} --server --dry-run --max-iterations 60 --loop-interval-ms 2000`);
  assert.equal(summary.commands.ensureTopologyWorkerConfirm.join(" "), `npm run cli -- runs ensure-control-plane-topology-worker ${sessionName} --server --confirm --max-iterations 60 --loop-interval-ms 2000`);
  assert.equal(summary.commands.inspectTopologyWorkers.join(" "), `npm run cli -- runs session-control-plane-topology-workers ${sessionName} --server`);
  assert.equal(summary.commands.topologyWorkerNextSteps.join(" "), `npm run cli -- runs session-control-plane-topology-workers-next ${sessionName} --server`);
  assert.equal(summary.commands.inspectControlPlaneWorkers.join(" "), `npm run cli -- runs session-control-plane-workers ${sessionName} --server --include-retired --lines 5`);
  assert.equal(summary.commands.inspectControlPlaneWorkerProgress.join(" "), `npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --include-retired --limit 5`);

  const commandQueue = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.inspectTopology.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.ensureTopologyLoopDryRun.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.ensureTopologyLoopConfirm.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.startTopologyWorkerDryRun.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.ensureTopologyWorkerConfirm.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.inspectTopologyWorkers.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.topologyWorkerNextSteps.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.inspectControlPlaneWorkers.join(" ")));
  assert.ok(commandQueue.commands.some((command) => command.command.join(" ") === summary.commands.inspectControlPlaneWorkerProgress.join(" ")));

  const text = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(text, /^control_plane_topology:$/m);
  assert.match(text, new RegExp(`ensure_loop_dry_run: .*ensure-control-plane-topology-loop ${sessionName}`));
  assert.match(text, new RegExp(`start_worker_dry_run: .*start-control-plane-topology-worker ${sessionName}`));
  assert.match(text, new RegExp(`inspect_workers: .*session-control-plane-topology-workers ${sessionName}`));
  assert.match(text, /^control_plane_workers:$/m);
  assert.match(text, new RegExp(`inspect_all: .*session-control-plane-workers ${sessionName} --server --include-retired --lines 5`));
  assert.match(text, new RegExp(`inspect_progress: .*session-control-plane-worker-progress ${sessionName} --server --include-retired --limit 5`));
  assert.match(text, /^worker_health:$/m);
  assert.match(text, /watch: total=0 alive=0 stopped=0 retired=0/);
  assert.match(text, /topology_loop: total=0 alive=0 stopped=0 retired=0 completed=0/);
  assert.match(text, /result_review_loop: total=0 alive=0 stopped=0 retired=0 completed=0/);
  assert.match(text, /bundle_recovery_loop: total=0 alive=0 stopped=0 retired=0 completed=0/);
  assert.match(text, /^control_plane_worker_progress:$/m);
  assert.match(text, /latest_results: count=0 recorded=0 progress=0 recent_progress=0/);
  const watchedSummary = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--watch",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  const watchedSummaryLines = watchedSummary.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    ok: boolean;
    session: string;
    poll: number;
    summary: { session: string; workers: { controlPlaneAdvance: { latestResults: unknown[] } } };
  });
  assert.equal(watchedSummaryLines.length, 2);
  assert.equal(watchedSummaryLines[0]?.ok, true);
  assert.equal(watchedSummaryLines[0]?.session, sessionName);
  assert.equal(watchedSummaryLines[0]?.poll, 1);
  assert.equal(watchedSummaryLines[1]?.poll, 2);
  assert.equal(watchedSummaryLines[0]?.summary.session, sessionName);
  assert.deepEqual(watchedSummaryLines[0]?.summary.workers.controlPlaneAdvance.latestResults, []);
  const watchedUntilActionEmpty = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--watch",
    "--until-action",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  const watchedUntilActionEmptyLines = watchedUntilActionEmpty.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    poll: number;
    untilAction: { done: boolean; reason: string | null; command: string[] | null; dryRunCommand: string[] | null };
  });
  assert.equal(watchedUntilActionEmptyLines.length, 2);
  assert.equal(watchedUntilActionEmptyLines[0]?.untilAction.done, false);
  assert.equal(watchedUntilActionEmptyLines[0]?.untilAction.reason, null);
  assert.equal(watchedUntilActionEmptyLines[0]?.untilAction.command, null);
  const watchedText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--watch",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
    "--format",
    "text",
  ]);
  assert.match(watchedText, /^control-plane status watch poll=1 observed_at=/m);
  assert.match(watchedText, /^control-plane status summary$/m);
  assert.match(watchedText, /^control_plane_worker_progress:$/m);

  const workerId = "status-topology-worker";
  const started = await cliJson<{ worker: { workerId: string; mode: string; command: string[] } }>(baseUrl, [
    "runs",
    "start-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
    "--dry-run",
    "--max-iterations",
    "1",
    "--loop-interval-ms",
    "0",
    "--lines",
    "5",
  ]);
  assert.equal(started.worker.workerId, workerId);
  assert.equal(started.worker.mode, "topology_loop");
  assert.deepEqual(started.worker.command, [
    "runs",
    "ensure-control-plane-topology-loop",
    sessionName,
    "--server",
    "--dry-run",
    "--max-iterations",
    "1",
    "--loop-interval-ms",
    "0",
    "--lines",
    "5",
    "--progress-json",
  ]);
  const inspected = await cliJson<{ count: number; workers: Array<{ workerId: string; mode: string }> }>(baseUrl, [
    "runs",
    "session-control-plane-topology-workers",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
    "--lines",
    "1",
  ]);
  assert.equal(inspected.count, 1);
  assert.equal(inspected.workers[0]?.workerId, workerId);
  assert.equal(inspected.workers[0]?.mode, "topology_loop");
  const completedTopologyWorker = await waitForTopologyWorkerResult(baseUrl, workerId, { iterations: 1, state: "completed" });
  assert.equal(completedTopologyWorker.latestResult?.iterations, 1);
  assert.equal(completedTopologyWorker.latestResult?.totalCoreExecuted, 0);
  assert.equal(completedTopologyWorker.latestResult?.totalMutationExecuted, 0);
  const completedWorkerRecord = await readTopologyWorkerRecord(workerId);
  assert.equal(completedWorkerRecord.recentProgress?.length, 1);
  assert.equal(completedWorkerRecord.recentProgress?.[0]?.iterations, 1);
  const completedStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(completedStatusText, /control_plane_advance: total=1 alive=0 stopped=0 retired=0 completed=1/);
  assert.match(completedStatusText, /topology_loop: total=1 alive=0 stopped=0 retired=0 completed=1/);
  assert.match(completedStatusText, /control_plane_worker_progress:/);
  assert.match(completedStatusText, /latest_results: count=1 recorded=1 progress=0 recent_progress=1/);
  assert.match(completedStatusText, new RegExp(`worker: ${workerId}`));
  assert.match(completedStatusText, /mode: topology_loop/);
  assert.match(completedStatusText, /source: recorded/);
  assert.match(completedStatusText, /iterations: 1/);
  assert.match(completedStatusText, /core: 0/);
  assert.match(completedStatusText, /mutation: 0/);
  assert.match(completedStatusText, new RegExp(`inspect: npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --worker-id ${workerId} --kind control-plane-topology --limit 5`));
  const completedStatusCommands = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(completedStatusCommands.commands.some((command) => (
    command.command.join(" ") === `npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --worker-id ${workerId} --kind control-plane-topology --limit 5`
  )));

  const aggregateBeforeStop = await cliJson<{
    summary: {
      topology: {
        total: number;
        latestResults: {
          count: number;
          recorded: number;
          progress: number;
          recentProgress: number;
          iterations: number;
          totalCoreExecuted: number;
          totalMutationExecuted: number;
        };
      };
      advance: { total: number; latestResults: { count: number; recorded: number; progress: number; recentProgress: number } };
    };
    workers: Array<{ kind: string; workerId: string | null; latestResultSource?: string; latestProgress?: unknown; recentProgress?: unknown[]; commands: { restart: string[] } | null }>;
    commands: { inspectTopologyWorkers: string[]; inspectProgress: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "1",
  ]);
  assert.equal(aggregateBeforeStop.summary.topology.total, 1);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.count, 1);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.recorded, 1);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.progress, 0);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.recentProgress, 1);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.iterations, 1);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.totalCoreExecuted, 0);
  assert.equal(aggregateBeforeStop.summary.topology.latestResults.totalMutationExecuted, 0);
  assert.equal(aggregateBeforeStop.summary.advance.total, 0);
  assert.equal(aggregateBeforeStop.summary.advance.latestResults.count, 0);
  assert.equal(aggregateBeforeStop.summary.advance.latestResults.recorded, 0);
  assert.equal(aggregateBeforeStop.summary.advance.latestResults.progress, 0);
  assert.equal(aggregateBeforeStop.summary.advance.latestResults.recentProgress, 0);
  const aggregateTopologyWorker = aggregateBeforeStop.workers.find((worker) => worker.workerId === workerId);
  assert.equal(aggregateTopologyWorker?.kind, "control_plane_topology");
  assert.equal(aggregateTopologyWorker?.latestResultSource, "recorded");
  assert.equal(aggregateTopologyWorker?.latestProgress, null);
  assert.equal(aggregateTopologyWorker?.recentProgress?.length, 1);
  assert.equal(
    aggregateTopologyWorker?.commands?.restart.join(" "),
    `npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId} --include-retired`,
  );
  assert.equal(
    aggregateBeforeStop.commands.inspectTopologyWorkers.join(" "),
    `npm run cli -- runs session-control-plane-topology-workers ${sessionName} --server --include-retired --lines 1`,
  );
  assert.equal(
    aggregateBeforeStop.commands.inspectProgress.join(" "),
    `npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --include-retired --limit 5`,
  );

  const bundleRecoveryWorkerId = "status-bundle-recovery-worker";
  const startedBundleRecovery = await cliJson<{ worker: { workerId: string; mode: string; command: string[] } }>(baseUrl, [
    "runs",
    "start-control-plane-worker-bundle-recovery-worker",
    sessionName,
    "--server",
    "--worker-id",
    bundleRecoveryWorkerId,
    "--dry-run",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
    "--lines",
    "1",
  ]);
  assert.equal(startedBundleRecovery.worker.workerId, bundleRecoveryWorkerId);
  assert.equal(startedBundleRecovery.worker.mode, "bundle_recovery_loop");
  assert.deepEqual(startedBundleRecovery.worker.command, [
    "runs",
    "recover-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--loop",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
    "--lines",
    "1",
    "--progress-json",
    "--dry-run",
  ]);
  const completedBundleRecoveryWorker = await waitForBundleRecoveryWorkerResult(baseUrl, bundleRecoveryWorkerId, { state: "completed" });
  assert.equal(completedBundleRecoveryWorker.latestResult?.profileCount, 0);
  assert.equal(completedBundleRecoveryWorker.latestResult?.planned, 0);
  assert.equal(completedBundleRecoveryWorker.latestResult?.actionable, 0);
  assert.equal(completedBundleRecoveryWorker.latestResult?.blocked, 0);
  assert.equal(completedBundleRecoveryWorker.latestResult?.executed, 0);
  assert.equal(completedBundleRecoveryWorker.latestResult?.polls, 1);
  const bundleRecoveryStatus = await cliJson<{
    workers: {
      controlPlaneAdvance: {
        modes: { bundle_recovery_loop: { total: number; alive: number; stopped: number; retired: number; completed: number } };
        latestResults: Array<{ workerId: string; mode: string; latestResultSource: string; latestResult: { profileCount?: number; polls?: number } }>;
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.deepEqual(bundleRecoveryStatus.workers.controlPlaneAdvance.modes.bundle_recovery_loop, {
    total: 1,
    alive: 0,
    stopped: 0,
    retired: 0,
    completed: 1,
  });
  const bundleRecoveryLatestResult = bundleRecoveryStatus.workers.controlPlaneAdvance.latestResults.find((result) => result.workerId === bundleRecoveryWorkerId);
  assert.equal(bundleRecoveryLatestResult?.mode, "bundle_recovery_loop");
  assert.equal(bundleRecoveryLatestResult?.latestResultSource, "recorded");
  assert.equal(bundleRecoveryLatestResult?.latestResult.profileCount, 0);
  assert.equal(bundleRecoveryLatestResult?.latestResult.polls, 1);
  const bundleRecoveryStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(bundleRecoveryStatusText, /bundle_recovery_loop: total=1 alive=0 stopped=0 retired=0 completed=1/);
  assert.match(bundleRecoveryStatusText, new RegExp(`worker: ${bundleRecoveryWorkerId}`));
  assert.match(bundleRecoveryStatusText, /mode: bundle_recovery_loop/);
  assert.match(bundleRecoveryStatusText, /profile_count: 0/);
  assert.match(bundleRecoveryStatusText, /planned: 0/);
  assert.match(bundleRecoveryStatusText, /actionable: 0/);
  assert.match(bundleRecoveryStatusText, /blocked: 0/);
  assert.match(bundleRecoveryStatusText, /executed: 0/);
  assert.match(bundleRecoveryStatusText, /polls: 1/);
  assert.match(bundleRecoveryStatusText, new RegExp(`inspect: npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --worker-id ${bundleRecoveryWorkerId} --kind control-plane-bundle-recovery --limit 5`));
  const completedProgress = await cliJson<{
    count: number;
    progress: Array<{ kind: string; workerId: string | null; state: string | null; source: string | null; iterations?: number; stoppedReason?: string }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-progress",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
    "--kind",
    "topology",
    "--include-retired",
    "--limit",
    "5",
  ]);
  assert.equal(completedProgress.count, 1);
  assert.equal(completedProgress.progress[0]?.kind, "control_plane_topology");
  assert.equal(completedProgress.progress[0]?.workerId, workerId);
  assert.equal(completedProgress.progress[0]?.state, "completed");
  assert.equal(completedProgress.progress[0]?.source, "recorded");
  assert.equal(completedProgress.progress[0]?.iterations, 1);
  assert.equal(completedProgress.progress[0]?.stoppedReason, "running");
  const completedProgressTimeline = await cliJson<{
    count: number;
    counts: Record<string, number>;
    events: Array<{
      source: string;
      event: string;
      workerId?: string;
      status?: string;
      reason?: string;
      mode?: string;
      progressIndex?: number;
      progressTotal?: number;
      iterations?: number;
      totalCoreExecuted?: number;
      totalMutationExecuted?: number;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--event",
    "worker_progress_recorded",
    "--worker",
    workerId,
    "--status",
    "running",
    "--limit",
    "5",
  ]);
  assert.equal(completedProgressTimeline.count, 1);
  assert.equal(completedProgressTimeline.counts.worker_progress_recorded, 1);
  assert.equal(completedProgressTimeline.events[0]?.source, "control_plane_advance_worker");
  assert.equal(completedProgressTimeline.events[0]?.event, "worker_progress_recorded");
  assert.equal(completedProgressTimeline.events[0]?.workerId, workerId);
  assert.equal(completedProgressTimeline.events[0]?.status, "running");
  assert.equal(completedProgressTimeline.events[0]?.reason, "running");
  assert.equal(completedProgressTimeline.events[0]?.mode, "topology_loop");
  assert.equal(completedProgressTimeline.events[0]?.progressIndex, 1);
  assert.equal(completedProgressTimeline.events[0]?.progressTotal, 1);
  assert.equal(completedProgressTimeline.events[0]?.iterations, 1);
  assert.equal(completedProgressTimeline.events[0]?.totalCoreExecuted, 0);
  assert.equal(completedProgressTimeline.events[0]?.totalMutationExecuted, 0);
  const completedProgressText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-worker-progress",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
    "--kind",
    "topology",
    "--include-retired",
    "--limit",
    "5",
    "--format",
    "text",
  ]);
  assert.match(completedProgressText, /^control_plane_worker_progress:$/m);
  assert.match(completedProgressText, new RegExp(`worker=${workerId} state=completed source=recorded index=1/1 iterations=1 reason=running`));
  const aggregateTextBeforeStop = await cliText(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(aggregateTextBeforeStop, /^control_plane_workers:$/m);
  assert.match(aggregateTextBeforeStop, new RegExp(`session: ${sessionName}`));
  assert.match(aggregateTextBeforeStop, /topology: total=1 alive=0 stopped=0 completed=1 retired=0 exited_unrecorded=0 restartable=0 latest_results=count=1,recorded=1,progress=0,recent_progress=1,iterations=1,core=0,mutation=0/);
  assert.match(aggregateTextBeforeStop, new RegExp(`inspect_topology: npm run cli -- runs session-control-plane-topology-workers ${sessionName} --server --include-retired --lines 1`));
  assert.match(aggregateTextBeforeStop, new RegExp(`inspect_progress: npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --include-retired --limit 5`));

  await cliJson(baseUrl, [
    "runs",
    "stop-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
    "--lines",
    "1",
  ]);
  const watchedUntilActionStopped = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--watch",
    "--until-action",
    "--max-polls",
    "5",
    "--interval-ms",
    "1",
  ]);
  const watchedUntilActionStoppedLines = watchedUntilActionStopped.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    poll: number;
    untilAction: { done: boolean; reason: string | null; command: string[] | null; dryRunCommand: string[] | null };
  });
  assert.equal(watchedUntilActionStoppedLines.length, 1);
  assert.equal(watchedUntilActionStoppedLines[0]?.poll, 1);
  assert.equal(watchedUntilActionStoppedLines[0]?.untilAction.done, true);
  assert.equal(watchedUntilActionStoppedLines[0]?.untilAction.reason, "control_plane_action:restart_control_plane_advance_worker");
  assert.deepEqual(watchedUntilActionStoppedLines[0]?.untilAction.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server"]);
  assert.deepEqual(watchedUntilActionStoppedLines[0]?.untilAction.dryRunCommand, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--dry-run"]);
  const watchedUntilActionDryRun = await cliText(baseUrl, [
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
    "5",
    "--interval-ms",
    "1",
  ]);
  const watchedUntilActionDryRunLines = watchedUntilActionDryRun.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    poll: number;
    untilAction: { done: boolean; reason: string | null; command: string[] | null; dryRunCommand: string[] | null };
    executedAction?: { dryRun: boolean; reason: string; command: string[]; advanceId: string; advancePath: string; executed: { command: string[]; exitCode: number | null } };
  });
  assert.equal(watchedUntilActionDryRunLines.length, 1);
  assert.equal(watchedUntilActionDryRunLines[0]?.untilAction.done, true);
  assert.equal(watchedUntilActionDryRunLines[0]?.executedAction?.dryRun, true);
  assert.equal(watchedUntilActionDryRunLines[0]?.executedAction?.reason, "control_plane_action:restart_control_plane_advance_worker");
  assert.deepEqual(watchedUntilActionDryRunLines[0]?.executedAction?.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--dry-run"]);
  assert.deepEqual(watchedUntilActionDryRunLines[0]?.executedAction?.executed.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--dry-run"]);
  assert.equal(watchedUntilActionDryRunLines[0]?.executedAction?.executed.exitCode, 0);
  assert.ok(watchedUntilActionDryRunLines[0]?.executedAction?.advanceId);
  const watchActionAdvances = await cliJson<{
    count: number;
    advances: Array<{ advanceId: string; dryRun: boolean; detailCommand: string; selected: { surface: string; action: string; reason: string; command: string[] }; executed: { command: string[]; exitCode: number | null } }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--status-watch-executions",
    "--limit",
    "5",
  ]);
  assert.equal(watchActionAdvances.count, 1);
  assert.equal(watchActionAdvances.advances[0]?.advanceId, watchedUntilActionDryRunLines[0]?.executedAction?.advanceId);
  assert.equal(watchActionAdvances.advances[0]?.dryRun, true);
  assert.equal(watchActionAdvances.advances[0]?.detailCommand, "status_watch_execute_action");
  assert.equal(watchActionAdvances.advances[0]?.selected.surface, "status_watch");
  assert.equal(watchActionAdvances.advances[0]?.selected.action, "execute_action");
  assert.equal(watchActionAdvances.advances[0]?.selected.reason, "control_plane_action:restart_control_plane_advance_worker");
  assert.deepEqual(watchActionAdvances.advances[0]?.selected.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--dry-run"]);
  assert.equal(watchActionAdvances.advances[0]?.executed.exitCode, 0);
  const watchActionAdvancesText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--status-watch-executions",
    "--format",
    "text",
  ]);
  assert.match(watchActionAdvancesText, /detail_commands=status_watch_execute_action/);
  assert.match(watchActionAdvancesText, /detail_command: status_watch_execute_action/);
  const summaryAfterWatchExecution = await cliJson<{
    recovery: { statusWatchExecutions: { attempts: { total: number; dryRun: number; executed: number; failed: number }; recent: Array<{ advanceId: string; command: string[] }> } };
    commands: { statusWatchExecutions: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(summaryAfterWatchExecution.recovery.statusWatchExecutions.attempts.total, 1);
  assert.equal(summaryAfterWatchExecution.recovery.statusWatchExecutions.attempts.dryRun, 1);
  assert.equal(summaryAfterWatchExecution.recovery.statusWatchExecutions.attempts.executed, 1);
  assert.equal(summaryAfterWatchExecution.recovery.statusWatchExecutions.attempts.failed, 0);
  assert.equal(summaryAfterWatchExecution.recovery.statusWatchExecutions.recent[0]?.advanceId, watchedUntilActionDryRunLines[0]?.executedAction?.advanceId);
  assert.deepEqual(summaryAfterWatchExecution.commands.statusWatchExecutions, ["npm", "run", "cli", "--", "runs", "session-control-plane-advances", sessionName, "--server", "--status-watch-executions"]);
  const summaryTextAfterWatchExecution = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(summaryTextAfterWatchExecution, /status_watch_executions: total=1 dry_run=1 executed=1 failed=0/);
  assert.match(summaryTextAfterWatchExecution, new RegExp(`inspect: npm run cli -- runs session-control-plane-advances ${sessionName} --server --status-watch-executions`));
  assert.match(summaryTextAfterWatchExecution, /recent_status_watch_executions:/);
  const statusWatchTimeline = await cliJson<{
    count: number;
    counts: Record<string, number>;
    events: Array<{
      source: string;
      event: string;
      status: string;
      advanceId: string;
      detailCommand: string;
      command: string[];
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--source",
    "status_watch_execution",
    "--event",
    "status_watch_executed",
    "--status",
    "dry_run",
  ]);
  assert.equal(statusWatchTimeline.count, 1);
  assert.equal(statusWatchTimeline.counts.status_watch_executed, 1);
  assert.equal(statusWatchTimeline.events[0]?.source, "status_watch_execution");
  assert.equal(statusWatchTimeline.events[0]?.event, "status_watch_executed");
  assert.equal(statusWatchTimeline.events[0]?.status, "dry_run");
  assert.equal(statusWatchTimeline.events[0]?.advanceId, watchedUntilActionDryRunLines[0]?.executedAction?.advanceId);
  assert.equal(statusWatchTimeline.events[0]?.detailCommand, "status_watch_execute_action");
  assert.deepEqual(statusWatchTimeline.events[0]?.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--dry-run"]);
  const statusWatchTimelineCommands = await cliJson<{ commands: Array<{ action: string; command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--source",
    "status_watch_execution",
    "--commands-only",
  ]);
  assert.ok(statusWatchTimelineCommands.commands.some((command) => (
    command.action === "inspect_status_watch_execution"
    && command.command.join(" ") === `npm run cli -- runs session-control-plane-advances ${sessionName} --server --status-watch-executions --advance ${watchedUntilActionDryRunLines[0]?.executedAction?.advanceId} --limit 20`
  )));
  assert.ok(statusWatchTimelineCommands.commands.some((command) => (
    command.action === "run_selected_command"
    && command.command.join(" ") === `npm run cli -- runs session-control-plane-advance ${sessionName} --server --dry-run`
  )));
  const failedStatusWatch = await writeWorkerSessionControlPlaneAdvanceRecord(settings.projectRoot, {
    session: sessionName,
    observedAt: "2026-05-14T00:00:02.000Z",
    completedAt: "2026-05-14T00:00:03.000Z",
    dryRun: false,
    detailCommand: "status_watch_execute_action",
    selected: {
      surface: "status_watch",
      action: "execute_action",
      reason: "control_plane_action:failed_status_watch_smoke",
      command: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--confirm"],
    },
    executed: {
      command: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--confirm"],
      exitCode: 1,
      stdout: "",
      stderr: "status watch failed",
      output: null,
    },
    before: null,
    after: null,
  });
  const statusWatchAlerts = await cliJson<{
    summary: { total: number; errors: number };
    alerts: Array<{ surface: string; severity: string; reason: string; advanceId: string; action: string; command: string[] }>;
    recentTimeline: { counts: Record<string, number> };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--surface",
    "status_watch",
  ]);
  assert.equal(statusWatchAlerts.summary.total, 1);
  assert.equal(statusWatchAlerts.summary.errors, 1);
  assert.equal(statusWatchAlerts.alerts[0]?.surface, "status_watch");
  assert.equal(statusWatchAlerts.alerts[0]?.severity, "error");
  assert.equal(statusWatchAlerts.alerts[0]?.reason, "failed_status_watch_execution");
  assert.equal(statusWatchAlerts.alerts[0]?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(statusWatchAlerts.alerts[0]?.action, "inspect_status_watch_execution");
  assert.deepEqual(statusWatchAlerts.alerts[0]?.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advances", sessionName, "--server", "--status-watch-executions", "--advance", failedStatusWatch.record.advanceId]);
  assert.equal(statusWatchAlerts.recentTimeline.counts.status_watch_executed, 1);
  const statusWatchAlertPreview = await cliJson<{
    alert: { surface: string; advanceId: string } | null;
    details: {
      kind: string;
      advance: { advanceId: string; detailCommand: string; executed: { exitCode: number | null } | null };
      commands: { inspectStatusWatchExecution: string[]; timelineStatusWatchExecution: string[]; runSelectedCommand: string[] | null };
    } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "status_watch",
  ]);
  assert.equal(statusWatchAlertPreview.alert?.surface, "status_watch");
  assert.equal(statusWatchAlertPreview.alert?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(statusWatchAlertPreview.details?.kind, "status_watch_execution");
  assert.equal(statusWatchAlertPreview.details?.advance.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(statusWatchAlertPreview.details?.advance.detailCommand, "status_watch_execute_action");
  assert.equal(statusWatchAlertPreview.details?.advance.executed?.exitCode, 1);
  assert.deepEqual(statusWatchAlertPreview.details?.commands.inspectStatusWatchExecution, ["npm", "run", "cli", "--", "runs", "session-control-plane-advances", sessionName, "--server", "--status-watch-executions", "--advance", failedStatusWatch.record.advanceId]);
  assert.deepEqual(statusWatchAlertPreview.details?.commands.timelineStatusWatchExecution, ["npm", "run", "cli", "--", "runs", "session-control-plane-timeline", sessionName, "--server", "--source", "status_watch_execution", "--advance", failedStatusWatch.record.advanceId]);
  assert.deepEqual(statusWatchAlertPreview.details?.commands.runSelectedCommand, ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--confirm"]);
  const statusWatchAlertCommands = await cliJson<{ commands: Array<{ action: string; advanceId?: string; command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "status_watch",
    "--commands-only",
  ]);
  assert.ok(statusWatchAlertCommands.commands.some((command) => (
    command.action === "inspect_status_watch_execution"
    && command.advanceId === failedStatusWatch.record.advanceId
  )));
  assert.ok(statusWatchAlertCommands.commands.some((command) => command.action === "timeline_status_watch_execution"));
  assert.ok(statusWatchAlertCommands.commands.some((command) => command.action === "acknowledge_status_watch_execution"));
  assert.ok(statusWatchAlertCommands.commands.some((command) => command.action === "run_selected_command"));
  const statusWatchAlertText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--surface",
    "status_watch",
    "--format",
    "text",
  ]);
  assert.match(statusWatchAlertText, /surface: status_watch/);
  assert.match(statusWatchAlertText, new RegExp(`advance: ${failedStatusWatch.record.advanceId}`));
  assert.match(statusWatchAlertText, /status_watch_execution:/);
  assert.match(statusWatchAlertText, /inspect_status_watch_execution: npm run cli -- runs session-control-plane-advances/);
  const summaryAfterFailedStatusWatch = await cliJson<{
    needsAction: boolean;
    nextRecovery: { surface: string; action: string; reason: string; count: number; command: string[]; dryRunCommand: string[] } | null;
    nextActions: Array<{ surface: string; action: string; reason: string; count: number; advanceId?: string; command: string[] }>;
    recovery: { statusWatchExecutions: { attempts: { total: number; dryRun: number; executed: number; failed: number }; recent: Array<{ advanceId: string; failed: boolean; command: string[] }>; failedRecent: Array<{ advanceId: string; failed: boolean; command: string[] }> } };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(summaryAfterFailedStatusWatch.needsAction, true);
  assert.equal(summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.attempts.total, 2);
  assert.equal(summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.attempts.dryRun, 1);
  assert.equal(summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.attempts.executed, 2);
  assert.equal(summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.attempts.failed, 1);
  const failedStatusWatchSummaryAttempt = summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.recent.find((attempt) => attempt.advanceId === failedStatusWatch.record.advanceId);
  assert.equal(failedStatusWatchSummaryAttempt?.failed, true);
  assert.deepEqual(failedStatusWatchSummaryAttempt?.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-advances", sessionName, "--server", "--advance", failedStatusWatch.record.advanceId, "--status-watch-executions"]);
  assert.equal(summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.failedRecent[0]?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(summaryAfterFailedStatusWatch.recovery.statusWatchExecutions.failedRecent[0]?.failed, true);
  assert.equal(summaryAfterFailedStatusWatch.nextRecovery?.surface, "status_watch");
  assert.equal(summaryAfterFailedStatusWatch.nextRecovery?.action, "inspect_failed_status_watch_execution");
  assert.equal(summaryAfterFailedStatusWatch.nextRecovery?.reason, "failed_status_watch_execution");
  assert.equal(summaryAfterFailedStatusWatch.nextRecovery?.count, 1);
  assert.deepEqual(summaryAfterFailedStatusWatch.nextRecovery?.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-alert", sessionName, "--server", "--surface", "status_watch"]);
  assert.deepEqual(summaryAfterFailedStatusWatch.nextRecovery?.dryRunCommand, summaryAfterFailedStatusWatch.nextRecovery?.command);
  assert.ok(summaryAfterFailedStatusWatch.nextActions.some((action) => (
    action.surface === "status_watch"
    && action.action === "inspect_failed_status_watch_execution"
    && action.advanceId === failedStatusWatch.record.advanceId
  )));
  const summaryTextAfterFailedStatusWatch = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(summaryTextAfterFailedStatusWatch, /status_watch_executions: total=2 dry_run=1 executed=2 failed=1/);
  assert.match(summaryTextAfterFailedStatusWatch, /next_recovery:\n  kind: control_plane_action\n  action: inspect_failed_status_watch_execution\n  reason: failed_status_watch_execution/);
  assert.match(summaryTextAfterFailedStatusWatch, /next_actions:\n  - surface: status_watch/);
  assert.match(summaryTextAfterFailedStatusWatch, new RegExp(`advance: ${failedStatusWatch.record.advanceId}`));
  await writeWorkerSessionControlPlaneAdvanceRecord(settings.projectRoot, {
    session: sessionName,
    observedAt: "2026-05-14T00:00:04.000Z",
    completedAt: "2026-05-14T00:00:05.000Z",
    dryRun: false,
    detailCommand: "status_watch_execute_action",
    selected: {
      surface: "status_watch",
      action: "execute_action",
      reason: "control_plane_action:successful_status_watch_smoke",
      command: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--confirm"],
    },
    executed: {
      command: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", sessionName, "--server", "--confirm"],
      exitCode: 0,
      stdout: "",
      stderr: "",
      output: null,
    },
    before: null,
    after: null,
  });
  const compactSummaryAfterFailedStatusWatch = await cliJson<{
    nextRecovery: { surface: string; action: string; reason: string; count: number; command: string[]; dryRunCommand: string[] } | null;
    nextActions: Array<{ surface: string; action: string; reason: string; count: number; advanceId?: string; command: string[] }>;
    recovery: { statusWatchExecutions: { attempts: { total: number; failed: number }; recent: Array<{ advanceId: string; failed: boolean }>; failedRecent: Array<{ advanceId: string; failed: boolean; command: string[] }> } };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "1",
  ]);
  assert.equal(compactSummaryAfterFailedStatusWatch.recovery.statusWatchExecutions.attempts.total, 3);
  assert.equal(compactSummaryAfterFailedStatusWatch.recovery.statusWatchExecutions.attempts.failed, 1);
  assert.equal(compactSummaryAfterFailedStatusWatch.recovery.statusWatchExecutions.recent.length, 1);
  assert.notEqual(compactSummaryAfterFailedStatusWatch.recovery.statusWatchExecutions.recent[0]?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(compactSummaryAfterFailedStatusWatch.recovery.statusWatchExecutions.failedRecent[0]?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(compactSummaryAfterFailedStatusWatch.nextRecovery?.surface, "status_watch");
  assert.equal(compactSummaryAfterFailedStatusWatch.nextActions[0]?.advanceId, failedStatusWatch.record.advanceId);
  const compactSummaryTextAfterFailedStatusWatch = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(compactSummaryTextAfterFailedStatusWatch, /failed_status_watch_executions:/);
  assert.match(compactSummaryTextAfterFailedStatusWatch, new RegExp(`advance: ${failedStatusWatch.record.advanceId}`));
  const recoverNextStatusWatch = await cliJson<{
    ok: boolean;
    dryRun: boolean;
    advanceId: string;
    selected: { kind: string; surface: string; action: string; reason: string; command: string[] } | null;
    command: string[] | null;
    result: { alert: { surface: string; advanceId: string } | null } | null;
    executed: { exitCode: number | null; command: string[] } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(recoverNextStatusWatch.ok, true);
  assert.equal(recoverNextStatusWatch.dryRun, false);
  assert.equal(recoverNextStatusWatch.selected?.kind, "control_plane_action");
  assert.equal(recoverNextStatusWatch.selected?.surface, "status_watch");
  assert.equal(recoverNextStatusWatch.selected?.action, "inspect_failed_status_watch_execution");
  assert.deepEqual(recoverNextStatusWatch.command, ["npm", "run", "cli", "--", "runs", "session-control-plane-alert", sessionName, "--server", "--surface", "status_watch"]);
  assert.equal(recoverNextStatusWatch.result?.alert?.surface, "status_watch");
  assert.equal(recoverNextStatusWatch.result?.alert?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(recoverNextStatusWatch.executed?.exitCode, 0);
  assert.deepEqual(recoverNextStatusWatch.executed?.command, recoverNextStatusWatch.command);
  const summaryAfterRecoverNextStatusWatch = await cliJson<{
    recovery: {
      recoverNext: {
        attempts: { total: number; dryRun: number; executed: number; failed: number };
        recent: Array<{
          advanceId: string;
          detailCommand: string | null;
          dryRun: boolean;
          selectedKind: string | null;
          selectedSurface: string | null;
          selectedAction: string | null;
          selectedReason: string | null;
          selectedCommand: string[] | null;
          executedCommand: string[] | null;
          executedExitCode: number | null;
        }>;
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "1",
  ]);
  assert.equal(summaryAfterRecoverNextStatusWatch.recovery.recoverNext.attempts.total, 1);
  assert.equal(summaryAfterRecoverNextStatusWatch.recovery.recoverNext.attempts.dryRun, 0);
  assert.equal(summaryAfterRecoverNextStatusWatch.recovery.recoverNext.attempts.executed, 1);
  assert.equal(summaryAfterRecoverNextStatusWatch.recovery.recoverNext.attempts.failed, 0);
  const recoverNextStatusWatchSummary = summaryAfterRecoverNextStatusWatch.recovery.recoverNext.recent[0];
  assert.equal(recoverNextStatusWatchSummary?.advanceId, recoverNextStatusWatch.advanceId);
  assert.equal(recoverNextStatusWatchSummary?.detailCommand, "recover_next");
  assert.equal(recoverNextStatusWatchSummary?.dryRun, false);
  assert.equal(recoverNextStatusWatchSummary?.selectedKind, "control_plane_action");
  assert.equal(recoverNextStatusWatchSummary?.selectedSurface, "status_watch");
  assert.equal(recoverNextStatusWatchSummary?.selectedAction, "inspect_failed_status_watch_execution");
  assert.equal(recoverNextStatusWatchSummary?.selectedReason, "failed_status_watch_execution");
  assert.deepEqual(recoverNextStatusWatchSummary?.selectedCommand, recoverNextStatusWatch.command);
  assert.deepEqual(recoverNextStatusWatchSummary?.executedCommand, recoverNextStatusWatch.command);
  assert.equal(recoverNextStatusWatchSummary?.executedExitCode, 0);
  const summaryTextAfterRecoverNextStatusWatch = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(summaryTextAfterRecoverNextStatusWatch, /selected: control_plane_action status_watch inspect_failed_status_watch_execution/);
  assert.match(summaryTextAfterRecoverNextStatusWatch, /reason: failed_status_watch_execution/);
  assert.match(summaryTextAfterRecoverNextStatusWatch, /executed_exit_code: 0/);
  const acknowledgeStatusWatch = await cliJson<{
    dryRun: boolean;
    detailCommand: string;
    selected: { surface: string; action: string; advanceId: string } | null;
    executed: { exitCode: number | null; output: { acknowledgedAdvanceId: string | null } } | null;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--surface",
    "status_watch",
    "--reason",
    "failed_status_watch_execution",
    "--action",
    "inspect_status_watch_execution",
    "--detail-command",
    "acknowledge_status_watch_execution",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(acknowledgeStatusWatch.dryRun, false);
  assert.equal(acknowledgeStatusWatch.detailCommand, "acknowledge_status_watch_execution");
  assert.equal(acknowledgeStatusWatch.selected?.surface, "status_watch");
  assert.equal(acknowledgeStatusWatch.selected?.action, "acknowledge_status_watch_execution");
  assert.equal(acknowledgeStatusWatch.selected?.advanceId, failedStatusWatch.record.advanceId);
  assert.equal(acknowledgeStatusWatch.executed?.exitCode, 0);
  assert.equal(acknowledgeStatusWatch.executed?.output.acknowledgedAdvanceId, failedStatusWatch.record.advanceId);
  const statusWatchAlertsAfterAck = await cliJson<{
    summary: { total: number; errors: number };
    alerts: Array<{ surface: string }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--surface",
    "status_watch",
  ]);
  assert.equal(statusWatchAlertsAfterAck.summary.total, 0);
  assert.equal(statusWatchAlertsAfterAck.summary.errors, 0);
  assert.equal(statusWatchAlertsAfterAck.alerts.length, 0);
  const summaryAfterStatusWatchAck = await cliJson<{
    nextRecovery: { surface: string } | null;
    nextActions: Array<{ surface: string }>;
    recovery: { statusWatchExecutions: { attempts: { failed: number }; failedRecent: Array<{ advanceId: string }>; acknowledgements: { attempts: { total: number; executed: number; failed: number } } } };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "1",
  ]);
  assert.equal(summaryAfterStatusWatchAck.recovery.statusWatchExecutions.attempts.failed, 1);
  assert.equal(summaryAfterStatusWatchAck.recovery.statusWatchExecutions.failedRecent.length, 0);
  assert.equal(summaryAfterStatusWatchAck.recovery.statusWatchExecutions.acknowledgements.attempts.total, 1);
  assert.equal(summaryAfterStatusWatchAck.recovery.statusWatchExecutions.acknowledgements.attempts.executed, 1);
  assert.equal(summaryAfterStatusWatchAck.recovery.statusWatchExecutions.acknowledgements.attempts.failed, 0);
  assert.notEqual(summaryAfterStatusWatchAck.nextRecovery?.surface, "status_watch");
  assert.ok(!summaryAfterStatusWatchAck.nextActions.some((action) => action.surface === "status_watch"));
  const nextSteps = await cliJson<{ count: number; nextSteps: Array<{ command: string[]; commands: { retireControlPlaneAdvanceWorker: string[] } }> }>(baseUrl, [
    "runs",
    "session-control-plane-topology-workers-next",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
  ]);
  assert.equal(nextSteps.count, 1);
  assert.equal(nextSteps.nextSteps[0]?.command.join(" "), `npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId}`);
  assert.equal(nextSteps.nextSteps[0]?.commands.retireControlPlaneAdvanceWorker.join(" "), `npm run cli -- runs stop-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId} --retire`);

  const aggregateAfterStop = await cliJson<{
    summary: { topology: { stopped: number; restartable: number } };
    nextSteps: Array<{ kind: string; workerId: string | null; command: string[] }>;
    commands: { restartNext: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "1",
  ]);
  assert.equal(aggregateAfterStop.summary.topology.stopped, 1);
  assert.equal(aggregateAfterStop.summary.topology.restartable, 1);
  assert.ok(aggregateAfterStop.nextSteps.some((step) => (
    step.kind === "control_plane_topology"
    && step.workerId === workerId
    && step.command.join(" ") === `npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId}`
  )));
  assert.equal(
    aggregateAfterStop.commands.restartNext?.join(" "),
    `npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId}`,
  );
  const aggregateTextAfterStop = await cliText(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(aggregateTextAfterStop, /topology: total=1 alive=0 stopped=1 completed=0 retired=0 exited_unrecorded=0 restartable=1 latest_results=count=1,recorded=1,progress=0,recent_progress=1,iterations=1,core=0,mutation=0/);
  assert.match(aggregateTextAfterStop, new RegExp(`restart_next: npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId}`));
  assert.match(aggregateTextAfterStop, new RegExp(`command: npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${workerId}`));

  await cliJson(baseUrl, [
    "runs",
    "stop-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    workerId,
    "--retire",
    "--lines",
    "1",
  ]);

  const liveWorkerId = "status-topology-live-worker";
  await cliJson(baseUrl, [
    "runs",
    "start-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    liveWorkerId,
    "--dry-run",
    "--max-iterations",
    "2",
    "--loop-interval-ms",
    "5000",
    "--lines",
    "1",
  ]);
  const liveTopologyWorker = await waitForTopologyWorkerResult(baseUrl, liveWorkerId, { iterations: 1, alive: true, state: "running" });
  assert.equal(liveTopologyWorker.alive, true);
  assert.equal(liveTopologyWorker.latestResult?.iterations, 1);
  assert.equal(liveTopologyWorker.latestResult?.stoppedReason, "running");
  assert.equal(liveTopologyWorker.latestResultSource, "stdout");
  assert.equal(liveTopologyWorker.latestProgress?.iterations, 1);
  assert.equal(liveTopologyWorker.recentProgress.length, 1);
  const liveStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(liveStatusText, new RegExp(`worker: ${liveWorkerId}`));
  assert.match(liveStatusText, /source: stdout/);
  assert.match(liveStatusText, /stopped_reason: running/);
  assert.match(liveStatusText, new RegExp(`inspect: npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --worker-id ${liveWorkerId} --kind control-plane-topology --limit 5`));
  const liveWorkerRecord = await readTopologyWorkerRecord(liveWorkerId);
  assert.equal(liveWorkerRecord.latestResult, null);
  assert.equal(liveWorkerRecord.recentProgress?.length, 1);
  assert.equal(liveWorkerRecord.recentProgress?.[0]?.iterations, 1);
  const liveAggregate = await cliJson<{
    summary: { topology: { latestResults: { count: number; recorded: number; progress: number; recentProgress: number; iterations: number } } };
    workers: Array<{ kind: string; workerId: string | null; latestResultSource?: string; latestProgress?: { iterations?: number } | null; recentProgress?: Array<{ iterations?: number }> }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--lines",
    "1",
  ]);
  assert.ok(liveAggregate.summary.topology.latestResults.count >= 1);
  assert.ok(liveAggregate.summary.topology.latestResults.recentProgress >= 1);
  assert.ok(liveAggregate.summary.topology.latestResults.iterations >= 1);
  const liveAggregateWorker = liveAggregate.workers.find((worker) => worker.workerId === liveWorkerId);
  assert.ok(liveAggregateWorker?.latestResultSource === "stdout" || liveAggregateWorker?.latestResultSource === "recorded");
  assert.equal(liveAggregateWorker?.recentProgress?.[0]?.iterations, 1);
  const liveProgress = await cliJson<{
    count: number;
    progress: Array<{ kind: string; workerId: string | null; state: string | null; source: string | null; iterations?: number; stoppedReason?: string }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-progress",
    sessionName,
    "--server",
    "--worker-id",
    liveWorkerId,
    "--kind",
    "topology",
    "--limit",
    "5",
  ]);
  assert.ok(liveProgress.count >= 1);
  const liveProgressRow = liveProgress.progress.find((progress) => progress.workerId === liveWorkerId);
  assert.equal(liveProgressRow?.kind, "control_plane_topology");
  assert.ok(liveProgressRow?.state === "running" || liveProgressRow?.state === "completed");
  assert.ok(liveProgressRow?.source === "stdout" || liveProgressRow?.source === "recorded");
  assert.ok((liveProgressRow?.iterations ?? 0) >= 1);
  assert.ok(liveProgressRow?.stoppedReason === "running" || liveProgressRow?.stoppedReason === "completed");
  const liveProgressText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-worker-progress",
    sessionName,
    "--server",
    "--worker-id",
    liveWorkerId,
    "--kind",
    "topology",
    "--limit",
    "5",
    "--format",
    "text",
  ]);
  assert.match(liveProgressText, new RegExp(`worker=${liveWorkerId} state=(running|completed) source=(stdout|recorded) index=\\d+/\\d+ iterations=\\d+ reason=(running|completed)`));
  const liveAggregateText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(liveAggregateText, /topology: total=1 alive=\d+ stopped=0 completed=\d+ retired=0 exited_unrecorded=0 restartable=0 latest_results=count=\d+,recorded=\d+,progress=\d+,recent_progress=\d+,iterations=\d+,core=0,mutation=0/);
  await cliJson(baseUrl, [
    "runs",
    "stop-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    liveWorkerId,
    "--retire",
    "--lines",
    "1",
  ]);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane status topology smoke passed");

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const stdout = await cliText(baseUrl, args);
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

async function waitForTopologyWorkerResult(
  baseUrl: string,
  workerId: string,
  options: { iterations?: number; alive?: boolean; state?: string } = {},
): Promise<{
  alive: boolean;
  lifecycle: { state: string };
  latestResultSource: string;
  latestProgress: {
    iterations?: number;
    stoppedReason?: string;
    totalCoreExecuted?: number;
    totalMutationExecuted?: number;
  } | null;
  recentProgress: Array<{
    iterations?: number;
    stoppedReason?: string;
    totalCoreExecuted?: number;
    totalMutationExecuted?: number;
  }>;
  latestResult: {
    iterations?: number;
    stoppedReason?: string;
    totalCoreExecuted?: number;
    totalMutationExecuted?: number;
  } | null;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspected = await cliJson<{ workers: Array<{ alive: boolean; lifecycle: { state: string }; latestResultSource: string; latestProgress: { iterations?: number; stoppedReason?: string; totalCoreExecuted?: number; totalMutationExecuted?: number } | null; recentProgress: Array<{ iterations?: number; stoppedReason?: string; totalCoreExecuted?: number; totalMutationExecuted?: number }>; latestResult: { iterations?: number; stoppedReason?: string; totalCoreExecuted?: number; totalMutationExecuted?: number } | null }> }>(baseUrl, [
      "runs",
      "session-control-plane-topology-workers",
      sessionName,
      "--server",
      "--worker-id",
      workerId,
      "--include-retired",
      "--lines",
      "1",
    ]);
    const worker = inspected.workers[0];
    if (
      worker?.latestResult
      && (options.iterations === undefined || worker.latestResult.iterations === options.iterations)
      && (options.alive === undefined || worker.alive === options.alive)
      && (options.state === undefined || worker.lifecycle.state === options.state)
    ) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`topology worker ${workerId} did not record latestResult`);
}

async function waitForBundleRecoveryWorkerResult(
  baseUrl: string,
  workerId: string,
  options: { alive?: boolean; state?: string } = {},
): Promise<{
  alive: boolean;
  lifecycle: { state: string };
  latestResultSource: string;
  latestResult: {
    profileCount?: number;
    planned?: number;
    actionable?: number;
    blocked?: number;
    executed?: number;
    polls?: number;
  } | null;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const inspected = await cliJson<{ workers: Array<{ alive: boolean; lifecycle: { state: string }; latestResultSource: string; latestResult: { profileCount?: number; planned?: number; actionable?: number; blocked?: number; executed?: number; polls?: number } | null }> }>(baseUrl, [
      "runs",
      "session-control-plane-worker-bundle-recovery-workers",
      sessionName,
      "--server",
      "--worker-id",
      workerId,
      "--include-retired",
      "--lines",
      "1",
    ]);
    const worker = inspected.workers[0];
    if (
      worker?.latestResult
      && (options.alive === undefined || worker.alive === options.alive)
      && (options.state === undefined || worker.lifecycle.state === options.state)
    ) {
      return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`bundle recovery worker ${workerId} did not record latestResult`);
}

async function readTopologyWorkerRecord(workerId: string): Promise<{
  latestResult?: unknown;
  recentProgress?: Array<{ iterations?: number; stoppedReason?: string }>;
}> {
  const text = await fs.readFile(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName, `${workerId}.json`), "utf8");
  return JSON.parse(text) as {
    latestResult?: unknown;
    recentProgress?: Array<{ iterations?: number; stoppedReason?: string }>;
  };
}

async function writeWorkerSessionRecord(): Promise<void> {
  const sessionDir = path.join(".threadbeat", "worker-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `${sessionName}.json`), `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-14T00:00:00.000Z",
    command: ["runs", "work", "--agent", "agt_status_topology"],
    workers: [],
    stoppedAt: "2026-05-14T00:00:01.000Z",
  }, null, 2)}\n`);
}
