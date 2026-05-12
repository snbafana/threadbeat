import { spawn } from "node:child_process";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import { buildAgentBootPlan, buildAgentRuntimeCheckPlan } from "./agentBoot.js";
import { getAgentRepositoryMetadata, planRunBranch } from "./agentRepository.js";
import { buildAgentTemplate } from "./agentTemplate.js";
import { GitHubHostedGitProvider } from "./hostedGit.js";
import { createInitialCommit } from "./gitRepositoryBootstrap.js";
import { assertValidGitRef } from "./git.js";
import { Database } from "./db.js";
import { createSandboxProvider } from "./modalProvider.js";
import { MessageBus } from "./messageBus.js";
import { buildPreflightReport } from "./preflight.js";
import { runPlanFromRow } from "./runPlanning.js";
import { SANDBOX_WORKDIR, SandboxService } from "./sandboxService.js";
import {
  executeWorkerSessionDrainContinuationRecord,
  listWorkerSessionApplyRecords,
  listWorkerSessionDrainContinuationRecords,
  queueWorkerSessionDrainContinuations,
  summarizeWorkerSessionApplyDrains,
} from "./workerSessionDrains.js";
import type { Settings } from "./config.js";

type AppParts = {
  app: FastifyInstance;
  db: Database;
};

export const buildServer = async (settings: Settings): Promise<AppParts> => {
  const db = new Database(settings.dbUrl, path.join(settings.projectRoot, "schema", "bootstrap.sql"));
  await db.initSchema();

  const bus = new MessageBus();
  const hostedGit = new GitHubHostedGitProvider(settings);
  const sandboxService = new SandboxService(db, createSandboxProvider(settings), bus);
  const app = Fastify({ logger: true });

  app.addHook("onClose", async () => {
    await db.close();
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/preflight", async () => ({
    preflight: buildPreflightReport(settings),
  }));

  app.get("/api/agents", async () => ({
    ok: true,
    agents: await db.listAgents(),
  }));

  app.post("/api/agent-template", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const template = buildAgentTemplate({
        name: parseString(body.name, "name"),
        id: parseOptionalString(body.id),
        description: parseOptionalString(body.description),
      });
      return { ok: true, template };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/agents/from-template", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const defaultBranch = parseOptionalString(body.defaultBranch) ?? "main";
      const template = buildAgentTemplate({
        name: parseString(body.name, "name"),
        id: parseOptionalString(body.id),
        description: parseOptionalString(body.description),
      });
      const provisionalAgent = {
        id: template.id,
        name: template.name,
        repo_url: `threadbeat-template://${template.id}`,
        current_ref: defaultBranch,
      };
      const dryRun = parseBoolean(body.dryRun, !settings.githubOwner?.trim() || !settings.githubToken?.trim());
      const hostedRepo = await hostedGit.createRepository({
        agent: provisionalAgent,
        dryRun,
        repoId: parseOptionalString(body.repoId) ?? template.id,
      });
      const initialized = hostedRepo.remoteUrl && !dryRun
        ? await createInitialCommit({
          branch: hostedRepo.defaultBranch,
          files: template.files,
          remoteUrl: hostedRepo.remoteUrl,
        })
        : null;
      const repoUrl = hostedAgentRepoUrl(hostedRepo);
      const agent = await db.createAgent({
        name: template.name,
        repoUrl,
        currentRef: hostedRepo.defaultBranch,
      });
      await db.createHostedGitRepo({
        agentId: agent.id,
        owner: hostedRepo.namespace,
        repo: hostedRepo.providerRepoId,
      });
      await db.appendMessage({
        agentId: agent.id,
        type: initialized ? "agent_template_repo_initialized" : "agent_template_repo_planned",
        text: initialized
          ? "Initialized hosted agent repo"
          : "Planned hosted agent repo from template",
      });
      return {
        ok: true,
        agent,
        hostedRepo: {
          namespace: hostedRepo.namespace,
          providerRepoId: hostedRepo.providerRepoId,
          remoteUrlRedacted: hostedRepo.remoteUrlRedacted,
        },
        initialized,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/agents", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const repoUrl = parseString(body.repoUrl, "repoUrl");
      const currentRef = assertValidGitRef(
        parseOptionalString(body.currentRef)
        ?? "main",
      );
      const agent = await db.createAgent({
        name: parseString(body.name, "name"),
        repoUrl,
        currentRef,
      });
      return { ok: true, agent };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    return { ok: true, agent };
  });

  app.get("/api/agents/:id/repository", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      return { ok: true, repository: getAgentRepositoryMetadata(agent) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/agents/:id/hosted-git", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    return { ok: true, hostedGitRepo: await db.getHostedGitRepoForAgent(id) };
  });

  app.get("/api/hosted-git/repos", async () => ({
    ok: true,
    hostedGitRepos: await db.listHostedGitRepos(),
  }));

  app.get("/api/worker-sessions/:name/apply-drains", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const prefixFilter = query.drainPrefix
        ? new Set(parseOptionalList(query.drainPrefix))
        : null;
      const records = await listWorkerSessionApplyRecords(settings.projectRoot, name);
      const summary = summarizeWorkerSessionApplyDrains(records);
      const drains = prefixFilter
        ? summary.drains.filter((drain) => prefixFilter.has(drain.prefix))
        : summary.drains;
      return {
        ok: true,
        session: name,
        applyRecords: records.length,
        counts: {
          total: drains.length,
          needsContinuation: drains.filter((drain) => drain.needsContinuation).length,
          done: drains.filter((drain) => drain.done).length,
          stoppedOnFailure: drains.filter((drain) => drain.stoppedOnFailure).length,
        },
        drains,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/apply-drain-continuations", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const limit = parseOptionalInteger(query.limit) ?? 20;
      const continuations = await listWorkerSessionDrainContinuationRecords(settings.projectRoot, name, limit);
      return {
        ok: true,
        session: name,
        count: continuations.length,
        continuations,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-drain-continuations", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const queued = await queueWorkerSessionDrainContinuations(settings.projectRoot, name, {
        drainPrefix: parseOptionalList(body.drainPrefix),
        dryRun: parseBoolean(body.dryRun, false),
        maxPolls: parseOptionalInteger(body.maxPolls),
        intervalMs: parseOptionalInteger(body.intervalMs),
      });
      return {
        ok: true,
        session: name,
        continuationPath: queued.path,
        continuation: queued.record,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-drain-continuations/:continuationId/execute", async (request, reply) => {
    try {
      const { name, continuationId } = request.params as { name: string; continuationId: string };
      const baseUrl = requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]);
      const executed = await executeWorkerSessionDrainContinuationRecord(
        settings.projectRoot,
        name,
        continuationId,
        async (drain) => {
          const result = await runCliContinuationCommand(settings.projectRoot, baseUrl, drain.command);
          return {
            ...drain,
            exitCode: result.exitCode,
            output: parseJsonMaybe(result.stdout),
            ...(result.stderr ? { stderr: result.stderr } : {}),
          };
        },
      );
      return {
        ok: true,
        session: name,
        continuationPath: executed.path,
        continuation: executed.record,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/agents/:id/runs", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as Record<string, string | string[] | undefined>;
      const agent = await db.getAgent(id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      return { ok: true, runs: await db.listAgentRuns(id, parseOptionalStatusList(query.status)) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/agents/:id/runs", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const body = requestBody(request.body);
      const objective = parseString(body.objective, "objective");
      const inputRef = parseOptionalString(body.inputRef) ?? agent.current_ref;
      const runId = nextId("run");
      const plan = planRunBranch({
        agent: { ...agent, current_ref: inputRef },
        objective,
        prefix: parseOptionalString(body.prefix),
        runId,
      });
      const run = await db.createAgentRun({
        id: runId,
        agentId: agent.id,
        objective,
        inputRef,
        runBranch: plan.branchName,
      });
      await db.appendMessage({
        agentId: agent.id,
        runId: run.id,
        type: "agent_run_planned",
        text: "Planned run",
      });
      return { ok: true, run, plan: runPlanFromRow(agent, run) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await db.getAgentRun(id);
    if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
    return { ok: true, run };
  });

  app.get("/api/runs/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const run = await db.getAgentRun(id);
    if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
    const [sandboxes, messages] = await Promise.all([
      db.listSandboxes({ runId: run.id }),
      db.listMessages({ runId: run.id, limit: parseOptionalInteger(query.limit) ?? 20 }),
    ]);
    return {
      ok: true,
      run,
      sandboxes,
      messages,
    };
  });

  app.post("/api/runs/:id/claim", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workerId = parseOptionalString(requestBody(request.body).workerId);
    const run = await db.claimAgentRun(id, workerId);
    if (!run) {
      const existing = await db.getAgentRun(id);
      if (!existing) return reply.code(404).send({ ok: false, error: "run not found" });
      return reply.code(409).send({ ok: false, error: `run is already ${existing.status}` });
    }
    await db.appendMessage({
      agentId: run.agent_id,
      runId: run.id,
      type: "agent_run_claimed",
      text: workerId ? `Claimed run by ${workerId}` : "Claimed run",
    });
    return { ok: true, run };
  });

  app.post("/api/runs/:id/requeue", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workerId = parseOptionalString(requestBody(request.body).workerId);
    const existing = await db.getAgentRun(id);
    if (!existing) return reply.code(404).send({ ok: false, error: "run not found" });
    if (existing.status === "completed") {
      return reply.code(409).send({ ok: false, error: "completed run cannot be requeued" });
    }
    const hasRunningSandbox = (await db.listSandboxes({ runId: existing.id }))
      .some((sandbox) => sandbox.state === "running");
    if (hasRunningSandbox) {
      return reply.code(409).send({ ok: false, error: "run has a running sandbox" });
    }
    const run = await db.requeueAgentRun(id);
    if (!run) return reply.code(409).send({ ok: false, error: "run could not be requeued" });
    await db.appendMessage({
      agentId: run.agent_id,
      runId: run.id,
      type: "agent_run_requeued",
      text: workerId ? `Requeued run by ${workerId}` : "Requeued run",
    });
    return { ok: true, run };
  });

  app.post("/api/runs/:id/sandbox", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const body = requestBody(request.body);
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      await db.markAgentRunRunning(run.id);
      const agent = await db.getAgent(run.agent_id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const bootstrapRequested = parseBoolean(body.bootstrap, false);
      const existingSandbox = await getRunSandbox(run.id);
      if (existingSandbox) {
        if (existingSandbox.state !== "running") {
          return reply.code(409).send({
            ok: false,
            error: `run sandbox is already ${existingSandbox.state}`,
          });
        }
        if (!bootstrapRequested) return { ok: true, sandbox: existingSandbox };
        const cloneUrl = await resolveCloneUrl(agent.id, run.input_ref);
        return { ok: true, sandbox: existingSandbox, bootstrap: await sandboxService.bootstrap(existingSandbox, cloneUrl) };
      }
      const cloneUrl = bootstrapRequested ? await resolveCloneUrl(agent.id, run.input_ref) : null;
      const sandbox = await sandboxService.startForAgent(agent, {
        runId: run.id,
      });
      if (!cloneUrl) return { ok: true, sandbox };
      return { ok: true, sandbox, bootstrap: await sandboxService.bootstrap(sandbox, cloneUrl) };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return reply.code(500).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/restart-sandbox", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const body = requestBody(request.body);
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      if (run.status === "completed" || run.status === "failed") {
        return reply.code(409).send({ ok: false, error: `run is already ${run.status}` });
      }
      const agent = await db.getAgent(run.agent_id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const existingSandbox = await getRunSandbox(run.id);
      if (!existingSandbox) {
        return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      }
      if (existingSandbox.state === "running") {
        return reply.code(409).send({ ok: false, error: "run sandbox is already running" });
      }
      if (existingSandbox.state !== "stopped" && existingSandbox.state !== "failed") {
        return reply.code(409).send({
          ok: false,
          error: `run sandbox cannot restart from ${existingSandbox.state}`,
        });
      }
      const bootstrapRequested = parseBoolean(body.bootstrap, false);
      const cloneUrl = bootstrapRequested ? await resolveCloneUrl(agent.id, run.input_ref) : null;
      await db.markAgentRunRunning(run.id);
      const sandbox = await sandboxService.startForAgent(agent, {
        runId: run.id,
      });
      if (!cloneUrl) return { ok: true, sandbox };
      return { ok: true, sandbox, bootstrap: await sandboxService.bootstrap(sandbox, cloneUrl) };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/exec", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      await db.markAgentRunRunning(run.id);
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const body = requestBody(request.body);
      const command = parseCommand(body.command);
      const cwd = parseOptionalString(body.cwd) ?? SANDBOX_WORKDIR;
      const timeoutMs = parseOptionalInteger(body.timeoutMs) ?? settings.sandboxExecTimeoutMs;
      const result = await sandboxService.exec(sandbox, command, { cwd, timeoutMs });
      return { ok: true, result };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/boot", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      await db.markAgentRunRunning(run.id);
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const body = requestBody(request.body);
      const plan = buildAgentBootPlan({
        agentPiCommand: settings.agentPiCommand ?? "pi",
        agentPiProvider: settings.agentPiProvider,
        agentPiModel: settings.agentPiModel,
        agentPiApiKeyEnv: settings.agentPiApiKeyEnv,
        objective: parseOptionalString(body.objective) ?? run.objective,
        promptPath: parseOptionalString(body.promptPath),
        runId: run.id,
        taskPath: parseOptionalString(body.taskPath),
      });
      const result = await sandboxService.exec(sandbox, plan.command, {
        cwd: SANDBOX_WORKDIR,
        timeoutMs: settings.agentBootTimeoutMs,
      });
      const failed = result.exitCode !== 0;
      if (failed) await db.updateAgentRunFailed(run.id);
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        type: failed ? "agent_boot_failed" : "agent_boot_completed",
        text: failed
          ? "Sandbox Pi boot failed"
          : "Sandbox Pi boot completed",
      });
      return { ok: true, result };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/check-runtime", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      await db.markAgentRunRunning(run.id);
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const plan = buildAgentRuntimeCheckPlan({
        agentPiCommand: settings.agentPiCommand,
        agentPiProvider: settings.agentPiProvider,
        agentPiModel: settings.agentPiModel,
      });
      const result = await sandboxService.exec(sandbox, plan.command, {
        cwd: SANDBOX_WORKDIR,
        timeoutMs: settings.sandboxExecTimeoutMs,
      });
      const failed = result.exitCode !== 0;
      if (failed) await db.updateAgentRunFailed(run.id);
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        type: failed ? "agent_runtime_check_failed" : "agent_runtime_check_completed",
        text: failed
          ? "Sandbox agent runtime check failed"
          : "Sandbox agent runtime check completed",
      });
      return { ok: true, result };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/finalize", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const body = requestBody(request.body);
      const commitMessage =
        parseOptionalString(body.commitMessage)
        ?? `Finalize run ${run.id}`;
      const finalized = await sandboxService.finalizeRunBranch(sandbox, {
        commitMessage,
        timeoutMs: settings.sandboxExecTimeoutMs,
      });
      await db.updateAgentRunCompleted({
        id: run.id,
        resultCommit: finalized.commitSha,
        status: "completed",
      });
      return { ok: true, result: finalized };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/stop", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      if (run.status === "completed" || run.status === "failed") {
        return reply.code(409).send({ ok: false, error: `run is already ${run.status}` });
      }
      const sandbox = await getRunSandbox(run.id);
      if (sandbox) await sandboxService.stop(sandbox);
      await db.updateAgentRunCompleted({
        id: run.id,
        status: "stopped",
      });
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox?.id,
        runId: run.id,
        type: "agent_run_stopped",
        text: "Stopped run",
      });
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  const resolveCloneUrl = async (
    agentId: string,
    baseRef: string,
  ): Promise<{ baseRef: string; pushRef?: boolean; repoUrl?: string; repoUrlRedacted?: string }> => {
    const repo = await db.getHostedGitRepoForAgent(agentId);
    if (!repo) return { baseRef };
    const cloneUrl = await hostedGit.getCloneUrl({
      namespace: repo.owner,
      repoId: repo.repo,
    });
    return {
      baseRef,
      pushRef: true,
      repoUrl: cloneUrl.remoteUrl,
      repoUrlRedacted: cloneUrl.remoteUrlRedacted,
    };
  };

  const getRunSandbox = async (runId: string) => {
    const sandboxes = await db.listSandboxes({ runId });
    return sandboxes.find((sandbox) => sandbox.state === "running") ?? sandboxes[0] ?? null;
  };

  app.get("/api/heartbeats", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return { ok: true, heartbeats: await db.listHeartbeats(query.agentId) };
  });

  app.get("/api/heartbeats/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const heartbeat = await db.getHeartbeat(id);
    if (!heartbeat) return reply.code(404).send({ ok: false, error: "heartbeat not found" });
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const agentId = parseString(body.agentId, "agentId");
      const agent = await db.getAgent(agentId);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const heartbeat = await db.createHeartbeat({
        agentId,
        title: parseOptionalString(body.title) ?? "heartbeat",
      });
      return { ok: true, heartbeat };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/sandboxes", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      ok: true,
      sandboxes: await db.listSandboxes({
        agentId: query.agentId,
        runId: query.runId,
      }),
    };
  });

  app.post("/api/sandboxes/stop-running", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const agentId = parseOptionalString(body.agentId);
      const runId = parseOptionalString(body.runId);
      if (!agentId && !runId) {
        return reply.code(400).send({ ok: false, error: "agentId or runId is required" });
      }
      if (agentId && !(await db.getAgent(agentId))) {
        return reply.code(404).send({ ok: false, error: "agent not found" });
      }
      if (runId && !(await db.getAgentRun(runId))) {
        return reply.code(404).send({ ok: false, error: "run not found" });
      }
      const sandboxes = await db.listSandboxes({ agentId, runId });
      const running = sandboxes.filter((sandbox) => sandbox.state === "running");
      let stoppedCount = 0;
      for (const sandbox of running) {
        await sandboxService.stop(sandbox);
        stoppedCount += 1;
      }
      return { ok: true, stoppedCount };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/sandboxes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sandbox = await db.getSandbox(id);
    if (!sandbox) return reply.code(404).send({ ok: false, error: "sandbox not found" });
    return { ok: true, sandbox };
  });

  app.post("/api/agents/:id/sandboxes", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const sandbox = await sandboxService.startForAgent(agent);
      return { ok: true, sandbox };
    } catch (error) {
      return reply.code(500).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/sandboxes/:id/exec", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "sandbox not found" });
      const body = requestBody(request.body);
      const command = parseCommand(body.command);
      const timeoutMs = parseOptionalInteger(body.timeoutMs) ?? settings.sandboxExecTimeoutMs;
      const result = await sandboxService.exec(sandbox, command, { timeoutMs });
      return { ok: true, result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/sandboxes/:id/bootstrap", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "sandbox not found" });
      return { ok: true, bootstrap: await sandboxService.bootstrap(sandbox) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/sandboxes/:id/stop", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "sandbox not found" });
      await sandboxService.stop(sandbox);
      return { ok: true };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/messages", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      ok: true,
      messages: await db.listMessages({
        agentId: query.agentId,
        runId: query.runId,
        sandboxId: query.sandboxId,
        limit: parseOptionalInteger(query.limit) ?? 100,
      }),
    };
  });

  app.get("/api/messages/listen", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const agentId = query.agentId;
    const runId = query.runId;
    const sandboxId = query.sandboxId;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });

    const unsubscribe = bus.subscribe((message) => {
      if (agentId && message.agent_id !== agentId) return;
      if (runId && message.run_id !== runId) return;
      if (sandboxId && message.sandbox_id !== sandboxId) return;
      reply.raw.write(`${JSON.stringify(message)}\n`);
    });
    request.raw.on("close", unsubscribe);
  });

  return { app, db };
};

