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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-control-plane-advances-smoke-"));
const sessionName = `control-plane-advances-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-control-plane-advances-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-control-plane-advances-smoke",
};

const { app } = await buildServer(settings);

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;
  const older = await writeAdvanceRecord({
    advanceId: `control-plane-advance-older-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T10:00:00.000Z",
    completedAt: "2026-05-13T10:00:01.000Z",
    selected: null,
  });
  const newer = await writeAdvanceRecord({
    advanceId: `control-plane-advance-newer-${Date.now().toString(36)}`,
    observedAt: "2026-05-13T11:00:00.000Z",
    completedAt: "2026-05-13T11:00:01.000Z",
    selected: {
      surface: "branch",
      action: "resume_branch",
      reason: "stopped_branch_without_result_commit",
      count: 1,
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", "run-a"],
      runId: "run-a",
    },
  });

  const newestPage = await cliJson<ControlPlaneAdvancesResponse>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--limit",
    "1",
  ]);
  assert.deepEqual(newestPage.advances.map((advance) => advance.advanceId), [newer.advanceId]);

  const byAdvance = await cliJson<ControlPlaneAdvancesResponse>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--advance",
    older.advanceId,
    "--limit",
    "1",
  ]);
  assert.deepEqual(byAdvance.filter.advanceIds, [older.advanceId]);
  assert.deepEqual(byAdvance.advances.map((advance) => advance.advanceId), [older.advanceId]);

  const timelineCommands = await cliJson<{
    commands: Array<{ action: string; advanceId: string | null; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--advance",
    newer.advanceId,
    "--commands-only",
    "--limit",
    "1",
  ]);
  assert.ok(timelineCommands.commands.some((command) => (
    command.action === "inspect_advance"
    && command.advanceId === newer.advanceId
    && command.command.includes("--advance")
    && command.command.includes(newer.advanceId)
  )));
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane advances smoke passed");

type ControlPlaneAdvancesResponse = {
  filter: { advanceIds: string[] };
  advances: Array<{ advanceId: string }>;
};

async function writeAdvanceRecord(options: {
  advanceId: string;
  observedAt: string;
  completedAt: string;
  selected: unknown | null;
}): Promise<{ advanceId: string }> {
  await writeWorkerSessionControlPlaneAdvanceRecord(settings.projectRoot, {
    advanceId: options.advanceId,
    session: sessionName,
    observedAt: options.observedAt,
    completedAt: options.completedAt,
    dryRun: true,
    selected: options.selected,
    executed: null,
    before: {},
    after: {},
  });
  return { advanceId: options.advanceId };
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}
