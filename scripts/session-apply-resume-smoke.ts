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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-session-apply-resume-smoke-"));
const sessionName = `session-apply-resume-${Date.now().toString(36)}`;
const applyId = "session-apply-resume-smoke";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-session-apply-resume-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-session-apply-resume-smoke",
};

const { app } = await buildServer(settings);
let baseUrl: string | null = null;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://${settings.host}:${address.port}`;

  const agent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "session-apply-resume-smoke-agent",
    "--repo",
    "https://github.com/example/session-apply-resume-smoke-agent.git",
    "--ref",
    "main",
  ]);
  await writeSessionRecord(baseUrl, agent.agent.id);

  const planned = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "session apply resume smoke",
  ]);
  await cliJson(baseUrl, ["runs", "stop", planned.run.id]);

  const firstApply = await cliJson<{
    resume: boolean;
    selected: number;
    skippedCompleted: number;
    commandsToRun: Array<{ runId?: string }>;
    executions: Array<{ runId: string | null; exitCode: number | null }>;
  }>(baseUrl, sessionApplyArgs(planned.run.id));
  assert.equal(firstApply.resume, false);
  assert.equal(firstApply.selected, 1);
  assert.equal(firstApply.skippedCompleted, 0);
  assert.deepEqual(firstApply.commandsToRun.map((command) => command.runId), [planned.run.id]);
  assert.deepEqual(firstApply.executions.map((execution) => execution.runId), [planned.run.id]);
  assert.deepEqual(firstApply.executions.map((execution) => execution.exitCode), [0]);

  const resumedApply = await cliJson<{
    resume: boolean;
    selected: number;
    skippedCompleted: number;
    skippedByResumeFilter: number;
    commandsToRun: Array<{ runId?: string }>;
    executions: Array<{ runId: string | null; exitCode: number | null }>;
  }>(baseUrl, [...sessionApplyArgs(planned.run.id), "--resume"]);
  assert.equal(resumedApply.resume, true);
  assert.equal(resumedApply.selected, 1);
  assert.equal(resumedApply.skippedCompleted, 1);
  assert.equal(resumedApply.skippedByResumeFilter, 0);
  assert.deepEqual(resumedApply.commandsToRun, []);
  assert.deepEqual(resumedApply.executions.map((execution) => execution.runId), [planned.run.id]);
  assert.deepEqual(resumedApply.executions.map((execution) => execution.exitCode), [0]);
} finally {
  await cleanupSession(sessionName);
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("session apply resume smoke passed");

function sessionApplyArgs(runId: string): string[] {
  return [
    "runs",
    "session-apply",
    sessionName,
    "--source",
    "status",
    "--include-stopped",
    "--branch-action",
    "resume_branch",
    "--run",
    runId,
    "--limit",
    "1",
    "--apply-id",
    applyId,
  ];
}

async function writeSessionRecord(baseUrl: string, agentId: string): Promise<void> {
  await fs.mkdir(path.join(".threadbeat", "worker-sessions"), { recursive: true });
  await fs.writeFile(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), `${JSON.stringify({
    session: sessionName,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", agentId],
    workers: [],
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

async function cleanupSession(session: string): Promise<void> {
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${session}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "apply", session), { recursive: true, force: true });
}
