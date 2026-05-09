import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

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
      return badRequest(reply, error);
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
      return badRequest(reply, error);
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
      return badRequest(reply, error);
    }
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return notFound(reply, "agent");
    return { ok: true, agent };
  });

  app.get("/api/agents/:id/repository", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return notFound(reply, "agent");
      return { ok: true, repository: getAgentRepositoryMetadata(agent) };
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get("/api/agents/:id/hosted-git", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return notFound(reply, "agent");
    return { ok: true, hostedGitRepo: await db.getHostedGitRepoForAgent(id) };
  });

  app.get("/api/hosted-git/repos", async () => ({
    ok: true,
    hostedGitRepos: await db.listHostedGitRepos(),
  }));

  app.get("/api/agents/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return notFound(reply, "agent");
    return { ok: true, runs: await db.listAgentRuns(id) };
  });

  app.post("/api/agents/:id/runs", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return notFound(reply, "agent");
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
      return badRequest(reply, error);
    }
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await db.getAgentRun(id);
    if (!run) return notFound(reply, "run");
    return { ok: true, run };
  });

  app.get("/api/runs/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const run = await db.getAgentRun(id);
    if (!run) return notFound(reply, "run");
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

  app.post("/api/runs/:id/sandbox", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const body = requestBody(request.body);
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      await db.markAgentRunRunning(run.id);
      const agent = await db.getAgent(run.agent_id);
      if (!agent) return notFound(reply, "agent");
      const bootstrapRequested = parseBoolean(body.bootstrap, false);
      const existingSandbox = await getRunSandbox(run.id);
      if (existingSandbox) {
        if (existingSandbox.state !== "running") {
          return conflict(reply, `run sandbox is already ${existingSandbox.state}`);
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
      return serverError(reply, error);
    }
  });

  app.post("/api/runs/:id/restart-sandbox", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const body = requestBody(request.body);
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      if (run.status === "completed" || run.status === "failed") {
        return conflict(reply, `run is already ${run.status}`);
      }
      const agent = await db.getAgent(run.agent_id);
      if (!agent) return notFound(reply, "agent");
      const existingSandbox = await getRunSandbox(run.id);
      if (!existingSandbox) {
        return notFound(reply, "run sandbox");
      }
      if (existingSandbox.state === "running") {
        return conflict(reply, "run sandbox is already running");
      }
      if (existingSandbox.state !== "stopped" && existingSandbox.state !== "failed") {
        return conflict(reply, `run sandbox cannot restart from ${existingSandbox.state}`);
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
      return badRequest(reply, error);
    }
  });

  app.post("/api/runs/:id/exec", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      await db.markAgentRunRunning(run.id);
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return notFound(reply, "run sandbox");
      const body = requestBody(request.body);
      const command = parseCommand(body.command);
      const cwd = parseOptionalString(body.cwd) ?? SANDBOX_WORKDIR;
      const timeoutMs = parseOptionalInteger(body.timeoutMs) ?? settings.sandboxExecTimeoutMs;
      const result = await sandboxService.exec(sandbox, command, { cwd, timeoutMs });
      return { ok: true, result };
    } catch (error) {
      if (runId) await db.updateAgentRunFailed(runId);
      return badRequest(reply, error);
    }
  });

  app.post("/api/runs/:id/boot", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      await db.markAgentRunRunning(run.id);
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return notFound(reply, "run sandbox");
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
      return badRequest(reply, error);
    }
  });

  app.post("/api/runs/:id/check-runtime", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      await db.markAgentRunRunning(run.id);
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return notFound(reply, "run sandbox");
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
      return badRequest(reply, error);
    }
  });

  app.post("/api/runs/:id/finalize", async (request, reply) => {
    let runId: string | undefined;
    try {
      const { id } = request.params as { id: string };
      runId = id;
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      const sandbox = await getRunSandbox(run.id);
      if (!sandbox) return notFound(reply, "run sandbox");
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
      return badRequest(reply, error);
    }
  });

  app.post("/api/runs/:id/stop", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const run = await db.getAgentRun(id);
      if (!run) return notFound(reply, "run");
      if (run.status === "completed" || run.status === "failed") {
        return conflict(reply, `run is already ${run.status}`);
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
      return badRequest(reply, error);
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
    if (!heartbeat) return notFound(reply, "heartbeat");
    return { ok: true, heartbeat };
  });

  app.post("/api/heartbeats", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const agentId = parseString(body.agentId, "agentId");
      const agent = await db.getAgent(agentId);
      if (!agent) return notFound(reply, "agent");
      const heartbeat = await db.createHeartbeat({
        agentId,
        title: parseOptionalString(body.title) ?? "heartbeat",
      });
      return { ok: true, heartbeat };
    } catch (error) {
      return badRequest(reply, error);
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
        return badRequest(reply, "agentId or runId is required");
      }
      if (agentId && !(await db.getAgent(agentId))) {
        return notFound(reply, "agent");
      }
      if (runId && !(await db.getAgentRun(runId))) {
        return notFound(reply, "run");
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
      return badRequest(reply, error);
    }
  });

  app.get("/api/sandboxes/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const sandbox = await db.getSandbox(id);
    if (!sandbox) return notFound(reply, "sandbox");
    return { ok: true, sandbox };
  });

  app.post("/api/agents/:id/sandboxes", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return notFound(reply, "agent");
      const sandbox = await sandboxService.startForAgent(agent);
      return { ok: true, sandbox };
    } catch (error) {
      return serverError(reply, error);
    }
  });

  app.post("/api/sandboxes/:id/exec", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return notFound(reply, "sandbox");
      const body = requestBody(request.body);
      const command = parseCommand(body.command);
      const timeoutMs = parseOptionalInteger(body.timeoutMs) ?? settings.sandboxExecTimeoutMs;
      const result = await sandboxService.exec(sandbox, command, { timeoutMs });
      return { ok: true, result };
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post("/api/sandboxes/:id/bootstrap", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return notFound(reply, "sandbox");
      return { ok: true, bootstrap: await sandboxService.bootstrap(sandbox) };
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post("/api/sandboxes/:id/stop", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return notFound(reply, "sandbox");
      await sandboxService.stop(sandbox);
      return { ok: true };
    } catch (error) {
      return badRequest(reply, error);
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

const notFound = (reply: FastifyReply, resource: string) =>
  errorResponse(reply, 404, `${resource} not found`);

const badRequest = (reply: FastifyReply, error: unknown) =>
  errorResponse(reply, 400, messageOf(error));

const conflict = (reply: FastifyReply, error: string) =>
  errorResponse(reply, 409, error);

const serverError = (reply: FastifyReply, error: unknown) =>
  errorResponse(reply, 500, messageOf(error));

const errorResponse = (reply: FastifyReply, statusCode: number, error: string) =>
  reply.code(statusCode).send({ ok: false, error });

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

const parseCommand = (value: unknown): string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    if (value.length === 0) throw new Error("command must not be empty");
    return value;
  }
  if (typeof value === "string" && value.trim()) return ["bash", "-lc", value.trim()];
  throw new Error("command must be a string or string[]");
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
