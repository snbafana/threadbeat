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
  await fs.writeFile(stdoutPath, "");
  await fs.writeFile(stderrPath, "");
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
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}
