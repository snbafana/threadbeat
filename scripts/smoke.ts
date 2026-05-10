import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-smoke-"));

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-smoke",
};

const { app } = await buildServer(settings);

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const preflightResponse = await app.inject({
    method: "GET",
    url: "/api/preflight",
  });
  assert.equal(preflightResponse.statusCode, 200);
  assert.match(preflightResponse.body, /sandbox_pi_auth/);

  const cliPreflight = await cliJson<{ preflight: { ok: boolean; checks: Array<{ name: string }> } }>(baseUrl, [
    "preflight",
  ]);
  assert.equal(cliPreflight.preflight.ok, false);
  assert.ok(cliPreflight.preflight.checks.some((check) => check.name === "hosted_git"));

  const agentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(agentResponse.statusCode, 200);
  const agentBody = JSON.parse(agentResponse.body) as { agent: { id: string } };

  const repositoryResponse = await app.inject({
    method: "GET",
    url: `/api/agents/${agentBody.agent.id}/repository`,
  });
  assert.equal(repositoryResponse.statusCode, 200);
  assert.match(repositoryResponse.body, /https:\/\/github.com\/example\/agent/);

  const runPlanResponse = await app.inject({
    method: "POST",
    url: `/api/agents/${agentBody.agent.id}/runs`,
    payload: {
      objective: "smoke branch plan",
      inputRef: "main",
    },
  });
  assert.equal(runPlanResponse.statusCode, 200);
  const runPlanBody = JSON.parse(runPlanResponse.body) as {
    plan: { branchName: string; links: { compareUrl: string | null } };
    run: { id: string; status: string };
  };
  assert.equal(runPlanBody.run.status, "planned");
  assert.match(runPlanBody.plan.branchName, /^threadbeat\/runs\//);
  assert.match(runPlanBody.plan.links.compareUrl ?? "", /github\.com\/example\/agent\/compare\/main\.\.\.threadbeat\/runs\//);

  const runGetResponse = await app.inject({
    method: "GET",
    url: `/api/runs/${runPlanBody.run.id}`,
  });
  assert.equal(runGetResponse.statusCode, 200);
  assert.match(runGetResponse.body, /smoke branch plan/);

  const runSandboxResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/sandbox`,
  });
  assert.equal(runSandboxResponse.statusCode, 200);
  const runSandboxBody = JSON.parse(runSandboxResponse.body) as {
    sandbox: { id: string; run_id: string | null; state: string };
  };
  assert.equal(runSandboxBody.sandbox.run_id, runPlanBody.run.id);
  assert.equal(runSandboxBody.sandbox.state, "running");

  const duplicateRunSandboxResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/sandbox`,
  });
  assert.equal(duplicateRunSandboxResponse.statusCode, 200);
  const duplicateRunSandboxBody = JSON.parse(duplicateRunSandboxResponse.body) as {
    sandbox: { id: string };
  };
  assert.equal(duplicateRunSandboxBody.sandbox.id, runSandboxBody.sandbox.id);

  const runSandboxListResponse = await app.inject({
    method: "GET",
    url: `/api/sandboxes?runId=${runPlanBody.run.id}`,
  });
  assert.equal(runSandboxListResponse.statusCode, 200);
  assert.ok(runSandboxListResponse.body.includes(runSandboxBody.sandbox.id));

  const runMessagesResponse = await app.inject({
    method: "GET",
    url: `/api/messages?runId=${runPlanBody.run.id}`,
  });
  assert.equal(runMessagesResponse.statusCode, 200);
  assert.match(runMessagesResponse.body, /sandbox_running/);

  const runStatusResponse = await app.inject({
    method: "GET",
    url: `/api/runs/${runPlanBody.run.id}/status?limit=5`,
  });
  assert.equal(runStatusResponse.statusCode, 200);
  assert.match(runStatusResponse.body, /"sandboxes":/);
  assert.match(runStatusResponse.body, /"messages":/);
  assert.match(runStatusResponse.body, /sandbox_running/);

  const runSandboxStopResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/stop`,
  });
  assert.equal(runSandboxStopResponse.statusCode, 200);

  const stoppedRunResponse = await app.inject({
    method: "GET",
    url: `/api/runs/${runPlanBody.run.id}`,
  });
  assert.equal(stoppedRunResponse.statusCode, 200);
  assert.match(stoppedRunResponse.body, /"status":"stopped"/);
  const stoppedRunListResponse = await app.inject({
    method: "GET",
    url: `/api/agents/${agentBody.agent.id}/runs?status=stopped`,
  });
  assert.equal(stoppedRunListResponse.statusCode, 200);
  const stoppedRunList = JSON.parse(stoppedRunListResponse.body) as { runs: Array<{ id: string; status: string }> };
  assert.equal(stoppedRunList.runs.length, 1);
  assert.equal(stoppedRunList.runs[0].id, runPlanBody.run.id);
  assert.equal(stoppedRunList.runs[0].status, "stopped");
  const plannedRunListResponse = await app.inject({
    method: "GET",
    url: `/api/agents/${agentBody.agent.id}/runs?status=planned`,
  });
  assert.equal(plannedRunListResponse.statusCode, 200);
  assert.deepEqual((JSON.parse(plannedRunListResponse.body) as { runs: unknown[] }).runs, []);
  const invalidRunStatusResponse = await app.inject({
    method: "GET",
    url: `/api/agents/${agentBody.agent.id}/runs?status=queued`,
  });
  assert.equal(invalidRunStatusResponse.statusCode, 400);

  const restartStoppedRunSandboxResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/sandbox`,
  });
  assert.equal(restartStoppedRunSandboxResponse.statusCode, 409);
  assert.match(restartStoppedRunSandboxResponse.body, /already stopped/);

  const runSandboxRestartResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/restart-sandbox`,
  });
  assert.equal(runSandboxRestartResponse.statusCode, 200);
  const runSandboxRestartBody = JSON.parse(runSandboxRestartResponse.body) as {
    sandbox: { id: string; run_id: string | null; state: string };
  };
  assert.notEqual(runSandboxRestartBody.sandbox.id, runSandboxBody.sandbox.id);
  assert.equal(runSandboxRestartBody.sandbox.run_id, runPlanBody.run.id);
  assert.equal(runSandboxRestartBody.sandbox.state, "running");
  const restartedRunResponse = await app.inject({
    method: "GET",
    url: `/api/runs/${runPlanBody.run.id}`,
  });
  assert.equal(restartedRunResponse.statusCode, 200);
  assert.match(restartedRunResponse.body, /"status":"running"/);

  const runningRunSandboxRestartResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/restart-sandbox`,
  });
  assert.equal(runningRunSandboxRestartResponse.statusCode, 409);
  assert.match(runningRunSandboxRestartResponse.body, /already running/);

  const restartedRunSandboxStopResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${runPlanBody.run.id}/stop`,
  });
  assert.equal(restartedRunSandboxStopResponse.statusCode, 200);

  const heartbeatResponse = await app.inject({
    method: "POST",
    url: "/api/heartbeats",
    payload: {
      agentId: agentBody.agent.id,
      title: "smoke heartbeat",
    },
  });
  assert.equal(heartbeatResponse.statusCode, 200);
  const heartbeatBody = JSON.parse(heartbeatResponse.body) as { heartbeat: { id: string } };

  const heartbeatGetResponse = await app.inject({
    method: "GET",
    url: `/api/heartbeats/${heartbeatBody.heartbeat.id}`,
  });
  assert.equal(heartbeatGetResponse.statusCode, 200);
  assert.match(heartbeatGetResponse.body, /smoke heartbeat/);

  const heartbeatListResponse = await app.inject({
    method: "GET",
    url: `/api/heartbeats?agentId=${agentBody.agent.id}`,
  });
  assert.equal(heartbeatListResponse.statusCode, 200);
  assert.match(heartbeatListResponse.body, /smoke heartbeat/);

  const sandboxResponse = await app.inject({
    method: "POST",
    url: `/api/agents/${agentBody.agent.id}/sandboxes`,
  });
  assert.equal(sandboxResponse.statusCode, 200);
  const sandboxBody = JSON.parse(sandboxResponse.body) as { sandbox: { id: string; state: string } };
  assert.equal(sandboxBody.sandbox.state, "running");

  const sandboxGetResponse = await app.inject({
    method: "GET",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}`,
  });
  assert.equal(sandboxGetResponse.statusCode, 200);
  assert.match(sandboxGetResponse.body, /running/);

  const bootstrapResponse = await app.inject({
    method: "POST",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}/bootstrap`,
    payload: { dryRun: true },
  });
  assert.equal(bootstrapResponse.statusCode, 200);
  assert.match(bootstrapResponse.body, /git clone/);

  const cliBootstrap = await cliJson<{ bootstrap: unknown[] }>(baseUrl, [
    "sandboxes",
    "bootstrap",
    sandboxBody.sandbox.id,
  ]);
  assert.equal(cliBootstrap.bootstrap.length, 5);

  const execResponse = await app.inject({
    method: "POST",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}/exec`,
    payload: { command: "pwd" },
  });
  assert.equal(execResponse.statusCode, 200);
  assert.match(execResponse.body, /dry-run/);

  const stopResponse = await app.inject({
    method: "POST",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}/stop`,
  });
  assert.equal(stopResponse.statusCode, 200);
  const stoppedSandboxResponse = await app.inject({
    method: "GET",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}`,
  });
  assert.equal(stoppedSandboxResponse.statusCode, 200);
  assert.match(stoppedSandboxResponse.body, /"state":"stopped"/);

  const messagesResponse = await app.inject({
    method: "GET",
    url: `/api/messages?sandboxId=${sandboxBody.sandbox.id}`,
  });
  assert.equal(messagesResponse.statusCode, 200);
  assert.match(messagesResponse.body, /exec_completed/);

  const unfilteredStopRunningResponse = await app.inject({
    method: "POST",
    url: "/api/sandboxes/stop-running",
    payload: {},
  });
  assert.equal(unfilteredStopRunningResponse.statusCode, 400);
  assert.match(unfilteredStopRunningResponse.body, /agentId or runId is required/);

  const cleanupSandboxA = await app.inject({
    method: "POST",
    url: `/api/agents/${agentBody.agent.id}/sandboxes`,
  });
  assert.equal(cleanupSandboxA.statusCode, 200);
  const cleanupSandboxB = await app.inject({
    method: "POST",
    url: `/api/agents/${agentBody.agent.id}/sandboxes`,
  });
  assert.equal(cleanupSandboxB.statusCode, 200);

  const cliStopRunning = await cliJson<{ stoppedCount: number }>(baseUrl, [
    "sandboxes",
    "stop-running",
    "--agent",
    agentBody.agent.id,
  ]);
  assert.equal(cliStopRunning.stoppedCount, 2);
  const stoppedSandboxes = await cliJson<{ sandboxes: Array<{ state: string }> }>(baseUrl, [
    "sandboxes",
    "list",
    "--agent",
    agentBody.agent.id,
  ]);
  assert.ok(stoppedSandboxes.sandboxes.filter((sandbox) => sandbox.state === "stopped").length >= 3);

  const cliHeartbeat = await cliJson<{ heartbeat: { id: string } }>(baseUrl, [
    "heartbeats",
    "get",
    heartbeatBody.heartbeat.id,
  ]);
  assert.equal(cliHeartbeat.heartbeat.id, heartbeatBody.heartbeat.id);

  const cliRepository = await cliJson<{ repository: { repoWebUrl: string } }>(baseUrl, [
    "agents",
    "repo",
    agentBody.agent.id,
  ]);
  assert.equal(cliRepository.repository.repoWebUrl, "https://github.com/example/agent");

  const cliRunPlan = await cliJson<{ run: { id: string; objective: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli branch plan",
  ]);
  assert.equal(cliRunPlan.run.objective, "cli branch plan");
  assert.match(cliRunPlan.plan.branchName, /^threadbeat\/runs\//);

  const cliRunsList = await cliJson<{ runs: unknown[] }>(baseUrl, [
    "runs",
    "list",
    "--agent",
    agentBody.agent.id,
  ]);
  assert.equal(cliRunsList.runs.length, 2);

  const cliRunGet = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "get",
    cliRunPlan.run.id,
  ]);
  assert.equal(cliRunGet.run.id, cliRunPlan.run.id);

  const cliRunStatus = await cliJson<{ run: { id: string }; sandboxes: unknown[]; messages: unknown[] }>(baseUrl, [
    "runs",
    "status",
    cliRunPlan.run.id,
    "--limit",
    "2",
  ]);
  assert.equal(cliRunStatus.run.id, cliRunPlan.run.id);
  assert.equal(cliRunStatus.sandboxes.length, 0);
  assert.ok(cliRunStatus.messages.length > 0);

  const cliRunWatch = await cliRaw(baseUrl, [
    "runs",
    "watch",
    cliRunPlan.run.id,
    "--limit",
    "2",
    "--interval-ms",
    "1",
    "--max-polls",
    "1",
  ]);
  const watched = JSON.parse(cliRunWatch.stdout.trim()) as {
    run: { id: string };
    messages: unknown[];
  };
  assert.equal(watched.run.id, cliRunPlan.run.id);
  assert.ok(watched.messages.length > 0);

  const claimPlan = await cliJson<{ run: { id: string; status: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli claim run",
  ]);
  assert.equal(claimPlan.run.status, "planned");
  const claimedRun = await cliJson<{ run: { id: string; status: string; worker_id: string | null } }>(baseUrl, [
    "runs",
    "claim",
    claimPlan.run.id,
    "--worker-id",
    "smoke-claimer",
  ]);
  assert.equal(claimedRun.run.id, claimPlan.run.id);
  assert.equal(claimedRun.run.status, "running");
  assert.equal(claimedRun.run.worker_id, "smoke-claimer");
  const claimMessages = await cliJson<{ messages: Array<{ type: string; text: string | null }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    claimPlan.run.id,
  ]);
  assert.ok(claimMessages.messages.some((message) => (
    message.type === "agent_run_claimed" && message.text === "Claimed run by smoke-claimer"
  )));
  const repeatedClaimResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${claimPlan.run.id}/claim`,
  });
  assert.equal(repeatedClaimResponse.statusCode, 409);
  assert.match(repeatedClaimResponse.body, /already running/);
  const requeuedRun = await cliJson<{ run: { id: string; status: string; worker_id: string | null } }>(baseUrl, [
    "runs",
    "requeue",
    claimPlan.run.id,
    "--worker-id",
    "smoke-requeuer",
  ]);
  assert.equal(requeuedRun.run.id, claimPlan.run.id);
  assert.equal(requeuedRun.run.status, "planned");
  assert.equal(requeuedRun.run.worker_id, null);
  const resumePlan = await cliJson<{
    run: { id: string; status: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli selective resume branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", resumePlan.run.id]);
  const resumePreview = await cliJson<{
    resumable: {
      runId: string;
      branchName: string;
      resultCommit: string | null;
      currentStatus: string;
    };
    dryRun: boolean;
  }>(baseUrl, ["runs", "resume-branch", resumePlan.run.id, "--dry-run"]);
  assert.equal(resumePreview.resumable.runId, resumePlan.run.id);
  assert.equal(resumePreview.resumable.branchName, resumePlan.plan.branchName);
  assert.equal(resumePreview.resumable.resultCommit, null);
  assert.equal(resumePreview.resumable.currentStatus, "stopped");
  assert.equal(resumePreview.dryRun, true);
  const resumedRun = await cliJson<{
    resumed: { runId: string; branchName: string; status: string; workerId: string | null };
    run: { id: string; status: string; worker_id: string | null };
  }>(baseUrl, [
    "runs",
    "resume-branch",
    resumePlan.run.id,
    "--worker-id",
    "smoke-resumer",
  ]);
  assert.equal(resumedRun.resumed.runId, resumePlan.run.id);
  assert.equal(resumedRun.resumed.branchName, resumePlan.plan.branchName);
  assert.equal(resumedRun.resumed.status, "planned");
  assert.equal(resumedRun.resumed.workerId, null);
  assert.equal(resumedRun.run.id, resumePlan.run.id);
  assert.equal(resumedRun.run.status, "planned");
  assert.equal(resumedRun.run.worker_id, null);
  const resumedMessages = await cliJson<{ messages: Array<{ type: string; text: string | null }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    resumePlan.run.id,
  ]);
  assert.ok(resumedMessages.messages.some((message) => (
    message.type === "agent_run_requeued" && message.text === "Requeued run by smoke-resumer"
  )));
  const requeueBlockedPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli requeue blocked run",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "sandbox",
    requeueBlockedPlan.run.id,
  ]);
  const requeueRunningSandboxResponse = await app.inject({
    method: "POST",
    url: `/api/runs/${requeueBlockedPlan.run.id}/requeue`,
  });
  assert.equal(requeueRunningSandboxResponse.statusCode, 409);
  assert.match(requeueRunningSandboxResponse.body, /running sandbox/);

  const recoverCommandPlan = await cliJson<{
    run: { id: string; objective: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli recover command",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    recoverCommandPlan.run.id,
    "--worker-id",
    "smoke-orphaned-worker",
  ]);
  const recoverPreview = await cliJson<{
    recovered: Array<{
      agentId: string;
      runId: string;
      objective: string;
      branchName: string;
      resultCommit: string | null;
      workerId: string | null;
      currentStatus?: string;
      dryRun?: boolean;
      skipped?: string;
    }>;
  }>(baseUrl, [
    "runs",
    "recover",
    "--agent",
    agentBody.agent.id,
    "--dry-run",
  ]);
  assert.ok(recoverPreview.recovered.some((run) => (
    run.agentId === agentBody.agent.id
      && run.runId === recoverCommandPlan.run.id
      && run.objective === "cli recover command"
      && run.branchName === recoverCommandPlan.plan.branchName
      && run.resultCommit === null
      && run.workerId === "smoke-orphaned-worker"
      && run.currentStatus === "running"
      && run.dryRun === true
  )));
  const previewedRun = await cliJson<{ run: { id: string; status: string } }>(baseUrl, [
    "runs",
    "get",
    recoverCommandPlan.run.id,
  ]);
  assert.equal(previewedRun.run.status, "running");
  const recoveredCommand = await cliJson<{
    recovered: Array<{
      agentId: string;
      runId: string;
      objective: string;
      branchName: string;
      resultCommit: string | null;
      workerId: string | null;
      status?: string;
      skipped?: string;
    }>;
  }>(baseUrl, [
    "runs",
    "recover",
    "--agent",
    agentBody.agent.id,
    "--worker-id",
    "smoke-recover-operator",
  ]);
  assert.ok(recoveredCommand.recovered.some((run) => (
    run.agentId === agentBody.agent.id
      && run.runId === requeueBlockedPlan.run.id
      && run.skipped === "run has a running sandbox"
  )));
  assert.ok(recoveredCommand.recovered.some((run) => (
    run.agentId === agentBody.agent.id
      && run.runId === recoverCommandPlan.run.id
      && run.branchName === recoverCommandPlan.plan.branchName
      && run.status === "planned"
      && run.workerId === null
  )));
  const recoverStoppedPlan = await cliJson<{
    run: { id: string; objective: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli recover stopped branch",
  ]);
  await cliJson(baseUrl, ["runs", "sandbox", recoverStoppedPlan.run.id]);
  await cliJson(baseUrl, ["runs", "stop", recoverStoppedPlan.run.id]);
  const recoveredStoppedCommand = await cliJson<{
    recovered: Array<{
      agentId: string;
      runId: string;
      objective: string;
      branchName: string;
      resultCommit: string | null;
      workerId: string | null;
      status?: string;
      skipped?: string;
    }>;
  }>(baseUrl, [
    "runs",
    "recover",
    "--agent",
    agentBody.agent.id,
    "--include-stopped",
    "--worker-id",
    "smoke-recover-stopped",
  ]);
  assert.ok(recoveredStoppedCommand.recovered.some((run) => (
    run.agentId === agentBody.agent.id
      && run.runId === recoverStoppedPlan.run.id
      && run.objective === "cli recover stopped branch"
      && run.branchName === recoverStoppedPlan.plan.branchName
      && run.resultCommit === null
      && run.workerId === null
      && run.status === "planned"
  )));
  const stoppedOwnerAgent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "stopped-owner-agent",
    "--repo",
    "https://github.com/example/agent.git",
  ]);
  const stoppedOwnerPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    stoppedOwnerAgent.agent.id,
    "--objective",
    "owned stopped branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    stoppedOwnerPlan.run.id,
    "--worker-id",
    "smoke-stopped-owner",
  ]);
  await cliJson(baseUrl, ["runs", "sandbox", stoppedOwnerPlan.run.id]);
  await cliJson(baseUrl, ["runs", "stop", stoppedOwnerPlan.run.id]);
  const skippedStoppedOwner = await cliJson<{ processed: Array<{ runId?: string }>; idlePasses: number }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    stoppedOwnerAgent.agent.id,
    "--resume-stopped",
    "--worker-id",
    "smoke-other-stopped-worker",
    "--limit",
    "1",
    "--idle-exit-after",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.deepEqual(skippedStoppedOwner.processed, []);
  assert.equal(skippedStoppedOwner.idlePasses, 1);
  const resumedStoppedOwner = await cliJson<{ processed: Array<{ runId?: string; action?: string }> }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    stoppedOwnerAgent.agent.id,
    "--resume-stopped",
    "--worker-id",
    "smoke-stopped-owner",
    "--limit",
    "1",
    "--no-bootstrap",
  ]);
  assert.ok(resumedStoppedOwner.processed.some((run) => (
    run.runId === stoppedOwnerPlan.run.id && run.action === "restarted"
  )));
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", stoppedOwnerPlan.run.id]);

  const recoverAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-recover-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(recoverAgentResponse.statusCode, 200);
  const recoverAgentBody = JSON.parse(recoverAgentResponse.body) as { agent: { id: string } };
  const recoverPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    recoverAgentBody.agent.id,
    "--objective",
    "cli recover orphaned claim",
  ]);
  await cliJson(baseUrl, ["runs", "claim", recoverPlan.run.id]);
  const recoveredWorker = await cliJson<{
    recovered: Array<{ runId: string; status: string }>;
    processed: Array<{ runId: string; sandbox: { run_id: string | null }; status: { run: { worker_id: string | null } } }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    recoverAgentBody.agent.id,
    "--recover",
    "--worker-id",
    "smoke-worker",
    "--limit",
    "1",
  ]);
  assert.deepEqual(recoveredWorker.recovered.map((run) => run.runId), [recoverPlan.run.id]);
  assert.deepEqual(recoveredWorker.processed.map((run) => run.runId), [recoverPlan.run.id]);
  assert.equal(recoveredWorker.processed[0].sandbox.run_id, recoverPlan.run.id);
  assert.equal(recoveredWorker.processed[0].status.run.worker_id, "smoke-worker");
  const recoveredMessages = await cliJson<{ messages: Array<{ type: string; text: string | null }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    recoverPlan.run.id,
  ]);
  assert.ok(recoveredMessages.messages.some((message) => (
    message.type === "agent_run_requeued" && message.text === "Requeued run by smoke-worker"
  )));
  assert.ok(recoveredMessages.messages.some((message) => (
    message.type === "agent_run_claimed" && message.text === "Claimed run by smoke-worker"
  )));
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", recoverPlan.run.id]);

  const launchAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-launch-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(launchAgentResponse.statusCode, 200);
  const launchAgentBody = JSON.parse(launchAgentResponse.body) as { agent: { id: string } };
  const cliLaunch = await cliJson<{
    runs: Array<{
      agentId: string;
      run: { id: string };
      sandbox: { run_id: string | null };
      runtime: { result: { exitCode: number } };
      status: { run: { status: string } };
    }>;
  }>(baseUrl, [
    "runs",
    "launch",
    "--agents",
    `${agentBody.agent.id},${launchAgentBody.agent.id}`,
    "--objective",
    "cli fanout run",
    "--bootstrap",
    "--check-runtime",
    "--concurrency",
    "2",
  ]);
  assert.equal(cliLaunch.runs.length, 2);
  assert.deepEqual(
    cliLaunch.runs.map((run) => run.agentId).sort(),
    [agentBody.agent.id, launchAgentBody.agent.id].sort(),
  );
  for (const launched of cliLaunch.runs) {
    assert.equal(launched.sandbox.run_id, launched.run.id);
    assert.equal(launched.runtime.result.exitCode, 0);
    assert.equal(launched.status.run.status, "running");
    await cliJson(baseUrl, [
      "sandboxes",
      "stop-running",
      "--run",
      launched.run.id,
    ]);
  }

  const workerAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-worker-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(workerAgentResponse.statusCode, 200);
  const workerAgentBody = JSON.parse(workerAgentResponse.body) as { agent: { id: string } };
  const workerRunA = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerAgentBody.agent.id,
    "--objective",
    "cli worker run a",
  ]);
  const workerRunB = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    launchAgentBody.agent.id,
    "--objective",
    "cli worker run b",
  ]);
  const cliMonitor = await cliRaw(baseUrl, [
    "runs",
    "monitor",
    "--agents",
    `${workerAgentBody.agent.id},${launchAgentBody.agent.id}`,
    "--limit",
    "2",
  ]);
  const monitored = JSON.parse(cliMonitor.stdout.trim()) as {
    agents: Array<{
      agentId: string;
      runs: Array<{ id: string; status: string; workerId: string | null; messages: Array<{ type: string }> }>;
    }>;
  };
  assert.deepEqual(
    monitored.agents.map((agent) => agent.agentId).sort(),
    [workerAgentBody.agent.id, launchAgentBody.agent.id].sort(),
  );
  assert.ok(monitored.agents.some((agent) => agent.runs.some((run) => run.id === workerRunA.run.id && run.status === "planned")));
  assert.ok(monitored.agents.some((agent) => agent.runs.some((run) => run.id === workerRunB.run.id && run.messages.some((message) => message.type === "agent_run_planned"))));
  const backlog = await cliJson<{
    agents: Array<{ agentId: string; total: number; statuses: Record<string, number>; resumableStopped: number }>;
  }>(baseUrl, [
    "runs",
    "backlog",
    "--agents",
    `${workerAgentBody.agent.id},${launchAgentBody.agent.id}`,
  ]);
  assert.ok(backlog.agents.some((agent) => (
    agent.agentId === workerAgentBody.agent.id && agent.total >= 1 && agent.statuses.planned >= 1 && agent.resumableStopped === 0
  )));
  assert.ok(backlog.agents.some((agent) => (
    agent.agentId === launchAgentBody.agent.id && agent.total >= 1 && agent.statuses.planned >= 1
  )));
  const cliPlannedMonitor = await cliRaw(baseUrl, [
    "runs",
    "monitor",
    "--agents",
    `${workerAgentBody.agent.id},${launchAgentBody.agent.id}`,
    "--status",
    "planned",
  ]);
  const plannedMonitored = JSON.parse(cliPlannedMonitor.stdout.trim()) as {
    agents: Array<{ runs: Array<{ id: string; status: string }> }>;
  };
  assert.ok(plannedMonitored.agents.every((agent) => agent.runs.every((run) => run.status === "planned")));
  assert.ok(plannedMonitored.agents.some((agent) => agent.runs.some((run) => run.id === workerRunA.run.id)));
  assert.ok(plannedMonitored.agents.some((agent) => agent.runs.some((run) => run.id === workerRunB.run.id)));

  const cliWorker = await cliJson<{
    processed: Array<{
      runId: string;
      sandbox: { run_id: string | null };
      runtime: { result: { exitCode: number } };
      status: { run: { status: string; worker_id: string | null } };
    }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agents",
    `${workerAgentBody.agent.id},${launchAgentBody.agent.id}`,
    "--bootstrap",
    "--check-runtime",
    "--limit",
    "2",
    "--concurrency",
    "2",
    "--worker-id",
    "smoke-batch-worker",
  ]);
  assert.equal(cliWorker.processed.length, 2);
  assert.deepEqual(
    cliWorker.processed.map((run) => run.runId).sort(),
    [workerRunA.run.id, workerRunB.run.id].sort(),
  );
  for (const worked of cliWorker.processed) {
    assert.equal(worked.sandbox.run_id, worked.runId);
    assert.equal(worked.runtime.result.exitCode, 0);
    assert.equal(worked.status.run.status, "running");
    assert.equal(worked.status.run.worker_id, "smoke-batch-worker");
  }
  const cliWorkers = await cliJson<{
    agents: Array<{ workers: Array<{ workerId: string; runs: Array<{ id: string; status: string }> }> }>;
  }>(baseUrl, [
    "runs",
    "workers",
    "--agents",
    `${workerAgentBody.agent.id},${launchAgentBody.agent.id}`,
  ]);
  const smokeWorkerRuns = cliWorkers.agents.flatMap((agent) => (
    agent.workers
      .filter((worker) => worker.workerId === "smoke-batch-worker")
      .flatMap((worker) => worker.runs)
  ));
  assert.deepEqual(
    smokeWorkerRuns.map((run) => run.id).sort(),
    [workerRunA.run.id, workerRunB.run.id].sort(),
  );
  assert.ok(smokeWorkerRuns.every((run) => run.status === "running"));
  for (const worked of cliWorker.processed) {
    await cliJson(baseUrl, [
      "sandboxes",
      "stop-running",
      "--run",
      worked.runId,
    ]);
  }

  const queueAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-queue-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(queueAgentResponse.statusCode, 200);
  const queueAgentBody = JSON.parse(queueAgentResponse.body) as { agent: { id: string } };
  const objectivesFile = path.join(tempRoot, "queue-objectives.txt");
  await fs.writeFile(objectivesFile, "# smoke queue\nqueued objective a\n\nqueued objective b\n");
  const queuedRuns = await cliJson<{
    queued: Array<{ agentId: string; objective: string; run: { id: string; status: string } }>;
  }>(baseUrl, [
    "runs",
    "queue",
    "--agent",
    queueAgentBody.agent.id,
    "--objectives-file",
    objectivesFile,
  ]);
  assert.deepEqual(queuedRuns.queued.map((item) => item.objective), ["queued objective a", "queued objective b"]);
  assert.ok(queuedRuns.queued.every((item) => item.agentId === queueAgentBody.agent.id));
  assert.ok(queuedRuns.queued.every((item) => item.run.status === "planned"));
  const queuedWorker = await cliJson<{
    processed: Array<{ runId: string; status: { run: { worker_id: string | null } } }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    queueAgentBody.agent.id,
    "--limit",
    "2",
    "--worker-id",
    "smoke-queue-worker",
  ]);
  assert.deepEqual(
    queuedWorker.processed.map((item) => item.runId).sort(),
    queuedRuns.queued.map((item) => item.run.id).sort(),
  );
  assert.ok(queuedWorker.processed.every((item) => item.status.run.worker_id === "smoke-queue-worker"));
  for (const worked of queuedWorker.processed) {
    await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", worked.runId]);
  }

  const queuePeerResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-queue-peer-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(queuePeerResponse.statusCode, 200);
  const queuePeerBody = JSON.parse(queuePeerResponse.body) as { agent: { id: string } };
  const roundRobinObjectivesFile = path.join(tempRoot, "round-robin-objectives.txt");
  await fs.writeFile(roundRobinObjectivesFile, "round robin a\nround robin b\nround robin c\n");
  const roundRobinPreview = await cliJson<{
    assignment: string;
    dryRun: boolean;
    planned: Array<{ agentId: string; objective: string }>;
  }>(baseUrl, [
    "runs",
    "queue",
    "--agents",
    `${queueAgentBody.agent.id},${queuePeerBody.agent.id}`,
    "--objectives-file",
    roundRobinObjectivesFile,
    "--assignment",
    "round-robin",
    "--dry-run",
  ]);
  assert.equal(roundRobinPreview.assignment, "round-robin");
  assert.equal(roundRobinPreview.dryRun, true);
  assert.deepEqual(roundRobinPreview.planned.map((item) => item.agentId), [
    queueAgentBody.agent.id,
    queuePeerBody.agent.id,
    queueAgentBody.agent.id,
  ]);
  const roundRobinQueued = await cliJson<{
    assignment: string;
    queued: Array<{ agentId: string; objective: string; run: { status: string } }>;
  }>(baseUrl, [
    "runs",
    "queue",
    "--agents",
    `${queueAgentBody.agent.id},${queuePeerBody.agent.id}`,
    "--objectives-file",
    roundRobinObjectivesFile,
    "--assignment",
    "round-robin",
  ]);
  assert.equal(roundRobinQueued.assignment, "round-robin");
  assert.deepEqual(roundRobinQueued.queued.map((item) => item.objective), [
    "round robin a",
    "round robin b",
    "round robin c",
  ]);
  assert.deepEqual(roundRobinQueued.queued.map((item) => item.agentId), [
    queueAgentBody.agent.id,
    queuePeerBody.agent.id,
    queueAgentBody.agent.id,
  ]);
  assert.ok(roundRobinQueued.queued.every((item) => item.run.status === "planned"));

  const drainAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-drain-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(drainAgentResponse.statusCode, 200);
  const drainAgentBody = JSON.parse(drainAgentResponse.body) as { agent: { id: string } };
  const drainObjectivesFile = path.join(tempRoot, "drain-objectives.txt");
  await fs.writeFile(drainObjectivesFile, "drain objective a\ndrain objective b\ndrain objective c\n");
  const drainQueue = await cliJson<{ queued: Array<{ run: { id: string } }> }>(baseUrl, [
    "runs",
    "queue",
    "--agent",
    drainAgentBody.agent.id,
    "--objectives-file",
    drainObjectivesFile,
  ]);
  const drainedWorker = await cliJson<{
    processed: Array<{ runId: string; status: { run: { worker_id: string | null } } }>;
    idlePasses: number;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    drainAgentBody.agent.id,
    "--until-empty",
    "--limit",
    "2",
    "--worker-id",
    "smoke-drain-worker",
    "--interval-ms",
    "1",
  ]);
  assert.deepEqual(
    drainedWorker.processed.map((item) => item.runId).sort(),
    drainQueue.queued.map((item) => item.run.id).sort(),
  );
  assert.equal(drainedWorker.idlePasses, 1);
  assert.ok(drainedWorker.processed.every((item) => item.status.run.worker_id === "smoke-drain-worker"));
  for (const worked of drainedWorker.processed) {
    await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", worked.runId]);
  }

  const workerGroupAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-worker-group-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(workerGroupAgentResponse.statusCode, 200);
  const workerGroupAgentBody = JSON.parse(workerGroupAgentResponse.body) as { agent: { id: string } };
  const workerGroupObjectivesFile = path.join(tempRoot, "worker-group-objectives.txt");
  await fs.writeFile(workerGroupObjectivesFile, "worker group objective a\nworker group objective b\n");
  const workerGroupQueue = await cliJson<{ queued: Array<{ run: { id: string } }> }>(baseUrl, [
    "runs",
    "queue",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objectives-file",
    workerGroupObjectivesFile,
  ]);
  const workerGroup = await cliJson<{
    workers: Array<{ workerId: string; exitCode: number | null; stdout: string; stderr: string }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--workers",
    "2",
    "--worker-prefix",
    "smoke-group-worker",
    "--until-empty",
    "--limit",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.deepEqual(workerGroup.workers.map((worker) => worker.workerId).sort(), [
    "smoke-group-worker-1",
    "smoke-group-worker-2",
  ]);
  assert.ok(workerGroup.workers.every((worker) => worker.exitCode === 0 && worker.stderr === ""));
  const workerGroupProcessed = workerGroup.workers.flatMap((worker) => (
    (JSON.parse(worker.stdout) as { processed: Array<{ runId: string; skipped?: string }> })
      .processed
      .filter((run) => !run.skipped)
      .map((run) => run.runId)
  ));
  assert.deepEqual(
    workerGroupProcessed.sort(),
    workerGroupQueue.queued.map((item) => item.run.id).sort(),
  );
  for (const queued of workerGroupQueue.queued) {
    await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", queued.run.id]);
  }

  const detachedWorkerSessionName = `smoke-${workerGroupAgentBody.agent.id}`;
  const detachedRecoverPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objective",
    "detached session recoverable claim",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    detachedRecoverPlan.run.id,
    "--worker-id",
    "smoke-detached-worker-1",
  ]);
  const detachedStoppedPlan = await cliJson<{
    run: { id: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objective",
    "detached session resumable stopped branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop",
    detachedStoppedPlan.run.id,
  ]);
  const detachedWorkerGroup = await cliJson<{
    session: {
      session: string;
      workers: Array<{ workerId: string; pid: number | null; stdoutPath: string; stderrPath: string }>;
    };
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--workers",
    "1",
    "--worker-prefix",
    "smoke-detached-worker",
    "--detach",
    "--session",
    detachedWorkerSessionName,
    "--loop",
    "--idle-exit-after",
    "100",
    "--interval-ms",
    "100",
  ]);
  assert.equal(detachedWorkerGroup.session.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerGroup.session.workers.length, 1);
  assert.equal(detachedWorkerGroup.session.workers[0].workerId, "smoke-detached-worker-1");
  assert.equal(typeof detachedWorkerGroup.session.workers[0].pid, "number");
  assert.match(detachedWorkerGroup.session.workers[0].stdoutPath, /worker-sessions/);
  const listedWorkerSessions = await cliJson<{
    sessions: Array<{ session: string; workers: Array<{ workerId: string; pid: number | null; alive: boolean }> }>;
  }>(baseUrl, ["runs", "sessions", "--session", detachedWorkerSessionName]);
  assert.equal(listedWorkerSessions.sessions.length, 1);
  assert.equal(listedWorkerSessions.sessions[0].workers[0].alive, true);
  const detachedWorkerStatus = await cliJson<{
    session: {
      session: string;
      workers: Array<{
        workerId: string;
        alive: boolean;
        runs: Array<{ id: string; status: string; branchName: string; resultCommit: string | null }>;
      }>;
    };
    agents: Array<{
      agentId: string;
      total: number;
      statuses: Record<string, number>;
      resumableStopped: number;
      unassigned: Array<{ id: string; status: string; branchName: string; resultCommit: string | null }>;
    }>;
  }>(baseUrl, ["runs", "session-status", detachedWorkerSessionName]);
  assert.equal(detachedWorkerStatus.session.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerStatus.session.workers[0].workerId, "smoke-detached-worker-1");
  assert.equal(detachedWorkerStatus.session.workers[0].alive, true);
  assert.ok(detachedWorkerStatus.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id && agent.total >= workerGroupQueue.queued.length
  )));
  assert.ok(detachedWorkerStatus.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
    && agent.resumableStopped >= 1
    && agent.unassigned.some((run) => (
      run.id === detachedStoppedPlan.run.id
      && run.status === "stopped"
      && run.branchName.startsWith("threadbeat/runs/")
      && run.resultCommit === null
    ))
  )));
  const detachedWorkerRecoverableStatus = await cliJson<{
    session: { session: string };
    recoveryPreview: Array<{
      runId: string;
      currentStatus?: string;
      dryRun?: boolean;
      resultCommit?: string | null;
      workerId?: string | null;
    }>;
  }>(baseUrl, ["runs", "session-status", detachedWorkerSessionName, "--recoverable", "--include-stopped"]);
  assert.equal(detachedWorkerRecoverableStatus.session.session, detachedWorkerSessionName);
  assert.ok(detachedWorkerRecoverableStatus.recoveryPreview.some((run) => (
    run.runId === detachedRecoverPlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  assert.ok(detachedWorkerRecoverableStatus.recoveryPreview.some((run) => (
    run.runId === detachedStoppedPlan.run.id
    && run.currentStatus === "stopped"
    && run.resultCommit === null
    && run.workerId === null
    && run.dryRun === true
  )));
  const detachedWorkerSummary = await cliJson<{
    session: { session: string; workers: { total: number; alive: number; dead: number } };
    totals: { runs: number; statuses: Record<string, number>; resultCommits: number; resumableStopped: number };
    agents: Array<{ agentId: string; total: number; resultCommits: number; resumableStopped: number }>;
  }>(baseUrl, ["runs", "session-summary", detachedWorkerSessionName]);
  assert.equal(detachedWorkerSummary.session.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerSummary.session.workers.total, 1);
  assert.equal(detachedWorkerSummary.session.workers.alive, 1);
  assert.equal(detachedWorkerSummary.session.workers.dead, 0);
  assert.ok(detachedWorkerSummary.totals.runs >= workerGroupQueue.queued.length);
  assert.ok((detachedWorkerSummary.totals.statuses.stopped ?? 0) >= 1);
  assert.ok(detachedWorkerSummary.totals.resumableStopped >= 1);
  assert.ok(detachedWorkerSummary.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
    && agent.total >= workerGroupQueue.queued.length
    && agent.resumableStopped >= 1
  )));
  const detachedWorkerBranches = await cliJson<{
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number };
      runs: Array<{ id: string; status: string; state: string; resultCommit: string | null; location: string }>;
    }>;
  }>(baseUrl, ["runs", "branches", "--session", detachedWorkerSessionName]);
  assert.ok(detachedWorkerBranches.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
    && agent.summary.resumable >= 1
    && agent.runs.some((run) => (
      run.id === detachedStoppedPlan.run.id
      && run.status === "stopped"
      && run.state === "resumable"
      && run.resultCommit === null
      && run.location === "unassigned"
    ))
  )));
  const detachedWorkerResumableBranches = await cliJson<{
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number };
      runs: Array<{ id: string; status: string; state: string; resultCommit: string | null; location: string }>;
    }>;
  }>(baseUrl, ["runs", "branches", "--session", detachedWorkerSessionName, "--resumable"]);
  const detachedWorkerResumableAgent = detachedWorkerResumableBranches.agents.find((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
  ));
  assert.ok(detachedWorkerResumableAgent);
  assert.equal(detachedWorkerResumableAgent.summary.total, detachedWorkerResumableAgent.runs.length);
  assert.equal(detachedWorkerResumableAgent.summary.resultCommits, 0);
  assert.equal(detachedWorkerResumableAgent.summary.resumable, detachedWorkerResumableAgent.runs.length);
  assert.ok(detachedWorkerResumableAgent.runs.some((run) => (
    run.id === detachedStoppedPlan.run.id
    && run.status === "stopped"
    && run.state === "resumable"
    && run.resultCommit === null
    && run.location === "unassigned"
  )));
  const detachedWorkerResults = await cliJson<{
    observedAt: string;
    session: string;
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number; warnings: number };
      runs: Array<{
        id: string;
        status: string;
        state: string;
        warning: string | null;
        resultCommit: string | null;
        links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
      }>;
    }>;
  }>(baseUrl, ["runs", "results", "--session", detachedWorkerSessionName]);
  assert.match(detachedWorkerResults.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(detachedWorkerResults.session, detachedWorkerSessionName);
  assert.ok(detachedWorkerResults.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
    && agent.summary.resumable >= 1
    && agent.runs.some((run) => (
      run.id === detachedStoppedPlan.run.id
      && run.status === "stopped"
      && run.state === "resumable"
      && run.warning === null
      && run.resultCommit === null
      && run.links.branchTreeUrl !== null
      && run.links.resultCommitUrl === null
    ))
  )));
  const detachedWorkerReview = await cliJson<{
    observedAt: string;
    session: { session: string; workers: { total: number; alive: number; dead: number } };
    resumableBranches: Array<{
      agentId: string;
      runId: string;
      objective: string;
      branchName: string;
      resultCommit: string | null;
      workerId: string | null;
      location: string;
      commands: {
        checkoutBranch: string[];
        resumeBranch: string[];
        resumeSession: string[] | null;
        checkoutSession: string[] | null;
      };
    }>;
    recoveryPreview: Array<{ runId: string; currentStatus?: string; dryRun?: boolean; skipped?: string }>;
    logs: Array<{ workerId: string; alive: boolean; stdout: { lines: string[] }; stderr: { lines: string[] } }>;
  }>(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--lines", "5"]);
  assert.match(detachedWorkerReview.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(detachedWorkerReview.session.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerReview.session.workers.total, 1);
  assert.equal(detachedWorkerReview.session.workers.alive, 1);
  assert.equal(detachedWorkerReview.session.workers.dead, 0);
  assert.ok(detachedWorkerReview.recoveryPreview.some((run) => (
    run.runId === detachedStoppedPlan.run.id
    && run.currentStatus === "stopped"
    && run.dryRun === true
  )));
  assert.ok(detachedWorkerReview.resumableBranches.some((run) => (
    run.agentId === workerGroupAgentBody.agent.id
    && run.runId === detachedStoppedPlan.run.id
    && run.objective === "detached session resumable stopped branch"
    && run.branchName === detachedStoppedPlan.plan.branchName
    && run.resultCommit === null
    && run.workerId === null
    && run.location === "unassigned"
    && run.commands.resumeBranch.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && run.commands.resumeSession?.join(" ") === `npm run cli -- runs resume-session ${detachedWorkerSessionName}`
    && run.commands.checkoutSession?.join(" ") === `npm run cli -- runs checkout-session ${detachedWorkerSessionName} --dir ./checkouts/${detachedWorkerSessionName}-resumable --resumable`
  )));
  assert.equal(detachedWorkerReview.logs[0].workerId, "smoke-detached-worker-1");
  assert.equal(detachedWorkerReview.logs[0].alive, true);
  assert.ok(Array.isArray(detachedWorkerReview.logs[0].stdout.lines));
  assert.ok(Array.isArray(detachedWorkerReview.logs[0].stderr.lines));
  const watchedWorkerStatus = await cliJson<{
    observedAt: string;
    session: {
      session: string;
      workers: Array<{ workerId: string; alive: boolean; runs: Array<{ id: string; status: string }> }>;
    };
    agents: Array<{ agentId: string; total: number; statuses: Record<string, number>; resumableStopped: number }>;
    recoveryPreview: Array<{ runId: string; currentStatus?: string; dryRun?: boolean }>;
  }>(baseUrl, [
    "runs",
    "session-watch",
    detachedWorkerSessionName,
    "--recoverable",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.match(watchedWorkerStatus.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(watchedWorkerStatus.session.session, detachedWorkerSessionName);
  assert.equal(watchedWorkerStatus.session.workers[0].workerId, "smoke-detached-worker-1");
  assert.equal(watchedWorkerStatus.session.workers[0].alive, true);
  assert.ok(watchedWorkerStatus.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id && agent.total >= workerGroupQueue.queued.length
  )));
  assert.ok(watchedWorkerStatus.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id && agent.resumableStopped >= 1
  )));
  assert.ok(watchedWorkerStatus.recoveryPreview.some((run) => (
    run.runId === detachedRecoverPlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  const detachedWorkerLogs = await cliJson<{
    session: string;
    workers: Array<{
      workerId: string;
      alive: boolean;
      stdout: { path: string; lines: string[] };
      stderr: { path: string; lines: string[] };
    }>;
  }>(baseUrl, ["runs", "session-logs", detachedWorkerSessionName, "--lines", "5"]);
  assert.equal(detachedWorkerLogs.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerLogs.workers[0].workerId, "smoke-detached-worker-1");
  assert.equal(detachedWorkerLogs.workers[0].alive, true);
  assert.match(detachedWorkerLogs.workers[0].stdout.path, /worker-sessions/);
  assert.match(detachedWorkerLogs.workers[0].stderr.path, /worker-sessions/);
  assert.ok(Array.isArray(detachedWorkerLogs.workers[0].stdout.lines));
  assert.ok(Array.isArray(detachedWorkerLogs.workers[0].stderr.lines));
  const stoppedWorkerSession = await cliJson<{
    session: string;
    stopped: Array<{ workerId: string; pid: number | null; stopped: boolean }>;
    recovered: Array<{ runId: string; status?: string; skipped?: string }>;
  }>(baseUrl, ["runs", "stop-session", detachedWorkerSessionName, "--recover"]);
  assert.equal(stoppedWorkerSession.session, detachedWorkerSessionName);
  assert.equal(stoppedWorkerSession.stopped[0].stopped, true);
  assert.ok(stoppedWorkerSession.recovered.some((item) => (
    item.runId === detachedRecoverPlan.run.id && item.status === "planned"
  )));
  const recoveredDetachedRun = await cliJson<{ run: { status: string; worker_id: string | null } }>(baseUrl, [
    "runs",
    "get",
    detachedRecoverPlan.run.id,
  ]);
  assert.equal(recoveredDetachedRun.run.status, "planned");
  assert.equal(recoveredDetachedRun.run.worker_id, null);
  const detachedSessionRecoverPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objective",
    "detached session direct recovery",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    detachedSessionRecoverPlan.run.id,
    "--worker-id",
    "smoke-detached-worker-1",
  ]);
  const sessionRecoverPreview = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; currentStatus?: string; dryRun?: boolean }>;
  }>(baseUrl, ["runs", "recover-session", detachedWorkerSessionName, "--dry-run"]);
  assert.equal(sessionRecoverPreview.session, detachedWorkerSessionName);
  assert.ok(sessionRecoverPreview.recovered.some((run) => (
    run.runId === detachedSessionRecoverPlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  const sessionStoppedRecoveryPreview = await cliJson<{
    session: string;
    recovered: Array<{
      runId: string;
      currentStatus?: string;
      dryRun?: boolean;
      resultCommit?: string | null;
      workerId?: string | null;
    }>;
  }>(baseUrl, ["runs", "recover-session", detachedWorkerSessionName, "--include-stopped", "--dry-run"]);
  assert.equal(sessionStoppedRecoveryPreview.session, detachedWorkerSessionName);
  assert.ok(sessionStoppedRecoveryPreview.recovered.some((run) => (
    run.runId === detachedStoppedPlan.run.id
    && run.currentStatus === "stopped"
    && run.dryRun === true
    && run.resultCommit === null
    && run.workerId === null
  )));
  const sessionRecovered = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; status?: string }>;
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "recover-session", detachedWorkerSessionName]);
  assert.equal(sessionRecovered.session, detachedWorkerSessionName);
  assert.equal(sessionRecovered.status.session.session, detachedWorkerSessionName);
  assert.ok(sessionRecovered.recovered.some((run) => (
    run.runId === detachedSessionRecoverPlan.run.id && run.status === "planned"
  )));
  const sessionRecoveredRun = await cliJson<{ run: { status: string; worker_id: string | null } }>(baseUrl, [
    "runs",
    "get",
    detachedSessionRecoverPlan.run.id,
  ]);
  assert.equal(sessionRecoveredRun.run.status, "planned");
  assert.equal(sessionRecoveredRun.run.worker_id, null);
  const sessionResumePlan = await cliJson<{
    run: { id: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objective",
    "detached session branch-only resume",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    sessionResumePlan.run.id,
    "--worker-id",
    "smoke-detached-worker-1",
  ]);
  await cliJson(baseUrl, ["runs", "stop", sessionResumePlan.run.id]);
  const sessionResumePreview = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; currentStatus?: string; dryRun?: boolean; branchName: string; workerId: string | null }>;
  }>(baseUrl, ["runs", "resume-session", detachedWorkerSessionName, "--worker-id", "smoke-detached-worker-1", "--dry-run"]);
  assert.equal(sessionResumePreview.session, detachedWorkerSessionName);
  assert.deepEqual(sessionResumePreview.resumed.map((run) => run.runId), [sessionResumePlan.run.id]);
  assert.equal(sessionResumePreview.resumed[0].branchName, sessionResumePlan.plan.branchName);
  assert.equal(sessionResumePreview.resumed[0].workerId, "smoke-detached-worker-1");
  assert.equal(sessionResumePreview.resumed[0].currentStatus, "stopped");
  assert.equal(sessionResumePreview.resumed[0].dryRun, true);
  const sessionResumed = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "resume-session", detachedWorkerSessionName, "--worker-id", "smoke-detached-worker-1"]);
  assert.equal(sessionResumed.session, detachedWorkerSessionName);
  assert.equal(sessionResumed.status.session.session, detachedWorkerSessionName);
  assert.deepEqual(sessionResumed.resumed.map((run) => run.runId), [sessionResumePlan.run.id]);
  assert.equal(sessionResumed.resumed[0].status, "planned");
  assert.equal(sessionResumed.resumed[0].workerId, null);

  const superviseAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-supervise-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(superviseAgentResponse.statusCode, 200);
  const superviseAgentBody = JSON.parse(superviseAgentResponse.body) as { agent: { id: string } };
  const superviseObjectivesFile = path.join(tempRoot, "supervise-objectives.txt");
  await fs.writeFile(superviseObjectivesFile, "supervise objective\n");
  const superviseQueue = await cliJson<{ queued: Array<{ run: { id: string } }> }>(baseUrl, [
    "runs",
    "queue",
    "--agent",
    superviseAgentBody.agent.id,
    "--objectives-file",
    superviseObjectivesFile,
  ]);
  const superviseSessionName = `supervise-${superviseAgentBody.agent.id}`;
  const supervised = await cliJson<{
    before: Array<{ agentId: string; statuses: Record<string, number> }>;
    session: { session: string; workers: Array<{ workerId: string; pid: number | null }> };
    after: Array<{ agentId: string }>;
  }>(baseUrl, [
    "runs",
    "supervise",
    "--agent",
    superviseAgentBody.agent.id,
    "--session",
    superviseSessionName,
    "--workers",
    "1",
    "--worker-prefix",
    "smoke-supervisor",
    "--recover",
    "--loop",
    "--idle-exit-after",
    "100",
    "--interval-ms",
    "100",
    "--limit",
    "1",
  ]);
  assert.equal(supervised.session.session, superviseSessionName);
  assert.equal(supervised.session.workers[0].workerId, "smoke-supervisor-1");
  assert.equal(typeof supervised.session.workers[0].pid, "number");
  assert.ok(supervised.before.some((agent) => (
    agent.agentId === superviseAgentBody.agent.id && agent.statuses.planned === superviseQueue.queued.length
  )));
  assert.ok(supervised.after.some((agent) => agent.agentId === superviseAgentBody.agent.id));
  await cliJson(baseUrl, ["runs", "stop-session", superviseSessionName]);
  for (const queued of superviseQueue.queued) {
    await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", queued.run.id]);
  }

  const dispatchAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-dispatch-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(dispatchAgentResponse.statusCode, 200);
  const dispatchAgentBody = JSON.parse(dispatchAgentResponse.body) as { agent: { id: string } };
  const dispatchPeerResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-dispatch-peer-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(dispatchPeerResponse.statusCode, 200);
  const dispatchPeerBody = JSON.parse(dispatchPeerResponse.body) as { agent: { id: string } };
  const dispatchObjectivesFile = path.join(tempRoot, "dispatch-objectives.txt");
  await fs.writeFile(dispatchObjectivesFile, "dispatch objective a\ndispatch objective b\n");
  const dispatchSessionName = `dispatch-${dispatchAgentBody.agent.id}`;
  const dispatchPreview = await cliJson<{
    assignment: string;
    dryRun: boolean;
    planned: Array<{ agentId: string; objective: string }>;
    session: { session: string; workerCount: number; command: string[] };
  }>(baseUrl, [
    "runs",
    "dispatch",
    "--agents",
    `${dispatchAgentBody.agent.id},${dispatchPeerBody.agent.id}`,
    "--objectives-file",
    dispatchObjectivesFile,
    "--assignment",
    "round-robin",
    "--session",
    dispatchSessionName,
    "--workers",
    "1",
    "--worker-prefix",
    "smoke-dispatcher",
    "--recover",
    "--interval-ms",
    "100",
    "--idle-exit-after",
    "100",
    "--limit",
    "1",
    "--dry-run",
  ]);
  assert.equal(dispatchPreview.assignment, "round-robin");
  assert.equal(dispatchPreview.dryRun, true);
  assert.deepEqual(dispatchPreview.planned.map((item) => item.agentId), [
    dispatchAgentBody.agent.id,
    dispatchPeerBody.agent.id,
  ]);
  assert.equal(dispatchPreview.session.session, dispatchSessionName);
  assert.equal(dispatchPreview.session.workerCount, 1);
  assert.ok(dispatchPreview.session.command.includes("--loop"));
  const dispatched = await cliJson<{
    assignment: string;
    queued: Array<{ agentId: string; objective: string; run: { id: string; status: string } }>;
    session: { session: string; workers: Array<{ workerId: string; pid: number | null }> };
    backlog: Array<{ agentId: string; total: number; statuses: Record<string, number> }>;
  }>(baseUrl, [
    "runs",
    "dispatch",
    "--agents",
    `${dispatchAgentBody.agent.id},${dispatchPeerBody.agent.id}`,
    "--objectives-file",
    dispatchObjectivesFile,
    "--assignment",
    "round-robin",
    "--session",
    dispatchSessionName,
    "--workers",
    "1",
    "--worker-prefix",
    "smoke-dispatcher",
    "--recover",
    "--interval-ms",
    "100",
    "--idle-exit-after",
    "100",
    "--limit",
    "1",
  ]);
  assert.equal(dispatched.assignment, "round-robin");
  assert.deepEqual(dispatched.queued.map((item) => item.objective), ["dispatch objective a", "dispatch objective b"]);
  assert.deepEqual(dispatched.queued.map((item) => item.agentId), [
    dispatchAgentBody.agent.id,
    dispatchPeerBody.agent.id,
  ]);
  assert.equal(dispatched.session.session, dispatchSessionName);
  assert.equal(dispatched.session.workers[0].workerId, "smoke-dispatcher-1");
  assert.equal(typeof dispatched.session.workers[0].pid, "number");
  assert.ok(dispatched.backlog.some((agent) => (
    agent.agentId === dispatchAgentBody.agent.id && agent.total >= 1
  )));
  assert.ok(dispatched.backlog.some((agent) => (
    agent.agentId === dispatchPeerBody.agent.id && agent.total >= 1
  )));
  const dispatchResults = await cliJson<{
    session: string;
    agents: Array<{
      agentId: string;
      runs: Array<{ id: string; location?: string; workerId: string | null }>;
    }>;
  }>(baseUrl, [
    "runs",
    "results",
    "--session",
    dispatchSessionName,
    "--status",
    "planned,running,completed,stopped",
  ]);
  assert.equal(dispatchResults.session, dispatchSessionName);
  for (const queued of dispatched.queued) {
    const visibleRun = dispatchResults.agents.flatMap((agent) => agent.runs).find((run) => run.id === queued.run.id);
    assert.ok(visibleRun);
    assert.ok(visibleRun.location === "unassigned" || visibleRun.location === "session_worker");
  }
  await cliJson(baseUrl, ["runs", "stop-session", dispatchSessionName]);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await cliJson<{ session: { workers: Array<{ alive: boolean }> } }>(baseUrl, [
      "runs",
      "session-status",
      dispatchSessionName,
    ]);
    if (status.session.workers.every((worker) => !worker.alive)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const restartStoppedPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    dispatchAgentBody.agent.id,
    "--objective",
    "restart session stopped branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", restartStoppedPlan.run.id]);
  const restartedDispatch = await cliJson<{
    session: string;
    restarted: Array<{ workerId: string; pid: number | null }>;
    status: {
      session: {
        command: string[];
        workers: Array<{ workerId: string; alive: boolean }>;
      };
    };
  }>(baseUrl, [
    "runs",
    "restart-session",
    dispatchSessionName,
    "--recover",
    "--resume-stopped",
  ]);
  assert.equal(restartedDispatch.session, dispatchSessionName);
  assert.deepEqual(restartedDispatch.restarted.map((worker) => worker.workerId), ["smoke-dispatcher-1"]);
  assert.equal(typeof restartedDispatch.restarted[0].pid, "number");
  assert.ok(restartedDispatch.status.session.command.includes("--resume-stopped"));
  assert.ok(restartedDispatch.status.session.workers.some((worker) => (
    worker.workerId === "smoke-dispatcher-1" && worker.alive
  )));
  let resumedStoppedRun: { run: { status: string } } | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    resumedStoppedRun = await cliJson<{ run: { status: string } }>(baseUrl, [
      "runs",
      "get",
      restartStoppedPlan.run.id,
    ]);
    if (resumedStoppedRun.run.status === "running") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(resumedStoppedRun?.run.status, "running");
  await cliJson(baseUrl, ["runs", "stop-session", dispatchSessionName]);
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", restartStoppedPlan.run.id]);
  for (const queued of dispatched.queued) {
    await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", queued.run.id]);
  }

  const cliRunSandbox = await cliJson<{ sandbox: { id: string; run_id: string | null } }>(baseUrl, [
    "runs",
    "sandbox",
    cliRunPlan.run.id,
    "--bootstrap",
  ]);
  assert.equal(cliRunSandbox.sandbox.run_id, cliRunPlan.run.id);

  const cliRunBootstrapMessages = await cliJson<{ messages: Array<{ type: string }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    cliRunPlan.run.id,
  ]);
  assert.ok(cliRunBootstrapMessages.messages.some((message) => message.type === "bootstrap_completed"));

  const cliRunExec = await cliJson<{ result: { stdout: string } }>(baseUrl, [
    "runs",
    "exec",
    cliRunPlan.run.id,
    "--",
    "pwd",
  ]);
  assert.match(cliRunExec.result.stdout, /\/workspace\/agent/);

  const cliRunBoot = await cliJson<{
    result: { exitCode: number; stdout: string };
  }>(baseUrl, [
    "runs",
    "boot",
    cliRunPlan.run.id,
  ]);
  assert.equal(cliRunBoot.result.exitCode, 0);
  assert.match(cliRunBoot.result.stdout, /\[dry-run\]/);
  assert.match(cliRunBoot.result.stdout, /pi --provider 'deepseek' --model 'deepseek-v4-flash' --api-key "\$DEEPSEEK_API_KEY" --mode json -p/);

  const cliRuntimeCheck = await cliJson<{
    result: { exitCode: number; stdout: string };
  }>(baseUrl, [
    "runs",
    "check-runtime",
    cliRunPlan.run.id,
  ]);
  assert.equal(cliRuntimeCheck.result.exitCode, 0);
  assert.match(cliRuntimeCheck.result.stdout, /agent runtime ready/);
  assert.match(cliRuntimeCheck.result.stdout, /pi --list-models 'deepseek' \| grep -F 'deepseek-v4-flash'/);

  const cliAgentBootMessages = await cliJson<{ messages: Array<{ type: string }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    cliRunPlan.run.id,
  ]);
  assert.ok(cliAgentBootMessages.messages.some((message) => message.type === "agent_boot_completed"));
  assert.ok(cliAgentBootMessages.messages.some((message) => message.type === "agent_runtime_check_completed"));

  const cliRunFinalize = await cliJson<{ result: { commitSha: string } }>(baseUrl, [
    "runs",
    "finalize",
    cliRunPlan.run.id,
    "--message",
    "Finalize smoke run",
  ]);
  assert.match(cliRunFinalize.result.commitSha, /^[a-f0-9]{40}$/);

  const cliRunSandboxes = await cliJson<{ sandboxes: unknown[] }>(baseUrl, [
    "sandboxes",
    "list",
    "--run",
    cliRunPlan.run.id,
  ]);
  assert.equal(cliRunSandboxes.sandboxes.length, 1);

  const cliRunMessages = await cliJson<{ messages: unknown[] }>(baseUrl, [
    "messages",
    "list",
    "--run",
    cliRunPlan.run.id,
  ]);
  assert.ok(cliRunMessages.messages.length > 0);

  const finalizedRunGet = await cliJson<{ run: { id: string; result_commit: string; status: string } }>(baseUrl, [
    "runs",
    "get",
    cliRunPlan.run.id,
  ]);
  assert.equal(finalizedRunGet.run.status, "completed");
  assert.equal(finalizedRunGet.run.result_commit, cliRunFinalize.result.commitSha);

  const inspectedRun = await cliJson<{
    run: {
      id: string;
      status: string;
      branchName: string;
      resultCommit: string;
    };
    links: {
      branchTreeUrl: string | null;
      resultCommitUrl: string | null;
      resultTreeUrl: string | null;
    };
    sandboxes: Array<{ state: string }>;
    messages: Array<{ type: string }>;
  }>(baseUrl, [
    "runs",
    "inspect",
    cliRunPlan.run.id,
  ]);
  assert.equal(inspectedRun.run.status, "completed");
  assert.equal(inspectedRun.run.resultCommit, cliRunFinalize.result.commitSha);
  assert.match(inspectedRun.run.branchName, /^threadbeat\/runs\//);
  assert.match(inspectedRun.links.branchTreeUrl ?? "", /github\.com\/example\/agent\/tree\/threadbeat\/runs\//);
  assert.match(inspectedRun.links.resultCommitUrl ?? "", new RegExp(`github\\.com/example/agent/commit/${cliRunFinalize.result.commitSha}`));
  assert.match(inspectedRun.links.resultTreeUrl ?? "", new RegExp(`github\\.com/example/agent/tree/${cliRunFinalize.result.commitSha}`));
  assert.ok(inspectedRun.sandboxes.some((sandbox) => sandbox.state === "running"));
  assert.ok(inspectedRun.messages.length > 0);
  const branchSummary = await cliJson<{
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number };
      runs: Array<{
        id: string;
        status: string;
        state: string;
        baseRef: string;
        branchName: string;
        resultCommit: string | null;
      }>;
    }>;
  }>(baseUrl, [
    "runs",
    "branches",
    "--agent",
    agentBody.agent.id,
  ]);
  assert.ok(branchSummary.agents.some((agent) => (
    agent.agentId === agentBody.agent.id
    && agent.summary.resultCommits >= 1
    && agent.runs.some((run) => (
      run.id === cliRunPlan.run.id
      && run.status === "completed"
      && run.state === "result"
      && run.baseRef === "main"
      && run.branchName === cliRunPlan.plan.branchName
      && run.resultCommit === cliRunFinalize.result.commitSha
    ))
  )));
  const workerFilteredPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "worker filtered stopped branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    workerFilteredPlan.run.id,
    "--worker-id",
    "smoke-branch-filter-worker",
  ]);
  await cliJson(baseUrl, ["runs", "sandbox", workerFilteredPlan.run.id]);
  await cliJson(baseUrl, ["runs", "stop", workerFilteredPlan.run.id]);
  const workerFilteredBranches = await cliJson<{
    agents: Array<{
      runs: Array<{ id: string; workerId: string | null; branchName: string }>;
    }>;
  }>(baseUrl, [
    "runs",
    "branches",
    "--agent",
    agentBody.agent.id,
    "--status",
    "stopped",
    "--worker-id",
    "smoke-branch-filter-worker",
  ]);
  assert.ok(workerFilteredBranches.agents.some((agent) => agent.runs.some((run) => (
    run.id === workerFilteredPlan.run.id
    && run.workerId === "smoke-branch-filter-worker"
    && run.branchName === workerFilteredPlan.plan.branchName
  ))));
  const otherWorkerBranches = await cliJson<{
    agents: Array<{ runs: Array<{ id: string }> }>;
  }>(baseUrl, [
    "runs",
    "branches",
    "--agent",
    agentBody.agent.id,
    "--status",
    "stopped",
    "--worker-id",
    "smoke-other-branch-worker",
  ]);
  assert.ok(otherWorkerBranches.agents.every((agent) => (
    !agent.runs.some((run) => run.id === workerFilteredPlan.run.id)
  )));
  const workerFilteredResults = await cliJson<{
    agents: Array<{
      runs: Array<{ id: string; workerId: string | null; state: string }>;
    }>;
  }>(baseUrl, [
    "runs",
    "results",
    "--agent",
    agentBody.agent.id,
    "--status",
    "stopped",
    "--worker-id",
    "smoke-branch-filter-worker",
  ]);
  assert.ok(workerFilteredResults.agents.some((agent) => agent.runs.some((run) => (
    run.id === workerFilteredPlan.run.id
    && run.workerId === "smoke-branch-filter-worker"
    && run.state === "resumable"
  ))));
  const resultSummary = await cliJson<{
    observedAt: string;
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number; warnings: number };
      runs: Array<{
        id: string;
        status: string;
        state: string;
        warning: string | null;
        baseRef: string;
        branchName: string;
        resultCommit: string | null;
        links: {
          branchTreeUrl: string | null;
          branchCompareUrl: string | null;
          resultTreeUrl: string | null;
          resultCommitUrl: string | null;
          resultCompareUrl: string | null;
        };
      }>;
    }>;
  }>(baseUrl, ["runs", "results", "--agent", agentBody.agent.id]);
  assert.match(resultSummary.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(resultSummary.agents.some((agent) => (
    agent.agentId === agentBody.agent.id
    && agent.summary.resultCommits >= 1
    && agent.summary.warnings === 0
    && agent.runs.some((run) => (
      run.id === cliRunPlan.run.id
      && run.status === "completed"
      && run.state === "result"
      && run.warning === null
      && run.baseRef === "main"
      && run.branchName === cliRunPlan.plan.branchName
      && run.resultCommit === cliRunFinalize.result.commitSha
      && /github\.com\/example\/agent\/tree\/threadbeat\/runs\//.test(run.links.branchTreeUrl ?? "")
      && new RegExp(`github\\.com/example/agent/commit/${cliRunFinalize.result.commitSha}`).test(run.links.resultCommitUrl ?? "")
      && new RegExp(`github\\.com/example/agent/compare/main\\.\\.\\.${cliRunFinalize.result.commitSha}`).test(run.links.resultCompareUrl ?? "")
    ))
  )));
  const watchedResults = await cliRaw(baseUrl, [
    "runs",
    "results",
    "--agent",
    agentBody.agent.id,
    "--status",
    "completed",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  const resultSnapshots = watchedResults.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    observedAt: string;
    agents: Array<{ runs: Array<{ id: string; resultCommit: string | null }> }>;
  });
  assert.equal(resultSnapshots.length, 2);
  assert.ok(resultSnapshots.every((snapshot) => (
    /^\d{4}-\d{2}-\d{2}T/.test(snapshot.observedAt)
    && snapshot.agents.some((agent) => agent.runs.some((run) => (
      run.id === cliRunPlan.run.id && run.resultCommit === cliRunFinalize.result.commitSha
    )))
  )));

  const checkoutRemote = path.join(tempRoot, "run-checkout-remote.git");
  const checkoutSeed = path.join(tempRoot, "run-checkout-seed");
  await execFileAsync("git", ["init", "--bare", checkoutRemote]);
  await fs.mkdir(checkoutSeed);
  await execFileAsync("git", ["-C", checkoutSeed, "init"]);
  await execFileAsync("git", ["-C", checkoutSeed, "config", "user.name", "Threadbeat Smoke"]);
  await execFileAsync("git", ["-C", checkoutSeed, "config", "user.email", "threadbeat-smoke@example.local"]);
  await fs.writeFile(path.join(checkoutSeed, "README.md"), "base\n");
  await execFileAsync("git", ["-C", checkoutSeed, "add", "README.md"]);
  await execFileAsync("git", ["-C", checkoutSeed, "commit", "-m", "Initial checkout smoke repo"]);
  await execFileAsync("git", ["-C", checkoutSeed, "branch", "-M", "main"]);
  await execFileAsync("git", ["-C", checkoutSeed, "remote", "add", "origin", checkoutRemote]);
  await execFileAsync("git", ["-C", checkoutSeed, "push", "-u", "origin", "main"]);
  const checkoutAgent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "checkout-agent",
    "--repo",
    checkoutRemote,
  ]);
  const checkoutPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    checkoutAgent.agent.id,
    "--objective",
    "checkout run branch",
  ]);
  await execFileAsync("git", ["-C", checkoutSeed, "checkout", "-B", checkoutPlan.plan.branchName]);
  await fs.writeFile(path.join(checkoutSeed, "report.md"), "branch report\n");
  await execFileAsync("git", ["-C", checkoutSeed, "add", "report.md"]);
  await execFileAsync("git", ["-C", checkoutSeed, "commit", "-m", "Write branch report"]);
  await execFileAsync("git", ["-C", checkoutSeed, "push", "origin", `HEAD:${checkoutPlan.plan.branchName}`]);
  const expectedCheckoutHead = (await execFileAsync("git", ["-C", checkoutSeed, "rev-parse", "HEAD"])).stdout.trim();
  const checkoutDir = path.join(tempRoot, "run-checkout");
  const checkedOutRun = await cliJson<{
    run: { id: string; branchName: string; resultCommit: string | null };
    checkout: { dir: string; created: boolean; branchName: string; headCommit: string; matchesResultCommit: boolean | null };
    review: {
      baseRef: string;
      baseCommit: string | null;
      headCommit: string;
      changedFiles: Array<{ status: string; path: string }>;
      commits: Array<{ sha: string; subject: string }>;
    };
  }>(baseUrl, [
    "runs",
    "checkout",
    checkoutPlan.run.id,
    "--dir",
    checkoutDir,
  ]);
  assert.equal(checkedOutRun.run.branchName, checkoutPlan.plan.branchName);
  assert.equal(checkedOutRun.run.resultCommit, null);
  assert.equal(checkedOutRun.checkout.dir, checkoutDir);
  assert.equal(checkedOutRun.checkout.created, true);
  assert.equal(checkedOutRun.checkout.branchName, checkoutPlan.plan.branchName);
  assert.equal(checkedOutRun.checkout.headCommit, expectedCheckoutHead);
  assert.equal(checkedOutRun.checkout.matchesResultCommit, null);
  assert.equal(checkedOutRun.review.baseRef, "main");
  assert.match(checkedOutRun.review.baseCommit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(checkedOutRun.review.headCommit, expectedCheckoutHead);
  assert.deepEqual(checkedOutRun.review.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.ok(checkedOutRun.review.commits.some((commit) => (
    commit.sha === expectedCheckoutHead && commit.subject === "Write branch report"
  )));
  assert.equal(await fs.readFile(path.join(checkoutDir, "report.md"), "utf8"), "branch report\n");
  await cliJson(baseUrl, ["runs", "stop", checkoutPlan.run.id]);
  const checkoutSessionName = `checkout-session-${process.pid}`;
  await fs.mkdir(path.join(".threadbeat", "worker-sessions"), { recursive: true });
  await fs.writeFile(path.join(".threadbeat", "worker-sessions", `${checkoutSessionName}.json`), `${JSON.stringify({
    session: checkoutSessionName,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", checkoutAgent.agent.id],
    workers: [],
  })}\n`);
  const sessionCheckoutDir = path.join(tempRoot, "session-checkouts");
  const checkedOutSession = await cliJson<{
    session: string;
    dir: string;
    total: number;
    checkouts: Array<{
      run: { id: string; status: string; branchName: string; resultCommit: string | null };
      checkout: { dir: string; headCommit: string; matchesResultCommit: boolean | null };
      review: { changedFiles: Array<{ status: string; path: string }> };
    }>;
  }>(baseUrl, [
    "runs",
    "checkout-session",
    checkoutSessionName,
    "--dir",
    sessionCheckoutDir,
  ]);
  assert.equal(checkedOutSession.session, checkoutSessionName);
  assert.equal(checkedOutSession.dir, sessionCheckoutDir);
  assert.equal(checkedOutSession.total, 1);
  assert.equal(checkedOutSession.checkouts[0].run.id, checkoutPlan.run.id);
  assert.equal(checkedOutSession.checkouts[0].run.status, "stopped");
  assert.equal(checkedOutSession.checkouts[0].run.branchName, checkoutPlan.plan.branchName);
  assert.equal(checkedOutSession.checkouts[0].checkout.dir, path.join(sessionCheckoutDir, checkoutPlan.run.id));
  assert.equal(checkedOutSession.checkouts[0].checkout.headCommit, expectedCheckoutHead);
  assert.equal(checkedOutSession.checkouts[0].checkout.matchesResultCommit, null);
  assert.deepEqual(checkedOutSession.checkouts[0].review.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.equal(await fs.readFile(path.join(sessionCheckoutDir, checkoutPlan.run.id, "report.md"), "utf8"), "branch report\n");
  const workerCheckoutPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    checkoutAgent.agent.id,
    "--objective",
    "checkout one worker branch",
  ]);
  await execFileAsync("git", ["-C", checkoutSeed, "checkout", "-B", workerCheckoutPlan.plan.branchName, "main"]);
  await fs.writeFile(path.join(checkoutSeed, "worker-report.md"), "worker branch report\n");
  await execFileAsync("git", ["-C", checkoutSeed, "add", "worker-report.md"]);
  await execFileAsync("git", ["-C", checkoutSeed, "commit", "-m", "Write worker branch report"]);
  await execFileAsync("git", ["-C", checkoutSeed, "push", "origin", `HEAD:${workerCheckoutPlan.plan.branchName}`]);
  const expectedWorkerCheckoutHead = (await execFileAsync("git", ["-C", checkoutSeed, "rev-parse", "HEAD"])).stdout.trim();
  await cliJson(baseUrl, [
    "runs",
    "claim",
    workerCheckoutPlan.run.id,
    "--worker-id",
    "smoke-checkout-worker",
  ]);
  await cliJson(baseUrl, ["runs", "sandbox", workerCheckoutPlan.run.id]);
  await cliJson(baseUrl, ["runs", "stop", workerCheckoutPlan.run.id]);
  const workerSessionCheckoutDir = path.join(tempRoot, "worker-session-checkouts");
  const checkedOutWorkerSession = await cliJson<{
    total: number;
    checkouts: Array<{
      run: { id: string; branchName: string; resultCommit: string | null };
      checkout: { dir: string; headCommit: string };
      review: { changedFiles: Array<{ status: string; path: string }> };
    }>;
  }>(baseUrl, [
    "runs",
    "checkout-session",
    checkoutSessionName,
    "--dir",
    workerSessionCheckoutDir,
    "--resumable",
    "--worker-id",
    "smoke-checkout-worker",
  ]);
  assert.equal(checkedOutWorkerSession.total, 1);
  assert.equal(checkedOutWorkerSession.checkouts[0].run.id, workerCheckoutPlan.run.id);
  assert.equal(checkedOutWorkerSession.checkouts[0].run.branchName, workerCheckoutPlan.plan.branchName);
  assert.equal(checkedOutWorkerSession.checkouts[0].run.resultCommit, null);
  assert.equal(checkedOutWorkerSession.checkouts[0].checkout.dir, path.join(workerSessionCheckoutDir, workerCheckoutPlan.run.id));
  assert.equal(checkedOutWorkerSession.checkouts[0].checkout.headCommit, expectedWorkerCheckoutHead);
  assert.deepEqual(checkedOutWorkerSession.checkouts[0].review.changedFiles, [{ status: "A", path: "worker-report.md" }]);
  assert.equal(
    await fs.readFile(path.join(workerSessionCheckoutDir, workerCheckoutPlan.run.id, "worker-report.md"), "utf8"),
    "worker branch report\n",
  );
  const resultsCheckoutDir = path.join(tempRoot, "results-checkouts");
  const checkedOutResults = await cliJson<{
    checkoutDir: string;
    agents: Array<{
      agentId: string;
      runs: Array<{
        id: string;
        status: string;
        checkout?: { dir: string; headCommit: string; matchesResultCommit: boolean | null };
        review?: { changedFiles: Array<{ status: string; path: string }> };
      }>;
    }>;
  }>(baseUrl, [
    "runs",
    "results",
    "--agent",
    checkoutAgent.agent.id,
    "--status",
    "stopped",
    "--checkout-dir",
    resultsCheckoutDir,
  ]);
  const checkedOutResultRun = checkedOutResults.agents
    .find((agent) => agent.agentId === checkoutAgent.agent.id)
    ?.runs.find((run) => run.id === checkoutPlan.run.id);
  assert.equal(checkedOutResults.checkoutDir, resultsCheckoutDir);
  assert.equal(checkedOutResultRun?.status, "stopped");
  assert.equal(checkedOutResultRun?.checkout?.dir, path.join(resultsCheckoutDir, checkoutPlan.run.id));
  assert.equal(checkedOutResultRun?.checkout?.headCommit, expectedCheckoutHead);
  assert.equal(checkedOutResultRun?.checkout?.matchesResultCommit, null);
  assert.deepEqual(checkedOutResultRun?.review?.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.equal(await fs.readFile(path.join(resultsCheckoutDir, checkoutPlan.run.id, "report.md"), "utf8"), "branch report\n");
  const sessionReviewCheckoutDir = path.join(tempRoot, "session-review-checkouts");
  const checkedOutSessionReview = await cliJson<{
    checkoutDir: string;
    recoveryPreview: Array<{ runId: string; currentStatus?: string; dryRun?: boolean }>;
    resultCheckouts: Array<{
      agentId: string;
      total: number;
      checkouts: Array<{
        run: { id: string; status: string; branchName: string };
        checkout: { dir: string; headCommit: string };
        review: { changedFiles: Array<{ status: string; path: string }> };
      }>;
    }>;
  }>(baseUrl, [
    "runs",
    "session-review",
    checkoutSessionName,
    "--include-stopped",
    "--checkout-dir",
    sessionReviewCheckoutDir,
  ]);
  const checkedOutReviewRun = checkedOutSessionReview.resultCheckouts
    .find((agent) => agent.agentId === checkoutAgent.agent.id)
    ?.checkouts.find((item) => item.run.id === checkoutPlan.run.id);
  assert.equal(checkedOutSessionReview.checkoutDir, sessionReviewCheckoutDir);
  assert.ok(checkedOutSessionReview.recoveryPreview.some((run) => (
    run.runId === checkoutPlan.run.id && run.currentStatus === "stopped" && run.dryRun === true
  )));
  assert.equal(checkedOutReviewRun?.run.status, "stopped");
  assert.equal(checkedOutReviewRun?.run.branchName, checkoutPlan.plan.branchName);
  assert.equal(checkedOutReviewRun?.checkout.dir, path.join(sessionReviewCheckoutDir, checkoutPlan.run.id));
  assert.equal(checkedOutReviewRun?.checkout.headCommit, expectedCheckoutHead);
  assert.deepEqual(checkedOutReviewRun?.review.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.equal(await fs.readFile(path.join(sessionReviewCheckoutDir, checkoutPlan.run.id, "report.md"), "utf8"), "branch report\n");

  const cliStopPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli stopped run",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliStopPlan.run.id,
  ]);
  const cliStoppedRun = await cliJson<{ run: { status: string } }>(baseUrl, [
    "runs",
    "get",
    cliStopPlan.run.id,
  ]);
  assert.equal(cliStoppedRun.run.status, "stopped");

  const stopMatchingAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-stop-matching-agent",
      repoUrl: "https://github.com/example/agent.git",
      currentRef: "main",
    },
  });
  assert.equal(stopMatchingAgentResponse.statusCode, 200);
  const stopMatchingAgentBody = JSON.parse(stopMatchingAgentResponse.body) as { agent: { id: string } };
  const stopMatchingRunA = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    stopMatchingAgentBody.agent.id,
    "--objective",
    "cli stopped matching run a",
  ]);
  const stopMatchingRunB = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    stopMatchingAgentBody.agent.id,
    "--objective",
    "cli stopped matching run b",
  ]);
  const stoppedMatching = await cliJson<{
    stopped: Array<{ runId: string; previousStatus: string }>;
  }>(baseUrl, [
    "runs",
    "stop-matching",
    "--agent",
    stopMatchingAgentBody.agent.id,
  ]);
  assert.deepEqual(
    stoppedMatching.stopped.map((run) => run.runId).sort(),
    [stopMatchingRunA.run.id, stopMatchingRunB.run.id].sort(),
  );
  assert.ok(stoppedMatching.stopped.every((run) => run.previousStatus === "planned"));
  const stoppedMatchingList = await cliJson<{ runs: Array<{ id: string; status: string }> }>(baseUrl, [
    "runs",
    "list",
    "--agent",
    stopMatchingAgentBody.agent.id,
    "--status",
    "stopped",
  ]);
  assert.ok(stoppedMatchingList.runs.every((run) => run.status === "stopped"));
  const stoppedMatchingBacklog = await cliJson<{
    agents: Array<{ agentId: string; resumableStopped: number; statuses: Record<string, number> }>;
  }>(baseUrl, [
    "runs",
    "backlog",
    "--agent",
    stopMatchingAgentBody.agent.id,
  ]);
  assert.ok(stoppedMatchingBacklog.agents.some((agent) => (
    agent.agentId === stopMatchingAgentBody.agent.id
    && agent.statuses.stopped === 2
    && agent.resumableStopped === 2
  )));
  const stoppedMatchingMonitor = await cliRaw(baseUrl, [
    "runs",
    "monitor",
    "--agent",
    stopMatchingAgentBody.agent.id,
    "--status",
    "stopped",
  ]);
  const stoppedMonitored = JSON.parse(stoppedMatchingMonitor.stdout.trim()) as {
    agents: Array<{ runs: Array<{ id: string; status: string; resumable: boolean }> }>;
  };
  assert.ok(stoppedMonitored.agents.some((agent) => (
    agent.runs.length === 2 && agent.runs.every((run) => run.status === "stopped" && run.resumable)
  )));
  const stoppedMatchingBranches = await cliJson<{
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number };
      runs: Array<{ id: string; status: string; state: string; resultCommit: string | null }>;
    }>;
  }>(baseUrl, [
    "runs",
    "branches",
    "--agent",
    stopMatchingAgentBody.agent.id,
  ]);
  assert.ok(stoppedMatchingBranches.agents.some((agent) => (
    agent.agentId === stopMatchingAgentBody.agent.id
    && agent.summary.total === 2
    && agent.summary.resultCommits === 0
    && agent.summary.resumable === 2
    && agent.runs.every((run) => run.status === "stopped" && run.state === "resumable" && run.resultCommit === null)
  )));

  const cliRestartPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli restarted run",
  ]);
  const cliRestartInitialSandbox = await cliJson<{ sandbox: { id: string } }>(baseUrl, [
    "runs",
    "sandbox",
    cliRestartPlan.run.id,
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliRestartPlan.run.id,
  ]);
  const cliRestartedSandbox = await cliJson<{
    sandbox: { id: string };
  }>(baseUrl, [
    "runs",
    "restart-sandbox",
    cliRestartPlan.run.id,
  ]);
  assert.notEqual(cliRestartedSandbox.sandbox.id, cliRestartInitialSandbox.sandbox.id);
  const cliRestartedRun = await cliJson<{ run: { status: string } }>(baseUrl, [
    "runs",
    "get",
    cliRestartPlan.run.id,
  ]);
  assert.equal(cliRestartedRun.run.status, "running");
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliRestartPlan.run.id,
  ]);

  const cliResumePlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli resumed run",
  ]);
  const cliResumedStarted = await cliJson<{
    action: string;
    run: { status: string };
    sandbox: { id: string };
  }>(baseUrl, [
    "runs",
    "resume",
    cliResumePlan.run.id,
    "--no-bootstrap",
  ]);
  assert.equal(cliResumedStarted.action, "started");
  assert.equal(cliResumedStarted.run.status, "running");
  const cliResumedExisting = await cliJson<{
    action: string;
    sandbox: { id: string };
  }>(baseUrl, [
    "runs",
    "resume",
    cliResumePlan.run.id,
    "--no-bootstrap",
  ]);
  assert.equal(cliResumedExisting.action, "existing");
  assert.equal(cliResumedExisting.sandbox.id, cliResumedStarted.sandbox.id);
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliResumePlan.run.id,
  ]);
  const cliResumedRestarted = await cliJson<{
    action: string;
    run: { status: string };
    sandbox: { id: string };
  }>(baseUrl, [
    "runs",
    "resume",
    cliResumePlan.run.id,
    "--no-bootstrap",
  ]);
  assert.equal(cliResumedRestarted.action, "restarted");
  assert.equal(cliResumedRestarted.run.status, "running");
  assert.notEqual(cliResumedRestarted.sandbox.id, cliResumedStarted.sandbox.id);
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliResumePlan.run.id,
  ]);

  const cliResumeWorkAgent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "resume-work-agent",
    "--repo",
    "https://github.com/example/resume-work",
  ]);
  const cliResumeWorkPlan = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    cliResumeWorkAgent.agent.id,
    "--objective",
    "resume stopped branch from work loop",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "sandbox",
    cliResumeWorkPlan.run.id,
  ]);
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliResumeWorkPlan.run.id,
  ]);
  const cliResumeStoppedWork = await cliJson<{
    processed: Array<{ action: string; runId: string; status: { run: { status: string } } }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    cliResumeWorkAgent.agent.id,
    "--resume-stopped",
    "--no-bootstrap",
    "--until-empty",
    "--limit",
    "1",
  ]);
  assert.equal(cliResumeStoppedWork.processed.length, 1);
  assert.equal(cliResumeStoppedWork.processed[0].runId, cliResumeWorkPlan.run.id);
  assert.equal(cliResumeStoppedWork.processed[0].action, "restarted");
  assert.equal(cliResumeStoppedWork.processed[0].status.run.status, "running");
  await cliJson(baseUrl, [
    "runs",
    "stop",
    cliResumeWorkPlan.run.id,
  ]);

  const cliWorkFinalizeAgent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "work-finalize-agent",
    "--repo",
    "https://github.com/example/work-finalize",
  ]);
  const cliWorkFinalizePlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    cliWorkFinalizeAgent.agent.id,
    "--objective",
    "worker finalize visibility",
  ]);
  const cliWorkFinalized = await cliJson<{
    processed: Array<{
      runId: string;
      branch: { baseRef: string; branchName: string; resultCommit: string | null; status: string };
      finalized: { result: { commitSha: string } };
      status: { run: { status: string; result_commit: string | null } };
    }>;
  }>(baseUrl, [
    "runs",
    "work",
    "--agent",
    cliWorkFinalizeAgent.agent.id,
    "--bootstrap",
    "--boot",
    "--finalize",
    "--message",
    "Finalize worker smoke",
    "--until-empty",
    "--limit",
    "1",
  ]);
  assert.equal(cliWorkFinalized.processed.length, 1);
  assert.equal(cliWorkFinalized.processed[0].runId, cliWorkFinalizePlan.run.id);
  assert.equal(cliWorkFinalized.processed[0].branch.baseRef, "main");
  assert.equal(cliWorkFinalized.processed[0].branch.branchName, cliWorkFinalizePlan.plan.branchName);
  assert.equal(cliWorkFinalized.processed[0].branch.status, "completed");
  assert.equal(cliWorkFinalized.processed[0].branch.resultCommit, cliWorkFinalized.processed[0].finalized.result.commitSha);
  assert.equal(cliWorkFinalized.processed[0].status.run.status, "completed");
  assert.equal(cliWorkFinalized.processed[0].status.run.result_commit, cliWorkFinalized.processed[0].finalized.result.commitSha);
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", cliWorkFinalizePlan.run.id]);

  const cliStep = await cliJson<{
    result: { stdout: string };
    finalized: { commitSha: string };
    status: { run: { id: string; status: string }; sandboxes: Array<{ state: string }> };
  }>(baseUrl, [
    "runs",
    "step",
    "--agent",
    agentBody.agent.id,
    "--objective",
    "cli step run",
    "--bootstrap",
    "--finalize",
    "--message",
    "Finalize step smoke",
    "--",
    "pwd",
  ]);
  assert.match(cliStep.result.stdout, /\/workspace\/agent/);
  assert.equal(cliStep.status.run.status, "completed");
  assert.match(cliStep.finalized?.commitSha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(cliStep.status.sandboxes.some((sandbox) => sandbox.state === "running"));

  const cliStepCleanup = await cliJson<{ stoppedCount: number }>(baseUrl, [
    "sandboxes",
    "stop-running",
    "--run",
    cliStep.status.run.id,
  ]);
  assert.equal(cliStepCleanup.stoppedCount, 1);

  await cliJson<{ sandbox: { id: string } }>(baseUrl, [
    "sandboxes",
    "stop",
    cliRunSandbox.sandbox.id,
  ]);

  const hostedGitList = await cliJson<{ hostedGitRepos: unknown[] }>(baseUrl, [
    "hosted-git",
    "list",
  ]);
  assert.equal(hostedGitList.hostedGitRepos.length, 0);

  const cliSandbox = await cliJson<{ sandbox: { id: string } }>(baseUrl, [
    "sandboxes",
    "get",
    sandboxBody.sandbox.id,
  ]);
  assert.equal(cliSandbox.sandbox.id, sandboxBody.sandbox.id);

  const cliMessages = await cliJson<{ messages: unknown[] }>(baseUrl, [
    "messages",
    "list",
    "--sandbox",
    sandboxBody.sandbox.id,
    "--limit",
    "5",
  ]);
  assert.ok(cliMessages.messages.length > 0);
} finally {
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await cliRaw(baseUrl, args);
  return JSON.parse(stdout) as T;
}

async function cliRaw(baseUrl: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
  });
}
