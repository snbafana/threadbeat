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
const selectedAdvanceWorkerId = "advance-worker-selected";
const otherAdvanceWorkerId = "advance-worker-other";
const exitedAdvanceWorkerId = "advance-worker-exited";
const selectedTickWorkerId = "tick-worker-selected";
const otherTickWorkerId = "tick-worker-other";
const exitedTickWorkerId = "tick-worker-exited";

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
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-tick-workers", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane worker next smoke passed");

type WorkerNextResponse = {
  count: number;
  actions: Record<string, number>;
  nextSteps: Array<{ workerId: string; reason: string; command: string[] }>;
};

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