const requestBody = (body: unknown): Record<string, unknown> => {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
};

const parseString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
};

const parseOptionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("expected string value");
  return value.trim();
};

const parseOptionalInteger = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("expected positive integer");
  return Math.floor(parsed);
};

const parseOptionalStatusList = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const values = (Array.isArray(value) ? value : String(value).split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (values.length === 0) return undefined;
  const allowed = new Set(["planned", "running", "completed", "failed", "stopped"]);
  for (const status of values) {
    if (!allowed.has(status)) throw new Error(`unknown run status: ${status}`);
  }
  return values;
};

const parseOptionalList = (value: unknown): string[] => {
  if (value === undefined || value === null || value === "") return [];
  const values = (Array.isArray(value) ? value : String(value).split(","))
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error("expected at least one value");
  return values;
};

const parseCommand = (value: unknown): string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    if (value.length === 0) throw new Error("command must not be empty");
    return value;
  }
  if (typeof value === "string" && value.trim()) return ["bash", "-lc", value.trim()];
  throw new Error("command must be a string or string[]");
};

const cliCommandArgs = (command: string[]): string[] => {
  const prefix = ["npm", "run", "cli", "--"];
  if (prefix.some((part, index) => command[index] !== part)) {
    throw new Error(`expected npm run cli command, got: ${command.join(" ")}`);
  }
  return command.slice(prefix.length);
};

const requestBaseUrl = (host: string | undefined, forwardedProto: string | string[] | undefined): string => {
  if (!host) throw new Error("request host is required to execute drain continuations");
  const protocolHeader = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = protocolHeader ? protocolHeader.split(",")[0].trim() : "http";
  return `${protocol}://${host}`;
};

const runCliContinuationCommand = async (
  cwd: string,
  baseUrl: string,
  command: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> => {
  const args = cliCommandArgs(command);
  return await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...args], {
      cwd,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
};

const parseJsonMaybe = (value: string): unknown => {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const nextId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
};

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const hostedAgentRepoUrl = (hostedRepo: {
  namespace: string;
  providerRepoId: string;
}): string => {
  return `https://github.com/${hostedRepo.namespace}/${hostedRepo.providerRepoId}.git`;
};
