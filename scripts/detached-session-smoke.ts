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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-detached-session-smoke-"));
const sessionName = `detached-smoke-${Date.now().toString(36)}`;

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-detached-session-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-detached-session-smoke",
};

const { app } = await buildServer(settings);
let baseUrl: string | null = null;
let sessionStarted = false;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://${settings.host}:${address.port}`;

  const agent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "detached-session-smoke-agent",
    "--repo",
    "https://github.com/example/agent.git",
    "--ref",
    "main",
  ]);
  const planned = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session smoke branch",
  ]);
  assert.match(planned.plan.branchName, /^threadbeat\/runs\//);
  const stalePlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session stale running branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    stalePlan.run.id,
    "--worker-id",
    "detached-smoke-worker-1",
  ]);
  const stoppedPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session unassigned stopped branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", stoppedPlan.run.id]);
  const workerStoppedPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session worker stopped branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    workerStoppedPlan.run.id,
    "--worker-id",
    "detached-smoke-worker-1",
  ]);
  await cliJson(baseUrl, ["runs", "stop", workerStoppedPlan.run.id]);

  const session = await cliJson<{
    session: {
      session: string;
      workers: Array<{ workerId: string; pid: number | null; stdoutPath: string; stderrPath: string }>;
    };
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    agent.agent.id,
    "--workers",
    "1",
    "--worker-prefix",
    "detached-smoke-worker",
    "--detach",
    "--session",
    sessionName,
    "--loop",
    "--idle-exit-after",
    "30",
    "--interval-ms",
    "100",
  ]);
  assert.equal(session.session.session, sessionName);
  assert.equal(session.session.workers.length, 1);
  assert.equal(session.session.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(typeof session.session.workers[0].pid, "number");
  sessionStarted = true;

  const status = await cliJson<{
    session: {
      session: string;
      workers: Array<{ workerId: string; alive: boolean; runs: Array<{ id: string; branchName: string }> }>;
    };
  }>(baseUrl, ["runs", "session-status", sessionName]);
  assert.equal(status.session.session, sessionName);
  assert.equal(status.session.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(status.session.workers[0].alive, true);
  const recoverableStatus = await cliJson<{
    recoveryPreview: Array<{
      runId: string;
      currentStatus?: string;
      dryRun?: boolean;
      resultCommit?: string | null;
      workerId?: string | null;
    }>;
    branchNextSteps: Array<{
      runId: string;
      action: string;
      reason: string;
      location: string;
      recoverable: boolean;
      workerId: string | null;
      command: string[];
      commands: { resumeBranch: string[]; recoverStopped: string[] | null };
    }>;
  }>(baseUrl, ["runs", "session-status", sessionName, "--recoverable", "--include-stopped"]);
  assert.ok(recoverableStatus.recoveryPreview.some((run) => (
    run.runId === stalePlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  assert.ok(recoverableStatus.recoveryPreview.some((run) => (
    run.runId === stoppedPlan.run.id
    && run.currentStatus === "stopped"
    && run.dryRun === true
    && run.resultCommit === null
    && run.workerId === null
  )));
  assert.ok(recoverableStatus.branchNextSteps.some((step) => (
    step.runId === stoppedPlan.run.id
    && step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.location === "unassigned"
    && step.recoverable === true
    && step.workerId === null
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
    && step.commands.resumeBranch.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
    && step.commands.recoverStopped?.join(" ") === `npm run cli -- runs recover-session ${sessionName} --include-stopped`
  )));

  const actions = await cliJson<{
    actions: { sessionStatus: string[]; sessionWatch: string[]; stopSession: string[] };
  }>(baseUrl, ["runs", "session-actions", sessionName]);
  assert.equal(actions.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${sessionName} --recoverable --include-stopped`);
  assert.equal(actions.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${sessionName} --recoverable --include-stopped --next`);
  assert.equal(actions.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${sessionName} --recover`);

  const recoveredPreview = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; currentStatus?: string; dryRun?: boolean }>;
  }>(baseUrl, ["runs", "recover-session", sessionName, "--dry-run"]);
  assert.equal(recoveredPreview.session, sessionName);
  assert.ok(recoveredPreview.recovered.some((run) => (
    run.runId === stalePlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  const recovered = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; status?: string; workerId: string | null }>;
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "recover-session", sessionName]);
  assert.equal(recovered.session, sessionName);
  assert.equal(recovered.status.session.session, sessionName);
  assert.ok(recovered.recovered.some((run) => (
    run.runId === stalePlan.run.id
    && run.status === "planned"
    && run.workerId === null
  )));
  const resumePreview = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; currentStatus?: string; dryRun?: boolean; branchName: string; workerId: string | null }>;
  }>(baseUrl, ["runs", "resume-session", sessionName, "--worker-id", "detached-smoke-worker-1", "--dry-run"]);
  assert.equal(resumePreview.session, sessionName);
  assert.deepEqual(resumePreview.resumed.map((run) => run.runId), [workerStoppedPlan.run.id]);
  assert.equal(resumePreview.resumed[0].branchName, workerStoppedPlan.plan.branchName);
  assert.equal(resumePreview.resumed[0].workerId, "detached-smoke-worker-1");
  assert.equal(resumePreview.resumed[0].currentStatus, "stopped");
  assert.equal(resumePreview.resumed[0].dryRun, true);
  const resumed = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "resume-session", sessionName, "--worker-id", "detached-smoke-worker-1"]);
  assert.equal(resumed.session, sessionName);
  assert.equal(resumed.status.session.session, sessionName);
  assert.deepEqual(resumed.resumed.map((run) => run.runId), [workerStoppedPlan.run.id]);
  assert.equal(resumed.resumed[0].status, "planned");
  assert.equal(resumed.resumed[0].workerId, null);

  const logs = await cliJson<{
    workers: Array<{ workerId: string; alive: boolean; stdout: { path: string }; stderr: { path: string } }>;
  }>(baseUrl, ["runs", "session-logs", sessionName, "--lines", "5"]);
  assert.equal(logs.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(logs.workers[0].alive, true);
  assert.match(logs.workers[0].stdout.path, /worker-sessions/);
  assert.match(logs.workers[0].stderr.path, /worker-sessions/);

  const stopped = await cliJson<{
    session: string;
    stopped: Array<{ workerId: string; pid: number | null; stopped: boolean; alive: boolean }>;
  }>(baseUrl, ["runs", "stop-session", sessionName]);
  assert.equal(stopped.session, sessionName);
  assert.equal(stopped.stopped[0].workerId, "detached-smoke-worker-1");
  assert.equal(stopped.stopped[0].stopped, true);
  assert.equal(stopped.stopped[0].alive, false);

  const stoppedSessions = await cliJson<{
    sessions: Array<{ session: string; workers: Array<{ alive: boolean }> }>;
  }>(baseUrl, ["runs", "sessions", "--session", sessionName]);
  assert.equal(stoppedSessions.sessions[0].workers[0].alive, false);
} finally {
  if (sessionStarted && baseUrl !== null) {
    try {
      await cliJson(baseUrl, ["runs", "stop-session", sessionName]);
    } catch {
      // Best-effort cleanup for failed assertions before the explicit stop.
    }
  }
  await cleanupSession(sessionName);
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
  });
  return JSON.parse(stdout) as T;
}

async function cleanupSession(session: string): Promise<void> {
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${session}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", session), { recursive: true, force: true });
}
