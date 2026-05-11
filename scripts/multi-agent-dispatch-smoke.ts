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
const superviseSessionName = `${sessionName}-supervise`;
const dispatchWaitSessionName = `${sessionName}-dispatch-wait`;
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
let superviseStarted = false;
let dispatchWaitStarted = false;

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
  const inspectedStopped = await cliJson<{
    run: { id: string; status: string; resultCommit: string | null };
    commands: { reviewRun: string[]; resumeBranch: string[] | null };
  }>(baseUrl, ["runs", "inspect", recoverableStopped.run.id]);
  assert.equal(inspectedStopped.run.status, "stopped");
  assert.equal(inspectedStopped.run.resultCommit, null);
  assert.equal(
    inspectedStopped.commands.reviewRun.join(" "),
    `npm run cli -- runs review ${recoverableStopped.run.id} --checkout-dir ./checkouts/${recoverableStopped.run.id}`,
  );
  assert.equal(inspectedStopped.commands.resumeBranch?.join(" "), `npm run cli -- runs resume-branch ${recoverableStopped.run.id}`);
  const watchedStopped = await cliJson<{
    run: { id: string; status: string; result_commit: string | null };
    branch: { branchName: string; resultCommit: string | null; state: string };
    commands: { reviewRun: string[]; resumeBranch: string[] | null };
    nextStep: { action: string; reason: string; command: string[] };
  }>(baseUrl, ["runs", "watch", recoverableStopped.run.id, "--max-polls", "1"]);
  assert.equal(watchedStopped.run.status, "stopped");
  assert.equal(watchedStopped.run.result_commit, null);
  assert.equal(watchedStopped.branch.branchName, recoverableStopped.plan.branchName);
  assert.equal(watchedStopped.branch.resultCommit, null);
  assert.equal(watchedStopped.branch.state, "resumable");
  assert.equal(
    watchedStopped.commands.reviewRun.join(" "),
    `npm run cli -- runs review ${recoverableStopped.run.id} --checkout-dir ./checkouts/${recoverableStopped.run.id}`,
  );
  assert.equal(watchedStopped.commands.resumeBranch?.join(" "), `npm run cli -- runs resume-branch ${recoverableStopped.run.id}`);
  assert.equal(watchedStopped.nextStep.action, "resume_branch");
  assert.equal(watchedStopped.nextStep.reason, "stopped_branch_without_result_commit");
  assert.equal(watchedStopped.nextStep.command.join(" "), `npm run cli -- runs resume-branch ${recoverableStopped.run.id}`);
  const resumableResults = await cliJson<{
    summary: { resumable: number };
    nextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      state: string;
      command: string[];
      commands: { resumeBranch: string[] | null };
    }>;
  }>(baseUrl, ["runs", "results", "--agent", agentA.agent.id, "--status", "stopped", "--next"]);
  assert.equal(resumableResults.summary.resumable, 1);
  assert.ok(resumableResults.nextSteps.some((step) => (
    step.runId === recoverableStopped.run.id
    && step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.state === "resumable"
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${recoverableStopped.run.id}`
    && step.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${recoverableStopped.run.id}`
  )));

  const supervisedRun = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentB.agent.id,
    "--objective",
    "run bounded supervise wait",
  ]);
  runIds.push(supervisedRun.run.id);
  superviseStarted = true;
  const supervised = await cliJson<{
    session: { session: string; workers: Array<{ workerId: string }> };
    wait: {
      completed: boolean;
      timedOut: boolean;
      summary: { workers: { total: number; alive: number; dead: number }; runs: number; statuses: Record<string, number> };
      commands: { sessionReview: string[]; branchQueue: string[]; results: string[]; checkoutSession: string[] };
    };
  }>(baseUrl, [
    "runs",
    "supervise",
    "--agents",
    agentB.agent.id,
    "--session",
    superviseSessionName,
    "--workers",
    "1",
    "--worker-prefix",
    "supervise-worker",
    "--until-empty",
    "--wait",
    "--interval-ms",
    "100",
    "--idle-exit-after",
    "1",
    "--max-polls",
    "20",
  ]);
  assert.equal(supervised.session.session, superviseSessionName);
  assert.deepEqual(supervised.session.workers.map((worker) => worker.workerId), ["supervise-worker-1"]);
  assert.equal(supervised.wait.completed, true);
  assert.equal(supervised.wait.timedOut, false);
  assert.equal(supervised.wait.summary.workers.total, 1);
  assert.equal(supervised.wait.summary.workers.alive, 0);
  assert.equal(supervised.wait.summary.workers.dead, 1);
  assert.ok(supervised.wait.summary.runs >= 1);
  assert.ok(Object.values(supervised.wait.summary.statuses).reduce((sum, count) => sum + count, 0) >= 1);
  assert.equal(supervised.wait.commands.sessionReview.join(" "), `npm run cli -- runs session-review ${superviseSessionName} --include-stopped`);
  assert.equal(supervised.wait.commands.branchQueue.join(" "), `npm run cli -- runs branches --session ${superviseSessionName} --next`);
  assert.equal(supervised.wait.commands.results.join(" "), `npm run cli -- runs results --session ${superviseSessionName}`);
  assert.equal(supervised.wait.commands.checkoutSession.join(" "), `npm run cli -- runs checkout-session ${superviseSessionName} --dir ./checkouts/${superviseSessionName}`);
  superviseStarted = false;

  dispatchWaitStarted = true;
  const dispatchWait = await cliJson<{
    assignment: string;
    queued: Array<{ agentId: string; objective: string; run: { id: string } }>;
    session: { session: string; workers: Array<{ workerId: string }> };
    wait: {
      completed: boolean;
      timedOut: boolean;
      summary: { workers: { total: number; alive: number; dead: number }; runs: number; statuses: Record<string, number> };
      commands: { sessionReview: string[]; branchQueue: string[]; results: string[]; checkoutSession: string[] };
    };
  }>(baseUrl, [
    "runs",
    "dispatch",
    "--agents",
    agentB.agent.id,
    "--objective",
    "queue and wait for bounded dispatch",
    "--session",
    dispatchWaitSessionName,
    "--workers",
    "1",
    "--worker-prefix",
    "dispatch-wait-worker",
    "--assignment",
    "round-robin",
    "--until-empty",
    "--wait",
    "--interval-ms",
    "100",
    "--idle-exit-after",
    "1",
    "--max-polls",
    "20",
  ]);
  dispatchWaitStarted = false;
  runIds.push(...dispatchWait.queued.map((item) => item.run.id));
  assert.equal(dispatchWait.assignment, "round-robin");
  assert.deepEqual(dispatchWait.queued.map((item) => item.agentId), [agentB.agent.id]);
  assert.deepEqual(dispatchWait.queued.map((item) => item.objective), ["queue and wait for bounded dispatch"]);
  assert.equal(dispatchWait.session.session, dispatchWaitSessionName);
  assert.deepEqual(dispatchWait.session.workers.map((worker) => worker.workerId), ["dispatch-wait-worker-1"]);
  assert.equal(dispatchWait.wait.completed, true);
  assert.equal(dispatchWait.wait.timedOut, false);
  assert.equal(dispatchWait.wait.summary.workers.total, 1);
  assert.equal(dispatchWait.wait.summary.workers.alive, 0);
  assert.equal(dispatchWait.wait.summary.workers.dead, 1);
  assert.ok(dispatchWait.wait.summary.runs >= 1);
  assert.ok(Object.values(dispatchWait.wait.summary.statuses).reduce((sum, count) => sum + count, 0) >= 1);
  assert.equal(dispatchWait.wait.commands.sessionReview.join(" "), `npm run cli -- runs session-review ${dispatchWaitSessionName} --include-stopped`);
  assert.equal(dispatchWait.wait.commands.branchQueue.join(" "), `npm run cli -- runs branches --session ${dispatchWaitSessionName} --next`);
  assert.equal(dispatchWait.wait.commands.results.join(" "), `npm run cli -- runs results --session ${dispatchWaitSessionName}`);
  assert.equal(dispatchWait.wait.commands.checkoutSession.join(" "), `npm run cli -- runs checkout-session ${dispatchWaitSessionName} --dir ./checkouts/${dispatchWaitSessionName}`);

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

  const sessionStopped = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentA.agent.id,
    "--objective",
    "inspect stopped branch from session watch",
  ]);
  runIds.push(sessionStopped.run.id);
  await cliJson(baseUrl, ["runs", "stop", sessionStopped.run.id]);
  const sessionWatch = await cliJson<{
    checkoutDir: string;
    branchNextSteps: Array<{
      runId: string;
      branchName: string;
      command: string[];
      commands: { checkoutBranch: string[]; inspectRun: string[]; reviewRun: string[]; watchRun: string[]; resumeBranch: string[] };
    }>;
  }>(baseUrl, [
    "runs",
    "session-watch",
    sessionName,
    "--recoverable",
    "--include-stopped",
    "--next",
    "--max-polls",
    "1",
    "--checkout-dir",
    "./checkouts/session-watch",
  ]);
  const watchedBranch = sessionWatch.branchNextSteps.find((step) => step.runId === sessionStopped.run.id);
  assert.ok(watchedBranch);
  assert.equal(sessionWatch.checkoutDir, "./checkouts/session-watch");
  assert.equal(watchedBranch.branchName, sessionStopped.plan.branchName);
  assert.equal(watchedBranch.command.join(" "), `npm run cli -- runs resume-branch ${sessionStopped.run.id}`);
  assert.equal(
    watchedBranch.commands.checkoutBranch.join(" "),
    `npm run cli -- runs checkout ${sessionStopped.run.id} --dir ./checkouts/session-watch/${sessionStopped.run.id}`,
  );
  assert.equal(watchedBranch.commands.inspectRun.join(" "), `npm run cli -- runs inspect ${sessionStopped.run.id}`);
  assert.equal(
    watchedBranch.commands.reviewRun.join(" "),
    `npm run cli -- runs review ${sessionStopped.run.id} --checkout-dir ./checkouts/session-watch/${sessionStopped.run.id}`,
  );
  assert.equal(
    watchedBranch.commands.watchRun.join(" "),
    `npm run cli -- runs watch ${sessionStopped.run.id} --checkout-dir ./checkouts/session-watch/${sessionStopped.run.id}`,
  );
  assert.equal(watchedBranch.commands.resumeBranch.join(" "), `npm run cli -- runs resume-branch ${sessionStopped.run.id}`);
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
    if (superviseStarted) {
      try {
        await cliJson(cleanupBaseUrl, ["runs", "stop-session", superviseSessionName, "--recover"]);
      } catch {
        // The supervise smoke may have failed before the session file existed.
      }
    }
    if (dispatchWaitStarted) {
      try {
        await cliJson(cleanupBaseUrl, ["runs", "stop-session", dispatchWaitSessionName, "--recover"]);
      } catch {
        // The dispatch wait smoke may have failed before the session file existed.
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
  await cleanupSession(superviseSessionName);
  await cleanupSession(dispatchWaitSessionName);
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
