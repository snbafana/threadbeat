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

  const apiResumeAgent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "detached-session-api-resume-agent",
    "--repo",
    "https://github.com/example/api-resume-agent.git",
    "--ref",
    "main",
  ]);
  const apiResumePlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    apiResumeAgent.agent.id,
    "--objective",
    "detached session api resume branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", apiResumePlan.run.id]);
  const apiResumePreviewResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${apiResumePlan.run.id}/resume-branch`,
    payload: { dryRun: true },
  });
  assert.equal(apiResumePreviewResponse.statusCode, 200);
  const apiResumePreview = JSON.parse(apiResumePreviewResponse.body) as {
    resumable: { runId: string; branchName: string; resultCommit: string | null; currentStatus: string };
    dryRun: boolean;
  };
  assert.equal(apiResumePreview.resumable.runId, apiResumePlan.run.id);
  assert.equal(apiResumePreview.resumable.branchName, apiResumePlan.plan.branchName);
  assert.equal(apiResumePreview.resumable.resultCommit, null);
  assert.equal(apiResumePreview.resumable.currentStatus, "stopped");
  assert.equal(apiResumePreview.dryRun, true);
  const apiResumeResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${apiResumePlan.run.id}/resume-branch`,
    payload: { workerId: "api-resumer" },
  });
  assert.equal(apiResumeResponse.statusCode, 200);
  const apiResume = JSON.parse(apiResumeResponse.body) as {
    resumed: { runId: string; branchName: string; status: string; workerId: string | null };
    run: { id: string; status: string; worker_id: string | null };
  };
  assert.equal(apiResume.resumed.runId, apiResumePlan.run.id);
  assert.equal(apiResume.resumed.branchName, apiResumePlan.plan.branchName);
  assert.equal(apiResume.resumed.status, "planned");
  assert.equal(apiResume.resumed.workerId, null);
  assert.equal(apiResume.run.id, apiResumePlan.run.id);
  assert.equal(apiResume.run.status, "planned");
  assert.equal(apiResume.run.worker_id, null);
  const apiResumeMessages = await cliJson<{ messages: Array<{ type: string; text: string | null }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    apiResumePlan.run.id,
  ]);
  assert.ok(apiResumeMessages.messages.some((message) => (
    message.type === "agent_run_requeued" && message.text === "Requeued run by api-resumer"
  )));

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
    actions: {
      sessionStatus: string[];
      sessionWait: string[];
      sessionWatch: string[];
      stopSession: string[];
      recoverSession: string[];
      resumeSession: string[];
      restartSession: string[];
      restartSessionWithStopped: string[];
    };
  }>(baseUrl, ["runs", "session-actions", sessionName]);
  assert.equal(actions.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${sessionName} --recoverable --include-stopped`);
  assert.equal(actions.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(actions.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${sessionName} --recoverable --include-stopped --next`);
  assert.equal(actions.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${sessionName} --recover`);
  assert.equal(actions.actions.recoverSession.join(" "), `npm run cli -- runs recover-session ${sessionName}`);
  assert.equal(actions.actions.resumeSession.join(" "), `npm run cli -- runs resume-session ${sessionName}`);
  assert.equal(actions.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);
  assert.equal(actions.actions.restartSessionWithStopped.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover --resume-stopped`);

  const recoveredPreview = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; currentStatus?: string; dryRun?: boolean }>;
    actions: { recoverSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, ["runs", "recover-session", sessionName, "--dry-run"]);
  assert.equal(recoveredPreview.session, sessionName);
  assert.ok(recoveredPreview.recovered.some((run) => (
    run.runId === stalePlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  assert.equal(recoveredPreview.nextStep.action, "recover_session");
  assert.equal(recoveredPreview.nextStep.reason, "dry_run_preview");
  assert.equal(recoveredPreview.nextStep.command.join(" "), `npm run cli -- runs recover-session ${sessionName}`);
  assert.equal(recoveredPreview.actions.recoverSession.join(" "), `npm run cli -- runs recover-session ${sessionName}`);
  const recovered = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; status?: string; workerId: string | null }>;
    actions: { sessionWait: string[]; restartSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "recover-session", sessionName]);
  assert.equal(recovered.session, sessionName);
  assert.equal(recovered.status.session.session, sessionName);
  assert.ok(recovered.recovered.some((run) => (
    run.runId === stalePlan.run.id
    && run.status === "planned"
    && run.workerId === null
  )));
  assert.equal(recovered.nextStep.action, "wait_session");
  assert.equal(recovered.nextStep.reason, "recovered_runs_for_live_workers");
  assert.equal(recovered.nextStep.command.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(recovered.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(recovered.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);
  const resumePreview = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; currentStatus?: string; dryRun?: boolean; branchName: string; workerId: string | null }>;
    actions: { resumeSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, ["runs", "resume-session", sessionName, "--worker-id", "detached-smoke-worker-1", "--dry-run"]);
  assert.equal(resumePreview.session, sessionName);
  assert.deepEqual(resumePreview.resumed.map((run) => run.runId), [workerStoppedPlan.run.id]);
  assert.equal(resumePreview.resumed[0].branchName, workerStoppedPlan.plan.branchName);
  assert.equal(resumePreview.resumed[0].workerId, "detached-smoke-worker-1");
  assert.equal(resumePreview.resumed[0].currentStatus, "stopped");
  assert.equal(resumePreview.resumed[0].dryRun, true);
  assert.equal(resumePreview.nextStep.action, "resume_session");
  assert.equal(resumePreview.nextStep.reason, "dry_run_preview");
  assert.equal(resumePreview.nextStep.command.join(" "), `npm run cli -- runs resume-session ${sessionName} --worker-id detached-smoke-worker-1`);
  assert.equal(resumePreview.actions.resumeSession.join(" "), `npm run cli -- runs resume-session ${sessionName} --worker-id detached-smoke-worker-1`);
  const resumed = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
    actions: { sessionWait: string[]; restartSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "resume-session", sessionName, "--worker-id", "detached-smoke-worker-1"]);
  assert.equal(resumed.session, sessionName);
  assert.equal(resumed.status.session.session, sessionName);
  assert.deepEqual(resumed.resumed.map((run) => run.runId), [workerStoppedPlan.run.id]);
  assert.equal(resumed.resumed[0].status, "planned");
  assert.equal(resumed.resumed[0].workerId, null);
  assert.equal(resumed.nextStep.action, "wait_session");
  assert.equal(resumed.nextStep.reason, "resumed_runs_for_live_workers");
  assert.equal(resumed.nextStep.command.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(resumed.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(resumed.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);

  const logs = await cliJson<{
    workers: Array<{ workerId: string; alive: boolean; stdout: { path: string }; stderr: { path: string } }>;
  }>(baseUrl, ["runs", "session-logs", sessionName, "--lines", "5"]);
  assert.equal(logs.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(logs.workers[0].alive, true);
  assert.match(logs.workers[0].stdout.path, /worker-sessions/);
  assert.match(logs.workers[0].stderr.path, /worker-sessions/);

  const apiNextResponse = await app.inject({
    method: "GET",
    url: `/api/worker-sessions/${sessionName}/next?lines=2`,
  });
  assert.equal(apiNextResponse.statusCode, 200);
  const apiNext = JSON.parse(apiNextResponse.body) as {
    session: string;
    aliveWorkers: number;
    nextStep: { action: string; reason: string; count: number; command: string[] };
    watchWorkerActions: { restart_session_watch_worker: number };
    watchWorkerNextSteps: unknown[];
    workers: Array<{ workerId: string; alive: boolean }>;
  };
  assert.equal(apiNext.session, sessionName);
  assert.equal(apiNext.aliveWorkers, 1);
  assert.equal(apiNext.nextStep.action, "inspect_live_session");
  assert.equal(apiNext.nextStep.reason, "live_worker_session");
  assert.equal(apiNext.nextStep.count, 1);
  assert.equal(apiNext.nextStep.command.join(" "), `npm run cli -- runs session-summary ${sessionName} --next`);
  assert.equal(apiNext.watchWorkerActions.restart_session_watch_worker, 0);
  assert.deepEqual(apiNext.watchWorkerNextSteps, []);
  assert.equal(apiNext.workers[0].workerId, "detached-smoke-worker-1");
  assert.equal(apiNext.workers[0].alive, true);

  const apiBranchesResponse = await app.inject({
    method: "GET",
    url: `/api/worker-sessions/${sessionName}/branches?resumable=true`,
  });
  assert.equal(apiBranchesResponse.statusCode, 200);
  const apiBranches = JSON.parse(apiBranchesResponse.body) as {
    session: string;
    checkoutDir: string;
    filter: { statuses: string[]; resumable: boolean; workerId: string | null };
    summary: { total: number; resultCommits: number; resumable: number; warnings: number };
    resultCommits: unknown[];
    resumableBranches: Array<{
      runId: string;
      resultCommit: string | null;
      location: string;
      commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[]; resumeBranch: string[] | null };
      links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
    }>;
    nextSteps: Array<{ action: string; reason: string; runId: string; command: string[] }>;
  };
  assert.equal(apiBranches.session, sessionName);
  assert.equal(apiBranches.checkoutDir, `./checkouts/${sessionName}-branches`);
  assert.deepEqual(apiBranches.filter.statuses, ["completed", "stopped"]);
  assert.equal(apiBranches.filter.resumable, true);
  assert.equal(apiBranches.filter.workerId, null);
  assert.ok(apiBranches.summary.total >= 1);
  assert.equal(apiBranches.summary.resultCommits, 0);
  assert.ok(apiBranches.summary.resumable >= 1);
  assert.equal(apiBranches.resultCommits.length, 0);
  assert.ok(apiBranches.resumableBranches.some((run) => (
    run.runId === stoppedPlan.run.id
    && run.resultCommit === null
    && run.location === "unassigned"
    && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${stoppedPlan.run.id} --dir ./checkouts/${sessionName}-branches/${stoppedPlan.run.id}`
    && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${stoppedPlan.run.id} --checkout-dir ./checkouts/${sessionName}-branches/${stoppedPlan.run.id}`
    && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${stoppedPlan.run.id}`
    && run.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
    && run.links.branchTreeUrl !== null
    && run.links.resultCommitUrl === null
  )));
  assert.ok(apiBranches.nextSteps.some((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.runId === stoppedPlan.run.id
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
  )));

  const stopped = await cliJson<{
    session: string;
    stopped: Array<{ workerId: string; pid: number | null; stopped: boolean; alive: boolean }>;
    recovered: Array<{ runId: string; status?: string; workerId: string | null }>;
  }>(baseUrl, ["runs", "stop-session", sessionName, "--recover", "--include-stopped"]);
  assert.equal(stopped.session, sessionName);
  assert.equal(stopped.stopped[0].workerId, "detached-smoke-worker-1");
  assert.equal(stopped.stopped[0].stopped, true);
  assert.equal(stopped.stopped[0].alive, false);
  assert.ok(stopped.recovered.some((run) => (
    run.runId === stoppedPlan.run.id
    && run.status === "planned"
    && run.workerId === null
  )));

  const stoppedSessions = await cliJson<{
    sessions: Array<{ session: string; workers: Array<{ alive: boolean }> }>;
  }>(baseUrl, ["runs", "sessions", "--session", sessionName]);
  assert.equal(stoppedSessions.sessions[0].workers[0].alive, false);

  const apiSessionResumePlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session api resume branches",
  ]);
  await cliJson(baseUrl, ["runs", "claim", apiSessionResumePlan.run.id, "--worker-id", "detached-smoke-worker-1"]);
  await cliJson(baseUrl, ["runs", "stop", apiSessionResumePlan.run.id]);
  const apiSessionResumePreviewResponse = await app.inject({
    method: "POST",
    url: `/api/worker-sessions/${sessionName}/resume-branches`,
    payload: { workerId: "detached-smoke-worker-1", dryRun: true },
  });
  assert.equal(apiSessionResumePreviewResponse.statusCode, 200);
  const apiSessionResumePreview = JSON.parse(apiSessionResumePreviewResponse.body) as {
    session: string;
    resumed: Array<{ runId: string; branchName: string; workerId: string | null; currentStatus?: string; dryRun?: boolean }>;
    nextStep: { action: string; reason: string; command: string[] };
  };
  assert.equal(apiSessionResumePreview.session, sessionName);
  assert.deepEqual(apiSessionResumePreview.resumed.map((run) => run.runId), [apiSessionResumePlan.run.id]);
  assert.equal(apiSessionResumePreview.resumed[0].branchName, apiSessionResumePlan.plan.branchName);
  assert.equal(apiSessionResumePreview.resumed[0].workerId, "detached-smoke-worker-1");
  assert.equal(apiSessionResumePreview.resumed[0].currentStatus, "stopped");
  assert.equal(apiSessionResumePreview.resumed[0].dryRun, true);
  assert.equal(apiSessionResumePreview.nextStep.action, "resume_session");
  assert.equal(apiSessionResumePreview.nextStep.reason, "dry_run_preview");
  assert.equal(apiSessionResumePreview.nextStep.command.join(" "), `npm run cli -- runs resume-session ${sessionName} --worker-id detached-smoke-worker-1`);
  const apiSessionResumeResponse = await app.inject({
    method: "POST",
    url: `/api/worker-sessions/${sessionName}/resume-branches`,
    payload: { workerId: "detached-smoke-worker-1" },
  });
  assert.equal(apiSessionResumeResponse.statusCode, 200);
  const apiSessionResume = JSON.parse(apiSessionResumeResponse.body) as {
    session: string;
    resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
    nextStep: { action: string; reason: string };
    status: { session: { session: string } };
  };
  assert.equal(apiSessionResume.session, sessionName);
  assert.equal(apiSessionResume.status.session.session, sessionName);
  assert.deepEqual(apiSessionResume.resumed.map((run) => run.runId), [apiSessionResumePlan.run.id]);
  assert.equal(apiSessionResume.resumed[0].status, "planned");
  assert.equal(apiSessionResume.resumed[0].workerId, null);
  assert.equal(apiSessionResume.nextStep.action, "restart_session");
  assert.equal(apiSessionResume.nextStep.reason, "resumed_runs_without_live_workers");
  const apiSessionResumeMessages = await cliJson<{ messages: Array<{ type: string; text: string | null }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    apiSessionResumePlan.run.id,
  ]);
  assert.ok(apiSessionResumeMessages.messages.some((message) => (
    message.type === "agent_run_requeued" && message.text === "Requeued run by detached-smoke-worker-1"
  )));

  const deadWorkerPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session dead worker recovery",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    deadWorkerPlan.run.id,
    "--worker-id",
    "detached-smoke-worker-1",
  ]);
  const deadWorkerWait = await cliJson<{
    session: string;
    completed: boolean;
    timedOut: boolean;
    summary: { workers: { alive: number }; recoveryCandidates: number; recoverableActive: number };
    recoveryPreview: Array<{ runId: string; currentStatus?: string }>;
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, [
    "runs",
    "session-wait",
    sessionName,
    "--recoverable",
    "--include-stopped",
    "--interval-ms",
    "100",
    "--max-polls",
    "1",
  ]);
  assert.equal(deadWorkerWait.session, sessionName);
  assert.equal(deadWorkerWait.completed, true);
  assert.equal(deadWorkerWait.timedOut, false);
  assert.equal(deadWorkerWait.summary.workers.alive, 0);
  assert.ok(deadWorkerWait.summary.recoveryCandidates >= 1);
  assert.ok(deadWorkerWait.summary.recoverableActive >= 1);
  assert.ok(deadWorkerWait.recoveryPreview.some((run) => (
    run.runId === deadWorkerPlan.run.id
    && run.currentStatus === "running"
  )));
  assert.equal(deadWorkerWait.nextStep.action, "recover_session");
  assert.equal(deadWorkerWait.nextStep.reason, "stale_running_claims");
  assert.equal(deadWorkerWait.nextStep.command.join(" "), `npm run cli -- runs recover-session ${sessionName}`);

  const deadWorkerRecovery = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; status?: string; workerId: string | null }>;
    actions: { sessionWait: string[]; restartSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
    status: { session: { workers: Array<{ alive: boolean }> } };
  }>(baseUrl, ["runs", "recover-session", sessionName]);
  assert.equal(deadWorkerRecovery.session, sessionName);
  assert.ok(deadWorkerRecovery.recovered.some((run) => (
    run.runId === deadWorkerPlan.run.id
    && run.status === "planned"
    && run.workerId === null
  )));
  assert.equal(deadWorkerRecovery.status.session.workers[0].alive, false);
  assert.equal(deadWorkerRecovery.nextStep.action, "restart_session");
  assert.equal(deadWorkerRecovery.nextStep.reason, "recovered_runs_without_live_workers");
  assert.equal(deadWorkerRecovery.nextStep.command.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);
  assert.equal(deadWorkerRecovery.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(deadWorkerRecovery.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);

  const deadWorkerStoppedPlan = await cliJson<{
    run: { id: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session dead worker stopped branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    deadWorkerStoppedPlan.run.id,
    "--worker-id",
    "detached-smoke-worker-1",
  ]);
  await cliJson(baseUrl, ["runs", "stop", deadWorkerStoppedPlan.run.id]);
  const deadWorkerStoppedWait = await cliJson<{
    session: string;
    completed: boolean;
    timedOut: boolean;
    summary: {
      workers: { alive: number };
      resumableBranches: number;
      recoverableActive: number;
    };
    nextStep: { action: string; reason: string; command: string[] };
  }>(baseUrl, [
    "runs",
    "session-wait",
    sessionName,
    "--recoverable",
    "--include-stopped",
    "--interval-ms",
    "100",
    "--max-polls",
    "1",
  ]);
  assert.equal(deadWorkerStoppedWait.session, sessionName);
  assert.equal(deadWorkerStoppedWait.completed, true);
  assert.equal(deadWorkerStoppedWait.timedOut, false);
  assert.equal(deadWorkerStoppedWait.summary.workers.alive, 0);
  assert.ok(deadWorkerStoppedWait.summary.resumableBranches >= 1);
  assert.equal(deadWorkerStoppedWait.summary.recoverableActive, 0);
  assert.equal(deadWorkerStoppedWait.nextStep.action, "restart_session_with_stopped");
  assert.equal(deadWorkerStoppedWait.nextStep.reason, "dead_workers_and_resumable_branches");
  assert.equal(
    deadWorkerStoppedWait.nextStep.command.join(" "),
    `npm run cli -- runs restart-session ${sessionName} --recover --resume-stopped`,
  );

  const restarted = await cliJson<{
    session: string;
    restarted: Array<{ workerId: string; pid: number | null }>;
    status: {
      session: {
        command: string[];
        workers: Array<{ workerId: string; alive: boolean }>;
      };
    };
    wait: {
      completed: boolean;
      timedOut: boolean;
      polls: number;
      summary: { workers: { total: number; alive: number; dead: number } };
      commands: {
        sessionWatch: string[];
        stopSession: string[];
        restartSession: string[];
        restartSessionWithStopped: string[];
      };
      nextStep: { action: string; reason: string; command: string[] };
    };
  }>(baseUrl, [
    "runs",
    "restart-session",
    sessionName,
    "--recover",
    "--resume-stopped",
    "--wait",
    "--interval-ms",
    "100",
    "--max-polls",
    "1",
  ]);
  assert.equal(restarted.session, sessionName);
  assert.deepEqual(restarted.restarted.map((worker) => worker.workerId), ["detached-smoke-worker-1"]);
  assert.equal(typeof restarted.restarted[0].pid, "number");
  assert.ok(restarted.status.session.command.includes("--resume-stopped"));
  assert.ok(restarted.status.session.workers.some((worker) => (
    worker.workerId === "detached-smoke-worker-1" && worker.alive
  )));
  assert.equal(restarted.wait.completed, false);
  assert.equal(restarted.wait.timedOut, true);
  assert.equal(restarted.wait.polls, 1);
  assert.equal(restarted.wait.summary.workers.total, 1);
  assert.equal(restarted.wait.summary.workers.alive, 1);
  assert.equal(restarted.wait.summary.workers.dead, 0);
  assert.equal(restarted.wait.nextStep.action, "continue_watch");
  assert.equal(restarted.wait.nextStep.reason, "workers_still_alive");
  assert.equal(restarted.wait.nextStep.command.join(" "), `npm run cli -- runs session-summary ${sessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(restarted.wait.commands.sessionWatch.join(" "), `npm run cli -- runs session-watch ${sessionName} --recoverable --include-stopped --next`);
  assert.equal(restarted.wait.commands.stopSession.join(" "), `npm run cli -- runs stop-session ${sessionName} --recover`);
  assert.equal(restarted.wait.commands.restartSession.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);
  assert.equal(
    restarted.wait.commands.restartSessionWithStopped.join(" "),
    `npm run cli -- runs restart-session ${sessionName} --recover --resume-stopped`,
  );

  let deadWorkerStoppedRun: { run: { status: string } } | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    deadWorkerStoppedRun = await cliJson<{ run: { status: string } }>(baseUrl, [
      "runs",
      "get",
      deadWorkerStoppedPlan.run.id,
    ]);
    if (deadWorkerStoppedRun.run.status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(deadWorkerStoppedRun?.run.status, "running");
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
