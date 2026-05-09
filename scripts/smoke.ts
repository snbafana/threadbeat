import assert from "node:assert/strict";

import { buildServer } from "../src/server.js";
import { cliJson, cliRaw } from "./cli-smoke-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptServerBaseUrl, scriptSettings } from "./settings-utils.js";
const tempRoot = await createScriptTempRoot("threadbeat-smoke");

const settings = scriptSettings({
  modalAppName: "threadbeat-smoke",
  tempRoot,
  overrides: { githubOwner: "threadbeat-smoke" },
});

const { app } = await buildServer(settings);

try {
  await app.listen({ host: settings.host, port: settings.port });
  const baseUrl = scriptServerBaseUrl(settings.host, app.server.address());

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
  await removeScriptTempRoot(tempRoot);
}
