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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-control-plane-worker-restart-proof-"));
const sessionName = `worker-restart-proof-${Date.now().toString(36)}`;
const topologyWorkerId = "restart-proof-topology-worker";
const tickWorkerId = "restart-proof-tick-worker";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-control-plane-worker-restart-proof",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-control-plane-worker-restart-proof",
};

const { app } = await buildServer(settings);
let baseUrl: string | null = null;
let topologyWorkerStarted = false;
let tickWorkerStarted = false;

try {
  await writeWorkerSessionRecord();
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://${settings.host}:${address.port}`;

  const started = await cliJson<{
    worker: { workerId: string; mode: string; command: string[]; alive: boolean };
  }>(baseUrl, [
    "runs",
    "start-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    topologyWorkerId,
    "--dry-run",
    "--max-iterations",
    "20",
    "--loop-interval-ms",
    "1000",
    "--lines",
    "2",
  ]);
  topologyWorkerStarted = true;
  assert.equal(started.worker.workerId, topologyWorkerId);
  assert.equal(started.worker.mode, "topology_loop");
  assert.equal(started.worker.alive, true);
  assert.deepEqual(started.worker.command, [
    "runs",
    "ensure-control-plane-topology-loop",
    sessionName,
    "--server",
    "--dry-run",
    "--max-iterations",
    "20",
    "--loop-interval-ms",
    "1000",
    "--lines",
    "2",
    "--progress-json",
  ]);

  await waitForTopologyProgress(baseUrl, { alive: true, state: "running", restartCount: 0 });
  await assertStatusHealth(baseUrl, /topology_loop: total=1 alive=1 stopped=0 retired=0 completed=0/);

  const stopped = await cliJson<{
    count: number;
    stopped: Array<{ workerId: string; stopped: boolean; aliveBefore: boolean }>;
  }>(baseUrl, [
    "runs",
    "stop-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    topologyWorkerId,
    "--lines",
    "2",
  ]);
  assert.equal(stopped.count, 1);
  assert.equal(stopped.stopped[0]?.workerId, topologyWorkerId);
  assert.equal(stopped.stopped[0]?.aliveBefore, true);
  assert.equal(stopped.stopped[0]?.stopped, true);

  const stoppedWorkers = await cliJson<{
    summary: { topology: { stopped: number; restartable: number } };
    nextSteps: Array<{ kind: string; workerId: string | null; action: string | null; command: string[] }>;
    commands: { restartNext: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "2",
  ]);
  assert.equal(stoppedWorkers.summary.topology.stopped, 1);
  assert.equal(stoppedWorkers.summary.topology.restartable, 1);
  assert.ok(stoppedWorkers.nextSteps.some((step) => (
    step.kind === "control_plane_topology"
    && step.workerId === topologyWorkerId
    && step.action === "restart_control_plane_advance_worker"
    && step.command.join(" ") === `npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${topologyWorkerId}`
  )));
  assert.equal(
    stoppedWorkers.commands.restartNext?.join(" "),
    `npm run cli -- runs restart-control-plane-topology-worker ${sessionName} --server --worker-id ${topologyWorkerId}`,
  );
  await assertStatusHealth(baseUrl, /topology_loop: total=1 alive=0 stopped=1 retired=0 completed=0/);

  const restarted = await cliJson<{
    count: number;
    restarted: Array<{ workerId: string; restartCount: number; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "restart-control-plane-topology-worker",
    sessionName,
    "--server",
    "--worker-id",
    topologyWorkerId,
    "--lines",
    "2",
  ]);
  assert.equal(restarted.count, 1);
  assert.equal(restarted.restarted[0]?.workerId, topologyWorkerId);
  assert.equal(restarted.restarted[0]?.restartCount, 1);
  assert.deepEqual(restarted.restarted[0]?.command, started.worker.command);

  await waitForTopologyProgress(baseUrl, { alive: true, state: "running", restartCount: 1 });
  await assertStatusHealth(baseUrl, /topology_loop: total=1 alive=1 stopped=0 retired=0 completed=0/);

  const progress = await cliJson<{
    count: number;
    progress: Array<{ kind: string; workerId: string | null; state: string | null; source: string | null; iterations?: number }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-progress",
    sessionName,
    "--server",
    "--worker-id",
    topologyWorkerId,
    "--kind",
    "topology",
    "--include-retired",
    "--limit",
    "5",
  ]);
  assert.ok(progress.count >= 1);
  assert.ok(progress.progress.some((entry) => (
    entry.kind === "control_plane_topology"
    && entry.workerId === topologyWorkerId
    && entry.state === "running"
    && entry.source === "stdout"
    && entry.iterations === 1
  )));

  const startedTick = await cliJson<{
    worker: { workerId: string; command: string[]; alive: boolean };
  }>(baseUrl, [
    "runs",
    "start-control-plane-tick-worker",
    sessionName,
    "--server",
    "--worker-id",
    tickWorkerId,
    "--dry-run",
    "--max-ticks",
    "20",
    "--interval-ms",
    "1000",
    "--lines",
    "2",
  ]);
  tickWorkerStarted = true;
  assert.equal(startedTick.worker.workerId, tickWorkerId);
  assert.equal(startedTick.worker.alive, true);
  assert.deepEqual(startedTick.worker.command, [
    "runs",
    "session-control-plane-tick-loop",
    sessionName,
    "--server",
    "--max-ticks",
    "20",
    "--interval-ms",
    "1000",
    "--lines",
    "2",
    "--dry-run",
  ]);

  const firstTickCount = await waitForTickRecord(baseUrl, 1);
  await assertStatusHealth(baseUrl, /tick: total=1 alive=1 stopped=0 retired=0 completed=0/);

  const stoppedTick = await cliJson<{
    count: number;
    stopped: Array<{ workerId: string; stopped: boolean; aliveBefore: boolean }>;
  }>(baseUrl, [
    "runs",
    "stop-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    tickWorkerId,
    "--lines",
    "2",
  ]);
  assert.equal(stoppedTick.count, 1);
  assert.equal(stoppedTick.stopped[0]?.workerId, tickWorkerId);
  assert.equal(stoppedTick.stopped[0]?.aliveBefore, true);
  assert.equal(stoppedTick.stopped[0]?.stopped, true);

  const stoppedTickWorkers = await cliJson<{
    summary: { tick: { stopped: number; restartable: number } };
    nextSteps: Array<{ kind: string; workerId: string | null; action: string | null; command: string[] }>;
    commands: { restartNext: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "2",
  ]);
  assert.equal(stoppedTickWorkers.summary.tick.stopped, 1);
  assert.equal(stoppedTickWorkers.summary.tick.restartable, 1);
  assert.ok(stoppedTickWorkers.nextSteps.some((step) => (
    step.kind === "control_plane_tick"
    && step.workerId === tickWorkerId
    && step.action === "restart_control_plane_tick_worker"
    && step.command.join(" ") === `npm run cli -- runs restart-control-plane-tick-workers ${sessionName} --server --worker-id ${tickWorkerId}`
  )));
  assert.equal(
    stoppedTickWorkers.commands.restartNext?.join(" "),
    `npm run cli -- runs restart-control-plane-tick-workers ${sessionName} --server --worker-id ${tickWorkerId}`,
  );
  await assertStatusHealth(baseUrl, /tick: total=1 alive=0 stopped=1 retired=0 completed=0/);

  const restartedTick = await cliJson<{
    count: number;
    restarted: Array<{ workerId: string; restartCount: number; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "restart-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    tickWorkerId,
    "--lines",
    "2",
  ]);
  assert.equal(restartedTick.count, 1);
  assert.equal(restartedTick.restarted[0]?.workerId, tickWorkerId);
  assert.equal(restartedTick.restarted[0]?.restartCount, 1);
  assert.deepEqual(restartedTick.restarted[0]?.command, startedTick.worker.command);

  await waitForTickRecord(baseUrl, firstTickCount + 1);
  await assertStatusHealth(baseUrl, /tick: total=1 alive=1 stopped=0 retired=0 completed=0/);
} finally {
  if (baseUrl && tickWorkerStarted) {
    await cliJson(baseUrl, [
      "runs",
      "stop-control-plane-tick-workers",
      sessionName,
      "--server",
      "--worker-id",
      tickWorkerId,
      "--retire",
      "--lines",
      "1",
    ]).catch(() => undefined);
  }
  if (baseUrl && topologyWorkerStarted) {
    await cliJson(baseUrl, [
      "runs",
      "stop-control-plane-topology-worker",
      sessionName,
      "--server",
      "--worker-id",
      topologyWorkerId,
      "--retire",
      "--lines",
      "1",
    ]).catch(() => undefined);
  }
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-tick-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-ticks", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane worker restart proof smoke passed");

