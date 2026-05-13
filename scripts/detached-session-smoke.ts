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

  const serverRecoverBranch = `threadbeat/runs/server-recovery-${Date.now().toString(36)}`;
  const serverRecoverRun = await db.createAgentRun({
    agentId: agent.agent.id,
    objective: "detached session server recovery",
    inputRef: "main",
    runBranch: serverRecoverBranch,
  });
  const serverRecoverClaim = await db.claimAgentRun(serverRecoverRun.id, "detached-smoke-worker-1");
  assert.ok(serverRecoverClaim);
  const serverRecoveredPreview = await cliJson<{
    ok?: true;
    session: string;
    recovered: Array<{
      runId: string;
      branchName: string;
      workerId: string | null;
      currentStatus: string;
      dryRun?: boolean;
      recoveryInspection: {
        recovery: {
          ready: boolean;
          reason: string;
          inspectionMode: string;
          runningSandboxes: unknown[];
        };
        commands: {
          recoverSession: string[];
          inspectRun: string[];
        };
      };
    }>;
    candidateSelection: { selected: number; recovered: number; skipped: number };
    actions: { recoverSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, ["runs", "recover-session", sessionName, "--server", "--dry-run", "--run", serverRecoverRun.id]);
  assert.equal(serverRecoveredPreview.ok, true);
  assert.equal(serverRecoveredPreview.session, sessionName);
  assert.deepEqual(serverRecoveredPreview.recovered.map((run) => run.runId), [serverRecoverRun.id]);
  assert.equal(serverRecoveredPreview.recovered[0].branchName, serverRecoverBranch);
  assert.equal(serverRecoveredPreview.recovered[0].workerId, "detached-smoke-worker-1");
  assert.equal(serverRecoveredPreview.recovered[0].currentStatus, "running");
  assert.equal(serverRecoveredPreview.recovered[0].dryRun, true);
  assert.equal(serverRecoveredPreview.recovered[0].recoveryInspection.recovery.ready, true);
  assert.equal(serverRecoveredPreview.recovered[0].recoveryInspection.recovery.reason, "stale_or_stopped_branch_without_running_sandbox");
  assert.equal(serverRecoveredPreview.recovered[0].recoveryInspection.recovery.inspectionMode, "server_metadata");
  assert.deepEqual(serverRecoveredPreview.recovered[0].recoveryInspection.recovery.runningSandboxes, []);
  assert.equal(serverRecoveredPreview.recovered[0].recoveryInspection.commands.recoverSession.join(" "), `npm run cli -- runs recover-session ${sessionName} --server`);
  assert.equal(serverRecoveredPreview.recovered[0].recoveryInspection.commands.inspectRun.join(" "), `npm run cli -- runs inspect ${serverRecoverRun.id}`);
  assert.equal(serverRecoveredPreview.candidateSelection.selected, 1);
  assert.equal(serverRecoveredPreview.candidateSelection.recovered, 1);
  assert.equal(serverRecoveredPreview.candidateSelection.skipped, 0);
  assert.equal(serverRecoveredPreview.nextStep.action, "recover_session");
  assert.equal(serverRecoveredPreview.nextStep.reason, "dry_run_preview");
  assert.equal(serverRecoveredPreview.nextStep.count, 1);
  assert.equal(serverRecoveredPreview.nextStep.command.join(" "), `npm run cli -- runs recover-session ${sessionName} --server`);
  assert.equal(serverRecoveredPreview.actions.recoverSession.join(" "), `npm run cli -- runs recover-session ${sessionName} --server`);
  const serverRecovered = await cliJson<{
    ok?: true;
    session: string;
    recovered: Array<{ runId: string; status?: string; workerId: string | null }>;
    candidateSelection: { selected: number; recovered: number; skipped: number };
    actions: { sessionWait: string[]; restartSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
    execution: {
      executionId: string;
      status: string;
      selected: number;
      resumed: Array<{ runId: string; branchName: string; status?: string }>;
      skipped: unknown[];
      filter: { action?: string; runIds?: string[] };
    };
  }>(baseUrl, ["runs", "recover-session", sessionName, "--server", "--run", serverRecoverRun.id]);
  assert.equal(serverRecovered.ok, true);
  assert.equal(serverRecovered.session, sessionName);
  assert.deepEqual(serverRecovered.recovered.map((run) => run.runId), [serverRecoverRun.id]);
  assert.equal(serverRecovered.recovered[0].status, "planned");
  assert.equal(serverRecovered.recovered[0].workerId, null);
  assert.equal(serverRecovered.candidateSelection.selected, 1);
  assert.equal(serverRecovered.candidateSelection.recovered, 1);
  assert.equal(serverRecovered.candidateSelection.skipped, 0);
  assert.equal(serverRecovered.nextStep.action, "wait_session");
  assert.equal(serverRecovered.nextStep.reason, "recovered_runs_for_live_workers");
  assert.equal(serverRecovered.nextStep.count, 1);
  assert.equal(serverRecovered.nextStep.command.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(serverRecovered.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${sessionName}`);
  assert.equal(serverRecovered.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${sessionName} --recover`);
  assert.equal(serverRecovered.execution.status, "executed");
  assert.equal(serverRecovered.execution.selected, 1);
  assert.deepEqual(serverRecovered.execution.resumed.map((run) => run.runId), [serverRecoverRun.id]);
  assert.equal(serverRecovered.execution.resumed[0].branchName, serverRecoverBranch);
  assert.equal(serverRecovered.execution.resumed[0].status, "planned");
  assert.deepEqual(serverRecovered.execution.skipped, []);
  assert.equal(serverRecovered.execution.filter.action, "recover_session");
  assert.deepEqual(serverRecovered.execution.filter.runIds, [serverRecoverRun.id]);
  const watchedBranchRecoveryExecutions = await cliJson<{
    summary: {
      branchRecoveryExecutions: number;
      branchRecoveryExecuted: number;
      branchRecoveryPartial: number;
      branchRecoveryNoop: number;
    };
    branchRecoveryExecutions: {
      counts: { recent: number; executed: number; partial: number; noop: number };
      recent: Array<{
        executionId: string;
        status: string;
        resumed: Array<{ runId: string }>;
        skipped: unknown[];
      }>;
    };
  }>(baseUrl, [
    "runs",
    "session-watch",
    sessionName,
    "--recoverable",
    "--include-stopped",
    "--next",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.ok(watchedBranchRecoveryExecutions.summary.branchRecoveryExecutions >= 1);
  assert.ok(watchedBranchRecoveryExecutions.summary.branchRecoveryExecuted >= 1);
  assert.equal(watchedBranchRecoveryExecutions.summary.branchRecoveryPartial, 0);
  assert.equal(watchedBranchRecoveryExecutions.summary.branchRecoveryNoop, 0);
  assert.equal(
    watchedBranchRecoveryExecutions.summary.branchRecoveryExecutions,
    watchedBranchRecoveryExecutions.branchRecoveryExecutions.counts.recent,
  );
  assert.equal(
    watchedBranchRecoveryExecutions.summary.branchRecoveryExecuted,
    watchedBranchRecoveryExecutions.branchRecoveryExecutions.counts.executed,
  );
  assert.ok(watchedBranchRecoveryExecutions.branchRecoveryExecutions.recent.some((execution) => (
    execution.executionId === serverRecovered.execution.executionId
    && execution.status === "executed"
    && execution.resumed.some((run) => run.runId === serverRecoverRun.id)
    && execution.skipped.length === 0
  )));

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
  const cliBranchResumeQueue = await cliJson<{
    ok: true;
    session: string;
    filter: {
      branchAction: string[];
      runIds: string[];
      limit: number;
      offset: number;
      totalNextSteps: number;
      visibleNextSteps: number;
      hasMore: boolean;
    };
    commands: Array<{
      action: string;
      runId: string;
      state: string;
      branchName: string;
      resultCommit: string | null;
      command: string[];
    }>;
  }>(baseUrl, [
    "runs",
    "session-branches",
    sessionName,
    "--server",
    "--branch-action",
    "resume_branch",
    "--run",
    stoppedPlan.run.id,
    "--limit",
    "1",
    "--commands-only",
  ]);
  assert.equal(cliBranchResumeQueue.ok, true);
  assert.equal(cliBranchResumeQueue.session, sessionName);
  assert.deepEqual(cliBranchResumeQueue.filter.branchAction, ["resume_branch"]);
  assert.deepEqual(cliBranchResumeQueue.filter.runIds, [stoppedPlan.run.id]);
  assert.equal(cliBranchResumeQueue.filter.limit, 1);
  assert.equal(cliBranchResumeQueue.filter.offset, 0);
  assert.equal(cliBranchResumeQueue.filter.totalNextSteps, 1);
  assert.equal(cliBranchResumeQueue.filter.visibleNextSteps, 1);
  assert.equal(cliBranchResumeQueue.filter.hasMore, false);
  assert.equal(cliBranchResumeQueue.commands.length, 1);
  assert.equal(cliBranchResumeQueue.commands[0].action, "resume_branch");
  assert.equal(cliBranchResumeQueue.commands[0].runId, stoppedPlan.run.id);
  assert.equal(cliBranchResumeQueue.commands[0].state, "resumable");
  assert.equal(cliBranchResumeQueue.commands[0].branchName, stoppedPlan.plan.branchName);
  assert.equal(cliBranchResumeQueue.commands[0].resultCommit, null);
  assert.equal(cliBranchResumeQueue.commands[0].command.join(" "), `npm run cli -- runs resume-branch ${stoppedPlan.run.id}`);
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
  type ApplyActionWorkerEnsureResponse = {
    ok?: true;
    session: string;
    action: string;
    reason: string;
    worker: {
      workerId: string;
      command: string[];
      alive: boolean;
      restartCount?: number;
      retiredAt?: string;
    };
    workers: Array<{ workerId: string; alive: boolean; retiredAt?: string }>;
  };
  const ensuredApplyActionWorkerId = "detached-smoke-apply-action-ensure-worker";
  const ensuredApplyActionWorker = await cliJson<ApplyActionWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-apply-action-worker",
    sessionName,
    "--server",
    "--worker-id",
    ensuredApplyActionWorkerId,
    "--apply-action",
    "inspect_drain_continuation_resets",
    "--max-actions",
    "1",
    "--lines",
    "5",
  ]);
  assert.equal(ensuredApplyActionWorker.ok, true);
  assert.equal(ensuredApplyActionWorker.session, sessionName);
  assert.equal(ensuredApplyActionWorker.action, "started");
  assert.equal(ensuredApplyActionWorker.reason, "no_running_or_restartable_worker");
  assert.equal(ensuredApplyActionWorker.worker.workerId, ensuredApplyActionWorkerId);
  assert.deepEqual(ensuredApplyActionWorker.worker.command, [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--record-worker",
    ensuredApplyActionWorkerId,
    "--apply-action",
    "inspect_drain_continuation_resets",
    "--max-actions",
    "1",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    ensuredApplyActionWorkerId,
  ]);
  const restartedEnsuredApplyActionWorker = await cliJson<ApplyActionWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-apply-action-worker",
    sessionName,
    "--server",
    "--worker-id",
    ensuredApplyActionWorkerId,
    "--lines",
    "5",
  ]);
  assert.equal(restartedEnsuredApplyActionWorker.ok, true);
  assert.equal(restartedEnsuredApplyActionWorker.action, "restarted");
  assert.equal(restartedEnsuredApplyActionWorker.reason, "restartable_worker_exists");
  assert.equal(restartedEnsuredApplyActionWorker.worker.workerId, ensuredApplyActionWorkerId);
  assert.equal(restartedEnsuredApplyActionWorker.worker.restartCount, 1);
  await cliJson(baseUrl, [
    "runs",
    "stop-apply-action-workers",
    sessionName,
    "--server",
    "--worker-id",
    ensuredApplyActionWorkerId,
    "--retire",
  ]);
  const blockedEnsuredApplyActionWorker = await cliJson<ApplyActionWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-apply-action-worker",
    sessionName,
    "--server",
    "--worker-id",
    ensuredApplyActionWorkerId,
    "--lines",
    "5",
  ]);
  assert.equal(blockedEnsuredApplyActionWorker.ok, true);
  assert.equal(blockedEnsuredApplyActionWorker.action, "blocked");
  assert.equal(blockedEnsuredApplyActionWorker.reason, "existing_worker_not_restartable");
  assert.equal(blockedEnsuredApplyActionWorker.worker.workerId, ensuredApplyActionWorkerId);
  assert.equal(typeof blockedEnsuredApplyActionWorker.worker.retiredAt, "string");
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
  const controlPlaneResumePlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
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
      controlPlaneAdvance: {
        total: number;
        stopped: number;
        retired: number;
        completed: number;
        modes: {
          advance_loop: { total: number; stopped: number; retired: number; completed: number };
          confirmation_drain: { total: number; stopped: number; retired: number; completed: number };
        };
      };
      controlPlaneTick: { total: number; stopped: number; retired: number; completed: number };
    };
    queues: {
      applyActions: { actionable: number; resetAudits: number };
      applyActionNextSteps: {
        count: number;
        nextSteps: Array<{
          applyId: string;
          source: string;
          action: string;
          selected: number;
          failed: number;
          pending: number;
          command: string[];
          executeCommand: string[];
        }>;
      };
      applyActionExecutions: {
        counts: { recent: number; executed: number; failed: number };
        recent: Array<{ executionId: string; applyId: string; action: string; status: string; exitCode: number | null }>;
      };
      drainContinuations: { total: number; queued: number; running: number; executed: number; failed: number };
    };
    branches: {
      counts: { total: number; ready: number; blocked: number; stoppedBranchWithoutResultCommit: number; runningSandboxPresent: number };
      actions: { resume_branch: number; inspect_run: number };
      commands: { resumeSession: string[]; resumeSessionDryRun: string[]; resumeNext: string[]; inspectBranches: string[] };
      nextSteps: Array<{
        action: string;
        reason: string;
        agentId: string;
        runId: string;
        objective: string;
        status: string;
        branchName: string;
        resultCommit: string | null;
        workerId: string | null;
        command: string[];
        commands: {
          inspectRun: string[];
          checkoutBranch: string[];
          reviewRun: string[];
          watchRun: string[];
          resumeBranch: string[] | null;
          resumeBranchDryRun: string[];
        };
        runningSandboxes: Array<{ id: string; providerSandboxId: string | null }>;
      }>;
      executions: {
        counts: { recent: number; executed: number; partial: number; noop: number };
        recent: Array<{ executionId: string; status: string; resumed: Array<{ runId: string }> }>;
      };
    };
    staleRuns: {
      counts: { total: number; ready: number; blocked: number; staleRunningClaimWithoutRunningSandbox: number; runningSandboxPresent: number };
      actions: { recover_session_run: number; inspect_run: number };
      commands: { recoverSession: string[]; recoverSessionDryRun: string[]; inspectSession: string[] };
      nextSteps: Array<{
        action: string;
        reason: string;
        agentId: string;
        runId: string;
        objective: string;
        status: string;
        branchName: string;
        resultCommit: string | null;
        workerId: string | null;
        command: string[];
        commands: {
          inspectRun: string[];
          recoverRun: string[] | null;
          recoverRunDryRun: string[];
          recoverSession: string[];
          recoverSessionDryRun: string[];
        };
        runningSandboxes: Array<{ id: string; providerSandboxId: string | null }>;
      }>;
    };
    recovery: {
      count: number;
      actions: { restart_drain_worker: number; restart_apply_action_worker: number; restart_control_plane_advance_worker: number; restart_control_plane_tick_worker: number };
      nextSteps: {
        drainWorkers: Array<{ workerId: string; action: string }>;
        applyActionWorkers: Array<{ workerId: string; action: string }>;
        controlPlaneAdvanceWorkers: Array<{ workerId: string; action: string; mode?: "advance_loop" | "confirmation_drain" }>;
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
  assert.equal(controlPlaneStatus.workers.applyAction.total, 2);
  assert.equal(controlPlaneStatus.workers.applyAction.stopped, 1);
  assert.equal(controlPlaneStatus.workers.applyAction.retired, 1);
  assert.equal(controlPlaneStatus.workers.controlPlaneAdvance.total, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneAdvance.stopped, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneAdvance.retired, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneAdvance.completed, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneAdvance.modes.advance_loop.total, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneAdvance.modes.confirmation_drain.total, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.total, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.stopped, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.retired, 0);
  assert.equal(controlPlaneStatus.workers.controlPlaneTick.completed, 0);
  assert.ok(controlPlaneStatus.queues.applyActionExecutions.counts.recent >= serverApplyActionExecutionsAfterWorker.count);
  assert.ok(controlPlaneStatus.queues.applyActionExecutions.counts.executed >= serverApplyActionExecutionsAfterWorker.count);
  assert.equal(controlPlaneStatus.queues.applyActionExecutions.counts.failed, 0);
  assert.ok(controlPlaneStatus.queues.applyActionExecutions.recent.some((execution) => (
    execution.executionId === serverExecutedApplyAction.execution?.executionId
    && execution.applyId === "detached-session-api-backed-reset"
    && execution.action === "inspect_drain_continuation_resets"
    && execution.status === "executed"
    && execution.exitCode === 0
  )));
  assert.equal(controlPlaneStatus.queues.applyActionNextSteps.count, controlPlaneStatus.queues.applyActions.actionable);
  assert.ok(controlPlaneStatus.queues.applyActionNextSteps.nextSteps.length <= 20);
  assert.ok(controlPlaneStatus.queues.applyActionNextSteps.nextSteps.some((step) => (
    step.applyId === "detached-session-api-backed-reset"
    && step.action === "inspect_drain_continuation_resets"
    && step.executeCommand.join(" ") === `npm run cli -- runs session-applies ${sessionName} --server --action-queue --execute-next --apply-id detached-session-api-backed-reset --apply-action inspect_drain_continuation_resets`
  )));
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
  assert.equal(controlPlaneStatus.staleRuns.counts.ready, controlPlaneStatus.staleRuns.actions.recover_session_run);
  assert.equal(controlPlaneStatus.staleRuns.counts.blocked, controlPlaneStatus.staleRuns.actions.inspect_run);
  assert.equal(controlPlaneStatus.staleRuns.counts.staleRunningClaimWithoutRunningSandbox, controlPlaneStatus.staleRuns.counts.ready);
  assert.equal(controlPlaneStatus.staleRuns.counts.runningSandboxPresent, controlPlaneStatus.staleRuns.counts.blocked);
  assert.equal(controlPlaneStatus.staleRuns.commands.recoverSession.join(" "), `npm run cli -- runs recover-session ${sessionName} --server`);
  assert.equal(controlPlaneStatus.staleRuns.commands.recoverSessionDryRun.join(" "), `npm run cli -- runs recover-session ${sessionName} --server --dry-run`);
  assert.equal(controlPlaneStatus.staleRuns.commands.inspectSession.join(" "), `npm run cli -- runs session-control-plane-status ${sessionName} --server`);
  const controlPlaneStatusSummary = await cliJson<{
    ok?: true;
    session: string;
    needsAction: boolean;
    workers: typeof controlPlaneStatus.workers;
    queues: {
      applyActions: { total: number; actionable: number; resetAudits: number };
      drainContinuations: { total: number; queued: number; running: number; failed: number };
      applyActionExecutions: { recent: number; executed: number; failed: number };
    };
    branches: {
      counts: typeof controlPlaneStatus.branches.counts;
      actions: typeof controlPlaneStatus.branches.actions;
    };
    staleRuns: {
      counts: typeof controlPlaneStatus.staleRuns.counts;
      actions: typeof controlPlaneStatus.staleRuns.actions;
    };
    recovery: { count: number; actions: Record<string, number> };
    nextActions: Array<{ surface: string; action: string; reason: string; count: number; command: string[] }>;
    commands: {
      fullStatus: string[];
      advance: string[];
      advanceDryRun: string[];
      advanceLoop: string[];
      advanceLoopDryRun: string[];
      tick: string[];
      tickDryRun: string[];
      timelineSummary: string[];
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusSummary.ok, true);
  assert.equal(controlPlaneStatusSummary.session, sessionName);
  assert.equal(controlPlaneStatusSummary.needsAction, true);
  assert.deepEqual(controlPlaneStatusSummary.workers, controlPlaneStatus.workers);
  assert.equal(controlPlaneStatusSummary.queues.applyActions.actionable, controlPlaneStatus.queues.applyActions.actionable);
  assert.equal(controlPlaneStatusSummary.queues.drainContinuations.total, controlPlaneStatus.queues.drainContinuations.total);
  assert.equal(controlPlaneStatusSummary.branches.counts.ready, controlPlaneStatus.branches.counts.ready);
  assert.equal(controlPlaneStatusSummary.staleRuns.counts.ready, controlPlaneStatus.staleRuns.counts.ready);
  assert.equal(controlPlaneStatusSummary.recovery.count, controlPlaneStatus.recovery.count);
  assert.ok(controlPlaneStatusSummary.nextActions.length > 0);
  if (controlPlaneStatus.staleRuns.counts.ready > 0) {
    assert.ok(controlPlaneStatusSummary.nextActions.some((action) => (
      action.action === "recover_stale_run"
      && action.count === controlPlaneStatus.staleRuns.counts.ready
      && action.command.join(" ").includes("recover-session")
    )));
  }
  if (controlPlaneStatus.branches.counts.ready > 0) {
    const firstReadyBranch = controlPlaneStatus.branches.nextSteps.find((step) => step.action === "resume_branch");
    assert.ok(controlPlaneStatusSummary.nextActions.some((action) => (
      action.action === "resume_branch"
      && action.count === controlPlaneStatus.branches.counts.ready
      && action.command.join(" ") === firstReadyBranch?.command.join(" ")
    )));
  }
  if (controlPlaneStatus.queues.applyActions.actionable > 0) {
    assert.ok(controlPlaneStatusSummary.nextActions.some((action) => (
      action.action === "execute_next_apply_action"
      && action.count === controlPlaneStatus.queues.applyActions.actionable
    )));
  }
  assert.equal(
    controlPlaneStatusSummary.commands.timelineSummary.join(" "),
    `npm run cli -- runs session-control-plane-timeline ${sessionName} --server --summary`,
  );
  assert.equal(
    controlPlaneStatusSummary.commands.advance.join(" "),
    `npm run cli -- runs session-control-plane-advance ${sessionName} --server`,
  );
  assert.equal(
    controlPlaneStatusSummary.commands.advanceDryRun.join(" "),
    `npm run cli -- runs session-control-plane-advance ${sessionName} --server --dry-run`,
  );
  assert.equal(
    controlPlaneStatusSummary.commands.advanceLoop.join(" "),
    `npm run cli -- runs session-control-plane-advance-loop ${sessionName} --server`,
  );
  assert.equal(
    controlPlaneStatusSummary.commands.advanceLoopDryRun.join(" "),
    `npm run cli -- runs session-control-plane-advance-loop ${sessionName} --server --dry-run`,
  );
  const controlPlaneAdvancePreview = await cliJson<{
    ok?: true;
    session: string;
    advanceId: string;
    advancePath: string;
    dryRun: boolean;
    selected: { surface: string; action: string; reason: string; count: number; command: string[] } | null;
    executed: null;
    before: { branches: { counts: { ready: number } }; queues: { applyActions: { actionable: number } }; recovery: { count: number } };
    after: { branches: { counts: { ready: number } }; queues: { applyActions: { actionable: number } }; recovery: { count: number } };
  }>(baseUrl, [
    "runs",
    "session-control-plane-advance",
    sessionName,
    "--server",
    "--dry-run",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneAdvancePreview.ok, true);
  assert.equal(controlPlaneAdvancePreview.session, sessionName);
  assert.match(controlPlaneAdvancePreview.advanceId, /^20/);
  assert.match(controlPlaneAdvancePreview.advancePath, /control-plane-advances/);
  assert.equal(controlPlaneAdvancePreview.dryRun, true);
  assert.deepEqual(controlPlaneAdvancePreview.selected, controlPlaneStatusSummary.nextActions[0]);
  assert.equal(controlPlaneAdvancePreview.executed, null);
  assert.equal(controlPlaneAdvancePreview.before.branches.counts.ready, controlPlaneStatus.branches.counts.ready);
  assert.equal(controlPlaneAdvancePreview.after.branches.counts.ready, controlPlaneStatus.branches.counts.ready);
  assert.equal(controlPlaneAdvancePreview.before.queues.applyActions.actionable, controlPlaneStatus.queues.applyActions.actionable);
  assert.equal(controlPlaneAdvancePreview.after.queues.applyActions.actionable, controlPlaneStatus.queues.applyActions.actionable);
  const controlPlaneAdvanceLoopPreview = await cliJson<{
    ok?: true;
    session: string;
    dryRun: boolean;
    maxSteps: number;
    intervalMs: number;
    executedSteps: number;
    stoppedReason: string;
    advances: Array<{
      advanceId: string;
      advancePath: string;
      selected: { surface: string; action: string; reason: string; count: number; command: string[] } | null;
      executed: null;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advance-loop",
    sessionName,
    "--server",
    "--dry-run",
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneAdvanceLoopPreview.ok, true);
  assert.equal(controlPlaneAdvanceLoopPreview.session, sessionName);
  assert.equal(controlPlaneAdvanceLoopPreview.dryRun, true);
  assert.equal(controlPlaneAdvanceLoopPreview.maxSteps, 3);
  assert.equal(controlPlaneAdvanceLoopPreview.intervalMs, 0);
  assert.equal(controlPlaneAdvanceLoopPreview.executedSteps, 1);
  assert.equal(controlPlaneAdvanceLoopPreview.stoppedReason, "dry_run");
  assert.equal(controlPlaneAdvanceLoopPreview.advances.length, 1);
  assert.match(controlPlaneAdvanceLoopPreview.advances[0]?.advanceId ?? "", /^20/);
  assert.match(controlPlaneAdvanceLoopPreview.advances[0]?.advancePath ?? "", /control-plane-advances/);
  assert.deepEqual(controlPlaneAdvanceLoopPreview.advances[0]?.selected, controlPlaneStatusSummary.nextActions[0]);
  assert.equal(controlPlaneAdvanceLoopPreview.advances[0]?.executed, null);
  const controlPlaneAdvances = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    advances: Array<{ advanceId: string; dryRun: boolean; selected: { surface: string; action: string } | null; executed: null }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--limit",
    "5",
  ]);
  assert.equal(controlPlaneAdvances.ok, true);
  assert.equal(controlPlaneAdvances.session, sessionName);
  assert.ok(controlPlaneAdvances.count >= 2);
  assert.ok(controlPlaneAdvances.advances.some((advance) => advance.advanceId === controlPlaneAdvancePreview.advanceId));
  assert.ok(controlPlaneAdvances.advances.some((advance) => advance.advanceId === controlPlaneAdvanceLoopPreview.advances[0]?.advanceId));
  assert.ok(controlPlaneAdvances.advances.every((advance) => advance.dryRun));
  assert.ok(controlPlaneAdvances.advances.every((advance) => advance.executed === null));
  const completedControlPlaneAdvanceWorker = await cliJson<{
    ok?: true;
    session: string;
    worker: { workerId: string; command: string[]; pid: number | null; stdoutPath: string; stderrPath: string };
  }>(baseUrl, [
    "runs",
    "start-control-plane-advance-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-advance-worker",
    "--dry-run",
    "--max-steps",
    "1",
    "--interval-ms",
    "0",
    "--lines",
    "20",
  ]);
  assert.equal(completedControlPlaneAdvanceWorker.ok, true);
  assert.equal(completedControlPlaneAdvanceWorker.session, sessionName);
  assert.equal(completedControlPlaneAdvanceWorker.worker.workerId, "detached-smoke-control-plane-advance-worker");
  assert.equal(
    completedControlPlaneAdvanceWorker.worker.command.join(" "),
    `runs session-control-plane-advance-loop ${sessionName} --server --max-steps 1 --interval-ms 0 --lines 20 --dry-run`,
  );
  assert.match(completedControlPlaneAdvanceWorker.worker.stdoutPath, /control-plane-advance-workers/);
  assert.match(completedControlPlaneAdvanceWorker.worker.stderrPath, /control-plane-advance-workers/);
  type ControlPlaneAdvanceWorkerListResponse = {
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
  let completedControlPlaneAdvanceWorkers: ControlPlaneAdvanceWorkerListResponse | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    completedControlPlaneAdvanceWorkers = await cliJson<ControlPlaneAdvanceWorkerListResponse>(baseUrl, [
      "runs",
      "session-control-plane-advance-workers",
      sessionName,
      "--server",
      "--worker-id",
      "detached-smoke-control-plane-advance-worker",
    ]);
    if (completedControlPlaneAdvanceWorkers?.workers[0]?.completedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(completedControlPlaneAdvanceWorkers?.ok, true);
  assert.equal(completedControlPlaneAdvanceWorkers?.count, 1);
  assert.equal(completedControlPlaneAdvanceWorkers?.workers[0]?.workerId, "detached-smoke-control-plane-advance-worker");
  assert.equal(completedControlPlaneAdvanceWorkers?.workers[0]?.alive, false);
  assert.ok(completedControlPlaneAdvanceWorkers?.workers[0]?.completedAt);
  assert.equal(completedControlPlaneAdvanceWorkers?.workers[0]?.completionResult?.exitCode, 0);
  assert.equal(completedControlPlaneAdvanceWorkers?.workers[0]?.lifecycle.state, "completed");
  assert.equal(completedControlPlaneAdvanceWorkers?.workers[0]?.lifecycle.restartable, false);
  assert.equal(completedControlPlaneAdvanceWorkers?.workers[0]?.lifecycle.reason, "worker_completed");
  const stoppedControlPlaneAdvanceWorkers = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    stopped: Array<{ workerId: string; stoppedAt: string; retiredAt?: string }>;
    workers: Array<{ workerId: string; retiredAt?: string; lifecycle: { state: string; restartable: boolean; reason: string } }>;
  }>(baseUrl, [
    "runs",
    "stop-control-plane-advance-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-advance-worker",
  ]);
  assert.equal(stoppedControlPlaneAdvanceWorkers.ok, true);
  assert.equal(stoppedControlPlaneAdvanceWorkers.count, 1);
  assert.equal(stoppedControlPlaneAdvanceWorkers.stopped[0]?.workerId, "detached-smoke-control-plane-advance-worker");
  assert.equal(stoppedControlPlaneAdvanceWorkers.stopped[0]?.retiredAt, undefined);
  assert.equal(stoppedControlPlaneAdvanceWorkers.workers[0]?.lifecycle.state, "stopped");
  assert.equal(stoppedControlPlaneAdvanceWorkers.workers[0]?.lifecycle.restartable, true);
  assert.equal(stoppedControlPlaneAdvanceWorkers.workers[0]?.lifecycle.reason, "stopped_control_plane_advance_worker");
  const controlPlaneAdvanceWorkerNext = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    actions: { restart_control_plane_advance_worker: number };
    nextSteps: Array<{ action: string; reason: string; workerId: string; mode: "advance_loop" | "confirmation_drain"; command: string[]; api: { restart: { method: string; url: string; payload: { workerId: string } } } }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advance-workers-next",
    sessionName,
    "--server",
  ]);
  assert.equal(controlPlaneAdvanceWorkerNext.ok, true);
  assert.equal(controlPlaneAdvanceWorkerNext.session, sessionName);
  assert.equal(controlPlaneAdvanceWorkerNext.count, 1);
  assert.equal(controlPlaneAdvanceWorkerNext.actions.restart_control_plane_advance_worker, 1);
  assert.equal(controlPlaneAdvanceWorkerNext.nextSteps[0]?.workerId, "detached-smoke-control-plane-advance-worker");
  assert.equal(controlPlaneAdvanceWorkerNext.nextSteps[0]?.mode, "advance_loop");
  assert.equal(controlPlaneAdvanceWorkerNext.nextSteps[0]?.action, "restart_control_plane_advance_worker");
  assert.equal(controlPlaneAdvanceWorkerNext.nextSteps[0]?.reason, "stopped_control_plane_advance_worker");
  assert.equal(
    controlPlaneAdvanceWorkerNext.nextSteps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-advance-workers ${sessionName} --server --worker-id detached-smoke-control-plane-advance-worker`,
  );
  assert.equal(controlPlaneAdvanceWorkerNext.nextSteps[0]?.api.restart.method, "POST");
  assert.match(controlPlaneAdvanceWorkerNext.nextSteps[0]?.api.restart.url ?? "", /\/control-plane-advance-workers\/restart$/);
  assert.equal(controlPlaneAdvanceWorkerNext.nextSteps[0]?.api.restart.payload.workerId, "detached-smoke-control-plane-advance-worker");
  const controlPlaneStatusBeforeAdvanceWorkerRestart = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusBeforeAdvanceWorkerRestart.recovery.actions.restart_control_plane_advance_worker, 1);
  assert.equal(controlPlaneStatusBeforeAdvanceWorkerRestart.recovery.nextSteps.controlPlaneAdvanceWorkers[0]?.workerId, "detached-smoke-control-plane-advance-worker");
  assert.equal(controlPlaneStatusBeforeAdvanceWorkerRestart.recovery.nextSteps.controlPlaneAdvanceWorkers[0]?.mode, "advance_loop");
  assert.equal(controlPlaneStatusBeforeAdvanceWorkerRestart.recovery.nextSteps.controlPlaneAdvanceWorkers[0]?.action, "restart_control_plane_advance_worker");
  const restartedControlPlaneAdvanceWorker = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    restarted: Array<{ workerId: string; previousPid: number | null; pid: number | null; restartCount: number; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "restart-control-plane-advance-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-advance-worker",
  ]);
  assert.equal(restartedControlPlaneAdvanceWorker.ok, true);
  assert.equal(restartedControlPlaneAdvanceWorker.session, sessionName);
  assert.equal(restartedControlPlaneAdvanceWorker.count, 1);
  assert.equal(restartedControlPlaneAdvanceWorker.restarted[0]?.workerId, "detached-smoke-control-plane-advance-worker");
  assert.equal(restartedControlPlaneAdvanceWorker.restarted[0]?.restartCount, 1);
  assert.equal(
    restartedControlPlaneAdvanceWorker.restarted[0]?.command.join(" "),
    `runs session-control-plane-advance-loop ${sessionName} --server --max-steps 1 --interval-ms 0 --lines 20 --dry-run`,
  );
  const retiredControlPlaneAdvanceWorkers = await cliJson<typeof stoppedControlPlaneAdvanceWorkers>(baseUrl, [
    "runs",
    "stop-control-plane-advance-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-advance-worker",
    "--retire",
  ]);
  assert.equal(retiredControlPlaneAdvanceWorkers.ok, true);
  assert.equal(retiredControlPlaneAdvanceWorkers.count, 1);
  assert.ok(retiredControlPlaneAdvanceWorkers.stopped[0]?.retiredAt);
  const controlPlaneStatusAfterAdvanceWorker = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusAfterAdvanceWorker.workers.controlPlaneAdvance.total, 1);
  assert.equal(controlPlaneStatusAfterAdvanceWorker.workers.controlPlaneAdvance.retired, 1);
  assert.equal(controlPlaneStatusAfterAdvanceWorker.workers.controlPlaneAdvance.completed, 0);
  assert.equal(controlPlaneStatusAfterAdvanceWorker.workers.controlPlaneAdvance.modes.advance_loop.total, 1);
  assert.equal(controlPlaneStatusAfterAdvanceWorker.workers.controlPlaneAdvance.modes.advance_loop.retired, 1);
  assert.equal(controlPlaneStatusAfterAdvanceWorker.workers.controlPlaneAdvance.modes.confirmation_drain.total, 0);
  assert.ok(controlPlaneStatus.branches.nextSteps.some((step) => (
    step.runId === controlPlaneResumePlan.run.id
    && step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${controlPlaneResumePlan.run.id}`
    && step.agentId === agent.agent.id
    && step.objective === "detached session control plane branch recovery"
    && step.status === "stopped"
    && step.branchName === controlPlaneResumePlan.plan.branchName
    && step.resultCommit === null
    && step.workerId === "detached-smoke-worker-1"
    && step.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${controlPlaneResumePlan.run.id}`
    && step.commands.resumeBranchDryRun.join(" ") === `npm run cli -- runs resume-branch ${controlPlaneResumePlan.run.id} --dry-run`
    && step.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${controlPlaneResumePlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${controlPlaneResumePlan.run.id} --dir ./checkouts/${sessionName}-control-plane/${controlPlaneResumePlan.run.id}`
    && step.commands.reviewRun.join(" ") === `npm run cli -- runs review ${controlPlaneResumePlan.run.id} --checkout-dir ./checkouts/${sessionName}-control-plane/${controlPlaneResumePlan.run.id}`
    && step.commands.watchRun.join(" ") === `npm run cli -- runs watch ${controlPlaneResumePlan.run.id} --checkout-dir ./checkouts/${sessionName}-control-plane/${controlPlaneResumePlan.run.id}`
    && step.runningSandboxes.length === 0
  )));
  assert.ok(controlPlaneStatus.branches.nextSteps.some((step) => (
    step.runId === controlPlaneBlockedPlan.run.id
    && step.action === "inspect_run"
    && step.reason === "running_sandbox_present"
    && step.command.join(" ") === `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`
    && step.branchName === controlPlaneBlockedPlan.plan.branchName
    && step.commands.resumeBranch === null
    && step.runningSandboxes.length === 1
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
    ticks: Array<{
      tickId: string;
      status: string;
      dryRun: boolean;
      decision: {
        statusReason: string;
        plannedCount: number;
        executedCount: number;
        planned: Array<{ surface: string; action: string; command?: string[] }>;
        skipped: Array<{ surface: string; action: string; reason: string }>;
        notPlanned: Array<{ surface: string; reason: string; readyCount: number | null }>;
        before: { branchRecoveries: number | null; applyActions: number | null; drainContinuations: number | null };
      };
    }>;
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
  assert.equal(controlPlaneTicks.ticks[0]?.decision.statusReason, "dry_run");
  assert.equal(controlPlaneTicks.ticks[0]?.decision.plannedCount, 3);
  assert.equal(controlPlaneTicks.ticks[0]?.decision.executedCount, 0);
  assert.deepEqual(
    controlPlaneTicks.ticks[0]?.decision.planned.map((entry) => entry.surface),
    ["branch_recovery", "apply_action", "drain_continuation"],
  );
  assert.equal(controlPlaneTicks.ticks[0]?.decision.planned[0]?.action, "resume_next_branch");
  assert.equal(controlPlaneTicks.ticks[0]?.decision.planned[0]?.command?.join(" "), `npm run cli -- runs resume-session ${sessionName} --next`);
  assert.equal(controlPlaneTicks.ticks[0]?.decision.skipped.length, 3);
  assert.ok(controlPlaneTicks.ticks[0]?.decision.skipped.every((entry) => entry.reason === "dry_run"));
  assert.deepEqual(controlPlaneTicks.ticks[0]?.decision.notPlanned, []);
  assert.ok((controlPlaneTicks.ticks[0]?.decision.before.branchRecoveries ?? 0) >= 1);
  assert.ok((controlPlaneTicks.ticks[0]?.decision.before.applyActions ?? 0) >= 1);
  assert.ok((controlPlaneTicks.ticks[0]?.decision.before.drainContinuations ?? 0) >= 1);
  const controlPlaneStaleBranch = `threadbeat/runs/control-plane-stale-${Date.now().toString(36)}`;
  const controlPlaneStaleRun = await db.createAgentRun({
    agentId: agent.agent.id,
    objective: "detached session control plane stale running recovery",
    inputRef: "main",
    runBranch: controlPlaneStaleBranch,
  });
  const controlPlaneStaleClaim = await db.claimAgentRun(controlPlaneStaleRun.id, "detached-smoke-worker-1");
  assert.ok(controlPlaneStaleClaim);
  const controlPlaneStaleStatus = await cliJson<{
    ok?: true;
    session: string;
    staleRuns: {
      counts: { ready: number; staleRunningClaimWithoutRunningSandbox: number };
      actions: { recover_session_run: number };
      nextSteps: Array<{
        action: string;
        reason: string;
        agentId: string;
        runId: string;
        objective: string;
        status: string;
        branchName: string;
        workerId: string | null;
        command: string[];
        commands: {
          inspectRun: string[];
          recoverRun: string[] | null;
          recoverRunDryRun: string[];
          recoverSession: string[];
          recoverSessionDryRun: string[];
        };
        runningSandboxes: Array<{ id: string; providerSandboxId: string | null }>;
      }>;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStaleStatus.ok, true);
  assert.equal(controlPlaneStaleStatus.session, sessionName);
  assert.ok(controlPlaneStaleStatus.staleRuns.counts.ready >= 1);
  assert.equal(
    controlPlaneStaleStatus.staleRuns.counts.staleRunningClaimWithoutRunningSandbox,
    controlPlaneStaleStatus.staleRuns.counts.ready,
  );
  assert.equal(controlPlaneStaleStatus.staleRuns.actions.recover_session_run, controlPlaneStaleStatus.staleRuns.counts.ready);
  assert.ok(controlPlaneStaleStatus.staleRuns.nextSteps.some((step) => (
    step.runId === controlPlaneStaleRun.id
    && step.action === "recover_session_run"
    && step.reason === "stale_running_claim_without_running_sandbox"
    && step.agentId === agent.agent.id
    && step.objective === "detached session control plane stale running recovery"
    && step.status === "running"
    && step.branchName === controlPlaneStaleBranch
    && step.workerId === "detached-smoke-worker-1"
    && step.command.join(" ") === `npm run cli -- runs recover-session ${sessionName} --server --run ${controlPlaneStaleRun.id}`
    && step.commands.recoverRun?.join(" ") === `npm run cli -- runs recover-session ${sessionName} --server --run ${controlPlaneStaleRun.id}`
    && step.commands.recoverRunDryRun.join(" ") === `npm run cli -- runs recover-session ${sessionName} --server --run ${controlPlaneStaleRun.id} --dry-run`
    && step.commands.recoverSession.join(" ") === `npm run cli -- runs recover-session ${sessionName} --server`
    && step.commands.recoverSessionDryRun.join(" ") === `npm run cli -- runs recover-session ${sessionName} --server --dry-run`
    && step.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${controlPlaneStaleRun.id}`
    && step.runningSandboxes.length === 0
  )));
  const controlPlaneStaleTick = await cliJson<{
    ok?: true;
    session: string;
    dryRun: boolean;
    tick: { status: string; dryRun: boolean };
    planned: { branchRecovery: { action: string; runIds: string[]; command: string[] } | null };
    executed: {
      branchRecovery: {
        exitCode: number | null;
        output?: { recovered?: Array<{ runId: string; status: string; workerId: string | null }> };
      } | null;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-tick",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStaleTick.ok, true);
  assert.equal(controlPlaneStaleTick.session, sessionName);
  assert.equal(controlPlaneStaleTick.dryRun, false);
  assert.ok(["executed", "partial"].includes(controlPlaneStaleTick.tick.status));
  assert.equal(controlPlaneStaleTick.tick.dryRun, false);
  assert.equal(controlPlaneStaleTick.planned.branchRecovery?.action, "recover_stale_running_run");
  assert.deepEqual(controlPlaneStaleTick.planned.branchRecovery?.runIds, [controlPlaneStaleRun.id]);
  assert.equal(controlPlaneStaleTick.planned.branchRecovery?.command.join(" "), `npm run cli -- runs recover-session ${sessionName} --server --run ${controlPlaneStaleRun.id}`);
  assert.equal(controlPlaneStaleTick.executed.branchRecovery?.exitCode, 0);
  assert.ok(controlPlaneStaleTick.executed.branchRecovery?.output?.recovered?.some((run) => (
    run.runId === controlPlaneStaleRun.id
    && run.status === "planned"
    && run.workerId === null
  )));
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
  type ControlPlaneTickWorkerEnsureResponse = {
    ok?: true;
    session: string;
    action: string;
    reason: string;
    worker: {
      workerId: string;
      command: string[];
      pid: number | null;
      alive: boolean;
      restartCount?: number;
      lifecycle: { state: string; restartable: boolean; reason: string };
    };
    workers: Array<{ workerId: string; alive: boolean; lifecycle: { state: string; restartable: boolean; reason: string } }>;
  };
  const ensuredControlPlaneTickWorker = await cliJson<ControlPlaneTickWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-control-plane-tick-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-ensure-worker",
    "--dry-run",
    "--max-ticks",
    "20",
    "--interval-ms",
    "100",
    "--lines",
    "20",
  ]);
  assert.equal(ensuredControlPlaneTickWorker.ok, true);
  assert.equal(ensuredControlPlaneTickWorker.session, sessionName);
  assert.equal(ensuredControlPlaneTickWorker.action, "started");
  assert.equal(ensuredControlPlaneTickWorker.reason, "no_running_or_restartable_worker");
  assert.equal(ensuredControlPlaneTickWorker.worker.workerId, "detached-smoke-control-plane-ensure-worker");
  assert.equal(ensuredControlPlaneTickWorker.worker.alive, true);
  assert.equal(
    ensuredControlPlaneTickWorker.worker.command.join(" "),
    `runs session-control-plane-tick-loop ${sessionName} --server --max-ticks 20 --interval-ms 100 --lines 20 --dry-run`,
  );
  const ensuredExistingControlPlaneTickWorker = await cliJson<ControlPlaneTickWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-control-plane-tick-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-ensure-worker",
    "--dry-run",
    "--max-ticks",
    "20",
    "--interval-ms",
    "100",
    "--lines",
    "20",
  ]);
  assert.equal(ensuredExistingControlPlaneTickWorker.ok, true);
  assert.equal(ensuredExistingControlPlaneTickWorker.action, "existing");
  assert.equal(ensuredExistingControlPlaneTickWorker.reason, "running_worker_exists");
  assert.equal(ensuredExistingControlPlaneTickWorker.worker.workerId, "detached-smoke-control-plane-ensure-worker");
  assert.equal(ensuredExistingControlPlaneTickWorker.worker.alive, true);
  await cliJson(baseUrl, [
    "runs",
    "stop-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-ensure-worker",
  ]);
  const ensuredRestartedControlPlaneTickWorker = await cliJson<ControlPlaneTickWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-control-plane-tick-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-ensure-worker",
    "--dry-run",
    "--max-ticks",
    "20",
    "--interval-ms",
    "100",
    "--lines",
    "20",
  ]);
  assert.equal(ensuredRestartedControlPlaneTickWorker.ok, true);
  assert.equal(ensuredRestartedControlPlaneTickWorker.action, "restarted");
  assert.equal(ensuredRestartedControlPlaneTickWorker.reason, "restartable_worker_exists");
  assert.equal(ensuredRestartedControlPlaneTickWorker.worker.workerId, "detached-smoke-control-plane-ensure-worker");
  assert.equal(ensuredRestartedControlPlaneTickWorker.worker.restartCount, 1);
  await cliJson(baseUrl, [
    "runs",
    "stop-control-plane-tick-workers",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-control-plane-ensure-worker",
    "--retire",
  ]);
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
  assert.equal(controlPlaneStatusAfterTickWorker.workers.controlPlaneTick.total, 3);
  assert.equal(controlPlaneStatusAfterTickWorker.workers.controlPlaneTick.retired, 2);
  assert.equal(controlPlaneStatusAfterTickWorker.workers.controlPlaneTick.completed, 1);
  const controlPlaneTimeline = await cliJson<{
    ok?: true;
    session: string;
    count: number;
    counts: Record<string, number>;
    decisions: {
      count: number;
      statuses: Record<string, number>;
      statusReasons: Record<string, number>;
      plannedSurfaces: Record<string, number>;
      executedSurfaces: Record<string, number>;
      skippedSurfaces: Record<string, number>;
      notPlannedSurfaces: Record<string, number>;
      latest: Array<{
        tickId: string;
        status: string;
        statusReason: string;
        plannedCount: number;
        executedCount: number;
        plannedSurfaces: string[];
        executedSurfaces: string[];
        skippedSurfaces: string[];
        notPlannedSurfaces: string[];
      }>;
    };
    events: Array<{
      event: string;
      source: string;
      tickId?: string;
      advanceId?: string;
      workerId?: string;
      executionId?: string;
      applyId?: string;
      applyAction?: string;
      status?: string;
      exitCode?: number | null;
      state?: string;
      reason?: string;
      restartable?: boolean;
      dryRun?: boolean;
      selectedSurface?: string;
      selectedAction?: string;
      selectedCount?: number;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--limit",
    "120",
    "--lines",
    "5",
  ]);
  assert.equal(controlPlaneTimeline.ok, true);
  assert.equal(controlPlaneTimeline.session, sessionName);
  assert.ok(controlPlaneTimeline.count >= 5);
  assert.ok((controlPlaneTimeline.counts.tick_recorded ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.counts.advance_recorded ?? 0) >= 2);
  assert.ok(controlPlaneTimeline.events.some((event) => (
    event.source === "advance"
    && event.event === "advance_recorded"
    && event.status === "dry_run"
    && event.dryRun === true
    && typeof event.advanceId === "string"
    && typeof event.selectedSurface === "string"
    && typeof event.selectedAction === "string"
  )));
  assert.ok((controlPlaneTimeline.counts.worker_completed ?? 0) >= 1);
  assert.ok((controlPlaneTimeline.counts.worker_retired ?? 0) >= 1);
  assert.ok(controlPlaneTimeline.events.some((event) => (
    event.source === "control_plane_advance_worker"
    && event.event === "worker_restarted"
    && event.workerId === "detached-smoke-control-plane-advance-worker"
  )));
  assert.ok(controlPlaneTimeline.events.some((event) => (
    event.source === "control_plane_advance_worker"
    && event.event === "worker_retired"
    && event.workerId === "detached-smoke-control-plane-advance-worker"
    && event.state === "retired"
  )));
  assert.ok((controlPlaneTimeline.counts.apply_action_executed ?? 0) >= 1);
  assert.ok(controlPlaneTimeline.decisions.count >= 3);
  assert.ok((controlPlaneTimeline.decisions.statuses.dry_run ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.decisions.statusReasons.dry_run ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.decisions.plannedSurfaces.branch_recovery ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.decisions.plannedSurfaces.apply_action ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.decisions.plannedSurfaces.drain_continuation ?? 0) >= 2);
  assert.ok((controlPlaneTimeline.decisions.skippedSurfaces.branch_recovery ?? 0) >= 2);
  assert.ok(controlPlaneTimeline.decisions.latest.length <= 5);
  assert.ok(controlPlaneTimeline.decisions.latest.some((decision) => (
    decision.statusReason === "dry_run"
    && decision.plannedSurfaces.includes("branch_recovery")
    && decision.skippedSurfaces.includes("branch_recovery")
  )));
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
  const controlPlaneTimelineSummary = await cliJson<{
    ok?: true;
    session: string;
    events: {
      total: number;
      counts: Record<string, number>;
    };
    decisions: typeof controlPlaneTimeline.decisions;
    latestEvents: Array<{
      event: string;
      source: string;
      status?: string;
      dryRun?: boolean;
      selectedSurface?: string;
      selectedAction?: string;
      state?: string;
      reason?: string;
    }>;
    commands: { fullTimeline: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--summary",
    "--limit",
    "120",
    "--lines",
    "3",
  ]);
  assert.equal(controlPlaneTimelineSummary.ok, true);
  assert.equal(controlPlaneTimelineSummary.session, sessionName);
  assert.equal(controlPlaneTimelineSummary.events.total, controlPlaneTimeline.count);
  assert.equal(controlPlaneTimelineSummary.events.counts.tick_recorded, controlPlaneTimeline.counts.tick_recorded);
  assert.equal(controlPlaneTimelineSummary.events.counts.advance_recorded, controlPlaneTimeline.counts.advance_recorded);
  assert.equal(controlPlaneTimelineSummary.decisions.count, controlPlaneTimeline.decisions.count);
  assert.equal(controlPlaneTimelineSummary.decisions.statusReasons.dry_run, controlPlaneTimeline.decisions.statusReasons.dry_run);
  assert.equal(controlPlaneTimelineSummary.latestEvents.length, 3);
  assert.ok(controlPlaneTimelineSummary.latestEvents.every((event) => typeof event.event === "string" && typeof event.source === "string"));
  assert.equal(
    controlPlaneTimelineSummary.commands.fullTimeline.join(" "),
    `npm run cli -- runs session-control-plane-timeline ${sessionName} --server`,
  );
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
  const filteredBranchRecoveryTimeline = await cliJson<{
    ok?: true;
    session: string;
    filter: { sources: string[]; events: string[]; statuses: string[]; limit: number };
    count: number;
    counts: Record<string, number>;
    events: Array<{
      event: string;
      source: string;
      executionId?: string;
      status?: string;
      skippedRunIds?: string[];
      skippedReasons?: string[];
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--source",
    "branch_recovery_execution",
    "--event",
    "branch_recovery_executed",
    "--status",
    "noop",
    "--limit",
    "5",
  ]);
  assert.equal(filteredBranchRecoveryTimeline.ok, true);
  assert.deepEqual(filteredBranchRecoveryTimeline.filter.sources, ["branch_recovery_execution"]);
  assert.deepEqual(filteredBranchRecoveryTimeline.filter.events, ["branch_recovery_executed"]);
  assert.deepEqual(filteredBranchRecoveryTimeline.filter.statuses, ["noop"]);
  assert.equal(filteredBranchRecoveryTimeline.filter.limit, 5);
  assert.equal(filteredBranchRecoveryTimeline.counts.branch_recovery_executed, filteredBranchRecoveryTimeline.count);
  assert.ok(filteredBranchRecoveryTimeline.count >= 1);
  assert.ok(filteredBranchRecoveryTimeline.events.every((event) => (
    event.source === "branch_recovery_execution"
    && event.event === "branch_recovery_executed"
    && event.status === "noop"
  )));
  assert.ok(filteredBranchRecoveryTimeline.events.some((event) => (
    event.executionId === controlPlaneResumeBlocked.execution.executionId
    && event.skippedRunIds?.includes(controlPlaneBlockedPlan.run.id)
    && event.skippedReasons?.includes("running_sandbox_present")
  )));
  const failedApplyActionExecutionId = "detached-smoke-failed-apply-action";
  await writeApplyActionExecution(sessionName, failedApplyActionExecutionId, {
    status: "failed",
    applyId: "detached-session-api-backed-reset",
    source: "status",
    action: "inspect_drain_continuation_resets",
    command: [
      "npm", "run", "cli", "--", "runs", "session-applies", sessionName, "--server", "--action-queue", "--execute-next",
      "--apply-id", "detached-session-api-backed-reset", "--apply-action", "inspect_drain_continuation_resets",
    ],
    exitCode: 1,
    stderr: "detached smoke failed apply action probe",
  });
  const failedDrainAlertContinuationId = "detached-smoke-alert-failed-drain";
  await writeDrainContinuation(sessionName, failedDrainAlertContinuationId, {
    status: "failed",
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    completedAt: new Date().toISOString(),
    error: "detached smoke failed drain alert probe",
    continueDrains: { dryRun: false, selected: 1, succeeded: 0, failed: 1 },
    drains: [{
      prefix: "detached-smoke-alert-failed-drain",
      nextApplyId: "detached-smoke-alert-failed-drain-002",
      command: ["npm", "run", "cli", "--", "runs", "session-apply", sessionName, "--source", "watch"],
      exitCode: 1,
      stderr: "detached smoke failed drain alert probe",
    }],
  });
  const controlPlaneAlerts = await cliJson<{
    ok?: true;
    session: string;
    limit: number;
    filter: {
      severities: string[];
      surfaces: string[];
      reasons: string[];
      runIds: string[];
      workerIds: string[];
      applyIds: string[];
      executionIds: string[];
      actions: string[];
      totalAlerts: number;
      visibleAlerts: number;
      hasMore: boolean;
    };
    summary: { total: number; errors: number; warnings: number };
    alerts: Array<{
      surface: string;
      severity: string;
      reason: string;
      count: number;
      runId?: string;
      applyId?: string;
      executionId?: string;
      action?: string;
      command: string[];
    }>;
    recentTimeline: {
      count: number;
      counts: Record<string, number>;
      events: Array<{ event: string; source: string; status?: string; skippedRunIds?: string[] }>;
    };
    commands: { fullStatus: string[]; timelineFailures: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--limit",
    "10",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneAlerts.ok, true);
  assert.equal(controlPlaneAlerts.session, sessionName);
  assert.equal(controlPlaneAlerts.limit, 10);
  assert.deepEqual(controlPlaneAlerts.filter.severities, []);
  assert.deepEqual(controlPlaneAlerts.filter.surfaces, []);
  assert.deepEqual(controlPlaneAlerts.filter.reasons, []);
  assert.deepEqual(controlPlaneAlerts.filter.runIds, []);
  assert.deepEqual(controlPlaneAlerts.filter.workerIds, []);
  assert.deepEqual(controlPlaneAlerts.filter.applyIds, []);
  assert.deepEqual(controlPlaneAlerts.filter.executionIds, []);
  assert.deepEqual(controlPlaneAlerts.filter.actions, []);
  assert.equal(controlPlaneAlerts.filter.visibleAlerts, controlPlaneAlerts.alerts.length);
  assert.ok(controlPlaneAlerts.summary.total > 0);
  assert.equal(controlPlaneAlerts.summary.total, controlPlaneAlerts.alerts.length);
  assert.ok(controlPlaneAlerts.summary.errors > 0);
  assert.ok(controlPlaneAlerts.summary.warnings > 0);
  assert.ok(controlPlaneAlerts.alerts.some((alert) => (
    alert.surface === "apply_action"
    && alert.reason === "failed_apply_action_execution"
    && alert.applyId === "detached-session-api-backed-reset"
    && alert.executionId === failedApplyActionExecutionId
  )));
  assert.ok(controlPlaneAlerts.alerts.some((alert) => (
    alert.surface === "drain_continuation"
    && alert.reason === "failed_drain_continuations"
    && alert.action === "inspect_failed_drain_continuations"
  )));
  assert.ok(controlPlaneAlerts.alerts.some((alert) => (
    alert.surface === "branch"
    && alert.reason === "running_sandbox_present"
    && alert.runId === controlPlaneBlockedPlan.run.id
    && alert.command.join(" ") === `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`
  )));
  assert.ok(controlPlaneAlerts.recentTimeline.events.some((event) => (
    event.source === "branch_recovery_execution"
    && event.event === "branch_recovery_executed"
    && event.status === "noop"
    && event.skippedRunIds?.includes(controlPlaneBlockedPlan.run.id)
  )));
  assert.equal(
    controlPlaneAlerts.commands.fullStatus.join(" "),
    `npm run cli -- runs session-control-plane-status ${sessionName} --server`,
  );
  assert.equal(
    controlPlaneAlerts.commands.timelineFailures.join(" "),
    `npm run cli -- runs session-control-plane-timeline ${sessionName} --server --status failed,noop`,
  );
  const filteredBranchAlerts = await cliJson<typeof controlPlaneAlerts>(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--severity",
    "warning",
    "--surface",
    "branch",
    "--reason",
    "running_sandbox_present",
    "--run",
    controlPlaneBlockedPlan.run.id,
    "--action",
    "inspect_run",
    "--limit",
    "5",
    "--lines",
    "20",
  ]);
  assert.deepEqual(filteredBranchAlerts.filter.severities, ["warning"]);
  assert.deepEqual(filteredBranchAlerts.filter.surfaces, ["branch"]);
  assert.deepEqual(filteredBranchAlerts.filter.reasons, ["running_sandbox_present"]);
  assert.deepEqual(filteredBranchAlerts.filter.runIds, [controlPlaneBlockedPlan.run.id]);
  assert.deepEqual(filteredBranchAlerts.filter.actions, ["inspect_run"]);
  assert.equal(filteredBranchAlerts.limit, 5);
  assert.ok(filteredBranchAlerts.summary.total > 0);
  assert.ok(filteredBranchAlerts.alerts.every((alert) => (
    alert.severity === "warning"
    && alert.surface === "branch"
    && alert.reason === "running_sandbox_present"
    && alert.runId === controlPlaneBlockedPlan.run.id
    && alert.action === "inspect_run"
  )));
  assert.ok(filteredBranchAlerts.alerts.some((alert) => alert.runId === controlPlaneBlockedPlan.run.id));
  type ControlPlaneAlertPreviewResponse = {
    ok?: true;
    session: string;
    filter: typeof controlPlaneAlerts.filter;
    matchCount: number;
    alert: typeof controlPlaneAlerts.alerts[number] | null;
    preview: { command: string[]; fullStatus: string[]; timelineFailures: string[] } | null;
    details: ({
      kind: "run_resume_inspection";
      inspection: {
        run: { id: string; status: string; resultCommit: string | null; workerId: string | null };
        recovery: { ready: boolean; reason: string; runningSandboxes: Array<{ id: string; providerSandboxId: string | null }> };
        links: { branchTreeUrl: string | null };
        nextStep: { action: string; reason: string; command: string[] };
      };
    } | {
      kind: "apply_action_execution";
      execution: {
        executionId: string;
        applyId: string;
        action: string;
        status: string;
        exitCode: number | null;
        stderr?: string;
      };
      commands: {
        inspectApply: string[];
        inspectApplyActionExecutions: string[];
        executeAction: string[];
        acknowledgeResetAudit?: string[];
      };
    } | {
      kind: "drain_continuations";
      status: "failed";
      totalFailed: number;
      continuations: Array<{ continuationId: string; status?: string; error?: string }>;
      commands: { inspectFailed: string[]; resetFailed: string[]; resetSelectedFailed: string[] | null };
    }) | null;
    recentTimeline: typeof controlPlaneAlerts.recentTimeline;
  };
  const applyActionAlertPreview = await cliJson<ControlPlaneAlertPreviewResponse>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "apply_action",
    "--reason",
    "failed_apply_action_execution",
    "--apply",
    "detached-session-api-backed-reset",
    "--execution",
    failedApplyActionExecutionId,
    "--action",
    "inspect_drain_continuation_resets",
    "--lines",
    "20",
  ]);
  assert.equal(applyActionAlertPreview.alert?.surface, "apply_action");
  assert.equal(applyActionAlertPreview.alert?.executionId, failedApplyActionExecutionId);
  const applyActionAlertDetails = applyActionAlertPreview.details;
  assert.equal(applyActionAlertDetails?.kind, "apply_action_execution");
  if (!applyActionAlertDetails || applyActionAlertDetails.kind !== "apply_action_execution") {
    throw new Error("expected apply action alert execution details");
  }
  assert.equal(applyActionAlertDetails.execution.executionId, failedApplyActionExecutionId);
  assert.equal(applyActionAlertDetails.execution.status, "failed");
  assert.equal(applyActionAlertDetails.execution.exitCode, 1);
  assert.equal(
    applyActionAlertDetails.commands.inspectApply.join(" "),
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset`,
  );
  assert.equal(
    applyActionAlertDetails.commands.executeAction.join(" "),
    `npm run cli -- runs session-applies ${sessionName} --server --action-queue --execute-next --apply-id detached-session-api-backed-reset --apply-action inspect_drain_continuation_resets`,
  );
  assert.equal(
    applyActionAlertDetails.commands.acknowledgeResetAudit?.join(" "),
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset --ack-reset-audit`,
  );
  const applyActionAlertCommands = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "apply_action",
    "--reason",
    "failed_apply_action_execution",
    "--apply",
    "detached-session-api-backed-reset",
    "--execution",
    failedApplyActionExecutionId,
    "--action",
    "inspect_drain_continuation_resets",
    "--commands-only",
    "--format",
    "shell",
  ]);
  const applyActionAlertCommandLines = applyActionAlertCommands.split("\n").filter(Boolean);
  assert.ok(applyActionAlertCommandLines.includes(
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset`,
  ));
  assert.ok(applyActionAlertCommandLines.includes(
    `npm run cli -- runs session-applies ${sessionName} --server --action-queue --execute-next --apply-id detached-session-api-backed-reset --apply-action inspect_drain_continuation_resets`,
  ));
  assert.ok(applyActionAlertCommandLines.includes(
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset --ack-reset-audit`,
  ));
  const applyActionAlertDetailExecute = await cliJson<{
    ok: true;
    session: string;
    dryRun: boolean;
    detailCommand: string;
    advanceId: string;
    advancePath: string;
    selected: {
      surface: string;
      action: string;
      reason: string;
      count: number;
      command: string[];
      detailCommand?: string;
      applyId?: string;
      executionId?: string;
    } | null;
    alert: ControlPlaneAlertPreviewResponse["alert"];
    executed: { command: string[]; exitCode: number | null; stdout?: string; stderr?: string } | null;
    executionSafety: {
      blocked: boolean;
      mutating: boolean;
      confirmationRequired: boolean;
      confirmed: boolean;
      reason: string | null;
      confirmationCommand: string[] | null;
    };
    filter: ControlPlaneAlertPreviewResponse["filter"];
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "apply_action",
    "--reason",
    "failed_apply_action_execution",
    "--apply",
    "detached-session-api-backed-reset",
    "--execution",
    failedApplyActionExecutionId,
    "--action",
    "inspect_drain_continuation_resets",
    "--detail-command",
    "inspect_apply",
    "--lines",
    "20",
  ]);
  assert.equal(applyActionAlertDetailExecute.ok, true);
  assert.equal(applyActionAlertDetailExecute.session, sessionName);
  assert.equal(applyActionAlertDetailExecute.dryRun, false);
  assert.equal(applyActionAlertDetailExecute.detailCommand, "inspect_apply");
  assert.equal(applyActionAlertDetailExecute.executionSafety.blocked, false);
  assert.equal(applyActionAlertDetailExecute.executionSafety.mutating, false);
  assert.match(applyActionAlertDetailExecute.advancePath, /control-plane-advances/);
  assert.equal(applyActionAlertDetailExecute.selected?.surface, "apply_action");
  assert.equal(applyActionAlertDetailExecute.selected?.action, "inspect_apply");
  assert.equal(applyActionAlertDetailExecute.selected?.detailCommand, "inspect_apply");
  assert.equal(applyActionAlertDetailExecute.selected?.applyId, "detached-session-api-backed-reset");
  assert.equal(applyActionAlertDetailExecute.selected?.executionId, failedApplyActionExecutionId);
  assert.equal(
    applyActionAlertDetailExecute.selected?.command.join(" "),
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset`,
  );
  assert.equal(
    applyActionAlertDetailExecute.executed?.command.join(" "),
    `npm run cli -- runs session-applies ${sessionName} --server --apply-id detached-session-api-backed-reset`,
  );
  assert.equal(applyActionAlertDetailExecute.executed?.exitCode, 0);
  assert.deepEqual(applyActionAlertDetailExecute.filter.applyIds, ["detached-session-api-backed-reset"]);
  const applyActionAlertMutatingDetailBlocked = await cliJson<{
    ok: true;
    session: string;
    dryRun: boolean;
    detailCommand: string;
    selected: {
      surface: string;
      action: string;
      command: string[];
      detailCommand?: string;
      applyId?: string;
      executionId?: string;
    } | null;
    executed: { command: string[]; exitCode: number | null } | null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmationRequired: boolean; confirmed: boolean; reason: string | null; confirmationCommand: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "apply_action",
    "--reason",
    "failed_apply_action_execution",
    "--apply",
    "detached-session-api-backed-reset",
    "--execution",
    failedApplyActionExecutionId,
    "--action",
    "inspect_drain_continuation_resets",
    "--detail-command",
    "execute_apply_action",
    "--lines",
    "20",
  ]);
  assert.equal(applyActionAlertMutatingDetailBlocked.ok, true);
  assert.equal(applyActionAlertMutatingDetailBlocked.session, sessionName);
  assert.equal(applyActionAlertMutatingDetailBlocked.dryRun, false);
  assert.equal(applyActionAlertMutatingDetailBlocked.detailCommand, "execute_apply_action");
  assert.equal(applyActionAlertMutatingDetailBlocked.selected?.action, "execute_apply_action");
  assert.equal(applyActionAlertMutatingDetailBlocked.selected?.detailCommand, "execute_apply_action");
  assert.equal(
    applyActionAlertMutatingDetailBlocked.selected?.command.join(" "),
    `npm run cli -- runs session-applies ${sessionName} --server --action-queue --execute-next --apply-id detached-session-api-backed-reset --apply-action inspect_drain_continuation_resets`,
  );
  assert.equal(applyActionAlertMutatingDetailBlocked.executed, null);
  assert.equal(applyActionAlertMutatingDetailBlocked.executionSafety.blocked, true);
  assert.equal(applyActionAlertMutatingDetailBlocked.executionSafety.mutating, true);
  assert.equal(applyActionAlertMutatingDetailBlocked.executionSafety.confirmationRequired, true);
  assert.equal(applyActionAlertMutatingDetailBlocked.executionSafety.confirmed, false);
  assert.equal(applyActionAlertMutatingDetailBlocked.executionSafety.reason, "mutating detail command requires confirm=true");
  assert.equal(
    applyActionAlertMutatingDetailBlocked.executionSafety.confirmationCommand?.join(" "),
    `npm run cli -- runs session-control-plane-alert-execute ${sessionName} --server --severity error --surface apply_action --reason failed_apply_action_execution --apply detached-session-api-backed-reset --execution ${failedApplyActionExecutionId} --action inspect_drain_continuation_resets --detail-command execute_apply_action --confirm --lines 20`,
  );
  const applyActionAlertMutatingDetailConfirmedDryRun = await cliJson<{
    ok: true;
    session: string;
    dryRun: boolean;
    detailCommand: string;
    selected: { action: string; detailCommand?: string } | null;
    executed: null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmationRequired: boolean; confirmed: boolean; reason: string | null; confirmationCommand: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "apply_action",
    "--reason",
    "failed_apply_action_execution",
    "--apply",
    "detached-session-api-backed-reset",
    "--execution",
    failedApplyActionExecutionId,
    "--action",
    "inspect_drain_continuation_resets",
    "--detail-command",
    "execute_apply_action",
    "--dry-run",
    "--confirm",
    "--lines",
    "20",
  ]);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.ok, true);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.session, sessionName);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.dryRun, true);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.detailCommand, "execute_apply_action");
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.selected?.action, "execute_apply_action");
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.selected?.detailCommand, "execute_apply_action");
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executed, null);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executionSafety.blocked, false);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executionSafety.mutating, true);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executionSafety.confirmationRequired, true);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executionSafety.confirmed, true);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executionSafety.reason, null);
  assert.equal(applyActionAlertMutatingDetailConfirmedDryRun.executionSafety.confirmationCommand, null);
  const blockedMutatingControlPlaneAdvances = await cliJson<{
    ok: true;
    session: string;
    filter: { limit: number; blocked: boolean | null; mutating: boolean | null };
    count: number;
    summary: { blocked: number; mutating: number; executed: number };
    advances: Array<{
      advanceId: string;
      executed: null;
      executionSafety?: { blocked: boolean; mutating: boolean; reason: string | null; confirmationCommand: string[] | null };
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--blocked",
    "--mutating",
    "--limit",
    "5",
  ]);
  assert.equal(blockedMutatingControlPlaneAdvances.ok, true);
  assert.equal(blockedMutatingControlPlaneAdvances.session, sessionName);
  assert.equal(blockedMutatingControlPlaneAdvances.filter.blocked, true);
  assert.equal(blockedMutatingControlPlaneAdvances.filter.mutating, true);
  assert.ok(blockedMutatingControlPlaneAdvances.count >= 1);
  assert.equal(blockedMutatingControlPlaneAdvances.summary.blocked, blockedMutatingControlPlaneAdvances.count);
  assert.equal(blockedMutatingControlPlaneAdvances.summary.mutating, blockedMutatingControlPlaneAdvances.count);
  assert.equal(blockedMutatingControlPlaneAdvances.summary.executed, 0);
  assert.ok(blockedMutatingControlPlaneAdvances.advances.every((advance) => advance.executed === null));
  assert.ok(blockedMutatingControlPlaneAdvances.advances.every((advance) => advance.executionSafety?.blocked === true));
  assert.ok(blockedMutatingControlPlaneAdvances.advances.every((advance) => advance.executionSafety?.mutating === true));
  assert.ok(blockedMutatingControlPlaneAdvances.advances.every((advance) => advance.executionSafety?.confirmationCommand?.includes("--confirm")));
  const blockedMutatingControlPlaneAdvanceCommands = await cliText(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--blocked",
    "--mutating",
    "--commands-only",
    "--format",
    "shell",
    "--limit",
    "5",
  ]);
  const blockedMutatingControlPlaneAdvanceCommandLines = blockedMutatingControlPlaneAdvanceCommands.trim().split("\n").filter(Boolean);
  assert.ok(blockedMutatingControlPlaneAdvanceCommandLines.length >= 1);
  assert.ok(blockedMutatingControlPlaneAdvanceCommandLines.every((line) => line.includes("session-control-plane-alert-execute")));
  assert.ok(blockedMutatingControlPlaneAdvanceCommandLines.every((line) => line.includes("--confirm")));
  assert.ok(blockedMutatingControlPlaneAdvanceCommandLines.some((line) => line.includes(`--execution ${failedApplyActionExecutionId}`)));
  const blockedMutatingControlPlaneAdvanceConfirmationQueue = await cliJson<{
    ok: true;
    session: string;
    filter: { blocked: boolean | null; mutating: boolean | null };
    confirmationQueue: {
      summary: { advances: number; groups: number; commands: number };
      groups: Array<{
        surface: string | null;
        action: string | null;
        detailCommand: string | null;
        reason: string | null;
        count: number;
        commandCount: number;
        applyIds: string[];
        executionIds: string[];
        commands: Array<{ command: string[] }>;
      }>;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--confirmation-queue",
    "--limit",
    "5",
  ]);
  assert.equal(blockedMutatingControlPlaneAdvanceConfirmationQueue.ok, true);
  assert.equal(blockedMutatingControlPlaneAdvanceConfirmationQueue.session, sessionName);
  assert.equal(blockedMutatingControlPlaneAdvanceConfirmationQueue.filter.blocked, true);
  assert.equal(blockedMutatingControlPlaneAdvanceConfirmationQueue.filter.mutating, true);
  assert.ok(blockedMutatingControlPlaneAdvanceConfirmationQueue.confirmationQueue.summary.advances >= 1);
  assert.ok(blockedMutatingControlPlaneAdvanceConfirmationQueue.confirmationQueue.summary.groups >= 1);
  assert.ok(blockedMutatingControlPlaneAdvanceConfirmationQueue.confirmationQueue.summary.commands >= 1);
  const applyActionConfirmationGroup = blockedMutatingControlPlaneAdvanceConfirmationQueue.confirmationQueue.groups.find((group) => (
    group.surface === "apply_action"
    && group.action === "execute_apply_action"
    && group.detailCommand === "execute_apply_action"
  ));
  assert.ok(applyActionConfirmationGroup);
  assert.equal(applyActionConfirmationGroup.reason, "mutating detail command requires confirm=true");
  assert.ok(applyActionConfirmationGroup.count >= 1);
  assert.ok(applyActionConfirmationGroup.commandCount >= 1);
  assert.ok(applyActionConfirmationGroup.applyIds.includes("detached-session-api-backed-reset"));
  assert.ok(applyActionConfirmationGroup.executionIds.includes(failedApplyActionExecutionId));
  assert.ok(applyActionConfirmationGroup.commands.every((item) => item.command.includes("--confirm")));
  const executedBlockedConfirmationDryRun = await cliJson<{
    ok: true;
    session: string;
    sourceAdvanceId: string;
    dryRun: boolean;
    detailCommand: string;
    selected: { action: string; detailCommand?: string } | null;
    executed: null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmationRequired: boolean; confirmed: boolean; reason: string | null; confirmationCommand: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--execute-confirmation",
    "--advance-id",
    blockedMutatingControlPlaneAdvances.advances[0]?.advanceId ?? "",
    "--confirm",
    "--dry-run",
  ]);
  assert.equal(executedBlockedConfirmationDryRun.ok, true);
  assert.equal(executedBlockedConfirmationDryRun.session, sessionName);
  assert.equal(executedBlockedConfirmationDryRun.sourceAdvanceId, blockedMutatingControlPlaneAdvances.advances[0]?.advanceId);
  assert.equal(executedBlockedConfirmationDryRun.dryRun, true);
  assert.equal(executedBlockedConfirmationDryRun.detailCommand, "execute_apply_action");
  assert.equal(executedBlockedConfirmationDryRun.selected?.action, "execute_apply_action");
  assert.equal(executedBlockedConfirmationDryRun.selected?.detailCommand, "execute_apply_action");
  assert.equal(executedBlockedConfirmationDryRun.executed, null);
  assert.equal(executedBlockedConfirmationDryRun.executionSafety.blocked, false);
  assert.equal(executedBlockedConfirmationDryRun.executionSafety.mutating, true);
  assert.equal(executedBlockedConfirmationDryRun.executionSafety.confirmationRequired, true);
  assert.equal(executedBlockedConfirmationDryRun.executionSafety.confirmed, true);
  assert.equal(executedBlockedConfirmationDryRun.executionSafety.reason, null);
  assert.equal(executedBlockedConfirmationDryRun.executionSafety.confirmationCommand, null);
  const executedNextBlockedConfirmationDryRun = await cliJson<{
    ok: true;
    session: string;
    sourceAdvanceId: string;
    dryRun: boolean;
    detailCommand: string;
    selected: { action: string; detailCommand?: string } | null;
    executed: null;
    executionSafety: { blocked: boolean; mutating: boolean; confirmationRequired: boolean; confirmed: boolean; reason: string | null; confirmationCommand: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--execute-next-confirmation",
    "--confirm",
    "--dry-run",
  ]);
  assert.equal(executedNextBlockedConfirmationDryRun.ok, true);
  assert.equal(executedNextBlockedConfirmationDryRun.session, sessionName);
  assert.equal(executedNextBlockedConfirmationDryRun.sourceAdvanceId, blockedMutatingControlPlaneAdvances.advances[0]?.advanceId);
  assert.equal(executedNextBlockedConfirmationDryRun.dryRun, true);
  assert.equal(executedNextBlockedConfirmationDryRun.detailCommand, "execute_apply_action");
  assert.equal(executedNextBlockedConfirmationDryRun.selected?.action, "execute_apply_action");
  assert.equal(executedNextBlockedConfirmationDryRun.selected?.detailCommand, "execute_apply_action");
  assert.equal(executedNextBlockedConfirmationDryRun.executed, null);
  assert.equal(executedNextBlockedConfirmationDryRun.executionSafety.blocked, false);
  assert.equal(executedNextBlockedConfirmationDryRun.executionSafety.mutating, true);
  assert.equal(executedNextBlockedConfirmationDryRun.executionSafety.confirmationRequired, true);
  assert.equal(executedNextBlockedConfirmationDryRun.executionSafety.confirmed, true);
  assert.equal(executedNextBlockedConfirmationDryRun.executionSafety.reason, null);
  assert.equal(executedNextBlockedConfirmationDryRun.executionSafety.confirmationCommand, null);
  const drainedBlockedConfirmationsDryRun = await cliJson<{
    ok: true;
    session: string;
    dryRun: boolean;
    maxConfirmations: number;
    availableConfirmations: number;
    attemptedConfirmations: number;
    stoppedReason: "empty" | "drained" | "failed" | "max_confirmations";
    results: Array<{
      sourceAdvanceId: string;
      dryRun: boolean;
      detailCommand: string;
      selected: { action: string; detailCommand?: string } | null;
      executed: null;
      executionSafety: { blocked: boolean; mutating: boolean; confirmationRequired: boolean; confirmed: boolean; reason: string | null; confirmationCommand: string[] | null };
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--drain-confirmations",
    "--max-confirmations",
    "1",
    "--confirm",
    "--dry-run",
  ]);
  assert.equal(drainedBlockedConfirmationsDryRun.ok, true);
  assert.equal(drainedBlockedConfirmationsDryRun.session, sessionName);
  assert.equal(drainedBlockedConfirmationsDryRun.dryRun, true);
  assert.equal(drainedBlockedConfirmationsDryRun.maxConfirmations, 1);
  assert.ok(drainedBlockedConfirmationsDryRun.availableConfirmations >= 1);
  assert.equal(drainedBlockedConfirmationsDryRun.attemptedConfirmations, 1);
  assert.ok(["drained", "max_confirmations"].includes(drainedBlockedConfirmationsDryRun.stoppedReason));
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.sourceAdvanceId, blockedMutatingControlPlaneAdvances.advances[0]?.advanceId);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.dryRun, true);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.detailCommand, "execute_apply_action");
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.selected?.action, "execute_apply_action");
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.selected?.detailCommand, "execute_apply_action");
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executed, null);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executionSafety.blocked, false);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executionSafety.mutating, true);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executionSafety.confirmationRequired, true);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executionSafety.confirmed, true);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executionSafety.reason, null);
  assert.equal(drainedBlockedConfirmationsDryRun.results[0]?.executionSafety.confirmationCommand, null);
  const drainedBlockedConfirmationsUntilEmptyDryRun = await cliJson<{
    ok: true;
    session: string;
    dryRun: boolean;
    untilEmpty: boolean;
    maxSteps: number;
    intervalMs: number;
    maxConfirmations: number;
    executedSteps: number;
    stoppedReason: "empty" | "dry_run" | "failed" | "max_steps";
    attemptedConfirmations: number;
    cycles: Array<{
      stoppedReason: "empty" | "drained" | "failed" | "max_confirmations";
      attemptedConfirmations: number;
      results: Array<{ sourceAdvanceId: string; dryRun: boolean }>;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--drain-confirmations",
    "--max-confirmations",
    "1",
    "--confirm",
    "--until-empty",
    "--max-steps",
    "2",
    "--interval-ms",
    "0",
    "--dry-run",
  ]);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.ok, true);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.session, sessionName);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.dryRun, true);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.untilEmpty, true);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.maxSteps, 2);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.intervalMs, 0);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.maxConfirmations, 1);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.executedSteps, 1);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.stoppedReason, "dry_run");
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.attemptedConfirmations, 1);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.cycles[0]?.results[0]?.sourceAdvanceId, blockedMutatingControlPlaneAdvances.advances[0]?.advanceId);
  assert.equal(drainedBlockedConfirmationsUntilEmptyDryRun.cycles[0]?.results[0]?.dryRun, true);
  const confirmationDrainWorker = await cliJson<{
    ok?: true;
    session: string;
    worker: {
      workerId: string;
      mode: "confirmation_drain";
      command: string[];
      pid: number | null;
      stdoutPath: string;
      stderrPath: string;
    };
  }>(baseUrl, [
    "runs",
    "start-control-plane-advance-worker",
    sessionName,
    "--server",
    "--worker-id",
    "detached-smoke-confirmation-drain-worker",
    "--drain-confirmations",
    "--confirm",
    "--max-confirmations",
    "1",
    "--until-empty",
    "--max-steps",
    "2",
    "--interval-ms",
    "0",
    "--dry-run",
  ]);
  assert.equal(confirmationDrainWorker.ok, true);
  assert.equal(confirmationDrainWorker.session, sessionName);
  assert.equal(confirmationDrainWorker.worker.workerId, "detached-smoke-confirmation-drain-worker");
  assert.equal(confirmationDrainWorker.worker.mode, "confirmation_drain");
  assert.equal(
    confirmationDrainWorker.worker.command.join(" "),
    `runs session-control-plane-advances ${sessionName} --server --drain-confirmations --confirm --max-confirmations 1 --until-empty --max-steps 2 --interval-ms 0 --dry-run`,
  );
  assert.match(confirmationDrainWorker.worker.stdoutPath, /control-plane-advance-workers/);
  assert.match(confirmationDrainWorker.worker.stderrPath, /control-plane-advance-workers/);
  type ConfirmationDrainWorkerListResponse = {
    ok?: true;
    session: string;
    count: number;
    workers: Array<{
      workerId: string;
      mode: "confirmation_drain";
      alive: boolean;
      completedAt?: string;
      completionResult?: { exitCode: number | null; signal: string | null };
      lifecycle: { state: string; restartable: boolean; reason: string };
      stdout: { lines: string[] };
    }>;
  };
  let completedConfirmationDrainWorkers: ConfirmationDrainWorkerListResponse | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    completedConfirmationDrainWorkers = await cliJson<ConfirmationDrainWorkerListResponse>(baseUrl, [
      "runs",
      "session-control-plane-advance-workers",
      sessionName,
      "--server",
      "--worker-id",
      "detached-smoke-confirmation-drain-worker",
      "--lines",
      "80",
    ]);
    if (completedConfirmationDrainWorkers?.workers[0]?.completedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(completedConfirmationDrainWorkers?.ok, true);
  assert.equal(completedConfirmationDrainWorkers?.count, 1);
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.workerId, "detached-smoke-confirmation-drain-worker");
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.mode, "confirmation_drain");
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.alive, false);
  assert.ok(completedConfirmationDrainWorkers?.workers[0]?.completedAt);
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.completionResult?.exitCode, 0);
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.lifecycle.state, "completed");
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.lifecycle.restartable, false);
  assert.equal(completedConfirmationDrainWorkers?.workers[0]?.lifecycle.reason, "worker_completed");
  const confirmationDrainWorkerOutput = completedConfirmationDrainWorkers?.workers[0]?.stdout.lines.join("\n") ?? "";
  assert.match(confirmationDrainWorkerOutput, /"sourceAdvanceId":/);
  assert.match(confirmationDrainWorkerOutput, /"confirmed": true/);
  const controlPlaneStatusAfterConfirmationDrainWorker = await cliJson<typeof controlPlaneStatus>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.total, 2);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.retired, 1);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.completed, 1);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.modes.advance_loop.total, 1);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.modes.advance_loop.retired, 1);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.modes.confirmation_drain.total, 1);
  assert.equal(controlPlaneStatusAfterConfirmationDrainWorker.workers.controlPlaneAdvance.modes.confirmation_drain.completed, 1);
  const drainContinuationAlertPreview = await cliJson<ControlPlaneAlertPreviewResponse>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "drain_continuation",
    "--reason",
    "failed_drain_continuations",
    "--action",
    "inspect_failed_drain_continuations",
    "--lines",
    "20",
  ]);
  assert.equal(drainContinuationAlertPreview.alert?.surface, "drain_continuation");
  const drainContinuationAlertDetails = drainContinuationAlertPreview.details;
  assert.equal(drainContinuationAlertDetails?.kind, "drain_continuations");
  if (!drainContinuationAlertDetails || drainContinuationAlertDetails.kind !== "drain_continuations") {
    throw new Error("expected drain continuation alert details");
  }
  assert.equal(drainContinuationAlertDetails.totalFailed, drainContinuationAlertPreview.alert?.count);
  assert.ok(drainContinuationAlertDetails.continuations.some((continuation) => (
    continuation.continuationId === failedDrainAlertContinuationId
    && continuation.status === "failed"
  )));
  assert.equal(
    drainContinuationAlertDetails.commands.resetFailed.join(" "),
    `npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed`,
  );
  const drainContinuationResetSelectedFailed = drainContinuationAlertDetails.commands.resetSelectedFailed?.join(" ") ?? "";
  assert.ok(drainContinuationResetSelectedFailed.startsWith(
    `npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed --continuation `,
  ));
  assert.ok(drainContinuationResetSelectedFailed.includes(failedDrainAlertContinuationId));
  const drainContinuationAlertCommands = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--severity",
    "error",
    "--surface",
    "drain_continuation",
    "--reason",
    "failed_drain_continuations",
    "--action",
    "inspect_failed_drain_continuations",
    "--commands-only",
    "--format",
    "shell",
  ]);
  const drainContinuationAlertCommandLines = drainContinuationAlertCommands.split("\n").filter(Boolean);
  assert.ok(drainContinuationAlertCommandLines.includes(
    `npm run cli -- runs session-drain-continuations ${sessionName} --status failed`,
  ));
  assert.ok(drainContinuationAlertCommandLines.includes(
    `npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed`,
  ));
  assert.ok(drainContinuationAlertCommandLines.some((line) => (
    line.startsWith(`npm run cli -- runs session-drain-continuations ${sessionName} --reset-failed --continuation `)
    && line.includes(failedDrainAlertContinuationId)
  )));
  const controlPlaneAlertPreview = await cliJson<ControlPlaneAlertPreviewResponse>(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--severity",
    "warning",
    "--surface",
    "branch",
    "--reason",
    "running_sandbox_present",
    "--run",
    controlPlaneBlockedPlan.run.id,
    "--action",
    "inspect_run",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneAlertPreview.ok, true);
  assert.equal(controlPlaneAlertPreview.session, sessionName);
  assert.equal(controlPlaneAlertPreview.matchCount, filteredBranchAlerts.filter.totalAlerts);
  assert.deepEqual(controlPlaneAlertPreview.filter.runIds, [controlPlaneBlockedPlan.run.id]);
  assert.equal(controlPlaneAlertPreview.alert?.runId, controlPlaneBlockedPlan.run.id);
  assert.equal(controlPlaneAlertPreview.alert?.action, "inspect_run");
  assert.equal(
    controlPlaneAlertPreview.preview?.command.join(" "),
    `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`,
  );
  assert.equal(controlPlaneAlertPreview.details?.kind, "run_resume_inspection");
  assert.equal(controlPlaneAlertPreview.details?.inspection.run.id, controlPlaneBlockedPlan.run.id);
  assert.equal(controlPlaneAlertPreview.details?.inspection.run.status, "stopped");
  assert.equal(controlPlaneAlertPreview.details?.inspection.recovery.ready, false);
  assert.equal(controlPlaneAlertPreview.details?.inspection.recovery.reason, "running_sandbox_present");
  assert.equal(controlPlaneAlertPreview.details?.inspection.nextStep.action, "inspect_run");
  assert.equal(
    controlPlaneAlertPreview.details?.inspection.nextStep.command.join(" "),
    `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`,
  );
  assert.ok(controlPlaneAlertPreview.recentTimeline.events.some((event) => (
    event.source === "branch_recovery_execution"
    && event.status === "noop"
    && event.skippedRunIds?.includes(controlPlaneBlockedPlan.run.id)
  )));
  const controlPlaneAlertCommands = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alerts",
    sessionName,
    "--server",
    "--severity",
    "warning",
    "--surface",
    "branch",
    "--reason",
    "running_sandbox_present",
    "--run",
    controlPlaneBlockedPlan.run.id,
    "--action",
    "inspect_run",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.ok(controlPlaneAlertCommands.split("\n").filter(Boolean).includes(
    `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`,
  ));
  const controlPlaneAlertPreviewCommand = await cliText(baseUrl, [
    "runs",
    "session-control-plane-alert",
    sessionName,
    "--server",
    "--severity",
    "warning",
    "--surface",
    "branch",
    "--reason",
    "running_sandbox_present",
    "--run",
    controlPlaneBlockedPlan.run.id,
    "--action",
    "inspect_run",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.equal(
    controlPlaneAlertPreviewCommand.trim(),
    `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`,
  );
  const controlPlaneAlertExecute = await cliJson<{
    ok: true;
    session: string;
    dryRun: boolean;
    advanceId: string;
    advancePath: string;
    selected: {
      surface: string;
      action: string;
      reason: string;
      count: number;
      command: string[];
      runId?: string;
    } | null;
    alert: ControlPlaneAlertPreviewResponse["alert"];
    details: ControlPlaneAlertPreviewResponse["details"];
    executed: { command: string[]; exitCode: number | null; stdout?: string; stderr?: string } | null;
    before: { ok: true; session: string };
    after: { ok: true; session: string };
    filter: ControlPlaneAlertPreviewResponse["filter"];
  }>(baseUrl, [
    "runs",
    "session-control-plane-alert-execute",
    sessionName,
    "--server",
    "--severity",
    "warning",
    "--surface",
    "branch",
    "--reason",
    "running_sandbox_present",
    "--run",
    controlPlaneBlockedPlan.run.id,
    "--action",
    "inspect_run",
    "--lines",
    "20",
  ]);
  assert.equal(controlPlaneAlertExecute.ok, true);
  assert.equal(controlPlaneAlertExecute.session, sessionName);
  assert.equal(controlPlaneAlertExecute.dryRun, false);
  assert.match(controlPlaneAlertExecute.advancePath, /control-plane-advances/);
  assert.equal(controlPlaneAlertExecute.selected?.surface, "branch");
  assert.equal(controlPlaneAlertExecute.selected?.action, "inspect_run");
  assert.equal(controlPlaneAlertExecute.selected?.runId, controlPlaneBlockedPlan.run.id);
  assert.equal(
    controlPlaneAlertExecute.selected?.command.join(" "),
    `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`,
  );
  assert.equal(controlPlaneAlertExecute.alert?.runId, controlPlaneBlockedPlan.run.id);
  assert.equal(controlPlaneAlertExecute.details?.kind, "run_resume_inspection");
  assert.deepEqual(controlPlaneAlertExecute.filter.runIds, [controlPlaneBlockedPlan.run.id]);
  assert.equal(
    controlPlaneAlertExecute.executed?.command.join(" "),
    `npm run cli -- runs inspect ${controlPlaneBlockedPlan.run.id}`,
  );
  assert.equal(controlPlaneAlertExecute.executed?.exitCode, 0);
  assert.equal(controlPlaneAlertExecute.before.session, sessionName);
  assert.equal(controlPlaneAlertExecute.after.session, sessionName);
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
  type DrainWorkerEnsureResponse = {
    ok?: true;
    session: string;
    action: string;
    reason: string;
    worker: {
      workerId: string;
      command: string[];
      alive: boolean;
      restartCount?: number;
      retiredAt?: string;
    };
    workers: Array<{ workerId: string; alive: boolean; retiredAt?: string }>;
  };
  const ensuredDrainWorkerId = "detached-smoke-drain-ensure-worker";
  const ensuredDrainWorker = await cliJson<DrainWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-drain-worker",
    sessionName,
    "--server",
    "--worker-id",
    ensuredDrainWorkerId,
    "--max-continuations",
    "1",
    "--lines",
    "5",
  ]);
  assert.equal(ensuredDrainWorker.ok, true);
  assert.equal(ensuredDrainWorker.session, sessionName);
  assert.equal(ensuredDrainWorker.action, "started");
  assert.equal(ensuredDrainWorker.reason, "no_running_or_restartable_worker");
  assert.equal(ensuredDrainWorker.worker.workerId, ensuredDrainWorkerId);
  assert.deepEqual(ensuredDrainWorker.worker.command, [
    "runs",
    "session-drain-continuations",
    sessionName,
    "--execute-queued",
    "--max-continuations",
    "1",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop-drain-workers",
    sessionName,
    "--server",
    "--worker-id",
    ensuredDrainWorkerId,
  ]);
  const restartedEnsuredDrainWorker = await cliJson<DrainWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-drain-worker",
    sessionName,
    "--server",
    "--worker-id",
    ensuredDrainWorkerId,
    "--lines",
    "5",
  ]);
  assert.equal(restartedEnsuredDrainWorker.ok, true);
  assert.equal(restartedEnsuredDrainWorker.action, "restarted");
  assert.equal(restartedEnsuredDrainWorker.reason, "restartable_worker_exists");
  assert.equal(restartedEnsuredDrainWorker.worker.workerId, ensuredDrainWorkerId);
  assert.equal(restartedEnsuredDrainWorker.worker.restartCount, 1);
  await cliJson(baseUrl, [
    "runs",
    "stop-drain-workers",
    sessionName,
    "--server",
    "--worker-id",
    ensuredDrainWorkerId,
    "--retire",
  ]);
  const blockedEnsuredDrainWorker = await cliJson<DrainWorkerEnsureResponse>(baseUrl, [
    "runs",
    "ensure-drain-worker",
    sessionName,
    "--server",
    "--worker-id",
    ensuredDrainWorkerId,
    "--lines",
    "5",
  ]);
  assert.equal(blockedEnsuredDrainWorker.ok, true);
  assert.equal(blockedEnsuredDrainWorker.action, "blocked");
  assert.equal(blockedEnsuredDrainWorker.reason, "existing_worker_not_restartable");
  assert.equal(blockedEnsuredDrainWorker.worker.workerId, ensuredDrainWorkerId);
  assert.equal(typeof blockedEnsuredDrainWorker.worker.retiredAt, "string");
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
	  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", session), { recursive: true, force: true });
	  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", session), { recursive: true, force: true });
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

async function writeApplyActionExecution(
  session: string,
  executionId: string,
  overrides: Record<string, unknown>,
): Promise<string> {
  const executionDir = path.join(".threadbeat", "worker-sessions", "apply-action-executions", session);
  const executionPath = path.join(executionDir, `${executionId}.json`);
  const observedAt = new Date().toISOString();
  await fs.mkdir(executionDir, { recursive: true });
  await fs.writeFile(executionPath, `${JSON.stringify({
    executionId,
    session,
    observedAt,
    completedAt: observedAt,
    filter: {},
    ...overrides,
  }, null, 2)}\n`);
  return executionPath;
}
