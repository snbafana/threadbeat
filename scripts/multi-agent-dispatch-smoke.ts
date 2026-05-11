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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-multi-agent-dispatch-smoke-"));
const sessionName = `multi-agent-smoke-${Date.now().toString(36)}`;
const runIds: string[] = [];

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-multi-agent-dispatch-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-multi-agent-dispatch-smoke",
};

const { app } = await buildServer(settings);
let baseUrl: string | null = null;
let sessionStarted = false;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://${settings.host}:${address.port}`;

  const agentA = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "multi-agent-dispatch-a",
    "--repo",
    "https://github.com/example/agent-a.git",
    "--ref",
    "main",
  ]);
  const agentB = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "multi-agent-dispatch-b",
    "--repo",
    "https://github.com/example/agent-b.git",
    "--ref",
    "main",
  ]);
  const agentIds = `${agentA.agent.id},${agentB.agent.id}`;
  const objectivesFile = path.join(tempRoot, "objectives.txt");
  await fs.writeFile(objectivesFile, "write research report a\nwrite research report b\n");

  const recoverableStopped = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentA.agent.id,
    "--objective",
    "recover existing stopped branch before dispatch",
  ]);
  runIds.push(recoverableStopped.run.id);
  assert.match(recoverableStopped.plan.branchName, /^threadbeat\/runs\//);
  await cliJson(baseUrl, ["runs", "stop", recoverableStopped.run.id]);

  const preview = await cliJson<{
    assignment: string;
    dryRun: boolean;
    planned: Array<{ agentId: string; objective: string }>;
    recoveryPreview: Array<{ runId: string; branchName: string; currentStatus?: string; dryRun?: boolean }>;
    session: { session: string; workerCount: number; workerPrefix: string; command: string[] };
    actions: { sessionWatch: string[]; sessionReview: string[]; branchQueue: string[]; results: string[]; stopSession: string[] };
  }>(baseUrl, [
    "runs",
    "dispatch",
    "--agents",
    agentIds,
    "--objectives-file",
    objectivesFile,
    "--assignment",
    "round-robin",
    "--session",
    sessionName,
    "--workers",
    "2",
    "--worker-prefix",
    "multi-agent-worker",
    "--recover",
    "--include-stopped",
    "--interval-ms",
    "100",
    "--idle-exit-after",
    "100",
    "--limit",
    "10",
    "--dry-run",
  ]);
  assert.equal(preview.assignment, "round-robin");
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.planned.map((item) => item.agentId), [agentA.agent.id, agentB.agent.id]);
  assert.deepEqual(preview.planned.map((item) => item.objective), ["write research report a", "write research report b"]);
  assert.ok(preview.recoveryPreview.some((run) => (
    run.runId === recoverableStopped.run.id
    && run.branchName === recoverableStopped.plan.branchName
    && run.currentStatus === "stopped"
    && run.dryRun === true
  )));
  assert.equal(preview.session.session, sessionName);
  assert.equal(preview.session.workerCount, 2);
  assert.equal(preview.session.workerPrefix, "multi-agent-worker");
  assert.ok(preview.session.command.includes("--loop"));
  assert.equal(preview.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${sessionName} --recoverable --include-stopped --next`);
  assert.equal(preview.actions.sessionReview.join(" "), `npm run cli -- runs session-review ${sessionName} --include-stopped`);
  assert.equal(preview.actions.branchQueue.join(" "), `npm run cli -- runs branches --session ${sessionName} --next`);
  assert.equal(preview.actions.results.join(" "), `npm run cli -- runs results --session ${sessionName}`);
  assert.equal(preview.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${sessionName} --recover`);

  const dispatched = await cliJson<{
    assignment: string;
    queued: Array<{ agentId: string; objective: string; run: { id: string } }>;
    recovered: Array<{ runId: string; branchName: string; status?: string }>;
    session: { session: string; workers: Array<{ workerId: string; pid: number | null }> };
    actions: { sessionStatus: string[]; sessionReview: string[]; results: string[]; sessionLogs: string[]; stopSession: string[] };
    backlog: Array<{ agentId: string; total: number; statuses: Record<string, number> }>;
  }>(baseUrl, [
    "runs",
    "dispatch",
    "--agents",
    agentIds,
    "--objectives-file",
    objectivesFile,
    "--assignment",
    "round-robin",
    "--session",
    sessionName,
    "--workers",
    "2",
    "--worker-prefix",
    "multi-agent-worker",
    "--recover",
    "--include-stopped",
    "--interval-ms",
    "100",
    "--idle-exit-after",
    "100",
    "--limit",
    "10",
  ]);
  sessionStarted = true;
  runIds.push(...dispatched.queued.map((item) => item.run.id));
  assert.equal(dispatched.assignment, "round-robin");
  assert.deepEqual(dispatched.queued.map((item) => item.agentId), [agentA.agent.id, agentB.agent.id]);
  assert.deepEqual(dispatched.queued.map((item) => item.objective), ["write research report a", "write research report b"]);
  assert.equal(dispatched.session.session, sessionName);
  assert.deepEqual(dispatched.session.workers.map((worker) => worker.workerId), [
    "multi-agent-worker-1",
    "multi-agent-worker-2",
  ]);
  assert.ok(dispatched.session.workers.every((worker) => typeof worker.pid === "number"));
  assert.ok(dispatched.recovered.some((run) => (
    run.runId === recoverableStopped.run.id
    && run.branchName === recoverableStopped.plan.branchName
    && run.status === "planned"
  )));
  assert.equal(dispatched.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${sessionName} --recoverable --include-stopped`);
  assert.equal(dispatched.actions.sessionReview.join(" "), `npm run cli -- runs session-review ${sessionName} --include-stopped`);
  assert.equal(dispatched.actions.results.join(" "), `npm run cli -- runs results --session ${sessionName}`);
  assert.equal(dispatched.actions.sessionLogs.join(" "), `npm run cli -- runs session-logs ${sessionName}`);
  assert.equal(dispatched.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${sessionName} --recover`);
  assert.ok(dispatched.backlog.some((agent) => agent.agentId === agentA.agent.id && agent.total >= 2));
  assert.ok(dispatched.backlog.some((agent) => agent.agentId === agentB.agent.id && agent.total >= 1));

  const status = await cliJson<{
    session: {
      session: string;
      workers: Array<{ workerId: string; alive: boolean; runs: Array<{ id: string; branchName: string; resultCommit: string | null }> }>;
    };
  }>(baseUrl, ["runs", "session-status", sessionName]);
  assert.equal(status.session.session, sessionName);
  assert.deepEqual(status.session.workers.map((worker) => worker.workerId), [
    "multi-agent-worker-1",
    "multi-agent-worker-2",
  ]);
  assert.ok(status.session.workers.some((worker) => worker.alive));

  const summary = await cliJson<{
    session: { workers: { total: number; alive: number } };
    totals: { runs: number; statuses: Record<string, number> };
    agents: Array<{ agentId: string; total: number }>;
  }>(baseUrl, ["runs", "session-summary", sessionName]);
  assert.equal(summary.session.workers.total, 2);
  assert.ok(summary.session.workers.alive >= 1);
  assert.ok(summary.totals.runs >= 3);
  assert.ok((summary.totals.statuses.planned ?? 0) + (summary.totals.statuses.running ?? 0) + (summary.totals.statuses.stopped ?? 0) >= 1);
  assert.deepEqual(summary.agents.map((agent) => agent.agentId).sort(), [agentA.agent.id, agentB.agent.id].sort());

  const results = await cliJson<{
    session: string;
    summary: { agents: number; total: number; changed: number | null };
    agents: Array<{ agentId: string; runs: Array<{ id: string; branchName: string; location?: string; workerId: string | null }> }>;
  }>(baseUrl, [
    "runs",
    "results",
    "--session",
    sessionName,
    "--status",
    "planned,running,stopped,completed",
  ]);
  assert.equal(results.session, sessionName);
  assert.equal(results.summary.agents, 2);
  assert.ok(results.summary.total >= dispatched.queued.length);
  assert.equal(results.summary.changed, null);
  for (const queued of dispatched.queued) {
    const visibleRun = results.agents.flatMap((agent) => agent.runs).find((run) => run.id === queued.run.id);
    assert.ok(visibleRun);
    assert.match(visibleRun.branchName, /^threadbeat\/runs\//);
    assert.ok(visibleRun.location === "unassigned" || visibleRun.location === "session_worker");
  }

  const monitor = await cliJson<{
    summary: { agents: number; runs: number; statuses: Record<string, number> };
    nextSteps: Array<{ runId: string; branchName: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "monitor",
    "--agents",
    agentIds,
    "--status",
    "planned,running,stopped",
    "--next",
  ]);
  assert.equal(monitor.summary.agents, 2);
  assert.ok(monitor.summary.runs >= 1);
  assert.ok(Object.values(monitor.summary.statuses).reduce((sum, count) => sum + count, 0) >= 1);
  assert.ok(monitor.nextSteps.every((step) => /^threadbeat\/runs\//.test(step.branchName)));
  assert.ok(monitor.nextSteps.every((step) => step.command[0] === "npm"));

  const stopped = await cliJson<{
    session: string;
    stopped: Array<{ workerId: string; stopped: boolean; alive: boolean }>;
  }>(baseUrl, ["runs", "stop-session", sessionName, "--recover"]);
  assert.equal(stopped.session, sessionName);
  assert.deepEqual(stopped.stopped.map((worker) => worker.workerId), [
    "multi-agent-worker-1",
    "multi-agent-worker-2",
  ]);
  assert.ok(stopped.stopped.every((worker) => worker.stopped && !worker.alive));
  sessionStarted = false;
} finally {
  if (baseUrl !== null) {
    const cleanupBaseUrl = baseUrl;
    if (sessionStarted) {
      try {
        await cliJson(cleanupBaseUrl, ["runs", "stop-session", sessionName, "--recover"]);
      } catch {
        // Best-effort cleanup for failed assertions before the explicit stop.
      }
    }
    await Promise.all(runIds.map(async (runId) => {
      try {
        await cliJson(cleanupBaseUrl, ["sandboxes", "stop-running", "--run", runId]);
      } catch {
        // The run may not have reached sandbox creation.
      }
    }));
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