async function cliJson<T = unknown>(baseUrl: string, args: string[]): Promise<T> {
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

async function waitForTopologyProgress(
  baseUrl: string,
  options: { alive: boolean; state: string; restartCount: number },
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const inspected = await cliJson<{
      workers: Array<{
        workerId: string;
        alive: boolean;
        lifecycle: { state: string };
        restartCount?: number;
        latestResultSource: string;
        latestProgress: { iterations?: number } | null;
      }>;
    }>(baseUrl, [
      "runs",
      "session-control-plane-topology-workers",
      sessionName,
      "--server",
      "--worker-id",
      topologyWorkerId,
      "--include-retired",
      "--lines",
      "2",
    ]);
    const worker = inspected.workers[0];
    if (
      worker?.alive === options.alive
      && worker.lifecycle.state === options.state
      && (worker.restartCount ?? 0) === options.restartCount
      && worker.latestResultSource === "stdout"
      && worker.latestProgress?.iterations === 1
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`topology worker ${topologyWorkerId} did not report expected progress`);
}

async function waitForTickRecord(baseUrl: string, minCount: number): Promise<number> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const inspected = await cliJson<{
      count: number;
      ticks: Array<{ status: string; dryRun: boolean; decision?: { plannedCount?: number; statusReason?: string } }>;
    }>(baseUrl, [
      "runs",
      "session-control-plane-ticks",
      sessionName,
      "--server",
      "--limit",
      "5",
    ]);
    if (inspected.count >= minCount && inspected.ticks.some((tick) => tick.status === "dry_run" && tick.dryRun)) {
      return inspected.count;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tick worker ${tickWorkerId} did not record ${minCount} dry-run tick records`);
}

async function assertStatusHealth(baseUrl: string, pattern: RegExp): Promise<void> {
  const statusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(statusText, /^worker_health:$/m);
  assert.match(statusText, pattern);
}

async function writeWorkerSessionRecord(): Promise<void> {
  const sessionDir = path.join(".threadbeat", "worker-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, `${sessionName}.json`), `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-14T00:00:00.000Z",
    command: ["runs", "work", "--agent", "agt_control_plane_restart_proof"],
    workers: [],
    stoppedAt: "2026-05-14T00:00:01.000Z",
  }, null, 2)}\n`);
}
