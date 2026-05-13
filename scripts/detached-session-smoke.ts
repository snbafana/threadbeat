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

const { app, db } = await buildServer(settings);
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
  const apiResumeInspectionResponse = await app.inject({
    method: "GET",
    url: `/api/runs/${apiResumePlan.run.id}/resume-inspection`,
  });
  assert.equal(apiResumeInspectionResponse.statusCode, 200);
  const apiResumeInspection = JSON.parse(apiResumeInspectionResponse.body) as {
    run: { id: string; status: string; resultCommit: string | null };
    recovery: { ready: boolean; reason: string; inspectionMode: string; runningSandboxes: unknown[] };
    links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
    commands: { resumeBranch: string[] | null; resumeBranchDryRun: string[]; inspectResult: string[] };
    nextStep: { action: string; reason: string; command: string[] };
  };
  assert.equal(apiResumeInspection.run.id, apiResumePlan.run.id);
  assert.equal(apiResumeInspection.run.status, "stopped");
  assert.equal(apiResumeInspection.run.resultCommit, null);
  assert.equal(apiResumeInspection.recovery.ready, true);
  assert.equal(apiResumeInspection.recovery.reason, "stopped_branch_without_result_commit");
  assert.equal(apiResumeInspection.recovery.inspectionMode, "server_metadata");
  assert.deepEqual(apiResumeInspection.recovery.runningSandboxes, []);
  assert.ok(apiResumeInspection.links.branchTreeUrl !== null);
  assert.equal(apiResumeInspection.links.resultCommitUrl, null);
  assert.equal(apiResumeInspection.commands.resumeBranch?.join(" "), `npm run cli -- runs resume-branch ${apiResumePlan.run.id}`);
  assert.equal(apiResumeInspection.commands.resumeBranchDryRun.join(" "), `npm run cli -- runs resume-branch ${apiResumePlan.run.id} --dry-run`);
  assert.equal(apiResumeInspection.commands.inspectResult.join(" "), `npm run cli -- runs inspect-result ${apiResumePlan.run.id} --server`);
  assert.equal(apiResumeInspection.nextStep.action, "resume_branch");
  assert.equal(apiResumeInspection.nextStep.reason, "stopped_branch_without_result_commit");
  assert.equal(apiResumeInspection.nextStep.command.join(" "), `npm run cli -- runs resume-branch ${apiResumePlan.run.id}`);
  const cliResumeInspection = await cliJson<{
    run: { id: string; status: string; resultCommit: string | null };
    recovery: { ready: boolean; reason: string };
    nextStep: { action: string; command: string[] };
  }>(baseUrl, ["runs", "resume-branch", apiResumePlan.run.id, "--inspect"]);
  assert.equal(cliResumeInspection.run.id, apiResumePlan.run.id);
  assert.equal(cliResumeInspection.run.status, "stopped");
  assert.equal(cliResumeInspection.run.resultCommit, null);
  assert.equal(cliResumeInspection.recovery.ready, true);
  assert.equal(cliResumeInspection.recovery.reason, "stopped_branch_without_result_commit");
  assert.equal(cliResumeInspection.nextStep.action, "resume_branch");
  assert.equal(cliResumeInspection.nextStep.command.join(" "), `npm run cli -- runs resume-branch ${apiResumePlan.run.id}`);
  const workerResumeInspectionAgent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "detached-session-worker-resume-inspection-agent",
    "--repo",
    "https://github.com/example/worker-resume-inspection-agent.git",
    "--ref",
    "main",
  ]);
  const workerResumeInspectionPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerResumeInspectionAgent.agent.id,
    "--objective",
    "worker resume inspection before stopped branch pickup",
  ]);
  await cliJson(baseUrl, ["runs", "stop", workerResumeInspectionPlan.run.id]);
  const workerResumeInspection = await cliJson<{
    processed: Array<{
      runId: string;
      resumeInspection?: {
        recovery: { ready: boolean; reason: string };
        nextStep: { action: string; command: string[] };
      };
    }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    workerResumeInspectionAgent.agent.id,
    "--resume-stopped",
    "--no-bootstrap",
    "--limit",
    "1",
  ]);
  const inspectedPickup = workerResumeInspection.processed.find((item) => item.runId === workerResumeInspectionPlan.run.id);
  assert.ok(inspectedPickup);
  assert.equal(inspectedPickup.resumeInspection?.recovery.ready, true);
  assert.equal(inspectedPickup.resumeInspection?.recovery.reason, "stopped_branch_without_result_commit");
  assert.equal(inspectedPickup.resumeInspection?.nextStep.action, "resume_branch");
  assert.equal(inspectedPickup.resumeInspection?.nextStep.command.join(" "), `npm run cli -- runs resume-branch ${workerResumeInspectionPlan.run.id}`);
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
    url: `/api/worker-sessions/${sessionName}/branches?resumable=true&runId=${stoppedPlan.run.id}&limit=1`,
  });
  assert.equal(apiBranchesResponse.statusCode, 200);
  const apiBranches = JSON.parse(apiBranchesResponse.body) as {
    session: string;
    checkoutDir: string;
    filter: {
      statuses: string[];
      resumable: boolean;
      workerId: string | null;
      branchAction: string[];
      runIds: string[];
      limit: number;
      offset: number;
      totalNextSteps: number;
      visibleNextSteps: number;
      hasMore: boolean;
      nextOffset: number | null;
    };
    summary: { total: number; resultCommits: number; resumable: number; warnings: number };
    resultCommits: unknown[];
    resumableBranches: Array<{
      runId: string;
      resultCommit: string | null;
      location: string;
      commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[]; inspectResult: string[]; resumeBranch: string[] | null };
      links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
    }>;
    nextSteps: Array<{ action: string; reason: string; runId: string; command: string[] }>;
  };
  assert.equal(apiBranches.session, sessionName);
  assert.equal(apiBranches.checkoutDir, `./checkouts/${sessionName}-branches`);
  assert.deepEqual(apiBranches.filter.statuses, ["completed", "stopped"]);
  assert.equal(apiBranches.filter.resumable, true);
  assert.equal(apiBranches.filter.workerId, null);
  assert.deepEqual(apiBranches.filter.branchAction, []);
  assert.deepEqual(apiBranches.filter.runIds, [stoppedPlan.run.id]);
  assert.equal(apiBranches.filter.limit, 1);
  assert.equal(apiBranches.filter.offset, 0);
  assert.equal(apiBranches.filter.totalNextSteps, 1);
  assert.equal(apiBranches.filter.visibleNextSteps, 1);
  assert.equal(apiBranches.filter.hasMore, false);
  assert.equal(apiBranches.filter.nextOffset, null);
  assert.equal(apiBranches.summary.total, 1);
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
    && run.commands.inspectResult.join(" ") === `npm run cli -- runs inspect-result ${stoppedPlan.run.id} --checkout-dir ./checkouts/${sessionName}-branches/${stoppedPlan.run.id}`
    && run.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
    && run.links.branchTreeUrl !== null
    && run.links.resultCommitUrl === null
  )));
  const inspectMissingResult = await cliJson<{
    result: { available: boolean; reason: string };
    commands: { resumeBranch: string[] | null; inspectResult: string[] };
  }>(baseUrl, ["runs", "inspect-result", stoppedPlan.run.id, "--checkout-dir", `./checkouts/${sessionName}-branches/${stoppedPlan.run.id}`]);
  assert.equal(inspectMissingResult.result.available, false);
  assert.equal(inspectMissingResult.result.reason, "stopped_branch_without_result_commit");
  assert.equal(inspectMissingResult.commands.resumeBranch?.join(" "), `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`);
  assert.equal(inspectMissingResult.commands.inspectResult.join(" "), `npm run cli -- runs inspect-result ${stoppedPlan.run.id} --checkout-dir ./checkouts/${sessionName}-branches/${stoppedPlan.run.id}`);
  const apiResultInspectionResponse = await app.inject({
    method: "GET",
    url: `/api/runs/${stoppedPlan.run.id}/result-inspection`,
  });
  assert.equal(apiResultInspectionResponse.statusCode, 200);
  const apiResultInspection = JSON.parse(apiResultInspectionResponse.body) as {
    run: { id: string; resultCommit: string | null };
    result: { available: boolean; reason: string; inspectionMode: string };
    commands: { inspectResult: string[]; resumeBranch: string[] | null };
    links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
  };
  assert.equal(apiResultInspection.run.id, stoppedPlan.run.id);
  assert.equal(apiResultInspection.run.resultCommit, null);
  assert.equal(apiResultInspection.result.available, false);
  assert.equal(apiResultInspection.result.reason, "stopped_branch_without_result_commit");
  assert.equal(apiResultInspection.result.inspectionMode, "server_metadata");
  assert.equal(apiResultInspection.commands.inspectResult.join(" "), `npm run cli -- runs inspect-result ${stoppedPlan.run.id} --server`);
  assert.equal(apiResultInspection.commands.resumeBranch?.join(" "), `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`);
  assert.ok(apiResultInspection.links.branchTreeUrl !== null);
  assert.equal(apiResultInspection.links.resultCommitUrl, null);
  const serverInspectMissingResult = await cliJson<{
    run: { id: string; resultCommit: string | null };
    result: { available: boolean; reason: string; inspectionMode: string };
    commands: { inspectResult: string[] };
  }>(baseUrl, ["runs", "inspect-result", stoppedPlan.run.id, "--server"]);
  assert.equal(serverInspectMissingResult.run.id, stoppedPlan.run.id);
  assert.equal(serverInspectMissingResult.run.resultCommit, null);
  assert.equal(serverInspectMissingResult.result.available, false);
  assert.equal(serverInspectMissingResult.result.reason, "stopped_branch_without_result_commit");
  assert.equal(serverInspectMissingResult.result.inspectionMode, "server_metadata");
  assert.equal(serverInspectMissingResult.commands.inspectResult.join(" "), `npm run cli -- runs inspect-result ${stoppedPlan.run.id} --server`);
  assert.ok(apiBranches.nextSteps.some((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.runId === stoppedPlan.run.id
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
  )));

  const cliBranches = await cliJson<{
    ok: true;
    session: string;
    filter: { statuses: string[]; resumable: boolean; workerId: string | null };
    summary: { resultCommits: number; resumable: number };
    resumableBranches: Array<{ runId: string; commands: { resumeBranch: string[] | null } }>;
  }>(baseUrl, ["runs", "session-branches", sessionName, "--server", "--resumable"]);
  assert.equal(cliBranches.ok, true);
  assert.equal(cliBranches.session, sessionName);
  assert.deepEqual(cliBranches.filter.statuses, ["completed", "stopped"]);
  assert.equal(cliBranches.filter.resumable, true);
  assert.equal(cliBranches.filter.workerId, null);
  assert.equal(cliBranches.summary.resultCommits, 0);
  assert.ok(cliBranches.summary.resumable >= 1);
  assert.ok(cliBranches.resumableBranches.some((run) => (
    run.runId === stoppedPlan.run.id
    && run.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`
  )));
  const cliBranchCommands = await cliText(baseUrl, [
    "runs",
    "session-branches",
    sessionName,
    "--server",
    "--resumable",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.ok(cliBranchCommands.split("\n").filter(Boolean).includes(
    `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`,
  ));
  const serverResults = await cliJson<{
    session: string;
    checkoutDir: string;
    runFilter: string[];
    summary: { total: number; resultCommits: number; resumable: number };
    commands: Array<{ scope: string; action: string; runId: string; command: string[] }>;
    filter: { branchAction: string[]; runIds: string[]; limit: number; offset: number; totalNextSteps: number; visibleNextSteps: number };
  }>(baseUrl, [
    "runs",
    "results",
    "--session",
    sessionName,
    "--server",
    "--branch-action",
    "resume_branch",
    "--run",
    stoppedPlan.run.id,
    "--next",
    "--commands-only",
    "--limit",
    "1",
  ]);
  assert.equal(serverResults.session, sessionName);
  assert.equal(serverResults.checkoutDir, `./checkouts/${sessionName}-results`);
  assert.deepEqual(serverResults.runFilter, [stoppedPlan.run.id]);
  assert.equal(serverResults.summary.total, 1);
  assert.equal(serverResults.summary.resultCommits, 0);
  assert.equal(serverResults.summary.resumable, 1);
  assert.deepEqual(serverResults.filter.branchAction, ["resume_branch"]);
  assert.deepEqual(serverResults.filter.runIds, [stoppedPlan.run.id]);
  assert.equal(serverResults.filter.limit, 1);
  assert.equal(serverResults.filter.offset, 0);
  assert.equal(serverResults.filter.totalNextSteps, 1);
  assert.equal(serverResults.filter.visibleNextSteps, 1);
  assert.equal(serverResults.commands[0].scope, "branch");
  assert.equal(serverResults.commands[0].action, "resume_branch");
  assert.equal(serverResults.commands[0].runId, stoppedPlan.run.id);
  assert.equal(serverResults.commands[0].command.join(" "), `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`);
  const serverResultsShell = await cliText(baseUrl, [
    "runs",
    "results",
    "--session",
    sessionName,
    "--server",
    "--branch-action",
    "resume_branch",
    "--run",
    stoppedPlan.run.id,
    "--next",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.deepEqual(serverResultsShell.split("\n").filter(Boolean), [
    `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`,
  ]);

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
    resumed: Array<{
      runId: string;
      branchName: string;
      workerId: string | null;
      currentStatus?: string;
      dryRun?: boolean;
      resumeInspection: {
        recovery: { ready: boolean; reason: string; inspectionMode: string; runningSandboxes: unknown[] };
        nextStep: { action: string; reason: string; command: string[] };
        commands: { resumeBranch: string[] | null; resumeBranchDryRun: string[] };
      };
    }>;
    nextStep: { action: string; reason: string; command: string[] };
  };
  assert.equal(apiSessionResumePreview.session, sessionName);
  assert.deepEqual(apiSessionResumePreview.resumed.map((run) => run.runId), [apiSessionResumePlan.run.id]);
  assert.equal(apiSessionResumePreview.resumed[0].branchName, apiSessionResumePlan.plan.branchName);
  assert.equal(apiSessionResumePreview.resumed[0].workerId, "detached-smoke-worker-1");
  assert.equal(apiSessionResumePreview.resumed[0].currentStatus, "stopped");
  assert.equal(apiSessionResumePreview.resumed[0].dryRun, true);
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.recovery.ready, true);
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.recovery.reason, "stopped_branch_without_result_commit");
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.recovery.inspectionMode, "server_metadata");
  assert.deepEqual(apiSessionResumePreview.resumed[0].resumeInspection.recovery.runningSandboxes, []);
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.nextStep.action, "resume_branch");
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.nextStep.command.join(" "), `npm run cli -- runs resume-branch ${apiSessionResumePlan.run.id}`);
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.commands.resumeBranch?.join(" "), `npm run cli -- runs resume-branch ${apiSessionResumePlan.run.id}`);
  assert.equal(apiSessionResumePreview.resumed[0].resumeInspection.commands.resumeBranchDryRun.join(" "), `npm run cli -- runs resume-branch ${apiSessionResumePlan.run.id} --dry-run`);
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
    resumed: Array<{
      runId: string;
      status?: string;
      workerId: string | null;
      resumeInspection: {
        recovery: { ready: boolean; reason: string };
        nextStep: { action: string; command: string[] };
      };
    }>;
    nextStep: { action: string; reason: string };
    status: { session: { session: string } };
  };
  assert.equal(apiSessionResume.session, sessionName);
  assert.equal(apiSessionResume.status.session.session, sessionName);
  assert.deepEqual(apiSessionResume.resumed.map((run) => run.runId), [apiSessionResumePlan.run.id]);
  assert.equal(apiSessionResume.resumed[0].status, "planned");
  assert.equal(apiSessionResume.resumed[0].workerId, null);
  assert.equal(apiSessionResume.resumed[0].resumeInspection.recovery.ready, true);
  assert.equal(apiSessionResume.resumed[0].resumeInspection.recovery.reason, "stopped_branch_without_result_commit");
  assert.equal(apiSessionResume.resumed[0].resumeInspection.nextStep.action, "resume_branch");
  assert.equal(apiSessionResume.resumed[0].resumeInspection.nextStep.command.join(" "), `npm run cli -- runs resume-branch ${apiSessionResumePlan.run.id}`);
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

  const apiSessionApplyPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session api backed apply resume",
  ]);
  await cliJson(baseUrl, ["runs", "claim", apiSessionApplyPlan.run.id, "--worker-id", "detached-smoke-worker-1"]);
  await cliJson(baseUrl, ["runs", "stop", apiSessionApplyPlan.run.id]);
  const apiSessionApplyId = "detached-session-api-backed-apply";
  const apiBackedApplyResume = await cliJson<{
    session: string;
    source: string;
    applyId: string;
    dryRun: boolean;
    selected: number;
    commands: Array<{ action: string; runId?: string }>;
    executions: Array<{
      action: string;
      runId: string | null;
      exitCode: number | null;
      output: { resumed?: { runId: string; branchName: string; status: string }; run?: { status: string; worker_id: string | null } };
    }>;
  }>(baseUrl, [
    "runs",
    "session-apply",
    sessionName,
    "--source",
    "status",
    "--include-stopped",
    "--branch-action",
    "resume_branch",
    "--run",
    apiSessionApplyPlan.run.id,
    "--limit",
    "1",
    "--apply-id",
    apiSessionApplyId,
  ]);
  assert.equal(apiBackedApplyResume.session, sessionName);
  assert.equal(apiBackedApplyResume.source, "status");
  assert.equal(apiBackedApplyResume.applyId, apiSessionApplyId);
  assert.equal(apiBackedApplyResume.dryRun, false);
  assert.equal(apiBackedApplyResume.selected, 1);
  assert.equal(apiBackedApplyResume.commands[0].action, "resume_branch");
  assert.equal(apiBackedApplyResume.commands[0].runId, apiSessionApplyPlan.run.id);
  assert.equal(apiBackedApplyResume.executions[0].action, "resume_branch");
  assert.equal(apiBackedApplyResume.executions[0].runId, apiSessionApplyPlan.run.id);
  assert.equal(apiBackedApplyResume.executions[0].exitCode, 0);
  assert.equal(apiBackedApplyResume.executions[0].output.resumed?.runId, apiSessionApplyPlan.run.id);
  assert.equal(apiBackedApplyResume.executions[0].output.resumed?.branchName, apiSessionApplyPlan.plan.branchName);
  assert.equal(apiBackedApplyResume.executions[0].output.resumed?.status, "planned");
  assert.equal(apiBackedApplyResume.executions[0].output.run?.status, "planned");
  assert.equal(apiBackedApplyResume.executions[0].output.run?.worker_id, null);

  const branchSourceApplyPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session branch source apply resume",
  ]);
  await cliJson(baseUrl, ["runs", "claim", branchSourceApplyPlan.run.id, "--worker-id", "detached-smoke-worker-1"]);
  await cliJson(baseUrl, ["runs", "stop", branchSourceApplyPlan.run.id]);
  const branchSourceApply = await cliJson<{
    session: string;
    source: string;
    applyId: string;
    selected: number;
    commands: Array<{ scope: string; action: string; runId?: string }>;
    executions: Array<{
      scope: string;
      action: string;
      runId: string | null;
      exitCode: number | null;
      output: { resumed?: { runId: string; branchName: string; status: string }; run?: { status: string; worker_id: string | null } };
    }>;
  }>(baseUrl, [
    "runs",
    "session-apply",
    sessionName,
    "--source",
    "branches",
    "--branch-action",
    "resume_branch",
    "--run",
    branchSourceApplyPlan.run.id,
    "--limit",
    "1",
    "--apply-id",
    "detached-session-branch-source-apply",
  ]);
  assert.equal(branchSourceApply.session, sessionName);
  assert.equal(branchSourceApply.source, "branches");
  assert.equal(branchSourceApply.applyId, "detached-session-branch-source-apply");
  assert.equal(branchSourceApply.selected, 1);
  assert.equal(branchSourceApply.commands[0].scope, "branch");
  assert.equal(branchSourceApply.commands[0].action, "resume_branch");
  assert.equal(branchSourceApply.commands[0].runId, branchSourceApplyPlan.run.id);
  assert.equal(branchSourceApply.executions[0].scope, "branch");
  assert.equal(branchSourceApply.executions[0].action, "resume_branch");
  assert.equal(branchSourceApply.executions[0].runId, branchSourceApplyPlan.run.id);
  assert.equal(branchSourceApply.executions[0].exitCode, 0);
  assert.equal(branchSourceApply.executions[0].output.resumed?.runId, branchSourceApplyPlan.run.id);
  assert.equal(branchSourceApply.executions[0].output.resumed?.branchName, branchSourceApplyPlan.plan.branchName);
  assert.equal(branchSourceApply.executions[0].output.resumed?.status, "planned");
  assert.equal(branchSourceApply.executions[0].output.run?.status, "planned");
  assert.equal(branchSourceApply.executions[0].output.run?.worker_id, null);

  const apiBackedResetContinuationId = "detached-api-backed-reset-failed";
  const apiBackedResetContinuationPath = await writeDrainContinuation(sessionName, apiBackedResetContinuationId, {
    status: "failed",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    completedAt: new Date().toISOString(),
    error: "detached smoke failed reset probe",
    continueDrains: { dryRun: false, selected: 1, succeeded: 0, failed: 1 },
    drains: [{
      prefix: "detached-api-backed-reset",
      nextApplyId: "detached-api-backed-reset-002",
      command: ["npm", "run", "cli", "--", "runs", "session-apply", sessionName, "--source", "watch"],
      exitCode: 1,
      stderr: "detached smoke failed reset probe",
    }],
  });
  const apiBackedReset = await cliJson<{
    session: string;
    source: string;
    applyId: string;
    selected: number;
    commands: Array<{ action: string; continuationIds?: string[] }>;
    executions: Array<{
      scope: string;
      action: string;
      exitCode: number;
      output: {
        ok: true;
        session: string;
        failed: number;
        resetCount: number;
        continuations: Array<{ continuationId: string; status: string; resetReason?: string }>;
      };
    }>;
  }>(baseUrl, [
    "runs",
    "session-apply",
    sessionName,
    "--source",
    "status",
    "--action",
    "reset_failed_drain_continuations",
    "--apply-id",
    "detached-session-api-backed-reset",
  ]);
  assert.equal(apiBackedReset.session, sessionName);
  assert.equal(apiBackedReset.source, "status");
  assert.equal(apiBackedReset.applyId, "detached-session-api-backed-reset");
  assert.equal(apiBackedReset.selected, 1);
  assert.equal(apiBackedReset.commands[0].action, "reset_failed_drain_continuations");
  assert.deepEqual(apiBackedReset.commands[0].continuationIds, [apiBackedResetContinuationId]);
  assert.equal(apiBackedReset.executions[0].scope, "drain_continuation");
  assert.equal(apiBackedReset.executions[0].action, "reset_failed_drain_continuations");
  assert.equal(apiBackedReset.executions[0].exitCode, 0);
  assert.equal(apiBackedReset.executions[0].output.ok, true);
  assert.equal(apiBackedReset.executions[0].output.session, sessionName);
  assert.equal(apiBackedReset.executions[0].output.failed, 1);
  assert.equal(apiBackedReset.executions[0].output.resetCount, 1);
  assert.equal(apiBackedReset.executions[0].output.continuations[0].continuationId, apiBackedResetContinuationId);
  assert.equal(apiBackedReset.executions[0].output.continuations[0].status, "queued");
  assert.equal(apiBackedReset.executions[0].output.continuations[0].resetReason, "operator_reset_failed");
  const serverApplyRecords = await cliJson<{
    session: string;
    count: number;
    returned: number;
    summary: {
      counts: { total: number; succeeded: number; failed: number; pending: number; dryRun: number };
      applies: Array<{ applyId: string; source: string; selected: number; succeeded: number; failed: number; pending: number }>;
    };
    applies: Array<{ applyId: string; source: string; selected: number; executions: Array<{ action: string; exitCode: number }> }>;
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--apply-id",
    "detached-session-api-backed-reset",
  ]);
  assert.equal(serverApplyRecords.session, sessionName);
  assert.equal(serverApplyRecords.returned, 1);
  assert.equal(serverApplyRecords.summary.counts.total, 1);
  assert.equal(serverApplyRecords.summary.counts.succeeded, 1);
  assert.equal(serverApplyRecords.summary.counts.failed, 0);
  assert.equal(serverApplyRecords.summary.counts.pending, 0);
  assert.equal(serverApplyRecords.summary.applies[0].applyId, "detached-session-api-backed-reset");
  assert.equal(serverApplyRecords.summary.applies[0].source, "status");
  assert.equal(serverApplyRecords.summary.applies[0].selected, 1);
  assert.equal(serverApplyRecords.applies[0].applyId, "detached-session-api-backed-reset");
  assert.equal(serverApplyRecords.applies[0].source, "status");
  assert.equal(serverApplyRecords.applies[0].executions[0].action, "reset_failed_drain_continuations");
  assert.equal(serverApplyRecords.applies[0].executions[0].exitCode, 0);
  const serverApplyActionQueue = await cliJson<{
    actionQueue: {
      counts: { actionable: number; resetAudits: number; resetAuditsAcknowledged: number; resetAuditsTotal: number };
      actions: Array<{ applyId: string; action: string; resetCount: number; command: string[]; ackCommand: string[] }>;
    };
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--apply-id",
    "detached-session-api-backed-reset",
  ]);
  assert.equal(serverApplyActionQueue.actionQueue.counts.actionable, 1);
  assert.equal(serverApplyActionQueue.actionQueue.counts.resetAudits, 1);
  assert.equal(serverApplyActionQueue.actionQueue.counts.resetAuditsAcknowledged, 0);
  assert.equal(serverApplyActionQueue.actionQueue.counts.resetAuditsTotal, 1);
  assert.equal(serverApplyActionQueue.actionQueue.actions[0].applyId, "detached-session-api-backed-reset");
  assert.equal(serverApplyActionQueue.actionQueue.actions[0].action, "inspect_drain_continuation_resets");
  assert.equal(serverApplyActionQueue.actionQueue.actions[0].resetCount, 1);
  assert.deepEqual(serverApplyActionQueue.actionQueue.actions[0].command, [
    "npm", "run", "cli", "--", "runs", "session-applies", sessionName, "--server", "--apply-id", "detached-session-api-backed-reset",
  ]);
  assert.deepEqual(serverApplyActionQueue.actionQueue.actions[0].ackCommand, [
    "npm", "run", "cli", "--", "runs", "session-applies", sessionName, "--server", "--apply-id", "detached-session-api-backed-reset", "--ack-reset-audit",
  ]);
  const serverApplyActionQueueShell = await cliText(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--format",
    "shell",
  ]);
  assert.equal(
    serverApplyActionQueueShell.trim(),
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset`,
  );
  const serverExecutedApplyAction = await cliJson<{
    executed: boolean;
    action: { applyId: string; action: string };
    exitCode: number;
    output: {
      count: number;
      returned: number;
      summary: { counts: { succeeded: number; failed: number; pending: number } };
      applies: Array<{ applyId: string }>;
    };
    execution: { executionId: string; applyId: string; action: string; status: string; exitCode: number };
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-next",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
  ]);
  assert.equal(serverExecutedApplyAction.executed, true);
  assert.equal(serverExecutedApplyAction.action.applyId, "detached-session-api-backed-reset");
  assert.equal(serverExecutedApplyAction.action.action, "inspect_drain_continuation_resets");
  assert.equal(serverExecutedApplyAction.exitCode, 0);
  assert.ok(serverExecutedApplyAction.output.count >= 1);
  assert.equal(serverExecutedApplyAction.output.returned, 1);
  assert.equal(serverExecutedApplyAction.output.applies[0]?.applyId, "detached-session-api-backed-reset");
  assert.equal(serverExecutedApplyAction.output.summary.counts.succeeded, 1);
  assert.equal(serverExecutedApplyAction.output.summary.counts.failed, 0);
  assert.equal(serverExecutedApplyAction.output.summary.counts.pending, 0);
  assert.equal(serverExecutedApplyAction.execution?.applyId, "detached-session-api-backed-reset");
  assert.equal(serverExecutedApplyAction.execution?.action, "inspect_drain_continuation_resets");
  assert.equal(serverExecutedApplyAction.execution?.status, "executed");
  assert.equal(serverExecutedApplyAction.execution?.exitCode, 0);
  const serverApplyActionExecutions = await cliJson<{
    count: number;
    executions: Array<{
      executionId: string;
      applyId: string;
      action: string;
      status: string;
      exitCode: number;
    }>;
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-executions",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
  ]);
  assert.equal(serverApplyActionExecutions.count, 1);
  assert.equal(serverApplyActionExecutions.executions[0]?.executionId, serverExecutedApplyAction.execution?.executionId);
  assert.equal(serverApplyActionExecutions.executions[0]?.applyId, "detached-session-api-backed-reset");
  assert.equal(serverApplyActionExecutions.executions[0]?.action, "inspect_drain_continuation_resets");
  assert.equal(serverApplyActionExecutions.executions[0]?.status, "executed");
  assert.equal(serverApplyActionExecutions.executions[0]?.exitCode, 0);
  const serverExecutedApplyActionBatch = await cliJson<{
    executed: number;
    stoppedOnFailure: boolean;
    remainingQueued: number;
    executions: Array<{
      action: { applyId: string; action: string };
      exitCode: number;
      execution: { applyId: string; action: string; status: string; exitCode: number };
    }>;
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--max-actions",
    "2",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
  ]);
  assert.equal(serverExecutedApplyActionBatch.executed, 1);
  assert.equal(serverExecutedApplyActionBatch.stoppedOnFailure, false);
  assert.equal(serverExecutedApplyActionBatch.remainingQueued, 0);
  assert.equal(serverExecutedApplyActionBatch.executions[0]?.action.applyId, "detached-session-api-backed-reset");
  assert.equal(serverExecutedApplyActionBatch.executions[0]?.action.action, "inspect_drain_continuation_resets");
  assert.equal(serverExecutedApplyActionBatch.executions[0]?.exitCode, 0);
  assert.equal(serverExecutedApplyActionBatch.executions[0]?.execution.status, "executed");
  const serverApplyActionExecutionsAfterBatch = await cliJson<{
    count: number;
    executions: Array<{ applyId: string; action: string; status: string; exitCode: number }>;
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-executions",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
  ]);
  assert.equal(serverApplyActionExecutionsAfterBatch.count, 2);
  assert.ok(serverApplyActionExecutionsAfterBatch.executions.every((execution) => (
    execution.applyId === "detached-session-api-backed-reset"
    && execution.action === "inspect_drain_continuation_resets"
    && execution.status === "executed"
    && execution.exitCode === 0
  )));
  const serverExecutedApplyActionLoop = await cliJson<{
    executed: number;
    stoppedReason: string;
    repeatedActions: string[];
    polls: Array<{ executed: number }>;
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--until-empty",
    "--max-polls",
    "3",
    "--interval-ms",
    "1",
    "--max-actions",
    "1",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
  ]);
  assert.equal(serverExecutedApplyActionLoop.executed, 1);
  assert.equal(serverExecutedApplyActionLoop.stoppedReason, "repeated_action");
  assert.deepEqual(serverExecutedApplyActionLoop.repeatedActions, [
    "detached-session-api-backed-reset:status:inspect_drain_continuation_resets",
  ]);
  assert.equal(serverExecutedApplyActionLoop.polls.length, 1);
  assert.equal(serverExecutedApplyActionLoop.polls[0]?.executed, 1);
  const serverApplyActionExecutionsAfterLoop = await cliJson<{
    count: number;
    executions: Array<{ applyId: string; action: string; status: string; exitCode: number }>;
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-executions",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
  ]);
  assert.equal(serverApplyActionExecutionsAfterLoop.count, 3);
  const applyActionWorker = await cliJson<{
    ok: true;
    worker: { workerId: string; alive: boolean; command: string[] };
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--detach",
    "--worker-id",
    "detached-smoke-apply-action-worker",
    "--max-actions",
    "1",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
    "--until-empty",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  assert.equal(applyActionWorker.ok, true);
  assert.equal(applyActionWorker.worker.workerId, "detached-smoke-apply-action-worker");
  assert.deepEqual(applyActionWorker.worker.command, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--record-worker",
    "detached-smoke-apply-action-worker",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--apply-action",
    "inspect_drain_continuation_resets",
    "--max-actions",
    "1",
    "--until-empty",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  let serverApplyActionExecutionsAfterWorker = serverApplyActionExecutionsAfterLoop;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    serverApplyActionExecutionsAfterWorker = await cliJson<{
      count: number;
      executions: Array<{ applyId: string; action: string; status: string; exitCode: number }>;
    }>(baseUrl, [
      "runs",
      "session-applies",
      sessionName,
      "--server",
      "--action-executions",
      "--apply-id",
      "detached-session-api-backed-reset",
      "--apply-action",
      "inspect_drain_continuation_resets",
    ]);
    if (serverApplyActionExecutionsAfterWorker.count >= 4) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(serverApplyActionExecutionsAfterWorker.count >= 4);
  const applyActionWorkers = await cliJson<{
    count: number;
    workers: Array<{
      workerId: string;
      command: string[];
      lastRun?: {
        status: string;
        executed: number;
        failed: number;
        stoppedReason: string;
        remainingQueued: number;
        repeatedActions?: string[];
        polls: Array<{ executed: number; failed: number; remainingQueued: number }>;
      };
      stdout: { path: string };
      stderr: { path: string };
    }>;
  }>(baseUrl, [
    "runs",
    "session-apply-action-workers",
    sessionName,
    "--worker-id",
    "detached-smoke-apply-action-worker",
  ]);
  assert.equal(applyActionWorkers.count, 1);
  assert.equal(applyActionWorkers.workers[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.status, "completed");
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.executed, 1);
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.failed, 0);
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.stoppedReason, "repeated_action");
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.remainingQueued, 1);
  assert.deepEqual(applyActionWorkers.workers[0]?.lastRun?.repeatedActions, [
    "detached-session-api-backed-reset:status:inspect_drain_continuation_resets",
  ]);
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.polls.length, 1);
  assert.equal(applyActionWorkers.workers[0]?.lastRun?.polls[0]?.executed, 1);
  assert.match(applyActionWorkers.workers[0]?.stdout.path ?? "", /apply-action-workers/);
  assert.match(applyActionWorkers.workers[0]?.stderr.path ?? "", /apply-action-workers/);
  const serverApplyActionWorkers = await cliJson<{
    ok: true;
    count: number;
    workers: Array<{
      workerId: string;
      lastRun?: {
        status: string;
        executed: number;
        stoppedReason: string;
        repeatedActions?: string[];
      };
    }>;
  }>(baseUrl, [
    "runs",
    "session-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-apply-action-worker",
  ]);
  assert.equal(serverApplyActionWorkers.ok, true);
  assert.equal(serverApplyActionWorkers.count, 1);
  assert.equal(serverApplyActionWorkers.workers[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(serverApplyActionWorkers.workers[0]?.lastRun?.status, "completed");
  assert.equal(serverApplyActionWorkers.workers[0]?.lastRun?.executed, 1);
  assert.equal(serverApplyActionWorkers.workers[0]?.lastRun?.stoppedReason, "repeated_action");
  assert.deepEqual(serverApplyActionWorkers.workers[0]?.lastRun?.repeatedActions, [
    "detached-session-api-backed-reset:status:inspect_drain_continuation_resets",
  ]);
  const stoppedApplyActionWorkers = await cliJson<{
    ok?: true;
    count: number;
    stopped: Array<{ workerId: string; stoppedAt?: string; retiredAt?: string }>;
    workers: Array<{ workerId: string; stoppedAt?: string; retiredAt?: string; alive: boolean }>;
  }>(baseUrl, [
    "runs",
    "stop-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-apply-action-worker",
  ]);
  assert.equal(stoppedApplyActionWorkers.ok, true);
  assert.equal(stoppedApplyActionWorkers.count, 1);
  assert.equal(stoppedApplyActionWorkers.stopped[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(typeof stoppedApplyActionWorkers.stopped[0]?.stoppedAt, "string");
  assert.equal(stoppedApplyActionWorkers.stopped[0]?.retiredAt, undefined);
  assert.equal(stoppedApplyActionWorkers.workers[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(stoppedApplyActionWorkers.workers[0]?.alive, false);
  assert.equal(typeof stoppedApplyActionWorkers.workers[0]?.stoppedAt, "string");
  assert.equal(stoppedApplyActionWorkers.workers[0]?.retiredAt, undefined);
  const applyActionWorkerNext = await cliJson<{
    ok?: true;
    count: number;
    actions: { restart_apply_action_worker: number };
    nextSteps: Array<{
      action: string;
      reason: string;
      workerId: string;
      command: string[];
      commands: { inspectApplyActionWorkers: string[]; retireApplyActionWorker: string[] };
      api: { restart: { method: string; url: string; payload: { workerId: string } } };
    }>;
  }>(baseUrl, [
    "runs",
    "session-apply-action-workers-next",
    sessionName,
    "--server",
  ]);
  assert.equal(applyActionWorkerNext.ok, true);
  assert.equal(applyActionWorkerNext.count, 1);
  assert.equal(applyActionWorkerNext.actions.restart_apply_action_worker, 1);
  assert.equal(applyActionWorkerNext.nextSteps[0]?.action, "restart_apply_action_worker");
  assert.equal(applyActionWorkerNext.nextSteps[0]?.reason, "stopped_apply_action_worker");
  assert.equal(applyActionWorkerNext.nextSteps[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.deepEqual(applyActionWorkerNext.nextSteps[0]?.command, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "restart-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-apply-action-worker",
  ]);
  assert.deepEqual(applyActionWorkerNext.nextSteps[0]?.commands.inspectApplyActionWorkers, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-apply-action-worker",
  ]);
  assert.equal(applyActionWorkerNext.nextSteps[0]?.api.restart.method, "POST");
  assert.match(applyActionWorkerNext.nextSteps[0]?.api.restart.url ?? "", /\/apply-action-workers\/restart$/);
  assert.equal(applyActionWorkerNext.nextSteps[0]?.api.restart.payload.workerId, "detached-smoke-apply-action-worker");
  const serverDrainWorkerId = "detached-smoke-drain-worker";
  const serverDrainWorkerDir = path.join(".threadbeat", "worker-sessions", "drain-continuation-workers", sessionName);
  const serverDrainWorkerStdoutPath = path.join(serverDrainWorkerDir, `${serverDrainWorkerId}.out.log`);
  const serverDrainWorkerStderrPath = path.join(serverDrainWorkerDir, `${serverDrainWorkerId}.err.log`);
  await fs.mkdir(serverDrainWorkerDir, { recursive: true });
  await fs.writeFile(serverDrainWorkerStdoutPath, "server drain worker stdout\n");
  await fs.writeFile(serverDrainWorkerStderrPath, "");
  await fs.writeFile(path.join(serverDrainWorkerDir, `${serverDrainWorkerId}.json`), `${JSON.stringify({
    session: sessionName,
    workerId: serverDrainWorkerId,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "session-drain-workers", sessionName, "--server"],
    pid: null,
    stdoutPath: serverDrainWorkerStdoutPath,
    stderrPath: serverDrainWorkerStderrPath,
    stoppedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  const serverDrainWorkers = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    workers: Array<{ workerId: string; alive: boolean; stoppedAt?: string; stdout: { path: string; lines: string[] } }>;
  }>(baseUrl, [
    "runs",
    "session-drain-workers",
    sessionName,
    "--server",
    "--worker-id",
    serverDrainWorkerId,
    "--lines",
    "5",
  ]);
  assert.equal(serverDrainWorkers.ok, true);
  assert.equal(serverDrainWorkers.session, sessionName);
  assert.equal(serverDrainWorkers.count, 1);
  assert.equal(serverDrainWorkers.workers[0]?.workerId, serverDrainWorkerId);
  assert.equal(serverDrainWorkers.workers[0]?.alive, false);
  assert.equal(typeof serverDrainWorkers.workers[0]?.stoppedAt, "string");
  assert.equal(serverDrainWorkers.workers[0]?.stdout.path, serverDrainWorkerStdoutPath);
  assert.ok(serverDrainWorkers.workers[0]?.stdout.lines.includes("server drain worker stdout"));
  const stoppedServerDrainWorker = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    stopped: Array<{ workerId: string; pid: number | null; aliveBefore: boolean; alive: boolean; stoppedAt: string }>;
  }>(baseUrl, [
    "runs",
    "stop-drain-workers",
    sessionName,
    "--server",
    "--worker-id",
    serverDrainWorkerId,
  ]);
  assert.equal(stoppedServerDrainWorker.ok, true);
  assert.equal(stoppedServerDrainWorker.session, sessionName);
  assert.equal(stoppedServerDrainWorker.count, 1);
  assert.equal(stoppedServerDrainWorker.stopped[0]?.workerId, serverDrainWorkerId);
  assert.equal(stoppedServerDrainWorker.stopped[0]?.pid, null);
  assert.equal(stoppedServerDrainWorker.stopped[0]?.aliveBefore, false);
  assert.equal(stoppedServerDrainWorker.stopped[0]?.alive, false);
  assert.equal(typeof stoppedServerDrainWorker.stopped[0]?.stoppedAt, "string");
  const controlPlaneResumePlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session control plane branch recovery",
  ]);
  await cliJson(baseUrl, ["runs", "claim", controlPlaneResumePlan.run.id, "--worker-id", "detached-smoke-worker-1"]);
  await cliJson(baseUrl, ["runs", "stop", controlPlaneResumePlan.run.id]);
  const controlPlaneBlockedPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "detached session blocked branch recovery",
  ]);
  await cliJson(baseUrl, ["runs", "sandbox", controlPlaneBlockedPlan.run.id]);
  await db.updateAgentRunCompleted({ id: controlPlaneBlockedPlan.run.id, status: "stopped" });
  const controlPlaneStatus = await cliJson<{
    ok?: true;
    session: string;
    workers: {
      drain: { total: number; stopped: number; retired: number };
      applyAction: { total: number; stopped: number; retired: number };
      controlPlaneTick: { total: number; stopped: number; retired: number; completed: number };
    };
    queues: {
      applyActions: { actionable: number; resetAudits: number };
      drainContinuations: { total: number; queued: number; running: number; executed: number; failed: number };
    };
    branches: {
      counts: { total: number; ready: number; blocked: number; stoppedBranchWithoutResultCommit: number; runningSandboxPresent: number };
      actions: { resume_branch: number; inspect_run: number };
      commands: { resumeSession: string[]; resumeSessionDryRun: string[]; resumeNext: string[]; inspectBranches: string[] };
      nextSteps: Array<{ action: string; reason: string; runId: string; command: string[] }>;
      executions: {
        counts: { recent: number; executed: number; partial: number; noop: number };
        recent: Array<{ executionId: string; status: string; resumed: Array<{ runId: string }> }>;
      };
    };
    recovery: {
      count: number;
      actions: { restart_drain_worker: number; restart_apply_action_worker: number; restart_control_plane_tick_worker: number };
      nextSteps: {
        drainWorkers: Array<{ workerId: string; action: string }>;
        applyActionWorkers: Array<{ workerId: string; action: string }>;
        controlPlaneTickWorkers: Array<{ workerId: string; action: string }>;
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatus.ok, true);
  assert.equal(controlPlaneStatus.session, sessionName);
  assert.equal(controlPlaneStatus.workers.drain.total, 1);
  assert.equal(controlPlaneStatus.workers.drain.stopped, 1);
  assert.equal(controlPlaneStatus.workers.drain.retired, 0);
  assert.equal(controlPlaneStatus.workers.applyAction.total, 1);
  assert.equal(controlPlaneStatus.workers.applyAction.stopped, 1);
  assert.equal(controlPlaneStatus.workers.applyAction.retired, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.total, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.stopped, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.retired, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.completed, 0);
  assert.ok(controlPlaneStatus.branches.counts.total >= 1);
  assert.ok(controlPlaneStatus.branches.counts.ready >= 1);
  assert.equal(controlPlaneStatus.branches.counts.stoppedBranchWithoutResultCommit, controlPlaneStatus.branches.counts.ready);
  assert.equal(controlPlaneStatus.branches.counts.runningSandboxPresent, controlPlaneStatus.branches.counts.blocked);
  assert.equal(controlPlaneStatus.branches.actions.resume_branch, controlPlaneStatus.branches.counts.ready);
  assert.equal(controlPlaneStatus.branches.actions.inspect_run, controlPlaneStatus.branches.counts.blocked);
  assert.equal(controlPlaneStatus.branches.commands.resumeSession.join(" "), `npm run cli -- runs resume-session ${sessionName}`);
  assert.equal(controlPlaneStatus.branches.commands.resumeSessionDryRun.join(" "), `npm run cli -- runs resume-session ${sessionName} --dry-run`);
  assert.equal(controlPlaneStatus.branches.commands.resumeNext.join(" "), `npm run cli -- runs resume-session ${sessionName} --next`);
  assert.equal(controlPlaneStatus.branches.commands.inspectBranches.join(" "), `npm run cli -- runs session-branches ${sessionName} --server --resumable`);
  assert.ok(controlPlaneStatus.branches.nextSteps.some((step) => (
    step.runId === controlPlaneResumePlan.run.id
    && step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${controlPlaneResumePlan.run.id}`
  )));
  const controlPlaneTickPreview = await cliJson<{
    ok?: true;
    session: string;
    dryRun: boolean;
    tickPath: string;
    tick: { tickId: string; status: string; dryRun: boolean };
    planned: {
      branchRecovery: { action: string; runIds: string[]; command: string[] } | null;
      applyAction: { action: string; actionable: number } | null;
      drainContinuation: { action: string; queued: number } | null;
    };
    executed: { branchRecovery: null; applyAction: null; drainContinuation: null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-tick",
    sessionName,
    "--server",
    "--dry-run",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneTickPreview.ok, true);
  assert.equal(controlPlaneTickPreview.session, sessionName);
  assert.equal(controlPlaneTickPreview.dryRun, true);
  assert.match(controlPlaneTickPreview.tickPath, /worker-sessions\/control-plane-ticks/);
  assert.equal(controlPlaneTickPreview.tick.status, "dry_run");
  assert.equal(controlPlaneTickPreview.tick.dryRun, true);
  assert.equal(controlPlaneTickPreview.planned.branchRecovery?.action, "resume_next_branch");
  assert.ok(controlPlaneTickPreview.planned.branchRecovery?.runIds.includes(controlPlaneResumePlan.run.id));
  assert.equal(controlPlaneTickPreview.planned.branchRecovery?.command.join(" "), `npm run cli -- runs resume-session ${sessionName} --next`);
  assert.equal(controlPlaneTickPreview.planned.applyAction?.action, "execute_next_apply_action");
  assert.ok((controlPlaneTickPreview.planned.applyAction?.actionable ?? 0) >= 1);
  assert.equal(controlPlaneTickPreview.planned.drainContinuation?.action, "execute_next_drain_continuation");
  assert.ok((controlPlaneTickPreview.planned.drainContinuation?.queued ?? 0) >= 1);
  assert.equal(controlPlaneTickPreview.executed.branchRecovery, null);
  assert.equal(controlPlaneTickPreview.executed.applyAction, null);
  assert.equal(controlPlaneTickPreview.executed.drainContinuation, null);
  const controlPlaneTickLoopPreview = await cliJson<{
    ok?: true;
    session: string;
    dryRun: boolean;
    maxTicks: number;
    intervalMs: number;
    executedTicks: number;
    stoppedReason: string;
    tickIds: string[];
    ticks: Array<{ tickId: string; status: string; dryRun: boolean }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-tick-loop",
    sessionName,
    "--server",
    "--dry-run",
    "--max-ticks",
    "1",
    "--interval-ms",
    "0",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneTickLoopPreview.ok, true);
  assert.equal(controlPlaneTickLoopPreview.session, sessionName);
  assert.equal(controlPlaneTickLoopPreview.dryRun, true);
  assert.equal(controlPlaneTickLoopPreview.maxTicks, 1);
  assert.equal(controlPlaneTickLoopPreview.intervalMs, 0);
  assert.equal(controlPlaneTickLoopPreview.executedTicks, 1);
  assert.equal(controlPlaneTickLoopPreview.stoppedReason, "max_ticks");
  assert.equal(controlPlaneTickLoopPreview.ticks[0]?.status, "dry_run");
  assert.equal(controlPlaneTickLoopPreview.ticks[0]?.dryRun, true);
  assert.equal(controlPlaneTickLoopPreview.tickIds[0], controlPlaneTickLoopPreview.ticks[0]?.tickId);
  const controlPlaneTicks = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    ticks: Array<{ tickId: string; status: string; dryRun: boolean }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-ticks",
    sessionName,
    "--server",
  ]);
  assert.equal(controlPlaneTicks.ok, true);
  assert.equal(controlPlaneTicks.session, sessionName);
  assert.equal(controlPlaneTicks.count, 2);
  assert.equal(controlPlaneTicks.ticks[0]?.tickId, controlPlaneTickLoopPreview.ticks[0]?.tickId);
  assert.equal(controlPlaneTicks.ticks[0]?.status, "dry_run");
  assert.equal(controlPlaneTicks.ticks[1]?.tickId, controlPlaneTickPreview.tick.tickId);
  const completedControlPlaneTickWorker = await cliJson<{
    ok?: true;
    session: string;
    worker: { workerId: string; pid: number | null; stdoutPath: string; stderrPath: string };
  }>(baseUrl, [
    "runs",
    "start-control-plane-tick-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-complete-worker",
    "--dry-run",
    "--max-ticks",
    "1",
    "--interval-ms",
    "0",
    "--lines",
    "20",
  ]);
  assert.equal(completedControlPlaneTickWorker.ok, true);
  assert.equal(completedControlPlaneTickWorker.worker.workerId, "detached-smoke-control-plane-complete-worker");
  type ControlPlaneTickWorkerListResponse = {
    ok?: true;
    session: string;
    count: number;
    workers: Array<{
      workerId: string;
      alive: boolean;
      completedAt?: string;
      completionResult?: { exitCode: number | null; signal: string | null };
      lifecycle: { state: string; restartable: boolean; reason: string };
    }>;
  };
  let completedControlPlaneTickWorkers: ControlPlaneTickWorkerListResponse | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    completedControlPlaneTickWorkers = await cliJson<ControlPlaneTickWorkerListResponse>(baseUrl, [
      "runs",
      "session-control-plane-tick-workers",
      sessionName,
      "--server",
      "--worker-id",
      "detached-smoke-control-plane-complete-worker",
    ]);
    if (completedControlPlaneTickWorkers?.workers[0]?.completedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(completedControlPlaneTickWorkers?.ok, true);
  assert.equal(completedControlPlaneTickWorkers?.count, 1);
  assert.equal(completedControlPlaneTickWorkers?.workers[0]?.workerId, "detached-smoke-control-plane-complete-worker");
  assert.equal(completedControlPlaneTickWorkers?.workers[0]?.alive, false);
  assert.ok(completedControlPlaneTickWorkers?.workers[0]?.completedAt);
  assert.equal(completedControlPlaneTickWorkers?.workers[0]?.completionResult?.exitCode, 0);
  assert.equal(completedControlPlaneTickWorkers?.workers[0]?.lifecycle.state, "completed");
  assert.equal(completedControlPlaneTickWorkers?.workers[0]?.lifecycle.restartable, false);
  assert.equal(completedControlPlaneTickWorkers?.workers[0]?.lifecycle.reason, "worker_completed");
  const controlPlaneStatusAfterCompletedTickWorker = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusAfterCompletedTickWorker.workers.controlPlaneTick.completed, 1);
  assert.equal(controlPlaneStatusAfterCompletedTickWorker.recovery.actions.restart_control_plane_tick_worker ?? 0, 0);
  const controlPlaneTickWorker = await cliJson<{
    ok?: true;
    session: string;
    worker: {
      workerId: string;
      command: string[];
      pid: number | null;
      alive: boolean;
      stdoutPath: string;
      stderrPath: string;
    };
  }>(baseUrl, [
    "runs",
    "start-control-plane-tick-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-worker",
    "--dry-run",
    "--max-ticks",
    "1",
    "--interval-ms",
    "0",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneTickWorker.ok, true);
  assert.equal(controlPlaneTickWorker.session, sessionName);
  assert.equal(controlPlaneTickWorker.worker.workerId, "detached-smoke-control-plane-worker");
  assert.equal(
    controlPlaneTickWorker.worker.command.join(" "),
    `runs session-control-plane-tick-loop ${sessionName} --server --max-ticks 1 --interval-ms 0 --lines 20 --dry-run`,
  );
  assert.match(controlPlaneTickWorker.worker.stdoutPath, /control-plane-tick-workers/);
  assert.match(controlPlaneTickWorker.worker.stderrPath, /control-plane-tick-workers/);
  const controlPlaneTickWorkers = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    workers: Array<{
      workerId: string;
      command: string[];
      pid: number | null;
      lifecycle: { state: string; restartable: boolean; reason: string };
      stdout: { lines: string[] };
      stderr: { lines: string[] };
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-worker",
  ]);
  assert.equal(controlPlaneTickWorkers.ok, true);
  assert.equal(controlPlaneTickWorkers.session, sessionName);
  assert.equal(controlPlaneTickWorkers.count, 1);
  assert.equal(controlPlaneTickWorkers.workers[0]?.workerId, "detached-smoke-control-plane-worker");
  assert.equal(controlPlaneTickWorkers.workers[0]?.lifecycle.restartable, false);
  const stoppedControlPlaneTickWorkers = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    stopped: Array<{ workerId: string; stoppedAt: string; retiredAt?: string }>;
    workers: Array<{ workerId: string; retiredAt?: string; lifecycle: { state: string; restartable: boolean; reason: string } }>;
  }>(baseUrl, [
    "runs",
    "stop-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-worker",
  ]);
  assert.equal(stoppedControlPlaneTickWorkers.ok, true);
  assert.equal(stoppedControlPlaneTickWorkers.session, sessionName);
  assert.equal(stoppedControlPlaneTickWorkers.count, 1);
  assert.equal(stoppedControlPlaneTickWorkers.stopped[0]?.workerId, "detached-smoke-control-plane-worker");
  assert.equal(stoppedControlPlaneTickWorkers.stopped[0]?.retiredAt, undefined);
  assert.equal(stoppedControlPlaneTickWorkers.workers[0]?.lifecycle.state, "stopped");
  assert.equal(stoppedControlPlaneTickWorkers.workers[0]?.lifecycle.restartable, true);
  assert.equal(stoppedControlPlaneTickWorkers.workers[0]?.lifecycle.reason, "stopped_control_plane_tick_worker");
  const controlPlaneTickWorkerNext = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    actions: { restart_control_plane_tick_worker: number };
    nextSteps: Array<{ action: string; reason: string; workerId: string; command: string[]; api: { restart: { method: string; url: string; payload: { workerId: string } } } }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-tick-workers-next",
    sessionName,
    "--server",
  ]);
  assert.equal(controlPlaneTickWorkerNext.ok, true);
  assert.equal(controlPlaneTickWorkerNext.session, sessionName);
  assert.equal(controlPlaneTickWorkerNext.count, 1);
  assert.equal(controlPlaneTickWorkerNext.actions.restart_control_plane_tick_worker, 1);
  assert.equal(controlPlaneTickWorkerNext.nextSteps[0]?.workerId, "detached-smoke-control-plane-worker");
  assert.equal(controlPlaneTickWorkerNext.nextSteps[0]?.action, "restart_control_plane_tick_worker");
  assert.equal(controlPlaneTickWorkerNext.nextSteps[0]?.reason, "stopped_control_plane_tick_worker");
  assert.equal(
    controlPlaneTickWorkerNext.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-tick-workers ${sessionName} --server --worker-id detached-smoke-control-plane-worker`,
  );
  assert.equal(controlPlaneTickWorkerNext.nextSteps[0]?.api.restart.method, "POST");
  assert.match(controlPlaneTickWorkerNext.nextSteps[0]?.api.restart.url ?? "", /\/control-plane-tick-workers\/restart$/);
  assert.equal(controlPlaneTickWorkerNext.nextSteps[0]?.api.restart.payload.workerId, "detached-smoke-control-plane-worker");
  const controlPlaneStatusBeforeTickWorkerRestart = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusBeforeTickWorkerRestart.recovery.actions.restart_control_plane_tick_worker, 1);
  assert.equal(controlPlaneStatusBeforeTickWorkerRestart.recovery.nextSteps.controlPlaneTickWorkers[0]?.workerId, "detached-smoke-control-plane-worker");
  assert.equal(controlPlaneStatusBeforeTickWorkerRestart.recovery.nextSteps.controlPlaneTickWorkers[0]?.action, "restart_control_plane_tick_worker");
  const restartedControlPlaneTickWorker = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    restarted: Array<{ workerId: string; previousPid: number | null; pid: number | null; restartCount: number; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "restart-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-worker",
  ]);
  assert.equal(restartedControlPlaneTickWorker.ok, true);
  assert.equal(restartedControlPlaneTickWorker.session, sessionName);
  assert.equal(restartedControlPlaneTickWorker.count, 1);
  assert.equal(restartedControlPlaneTickWorker.restarted[0]?.workerId, "detached-smoke-control-plane-worker");
  assert.equal(restartedControlPlaneTickWorker.restarted[0]?.restartCount, 1);
  assert.equal(
    restartedControlPlaneTickWorker.restarted[0]?.command.join(" "),
    `runs session-control-plane-tick-loop ${sessionName} --server --max-ticks 1 --interval-ms 0 --lines 20 --dry-run`,
  );
  const retiredControlPlaneTickWorkers = await cliJson<typeof stoppedControlPlaneTickWorkers>(baseUrl, [
    "runs",
    "stop-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-worker",
    "--retire",
  ]);
  assert.equal(retiredControlPlaneTickWorkers.ok, true);
  assert.equal(retiredControlPlaneTickWorkers.count, 1);
  assert.ok(retiredControlPlaneTickWorkers.stopped[0]?.retiredAt);
  const controlPlaneStatusAfterTickWorker = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusAfterTickWorker.workers.controlPlaneTick.total, 2);
  assert.equal(controlPlaneStatusAfterTickWorker.workers.controlPlaneTick.retired, 1);
  assert.equal(controlPlaneStatusAfterTickWorker.workers.controlPlaneTick.completed, 1);
  const controlPlaneTimeline = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    counts: Record<string, number>;
    events: Array<{ event: string; source: string; tickId?: string; workerId?: string; status?: string; state?: string; reason?: string; restartable?: boolean }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--limit",
    "20",
    "--lines",
    "5",
  ]);
  assert.equal(controlPlaneTimeline.ok, true);
  assert.equal(controlPlaneTimeline.session, sessionName);
  assert.ok(controlPlaneTimeline.count >= 5);
  assert.ok((controlPlaneTimeline.counts.tick_recorded ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.counts.worker_completed ?? 0) >= 1);
  assert.ok((controlPlaneTimeline.counts.worker_retired ?? 0) >= 1);
  assert.ok(controlPlaneTimeline.events.some((event) => event.event === "tick_recorded" && event.status === "dry_run"));
  assert.ok(controlPlaneTimeline.events.some((event) => (
    event.event === "worker_completed"
    && event.workerId === "detached-smoke-control-plane-complete-worker"
    && event.reason === "worker_completed"
  )));
  assert.ok(controlPlaneTimeline.events.some((event) => (
    event.event === "worker_retired"
    && event.workerId === "detached-smoke-control-plane-worker"
    && event.state === "retired"
  )));
  const controlPlaneResumeNext = await cliJson<{
    resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
    nextStep: { action: string; count: number };
    candidateSelection: {
      ready: number;
      blocked: number;
      selected: number;
      selectedReady: number;
      selectedBlocked: number;
      deprioritizedBlocked: number;
      limit: number | null;
    };
    executionPath: string;
    execution: {
      executionId: string;
      status: string;
      selected: number;
      resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
      skipped: unknown[];
    };
  }>(baseUrl, [
    "runs",
    "resume-session",
    sessionName,
    "--next",
    "--run",
    `${controlPlaneBlockedPlan.run.id},${controlPlaneResumePlan.run.id}`,
  ]);
  assert.deepEqual(controlPlaneResumeNext.resumed.map((run) => run.runId), [controlPlaneResumePlan.run.id]);
  assert.equal(controlPlaneResumeNext.resumed[0].status, "planned");
  assert.equal(controlPlaneResumeNext.resumed[0].workerId, null);
  assert.equal(controlPlaneResumeNext.candidateSelection.limit, 1);
  assert.ok(controlPlaneResumeNext.candidateSelection.ready >= 1);
  assert.ok(controlPlaneResumeNext.candidateSelection.blocked >= 1);
  assert.equal(controlPlaneResumeNext.candidateSelection.selected, 1);
  assert.equal(controlPlaneResumeNext.candidateSelection.selectedReady, 1);
  assert.equal(controlPlaneResumeNext.candidateSelection.selectedBlocked, 0);
  assert.ok(controlPlaneResumeNext.candidateSelection.deprioritizedBlocked >= 1);
  assert.equal(controlPlaneResumeNext.nextStep.action, "restart_session");
  assert.equal(controlPlaneResumeNext.nextStep.count, 1);
  assert.match(controlPlaneResumeNext.executionPath, /worker-sessions\/branch-recovery-executions/);
  assert.equal(controlPlaneResumeNext.execution.status, "executed");
  assert.equal(controlPlaneResumeNext.execution.selected, 1);
  assert.deepEqual(controlPlaneResumeNext.execution.resumed.map((run) => run.runId), [controlPlaneResumePlan.run.id]);
  assert.deepEqual(controlPlaneResumeNext.execution.skipped, []);
  const branchRecoveryExecutions = await cliJson<{
    session: string;
    count: number;
    executions: Array<{ executionId: string; status: string; resumed: Array<{ runId: string }> }>;
  }>(baseUrl, [
    "runs",
    "session-branch-recovery-executions",
    sessionName,
    "--server",
    "--run",
    controlPlaneResumePlan.run.id,
  ]);
  assert.equal(branchRecoveryExecutions.session, sessionName);
  assert.equal(branchRecoveryExecutions.count, 1);
  assert.equal(branchRecoveryExecutions.executions[0]?.executionId, controlPlaneResumeNext.execution.executionId);
  assert.equal(branchRecoveryExecutions.executions[0]?.status, "executed");
  assert.deepEqual(branchRecoveryExecutions.executions[0]?.resumed.map((run) => run.runId), [controlPlaneResumePlan.run.id]);
  const controlPlaneTimelineAfterBranchRecovery = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    counts: Record<string, number>;
    events: Array<{
      event: string;
      source: string;
      executionId?: string;
      runIds?: string[];
      resumedRunIds?: string[];
      skippedRunIds?: string[];
      branchNames?: string[];
      skippedReasons?: string[];
      status?: string;
      selected?: number;
      resumedCount?: number;
      skippedCount?: number;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--limit",
    "30",
  ]);
  assert.equal(controlPlaneTimelineAfterBranchRecovery.ok, true);
  assert.ok((controlPlaneTimelineAfterBranchRecovery.counts.branch_recovery_executed ?? 0) >= 1);
  assert.ok(controlPlaneTimelineAfterBranchRecovery.events.some((event) => (
    event.event === "branch_recovery_executed"
    && event.source === "branch_recovery_execution"
    && event.executionId === controlPlaneResumeNext.execution.executionId
    && event.status === "executed"
    && event.selected === 1
    && event.resumedCount === 1
    && event.skippedCount === 0
    && event.runIds?.includes(controlPlaneResumePlan.run.id)
    && event.resumedRunIds?.includes(controlPlaneResumePlan.run.id)
  )));
  const controlPlaneResumeBlocked = await cliJson<{
    resumed: Array<{ runId: string; skipped?: string }>;
    execution: {
      executionId: string;
      status: string;
      selected: number;
      resumed: Array<{ runId: string }>;
      skipped: Array<{ runId: string; reason: string }>;
    };
  }>(baseUrl, [
    "runs",
    "resume-session",
    sessionName,
    "--run",
    controlPlaneBlockedPlan.run.id,
  ]);
  assert.deepEqual(controlPlaneResumeBlocked.resumed.map((run) => run.runId), [controlPlaneBlockedPlan.run.id]);
  assert.equal(controlPlaneResumeBlocked.resumed[0]?.skipped, "running_sandbox_present");
  assert.equal(controlPlaneResumeBlocked.execution.status, "noop");
  assert.equal(controlPlaneResumeBlocked.execution.selected, 1);
  assert.deepEqual(controlPlaneResumeBlocked.execution.resumed, []);
  assert.deepEqual(controlPlaneResumeBlocked.execution.skipped.map((run) => run.runId), [controlPlaneBlockedPlan.run.id]);
  assert.equal(controlPlaneResumeBlocked.execution.skipped[0]?.reason, "running_sandbox_present");
  const controlPlaneTimelineAfterSkippedBranchRecovery = await cliJson<typeof controlPlaneTimelineAfterBranchRecovery>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--limit",
    "30",
  ]);
  assert.ok((controlPlaneTimelineAfterSkippedBranchRecovery.counts.branch_recovery_executed ?? 0) >= 2);
  assert.ok(controlPlaneTimelineAfterSkippedBranchRecovery.events.some((event) => (
    event.event === "branch_recovery_executed"
    && event.source === "branch_recovery_execution"
    && event.executionId === controlPlaneResumeBlocked.execution.executionId
    && event.status === "noop"
    && event.selected === 1
    && event.resumedCount === 0
    && event.skippedCount === 1
    && event.runIds?.includes(controlPlaneBlockedPlan.run.id)
    && event.skippedRunIds?.includes(controlPlaneBlockedPlan.run.id)
    && event.skippedReasons?.includes("running_sandbox_present")
    && event.branchNames?.includes(controlPlaneBlockedPlan.plan.branchName)
  )));
  const controlPlaneStatusAfterResume = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.ok(controlPlaneStatusAfterResume.branches.executions.counts.recent >= 1);
  assert.ok(controlPlaneStatusAfterResume.branches.executions.counts.executed >= 1);
  assert.ok(controlPlaneStatusAfterResume.branches.executions.recent.some((execution) => (
    execution.executionId === controlPlaneResumeNext.execution.executionId
    && execution.status === "executed"
    && execution.resumed.some((run) => run.runId === controlPlaneResumePlan.run.id)
  )));
  assert.ok(controlPlaneStatus.queues.applyActions.actionable >= 1);
  assert.ok(controlPlaneStatus.queues.applyActions.resetAudits >= 1);
  assert.ok(controlPlaneStatus.queues.drainContinuations.total >= 1);
  assert.ok(
    controlPlaneStatus.queues.drainContinuations.queued
      + controlPlaneStatus.queues.drainContinuations.running
      + controlPlaneStatus.queues.drainContinuations.executed
      + controlPlaneStatus.queues.drainContinuations.failed
      <= controlPlaneStatus.queues.drainContinuations.total,
  );
  assert.equal(controlPlaneStatus.recovery.actions.restart_drain_worker, 1);
  assert.equal(controlPlaneStatus.recovery.nextSteps.drainWorkers[0]?.workerId, serverDrainWorkerId);
  assert.equal(controlPlaneStatus.recovery.nextSteps.drainWorkers[0]?.action, "restart_drain_worker");
  assert.equal(controlPlaneStatus.recovery.actions.restart_apply_action_worker, 1);
  assert.equal(controlPlaneStatus.recovery.nextSteps.applyActionWorkers[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(controlPlaneStatus.recovery.nextSteps.applyActionWorkers[0]?.action, "restart_apply_action_worker");
  const restartedServerDrainWorker = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    restarted: Array<{ workerId: string; previousPid: number | null; pid: number | null; restartCount: number; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "restart-drain-workers",
    sessionName,
    "--server",
    "--worker-id",
    serverDrainWorkerId,
  ]);
  assert.equal(restartedServerDrainWorker.ok, true);
  assert.equal(restartedServerDrainWorker.session, sessionName);
  assert.equal(restartedServerDrainWorker.count, 1);
  assert.equal(restartedServerDrainWorker.restarted[0]?.workerId, serverDrainWorkerId);
  assert.equal(restartedServerDrainWorker.restarted[0]?.previousPid, null);
  assert.equal(restartedServerDrainWorker.restarted[0]?.restartCount, 1);
  assert.deepEqual(restartedServerDrainWorker.restarted[0]?.command, ["runs", "session-drain-workers", sessionName, "--server"]);
  await cliJson(baseUrl, [
    "runs",
    "stop-drain-workers",
    sessionName,
    "--server",
    "--worker-id",
    serverDrainWorkerId,
    "--retire",
  ]);
  const restartedApplyActionWorkers = await cliJson<{
    ok?: true;
    count: number;
    restarted: Array<{ workerId: string; restartCount: number; command: string[] }>;
    workers: Array<{ workerId: string; restartedAt?: string; retiredAt?: string }>;
  }>(baseUrl, [
    "runs",
    "restart-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-apply-action-worker",
  ]);
  assert.equal(restartedApplyActionWorkers.ok, true);
  assert.equal(restartedApplyActionWorkers.count, 1);
  assert.equal(restartedApplyActionWorkers.restarted[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(restartedApplyActionWorkers.restarted[0]?.restartCount, 1);
  assert.deepEqual(restartedApplyActionWorkers.restarted[0]?.command.slice(0, 4), ["runs", "session-applies", sessionName, "--server"]);
  assert.equal(restartedApplyActionWorkers.workers[0]?.workerId, "detached-smoke-apply-action-worker");
  assert.equal(typeof restartedApplyActionWorkers.workers[0]?.restartedAt, "string");
  assert.equal(restartedApplyActionWorkers.workers[0]?.retiredAt, undefined);
  await cliJson(baseUrl, [
    "runs",
    "stop-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-apply-action-worker",
    "--retire",
  ]);
  const serverResetAuditAck = await cliJson<{
    session: string;
    applyId: string;
    dryRun: boolean;
    resetAudit: { acknowledged: boolean; acknowledgedAt: string; acknowledgedBy: string };
    record: { resetAuditAcknowledgedAt: string; resetAuditAcknowledgedBy: string };
  }>(baseUrl, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--apply-id",
    "detached-session-api-backed-reset",
    "--ack-reset-audit",
  ]);
  assert.equal(serverResetAuditAck.session, sessionName);
  assert.equal(serverResetAuditAck.applyId, "detached-session-api-backed-reset");
  assert.equal(serverResetAuditAck.dryRun, false);
  assert.equal(serverResetAuditAck.resetAudit.acknowledged, true);
  assert.equal(serverResetAuditAck.resetAudit.acknowledgedBy, "server");
  assert.equal(serverResetAuditAck.record.resetAuditAcknowledgedAt, serverResetAuditAck.resetAudit.acknowledgedAt);
  assert.equal(serverResetAuditAck.record.resetAuditAcknowledgedBy, "server");
  await fs.rm(apiBackedResetContinuationPath, { force: true });

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

async function cliText(baseUrl: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
  });
  return stdout;
}

async function cleanupSession(session: string): Promise<void> {
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${session}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "apply", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "apply-action-executions", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "apply-action-workers", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "branch-recovery-executions", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-tick-workers", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-ticks", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "drain-continuations", session), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "drain-continuation-workers", session), { recursive: true, force: true });
}

async function writeDrainContinuation(
  session: string,
  continuationId: string,
  overrides: Record<string, unknown>,
): Promise<string> {
  const continuationDir = path.join(".threadbeat", "worker-sessions", "drain-continuations", session);
  const continuationPath = path.join(continuationDir, `${continuationId}.json`);
  await fs.mkdir(continuationDir, { recursive: true });
  await fs.writeFile(continuationPath, `${JSON.stringify({
    continuationId,
    session,
    observedAt: new Date().toISOString(),
    dryRun: false,
    filter: {},
    readinessSource: "server",
    readinessCounts: {
      total: 1,
      needsContinuation: 1,
      done: 0,
      stoppedOnFailure: 1,
    },
    ...overrides,
  }, null, 2)}\n`);
  return continuationPath;
}
