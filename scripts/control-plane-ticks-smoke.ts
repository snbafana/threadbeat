import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { writeWorkerSessionControlPlaneTickRecord } from "../src/workerSessionControlPlaneTicks.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-control-plane-ticks-smoke-"));
const sessionName = `control-plane-ticks-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-control-plane-ticks-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-control-plane-ticks-smoke",
};

const { app } = await buildServer(settings);

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;
  const older = await writeTickRecord({
    tickId: `control-plane-tick-older-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T10:00:00.000Z",
    completedAt: "2026-05-13T10:00:01.000Z",
    status: "noop",
  });
  const newer = await writeTickRecord({
    tickId: `control-plane-tick-newer-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T11:00:00.000Z",
    completedAt: "2026-05-13T11:00:01.000Z",
    status: "dry_run",
  });

  const newestPage = await cliJson<ControlPlaneTicksResponse>(baseUrl, [
    "runs",
    "session-control-plane-ticks",
    sessionName,
    "--server",
    "--limit",
    "1",
  ]);
  assert.deepEqual(newestPage.ticks.map((tick) => tick.tickId), [newer.tickId]);

  const byTick = await cliJson<ControlPlaneTicksResponse>(baseUrl, [
    "runs",
    "session-control-plane-ticks",
    sessionName,
    "--server",
    "--tick",
    older.tickId,
    "--limit",
    "1",
  ]);
  assert.deepEqual(byTick.filter.tickIds, [older.tickId]);
  assert.deepEqual(byTick.ticks.map((tick) => tick.tickId), [older.tickId]);

  const localByTick = await cliJson<ControlPlaneTicksResponse>("", [
    "runs",
    "session-control-plane-ticks",
    sessionName,
    "--tick",
    older.tickId,
    "--limit",
    "1",
  ]);
  assert.deepEqual(localByTick.filter.tickIds, [older.tickId]);
  assert.deepEqual(localByTick.ticks.map((tick) => tick.tickId), [older.tickId]);

  const timelineCommands = await cliJson<{
    commands: Array<{ action: string; tickId: string | null; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--source",
    "tick",
    "--tick",
    newer.tickId,
    "--commands-only",
    "--limit",
    "1",
  ]);
  assert.ok(timelineCommands.commands.some((command) => (
    command.action === "inspect_tick"
    && command.tickId === newer.tickId
    && command.command.includes("--tick")
    && command.command.includes(newer.tickId)
  )));
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-ticks", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane ticks smoke passed");

type ControlPlaneTicksResponse = {
  filter: { tickIds: string[] };
  ticks: Array<{ tickId: string }>;
};

async function writeTickRecord(options: {
  tickId: string;
  observedAt: string;
  completedAt: string;
  status: "dry_run" | "noop";
}): Promise<{ tickId: string }> {
  await writeWorkerSessionControlPlaneTickRecord(settings.projectRoot, {
    tickId: options.tickId,
    session: sessionName,
    observedAt: options.observedAt,
    completedAt: options.completedAt,
    dryRun: options.status === "dry_run",
    status: options.status,
    planned: {
      branchRecovery: null,
      applyAction: null,
      drainContinuation: null,
    },
    executed: {
      branchRecovery: null,
      applyAction: null,
      drainContinuation: null,
    },
    before: {},
    after: {},
  });
  return { tickId: options.tickId };
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const env = { ...process.env };
  if (baseUrl) env.THREADBEAT_BASE_URL = baseUrl;
  else delete env.THREADBEAT_BASE_URL;
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}
