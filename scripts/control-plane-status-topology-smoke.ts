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
  assert.equal(liveAggregate.summary.topology.latestResults.count, 1);
  assert.equal(liveAggregate.summary.topology.latestResults.recorded, 0);
  assert.equal(liveAggregate.summary.topology.latestResults.progress, 1);
  assert.equal(liveAggregate.summary.topology.latestResults.recentProgress, 1);
  assert.equal(liveAggregate.summary.topology.latestResults.iterations, 1);
  const liveAggregateWorker = liveAggregate.workers.find((worker) => worker.workerId === liveWorkerId);
  assert.equal(liveAggregateWorker?.latestResultSource, "stdout");
  assert.equal(liveAggregateWorker?.latestProgress?.iterations, 1);
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
  assert.equal(liveProgress.count, 1);
  assert.equal(liveProgress.progress[0]?.kind, "control_plane_topology");
  assert.equal(liveProgress.progress[0]?.workerId, liveWorkerId);
  assert.equal(liveProgress.progress[0]?.state, "running");
  assert.equal(liveProgress.progress[0]?.source, "stdout");
  assert.equal(liveProgress.progress[0]?.iterations, 1);
  assert.equal(liveProgress.progress[0]?.stoppedReason, "running");
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
  assert.match(liveProgressText, new RegExp(`worker=${liveWorkerId} state=running source=stdout index=1/1 iterations=1 reason=running`));
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
  assert.match(liveAggregateText, /topology: total=1 alive=1 stopped=0 completed=0 retired=0 exited_unrecorded=0 restartable=0 latest_results=count=1,recorded=0,progress=1,recent_progress=1,iterations=1,core=0,mutation=0/);
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
