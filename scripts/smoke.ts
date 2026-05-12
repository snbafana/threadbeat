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
      runs: Array<{
        id: string;
        status: string;
        objective: string;
        branchName: string;
        resultCommit: string | null;
        workerId: string | null;
        messages: Array<{ type: string }>;
      }>;
    }>;
  };
  assert.deepEqual(
    monitored.agents.map((agent) => agent.agentId).sort(),
    [workerAgentBody.agent.id, launchAgentBody.agent.id].sort(),
  );
  assert.ok(monitored.agents.some((agent) => agent.runs.some((run) => (
    run.id === workerRunA.run.id
    && run.status === "planned"
    && run.objective === "cli worker run a"
    && run.branchName.startsWith("threadbeat/runs/")
    && run.resultCommit === null
  ))));
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
  const plannedMonitorNext = await cliJson<{
    summary: { runs: number; statuses: Record<string, number>; resumable: number; warnings: number };
    checkoutDir: string;
    nextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      objective: string;
      branchName: string;
      resultCommit: string | null;
      warning: string | null;
      resumable: boolean;
      command: string[];
      commands: {
        claimRun: string[];
        watchRun: string[];
        inspectRun: string[];
        checkoutBranch: string[];
        reviewRun: string[];
        resumeBranch: string[] | null;
      };
    }>;
    agents?: unknown;
  }>(baseUrl, [
    "runs",
    "monitor",
    "--agents",
    `${workerAgentBody.agent.id},${launchAgentBody.agent.id}`,
    "--status",
    "planned",
    "--next",
    "--checkout-dir",
    "./checkouts/monitor-next",
  ]);
  assert.equal(plannedMonitorNext.agents, undefined);
  assert.equal(plannedMonitorNext.checkoutDir, "./checkouts/monitor-next");
  assert.ok(plannedMonitorNext.summary.runs >= 2);
  assert.ok(plannedMonitorNext.summary.statuses.planned >= 2);
  assert.equal(plannedMonitorNext.summary.resumable, 0);
  assert.equal(plannedMonitorNext.summary.warnings, 0);
  assert.ok(plannedMonitorNext.nextSteps.some((step) => (
    step.action === "claim_run"
    && step.reason === "queued_run"
    && step.runId === workerRunA.run.id
    && step.objective === "cli worker run a"
    && step.branchName.startsWith("threadbeat/runs/")
    && step.resultCommit === null
    && step.warning === null
    && step.resumable === false
    && step.command.join(" ") === `npm run cli -- runs claim ${workerRunA.run.id}`
    && step.commands.claimRun.join(" ") === `npm run cli -- runs claim ${workerRunA.run.id}`
    && step.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${workerRunA.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${workerRunA.run.id} --dir ./checkouts/monitor-next/${workerRunA.run.id}`
    && step.commands.reviewRun.join(" ") === `npm run cli -- runs review ${workerRunA.run.id} --checkout-dir ./checkouts/monitor-next/${workerRunA.run.id}`
    && step.commands.resumeBranch === null
  )));

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
  const inlineQueued = await cliJson<{
    assignment: string;
    queued: Array<{ agentId: string; objective: string; run: { status: string } }>;
  }>(baseUrl, [
    "runs",
    "queue",
    "--agents",
    `${queueAgentBody.agent.id},${queuePeerBody.agent.id}`,
    "--objective",
    "inline queue objective",
    "--assignment",
    "round-robin",
  ]);
  assert.equal(inlineQueued.assignment, "round-robin");
  assert.deepEqual(inlineQueued.queued.map((item) => item.objective), ["inline queue objective"]);
  assert.deepEqual(inlineQueued.queued.map((item) => item.agentId), [queueAgentBody.agent.id]);
  assert.ok(inlineQueued.queued.every((item) => item.run.status === "planned"));

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
  const detachedResultPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objective",
    "detached session completed result branch",
  ]);
  await cliJson(baseUrl, [
    "runs",
    "claim",
    detachedResultPlan.run.id,
    "--worker-id",
    "smoke-detached-worker-1",
  ]);
  await cliJson(baseUrl, ["runs", "sandbox", detachedResultPlan.run.id]);
  await cliJson(baseUrl, ["runs", "boot", detachedResultPlan.run.id]);
  const detachedResultFinalized = await cliJson<{ result: { commitSha: string } }>(baseUrl, [
    "runs",
    "finalize",
    detachedResultPlan.run.id,
    "--message",
    "Finalize detached session result",
  ]);
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", detachedResultPlan.run.id]);
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
    "300",
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
  const detachedWorkerActions = await cliJson<{
    session: { session: string; workers: number; command: string[] };
    actions: {
      sessionStatus: string[];
      sessionWait: string[];
      sessionWatch: string[];
      sessionSummary: string[];
      sessionSummaryWatch: string[];
      fleetSummary: string[];
      fleetSummaryWatch: string[];
      fleetNeedsAction: string[];
      fleetNeedsActionWatch: string[];
      monitor: string[];
      sessionReview: string[];
      branchQueue: string[];
      results: string[];
      resultsNext: string[];
      changedResults: string[];
      checkoutSession: string[];
      sessionLogs: string[];
      stopSession: string[];
      stopSessionIncludeStopped: string[];
      recoverSession: string[];
      recoverStopped: string[];
      resumeSession: string[];
      restartSession: string[];
      restartSessionWithStopped: string[];
      archiveSessionPreview: string[];
      archiveSession: string[];
    };
  }>(baseUrl, ["runs", "session-actions", detachedWorkerSessionName]);
  assert.equal(detachedWorkerActions.session.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerActions.session.workers, 1);
  assert.equal(detachedWorkerActions.session.command[0], "runs");
  assert.equal(detachedWorkerActions.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${detachedWorkerSessionName} --recoverable --include-stopped`);
  assert.equal(detachedWorkerActions.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${detachedWorkerSessionName}`);
  assert.equal(detachedWorkerActions.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${detachedWorkerSessionName} --recoverable --include-stopped --next`);
  assert.equal(detachedWorkerActions.actions.sessionSummary.join(" "), `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next`);
  assert.equal(detachedWorkerActions.actions.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(detachedWorkerActions.actions.fleetSummary.join(" "), `npm run cli -- runs sessions --session ${detachedWorkerSessionName} --summary --next`);
  assert.equal(detachedWorkerActions.actions.fleetSummaryWatch.join(" "), `npm run cli -- runs sessions --session ${detachedWorkerSessionName} --summary --next --max-polls 30 --interval-ms 10000`);
  assert.equal(detachedWorkerActions.actions.fleetNeedsAction.join(" "), `npm run cli -- runs sessions --session ${detachedWorkerSessionName} --summary --next --needs-action`);
  assert.equal(detachedWorkerActions.actions.fleetNeedsActionWatch.join(" "), `npm run cli -- runs sessions --session ${detachedWorkerSessionName} --summary --next --needs-action --max-polls 30 --interval-ms 10000`);
  assert.equal(detachedWorkerActions.actions.monitor.join(" "), `npm run cli -- runs monitor --agents ${workerGroupAgentBody.agent.id} --status planned,running,stopped --next --checkout-dir ./checkouts/${detachedWorkerSessionName}-monitor`);
  assert.equal(detachedWorkerActions.actions.sessionReview.join(" "), `npm run cli -- runs session-review ${detachedWorkerSessionName} --include-stopped`);
  assert.equal(detachedWorkerActions.actions.branchQueue.join(" "), `npm run cli -- runs branches --session ${detachedWorkerSessionName} --next`);
  assert.equal(detachedWorkerActions.actions.results.join(" "), `npm run cli -- runs results --session ${detachedWorkerSessionName}`);
  assert.equal(detachedWorkerActions.actions.resultsNext.join(" "), `npm run cli -- runs results --session ${detachedWorkerSessionName} --next`);
  assert.equal(detachedWorkerActions.actions.changedResults.join(" "), `npm run cli -- runs results --session ${detachedWorkerSessionName} --checkout-dir ./checkouts/${detachedWorkerSessionName}-results --changed-only --next`);
  assert.equal(detachedWorkerActions.actions.checkoutSession.join(" "), `npm run cli -- runs checkout-session ${detachedWorkerSessionName} --dir ./checkouts/${detachedWorkerSessionName}`);
  assert.equal(detachedWorkerActions.actions.sessionLogs.join(" "), `npm run cli -- runs session-logs ${detachedWorkerSessionName}`);
  assert.equal(detachedWorkerActions.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${detachedWorkerSessionName} --recover`);
  assert.equal(detachedWorkerActions.actions.stopSessionIncludeStopped.join(" "), `npm run cli -- runs stop-session ${detachedWorkerSessionName} --recover --include-stopped`);
  assert.equal(detachedWorkerActions.actions.recoverSession.join(" "), `npm run cli -- runs recover-session ${detachedWorkerSessionName}`);
  assert.equal(detachedWorkerActions.actions.recoverStopped.join(" "), `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`);
  assert.equal(detachedWorkerActions.actions.resumeSession.join(" "), `npm run cli -- runs resume-session ${detachedWorkerSessionName}`);
  assert.equal(detachedWorkerActions.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${detachedWorkerSessionName} --recover`);
  assert.equal(detachedWorkerActions.actions.restartSessionWithStopped.join(" "), `npm run cli -- runs restart-session ${detachedWorkerSessionName} --recover --resume-stopped`);
  assert.equal(detachedWorkerActions.actions.archiveSessionPreview.join(" "), `npm run cli -- runs archive-sessions --session ${detachedWorkerSessionName} --dry-run`);
  assert.equal(detachedWorkerActions.actions.archiveSession.join(" "), `npm run cli -- runs archive-sessions --session ${detachedWorkerSessionName}`);
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
    branchNextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      objective: string;
      workerId: string | null;
      location: string;
      recoverable: boolean;
      command: string[];
      commands: { checkoutBranch: string[]; resumeBranch: string[]; recoverStopped: string[] | null };
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
  assert.ok(detachedWorkerRecoverableStatus.branchNextSteps.some((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.runId === detachedStoppedPlan.run.id
    && step.objective === "detached session resumable stopped branch"
    && step.workerId === null
    && step.location === "unassigned"
    && step.recoverable === true
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && step.commands.resumeBranch.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.recoverStopped?.join(" ") === `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`
  )));
  const detachedWorkerRecoverableStatusCommands = await cliJson<{
    filter: { branchAction: string[]; totalBranchNextSteps: number };
    branchActions: Record<string, number>;
    commands: Array<{
      scope: string;
      action: string;
      runId?: string;
      resultCommit?: string | null;
      command: string[];
    }>;
    branchNextSteps?: unknown;
  }>(baseUrl, [
    "runs",
    "session-status",
    detachedWorkerSessionName,
    "--recoverable",
    "--include-stopped",
    "--next",
    "--commands-only",
    "--branch-action",
    "resume_branch",
  ]);
  assert.deepEqual(detachedWorkerRecoverableStatusCommands.filter.branchAction, ["resume_branch"]);
  assert.ok(detachedWorkerRecoverableStatusCommands.filter.totalBranchNextSteps >= 1);
  assert.ok(detachedWorkerRecoverableStatusCommands.branchActions.resume_branch >= 1);
  assert.equal(detachedWorkerRecoverableStatusCommands.branchNextSteps, undefined);
  assert.ok(detachedWorkerRecoverableStatusCommands.commands.some((item) => (
    item.scope === "branch"
    && item.action === "resume_branch"
    && item.runId === detachedStoppedPlan.run.id
    && item.resultCommit === null
    && item.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  const detachedWorkerRecoverableStatusShell = await cliRaw(baseUrl, [
    "runs",
    "session-status",
    detachedWorkerSessionName,
    "--recoverable",
    "--include-stopped",
    "--next",
    "--commands-only",
    "--branch-action",
    "resume_branch",
    "--format",
    "shell",
  ]);
  assert.ok(detachedWorkerRecoverableStatusShell.stdout.trim().split("\n").includes(
    `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`,
  ));
  const detachedWorkerSummary = await cliJson<{
    session: { session: string; workers: { total: number; alive: number; dead: number } };
    totals: { runs: number; statuses: Record<string, number>; resultCommits: number; resumableStopped: number };
    resumableBranches: Array<{
      agentId: string;
      runId: string;
      status: string;
      resultCommit: string | null;
      location: string;
      commands: { inspectRun: string[]; checkoutBranch: string[]; reviewRun: string[]; resumeBranch: string[] };
    }>;
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
  assert.ok(detachedWorkerSummary.resumableBranches.some((run) => (
    run.agentId === workerGroupAgentBody.agent.id
    && run.runId === detachedStoppedPlan.run.id
    && run.status === "stopped"
    && run.resultCommit === null
    && run.location === "unassigned"
    && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${detachedStoppedPlan.run.id}`
    && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${detachedStoppedPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && run.commands.resumeBranch.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  const detachedWorkerSummaryCommands = await cliJson<{
    filter: { branchAction: string[]; totalActions: number; totalBranchActions: number };
    nextActions: Record<string, number>;
    branchActions: Record<string, number>;
    commands: Array<{ scope: string; action: string; runId?: string; resultCommit?: string | null; command: string[] }>;
    resumableBranches?: unknown;
    resultCommits?: unknown;
  }>(baseUrl, [
    "runs",
    "session-summary",
    detachedWorkerSessionName,
    "--next",
    "--commands-only",
    "--branch-action",
    "resume_branch",
  ]);
  assert.deepEqual(detachedWorkerSummaryCommands.filter.branchAction, ["resume_branch"]);
  assert.equal(detachedWorkerSummaryCommands.filter.totalActions, 1);
  assert.ok(detachedWorkerSummaryCommands.filter.totalBranchActions >= 1);
  assert.equal(detachedWorkerSummaryCommands.nextActions.continue_watch, 1);
  assert.ok(detachedWorkerSummaryCommands.branchActions.resume_branch >= 1);
  assert.equal(detachedWorkerSummaryCommands.resumableBranches, undefined);
  assert.equal(detachedWorkerSummaryCommands.resultCommits, undefined);
  assert.ok(detachedWorkerSummaryCommands.commands.some((item) => (
    item.scope === "branch"
    && item.action === "resume_branch"
    && item.runId === detachedStoppedPlan.run.id
    && item.resultCommit === null
    && item.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  const detachedWorkerSummaryCommandsShell = await cliRaw(baseUrl, [
    "runs",
    "session-summary",
    detachedWorkerSessionName,
    "--next",
    "--commands-only",
    "--branch-action",
    "resume_branch",
    "--format",
    "shell",
  ]);
  assert.ok(detachedWorkerSummaryCommandsShell.stdout.trim().split("\n").includes(
    `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`,
  ));
  const workerFleetSummary = await cliJson<{
    totals: { sessions: number; unavailable: number; workers: { alive: number }; resumableStopped: number };
    branchActions: Record<string, number>;
    branchActionQueue: Array<{
      session: string;
      action: string;
      reason: string;
      agentId: string;
      runId: string;
      resultCommit: string | null;
      command: string[];
    }>;
    resumableBranches: Array<{
      session: string;
      agentId: string;
      runId: string;
      status: string;
      resultCommit: string | null;
      location: string;
      commands: {
        inspectRun: string[];
        checkoutBranch: string[];
        reviewRun: string[];
        resumeBranch: string[];
        sessionBranches: string[];
      };
    }>;
    sessions: Array<{
      session: { session: string; workers?: { alive: number } };
      totals?: { resumableStopped: number };
      resumableBranches?: Array<{ runId: string; resultCommit: string | null }>;
      nextStep?: { action: string; reason: string; command: string[] };
      commands?: { sessionSummaryWatch: string[] };
      error?: string;
    }>;
  }>(baseUrl, ["runs", "sessions", "--summary", "--next"]);
  assert.ok(workerFleetSummary.totals.sessions >= 1);
  assert.ok(workerFleetSummary.totals.workers.alive >= 1);
  assert.ok(workerFleetSummary.totals.resumableStopped >= 1);
  assert.ok(workerFleetSummary.branchActions.resume_branch >= 1);
  assert.ok(workerFleetSummary.branchActionQueue.some((run) => (
    run.session === detachedWorkerSessionName
    && run.action === "resume_branch"
    && run.reason === "stopped_branch_without_result_commit"
    && run.agentId === workerGroupAgentBody.agent.id
    && run.runId === detachedStoppedPlan.run.id
    && run.resultCommit === null
    && run.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  assert.ok(workerFleetSummary.resumableBranches.some((run) => (
    run.session === detachedWorkerSessionName
    && run.agentId === workerGroupAgentBody.agent.id
    && run.runId === detachedStoppedPlan.run.id
    && run.status === "stopped"
    && run.resultCommit === null
    && run.location === "unassigned"
    && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${detachedStoppedPlan.run.id}`
    && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${detachedStoppedPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && run.commands.resumeBranch.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && run.commands.sessionBranches.join(" ") === `npm run cli -- runs branches --session ${detachedWorkerSessionName} --next`
  )));
  const detachedFleetSession = workerFleetSummary.sessions.find((session) => session.session.session === detachedWorkerSessionName);
  assert.ok(detachedFleetSession);
  assert.equal(detachedFleetSession?.error, undefined);
  assert.equal(detachedFleetSession?.session.workers?.alive, 1);
  assert.ok((detachedFleetSession?.totals?.resumableStopped ?? 0) >= 1);
  assert.ok(detachedFleetSession?.resumableBranches?.some((run) => (
    run.runId === detachedStoppedPlan.run.id
    && run.resultCommit === null
  )));
  assert.equal(detachedFleetSession?.nextStep?.action, "continue_watch");
  assert.equal(detachedFleetSession?.nextStep?.reason, "workers_still_alive");
  assert.equal(detachedFleetSession?.nextStep?.command.join(" "), `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(detachedFleetSession?.commands?.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next --max-polls 30 --interval-ms 10000`);
  const workerFleetSummaryPoll = await cliRaw(baseUrl, [
    "runs",
    "sessions",
    "--session",
    detachedWorkerSessionName,
    "--summary",
    "--next",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  const workerFleetSummarySnapshots = workerFleetSummaryPoll.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    observedAt: string;
    totals: { sessions: number; resumableStopped: number };
    nextActions: Record<string, number>;
    actionQueue: Array<{ session: string; action: string; reason: string; command: string[] }>;
    branchActions: Record<string, number>;
    branchActionQueue: Array<{ session: string; action: string; runId: string; resultCommit: string | null; command: string[] }>;
    resumableBranches: Array<{ runId: string; resultCommit: string | null }>;
    sessions: Array<{
      session: { session: string };
      nextStep?: { action: string };
    }>;
  });
  assert.equal(workerFleetSummarySnapshots.length, 2);
  assert.ok(workerFleetSummarySnapshots.every((snapshot) => (
    /^\d{4}-\d{2}-\d{2}T/.test(snapshot.observedAt)
    && snapshot.totals.sessions === 1
    && snapshot.totals.resumableStopped >= 1
    && snapshot.nextActions.continue_watch === 1
    && snapshot.actionQueue.some((item) => (
      item.session === detachedWorkerSessionName
      && item.action === "continue_watch"
      && item.reason === "workers_still_alive"
      && item.command.join(" ") === `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next --max-polls 30 --interval-ms 10000`
    ))
    && snapshot.branchActions.resume_branch >= 1
    && snapshot.branchActionQueue.some((run) => (
      run.session === detachedWorkerSessionName
      && run.action === "resume_branch"
      && run.runId === detachedStoppedPlan.run.id
      && run.resultCommit === null
      && run.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    ))
    && snapshot.resumableBranches.some((run) => (
      run.runId === detachedStoppedPlan.run.id
      && run.resultCommit === null
    ))
    && snapshot.sessions.some((session) => (
      session.session.session === detachedWorkerSessionName
      && session.nextStep?.action === "continue_watch"
    ))
  )));
  const workerFleetNeedsAction = await cliJson<{
    filter: { needsAction: true; totalSessions: number };
    totals: { sessions: number; workers: { alive: number }; resumableStopped: number };
    nextActions: Record<string, number>;
    actionQueue: Array<{ session: string; action: string }>;
    branchActions: Record<string, number>;
    branchActionQueue: Array<{ session: string; action: string }>;
    resumableBranches: Array<{ runId: string }>;
    sessions: Array<{ session: { session: string }; nextStep?: { action: string } }>;
  }>(baseUrl, [
    "runs",
    "sessions",
    "--session",
    detachedWorkerSessionName,
    "--summary",
    "--next",
    "--needs-action",
  ]);
  assert.equal(workerFleetNeedsAction.filter.needsAction, true);
  assert.equal(workerFleetNeedsAction.filter.totalSessions, 1);
  assert.equal(workerFleetNeedsAction.totals.sessions, 0);
  assert.equal(workerFleetNeedsAction.totals.workers.alive, 0);
  assert.equal(workerFleetNeedsAction.totals.resumableStopped, 0);
  assert.deepEqual(workerFleetNeedsAction.nextActions, {});
  assert.deepEqual(workerFleetNeedsAction.actionQueue, []);
  assert.deepEqual(workerFleetNeedsAction.branchActions, {});
  assert.deepEqual(workerFleetNeedsAction.branchActionQueue, []);
  assert.equal(workerFleetNeedsAction.resumableBranches.length, 0);
  assert.equal(workerFleetNeedsAction.sessions.length, 0);
  const detachedWorkerBranches = await cliJson<{
    observedAt: string;
    session: string;
    checkoutDir: string;
    summary: { total: number; resultCommits: number; resumable: number; warnings: number };
    agents: Array<{
      agentId: string;
      summary: { total: number; resultCommits: number; resumable: number; warnings: number };
      runs: Array<{
        id: string;
        status: string;
        state: string;
        warning: string | null;
        resultCommit: string | null;
        location: string;
        commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[]; resumeBranch: string[] | null };
        links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
      }>;
    }>;
  }>(baseUrl, ["runs", "branches", "--session", detachedWorkerSessionName]);
  assert.match(detachedWorkerBranches.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(detachedWorkerBranches.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerBranches.checkoutDir, `./checkouts/${detachedWorkerSessionName}-branches`);
  assert.ok(detachedWorkerBranches.summary.resumable >= 1);
  assert.equal(detachedWorkerBranches.summary.warnings, 0);
  assert.ok(detachedWorkerBranches.agents.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
    && agent.summary.resumable >= 1
    && agent.summary.warnings === 0
    && agent.runs.some((run) => (
      run.id === detachedStoppedPlan.run.id
      && run.status === "stopped"
      && run.state === "resumable"
      && run.warning === null
      && run.resultCommit === null
      && run.location === "unassigned"
      && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-branches/${detachedStoppedPlan.run.id}`
      && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${detachedStoppedPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-branches/${detachedStoppedPlan.run.id}`
      && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${detachedStoppedPlan.run.id}`
      && run.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
      && run.links.branchTreeUrl !== null
      && run.links.resultCommitUrl === null
    ))
  )));
  const detachedWorkerBranchesNext = await cliJson<{
    observedAt: string;
    session: string;
    checkoutDir: string;
    summary: { total: number; resultCommits: number; resumable: number; warnings: number };
    nextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      warning: string | null;
      objective: string;
      workerId: string | null;
      location: string | null;
      command: string[];
      commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[]; resumeBranch: string[] | null };
    }>;
  }>(baseUrl, ["runs", "branches", "--session", detachedWorkerSessionName, "--next"]);
  assert.match(detachedWorkerBranchesNext.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(detachedWorkerBranchesNext.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerBranchesNext.checkoutDir, `./checkouts/${detachedWorkerSessionName}-branches`);
  assert.equal(detachedWorkerBranchesNext.summary.total, detachedWorkerBranches.summary.total);
  assert.ok(detachedWorkerBranchesNext.nextSteps.some((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.runId === detachedStoppedPlan.run.id
    && step.warning === null
    && step.objective === "detached session resumable stopped branch"
    && step.workerId === null
    && step.location === "unassigned"
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-branches/${detachedStoppedPlan.run.id}`
    && step.commands.reviewRun.join(" ") === `npm run cli -- runs review ${detachedStoppedPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-branches/${detachedStoppedPlan.run.id}`
    && step.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${detachedStoppedPlan.run.id}`
    && step.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  const detachedWorkerBranchCommands = await cliJson<{
    summary: { resumable: number };
    commands: Array<{ action: string; runId: string; resultCommit: string | null; command: string[] }>;
    nextSteps?: unknown;
  }>(baseUrl, ["runs", "branches", "--session", detachedWorkerSessionName, "--next", "--commands-only"]);
  assert.ok(detachedWorkerBranchCommands.summary.resumable >= 1);
  assert.equal(detachedWorkerBranchCommands.nextSteps, undefined);
  assert.ok(detachedWorkerBranchCommands.commands.some((item) => (
    item.action === "resume_branch"
    && item.runId === detachedStoppedPlan.run.id
    && item.resultCommit === null
    && item.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  const detachedWorkerBranchCommandsShell = await cliRaw(baseUrl, ["runs", "branches", "--session", detachedWorkerSessionName, "--next", "--commands-only", "--format", "shell"]);
  assert.ok(detachedWorkerBranchCommandsShell.stdout.trim().split("\n").includes(
    `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`,
  ));
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
        commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[] };
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
      && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-results/${detachedStoppedPlan.run.id}`
      && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${detachedStoppedPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-results/${detachedStoppedPlan.run.id}`
      && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${detachedStoppedPlan.run.id}`
      && run.links.branchTreeUrl !== null
      && run.links.resultCommitUrl === null
    ))
  )));
  const detachedWorkerReview = await cliJson<{
    observedAt: string;
    session: { session: string; workers: { total: number; alive: number; dead: number } };
    summary: {
      agents: number;
      resultBranches: number;
      resumableBranches: number;
      recoveryCandidates: number;
      branchNextSteps: number;
      changedResults: number | null;
      changedFiles: number | null;
      agentSummaries: Array<{
        agentId: string;
        resultBranches: number;
        resumableBranches: number;
        recoveryCandidates: number;
        changedResults: number | null;
      }>;
    };
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
    resultBranches: Array<{
      agentId: string;
      runId: string;
      status: string;
      objective: string;
      branchName: string;
      resultCommit: string;
      workerId: string | null;
      location: string;
      commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[] };
    }>;
    recoveryPreview: Array<{ runId: string; currentStatus?: string; dryRun?: boolean; skipped?: string }>;
    actions: {
      restartSession: string[] | null;
      restartSessionWithStopped: string[] | null;
      recoverSession: string[] | null;
      recoverStopped: string[] | null;
      resumeSession: string[] | null;
      sessionSummary: string[];
      sessionSummaryWatch: string[];
      branchQueue: string[];
      changedResults: string[];
    };
    nextSteps: Array<{ action: string; reason: string; count: number; command: string[] }>;
    branchNextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      status: string;
      objective: string;
      workerId: string | null;
      location: string;
      recoverable?: boolean;
      command: string[];
      commands: {
        checkoutBranch: string[];
        reviewRun?: string[];
        inspectRun?: string[];
        resumeBranch?: string[];
        recoverStopped?: string[] | null;
      };
    }>;
    logs: Array<{ workerId: string; alive: boolean; stdout: { lines: string[] }; stderr: { lines: string[] } }>;
  }>(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--lines", "5"]);
  assert.match(detachedWorkerReview.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(detachedWorkerReview.session.session, detachedWorkerSessionName);
  assert.equal(detachedWorkerReview.session.workers.total, 1);
  assert.equal(detachedWorkerReview.session.workers.alive, 1);
  assert.equal(detachedWorkerReview.session.workers.dead, 0);
  assert.ok(detachedWorkerReview.summary.agents >= 1);
  assert.ok(detachedWorkerReview.summary.resultBranches >= 1);
  assert.ok(detachedWorkerReview.summary.resumableBranches >= 1);
  assert.ok(detachedWorkerReview.summary.recoveryCandidates >= 1);
  assert.ok(detachedWorkerReview.summary.branchNextSteps >= 2);
  assert.equal(detachedWorkerReview.summary.changedResults, null);
  assert.equal(detachedWorkerReview.summary.changedFiles, null);
  assert.ok(detachedWorkerReview.summary.agentSummaries.some((agent) => (
    agent.agentId === workerGroupAgentBody.agent.id
    && agent.resultBranches >= 1
    && agent.resumableBranches >= 1
    && agent.recoveryCandidates >= 1
    && agent.changedResults === null
  )));
  assert.equal(detachedWorkerReview.actions.restartSession, null);
  assert.equal(detachedWorkerReview.actions.restartSessionWithStopped, null);
  assert.equal(detachedWorkerReview.actions.sessionSummary.join(" "), `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next`);
  assert.equal(detachedWorkerReview.actions.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${detachedWorkerSessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(
    detachedWorkerReview.actions.recoverStopped?.join(" "),
    `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`,
  );
  assert.equal(
    detachedWorkerReview.actions.resumeSession?.join(" "),
    `npm run cli -- runs resume-session ${detachedWorkerSessionName}`,
  );
  assert.equal(
    detachedWorkerReview.actions.branchQueue.join(" "),
    `npm run cli -- runs branches --session ${detachedWorkerSessionName} --next`,
  );
  assert.equal(
    detachedWorkerReview.actions.changedResults.join(" "),
    `npm run cli -- runs results --session ${detachedWorkerSessionName} --checkout-dir ./checkouts/${detachedWorkerSessionName}-results --changed-only --next`,
  );
  const detachedNextStepActions = detachedWorkerReview.nextSteps.map((step) => step.action);
  assert.ok(detachedNextStepActions.indexOf("recover_stopped") >= 0);
  assert.ok(detachedNextStepActions.indexOf("resume_session") > detachedNextStepActions.indexOf("recover_stopped"));
  assert.ok(detachedNextStepActions.indexOf("review_changed_results") > detachedNextStepActions.indexOf("resume_session"));
  assert.ok(detachedWorkerReview.nextSteps.some((step) => (
    step.action === "recover_stopped"
    && step.reason === "unfinished_stopped_branches"
    && step.count >= 1
    && step.command.join(" ") === `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`
  )));
  assert.ok(detachedWorkerReview.nextSteps.some((step) => (
    step.action === "review_changed_results"
    && step.reason === "result_branches_available"
    && step.count >= 1
  )));
  assert.ok(detachedWorkerReview.branchNextSteps.some((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.runId === detachedStoppedPlan.run.id
    && step.status === "stopped"
    && step.objective === "detached session resumable stopped branch"
    && step.workerId === null
    && step.location === "unassigned"
    && step.recoverable === true
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && step.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.recoverStopped?.join(" ") === `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`
  )));
  assert.ok(detachedWorkerReview.branchNextSteps.some((step) => (
    step.action === "review_branch"
    && step.reason === "result_commit_available"
    && step.runId === detachedResultPlan.run.id
    && step.status === "completed"
    && step.objective === "detached session completed result branch"
    && step.workerId === "smoke-detached-worker-1"
    && step.location === "session_worker"
    && step.command.join(" ") === `npm run cli -- runs review ${detachedResultPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-results/${detachedResultPlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedResultPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-results/${detachedResultPlan.run.id}`
    && step.commands.inspectRun?.join(" ") === `npm run cli -- runs inspect ${detachedResultPlan.run.id}`
  )));
  const detachedNextOnly = await cliJson<{
    session: { session: string };
    summary: { agents: number; resultBranches: number; resumableBranches: number; recoveryCandidates: number; branchNextSteps: number };
    nextSteps: Array<{ action: string; reason: string; count: number; command: string[] }>;
    branchNextSteps: Array<{ action: string; reason: string; runId: string; objective: string; workerId: string | null; recoverable?: boolean; command: string[]; commands: { checkoutBranch: string[]; recoverStopped?: string[] | null } }>;
    agents?: unknown;
    logs?: unknown;
  }>(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--next"]);
  assert.equal(detachedNextOnly.session.session, detachedWorkerSessionName);
  assert.equal(detachedNextOnly.summary.agents, detachedWorkerReview.summary.agents);
  assert.equal(detachedNextOnly.summary.branchNextSteps, detachedWorkerReview.summary.branchNextSteps);
  assert.deepEqual(detachedNextOnly.nextSteps.map((step) => step.action), detachedWorkerReview.nextSteps.map((step) => step.action));
  assert.deepEqual(detachedNextOnly.branchNextSteps.map((step) => step.runId), detachedWorkerReview.branchNextSteps.map((step) => step.runId));
  assert.deepEqual(detachedNextOnly.branchNextSteps.map((step) => step.objective), detachedWorkerReview.branchNextSteps.map((step) => step.objective));
  assert.deepEqual(detachedNextOnly.branchNextSteps.map((step) => step.workerId), detachedWorkerReview.branchNextSteps.map((step) => step.workerId));
  assert.deepEqual(detachedNextOnly.branchNextSteps.map((step) => step.recoverable ?? null), detachedWorkerReview.branchNextSteps.map((step) => step.recoverable ?? null));
  assert.deepEqual(
    detachedNextOnly.branchNextSteps.map((step) => step.commands.checkoutBranch.join(" ")),
    detachedWorkerReview.branchNextSteps.map((step) => step.commands.checkoutBranch.join(" ")),
  );
  assert.deepEqual(
    detachedNextOnly.branchNextSteps.map((step) => step.commands.recoverStopped?.join(" ") ?? null),
    detachedWorkerReview.branchNextSteps.map((step) => step.commands.recoverStopped?.join(" ") ?? null),
  );
  assert.equal(detachedNextOnly.agents, undefined);
  assert.equal(detachedNextOnly.logs, undefined);
  const detachedReviewCommands = await cliJson<{
    session: { session: string };
    summary: { branchNextSteps: number };
    commands: Array<{ scope: string; action: string; runId?: string; command: string[] }>;
    nextSteps?: unknown;
    branchNextSteps?: unknown;
  }>(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--next", "--commands-only"]);
  assert.equal(detachedReviewCommands.session.session, detachedWorkerSessionName);
  assert.equal(detachedReviewCommands.summary.branchNextSteps, detachedWorkerReview.summary.branchNextSteps);
  assert.equal(detachedReviewCommands.nextSteps, undefined);
  assert.equal(detachedReviewCommands.branchNextSteps, undefined);
  assert.ok(detachedReviewCommands.commands.some((step) => (
    step.scope === "branch"
    && step.action === "resume_branch"
    && step.runId === detachedStoppedPlan.run.id
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
  )));
  const detachedReviewCommandsShell = await cliRaw(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--next", "--commands-only", "--format", "shell"]);
  assert.ok(detachedReviewCommandsShell.stdout.trim().split("\n").includes(`npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`));
  const detachedReviewResumeCommands = await cliJson<{
    filter: { branchAction: string[]; totalBranchNextSteps: number };
    commands: Array<{ scope: string; action: string; runId?: string; command: string[] }>;
  }>(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--next", "--commands-only", "--branch-action", "resume_branch"]);
  assert.deepEqual(detachedReviewResumeCommands.filter.branchAction, ["resume_branch"]);
  assert.equal(detachedReviewResumeCommands.filter.totalBranchNextSteps, detachedWorkerReview.branchNextSteps.length);
  assert.ok(detachedReviewResumeCommands.commands.some((step) => (
    step.scope === "branch"
    && step.action === "resume_branch"
    && step.runId === detachedStoppedPlan.run.id
  )));
  assert.ok(detachedReviewResumeCommands.commands.every((step) => step.scope !== "branch" || step.action === "resume_branch"));
  const detachedReviewResumeShell = await cliRaw(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--next", "--commands-only", "--branch-action", "resume_branch", "--format", "shell"]);
  const detachedReviewResumeShellLines = detachedReviewResumeShell.stdout.trim().split("\n");
  assert.ok(detachedReviewResumeShellLines.includes(`npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`));
  assert.ok(!detachedReviewResumeShellLines.includes(`npm run cli -- runs review ${detachedResultPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-results/${detachedResultPlan.run.id}`));
  const detachedReviewChangedResultsOnly = await cliJson<{
    filter: { action: string[]; totalNextSteps: number };
    nextSteps: Array<{ action: string }>;
    branchNextSteps: Array<{ action: string }>;
  }>(baseUrl, ["runs", "session-review", detachedWorkerSessionName, "--include-stopped", "--next", "--action", "review_changed_results"]);
  assert.deepEqual(detachedReviewChangedResultsOnly.filter.action, ["review_changed_results"]);
  assert.equal(detachedReviewChangedResultsOnly.filter.totalNextSteps, detachedWorkerReview.nextSteps.length);
  assert.ok(detachedReviewChangedResultsOnly.nextSteps.every((step) => step.action === "review_changed_results"));
  assert.equal(detachedReviewChangedResultsOnly.branchNextSteps.length, detachedWorkerReview.branchNextSteps.length);
  const detachedApplyResumePreview = await cliJson<{
    session: string;
    source: string;
    dryRun: boolean;
    selected: number;
    filter: { branchAction: string[]; run: string[]; limit: number };
    commands: Array<{ scope: string; action: string; runId?: string; command: string[] }>;
  }>(baseUrl, ["runs", "session-apply", detachedWorkerSessionName, "--include-stopped", "--branch-action", "resume_branch", "--run", detachedStoppedPlan.run.id, "--limit", "1", "--dry-run"]);
  assert.equal(detachedApplyResumePreview.session, detachedWorkerSessionName);
  assert.equal(detachedApplyResumePreview.source, "review");
  assert.equal(detachedApplyResumePreview.dryRun, true);
  assert.equal(detachedApplyResumePreview.selected, 1);
  assert.deepEqual(detachedApplyResumePreview.filter.branchAction, ["resume_branch"]);
  assert.deepEqual(detachedApplyResumePreview.filter.run, [detachedStoppedPlan.run.id]);
  assert.equal(detachedApplyResumePreview.filter.limit, 1);
  assert.equal(detachedApplyResumePreview.commands[0].scope, "branch");
  assert.equal(detachedApplyResumePreview.commands[0].action, "resume_branch");
  assert.equal(detachedApplyResumePreview.commands[0].runId, detachedStoppedPlan.run.id);
  assert.equal(detachedApplyResumePreview.commands[0].command.join(" "), `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`);
  const detachedApplyStatusResumePreview = await cliJson<{
    session: string;
    source: string;
    dryRun: boolean;
    selected: number;
    filter: { branchAction: string[]; run: string[]; limit: number; totalBranchNextSteps: number };
    commands: Array<{ scope: string; action: string; runId?: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-apply",
    detachedWorkerSessionName,
    "--source",
    "status",
    "--include-stopped",
    "--branch-action",
    "resume_branch",
    "--run",
    detachedStoppedPlan.run.id,
    "--limit",
    "1",
    "--dry-run",
  ]);
  assert.equal(detachedApplyStatusResumePreview.session, detachedWorkerSessionName);
  assert.equal(detachedApplyStatusResumePreview.source, "status");
  assert.equal(detachedApplyStatusResumePreview.dryRun, true);
  assert.equal(detachedApplyStatusResumePreview.selected, 1);
  assert.deepEqual(detachedApplyStatusResumePreview.filter.branchAction, ["resume_branch"]);
  assert.deepEqual(detachedApplyStatusResumePreview.filter.run, [detachedStoppedPlan.run.id]);
  assert.equal(detachedApplyStatusResumePreview.filter.limit, 1);
  assert.ok(detachedApplyStatusResumePreview.filter.totalBranchNextSteps >= 1);
  assert.equal(detachedApplyStatusResumePreview.commands[0].scope, "branch");
  assert.equal(detachedApplyStatusResumePreview.commands[0].action, "resume_branch");
  assert.equal(detachedApplyStatusResumePreview.commands[0].runId, detachedStoppedPlan.run.id);
  assert.equal(detachedApplyStatusResumePreview.commands[0].command.join(" "), `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`);
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
  assert.ok(detachedWorkerReview.resultBranches.some((run) => (
    run.agentId === workerGroupAgentBody.agent.id
    && run.runId === detachedResultPlan.run.id
    && run.status === "completed"
    && run.objective === "detached session completed result branch"
    && run.branchName === detachedResultPlan.plan.branchName
    && run.resultCommit === detachedResultFinalized.result.commitSha
    && run.workerId === "smoke-detached-worker-1"
    && run.location === "session_worker"
    && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedResultPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-results/${detachedResultPlan.run.id}`
    && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${detachedResultPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-results/${detachedResultPlan.run.id}`
    && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${detachedResultPlan.run.id}`
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
  const watchedWorkerNext = await cliJson<{
    observedAt: string;
    session: { session: string; workers: { total: number; alive: number; dead: number } };
    summary: { recoveryCandidates: number; resumableBranches: number; branchNextSteps: number };
    nextSteps: Array<{ action: string; reason: string; count: number; command: string[] }>;
    branchNextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      objective: string;
      workerId: string | null;
      location: string;
      recoverable: boolean;
      command: string[];
      commands: { checkoutBranch: string[]; resumeBranch: string[]; recoverStopped: string[] | null };
    }>;
    agents?: unknown;
    recoveryPreview?: unknown;
  }>(baseUrl, [
    "runs",
    "session-watch",
    detachedWorkerSessionName,
    "--recoverable",
    "--include-stopped",
    "--next",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.match(watchedWorkerNext.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(watchedWorkerNext.session.session, detachedWorkerSessionName);
  assert.equal(watchedWorkerNext.session.workers.total, 1);
  assert.equal(watchedWorkerNext.session.workers.alive, 1);
  assert.equal(watchedWorkerNext.agents, undefined);
  assert.equal(watchedWorkerNext.recoveryPreview, undefined);
  assert.ok(watchedWorkerNext.summary.recoveryCandidates >= 1);
  assert.ok(watchedWorkerNext.summary.resumableBranches >= 1);
  assert.equal(watchedWorkerNext.summary.branchNextSteps, watchedWorkerNext.branchNextSteps.length);
  assert.ok(watchedWorkerNext.nextSteps.some((step) => (
    step.action === "recover_session"
    && step.reason === "stale_running_claims"
    && step.command.join(" ") === `npm run cli -- runs recover-session ${detachedWorkerSessionName}`
  )));
  assert.ok(watchedWorkerNext.nextSteps.some((step) => (
    step.action === "recover_stopped"
    && step.reason === "unfinished_stopped_branches"
    && step.command.join(" ") === `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`
  )));
  assert.ok(watchedWorkerNext.nextSteps.some((step) => (
    step.action === "resume_session"
    && step.reason === "resumable_branch_runs"
    && step.command.join(" ") === `npm run cli -- runs resume-session ${detachedWorkerSessionName}`
  )));
  assert.ok(watchedWorkerNext.branchNextSteps.some((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.runId === detachedStoppedPlan.run.id
    && step.objective === "detached session resumable stopped branch"
    && step.workerId === null
    && step.location === "unassigned"
    && step.recoverable === true
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${detachedStoppedPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-resumable/${detachedStoppedPlan.run.id}`
    && step.commands.resumeBranch.join(" ") === `npm run cli -- runs resume-branch ${detachedStoppedPlan.run.id}`
    && step.commands.recoverStopped?.join(" ") === `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`
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
  assert.equal(typeof detachedWorkerLogs.workers[0].alive, "boolean");
  assert.match(detachedWorkerLogs.workers[0].stdout.path, /worker-sessions/);
  assert.match(detachedWorkerLogs.workers[0].stderr.path, /worker-sessions/);
  assert.ok(Array.isArray(detachedWorkerLogs.workers[0].stdout.lines));
  assert.ok(Array.isArray(detachedWorkerLogs.workers[0].stderr.lines));
  const workerFleetResumeBranchQueue = await cliJson<{
    filter: { branchAction: string[]; totalSessions: number };
    branchActions: Record<string, number>;
    branchActionQueue: Array<{ session: string; action: string; runId: string; resultCommit: string | null }>;
    resultCommits: Array<{ runId: string }>;
    resumableBranches: Array<{ runId: string; resultCommit: string | null }>;
  }>(baseUrl, [
    "runs",
    "sessions",
    "--session",
    detachedWorkerSessionName,
    "--summary",
    "--next",
    "--branch-action",
    "resume_branch",
  ]);
  assert.deepEqual(workerFleetResumeBranchQueue.filter.branchAction, ["resume_branch"]);
  assert.equal(workerFleetResumeBranchQueue.filter.totalSessions, 1);
  assert.ok(workerFleetResumeBranchQueue.branchActions.resume_branch >= 1);
  assert.ok(workerFleetResumeBranchQueue.branchActionQueue.every((item) => item.action === "resume_branch"));
  assert.equal(workerFleetResumeBranchQueue.resultCommits.length, 0);
  assert.ok(workerFleetResumeBranchQueue.resumableBranches.some((run) => (
    run.runId === detachedStoppedPlan.run.id
    && run.resultCommit === null
  )));
  const stoppedWorkerSession = await cliJson<{
    session: string;
    stopped: Array<{
      workerId: string;
      pid: number | null;
      stopped: boolean;
      signalSent: boolean;
      forced: boolean;
      alive: boolean;
    }>;
    recovered: Array<{ runId: string; status?: string; skipped?: string }>;
  }>(baseUrl, ["runs", "stop-session", detachedWorkerSessionName, "--recover"]);
  assert.equal(stoppedWorkerSession.session, detachedWorkerSessionName);
  assert.equal(stoppedWorkerSession.stopped[0].stopped, true);
  assert.equal(stoppedWorkerSession.stopped[0].alive, false);
  assert.equal(typeof stoppedWorkerSession.stopped[0].signalSent, "boolean");
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
    actions: { recoverSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, ["runs", "recover-session", detachedWorkerSessionName, "--dry-run"]);
  assert.equal(sessionRecoverPreview.session, detachedWorkerSessionName);
  assert.ok(sessionRecoverPreview.recovered.some((run) => (
    run.runId === detachedSessionRecoverPlan.run.id
    && run.currentStatus === "running"
    && run.dryRun === true
  )));
  assert.equal(sessionRecoverPreview.nextStep.action, "recover_session");
  assert.equal(sessionRecoverPreview.nextStep.reason, "dry_run_preview");
  assert.equal(sessionRecoverPreview.nextStep.command.join(" "), `npm run cli -- runs recover-session ${detachedWorkerSessionName}`);
  assert.equal(sessionRecoverPreview.actions.recoverSession.join(" "), `npm run cli -- runs recover-session ${detachedWorkerSessionName}`);
  const sessionStoppedRecoveryPreview = await cliJson<{
    session: string;
    recovered: Array<{
      runId: string;
      currentStatus?: string;
      dryRun?: boolean;
      resultCommit?: string | null;
      workerId?: string | null;
    }>;
    actions: { recoverSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, ["runs", "recover-session", detachedWorkerSessionName, "--include-stopped", "--dry-run"]);
  assert.equal(sessionStoppedRecoveryPreview.session, detachedWorkerSessionName);
  assert.ok(sessionStoppedRecoveryPreview.recovered.some((run) => (
    run.runId === detachedStoppedPlan.run.id
    && run.currentStatus === "stopped"
    && run.dryRun === true
    && run.resultCommit === null
    && run.workerId === null
  )));
  assert.equal(sessionStoppedRecoveryPreview.nextStep.action, "recover_session");
  assert.equal(sessionStoppedRecoveryPreview.nextStep.reason, "dry_run_preview");
  assert.equal(sessionStoppedRecoveryPreview.nextStep.command.join(" "), `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`);
  assert.equal(sessionStoppedRecoveryPreview.actions.recoverSession.join(" "), `npm run cli -- runs recover-session ${detachedWorkerSessionName} --include-stopped`);
  const sessionRecovered = await cliJson<{
    session: string;
    recovered: Array<{ runId: string; status?: string }>;
    actions: { sessionWait: string[]; restartSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "recover-session", detachedWorkerSessionName]);
  assert.equal(sessionRecovered.session, detachedWorkerSessionName);
  assert.equal(sessionRecovered.status.session.session, detachedWorkerSessionName);
  assert.ok(sessionRecovered.recovered.some((run) => (
    run.runId === detachedSessionRecoverPlan.run.id && run.status === "planned"
  )));
  assert.equal(sessionRecovered.nextStep.action, "restart_session");
  assert.equal(sessionRecovered.nextStep.reason, "recovered_runs_without_live_workers");
  assert.equal(sessionRecovered.nextStep.command.join(" "), `npm run cli -- runs restart-session ${detachedWorkerSessionName} --recover`);
  assert.equal(sessionRecovered.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${detachedWorkerSessionName}`);
  assert.equal(sessionRecovered.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${detachedWorkerSessionName} --recover`);
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
    actions: { resumeSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
  }>(baseUrl, ["runs", "resume-session", detachedWorkerSessionName, "--worker-id", "smoke-detached-worker-1", "--dry-run"]);
  assert.equal(sessionResumePreview.session, detachedWorkerSessionName);
  assert.deepEqual(sessionResumePreview.resumed.map((run) => run.runId), [sessionResumePlan.run.id]);
  assert.equal(sessionResumePreview.resumed[0].branchName, sessionResumePlan.plan.branchName);
  assert.equal(sessionResumePreview.resumed[0].workerId, "smoke-detached-worker-1");
  assert.equal(sessionResumePreview.resumed[0].currentStatus, "stopped");
  assert.equal(sessionResumePreview.resumed[0].dryRun, true);
  assert.equal(sessionResumePreview.nextStep.action, "resume_session");
  assert.equal(sessionResumePreview.nextStep.reason, "dry_run_preview");
  assert.equal(sessionResumePreview.nextStep.command.join(" "), `npm run cli -- runs resume-session ${detachedWorkerSessionName} --worker-id smoke-detached-worker-1`);
  assert.equal(sessionResumePreview.actions.resumeSession.join(" "), `npm run cli -- runs resume-session ${detachedWorkerSessionName} --worker-id smoke-detached-worker-1`);
  const sessionResumed = await cliJson<{
    session: string;
    resumed: Array<{ runId: string; status?: string; workerId: string | null }>;
    actions: { sessionWait: string[]; restartSession: string[] };
    nextStep: { action: string; reason: string; count: number; command: string[] };
    status: { session: { session: string } };
  }>(baseUrl, ["runs", "resume-session", detachedWorkerSessionName, "--worker-id", "smoke-detached-worker-1"]);
  assert.equal(sessionResumed.session, detachedWorkerSessionName);
  assert.equal(sessionResumed.status.session.session, detachedWorkerSessionName);
  assert.deepEqual(sessionResumed.resumed.map((run) => run.runId), [sessionResumePlan.run.id]);
  assert.equal(sessionResumed.resumed[0].status, "planned");
  assert.equal(sessionResumed.resumed[0].workerId, null);
  assert.equal(sessionResumed.nextStep.action, "restart_session");
  assert.equal(sessionResumed.nextStep.reason, "resumed_runs_without_live_workers");
  assert.equal(sessionResumed.nextStep.command.join(" "), `npm run cli -- runs restart-session ${detachedWorkerSessionName} --recover`);
  assert.equal(sessionResumed.actions.sessionWait.join(" "), `npm run cli -- runs session-wait ${detachedWorkerSessionName}`);
  assert.equal(sessionResumed.actions.restartSession.join(" "), `npm run cli -- runs restart-session ${detachedWorkerSessionName} --recover`);
  const sessionApplyPlan = await cliJson<{
    run: { id: string };
    plan: { branchName: string };
  }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    workerGroupAgentBody.agent.id,
    "--objective",
    "detached session apply resume branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", sessionApplyPlan.run.id]);
  const sessionApplyId = "smoke-session-apply-resume";
  const sessionApplyResumed = await cliJson<{
    session: string;
    source: string;
    applyId: string;
    applyPath: string;
    dryRun: boolean;
    resume: boolean;
    selected: number;
    skippedCompleted: number;
    commands: Array<{ action: string; runId?: string }>;
    executions: Array<{
      action: string;
      runId: string | null;
      exitCode: number | null;
      output: { resumed?: { runId: string; branchName: string; status: string; workerId: string | null }; run?: { status: string; worker_id: string | null } };
    }>;
  }>(baseUrl, ["runs", "session-apply", detachedWorkerSessionName, "--source", "status", "--include-stopped", "--branch-action", "resume_branch", "--run", sessionApplyPlan.run.id, "--limit", "1", "--apply-id", sessionApplyId]);
  assert.equal(sessionApplyResumed.session, detachedWorkerSessionName);
  assert.equal(sessionApplyResumed.source, "status");
  assert.equal(sessionApplyResumed.applyId, sessionApplyId);
  assert.match(sessionApplyResumed.applyPath, new RegExp(`\\.threadbeat/worker-sessions/apply/${detachedWorkerSessionName}/${sessionApplyId}\\.json$`));
  assert.equal(sessionApplyResumed.dryRun, false);
  assert.equal(sessionApplyResumed.resume, false);
  assert.equal(sessionApplyResumed.selected, 1);
  assert.equal(sessionApplyResumed.skippedCompleted, 0);
  assert.equal(sessionApplyResumed.commands[0].action, "resume_branch");
  assert.equal(sessionApplyResumed.commands[0].runId, sessionApplyPlan.run.id);
  assert.equal(sessionApplyResumed.executions[0].action, "resume_branch");
  assert.equal(sessionApplyResumed.executions[0].runId, sessionApplyPlan.run.id);
  assert.equal(sessionApplyResumed.executions[0].exitCode, 0);
  assert.equal(sessionApplyResumed.executions[0].output.resumed?.runId, sessionApplyPlan.run.id);
  assert.equal(sessionApplyResumed.executions[0].output.resumed?.branchName, sessionApplyPlan.plan.branchName);
  assert.equal(sessionApplyResumed.executions[0].output.resumed?.status, "planned");
  assert.equal(sessionApplyResumed.executions[0].output.run?.status, "planned");
  assert.equal(sessionApplyResumed.executions[0].output.run?.worker_id, null);
  const sessionApplyRun = await cliJson<{ run: { status: string; worker_id: string | null } }>(baseUrl, [
    "runs",
    "get",
    sessionApplyPlan.run.id,
  ]);
  assert.equal(sessionApplyRun.run.status, "planned");
  assert.equal(sessionApplyRun.run.worker_id, null);
  const sessionApplyRecord = JSON.parse(await fs.readFile(sessionApplyResumed.applyPath, "utf8")) as {
    session: string;
    source: string;
    applyId: string;
    commands: Array<{ runId?: string }>;
    executions: Array<{ runId: string | null; exitCode: number | null }>;
  };
  assert.equal(sessionApplyRecord.session, detachedWorkerSessionName);
  assert.equal(sessionApplyRecord.source, "status");
  assert.equal(sessionApplyRecord.applyId, sessionApplyId);
  assert.deepEqual(sessionApplyRecord.commands.map((command) => command.runId), [sessionApplyPlan.run.id]);
  assert.equal(sessionApplyRecord.executions[0].runId, sessionApplyPlan.run.id);
  assert.equal(sessionApplyRecord.executions[0].exitCode, 0);
  const sessionApplyResume = await cliJson<{
    session: string;
    source: string;
    applyId: string;
    resume: boolean;
    resumeFilter: string[];
    selected: number;
    skippedCompleted: number;
    skippedByResumeFilter: number;
    commandsToRun: Array<{ runId?: string }>;
    executions: Array<{ runId: string | null; exitCode: number | null }>;
  }>(baseUrl, ["runs", "session-apply", detachedWorkerSessionName, "--source", "status", "--include-stopped", "--branch-action", "resume_branch", "--run", sessionApplyPlan.run.id, "--limit", "1", "--apply-id", sessionApplyId, "--resume"]);
  assert.equal(sessionApplyResume.session, detachedWorkerSessionName);
  assert.equal(sessionApplyResume.source, "status");
  assert.equal(sessionApplyResume.applyId, sessionApplyId);
  assert.equal(sessionApplyResume.resume, true);
  assert.deepEqual(sessionApplyResume.resumeFilter, ["failed", "pending"]);
  assert.equal(sessionApplyResume.selected, 1);
  assert.equal(sessionApplyResume.skippedCompleted, 1);
  assert.equal(sessionApplyResume.skippedByResumeFilter, 0);
  assert.deepEqual(sessionApplyResume.commandsToRun, []);
  assert.deepEqual(sessionApplyResume.executions.map((execution) => execution.runId), [sessionApplyPlan.run.id]);
  assert.deepEqual(sessionApplyResume.executions.map((execution) => execution.exitCode), [0]);
  const sessionApplyInspection = await cliJson<{
    session: string;
    applyId: string;
    summary: {
      applyId: string;
      selected: number;
      succeeded: number;
      failed: number;
      pending: number;
      actions: { resumeApply: string[]; inspectResults: string[] | null; reviewReadyResults: string[] | null };
      pendingCommands: Array<{ runId?: string }>;
      failedCommands: Array<{ runId?: string }>;
      affectedRuns: Array<{
        runId: string;
        state: string;
        currentRun: { status: string; resultCommit: string | null; nextAction: string; location: string } | null;
        commands: { inspectRun: string[]; inspectResults: string[]; checkoutBranch: string[]; reviewRun: string[] };
      }>;
    };
    failedExecutions: Array<{ runId: string | null }>;
    record: { applyId: string; executions: Array<{ runId: string | null; exitCode: number | null }> };
  }>(baseUrl, ["runs", "session-applies", detachedWorkerSessionName, "--apply-id", sessionApplyId]);
  assert.equal(sessionApplyInspection.session, detachedWorkerSessionName);
  assert.equal(sessionApplyInspection.applyId, sessionApplyId);
  assert.equal(sessionApplyInspection.summary.applyId, sessionApplyId);
  assert.equal(sessionApplyInspection.summary.selected, 1);
  assert.equal(sessionApplyInspection.summary.succeeded, 1);
  assert.equal(sessionApplyInspection.summary.failed, 0);
  assert.equal(sessionApplyInspection.summary.pending, 0);
  assert.deepEqual(sessionApplyInspection.summary.pendingCommands, []);
  assert.deepEqual(sessionApplyInspection.summary.failedCommands, []);
  assert.deepEqual(sessionApplyInspection.summary.affectedRuns.map((run) => ({ runId: run.runId, state: run.state })), [
    { runId: sessionApplyPlan.run.id, state: "succeeded" },
  ]);
  assert.equal(sessionApplyInspection.summary.affectedRuns[0].currentRun?.status, "planned");
  assert.equal(sessionApplyInspection.summary.affectedRuns[0].currentRun?.resultCommit, null);
  assert.equal(sessionApplyInspection.summary.affectedRuns[0].currentRun?.location, "unassigned");
  assert.equal(sessionApplyInspection.summary.affectedRuns[0].currentRun?.nextAction, "dispatch_worker");
  assert.equal(
    sessionApplyInspection.summary.actions.inspectResults?.join(" "),
    `npm run cli -- runs results --session ${detachedWorkerSessionName} --run ${sessionApplyPlan.run.id} --next`,
  );
  assert.equal(sessionApplyInspection.summary.actions.reviewReadyResults, null);
  assert.equal(sessionApplyInspection.summary.affectedRuns[0].commands.inspectRun.join(" "), `npm run cli -- runs inspect ${sessionApplyPlan.run.id}`);
  assert.equal(
    sessionApplyInspection.summary.affectedRuns[0].commands.inspectResults.join(" "),
    `npm run cli -- runs results --session ${detachedWorkerSessionName} --run ${sessionApplyPlan.run.id} --next`,
  );
  assert.equal(
    sessionApplyInspection.summary.affectedRuns[0].commands.checkoutBranch.join(" "),
    `npm run cli -- runs checkout ${sessionApplyPlan.run.id} --dir ./checkouts/${detachedWorkerSessionName}-applies/${sessionApplyId}/${sessionApplyPlan.run.id}`,
  );
  assert.equal(
    sessionApplyInspection.summary.affectedRuns[0].commands.reviewRun.join(" "),
    `npm run cli -- runs review ${sessionApplyPlan.run.id} --checkout-dir ./checkouts/${detachedWorkerSessionName}-applies/${sessionApplyId}/${sessionApplyPlan.run.id}`,
  );
  assert.deepEqual(sessionApplyInspection.failedExecutions, []);
  assert.deepEqual(sessionApplyInspection.summary.actions.resumeApply, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-apply",
    detachedWorkerSessionName,
    "--source",
    "status",
    "--branch-action",
    "resume_branch",
    "--apply-id",
    sessionApplyId,
    "--resume",
  ]);
  assert.deepEqual(sessionApplyInspection.record.executions.map((execution) => execution.runId), [sessionApplyPlan.run.id]);
  const sessionApplyList = await cliJson<{
    session: string;
    count: number;
    applies: Array<{ applyId: string; pending: number; actions: { resumeApply: string[]; inspectResults: string[] | null; reviewReadyResults: string[] | null }; affectedRuns: Array<{ runId: string; currentRun: { status: string } | null }> }>;
  }>(baseUrl, ["runs", "session-applies", detachedWorkerSessionName]);
  assert.equal(sessionApplyList.session, detachedWorkerSessionName);
  assert.ok(sessionApplyList.count >= 1);
  assert.ok(sessionApplyList.applies.some((apply) => (
    apply.applyId === sessionApplyId
    && apply.pending === 0
    && apply.affectedRuns.some((run) => run.runId === sessionApplyPlan.run.id && run.currentRun?.status === "planned")
    && apply.actions.resumeApply.join(" ") === sessionApplyInspection.summary.actions.resumeApply.join(" ")
    && apply.actions.inspectResults?.join(" ") === sessionApplyInspection.summary.actions.inspectResults?.join(" ")
  )));
  const sessionApplySummary = await cliJson<{
    session: string;
    summary: {
      counts: { total: number; resumeNeeded: number; readyToReview: number; waiting: number; failed: number; pending: number };
      groups: {
        resumeNeeded: Array<{ applyId: string; command: string[] }>;
        readyToReview: Array<{ applyId: string; resultRuns: string[]; command: string[] }>;
        waiting: Array<{ applyId: string }>;
      };
    };
  }>(baseUrl, ["runs", "session-applies", detachedWorkerSessionName, "--summary"]);
  assert.equal(sessionApplySummary.session, detachedWorkerSessionName);
  assert.equal(sessionApplySummary.summary.counts.total, sessionApplyList.count);
  assert.equal(sessionApplySummary.summary.counts.readyToReview, 0);
  assert.ok(sessionApplySummary.summary.counts.waiting >= 1);
  assert.ok(sessionApplySummary.summary.groups.waiting.some((apply) => apply.applyId === sessionApplyId));
  const sessionApplyShell = await cliRaw(baseUrl, ["runs", "session-applies", detachedWorkerSessionName, "--apply-id", sessionApplyId, "--format", "shell"]);
  assert.equal(
    sessionApplyShell.stdout.trim(),
    `npm run cli -- runs session-apply ${detachedWorkerSessionName} --source status --branch-action resume_branch --apply-id ${sessionApplyId} --resume`,
  );
  const retryApplyId = "smoke-session-apply-retry-filter";
  const retryApplyPath = path.join(path.dirname(sessionApplyResumed.applyPath), `${retryApplyId}.json`);
  const retryCommands = [
    {
      scope: "branch",
      action: "resume_branch",
      reason: "already completed",
      runId: "run_completed_retry_filter",
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", "run_completed_retry_filter"],
    },
    {
      scope: "branch",
      action: "resume_branch",
      reason: "failed earlier",
      runId: "run_failed_retry_filter",
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", "run_failed_retry_filter"],
    },
    {
      scope: "branch",
      action: "resume_branch",
      reason: "never started",
      runId: "run_pending_retry_filter",
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", "run_pending_retry_filter"],
    },
  ];
  await fs.writeFile(retryApplyPath, `${JSON.stringify({
    observedAt: "2026-01-01T00:00:00.000Z",
    session: detachedWorkerSessionName,
    applyId: retryApplyId,
    applyPath: retryApplyPath,
    dryRun: false,
    resume: false,
    filter: { branchAction: ["resume_branch"] },
    selected: retryCommands.length,
    skippedCompleted: 0,
    commands: retryCommands,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    executions: [
      {
        scope: retryCommands[0].scope,
        action: retryCommands[0].action,
        reason: retryCommands[0].reason,
        runId: retryCommands[0].runId,
        command: retryCommands[0].command,
        exitCode: 0,
        stdout: "{}",
        stderr: "",
        output: {},
      },
      {
        scope: retryCommands[1].scope,
        action: retryCommands[1].action,
        reason: retryCommands[1].reason,
        runId: retryCommands[1].runId,
        command: retryCommands[1].command,
        exitCode: 1,
        stdout: "",
        stderr: "failed",
        output: null,
      },
    ],
  }, null, 2)}\n`);
  const retryInspection = await cliJson<{
    summary: {
      succeeded: number;
      failed: number;
      pending: number;
      actions: { retryFailed: string[]; resumePending: string[] };
      failedCommands: Array<{ runId?: string }>;
      pendingCommands: Array<{ runId?: string }>;
      affectedRuns: Array<{ runId: string; state: string; currentRun: unknown; commands: { inspectRun: string[] } }>;
    };
  }>(baseUrl, ["runs", "session-applies", detachedWorkerSessionName, "--apply-id", retryApplyId]);
  assert.equal(retryInspection.summary.succeeded, 1);
  assert.equal(retryInspection.summary.failed, 1);
  assert.equal(retryInspection.summary.pending, 1);
  assert.deepEqual(retryInspection.summary.failedCommands.map((command) => command.runId), ["run_failed_retry_filter"]);
  assert.deepEqual(retryInspection.summary.pendingCommands.map((command) => command.runId), ["run_pending_retry_filter"]);
  assert.deepEqual(retryInspection.summary.affectedRuns.map((run) => ({ runId: run.runId, state: run.state })), [
    { runId: "run_completed_retry_filter", state: "succeeded" },
    { runId: "run_failed_retry_filter", state: "failed" },
    { runId: "run_pending_retry_filter", state: "pending" },
  ]);
  assert.ok(retryInspection.summary.affectedRuns.every((run) => run.currentRun === null));
  assert.equal(
    retryInspection.summary.affectedRuns.find((run) => run.runId === "run_failed_retry_filter")?.commands.inspectRun.join(" "),
    "npm run cli -- runs inspect run_failed_retry_filter",
  );
  assert.deepEqual(retryInspection.summary.actions.retryFailed, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-apply",
    detachedWorkerSessionName,
    "--branch-action",
    "resume_branch",
    "--apply-id",
    retryApplyId,
    "--resume",
    "--resume-filter",
    "failed",
  ]);
  assert.deepEqual(retryInspection.summary.actions.resumePending, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-apply",
    detachedWorkerSessionName,
    "--branch-action",
    "resume_branch",
    "--apply-id",
    retryApplyId,
    "--resume",
    "--resume-filter",
    "pending",
  ]);
  const retrySummaryGroupShell = await cliRaw(baseUrl, [
    "runs",
    "session-applies",
    detachedWorkerSessionName,
    "--summary-group",
    "resume-needed",
    "--format",
    "shell",
  ]);
  assert.equal(
    retrySummaryGroupShell.stdout.trim(),
    retryInspection.summary.actions.retryFailed.join(" "),
  );
  const retryActionQueueShell = await cliRaw(baseUrl, [
    "runs",
    "session-applies",
    detachedWorkerSessionName,
    "--action-queue",
    "--format",
    "shell",
  ]);
  assert.equal(
    retryActionQueueShell.stdout.trim(),
    retryInspection.summary.actions.retryFailed.join(" "),
  );
  const retryActionQueueJson = await cliJson<{
    actionQueue: {
      counts: { actionable: number; resumeNeeded: number; readyToReview: number; failed: number; pending: number };
      actions: Array<{ applyId: string; action: string; resultRuns: string[]; command: string[] }>;
    };
  }>(baseUrl, ["runs", "session-applies", detachedWorkerSessionName, "--action-queue"]);
  assert.ok(retryActionQueueJson.actionQueue.counts.actionable >= 1);
  assert.ok(retryActionQueueJson.actionQueue.counts.resumeNeeded >= 1);
  assert.equal(retryActionQueueJson.actionQueue.counts.readyToReview, 0);
  assert.ok(retryActionQueueJson.actionQueue.counts.failed >= 1);
  assert.ok(retryActionQueueJson.actionQueue.counts.pending >= 1);
  assert.ok(retryActionQueueJson.actionQueue.actions.some((action) => (
    action.applyId === retryApplyId
    && action.action === "retry_failed"
    && action.resultRuns.length === 0
    && action.command.join(" ") === retryInspection.summary.actions.retryFailed.join(" ")
  )));
  const drainPrefix = "smoke-watch-drain";
  const drainApplyOnePath = path.join(path.dirname(sessionApplyResumed.applyPath), `${drainPrefix}-001.json`);
  const drainApplyTwoPath = path.join(path.dirname(sessionApplyResumed.applyPath), `${drainPrefix}-002.json`);
  const drainCommand = {
    scope: "apply",
    action: "retry_failed",
    reason: "session_apply_failed_commands",
    command: retryInspection.summary.actions.retryFailed,
  };
  await fs.writeFile(drainApplyOnePath, `${JSON.stringify({
    observedAt: "2026-01-01T00:00:02.000Z",
    session: detachedWorkerSessionName,
    source: "watch",
    applyId: `${drainPrefix}-001`,
    applyPath: drainApplyOnePath,
    dryRun: false,
    resume: false,
    filter: { action: ["retry_failed"], limit: 1 },
    selected: 1,
    skippedCompleted: 0,
    commands: [drainCommand],
    startedAt: "2026-01-01T00:00:02.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
    executions: [{
      ...drainCommand,
      runId: null,
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      output: {},
    }],
  }, null, 2)}\n`);
  await fs.writeFile(drainApplyTwoPath, `${JSON.stringify({
    observedAt: "2026-01-01T00:00:04.000Z",
    session: detachedWorkerSessionName,
    source: "watch",
    applyId: `${drainPrefix}-002`,
    applyPath: drainApplyTwoPath,
    dryRun: false,
    resume: false,
    filter: { action: ["retry_failed"], limit: 1 },
    selected: 0,
    skippedCompleted: 0,
    commands: [],
    startedAt: "2026-01-01T00:00:04.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
    executions: [],
  }, null, 2)}\n`);
  const drainSummary = await cliJson<{
    summary: {
      counts: { drainPrefixes: number };
      groups: {
        drainPrefixes: Array<{
          prefix: string;
          polls: number;
          applyIds: string[];
          latestApplyId: string;
          selected: number;
          succeeded: number;
          failed: number;
          pending: number;
          done: boolean;
          stoppedOnFailure: boolean;
          nextApplyId: string;
        }>;
      };
    };
  }>(baseUrl, ["runs", "session-applies", detachedWorkerSessionName, "--summary"]);
  const drainGroup = drainSummary.summary.groups.drainPrefixes.find((group) => group.prefix === drainPrefix);
  assert.ok(drainSummary.summary.counts.drainPrefixes >= 1);
  assert.ok(drainGroup);
  assert.equal(drainGroup.polls, 2);
  assert.deepEqual(drainGroup.applyIds, [`${drainPrefix}-001`, `${drainPrefix}-002`]);
  assert.equal(drainGroup.latestApplyId, `${drainPrefix}-002`);
  assert.equal(drainGroup.selected, 1);
  assert.equal(drainGroup.succeeded, 1);
  assert.equal(drainGroup.failed, 0);
  assert.equal(drainGroup.pending, 0);
  assert.equal(drainGroup.done, true);
  assert.equal(drainGroup.stoppedOnFailure, false);
  assert.equal(drainGroup.nextApplyId, `${drainPrefix}-003`);
  const retryWatchActionQueue = await cliJson<{
    summary: { applyActions: number; applyResumeNeeded: number; applyReadyToReview: number };
    actionQueue: {
      counts: { actionable: number; resumeNeeded: number; readyToReview: number };
      actions: Array<{ applyId: string; action: string; command: string[] }>;
    };
  }>(baseUrl, [
    "runs",
    "session-watch",
    detachedWorkerSessionName,
    "--next",
    "--action-queue",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.equal(retryWatchActionQueue.summary.applyActions, retryWatchActionQueue.actionQueue.counts.actionable);
  assert.equal(retryWatchActionQueue.summary.applyResumeNeeded, retryWatchActionQueue.actionQueue.counts.resumeNeeded);
  assert.equal(retryWatchActionQueue.summary.applyReadyToReview, retryWatchActionQueue.actionQueue.counts.readyToReview);
  assert.ok(retryWatchActionQueue.actionQueue.actions.some((action) => (
    action.applyId === retryApplyId
    && action.action === "retry_failed"
    && action.command.join(" ") === retryInspection.summary.actions.retryFailed.join(" ")
  )));
  const retryWatchUntilEmpty = await cliJson<{
    untilEmpty: { done: boolean; remaining: number; poll: number; maxPolls: number };
  }>(baseUrl, [
    "runs",
    "session-watch",
    detachedWorkerSessionName,
    "--next",
    "--action-queue",
    "--until-empty",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.equal(retryWatchUntilEmpty.untilEmpty.done, false);
  assert.ok(retryWatchUntilEmpty.untilEmpty.remaining >= 1);
  assert.equal(retryWatchUntilEmpty.untilEmpty.poll, 1);
  assert.equal(retryWatchUntilEmpty.untilEmpty.maxPolls, 1);
  const retryWatchActionQueueShell = await cliRaw(baseUrl, [
    "runs",
    "session-watch",
    detachedWorkerSessionName,
    "--next",
    "--action-queue",
    "--commands-only",
    "--format",
    "shell",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.ok(retryWatchActionQueueShell.stdout.trim().split("\n").includes(
    retryInspection.summary.actions.retryFailed.join(" "),
  ));
  const retryWatchApplyPreview = await cliJson<{
    source: string;
    selected: number;
    commandsToRun: Array<{ scope: string; action: string; reason: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-apply",
    detachedWorkerSessionName,
    "--source",
    "watch",
    "--action",
    "retry_failed",
    "--limit",
    "1",
    "--dry-run",
  ]);
  assert.equal(retryWatchApplyPreview.source, "watch");
  assert.equal(retryWatchApplyPreview.selected, 1);
  assert.equal(retryWatchApplyPreview.commandsToRun.length, 1);
  assert.equal(retryWatchApplyPreview.commandsToRun[0].scope, "apply");
  assert.equal(retryWatchApplyPreview.commandsToRun[0].action, "retry_failed");
  assert.equal(retryWatchApplyPreview.commandsToRun[0].reason, "session_apply_failed_commands");
  assert.equal(retryWatchApplyPreview.commandsToRun[0].command.join(" "), retryInspection.summary.actions.retryFailed.join(" "));
  const retryWatchApplyDrainPreview = await cliJson<{
    source: string;
    dryRun: boolean;
    applyIdPrefix: string;
    untilEmpty: { done: boolean; remaining: number; polls: number; maxPolls: number };
    polls: Array<{ poll: number; applyId: string; selected: number; commandsToRun: number; exitCode: number | null; failed: number }>;
  }>(baseUrl, [
    "runs",
    "session-apply",
    detachedWorkerSessionName,
    "--source",
    "watch",
    "--action",
    "retry_failed",
    "--limit",
    "1",
    "--apply-id",
    "retry-watch-drain-preview",
    "--until-empty",
    "--max-polls",
    "3",
    "--interval-ms",
    "1",
    "--dry-run",
  ]);
  assert.equal(retryWatchApplyDrainPreview.source, "watch");
  assert.equal(retryWatchApplyDrainPreview.dryRun, true);
  assert.equal(retryWatchApplyDrainPreview.applyIdPrefix, "retry-watch-drain-preview");
  assert.equal(retryWatchApplyDrainPreview.untilEmpty.done, false);
  assert.equal(retryWatchApplyDrainPreview.untilEmpty.remaining, 1);
  assert.equal(retryWatchApplyDrainPreview.untilEmpty.polls, 1);
  assert.equal(retryWatchApplyDrainPreview.untilEmpty.maxPolls, 3);
  assert.equal(retryWatchApplyDrainPreview.polls[0].applyId, "retry-watch-drain-preview-001");
  assert.equal(retryWatchApplyDrainPreview.polls[0].selected, 1);
  assert.equal(retryWatchApplyDrainPreview.polls[0].commandsToRun, 1);
  assert.equal(retryWatchApplyDrainPreview.polls[0].exitCode, 0);
  assert.equal(retryWatchApplyDrainPreview.polls[0].failed, 0);
  const retryFailedPreview = await cliJson<{
    resumeFilter: string[];
    selected: number;
    skippedCompleted: number;
    skippedByResumeFilter: number;
    commandsToRun: Array<{ runId?: string }>;
  }>(baseUrl, ["runs", "session-apply", detachedWorkerSessionName, "--branch-action", "resume_branch", "--apply-id", retryApplyId, "--resume", "--resume-filter", "failed", "--dry-run"]);
  assert.deepEqual(retryFailedPreview.resumeFilter, ["failed"]);
  assert.equal(retryFailedPreview.selected, 3);
  assert.equal(retryFailedPreview.skippedCompleted, 1);
  assert.equal(retryFailedPreview.skippedByResumeFilter, 1);
  assert.deepEqual(retryFailedPreview.commandsToRun.map((command) => command.runId), ["run_failed_retry_filter"]);
  const retryPendingPreview = await cliJson<{
    resumeFilter: string[];
    selected: number;
    skippedCompleted: number;
    skippedByResumeFilter: number;
    commandsToRun: Array<{ runId?: string }>;
  }>(baseUrl, ["runs", "session-apply", detachedWorkerSessionName, "--branch-action", "resume_branch", "--apply-id", retryApplyId, "--resume", "--resume-filter", "pending", "--dry-run"]);
  assert.deepEqual(retryPendingPreview.resumeFilter, ["pending"]);
  assert.equal(retryPendingPreview.selected, 3);
  assert.equal(retryPendingPreview.skippedCompleted, 1);
  assert.equal(retryPendingPreview.skippedByResumeFilter, 1);
  assert.deepEqual(retryPendingPreview.commandsToRun.map((command) => command.runId), ["run_pending_retry_filter"]);

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
  const superviseStoppedPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    superviseAgentBody.agent.id,
    "--objective",
    "supervise recovered stopped branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", superviseStoppedPlan.run.id]);
  const superviseSessionName = `supervise-${superviseAgentBody.agent.id}`;
  const supervised = await cliJson<{
    before: Array<{ agentId: string; statuses: Record<string, number> }>;
    recovered: Array<{ runId: string; status?: string; branchName: string }>;
    session: { session: string; workers: Array<{ workerId: string; pid: number | null }> };
    actions: {
      sessionStatus: string[];
      sessionWatch: string[];
      sessionSummary: string[];
      sessionSummaryWatch: string[];
      monitor: string[];
      sessionReview: string[];
      branchQueue: string[];
      results: string[];
      checkoutSession: string[];
      sessionLogs: string[];
      stopSession: string[];
    };
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
    "--include-stopped",
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
  assert.equal(supervised.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${superviseSessionName} --recoverable --include-stopped`);
  assert.equal(supervised.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${superviseSessionName} --recoverable --include-stopped --next`);
  assert.equal(supervised.actions.sessionSummary.join(" "), `npm run cli -- runs session-summary ${superviseSessionName} --next`);
  assert.equal(supervised.actions.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${superviseSessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(supervised.actions.monitor.join(" "), `npm run cli -- runs monitor --agents ${superviseAgentBody.agent.id} --status planned,running,stopped --next --checkout-dir ./checkouts/${superviseSessionName}-monitor`);
  assert.equal(supervised.actions.sessionReview.join(" "), `npm run cli -- runs session-review ${superviseSessionName} --include-stopped`);
  assert.equal(supervised.actions.branchQueue.join(" "), `npm run cli -- runs branches --session ${superviseSessionName} --next`);
  assert.equal(supervised.actions.results.join(" "), `npm run cli -- runs results --session ${superviseSessionName}`);
  assert.equal(supervised.actions.checkoutSession.join(" "), `npm run cli -- runs checkout-session ${superviseSessionName} --dir ./checkouts/${superviseSessionName}`);
  assert.equal(supervised.actions.sessionLogs.join(" "), `npm run cli -- runs session-logs ${superviseSessionName}`);
  assert.equal(supervised.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${superviseSessionName} --recover`);
  assert.ok(supervised.before.some((agent) => (
    agent.agentId === superviseAgentBody.agent.id && agent.statuses.planned === superviseQueue.queued.length
  )));
  assert.ok(supervised.recovered.some((run) => (
    run.runId === superviseStoppedPlan.run.id
    && run.branchName === superviseStoppedPlan.plan.branchName
    && run.status === "planned"
  )));
  assert.ok(supervised.after.some((agent) => agent.agentId === superviseAgentBody.agent.id));
  await cliJson(baseUrl, ["runs", "stop-session", superviseSessionName]);
  for (const queued of superviseQueue.queued) {
    await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", queued.run.id]);
  }
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", superviseStoppedPlan.run.id]);

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
  const dispatchRecoveredPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    dispatchAgentBody.agent.id,
    "--objective",
    "dispatch recovered stopped branch",
  ]);
  await cliJson(baseUrl, ["runs", "stop", dispatchRecoveredPlan.run.id]);
  const dispatchPreview = await cliJson<{
    assignment: string;
    dryRun: boolean;
    planned: Array<{ agentId: string; objective: string }>;
    session: { session: string; workerCount: number; command: string[] };
    actions: { sessionWatch: string[]; sessionSummary: string[]; sessionSummaryWatch: string[]; monitor: string[]; sessionReview: string[]; results: string[]; sessionLogs: string[]; stopSession: string[] };
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
  assert.equal(dispatchPreview.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${dispatchSessionName} --recoverable --include-stopped --next`);
  assert.equal(dispatchPreview.actions.sessionSummary.join(" "), `npm run cli -- runs session-summary ${dispatchSessionName} --next`);
  assert.equal(dispatchPreview.actions.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${dispatchSessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(dispatchPreview.actions.monitor.join(" "), `npm run cli -- runs monitor --agents ${dispatchAgentBody.agent.id},${dispatchPeerBody.agent.id} --status planned,running,stopped --next --checkout-dir ./checkouts/${dispatchSessionName}-monitor`);
  assert.equal(dispatchPreview.actions.sessionReview.join(" "), `npm run cli -- runs session-review ${dispatchSessionName} --include-stopped`);
  assert.equal(dispatchPreview.actions.results.join(" "), `npm run cli -- runs results --session ${dispatchSessionName}`);
  assert.equal(dispatchPreview.actions.sessionLogs.join(" "), `npm run cli -- runs session-logs ${dispatchSessionName}`);
  assert.equal(dispatchPreview.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${dispatchSessionName} --recover`);
  const inlineDispatchPreview = await cliJson<{
    assignment: string;
    dryRun: boolean;
    planned: Array<{ agentId: string; objective: string }>;
    session: { session: string; workerCount: number; command: string[] };
  }>(baseUrl, [
    "runs",
    "dispatch",
    "--agents",
    `${dispatchAgentBody.agent.id},${dispatchPeerBody.agent.id}`,
    "--objective",
    "inline dispatch objective",
    "--assignment",
    "round-robin",
    "--session",
    `${dispatchSessionName}-inline-preview`,
    "--workers",
    "2",
    "--dry-run",
  ]);
  assert.equal(inlineDispatchPreview.assignment, "round-robin");
  assert.equal(inlineDispatchPreview.dryRun, true);
  assert.deepEqual(inlineDispatchPreview.planned, [{
    agentId: dispatchAgentBody.agent.id,
    objective: "inline dispatch objective",
  }]);
  assert.equal(inlineDispatchPreview.session.session, `${dispatchSessionName}-inline-preview`);
  assert.equal(inlineDispatchPreview.session.workerCount, 2);
  const dispatched = await cliJson<{
    assignment: string;
    queued: Array<{ agentId: string; objective: string; run: { id: string; status: string } }>;
    recovered: Array<{ runId: string; status?: string; branchName: string }>;
    session: { session: string; workers: Array<{ workerId: string; pid: number | null }> };
    actions: {
      sessionStatus: string[];
      sessionWatch: string[];
      sessionSummary: string[];
      sessionSummaryWatch: string[];
      monitor: string[];
      sessionReview: string[];
      branchQueue: string[];
      results: string[];
      checkoutSession: string[];
      sessionLogs: string[];
      stopSession: string[];
    };
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
    "--include-stopped",
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
  assert.equal(dispatched.actions.sessionStatus.join(" "), `npm run cli -- runs session-status ${dispatchSessionName} --recoverable --include-stopped`);
  assert.equal(dispatched.actions.sessionWatch.join(" "), `npm run cli -- runs session-watch ${dispatchSessionName} --recoverable --include-stopped --next`);
  assert.equal(dispatched.actions.sessionSummary.join(" "), `npm run cli -- runs session-summary ${dispatchSessionName} --next`);
  assert.equal(dispatched.actions.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${dispatchSessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(dispatched.actions.monitor.join(" "), `npm run cli -- runs monitor --agents ${dispatchAgentBody.agent.id},${dispatchPeerBody.agent.id} --status planned,running,stopped --next --checkout-dir ./checkouts/${dispatchSessionName}-monitor`);
  assert.equal(dispatched.actions.sessionReview.join(" "), `npm run cli -- runs session-review ${dispatchSessionName} --include-stopped`);
  assert.equal(dispatched.actions.branchQueue.join(" "), `npm run cli -- runs branches --session ${dispatchSessionName} --next`);
  assert.equal(dispatched.actions.results.join(" "), `npm run cli -- runs results --session ${dispatchSessionName}`);
  assert.equal(dispatched.actions.checkoutSession.join(" "), `npm run cli -- runs checkout-session ${dispatchSessionName} --dir ./checkouts/${dispatchSessionName}`);
  assert.equal(dispatched.actions.sessionLogs.join(" "), `npm run cli -- runs session-logs ${dispatchSessionName}`);
  assert.equal(dispatched.actions.stopSession.join(" "), `npm run cli -- runs stop-session ${dispatchSessionName} --recover`);
  assert.ok(dispatched.recovered.some((run) => (
    run.runId === dispatchRecoveredPlan.run.id
    && run.branchName === dispatchRecoveredPlan.plan.branchName
    && run.status === "planned"
  )));
  assert.ok(dispatched.backlog.some((agent) => (
    agent.agentId === dispatchAgentBody.agent.id && agent.total >= 1
  )));
  assert.ok(dispatched.backlog.some((agent) => (
    agent.agentId === dispatchPeerBody.agent.id && agent.total >= 1
  )));
  const dispatchResults = await cliJson<{
    session: string;
    summary: { agents: number; total: number; resultCommits: number; resumable: number; warnings: number; changed: number | null };
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
  assert.equal(dispatchResults.summary.agents, 2);
  assert.ok(dispatchResults.summary.total >= dispatched.queued.length);
  assert.equal(dispatchResults.summary.changed, null);
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
  await cliJson(baseUrl, ["sandboxes", "stop-running", "--run", dispatchRecoveredPlan.run.id]);

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
    commands: {
      checkoutBranch: string[];
      watchRun: string[];
      resumeBranch: string[] | null;
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
  assert.equal(inspectedRun.commands.checkoutBranch.join(" "), `npm run cli -- runs checkout ${cliRunPlan.run.id} --dir ./checkouts/${cliRunPlan.run.id}`);
  assert.equal(inspectedRun.commands.watchRun.join(" "), `npm run cli -- runs watch ${cliRunPlan.run.id}`);
  assert.equal(inspectedRun.commands.resumeBranch, null);
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
    resultCommits: Array<{
      agentId: string;
      runId: string;
      resultCommit: string;
      commands: { inspectRun: string[]; checkoutBranch: string[]; reviewRun: string[] };
      links: { resultCommitUrl: string | null; resultCompareUrl: string | null };
    }>;
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
        commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[] };
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
  assert.ok(resultSummary.resultCommits.some((commit) => (
    commit.agentId === agentBody.agent.id
    && commit.runId === cliRunPlan.run.id
    && commit.resultCommit === cliRunFinalize.result.commitSha
    && commit.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${cliRunPlan.run.id}`
    && commit.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${cliRunPlan.run.id} --dir ./checkouts/results/${cliRunPlan.run.id}`
    && commit.commands.reviewRun.join(" ") === `npm run cli -- runs review ${cliRunPlan.run.id} --checkout-dir ./checkouts/results/${cliRunPlan.run.id}`
    && new RegExp(`github\\.com/example/agent/commit/${cliRunFinalize.result.commitSha}`).test(commit.links.resultCommitUrl ?? "")
    && new RegExp(`github\\.com/example/agent/compare/main\\.\\.\\.${cliRunFinalize.result.commitSha}`).test(commit.links.resultCompareUrl ?? "")
  )));
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
      && run.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${cliRunPlan.run.id} --dir ./checkouts/results/${cliRunPlan.run.id}`
      && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${cliRunPlan.run.id} --checkout-dir ./checkouts/results/${cliRunPlan.run.id}`
      && run.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${cliRunPlan.run.id}`
      && /github\.com\/example\/agent\/tree\/threadbeat\/runs\//.test(run.links.branchTreeUrl ?? "")
      && new RegExp(`github\\.com/example/agent/commit/${cliRunFinalize.result.commitSha}`).test(run.links.resultCommitUrl ?? "")
      && new RegExp(`github\\.com/example/agent/compare/main\\.\\.\\.${cliRunFinalize.result.commitSha}`).test(run.links.resultCompareUrl ?? "")
    ))
  )));
  const runFilteredResults = await cliJson<{
    runFilter: string[];
    summary: { total: number; resultCommits: number };
    resultCommits: Array<{ runId: string; resultCommit: string | null }>;
    agents: Array<{ runs: Array<{ id: string; resultCommit: string | null }> }>;
  }>(baseUrl, ["runs", "results", "--agent", agentBody.agent.id, "--run", cliRunPlan.run.id]);
  assert.deepEqual(runFilteredResults.runFilter, [cliRunPlan.run.id]);
  assert.equal(runFilteredResults.summary.total, 1);
  assert.equal(runFilteredResults.summary.resultCommits, 1);
  assert.deepEqual(runFilteredResults.agents.flatMap((agent) => agent.runs).map((run) => run.id), [cliRunPlan.run.id]);
  assert.deepEqual(runFilteredResults.resultCommits.map((commit) => [commit.runId, commit.resultCommit]), [[cliRunPlan.run.id, cliRunFinalize.result.commitSha]]);
  const runFilteredCommands = await cliJson<{
    runFilter: string[];
    summary: { total: number; resultCommits: number };
    commands: Array<{ runId: string; resultCommit: string | null; command: string[] }>;
    agents?: unknown;
  }>(baseUrl, ["runs", "results", "--agent", agentBody.agent.id, "--run", cliRunPlan.run.id, "--next", "--commands-only"]);
  assert.deepEqual(runFilteredCommands.runFilter, [cliRunPlan.run.id]);
  assert.equal(runFilteredCommands.summary.total, 1);
  assert.equal(runFilteredCommands.summary.resultCommits, 1);
  assert.equal(runFilteredCommands.agents, undefined);
  assert.deepEqual(runFilteredCommands.commands.map((command) => [command.runId, command.resultCommit]), [[cliRunPlan.run.id, cliRunFinalize.result.commitSha]]);
  assert.equal(
    runFilteredCommands.commands[0]?.command.join(" "),
    `npm run cli -- runs review ${cliRunPlan.run.id} --checkout-dir ./checkouts/results/${cliRunPlan.run.id}`,
  );
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
    resultCommits: Array<{ runId: string; resultCommit: string | null }>;
    agents: Array<{ runs: Array<{ id: string; resultCommit: string | null }> }>;
  });
  assert.equal(resultSnapshots.length, 2);
  assert.ok(resultSnapshots.every((snapshot) => (
    /^\d{4}-\d{2}-\d{2}T/.test(snapshot.observedAt)
    && snapshot.agents.some((agent) => agent.runs.some((run) => (
      run.id === cliRunPlan.run.id && run.resultCommit === cliRunFinalize.result.commitSha
    )))
    && snapshot.resultCommits.some((commit) => (
      commit.runId === cliRunPlan.run.id && commit.resultCommit === cliRunFinalize.result.commitSha
    ))
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
  const reviewDir = path.join(tempRoot, "run-review");
  const reviewedRun = await cliJson<{
    run: { id: string; branchName: string; resultCommit: string | null };
    checkout: { dir: string; headCommit: string; matchesResultCommit: boolean | null };
    review: {
      changedFiles: Array<{ status: string; path: string }>;
      commits: Array<{ sha: string; subject: string }>;
    };
    commands: {
      changedFiles: string[];
      diff: string[];
      commits: string[];
    };
  }>(baseUrl, [
    "runs",
    "review",
    checkoutPlan.run.id,
    "--checkout-dir",
    reviewDir,
  ]);
  assert.equal(reviewedRun.run.branchName, checkoutPlan.plan.branchName);
  assert.equal(reviewedRun.run.resultCommit, null);
  assert.equal(reviewedRun.checkout.dir, reviewDir);
  assert.equal(reviewedRun.checkout.headCommit, expectedCheckoutHead);
  assert.equal(reviewedRun.checkout.matchesResultCommit, null);
  assert.deepEqual(reviewedRun.review.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.ok(reviewedRun.review.commits.some((commit) => (
    commit.sha === expectedCheckoutHead && commit.subject === "Write branch report"
  )));
  assert.equal(reviewedRun.commands.changedFiles.join(" "), `git -C ${reviewDir} diff --name-status refs/threadbeat/bases/${checkoutPlan.run.id}...HEAD`);
  assert.equal(reviewedRun.commands.diff.join(" "), `git -C ${reviewDir} diff refs/threadbeat/bases/${checkoutPlan.run.id}...HEAD`);
  assert.equal(reviewedRun.commands.commits.join(" "), `git -C ${reviewDir} log --oneline refs/threadbeat/bases/${checkoutPlan.run.id}..HEAD`);
  assert.equal(await fs.readFile(path.join(reviewDir, "report.md"), "utf8"), "branch report\n");
  const inspectCheckoutDir = path.join(tempRoot, "inspect-checkout");
  const inspectedCheckoutRun = await cliJson<{
    run: { id: string; branchName: string; resultCommit: string | null };
    checkout: { dir: string; headCommit: string; matchesResultCommit: boolean | null };
    review: { changedFiles: Array<{ status: string; path: string }>; commits: Array<{ sha: string; subject: string }> };
  }>(baseUrl, [
    "runs",
    "inspect",
    checkoutPlan.run.id,
    "--checkout",
    "--checkout-dir",
    inspectCheckoutDir,
  ]);
  assert.equal(inspectedCheckoutRun.run.branchName, checkoutPlan.plan.branchName);
  assert.equal(inspectedCheckoutRun.run.resultCommit, null);
  assert.equal(inspectedCheckoutRun.checkout.dir, inspectCheckoutDir);
  assert.equal(inspectedCheckoutRun.checkout.headCommit, expectedCheckoutHead);
  assert.equal(inspectedCheckoutRun.checkout.matchesResultCommit, null);
  assert.deepEqual(inspectedCheckoutRun.review.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.ok(inspectedCheckoutRun.review.commits.some((commit) => (
    commit.sha === expectedCheckoutHead && commit.subject === "Write branch report"
  )));
  assert.equal(await fs.readFile(path.join(inspectCheckoutDir, "report.md"), "utf8"), "branch report\n");
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
      run: {
        id: string;
        agentId: string;
        status: string;
        objective: string;
        branchName: string;
        resultCommit: string | null;
        workerId: string | null;
        location: string;
      };
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
  assert.equal(checkedOutSession.checkouts[0].run.agentId, checkoutAgent.agent.id);
  assert.equal(checkedOutSession.checkouts[0].run.status, "stopped");
  assert.equal(checkedOutSession.checkouts[0].run.objective, "checkout run branch");
  assert.equal(checkedOutSession.checkouts[0].run.branchName, checkoutPlan.plan.branchName);
  assert.equal(checkedOutSession.checkouts[0].run.workerId, null);
  assert.equal(checkedOutSession.checkouts[0].run.location, "unassigned");
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
      run: { id: string; objective: string; branchName: string; resultCommit: string | null; workerId: string | null; location: string };
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
  assert.equal(checkedOutWorkerSession.checkouts[0].run.objective, "checkout one worker branch");
  assert.equal(checkedOutWorkerSession.checkouts[0].run.branchName, workerCheckoutPlan.plan.branchName);
  assert.equal(checkedOutWorkerSession.checkouts[0].run.resultCommit, null);
  assert.equal(checkedOutWorkerSession.checkouts[0].run.workerId, "smoke-checkout-worker");
  assert.equal(checkedOutWorkerSession.checkouts[0].run.location, "other_worker");
  assert.equal(checkedOutWorkerSession.checkouts[0].checkout.dir, path.join(workerSessionCheckoutDir, workerCheckoutPlan.run.id));
  assert.equal(checkedOutWorkerSession.checkouts[0].checkout.headCommit, expectedWorkerCheckoutHead);
  assert.deepEqual(checkedOutWorkerSession.checkouts[0].review.changedFiles, [{ status: "A", path: "worker-report.md" }]);
  assert.equal(
    await fs.readFile(path.join(workerSessionCheckoutDir, workerCheckoutPlan.run.id, "worker-report.md"), "utf8"),
    "worker branch report\n",
  );
  const unchangedCheckoutPlan = await cliJson<{ run: { id: string }; plan: { branchName: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    checkoutAgent.agent.id,
    "--objective",
    "checkout unchanged branch",
  ]);
  await execFileAsync("git", ["-C", checkoutSeed, "checkout", "-B", unchangedCheckoutPlan.plan.branchName, "main"]);
  await execFileAsync("git", ["-C", checkoutSeed, "push", "origin", `HEAD:${unchangedCheckoutPlan.plan.branchName}`]);
  await cliJson(baseUrl, ["runs", "stop", unchangedCheckoutPlan.run.id]);
  const resultsCheckoutDir = path.join(tempRoot, "results-checkouts");
  const checkedOutResults = await cliJson<{
    checkoutDir: string;
    summary: { total: number; changed: number | null; changedFiles: number | null; resumable: number };
    changedFiles: Array<{ agentId: string; runId: string; status: string; path: string; branchName: string; resultCommit: string | null }>;
    agents: Array<{
      agentId: string;
      runs: Array<{
        id: string;
        status: string;
        commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[] };
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
  assert.ok(checkedOutResults.summary.total >= 2);
  assert.equal(checkedOutResults.summary.resumable, checkedOutResults.summary.total);
  const checkedOutChangedCount = checkedOutResults.agents
    .flatMap((agent) => agent.runs)
    .filter((run) => (run.review?.changedFiles.length ?? 0) > 0).length;
  assert.equal(checkedOutResults.summary.changed, checkedOutChangedCount);
  assert.ok(checkedOutChangedCount >= 1);
  const checkedOutChangedFileCount = checkedOutResults.agents
    .flatMap((agent) => agent.runs)
    .flatMap((run) => run.review?.changedFiles ?? []).length;
  assert.equal(checkedOutResults.summary.changedFiles, checkedOutChangedFileCount);
  assert.ok(checkedOutResults.changedFiles.some((file) => (
    file.agentId === checkoutAgent.agent.id
    && file.runId === checkoutPlan.run.id
    && file.path === "report.md"
    && file.status === "A"
    && file.branchName === checkoutPlan.plan.branchName
    && file.resultCommit === null
  )));
  assert.equal(checkedOutResultRun?.status, "stopped");
  assert.equal(checkedOutResultRun?.commands.checkoutBranch.join(" "), `npm run cli -- runs checkout ${checkoutPlan.run.id} --dir ${resultsCheckoutDir}/${checkoutPlan.run.id}`);
  assert.equal(checkedOutResultRun?.commands.reviewRun.join(" "), `npm run cli -- runs review ${checkoutPlan.run.id} --checkout-dir ${resultsCheckoutDir}/${checkoutPlan.run.id}`);
  assert.equal(checkedOutResultRun?.commands.inspectRun.join(" "), `npm run cli -- runs inspect ${checkoutPlan.run.id}`);
  assert.equal(checkedOutResultRun?.checkout?.dir, path.join(resultsCheckoutDir, checkoutPlan.run.id));
  assert.equal(checkedOutResultRun?.checkout?.headCommit, expectedCheckoutHead);
  assert.equal(checkedOutResultRun?.checkout?.matchesResultCommit, null);
  assert.deepEqual(checkedOutResultRun?.review?.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.equal(await fs.readFile(path.join(resultsCheckoutDir, checkoutPlan.run.id, "report.md"), "utf8"), "branch report\n");
  const changedOnlyResultsDir = path.join(tempRoot, "changed-only-results");
  const changedOnlyResults = await cliJson<{
    checkoutDir: string;
    summary: { total: number; changed: number | null; changedFiles: number | null };
    changedFiles: Array<{ runId: string; path: string }>;
    agents: Array<{
      agentId: string;
      summary: { total: number };
      runs: Array<{ id: string; review?: { changedFiles: Array<{ status: string; path: string }> } }>;
    }>;
  }>(baseUrl, [
    "runs",
    "results",
    "--agent",
    checkoutAgent.agent.id,
    "--status",
    "stopped",
    "--checkout-dir",
    changedOnlyResultsDir,
    "--changed-only",
  ]);
  const changedOnlyAgent = changedOnlyResults.agents.find((agent) => agent.agentId === checkoutAgent.agent.id);
  assert.equal(changedOnlyResults.checkoutDir, changedOnlyResultsDir);
  const changedOnlyCount = changedOnlyResults.agents
    .flatMap((agent) => agent.runs)
    .filter((run) => (run.review?.changedFiles.length ?? 0) > 0).length;
  assert.equal(changedOnlyResults.summary.total, changedOnlyCount);
  assert.equal(changedOnlyResults.summary.changed, changedOnlyCount);
  assert.ok(changedOnlyCount >= 1);
  const changedOnlyFileCount = changedOnlyResults.agents
    .flatMap((agent) => agent.runs)
    .flatMap((run) => run.review?.changedFiles ?? []).length;
  const changedOnlyNext = await cliJson<{
    checkoutDir: string;
    summary: { total: number; changed: number | null; changedFiles: number | null };
    nextSteps: Array<{
      action: string;
      reason: string;
      agentId: string;
      runId: string;
      status: string;
      state: string;
      objective: string;
      workerId: string | null;
      location: string | null;
      branchName: string;
      resultCommit: string | null;
      changedFiles: number | null;
      commits: number | null;
      command: string[];
      commands: { checkoutBranch: string[]; reviewRun: string[]; inspectRun: string[] };
    }>;
    agents?: unknown;
  }>(baseUrl, [
    "runs",
    "results",
    "--agent",
    checkoutAgent.agent.id,
    "--status",
    "stopped",
    "--checkout-dir",
    changedOnlyResultsDir,
    "--changed-only",
    "--next",
  ]);
  assert.equal(changedOnlyNext.checkoutDir, changedOnlyResults.checkoutDir);
  assert.equal(changedOnlyNext.summary.total, changedOnlyResults.summary.total);
  assert.equal(changedOnlyNext.summary.changed, changedOnlyResults.summary.changed);
  assert.equal(changedOnlyNext.summary.changedFiles, changedOnlyResults.summary.changedFiles);
  assert.equal(changedOnlyNext.agents, undefined);
  assert.ok(changedOnlyNext.nextSteps.some((step) => (
    step.action === "review_changed_result"
    && step.reason === "changed_result_branch"
    && step.agentId === checkoutAgent.agent.id
    && step.runId === checkoutPlan.run.id
    && step.status === "stopped"
    && step.state === "resumable"
    && step.objective === "checkout run branch"
    && step.workerId === null
    && step.location === null
    && step.branchName === checkoutPlan.plan.branchName
    && step.resultCommit === null
    && step.changedFiles === 1
    && step.commits === 1
    && step.command.join(" ") === `npm run cli -- runs review ${checkoutPlan.run.id} --checkout-dir ${changedOnlyResultsDir}/${checkoutPlan.run.id}`
    && step.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${checkoutPlan.run.id} --dir ${changedOnlyResultsDir}/${checkoutPlan.run.id}`
    && step.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${checkoutPlan.run.id}`
  )));
  assert.equal(changedOnlyResults.summary.changedFiles, changedOnlyFileCount);
  assert.ok(changedOnlyResults.changedFiles.every((file) => file.path.length > 0));
  assert.ok(changedOnlyAgent?.runs.some((run) => run.id === checkoutPlan.run.id));
  assert.equal(changedOnlyAgent?.runs.some((run) => run.id === unchangedCheckoutPlan.run.id), false);
  assert.ok(changedOnlyAgent?.runs.every((run) => (run.review?.changedFiles.length ?? 0) > 0));
  const changedPathResults = await cliJson<{
    summary: { total: number; changedFiles: number | null };
    changedFiles: Array<{ runId: string; path: string }>;
    agents: Array<{ runs: Array<{ id: string; review?: { changedFiles: Array<{ path: string }> } }> }>;
  }>(baseUrl, [
    "runs",
    "results",
    "--agent",
    checkoutAgent.agent.id,
    "--status",
    "stopped",
    "--checkout-dir",
    changedOnlyResultsDir,
    "--changed-path",
    "report.md",
  ]);
  assert.equal(changedPathResults.summary.total, 1);
  assert.equal(changedPathResults.summary.changedFiles, 1);
  assert.deepEqual(changedPathResults.changedFiles.map((file) => [file.runId, file.path]), [[checkoutPlan.run.id, "report.md"]]);
  assert.deepEqual(changedPathResults.agents.flatMap((agent) => agent.runs).map((run) => run.id), [checkoutPlan.run.id]);
  const sessionReviewCheckoutDir = path.join(tempRoot, "session-review-checkouts");
  const checkedOutSessionReview = await cliJson<{
    checkoutDir: string;
    summary: {
      changedResults: number | null;
      changedFiles: number | null;
      agentSummaries: Array<{
        agentId: string;
        changedResults: number | null;
        changedFiles: number | null;
      }>;
    };
    recoveryPreview: Array<{ runId: string; currentStatus?: string; dryRun?: boolean }>;
    changedResults: Array<{
      agentId: string;
      runId: string;
      status: string;
      branchName: string;
      resultCommit: string | null;
      checkoutDir: string;
      changedFiles: Array<{ status: string; path: string }>;
      commits: Array<{ sha: string; subject: string }>;
      error: string | null;
      commands: { reviewRun: string[] };
    }>;
    resultCheckouts: Array<{
      agentId: string;
      total: number;
      checkouts: Array<{
        run: { id: string; status: string; branchName: string };
        checkout: { dir: string; headCommit: string };
        review: { changedFiles: Array<{ status: string; path: string }> };
      }>;
    }>;
    nextSteps: Array<{ action: string; reason: string; count: number; command: string[] }>;
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
  assert.ok((checkedOutSessionReview.summary.changedResults ?? 0) >= 1);
  assert.ok((checkedOutSessionReview.summary.changedFiles ?? 0) >= 1);
  assert.ok(checkedOutSessionReview.summary.agentSummaries.some((agent) => (
    agent.agentId === checkoutAgent.agent.id
    && (agent.changedResults ?? 0) >= 1
    && (agent.changedFiles ?? 0) >= 1
  )));
  assert.ok(checkedOutSessionReview.nextSteps.some((step) => (
    step.action === "review_changed_results"
    && step.reason === "changed_results_found"
    && step.count >= 1
  )));
  assert.ok(checkedOutSessionReview.recoveryPreview.some((run) => (
    run.runId === checkoutPlan.run.id && run.currentStatus === "stopped" && run.dryRun === true
  )));
  assert.equal(checkedOutReviewRun?.run.status, "stopped");
  assert.equal(checkedOutReviewRun?.run.branchName, checkoutPlan.plan.branchName);
  assert.equal(checkedOutReviewRun?.checkout.dir, path.join(sessionReviewCheckoutDir, checkoutPlan.run.id));
  assert.equal(checkedOutReviewRun?.checkout.headCommit, expectedCheckoutHead);
  assert.deepEqual(checkedOutReviewRun?.review.changedFiles, [{ status: "A", path: "report.md" }]);
  assert.ok(checkedOutSessionReview.changedResults.some((run) => (
    run.agentId === checkoutAgent.agent.id
    && run.runId === checkoutPlan.run.id
    && run.status === "stopped"
    && run.branchName === checkoutPlan.plan.branchName
    && run.resultCommit === null
    && run.checkoutDir === path.join(sessionReviewCheckoutDir, checkoutPlan.run.id)
    && run.error === null
    && run.commands.reviewRun.join(" ") === `npm run cli -- runs review ${checkoutPlan.run.id} --checkout-dir ${path.join(sessionReviewCheckoutDir, checkoutPlan.run.id)}`
    && run.changedFiles.some((file) => file.status === "A" && file.path === "report.md")
  )));
  assert.equal(await fs.readFile(path.join(sessionReviewCheckoutDir, checkoutPlan.run.id, "report.md"), "utf8"), "branch report\n");
  const changedPathSessionReview = await cliJson<{
    summary: { changedResults: number | null; changedFiles: number | null };
    changedResults: Array<{ runId: string; changedFiles: Array<{ path: string }> }>;
    resultCheckouts: Array<{ checkouts: Array<{ run: { id: string } }> }>;
  }>(baseUrl, [
    "runs",
    "session-review",
    checkoutSessionName,
    "--include-stopped",
    "--checkout-dir",
    sessionReviewCheckoutDir,
    "--changed-path",
    "report.md",
  ]);
  assert.deepEqual(
    changedPathSessionReview.resultCheckouts.flatMap((agent) => agent.checkouts.map((checkout) => checkout.run.id)),
    [checkoutPlan.run.id],
  );
  assert.equal(changedPathSessionReview.summary.changedResults, 1);
  assert.equal(changedPathSessionReview.summary.changedFiles, 1);
  assert.deepEqual(changedPathSessionReview.changedResults.map((run) => run.runId), [checkoutPlan.run.id]);
  assert.equal(changedPathSessionReview.changedResults[0].changedFiles[0].path, "report.md");

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
    agents: Array<{ runs: Array<{ id: string; status: string; resultCommit: string | null; resumable: boolean }> }>;
  };
  assert.ok(stoppedMonitored.agents.some((agent) => (
    agent.runs.length === 2 && agent.runs.every((run) => run.status === "stopped" && run.resultCommit === null && run.resumable)
  )));
  const stoppedMonitorNext = await cliJson<{
    summary: { statuses: Record<string, number>; resumable: number; warnings: number };
    nextSteps: Array<{
      action: string;
      reason: string;
      runId: string;
      resultCommit: string | null;
      warning: string | null;
      resumable: boolean;
      command: string[];
      commands: { resumeBranch: string[] | null; inspectRun: string[] };
    }>;
  }>(baseUrl, [
    "runs",
    "monitor",
    "--agent",
    stopMatchingAgentBody.agent.id,
    "--status",
    "stopped",
    "--next",
  ]);
  assert.equal(stoppedMonitorNext.summary.statuses.stopped, 2);
  assert.equal(stoppedMonitorNext.summary.resumable, 2);
  assert.equal(stoppedMonitorNext.summary.warnings, 0);
  assert.ok(stoppedMonitorNext.nextSteps.every((step) => (
    step.action === "resume_branch"
    && step.reason === "stopped_branch_without_result_commit"
    && step.resultCommit === null
    && step.warning === null
    && step.resumable
    && step.commands.resumeBranch !== null
  )));
  assert.ok(stoppedMonitorNext.nextSteps.some((step) => (
    step.runId === stopMatchingRunA.run.id
    && step.command.join(" ") === `npm run cli -- runs resume-branch ${stopMatchingRunA.run.id}`
    && step.commands.resumeBranch?.join(" ") === `npm run cli -- runs resume-branch ${stopMatchingRunA.run.id}`
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

  const resultSummarySessionName = `result-summary-${process.pid}`;
  await fs.mkdir(path.join(".threadbeat", "worker-sessions"), { recursive: true });
  await fs.writeFile(path.join(".threadbeat", "worker-sessions", `${resultSummarySessionName}.json`), `${JSON.stringify({
    session: resultSummarySessionName,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", cliWorkFinalizeAgent.agent.id],
    workers: [],
  })}\n`);
  const sessionResultSummary = await cliJson<{
    session: { session: string; workers: { total: number; alive: number; dead: number } };
    totals: { statuses: Record<string, number>; resultCommits: number; resumableStopped: number };
    resultCommits: Array<{
      agentId: string;
      runId: string;
      status: string;
      resultCommit: string;
      commands: { inspectRun: string[]; checkoutBranch: string[]; reviewRun: string[] };
    }>;
    commands: { resultsNext: string[]; changedResults: string[] };
    nextStep: { action: string; reason: string; command: string[] };
  }>(baseUrl, ["runs", "session-summary", resultSummarySessionName, "--next"]);
  assert.equal(sessionResultSummary.session.session, resultSummarySessionName);
  assert.equal(sessionResultSummary.session.workers.total, 0);
  assert.equal(sessionResultSummary.session.workers.alive, 0);
  assert.equal(sessionResultSummary.session.workers.dead, 0);
  assert.equal(sessionResultSummary.totals.statuses.completed, 1);
  assert.equal(sessionResultSummary.totals.resultCommits, 1);
  assert.equal(sessionResultSummary.totals.resumableStopped, 0);
  const resultApplyId = "smoke-result-apply-review";
  const resultApplyDir = path.join(".threadbeat", "worker-sessions", "apply", resultSummarySessionName);
  const resultApplyPath = path.join(resultApplyDir, `${resultApplyId}.json`);
  await fs.mkdir(resultApplyDir, { recursive: true });
  await fs.writeFile(resultApplyPath, `${JSON.stringify({
    observedAt: "2026-01-01T00:00:00.000Z",
    session: resultSummarySessionName,
    source: "status",
    applyId: resultApplyId,
    applyPath: resultApplyPath,
    dryRun: false,
    resume: false,
    filter: { branchAction: ["resume_branch"] },
    selected: 1,
    skippedCompleted: 0,
    commands: [{
      scope: "branch",
      action: "resume_branch",
      reason: "applied branch resume",
      runId: cliWorkFinalizePlan.run.id,
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", cliWorkFinalizePlan.run.id],
    }],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    executions: [{
      scope: "branch",
      action: "resume_branch",
      reason: "applied branch resume",
      runId: cliWorkFinalizePlan.run.id,
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", cliWorkFinalizePlan.run.id],
      exitCode: 0,
      stdout: "{}",
      stderr: "",
      output: {},
    }],
  }, null, 2)}\n`);
  const readyResultApply = await cliJson<{
    summary: {
      actions: { inspectResults: string[] | null; reviewReadyResults: string[] | null };
      affectedRuns: Array<{ runId: string; currentRun: { status: string; resultCommit: string | null; nextAction: string } | null }>;
    };
  }>(baseUrl, ["runs", "session-applies", resultSummarySessionName, "--apply-id", resultApplyId]);
  assert.equal(
    readyResultApply.summary.actions.inspectResults?.join(" "),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next`,
  );
  assert.equal(
    readyResultApply.summary.actions.reviewReadyResults?.join(" "),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only`,
  );
  const readyResultApplyShell = await cliRaw(baseUrl, ["runs", "session-applies", resultSummarySessionName, "--apply-id", resultApplyId, "--ready-results", "--format", "shell"]);
  assert.equal(
    readyResultApplyShell.stdout.trim(),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only`,
  );
  const readyResultChangedShell = await cliRaw(baseUrl, [
    "runs",
    "session-applies",
    resultSummarySessionName,
    "--apply-id",
    resultApplyId,
    "--ready-results",
    "--format",
    "shell",
    "--checkout-dir",
    "./checkouts/smoke-ready-results",
    "--changed-only",
    "--changed-path",
    "report.md",
  ]);
  assert.equal(
    readyResultChangedShell.stdout.trim(),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only --checkout-dir ./checkouts/smoke-ready-results --changed-only --changed-path report.md`,
  );
  const readyResultAppliesShell = await cliRaw(baseUrl, ["runs", "session-applies", resultSummarySessionName, "--ready-results", "--format", "shell"]);
  assert.equal(
    readyResultAppliesShell.stdout.trim(),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only`,
  );
  const readyResultSummaryGroupShell = await cliRaw(baseUrl, [
    "runs",
    "session-applies",
    resultSummarySessionName,
    "--summary-group",
    "ready-to-review",
    "--format",
    "shell",
    "--checkout-dir",
    "./checkouts/smoke-ready-results",
    "--changed-only",
    "--changed-path",
    "report.md",
  ]);
  assert.equal(
    readyResultSummaryGroupShell.stdout.trim(),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only --checkout-dir ./checkouts/smoke-ready-results --changed-only --changed-path report.md`,
  );
  const readyResultActionQueueShell = await cliRaw(baseUrl, [
    "runs",
    "session-applies",
    resultSummarySessionName,
    "--action-queue",
    "--format",
    "shell",
    "--checkout-dir",
    "./checkouts/smoke-ready-results",
    "--changed-only",
    "--changed-path",
    "report.md",
  ]);
  assert.equal(
    readyResultActionQueueShell.stdout.trim(),
    `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only --checkout-dir ./checkouts/smoke-ready-results --changed-only --changed-path report.md`,
  );
  const readyResultActionQueueJson = await cliJson<{
    actionQueue: {
      counts: { actionable: number; resumeNeeded: number; readyToReview: number; waiting: number };
      actions: Array<{ applyId: string; action: string; resultRuns: string[]; command: string[] }>;
    };
  }>(baseUrl, [
    "runs",
    "session-applies",
    resultSummarySessionName,
    "--action-queue",
    "--checkout-dir",
    "./checkouts/smoke-ready-results",
    "--changed-only",
    "--changed-path",
    "report.md",
  ]);
  assert.ok(readyResultActionQueueJson.actionQueue.counts.actionable >= 1);
  assert.equal(readyResultActionQueueJson.actionQueue.counts.resumeNeeded, 0);
  assert.ok(readyResultActionQueueJson.actionQueue.counts.readyToReview >= 1);
  assert.ok(readyResultActionQueueJson.actionQueue.actions.some((action) => (
    action.applyId === resultApplyId
    && action.action === "review_ready_results"
    && action.resultRuns.join(",") === cliWorkFinalizePlan.run.id
    && action.command.join(" ") === `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only --checkout-dir ./checkouts/smoke-ready-results --changed-only --changed-path report.md`
  )));
  const readyResultApplySummary = await cliJson<{
    summary: {
      counts: { readyToReview: number; resumeNeeded: number; waiting: number };
      groups: { readyToReview: Array<{ applyId: string; resultRuns: string[]; command: string[] }> };
    };
  }>(baseUrl, ["runs", "session-applies", resultSummarySessionName, "--summary"]);
  assert.ok(readyResultApplySummary.summary.counts.readyToReview >= 1);
  assert.equal(readyResultApplySummary.summary.counts.resumeNeeded, 0);
  assert.ok(readyResultApplySummary.summary.groups.readyToReview.some((apply) => (
    apply.applyId === resultApplyId
    && apply.resultRuns.join(",") === cliWorkFinalizePlan.run.id
    && apply.command.join(" ") === `npm run cli -- runs results --session ${resultSummarySessionName} --run ${cliWorkFinalizePlan.run.id} --next --commands-only`
  )));
  assert.equal(readyResultApply.summary.affectedRuns[0].currentRun?.status, "completed");
  assert.equal(readyResultApply.summary.affectedRuns[0].currentRun?.resultCommit, cliWorkFinalized.processed[0].finalized.result.commitSha);
  assert.equal(readyResultApply.summary.affectedRuns[0].currentRun?.nextAction, "review_branch");
  assert.ok(sessionResultSummary.resultCommits.some((commit) => (
    commit.agentId === cliWorkFinalizeAgent.agent.id
    && commit.runId === cliWorkFinalizePlan.run.id
    && commit.status === "completed"
    && commit.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    && commit.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${cliWorkFinalizePlan.run.id}`
    && commit.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${cliWorkFinalizePlan.run.id} --dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
    && commit.commands.reviewRun.join(" ") === `npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
  )));
  assert.equal(sessionResultSummary.nextStep.action, "inspect_results");
  assert.equal(sessionResultSummary.nextStep.reason, "result_commits_available");
  assert.equal(sessionResultSummary.nextStep.command.join(" "), `npm run cli -- runs results --session ${resultSummarySessionName} --next`);
  assert.equal(sessionResultSummary.commands.resultsNext.join(" "), `npm run cli -- runs results --session ${resultSummarySessionName} --next`);
  assert.equal(
    sessionResultSummary.commands.changedResults.join(" "),
    `npm run cli -- runs results --session ${resultSummarySessionName} --checkout-dir ./checkouts/${resultSummarySessionName}-results --changed-only --next`,
  );
  const resultCommandsOnly = await cliJson<{
    summary: { resultCommits: number };
    commands: Array<{ action: string; runId: string; resultCommit: string | null; command: string[] }>;
    nextSteps?: unknown;
    resultCommits?: unknown;
  }>(baseUrl, ["runs", "results", "--session", resultSummarySessionName, "--next", "--commands-only"]);
  assert.equal(resultCommandsOnly.summary.resultCommits, 1);
  assert.equal(resultCommandsOnly.nextSteps, undefined);
  assert.equal(resultCommandsOnly.resultCommits, undefined);
  assert.ok(resultCommandsOnly.commands.some((item) => (
    item.action === "review_result"
    && item.runId === cliWorkFinalizePlan.run.id
    && item.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    && item.command.join(" ") === `npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
  )));
  const resultCommandsShell = await cliRaw(baseUrl, ["runs", "results", "--session", resultSummarySessionName, "--next", "--commands-only", "--format", "shell"]);
  assert.ok(resultCommandsShell.stdout.trim().split("\n").includes(
    `npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`,
  ));
  const sessionResultSummaryPoll = await cliRaw(baseUrl, [
    "runs",
    "session-summary",
    resultSummarySessionName,
    "--next",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
  ]);
  const sessionResultSummarySnapshots = sessionResultSummaryPoll.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
    observedAt: string;
    session: { session: string };
    totals: { resultCommits: number };
    resultCommits: Array<{ runId: string; resultCommit: string }>;
    nextStep: { action: string };
  });
  assert.equal(sessionResultSummarySnapshots.length, 2);
  assert.ok(sessionResultSummarySnapshots.every((snapshot) => (
    /^\d{4}-\d{2}-\d{2}T/.test(snapshot.observedAt)
    && snapshot.session.session === resultSummarySessionName
    && snapshot.totals.resultCommits === 1
    && snapshot.resultCommits.some((commit) => (
      commit.runId === cliWorkFinalizePlan.run.id
      && commit.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    ))
    && snapshot.nextStep.action === "inspect_results"
  )));
  const resultFleetSummary = await cliJson<{
    totals: { resultCommits: number };
    branchActions: Record<string, number>;
    branchActionQueue: Array<{
      session: string;
      action: string;
      reason: string;
      agentId: string;
      runId: string;
      resultCommit: string;
      command: string[];
    }>;
    resultCommits: Array<{
      session: string;
      agentId: string;
      runId: string;
      resultCommit: string;
      commands: { inspectRun: string[]; checkoutBranch: string[]; reviewRun: string[]; sessionResults: string[] };
    }>;
    sessions: Array<{
      session: { session: string };
      resultCommits: Array<{ runId: string; resultCommit: string }>;
      nextStep?: { action: string; reason: string; command: string[] };
    }>;
  }>(baseUrl, ["runs", "sessions", "--session", resultSummarySessionName, "--summary", "--next"]);
  assert.equal(resultFleetSummary.totals.resultCommits, 1);
  assert.equal(resultFleetSummary.branchActions.review_branch, 1);
  assert.ok(resultFleetSummary.branchActionQueue.some((commit) => (
    commit.session === resultSummarySessionName
    && commit.action === "review_branch"
    && commit.reason === "result_commit_available"
    && commit.agentId === cliWorkFinalizeAgent.agent.id
    && commit.runId === cliWorkFinalizePlan.run.id
    && commit.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    && commit.command.join(" ") === `npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
  )));
  const resultFleetInspectOnly = await cliJson<{
    filter: { action: string[]; totalSessions: number };
    totals: { sessions: number; resultCommits: number };
    nextActions: Record<string, number>;
    actionQueue: Array<{ session: string; action: string }>;
  }>(baseUrl, ["runs", "sessions", "--session", resultSummarySessionName, "--summary", "--next", "--action", "inspect_results"]);
  assert.deepEqual(resultFleetInspectOnly.filter.action, ["inspect_results"]);
  assert.equal(resultFleetInspectOnly.filter.totalSessions, 1);
  assert.equal(resultFleetInspectOnly.totals.sessions, 1);
  assert.equal(resultFleetInspectOnly.totals.resultCommits, 1);
  assert.equal(resultFleetInspectOnly.nextActions.inspect_results, 1);
  assert.ok(resultFleetInspectOnly.actionQueue.every((item) => item.action === "inspect_results"));
  const resultFleetReviewBranchOnly = await cliJson<{
    filter: { branchAction: string[]; totalSessions: number };
    branchActions: Record<string, number>;
    branchActionQueue: Array<{ session: string; action: string; runId: string; resultCommit: string }>;
    resultCommits: Array<{ runId: string; resultCommit: string }>;
    resumableBranches: Array<{ runId: string }>;
  }>(baseUrl, ["runs", "sessions", "--session", resultSummarySessionName, "--summary", "--next", "--branch-action", "review_branch"]);
  assert.deepEqual(resultFleetReviewBranchOnly.filter.branchAction, ["review_branch"]);
  assert.equal(resultFleetReviewBranchOnly.filter.totalSessions, 1);
  assert.equal(resultFleetReviewBranchOnly.branchActions.review_branch, 1);
  assert.ok(resultFleetReviewBranchOnly.branchActionQueue.every((item) => item.action === "review_branch"));
  assert.ok(resultFleetReviewBranchOnly.branchActionQueue.some((commit) => (
    commit.session === resultSummarySessionName
    && commit.runId === cliWorkFinalizePlan.run.id
    && commit.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
  )));
  assert.ok(resultFleetReviewBranchOnly.resultCommits.some((commit) => commit.runId === cliWorkFinalizePlan.run.id));
  assert.equal(resultFleetReviewBranchOnly.resumableBranches.length, 0);
  const resultFleetCommandsOnly = await cliJson<{
    totals: { sessions: number; resultCommits: number };
    nextActions: Record<string, number>;
    branchActions: Record<string, number>;
    commands: Array<{
      scope: string;
      session: string;
      action: string;
      reason: string;
      runId?: string;
      resultCommit?: string | null;
      command: string[];
    }>;
    sessions?: unknown;
    resultCommits?: unknown;
    resumableBranches?: unknown;
  }>(baseUrl, ["runs", "sessions", "--session", resultSummarySessionName, "--next", "--commands-only"]);
  assert.equal(resultFleetCommandsOnly.totals.sessions, 1);
  assert.equal(resultFleetCommandsOnly.totals.resultCommits, 1);
  assert.equal(resultFleetCommandsOnly.nextActions.inspect_results, 1);
  assert.equal(resultFleetCommandsOnly.branchActions.review_branch, 1);
  assert.equal(resultFleetCommandsOnly.sessions, undefined);
  assert.equal(resultFleetCommandsOnly.resultCommits, undefined);
  assert.equal(resultFleetCommandsOnly.resumableBranches, undefined);
  assert.ok(resultFleetCommandsOnly.commands.some((item) => (
    item.scope === "session"
    && item.session === resultSummarySessionName
    && item.action === "inspect_results"
    && item.reason === "result_commits_available"
    && item.command.join(" ") === `npm run cli -- runs results --session ${resultSummarySessionName} --next`
  )));
  assert.ok(resultFleetCommandsOnly.commands.some((item) => (
    item.scope === "branch"
    && item.session === resultSummarySessionName
    && item.action === "review_branch"
    && item.runId === cliWorkFinalizePlan.run.id
    && item.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    && item.command.join(" ") === `npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
  )));
  const resultFleetCommandsShell = await cliRaw(baseUrl, ["runs", "sessions", "--session", resultSummarySessionName, "--next", "--commands-only", "--format", "shell"]);
  const resultFleetCommandLines = resultFleetCommandsShell.stdout.trim().split("\n");
  assert.ok(resultFleetCommandLines.includes(`npm run cli -- runs results --session ${resultSummarySessionName} --next`));
  assert.ok(resultFleetCommandLines.includes(`npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`));
  assert.ok(resultFleetSummary.resultCommits.some((commit) => (
    commit.session === resultSummarySessionName
    && commit.agentId === cliWorkFinalizeAgent.agent.id
    && commit.runId === cliWorkFinalizePlan.run.id
    && commit.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    && commit.commands.inspectRun.join(" ") === `npm run cli -- runs inspect ${cliWorkFinalizePlan.run.id}`
    && commit.commands.checkoutBranch.join(" ") === `npm run cli -- runs checkout ${cliWorkFinalizePlan.run.id} --dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
    && commit.commands.reviewRun.join(" ") === `npm run cli -- runs review ${cliWorkFinalizePlan.run.id} --checkout-dir ./checkouts/${resultSummarySessionName}-results/${cliWorkFinalizePlan.run.id}`
    && commit.commands.sessionResults.join(" ") === `npm run cli -- runs results --session ${resultSummarySessionName} --next`
  )));
  assert.ok(resultFleetSummary.sessions.some((session) => (
    session.session.session === resultSummarySessionName
    && session.nextStep?.action === "inspect_results"
    && session.nextStep.reason === "result_commits_available"
    && session.resultCommits.some((commit) => (
      commit.runId === cliWorkFinalizePlan.run.id
      && commit.resultCommit === cliWorkFinalized.processed[0].finalized.result.commitSha
    ))
  )));

  const liveSummarySessionName = `live-summary-${process.pid}`;
  await fs.mkdir(path.join(".threadbeat", "worker-sessions", liveSummarySessionName), { recursive: true });
  await fs.writeFile(path.join(".threadbeat", "worker-sessions", `${liveSummarySessionName}.json`), `${JSON.stringify({
    session: liveSummarySessionName,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", cliWorkFinalizeAgent.agent.id],
    workers: [{
      workerId: "smoke-live-summary-1",
      pid: process.pid,
      stdoutPath: path.join(".threadbeat", "worker-sessions", liveSummarySessionName, "worker.out.log"),
      stderrPath: path.join(".threadbeat", "worker-sessions", liveSummarySessionName, "worker.err.log"),
    }],
  })}\n`);
  const liveSessionWait = await cliJson<{
    timedOut: boolean;
    commands: { monitor: string[] };
    nextStep: { action: string; reason: string; command: string[] };
  }>(baseUrl, ["runs", "session-wait", liveSummarySessionName, "--max-polls", "1", "--interval-ms", "1"]);
  assert.equal(liveSessionWait.timedOut, true);
  assert.equal(liveSessionWait.commands.monitor.join(" "), `npm run cli -- runs monitor --agents ${cliWorkFinalizeAgent.agent.id} --status planned,running,stopped --next --checkout-dir ./checkouts/${liveSummarySessionName}-monitor`);
  assert.equal(liveSessionWait.nextStep.action, "continue_watch");
  assert.equal(liveSessionWait.nextStep.reason, "workers_still_alive");
  assert.equal(liveSessionWait.nextStep.command.join(" "), `npm run cli -- runs session-summary ${liveSummarySessionName} --next --max-polls 30 --interval-ms 10000`);
  const liveSessionSummary = await cliJson<{
    session: { workers: { alive: number } };
    commands: { sessionSummaryWatch: string[] };
    nextStep: { action: string; reason: string; command: string[] };
  }>(baseUrl, ["runs", "session-summary", liveSummarySessionName, "--next"]);
  assert.equal(liveSessionSummary.session.workers.alive, 1);
  assert.equal(liveSessionSummary.commands.sessionSummaryWatch.join(" "), `npm run cli -- runs session-summary ${liveSummarySessionName} --next --max-polls 30 --interval-ms 10000`);
  assert.equal(liveSessionSummary.nextStep.action, "continue_watch");
  assert.equal(liveSessionSummary.nextStep.reason, "workers_still_alive");
  assert.equal(liveSessionSummary.nextStep.command.join(" "), `npm run cli -- runs session-summary ${liveSummarySessionName} --next --max-polls 30 --interval-ms 10000`);

  const skippedLiveArchive = await cliJson<{
    archived: unknown[];
    skipped: Array<{ session: string; reason: string; workers: { alive: number } }>;
  }>(baseUrl, ["runs", "archive-sessions", "--session", liveSummarySessionName]);
  assert.equal(skippedLiveArchive.archived.length, 0);
  assert.equal(skippedLiveArchive.skipped[0]?.session, liveSummarySessionName);
  assert.equal(skippedLiveArchive.skipped[0]?.reason, "workers_alive");
  assert.equal(skippedLiveArchive.skipped[0]?.workers.alive, 1);
  assert.equal(await fileExists(path.join(".threadbeat", "worker-sessions", `${liveSummarySessionName}.json`)), true);

  const archiveAgentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "archive-session-agent",
      repoUrl: "https://github.com/example/archive-session-agent.git",
      currentRef: "main",
    },
  });
  assert.equal(archiveAgentResponse.statusCode, 200);
  const archiveAgentBody = JSON.parse(archiveAgentResponse.body) as { agent: { id: string } };
  const archiveSessionName = `archive-session-${process.pid}`;
  const archiveSessionPath = path.join(".threadbeat", "worker-sessions", `${archiveSessionName}.json`);
  const archiveSessionLogDir = path.join(".threadbeat", "worker-sessions", archiveSessionName);
  await fs.mkdir(archiveSessionLogDir, { recursive: true });
  await fs.writeFile(path.join(archiveSessionLogDir, "worker.out.log"), "finished\n");
  await fs.writeFile(archiveSessionPath, `${JSON.stringify({
    session: archiveSessionName,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "work", "--agent", archiveAgentBody.agent.id],
    workers: [{
      workerId: "smoke-archive-worker-1",
      pid: null,
      stdoutPath: path.join(archiveSessionLogDir, "worker.out.log"),
      stderrPath: path.join(archiveSessionLogDir, "worker.err.log"),
    }],
  })}\n`);
  const archiveSessionSummary = await cliJson<{
    commands: { archiveSessionPreview: string[]; archiveSession: string[] };
    nextStep: { action: string; reason: string; command: string[] };
  }>(baseUrl, ["runs", "session-summary", archiveSessionName, "--next"]);
  assert.equal(archiveSessionSummary.nextStep.action, "archive_session_preview");
  assert.equal(archiveSessionSummary.nextStep.reason, "dead_session_without_runs");
  assert.equal(archiveSessionSummary.nextStep.command.join(" "), `npm run cli -- runs archive-sessions --session ${archiveSessionName} --dry-run`);
  assert.equal(archiveSessionSummary.commands.archiveSessionPreview.join(" "), `npm run cli -- runs archive-sessions --session ${archiveSessionName} --dry-run`);
  assert.equal(archiveSessionSummary.commands.archiveSession.join(" "), `npm run cli -- runs archive-sessions --session ${archiveSessionName}`);
  const archiveFleetSummary = await cliJson<{
    sessions: Array<{
      session: { session: string };
      commands?: { archiveSessionPreview: string[] };
      nextStep?: { action: string; reason: string; command: string[] };
    }>;
  }>(baseUrl, ["runs", "sessions", "--session", archiveSessionName, "--summary", "--next"]);
  assert.equal(archiveFleetSummary.sessions[0]?.session.session, archiveSessionName);
  assert.equal(archiveFleetSummary.sessions[0]?.nextStep?.action, "archive_session_preview");
  assert.equal(archiveFleetSummary.sessions[0]?.nextStep?.reason, "dead_session_without_runs");
  assert.equal(archiveFleetSummary.sessions[0]?.nextStep?.command.join(" "), `npm run cli -- runs archive-sessions --session ${archiveSessionName} --dry-run`);
  assert.equal(archiveFleetSummary.sessions[0]?.commands?.archiveSessionPreview.join(" "), `npm run cli -- runs archive-sessions --session ${archiveSessionName} --dry-run`);
  const archiveDryRun = await cliJson<{
    dryRun: boolean;
    archived: Array<{ session: string; reason: string; workers: { alive: number }; paths: { destinationFile: string; destinationLogDir: string } }>;
  }>(baseUrl, ["runs", "archive-sessions", "--session", archiveSessionName, "--dry-run"]);
  assert.equal(archiveDryRun.dryRun, true);
  assert.equal(archiveDryRun.archived[0]?.session, archiveSessionName);
  assert.equal(archiveDryRun.archived[0]?.reason, "all_workers_dead");
  assert.equal(archiveDryRun.archived[0]?.workers.alive, 0);
  assert.equal(await fileExists(archiveSessionPath), true);
  assert.equal(await fileExists(archiveSessionLogDir), true);
  const archivedSession = await cliJson<{
    dryRun: boolean;
    note: string;
    archived: Array<{ session: string; reason: string; paths: { destinationFile: string; destinationLogDir: string } }>;
  }>(baseUrl, ["runs", "archive-sessions", "--session", archiveSessionName]);
  assert.equal(archivedSession.dryRun, false);
  assert.equal(archivedSession.archived[0]?.session, archiveSessionName);
  assert.equal(archivedSession.archived[0]?.reason, "all_workers_dead");
  assert.match(archivedSession.note, /Git branches are unchanged/);
  assert.equal(await fileExists(archiveSessionPath), false);
  assert.equal(await fileExists(archiveSessionLogDir), false);
  assert.equal(await fileExists(archivedSession.archived[0]?.paths.destinationFile ?? ""), true);
  assert.equal(await fileExists(archivedSession.archived[0]?.paths.destinationLogDir ?? ""), true);

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
