import { spawn } from "node:child_process";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import { buildAgentBootPlan, buildAgentRuntimeCheckPlan } from "./agentBoot.js";
import { getAgentRepositoryMetadata, planRunBranch } from "./agentRepository.js";
import { buildAgentTemplate } from "./agentTemplate.js";
import { GitHubHostedGitProvider } from "./hostedGit.js";
import { createInitialCommit } from "./gitRepositoryBootstrap.js";
import { assertValidGitRef } from "./git.js";
import { deriveGitHubLinks } from "./gitLinks.js";
import { Database } from "./db.js";
import { createSandboxProvider } from "./modalProvider.js";
import { MessageBus } from "./messageBus.js";
import { buildPreflightReport } from "./preflight.js";
import { runPlanFromRow } from "./runPlanning.js";
import { SANDBOX_WORKDIR, SandboxService } from "./sandboxService.js";
import {
  acknowledgeWorkerSessionApplyResetAudit,
  executeNextWorkerSessionDrainContinuationRecord,
  executeQueuedWorkerSessionDrainContinuationRecords,
  executeWorkerSessionDrainContinuationRecord,
  listWorkerSessionApplyActionExecutionRecords,
  listWorkerSessionApplyRecords,
  listWorkerSessionDrainContinuationRecords,
  queueWorkerSessionDrainContinuations,
  resetFailedWorkerSessionDrainContinuationRecords,
  resetRunningWorkerSessionDrainContinuationRecords,
  summarizeWorkerSessionApplyActionQueue,
  summarizeWorkerSessionApplyDrains,
  summarizeWorkerSessionApplyRecords,
  writeWorkerSessionApplyActionExecutionRecord,
} from "./workerSessionDrains.js";
import {
  listWorkerSessionBranchRecoveryExecutionRecords,
  writeWorkerSessionBranchRecoveryExecutionRecord,
} from "./workerSessionBranchRecovery.js";
import {
  listWorkerSessionControlPlaneTickRecords,
  writeWorkerSessionControlPlaneTickRecord,
} from "./workerSessionControlPlaneTicks.js";
import {
  listWorkerSessionControlPlaneTickWorkerNextSteps,
  listWorkerSessionControlPlaneTickWorkers,
  restartWorkerSessionControlPlaneTickWorker,
  startWorkerSessionControlPlaneTickWorker,
  stopWorkerSessionControlPlaneTickWorkers,
} from "./workerSessionControlPlaneTickWorkers.js";
import {
  listWorkerSessionApplyActionWorkerNextSteps,
  listWorkerSessionApplyActionWorkers,
  restartWorkerSessionApplyActionWorker,
  stopWorkerSessionApplyActionWorkers,
} from "./workerSessionApplyActionWorkers.js";
import {
  listWorkerSessionDrainWorkerNextSteps,
  listWorkerSessionDrainWorkers,
  restartWorkerSessionDrainWorker,
  stopWorkerSessionDrainWorkers,
} from "./workerSessionDrainWorkers.js";
import {
  listWorkerSessionWatchWorkerNextSteps,
  listWorkerSessionWatchWorkers,
  restartWorkerSessionWatchWorker,
  startWorkerSessionWatchWorker,
  stopWorkerSessionWatchWorkers,
} from "./workerSessionWatchWorkers.js";
import {
  readWorkerSession,
  readWorkerSessionLogs,
  readWorkerSessionNext,
  workerSessionAgentIds,
} from "./workerSessions.js";
import type { Settings } from "./config.js";

type AppParts = {
  app: FastifyInstance;
  db: Database;
};

type WorkerSessionApplyActionSummary = ReturnType<typeof summarizeWorkerSessionApplyActionQueue>["actions"][number];

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

  app.get("/api/worker-sessions/:name/applies", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const applyIds = parseOptionalList(query.applyId);
      const applyIdFilter = applyIds.length > 0 ? new Set(applyIds) : null;
      const sourceFilter = query.source ? new Set(parseOptionalList(query.source)) : null;
      const limit = parseOptionalInteger(query.limit) ?? null;
      const records = await listWorkerSessionApplyRecords(settings.projectRoot, name);
      const filtered = records
        .filter((record) => !applyIdFilter || applyIdFilter.has(record.applyId))
        .filter((record) => !sourceFilter || sourceFilter.has(record.source))
        .slice(0, limit ?? undefined);
      return {
        ok: true,
        session: name,
        count: records.length,
        returned: filtered.length,
        filter: { applyIds, source: sourceFilter ? [...sourceFilter] : [], limit },
        summary: summarizeWorkerSessionApplyRecords(filtered),
        applies: filtered,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/apply-actions", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const applyIds = parseOptionalList(query.applyId);
      const applyIdFilter = applyIds.length > 0 ? new Set(applyIds) : null;
      const sourceFilter = query.source ? new Set(parseOptionalList(query.source)) : null;
      const limit = parseOptionalInteger(query.limit) ?? null;
      const records = await listWorkerSessionApplyRecords(settings.projectRoot, name);
      const filtered = records
        .filter((record) => !applyIdFilter || applyIdFilter.has(record.applyId))
        .filter((record) => !sourceFilter || sourceFilter.has(record.source))
        .slice(0, limit ?? undefined);
      return {
        ok: true,
        session: name,
        count: records.length,
        returned: filtered.length,
        filter: { applyIds, source: sourceFilter ? [...sourceFilter] : [], limit },
        actionQueue: summarizeWorkerSessionApplyActionQueue(filtered),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/apply-action-executions", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const limit = parseOptionalInteger(query.limit) ?? 20;
      const applyIds = parseOptionalList(query.applyId);
      const applyIdFilter = applyIds.length > 0 ? new Set(applyIds) : null;
      const actionFilter = query.action ? new Set(parseOptionalApplyActions(query.action)) : null;
      const statusFilter = query.status ? new Set(parseOptionalApplyActionExecutionStatuses(query.status)) : null;
      const records = await listWorkerSessionApplyActionExecutionRecords(settings.projectRoot, name, Number.MAX_SAFE_INTEGER);
      const executions = records
        .filter((record) => !applyIdFilter || applyIdFilter.has(record.applyId))
        .filter((record) => !actionFilter || actionFilter.has(record.action))
        .filter((record) => !statusFilter || statusFilter.has(record.status))
        .slice(0, limit);
      return {
        ok: true,
        session: name,
        count: executions.length,
        filter: {
          applyIds,
          action: actionFilter ? [...actionFilter] : [],
          status: statusFilter ? [...statusFilter] : [],
          limit,
        },
        executions,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/branch-recovery-executions", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const limit = parseOptionalInteger(query.limit) ?? 20;
      const statusFilter = query.status ? new Set(parseOptionalBranchRecoveryExecutionStatuses(query.status)) : null;
      const runIds = [
        ...parseOptionalList(query.runId),
        ...parseOptionalList(query.runIds),
      ];
      const runIdFilter = runIds.length > 0 ? new Set(runIds) : null;
      const records = await listWorkerSessionBranchRecoveryExecutionRecords(settings.projectRoot, name, Number.MAX_SAFE_INTEGER);
      const executions = records
        .filter((record) => !statusFilter || statusFilter.has(record.status))
        .filter((record) => !runIdFilter || [
          ...record.resumed.map((run) => run.runId),
          ...record.skipped.map((run) => run.runId),
        ].some((runId) => runIdFilter.has(runId)))
        .slice(0, limit);
      return {
        ok: true,
        session: name,
        count: executions.length,
        filter: { status: statusFilter ? [...statusFilter] : [], runIds, limit },
        executions,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/apply-action-workers", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const workers = await listWorkerSessionApplyActionWorkers(
        settings.projectRoot,
        {
          sessionName: name,
          ...(query.workerId ? { workerId: query.workerId } : {}),
          includeRetired: parseBoolean(query.includeRetired, false),
        },
        parseOptionalInteger(query.lines) ?? 20,
      );
      return {
        ok: true,
        session: name,
        count: workers.length,
        workers,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/apply-action-workers/next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      return {
        ok: true,
        ...await listWorkerSessionApplyActionWorkerNextSteps(settings.projectRoot, name),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/control-plane-status", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      return await readWorkerSessionControlPlaneStatus(
        settings,
        db,
        name,
        parseOptionalInteger(query.lines) ?? 5,
      );
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/control-plane-tick", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return await runWorkerSessionControlPlaneTick(
        settings,
        db,
        requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
        name,
        {
          dryRun: parseBoolean(body.dryRun, false),
          lines: parseOptionalInteger(body.lines) ?? 5,
        },
      );
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/control-plane-tick-loop", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return await runWorkerSessionControlPlaneTickLoop(
        settings,
        db,
        requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
        name,
        {
          dryRun: parseBoolean(body.dryRun, false),
          lines: parseOptionalInteger(body.lines) ?? 5,
          maxTicks: parseOptionalInteger(body.maxTicks) ?? 10,
          intervalMs: parseOptionalNonNegativeInteger(body.intervalMs) ?? 2000,
        },
      );
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/control-plane-ticks", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const ticks = await listWorkerSessionControlPlaneTickRecords(
        settings.projectRoot,
        name,
        parseOptionalInteger(query.limit) ?? 20,
      );
      return {
        ok: true,
        session: name,
        count: ticks.length,
        ticks,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/control-plane-tick-workers", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const workers = await listWorkerSessionControlPlaneTickWorkers(settings.projectRoot, {
        sessionName: name,
        ...(query.workerId ? { workerId: query.workerId } : {}),
        includeRetired: parseBoolean(query.includeRetired, false),
      }, parseOptionalInteger(query.lines) ?? 20);
      return {
        ok: true,
        session: name,
        count: workers.length,
        workers,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/control-plane-tick-workers/next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      return {
        ok: true,
        ...await listWorkerSessionControlPlaneTickWorkerNextSteps(settings.projectRoot, name),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/control-plane-tick-workers", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const worker = await startWorkerSessionControlPlaneTickWorker(
        settings.projectRoot,
        requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
        name,
        {
          ...(parseOptionalString(body.workerId) ? { workerId: parseOptionalString(body.workerId) } : {}),
          dryRun: parseBoolean(body.dryRun, false),
          maxTicks: parseOptionalInteger(body.maxTicks) ?? 10,
          intervalMs: parseOptionalNonNegativeInteger(body.intervalMs) ?? 2000,
          lines: parseOptionalInteger(body.lines) ?? 5,
        },
      );
      return { ok: true, session: name, worker };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/control-plane-tick-workers/restart", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await restartWorkerSessionControlPlaneTickWorker(
          settings.projectRoot,
          requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
          name,
          {
            workerId: parseString(body.workerId, "workerId"),
            includeRetired: parseBoolean(body.includeRetired, false),
            lines: parseOptionalInteger(body.lines) ?? 20,
          },
        ),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/control-plane-tick-workers/stop", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await stopWorkerSessionControlPlaneTickWorkers(settings.projectRoot, name, {
          ...(parseOptionalString(body.workerId) ? { workerId: parseOptionalString(body.workerId) } : {}),
          retire: parseBoolean(body.retire, false),
          lines: parseOptionalInteger(body.lines) ?? 20,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/drain-workers", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const lines = parseOptionalInteger(query.lines) ?? 20;
      const workers = await listWorkerSessionDrainWorkers(settings.projectRoot, {
        sessionName: name,
        ...(query.workerId ? { workerId: query.workerId } : {}),
        includeRetired: parseBoolean(query.includeRetired, false),
      }, lines);
      return {
        ok: true,
        session: name,
        count: workers.length,
        workers,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/drain-workers/next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      return {
        ok: true,
        ...await listWorkerSessionDrainWorkerNextSteps(settings.projectRoot, name),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/drain-workers/stop", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await stopWorkerSessionDrainWorkers(settings.projectRoot, name, {
          ...(body.workerId ? { workerId: parseString(body.workerId, "workerId") } : {}),
          retire: parseBoolean(body.retire, false),
          lines: parseOptionalInteger(body.lines) ?? 20,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/drain-workers/restart", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await restartWorkerSessionDrainWorker(
          settings.projectRoot,
          requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
          name,
          {
            workerId: parseString(body.workerId, "workerId"),
            includeRetired: parseBoolean(body.includeRetired, false),
            lines: parseOptionalInteger(body.lines) ?? 20,
          },
        ),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-action-workers/stop", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await stopWorkerSessionApplyActionWorkers(settings.projectRoot, name, {
          ...(parseOptionalString(body.workerId) ? { workerId: parseOptionalString(body.workerId) } : {}),
          retire: parseBoolean(body.retire, false),
          lines: parseOptionalInteger(body.lines) ?? 20,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-action-workers/restart", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await restartWorkerSessionApplyActionWorker(
          settings.projectRoot,
          requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
          name,
          {
            workerId: parseString(body.workerId, "workerId"),
            includeRetired: parseBoolean(body.includeRetired, false),
            lines: parseOptionalInteger(body.lines) ?? 20,
          },
        ),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-actions/execute-next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const applyIds = [
        ...parseOptionalList(body.applyIds),
        ...parseOptionalList(body.applyId),
      ];
      const applyIdFilter = applyIds.length > 0 ? new Set(applyIds) : null;
      const sourceFilter = body.source ? new Set(parseOptionalList(body.source)) : null;
      const actionFilter = body.action ? new Set(parseOptionalApplyActions(body.action)) : null;
      const limit = parseOptionalInteger(body.limit) ?? null;
      const records = await listWorkerSessionApplyRecords(settings.projectRoot, name);
      const filtered = records
        .filter((record) => !applyIdFilter || applyIdFilter.has(record.applyId))
        .filter((record) => !sourceFilter || sourceFilter.has(record.source))
        .slice(0, limit ?? undefined);
      const actionQueue = summarizeWorkerSessionApplyActionQueue(filtered);
      const nextAction = actionQueue.actions
        .filter((action) => !actionFilter || actionFilter.has(action.action))
        .at(0);
      if (!nextAction) {
        return {
          ok: true,
          session: name,
          executed: false,
          filter: { applyIds, source: sourceFilter ? [...sourceFilter] : [], action: actionFilter ? [...actionFilter] : [], limit },
          actionQueue,
        };
      }
      const baseUrl = requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]);
      const filter = { applyIds, source: sourceFilter ? [...sourceFilter] : [], action: actionFilter ? [...actionFilter] : [], limit };
      const executedAction = await executeWorkerSessionApplyActionCommand(
        settings.projectRoot,
        baseUrl,
        name,
        nextAction,
        filter,
      );
      return {
        ok: true,
        session: name,
        executed: true,
        filter,
        action: nextAction,
        exitCode: executedAction.result.exitCode,
        stdout: executedAction.result.stdout,
        stderr: executedAction.result.stderr,
        output: executedAction.output,
        executionPath: executedAction.execution.path,
        execution: executedAction.execution.record,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-actions/execute-queued", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const applyIds = [
        ...parseOptionalList(body.applyIds),
        ...parseOptionalList(body.applyId),
      ];
      const applyIdFilter = applyIds.length > 0 ? new Set(applyIds) : null;
      const sourceFilter = body.source ? new Set(parseOptionalList(body.source)) : null;
      const actionFilter = body.action ? new Set(parseOptionalApplyActions(body.action)) : null;
      const limit = parseOptionalInteger(body.limit) ?? null;
      const maxActions = parseOptionalInteger(body.maxActions) ?? 10;
      if (maxActions < 1) throw new Error("maxActions must be at least 1");
      const stopOnFailure = parseBoolean(body.stopOnFailure, true);
      const records = await listWorkerSessionApplyRecords(settings.projectRoot, name);
      const filtered = records
        .filter((record) => !applyIdFilter || applyIdFilter.has(record.applyId))
        .filter((record) => !sourceFilter || sourceFilter.has(record.source))
        .slice(0, limit ?? undefined);
      const actionQueue = summarizeWorkerSessionApplyActionQueue(filtered);
      const matchingActions = actionQueue.actions
        .filter((action) => !actionFilter || actionFilter.has(action.action));
      const actions = matchingActions.slice(0, maxActions);
      const baseUrl = requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]);
      const filter = {
        applyIds,
        source: sourceFilter ? [...sourceFilter] : [],
        action: actionFilter ? [...actionFilter] : [],
        limit,
        maxActions,
        stopOnFailure,
      };
      const executions = [];
      for (const action of actions) {
        const executedAction = await executeWorkerSessionApplyActionCommand(
          settings.projectRoot,
          baseUrl,
          name,
          action,
          filter,
        );
        executions.push({
          action,
          exitCode: executedAction.result.exitCode,
          stdout: executedAction.result.stdout,
          stderr: executedAction.result.stderr,
          output: executedAction.output,
          executionPath: executedAction.execution.path,
          execution: executedAction.execution.record,
        });
        if (stopOnFailure && executedAction.result.exitCode !== 0) break;
      }
      return {
        ok: true,
        session: name,
        executed: executions.length,
        stoppedOnFailure: stopOnFailure && executions.some((item) => item.exitCode !== 0),
        remainingQueued: Math.max(0, matchingActions.length - executions.length),
        filter,
        actionQueue,
        executions,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/applies/:applyId/reset-audit/ack", async (request, reply) => {
    try {
      const { name, applyId } = request.params as { name: string; applyId: string };
      const body = requestBody(request.body);
      const dryRun = parseBoolean(body.dryRun, false);
      const acknowledged = await acknowledgeWorkerSessionApplyResetAudit(
        settings.projectRoot,
        name,
        applyId,
        { dryRun, acknowledgedBy: "server" },
      );
      return {
        ok: true,
        session: name,
        applyId,
        applyPath: acknowledged.path,
        dryRun,
        resetAudit: {
          acknowledged: true,
          acknowledgedAt: acknowledged.acknowledgedAt,
          acknowledgedBy: acknowledged.record.resetAuditAcknowledgedBy,
        },
        summary: summarizeWorkerSessionApplyRecords([acknowledged.record]).applies[0],
        record: acknowledged.record,
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
      const statuses = parseOptionalDrainContinuationStatuses(query.status);
      const records = await listWorkerSessionDrainContinuationRecords(
        settings.projectRoot,
        name,
        statuses.length > 0 ? Number.MAX_SAFE_INTEGER : limit,
      );
      const continuations = (statuses.length > 0
        ? records.filter((record) => record.status && statuses.includes(record.status))
        : records).slice(0, limit);
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
        async (drain) => executeDrainContinuationCommand(settings.projectRoot, baseUrl, drain),
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

  app.post("/api/worker-sessions/:name/apply-drain-continuations/execute-queued", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const baseUrl = requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]);
      const drained = await executeQueuedWorkerSessionDrainContinuationRecords(
        settings.projectRoot,
        name,
        async (drain) => executeDrainContinuationCommand(settings.projectRoot, baseUrl, drain),
        { maxContinuations: parseOptionalInteger(body.maxContinuations) },
      );
      return {
        ok: true,
        session: name,
        executed: drained.executed.length,
        remainingQueued: drained.remainingQueued,
        continuations: drained.executed.map((item) => item.record),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-drain-continuations/execute-next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const baseUrl = requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]);
      const executed = await executeNextWorkerSessionDrainContinuationRecord(
        settings.projectRoot,
        name,
        async (drain) => executeDrainContinuationCommand(settings.projectRoot, baseUrl, drain),
      );
      return {
        ok: true,
        session: name,
        executed: executed !== null,
        continuationPath: executed?.path ?? null,
        continuation: executed?.record ?? null,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-drain-continuations/reset-running", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const reset = await resetRunningWorkerSessionDrainContinuationRecords(
        settings.projectRoot,
        name,
        { olderThanMs: parseOptionalInteger(body.olderThanMs) },
      );
      return {
        ok: true,
        session: name,
        ...reset,
        continuations: reset.reset.map((item) => item.record),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/apply-drain-continuations/reset-failed", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const reset = await resetFailedWorkerSessionDrainContinuationRecords(
        settings.projectRoot,
        name,
        { continuationIds: parseOptionalList(body.continuationIds) },
      );
      return {
        ok: true,
        session: name,
        ...reset,
        continuations: reset.reset.map((item) => item.record),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/logs", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      return {
        ok: true,
        ...await readWorkerSessionLogs(
          settings.projectRoot,
          name,
          parseOptionalInteger(query.lines) ?? 80,
        ),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      return {
        ok: true,
        ...await readWorkerSessionNext(
          settings.projectRoot,
          name,
          parseOptionalInteger(query.lines) ?? 20,
        ),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/branches", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const session = await readWorkerSession(settings.projectRoot, name);
      const statusList = parseOptionalStatusList(query.status) ?? ["completed", "stopped"];
      const statusFilter = new Set(statusList);
      const workerIdFilter = parseOptionalString(query.workerId) ?? null;
      const resumableOnly = parseBoolean(query.resumable, false);
      const checkoutDir = parseOptionalString(query.checkoutDir) ?? `./checkouts/${name}-branches`;
      const branchActions = parseOptionalBranchActions(query.branchAction);
      const branchActionFilter = branchActions.length > 0 ? new Set(branchActions) : null;
      const runIds = [
        ...parseOptionalList(query.runId),
        ...parseOptionalList(query.runIds),
      ];
      const runIdFilter = runIds.length > 0 ? new Set(runIds) : null;
      const limit = parseOptionalInteger(query.limit) ?? null;
      const offset = parseOptionalNonNegativeInteger(query.offset) ?? 0;
      const sessionWorkerIds = new Set(session.workers.map((worker) => worker.workerId));
      const agents = await Promise.all(workerSessionAgentIds(session).map(async (agentId) => {
        const agent = await db.getAgent(agentId);
        if (!agent) {
          return {
            agentId,
            available: false,
            repository: { repoWebUrl: null },
            summary: { total: 0, resultCommits: 0, resumable: 0, warnings: 0 },
            runs: [],
          };
        }
        const runs = (await db.listAgentRuns(agentId, statusList))
          .filter((run) => statusFilter.has(run.status))
          .filter((run) => workerIdFilter === null || run.worker_id === workerIdFilter)
          .filter((run) => !resumableOnly || (run.status === "stopped" && !run.result_commit))
          .filter((run) => !runIdFilter || runIdFilter.has(run.id))
          .map((run) => {
            const branchLinks = deriveGitHubLinks(agent.repo_url, {
              compareBaseRef: run.input_ref,
              compareHeadRef: run.run_branch,
              treeRef: run.run_branch,
            });
            const resultLinks = deriveGitHubLinks(agent.repo_url, {
              commitRef: run.result_commit,
              compareBaseRef: run.input_ref,
              compareHeadRef: run.result_commit,
              treeRef: run.result_commit,
            });
            const state = run.result_commit ? "result" : run.status === "stopped" ? "resumable" : run.status;
            const warning = run.status === "completed" && !run.result_commit
              ? "completed_without_result_commit"
              : null;
            return {
              id: run.id,
              status: run.status,
              state,
              warning,
              objective: run.objective,
              baseRef: run.input_ref,
              branchName: run.run_branch,
              resultCommit: run.result_commit,
              workerId: run.worker_id,
              location: run.worker_id === null
                ? "unassigned"
                : sessionWorkerIds.has(run.worker_id)
                  ? "session_worker"
                  : "other_worker",
              commands: {
                checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${checkoutDir}/${run.id}`],
                reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${checkoutDir}/${run.id}`],
                inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
                inspectResult: ["npm", "run", "cli", "--", "runs", "inspect-result", run.id, "--checkout-dir", `${checkoutDir}/${run.id}`],
                resumeBranch: state === "resumable"
                  ? ["npm", "run", "cli", "--", "runs", "resume-branch", run.id]
                  : null,
              },
              links: {
                repoUrl: branchLinks.repoUrl,
                branchTreeUrl: branchLinks.treeUrl,
                branchCompareUrl: branchLinks.compareUrl,
                resultTreeUrl: resultLinks.treeUrl,
                resultCommitUrl: resultLinks.commitUrl,
                resultCompareUrl: resultLinks.compareUrl,
              },
            };
          });
        return {
          agentId,
          available: true,
          repository: { repoWebUrl: deriveGitHubLinks(agent.repo_url, {}).repoUrl },
          summary: {
            total: runs.length,
            resultCommits: runs.filter((run) => run.resultCommit).length,
            resumable: runs.filter((run) => run.state === "resumable").length,
            warnings: runs.filter((run) => run.warning).length,
          },
          runs,
        };
      }));
      const visibleRuns = agents.flatMap((agent) => agent.runs.map((run) => ({ agentId: agent.agentId, run })));
      const resultCommits = visibleRuns
        .filter(({ run }) => run.resultCommit)
        .map(({ agentId, run }) => ({
          agentId,
          runId: run.id,
          status: run.status,
          state: run.state,
          objective: run.objective,
          workerId: run.workerId,
          location: run.location,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          links: {
            resultCommitUrl: run.links.resultCommitUrl,
            resultTreeUrl: run.links.resultTreeUrl,
            resultCompareUrl: run.links.resultCompareUrl,
          },
          commands: {
            inspectRun: run.commands.inspectRun,
            checkoutBranch: run.commands.checkoutBranch,
            reviewRun: run.commands.reviewRun,
          },
        }));
      const resumableBranches = visibleRuns
        .filter(({ run }) => run.state === "resumable")
        .map(({ agentId, run }) => ({
          agentId,
          runId: run.id,
          status: run.status,
          state: run.state,
          objective: run.objective,
          workerId: run.workerId,
          location: run.location,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          commands: run.commands,
          links: run.links,
        }));
      const nextSteps = visibleRuns.map(({ agentId, run }) => {
        const action: "resume_branch" | "review_branch" = run.state === "resumable" ? "resume_branch" : "review_branch";
        return {
          action,
          reason: run.state === "resumable"
            ? "stopped_branch_without_result_commit"
            : run.warning ?? (run.resultCommit ? "result_commit_available" : "branch_available"),
          agentId,
          runId: run.id,
          status: run.status,
          state: run.state,
          warning: run.warning,
          objective: run.objective,
          workerId: run.workerId,
          location: run.location,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          command: run.state === "resumable" && run.commands.resumeBranch
            ? run.commands.resumeBranch
            : run.commands.reviewRun,
          commands: run.commands,
        };
      });
      const filteredResultCommits = branchActionFilter && !branchActionFilter.has("review_branch")
        ? []
        : resultCommits;
      const filteredResumableBranches = branchActionFilter && !branchActionFilter.has("resume_branch")
        ? []
        : resumableBranches;
      const filteredNextSteps = branchActionFilter
        ? nextSteps.filter((step) => branchActionFilter.has(step.action))
        : nextSteps;
      const pageEnd = limit ? offset + limit : undefined;
      const limitedResultCommits = offset > 0 || limit
        ? filteredResultCommits.slice(offset, pageEnd)
        : filteredResultCommits;
      const limitedResumableBranches = offset > 0 || limit
        ? filteredResumableBranches.slice(offset, pageEnd)
        : filteredResumableBranches;
      const limitedNextSteps = offset > 0 || limit
        ? filteredNextSteps.slice(offset, pageEnd)
        : filteredNextSteps;
      const pageTotal = Math.max(filteredResultCommits.length, filteredResumableBranches.length, filteredNextSteps.length);
      const nextOffset = limit ? offset + limit : null;
      const hasMore = nextOffset !== null && nextOffset < pageTotal;
      return {
        ok: true,
        observedAt: new Date().toISOString(),
        session: name,
        checkoutDir,
        filter: {
          statuses: statusList,
          resumable: resumableOnly,
          workerId: workerIdFilter,
          branchAction: branchActions,
          runIds,
          limit,
          offset,
          totalResultCommits: filteredResultCommits.length,
          visibleResultCommits: limitedResultCommits.length,
          totalResumableBranches: filteredResumableBranches.length,
          visibleResumableBranches: limitedResumableBranches.length,
          totalNextSteps: filteredNextSteps.length,
          visibleNextSteps: limitedNextSteps.length,
          hasMore,
          nextOffset: hasMore ? nextOffset : null,
        },
        summary: {
          agents: agents.length,
          total: filteredNextSteps.length,
          resultCommits: filteredResultCommits.length,
          resumable: filteredResumableBranches.length,
          warnings: filteredNextSteps.filter((step) => step.warning).length,
        },
        resultCommits: limitedResultCommits,
        resumableBranches: limitedResumableBranches,
        nextSteps: limitedNextSteps,
        agents,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/resume-branches", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const session = await readWorkerSession(settings.projectRoot, name);
      const dryRun = parseBoolean(body.dryRun, false);
      const workerIdFilter = parseOptionalString(body.workerId) ?? null;
      const runIds = [
        ...parseOptionalList(body.runIds),
        ...parseOptionalList(body.runId),
      ];
      const runIdFilter = runIds.length > 0 ? new Set(runIds) : null;
      const limit = parseOptionalInteger(body.limit) ?? null;
      const sessionWorkerIds = new Set(session.workers.map((worker) => worker.workerId));
      if (workerIdFilter && !sessionWorkerIds.has(workerIdFilter)) {
        return reply.code(400).send({
          ok: false,
          error: `worker ${workerIdFilter} is not recorded in session ${session.session}`,
        });
      }
      const includeUnassigned = workerIdFilter === null;
      const selectedWorkerIds = workerIdFilter ? new Set([workerIdFilter]) : sessionWorkerIds;
      const candidates = (await Promise.all(workerSessionAgentIds(session).map(async (agentId) => {
        const runs = await db.listAgentRuns(agentId, ["stopped"]);
        return runs
          .filter((run) => run.result_commit === null)
          .filter((run) => !runIdFilter || runIdFilter.has(run.id))
          .filter((run) => run.worker_id === null ? includeUnassigned : selectedWorkerIds.has(run.worker_id))
          .map((run) => ({ agentId, run }));
      }))).flat();
      const inspectedCandidates = await Promise.all(candidates.map(async ({ agentId, run }) => {
        const runningSandboxes = (await db.listSandboxes({ runId: run.id }))
          .filter((sandbox) => sandbox.state === "running");
        const resumeReady = runningSandboxes.length === 0;
        const resumeReason = resumeReady
          ? "stopped_branch_without_result_commit"
          : "running_sandbox_present";
        return { agentId, run, runningSandboxes, resumeReady, resumeReason };
      }));
      const readyCandidates = inspectedCandidates.filter((candidate) => candidate.resumeReady);
      const blockedCandidates = inspectedCandidates.filter((candidate) => !candidate.resumeReady);
      const selectedReadyCandidates = limit === null ? readyCandidates : readyCandidates.slice(0, limit);
      const selectedBlockedCandidates = limit === null
        ? blockedCandidates
        : blockedCandidates.slice(0, Math.max(limit - selectedReadyCandidates.length, 0));
      const selectedCandidates = limit === null
        ? inspectedCandidates
        : [...selectedReadyCandidates, ...selectedBlockedCandidates];
      const candidateSelection = {
        candidates: inspectedCandidates.length,
        ready: readyCandidates.length,
        blocked: blockedCandidates.length,
        selected: selectedCandidates.length,
        selectedReady: selectedReadyCandidates.length,
        selectedBlocked: selectedBlockedCandidates.length,
        deprioritizedBlocked: Math.max(blockedCandidates.length - selectedBlockedCandidates.length, 0),
        limit,
      };
      const resumed = [];
      for (const { agentId, run, runningSandboxes, resumeReady, resumeReason } of selectedCandidates) {
        const resumeBranch = ["npm", "run", "cli", "--", "runs", "resume-branch", run.id];
        const inspectRun = ["npm", "run", "cli", "--", "runs", "inspect", run.id];
        const resumeInspection = {
          recovery: {
            ready: resumeReady,
            reason: resumeReason,
            inspectionMode: "server_metadata",
            runningSandboxes: runningSandboxes.map((sandbox) => ({
              id: sandbox.id,
              providerSandboxId: sandbox.provider_sandbox_id,
            })),
          },
          commands: {
            resumeBranch: resumeReady ? resumeBranch : null,
            resumeBranchDryRun: [...resumeBranch, "--dry-run"],
            inspectRun,
          },
          nextStep: resumeReady
            ? { action: "resume_branch", reason: resumeReason, command: resumeBranch }
            : { action: "inspect_run", reason: resumeReason, command: inspectRun },
        };
        const item = {
          agentId,
          runId: run.id,
          objective: run.objective,
          branchName: run.run_branch,
          resultCommit: run.result_commit,
          workerId: run.worker_id,
          resumeInspection,
        };
        if (dryRun) {
          resumed.push({
            ...item,
            currentStatus: run.status,
            dryRun: true,
            ...(resumeReady ? {} : { skipped: resumeReason }),
          });
          continue;
        }
        if (!resumeReady) {
          resumed.push({ ...item, skipped: resumeReason });
          continue;
        }
        const requeued = await db.requeueAgentRun(run.id);
        if (!requeued) {
          resumed.push({ ...item, skipped: "run could not be resumed" });
          continue;
        }
        await db.appendMessage({
          agentId: requeued.agent_id,
          runId: requeued.id,
          type: "agent_run_requeued",
          text: `Requeued run by ${workerIdFilter ?? session.session}`,
        });
        resumed.push({ ...item, status: requeued.status, workerId: requeued.worker_id, run: requeued });
      }
      const resumeSession = ["npm", "run", "cli", "--", "runs", "resume-session", session.session];
      if (workerIdFilter) resumeSession.push("--worker-id", workerIdFilter);
      const actions = {
        sessionWait: ["npm", "run", "cli", "--", "runs", "session-wait", session.session],
        sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", session.session, "--recoverable", "--include-stopped", "--next"],
        sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", session.session, "--include-stopped"],
        restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", session.session, "--recover"],
        resumeSession,
      };
      const changedRuns = resumed.filter((item) => !("skipped" in item)).length;
      if (dryRun) {
        return {
          ok: true,
          session: session.session,
          resumed,
          filter: { dryRun, workerId: workerIdFilter, runIds, limit },
          candidateSelection,
          actions,
          nextStep: {
            action: "resume_session",
            reason: "dry_run_preview",
            count: changedRuns,
            command: actions.resumeSession,
          },
        };
      }
      const logs = await readWorkerSessionLogs(settings.projectRoot, session.session, 0);
      const aliveWorkers = logs.workers.filter((worker) => worker.alive).length;
      const workerRuns = new Map(session.workers.map((worker) => [
        worker.workerId,
        [] as Array<{
          agentId: string;
          id: string;
          status: string;
          objective: string;
          branchName: string;
          resultCommit: string | null;
        }>,
      ]));
      const statusAgents = await Promise.all(workerSessionAgentIds(session).map(async (agentId) => {
        const runs = await db.listAgentRuns(agentId);
        const statuses: Record<string, number> = {};
        let resumableStopped = 0;
        const unassigned = [];
        const otherWorkers = [];
        for (const run of runs) {
          statuses[run.status] = (statuses[run.status] ?? 0) + 1;
          if (run.status === "stopped" && !run.result_commit) resumableStopped += 1;
          if (!["planned", "running", "stopped"].includes(run.status)) continue;
          const visibleRun = {
            id: run.id,
            status: run.status,
            objective: run.objective,
            branchName: run.run_branch,
            resultCommit: run.result_commit,
          };
          if (!run.worker_id) {
            unassigned.push(visibleRun);
            continue;
          }
          const sessionRuns = workerRuns.get(run.worker_id);
          if (sessionRuns) {
            sessionRuns.push({ agentId, ...visibleRun });
            continue;
          }
          otherWorkers.push({ ...visibleRun, workerId: run.worker_id });
        }
        return { agentId, total: runs.length, statuses, resumableStopped, unassigned, otherWorkers };
      }));
      const aliveByWorkerId = new Map(logs.workers.map((worker) => [worker.workerId, worker.alive]));
      const nextStep = changedRuns > 0 && aliveWorkers > 0
        ? {
          action: "wait_session",
          reason: "resumed_runs_for_live_workers",
          count: changedRuns,
          command: actions.sessionWait,
        }
        : changedRuns > 0
          ? {
            action: "restart_session",
            reason: "resumed_runs_without_live_workers",
            count: changedRuns,
            command: actions.restartSession,
          }
          : {
            action: "review_session",
            reason: "no_runs_resumed",
            count: 0,
            command: actions.sessionReview,
          };
      const observedAt = new Date().toISOString();
      const execution = await writeWorkerSessionBranchRecoveryExecutionRecord(settings.projectRoot, {
        session: session.session,
        observedAt,
        completedAt: new Date().toISOString(),
        status: changedRuns === 0 ? "noop" : changedRuns === resumed.length ? "executed" : "partial",
        filter: { dryRun, workerId: workerIdFilter, runIds, limit, candidateSelection },
        selected: resumed.length,
        resumed: resumed
          .filter((item) => !("skipped" in item))
          .map((item) => ({
            agentId: item.agentId,
            runId: item.runId,
            objective: item.objective,
            branchName: item.branchName,
            resultCommit: item.resultCommit,
            workerId: item.workerId,
            ...("status" in item ? { status: item.status } : {}),
          })),
        skipped: resumed
          .filter((item): item is typeof item & { skipped: string } => "skipped" in item)
          .map((item) => ({
            agentId: item.agentId,
            runId: item.runId,
            objective: item.objective,
            branchName: item.branchName,
            resultCommit: item.resultCommit,
            workerId: item.workerId,
            reason: item.skipped,
          })),
        nextStep,
      });
      return {
        ok: true,
        session: session.session,
        resumed,
        filter: { dryRun, workerId: workerIdFilter, runIds, limit },
        candidateSelection,
        actions,
        nextStep,
        executionPath: execution.path,
        execution: execution.record,
        status: {
          session: {
            ...session,
            workers: session.workers.map((worker) => ({
              ...worker,
              alive: aliveByWorkerId.get(worker.workerId) ?? false,
              runs: workerRuns.get(worker.workerId) ?? [],
            })),
          },
          agents: statusAgents,
        },
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/watch-workers", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const query = request.query as Record<string, string | undefined>;
      const workers = await listWorkerSessionWatchWorkers(
        settings.projectRoot,
        {
          sessionName: name,
          ...(query.workerId ? { workerId: query.workerId } : {}),
          includeRetired: parseBoolean(query.includeRetired, false),
        },
        parseOptionalInteger(query.lines) ?? 20,
      );
      return {
        ok: true,
        session: name,
        count: workers.length,
        workers,
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/worker-sessions/:name/watch-workers/next", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      return {
        ok: true,
        ...await listWorkerSessionWatchWorkerNextSteps(settings.projectRoot, name),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/watch-workers", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      const worker = await startWorkerSessionWatchWorker(
        settings.projectRoot,
        requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
        name,
        {
          ...(parseOptionalString(body.workerId) ? { workerId: parseOptionalString(body.workerId) } : {}),
          ...(parseOptionalString(body.watchId) ? { watchId: parseOptionalString(body.watchId) } : {}),
          maxPolls: parseOptionalInteger(body.maxPolls) ?? 60,
          intervalMs: parseOptionalInteger(body.intervalMs) ?? 2000,
          recoverable: parseBoolean(body.recoverable, false),
          includeStopped: parseBoolean(body.includeStopped, false),
          actionQueue: parseBoolean(body.actionQueue, false),
          ...(parseOptionalString(body.applyAction) ? { applyAction: parseOptionalString(body.applyAction) } : {}),
        },
      );
      return { ok: true, session: name, worker };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/watch-workers/stop", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await stopWorkerSessionWatchWorkers(settings.projectRoot, name, {
          ...(parseOptionalString(body.workerId) ? { workerId: parseOptionalString(body.workerId) } : {}),
          retire: parseBoolean(body.retire, false),
          lines: parseOptionalInteger(body.lines) ?? 20,
        }),
      };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/worker-sessions/:name/watch-workers/restart", async (request, reply) => {
    try {
      const { name } = request.params as { name: string };
      const body = requestBody(request.body);
      return {
        ok: true,
        ...await restartWorkerSessionWatchWorker(
          settings.projectRoot,
          requestBaseUrl(request.headers.host, request.headers["x-forwarded-proto"]),
          name,
          {
            workerId: parseString(body.workerId, "workerId"),
            includeRetired: parseBoolean(body.includeRetired, false),
            lines: parseOptionalInteger(body.lines) ?? 20,
          },
        ),
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

  app.get("/api/runs/:id/result-inspection", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await db.getAgentRun(id);
    if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
    const agent = await db.getAgent(run.agent_id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    const branchLinks = deriveGitHubLinks(agent.repo_url, {
      compareBaseRef: run.input_ref,
      compareHeadRef: run.run_branch,
      treeRef: run.run_branch,
    });
    const resultLinks = deriveGitHubLinks(agent.repo_url, {
      commitRef: run.result_commit,
      compareBaseRef: run.input_ref,
      compareHeadRef: run.result_commit,
      treeRef: run.result_commit,
    });
    const resultAvailable = run.result_commit !== null;
    return {
      ok: true,
      run: {
        id: run.id,
        agentId: run.agent_id,
        status: run.status,
        objective: run.objective,
        baseRef: run.input_ref,
        branchName: run.run_branch,
        resultCommit: run.result_commit,
        workerId: run.worker_id,
      },
      repository: {
        repoUrl: agent.repo_url,
        repoWebUrl: branchLinks.repoUrl,
      },
      links: {
        branchTreeUrl: branchLinks.treeUrl,
        branchCompareUrl: branchLinks.compareUrl,
        resultTreeUrl: resultLinks.treeUrl,
        resultCommitUrl: resultLinks.commitUrl,
        resultCompareUrl: resultLinks.compareUrl,
      },
      result: resultAvailable
        ? {
            available: true,
            commit: run.result_commit,
            baseRef: run.input_ref,
            branchName: run.run_branch,
            inspectionMode: "server_metadata",
          }
        : {
            available: false,
            reason: run.status === "stopped"
              ? "stopped_branch_without_result_commit"
              : "result_commit_not_recorded",
            inspectionMode: "server_metadata",
          },
      commands: {
        inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
        inspectResult: ["npm", "run", "cli", "--", "runs", "inspect-result", run.id, "--server"],
        checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `./checkouts/${run.id}`],
        reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `./checkouts/${run.id}`],
        resumeBranch: run.status === "stopped" && run.result_commit === null
          ? ["npm", "run", "cli", "--", "runs", "resume-branch", run.id]
          : null,
      },
    };
  });

  app.get("/api/runs/:id/resume-inspection", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await db.getAgentRun(id);
    if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
    const agent = await db.getAgent(run.agent_id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    const sandboxes = await db.listSandboxes({ runId: run.id });
    const runningSandboxes = sandboxes.filter((sandbox) => sandbox.state === "running");
    const branchLinks = deriveGitHubLinks(agent.repo_url, {
      compareBaseRef: run.input_ref,
      compareHeadRef: run.run_branch,
      treeRef: run.run_branch,
    });
    const resultLinks = deriveGitHubLinks(agent.repo_url, {
      commitRef: run.result_commit,
      compareBaseRef: run.input_ref,
      compareHeadRef: run.result_commit,
      treeRef: run.result_commit,
    });
    const ready = run.status === "stopped" && run.result_commit === null && runningSandboxes.length === 0;
    const reason = run.result_commit !== null
      ? "result_commit_recorded"
      : run.status !== "stopped"
        ? `run_status_${run.status}`
        : runningSandboxes.length > 0
          ? "running_sandbox_present"
          : "stopped_branch_without_result_commit";
    const resumeBranch = ["npm", "run", "cli", "--", "runs", "resume-branch", run.id];
    const inspectRun = ["npm", "run", "cli", "--", "runs", "inspect", run.id];
    const inspectResult = ["npm", "run", "cli", "--", "runs", "inspect-result", run.id, "--server"];
    return {
      ok: true,
      run: {
        id: run.id,
        agentId: run.agent_id,
        status: run.status,
        objective: run.objective,
        baseRef: run.input_ref,
        branchName: run.run_branch,
        resultCommit: run.result_commit,
        workerId: run.worker_id,
      },
      repository: {
        repoUrl: agent.repo_url,
        repoWebUrl: branchLinks.repoUrl,
      },
      recovery: {
        ready,
        reason,
        inspectionMode: "server_metadata",
        runningSandboxes: runningSandboxes.map((sandbox) => ({
          id: sandbox.id,
          providerSandboxId: sandbox.provider_sandbox_id,
        })),
      },
      links: {
        branchTreeUrl: branchLinks.treeUrl,
        branchCompareUrl: branchLinks.compareUrl,
        resultTreeUrl: resultLinks.treeUrl,
        resultCommitUrl: resultLinks.commitUrl,
        resultCompareUrl: resultLinks.compareUrl,
      },
      commands: {
        inspectRun,
        inspectResult,
        resumeBranch: ready ? resumeBranch : null,
        resumeBranchDryRun: [...resumeBranch, "--dry-run"],
        checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `./checkouts/${run.id}`],
        watchRun: ["npm", "run", "cli", "--", "runs", "watch", run.id],
        resumeStoppedWorker: ["npm", "run", "cli", "--", "runs", "work", "--agent", run.agent_id, "--resume-stopped"],
      },
      nextStep: ready
        ? { action: "resume_branch", reason, command: resumeBranch }
        : {
            action: run.result_commit ? "inspect_result" : "inspect_run",
            reason,
            command: run.result_commit ? inspectResult : inspectRun,
          },
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

  app.post("/api/runs/:id/resume-branch", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = requestBody(request.body);
    const workerId = parseOptionalString(body.workerId);
    const dryRun = parseBoolean(body.dryRun, false);
    const existing = await db.getAgentRun(id);
    if (!existing) return reply.code(404).send({ ok: false, error: "run not found" });
    if (existing.status !== "stopped" || existing.result_commit !== null) {
      return reply.code(409).send({
        ok: false,
        error: `resume-branch requires a stopped run without a result commit; ${existing.id} is ${existing.status}`,
      });
    }
    const hasRunningSandbox = (await db.listSandboxes({ runId: existing.id }))
      .some((sandbox) => sandbox.state === "running");
    if (hasRunningSandbox) {
      return reply.code(409).send({ ok: false, error: "run has a running sandbox" });
    }
    const branch = {
      agentId: existing.agent_id,
      runId: existing.id,
      objective: existing.objective,
      branchName: existing.run_branch,
      resultCommit: existing.result_commit,
      workerId: existing.worker_id,
      currentStatus: existing.status,
    };
    if (dryRun) return { ok: true, resumable: branch, dryRun: true };
    const run = await db.requeueAgentRun(id);
    if (!run) return reply.code(409).send({ ok: false, error: "run could not be resumed" });
    await db.appendMessage({
      agentId: run.agent_id,
      runId: run.id,
      type: "agent_run_requeued",
      text: workerId ? `Requeued run by ${workerId}` : "Requeued run",
    });
    return {
      ok: true,
      resumed: {
        ...branch,
        status: run.status,
        workerId: run.worker_id,
      },
      run,
    };
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

const readWorkerSessionControlPlaneStatus = async (
  settings: Settings,
  db: Database,
  name: string,
  lines: number,
): Promise<{
  ok: true;
  session: string;
  workers: {
    watch: { total: number; alive: number; stopped: number; retired: number };
    drain: { total: number; alive: number; stopped: number; retired: number };
    applyAction: { total: number; alive: number; stopped: number; retired: number };
    controlPlaneTick: { total: number; alive: number; stopped: number; retired: number };
  };
  queues: {
    applyActions: ReturnType<typeof summarizeWorkerSessionApplyActionQueue>["counts"];
    drainContinuations: ReturnType<typeof summarizeDrainContinuationStatuses>;
  };
  branches: Awaited<ReturnType<typeof summarizeWorkerSessionBranchRecovery>> & {
    executions: {
      recent: Awaited<ReturnType<typeof listWorkerSessionBranchRecoveryExecutionRecords>>;
      counts: ReturnType<typeof summarizeBranchRecoveryExecutionStatuses>;
    };
  };
  recovery: {
    count: number;
    actions: Record<string, number>;
    nextSteps: { watchWorkers: unknown[]; drainWorkers: unknown[]; applyActionWorkers: unknown[]; controlPlaneTickWorkers: unknown[] };
  };
}> => {
  const session = await readWorkerSession(settings.projectRoot, name);
  const [
    applyRecords,
    drainContinuations,
    watchWorkers,
    watchWorkerNextSteps,
    drainWorkers,
    drainWorkerNextSteps,
    applyActionWorkers,
    applyActionWorkerNextSteps,
    controlPlaneTickWorkers,
    controlPlaneTickWorkerNextSteps,
    branchRecovery,
    branchRecoveryExecutions,
  ] = await Promise.all([
    listWorkerSessionApplyRecords(settings.projectRoot, name),
    listWorkerSessionDrainContinuationRecords(settings.projectRoot, name, Number.MAX_SAFE_INTEGER),
    listWorkerSessionWatchWorkers(settings.projectRoot, { sessionName: name, includeRetired: true }, lines),
    listWorkerSessionWatchWorkerNextSteps(settings.projectRoot, name),
    listWorkerSessionDrainWorkers(settings.projectRoot, { sessionName: name, includeRetired: true }, lines),
    listWorkerSessionDrainWorkerNextSteps(settings.projectRoot, name),
    listWorkerSessionApplyActionWorkers(settings.projectRoot, { sessionName: name, includeRetired: true }, lines),
    listWorkerSessionApplyActionWorkerNextSteps(settings.projectRoot, name),
    listWorkerSessionControlPlaneTickWorkers(settings.projectRoot, { sessionName: name, includeRetired: true }, lines),
    listWorkerSessionControlPlaneTickWorkerNextSteps(settings.projectRoot, name),
    summarizeWorkerSessionBranchRecovery(db, session, lines),
    listWorkerSessionBranchRecoveryExecutionRecords(settings.projectRoot, name, lines),
  ]);
  const applyActionQueue = summarizeWorkerSessionApplyActionQueue(applyRecords);
  return {
    ok: true,
    session: name,
    workers: {
      watch: summarizeControlPlaneWorkers(watchWorkers),
      drain: summarizeControlPlaneWorkers(drainWorkers),
      applyAction: summarizeControlPlaneWorkers(applyActionWorkers),
      controlPlaneTick: summarizeControlPlaneWorkers(controlPlaneTickWorkers),
    },
    queues: {
      applyActions: applyActionQueue.counts,
      drainContinuations: summarizeDrainContinuationStatuses(drainContinuations),
    },
    branches: {
      ...branchRecovery,
      executions: {
        recent: branchRecoveryExecutions,
        counts: summarizeBranchRecoveryExecutionStatuses(branchRecoveryExecutions),
      },
    },
    recovery: {
      count: watchWorkerNextSteps.count + drainWorkerNextSteps.count + applyActionWorkerNextSteps.count + controlPlaneTickWorkerNextSteps.count,
      actions: {
        ...watchWorkerNextSteps.actions,
        ...drainWorkerNextSteps.actions,
        ...applyActionWorkerNextSteps.actions,
        ...controlPlaneTickWorkerNextSteps.actions,
      },
      nextSteps: {
        watchWorkers: watchWorkerNextSteps.nextSteps,
        drainWorkers: drainWorkerNextSteps.nextSteps,
        applyActionWorkers: applyActionWorkerNextSteps.nextSteps,
        controlPlaneTickWorkers: controlPlaneTickWorkerNextSteps.nextSteps,
      },
    },
  };
};

const runWorkerSessionControlPlaneTick = async (
  settings: Settings,
  db: Database,
  baseUrl: string,
  sessionName: string,
  options: { dryRun: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  tickPath: string;
  tick: Awaited<ReturnType<typeof writeWorkerSessionControlPlaneTickRecord>>["record"];
  planned: Awaited<ReturnType<typeof writeWorkerSessionControlPlaneTickRecord>>["record"]["planned"];
  executed: Awaited<ReturnType<typeof writeWorkerSessionControlPlaneTickRecord>>["record"]["executed"];
  before: Awaited<ReturnType<typeof readWorkerSessionControlPlaneStatus>>;
  after: Awaited<ReturnType<typeof readWorkerSessionControlPlaneStatus>>;
}> => {
  const observedAt = new Date().toISOString();
  const before = await readWorkerSessionControlPlaneStatus(settings, db, sessionName, options.lines);
  const branchRunIds = before.branches.nextSteps
    .filter((step) => step.action === "resume_branch")
    .map((step) => step.runId);
  const planned = {
    branchRecovery: branchRunIds.length > 0
      ? {
        action: "resume_next_branch" as const,
        runIds: branchRunIds.slice(0, 1),
        command: before.branches.commands.resumeNext,
      }
      : null,
    applyAction: before.queues.applyActions.actionable > 0
      ? {
        action: "execute_next_apply_action" as const,
        actionable: before.queues.applyActions.actionable,
      }
      : null,
    drainContinuation: before.queues.drainContinuations.queued > 0
      ? {
        action: "execute_next_drain_continuation" as const,
        queued: before.queues.drainContinuations.queued,
      }
      : null,
  };
  const executed = {
    branchRecovery: null as TickCommandExecution | null,
    applyAction: null as TickCommandExecution | null,
    drainContinuation: null as TickCommandExecution | null,
  };
  if (!options.dryRun) {
    if (planned.branchRecovery) {
      executed.branchRecovery = await runControlPlaneTickCommand(
        settings.projectRoot,
        baseUrl,
        planned.branchRecovery.command,
      );
    }
    if (planned.applyAction) {
      executed.applyAction = await runControlPlaneTickCommand(
        settings.projectRoot,
        baseUrl,
        ["npm", "run", "cli", "--", "runs", "session-applies", sessionName, "--server", "--action-queue", "--execute-next"],
      );
    }
    if (planned.drainContinuation) {
      executed.drainContinuation = await runControlPlaneTickCommand(
        settings.projectRoot,
        baseUrl,
        ["npm", "run", "cli", "--", "runs", "session-drain-continuations", sessionName, "--execute-next"],
      );
    }
  }
  const after = await readWorkerSessionControlPlaneStatus(settings, db, sessionName, options.lines);
  const plannedCount = [
    planned.branchRecovery,
    planned.applyAction,
    planned.drainContinuation,
  ].filter(Boolean).length;
  const executedCount = [
    commandSucceeded(executed.branchRecovery) ? executed.branchRecovery : null,
    commandExecutedBoolean(executed.applyAction) ? executed.applyAction : null,
    commandExecutedBoolean(executed.drainContinuation) ? executed.drainContinuation : null,
  ].filter(Boolean).length;
  const tick = await writeWorkerSessionControlPlaneTickRecord(settings.projectRoot, {
    session: sessionName,
    observedAt,
    completedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    status: options.dryRun
      ? "dry_run"
      : plannedCount === 0
        ? "noop"
        : executedCount === plannedCount
          ? "executed"
          : "partial",
    planned,
    executed,
    before,
    after,
  });
  return {
    ok: true,
    session: sessionName,
    observedAt,
    completedAt: tick.record.completedAt,
    dryRun: options.dryRun,
    tickPath: tick.path,
    tick: tick.record,
    planned,
    executed,
    before,
    after,
  };
};

const runWorkerSessionControlPlaneTickLoop = async (
  settings: Settings,
  db: Database,
  baseUrl: string,
  sessionName: string,
  options: { dryRun: boolean; lines: number; maxTicks: number; intervalMs: number },
): Promise<{
  ok: true;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  maxTicks: number;
  intervalMs: number;
  executedTicks: number;
  stoppedReason: "noop" | "max_ticks";
  tickIds: string[];
  ticks: Array<Awaited<ReturnType<typeof runWorkerSessionControlPlaneTick>>["tick"]>;
}> => {
  if (options.maxTicks < 1) throw new Error("maxTicks must be at least 1");
  if (options.intervalMs < 0) throw new Error("intervalMs must be non-negative");
  const observedAt = new Date().toISOString();
  const ticks = [];
  let stoppedReason: "noop" | "max_ticks" = "max_ticks";
  for (let tickIndex = 0; tickIndex < options.maxTicks; tickIndex += 1) {
    const tick = await runWorkerSessionControlPlaneTick(settings, db, baseUrl, sessionName, {
      dryRun: options.dryRun,
      lines: options.lines,
    });
    ticks.push(tick.tick);
    if (tick.tick.status === "noop") {
      stoppedReason = "noop";
      break;
    }
    if (tickIndex + 1 < options.maxTicks) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
  return {
    ok: true,
    session: sessionName,
    observedAt,
    completedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    maxTicks: options.maxTicks,
    intervalMs: options.intervalMs,
    executedTicks: ticks.length,
    stoppedReason,
    tickIds: ticks.map((tick) => tick.tickId),
    ticks,
  };
};

type TickCommandExecution = {
  command: string[];
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  output: unknown;
};

const runControlPlaneTickCommand = async (
  projectRoot: string,
  baseUrl: string,
  command: string[],
): Promise<TickCommandExecution> => {
  const result = await runCliContinuationCommand(projectRoot, baseUrl, command);
  return {
    command,
    exitCode: result.exitCode,
    ...(result.stdout ? { stdout: result.stdout } : {}),
    ...(result.stderr ? { stderr: result.stderr } : {}),
    output: parseJsonMaybe(result.stdout),
  };
};

const commandSucceeded = (execution: TickCommandExecution | null): boolean => {
  return execution?.exitCode === 0;
};

const commandExecutedBoolean = (execution: TickCommandExecution | null): boolean => {
  if (!commandSucceeded(execution)) return false;
  if (typeof execution?.output !== "object" || execution.output === null || Array.isArray(execution.output)) return false;
  return (execution.output as { executed?: unknown }).executed === true;
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

const parseOptionalNonNegativeInteger = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("expected non-negative integer");
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

const parseOptionalBranchActions = (value: unknown): Array<"resume_branch" | "review_branch"> => {
  const actions = parseOptionalList(value);
  const allowed = new Set(["resume_branch", "review_branch"]);
  for (const action of actions) {
    if (!allowed.has(action)) throw new Error(`unknown branch action: ${action}`);
  }
  return actions as Array<"resume_branch" | "review_branch">;
};

const parseOptionalDrainContinuationStatuses = (value: unknown): Array<"queued" | "running" | "executed" | "failed"> => {
  const statuses = parseOptionalList(value);
  const allowed = new Set(["queued", "running", "executed", "failed"]);
  for (const status of statuses) {
    if (!allowed.has(status)) throw new Error(`unknown drain continuation status: ${status}`);
  }
  return statuses as Array<"queued" | "running" | "executed" | "failed">;
};

const parseOptionalApplyActions = (
  value: unknown,
): Array<"retry_failed" | "resume_pending" | "inspect_drain_continuation_resets"> => {
  const actions = parseOptionalList(value);
  const allowed = new Set(["retry_failed", "resume_pending", "inspect_drain_continuation_resets"]);
  for (const action of actions) {
    if (!allowed.has(action)) throw new Error(`unknown apply action: ${action}`);
  }
  return actions as Array<"retry_failed" | "resume_pending" | "inspect_drain_continuation_resets">;
};

const parseOptionalApplyActionExecutionStatuses = (value: unknown): Array<"executed" | "failed"> => {
  const statuses = parseOptionalList(value);
  const allowed = new Set(["executed", "failed"]);
  for (const status of statuses) {
    if (!allowed.has(status)) throw new Error(`unknown apply action execution status: ${status}`);
  }
  return statuses as Array<"executed" | "failed">;
};

const parseOptionalBranchRecoveryExecutionStatuses = (value: unknown): Array<"executed" | "partial" | "noop"> => {
  const statuses = parseOptionalList(value);
  const allowed = new Set(["executed", "partial", "noop"]);
  for (const status of statuses) {
    if (!allowed.has(status)) throw new Error(`unknown branch recovery execution status: ${status}`);
  }
  return statuses as Array<"executed" | "partial" | "noop">;
};

const parseCommand = (value: unknown): string[] => {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    if (value.length === 0) throw new Error("command must not be empty");
    return value;
  }
  if (typeof value === "string" && value.trim()) return ["bash", "-lc", value.trim()];
  throw new Error("command must be a string or string[]");
};

const summarizeControlPlaneWorkers = <T extends { alive: boolean; retiredAt?: string; stoppedAt?: string }>(workers: T[]): {
  total: number;
  alive: number;
  stopped: number;
  retired: number;
} => ({
  total: workers.length,
  alive: workers.filter((worker) => worker.alive).length,
  stopped: workers.filter((worker) => !worker.alive && Boolean(worker.stoppedAt) && !worker.retiredAt).length,
  retired: workers.filter((worker) => Boolean(worker.retiredAt)).length,
});

const summarizeDrainContinuationStatuses = <T extends { status?: string }>(records: T[]): {
  total: number;
  queued: number;
  running: number;
  executed: number;
  failed: number;
} => ({
  total: records.length,
  queued: records.filter((record) => (record.status ?? "queued") === "queued").length,
  running: records.filter((record) => record.status === "running").length,
  executed: records.filter((record) => record.status === "executed").length,
  failed: records.filter((record) => record.status === "failed").length,
});

const summarizeBranchRecoveryExecutionStatuses = <T extends { status: string }>(records: T[]): {
  recent: number;
  executed: number;
  partial: number;
  noop: number;
} => ({
  recent: records.length,
  executed: records.filter((record) => record.status === "executed").length,
  partial: records.filter((record) => record.status === "partial").length,
  noop: records.filter((record) => record.status === "noop").length,
});

const summarizeWorkerSessionBranchRecovery = async (
  db: Database,
  session: Awaited<ReturnType<typeof readWorkerSession>>,
  nextStepLimit: number,
): Promise<{
  counts: {
    total: number;
    ready: number;
    blocked: number;
    stoppedBranchWithoutResultCommit: number;
    runningSandboxPresent: number;
  };
  actions: { resume_branch: number; inspect_run: number };
  commands: { resumeSession: string[]; resumeSessionDryRun: string[]; resumeNext: string[]; inspectBranches: string[] };
  nextSteps: Array<{
    action: "resume_branch" | "inspect_run";
    reason: "stopped_branch_without_result_commit" | "running_sandbox_present";
    agentId: string;
    runId: string;
    status: string;
    branchName: string;
    workerId: string | null;
    command: string[];
    runningSandboxes: Array<{ id: string; providerSandboxId: string | null }>;
  }>;
}> => {
  const sessionWorkerIds = new Set(session.workers.map((worker) => worker.workerId));
  const runs = (await Promise.all(workerSessionAgentIds(session).map(async (agentId) => {
    return (await db.listAgentRuns(agentId, ["stopped"]))
      .filter((run) => run.result_commit === null)
      .filter((run) => run.worker_id === null || sessionWorkerIds.has(run.worker_id))
      .map((run) => ({ agentId, run }));
  }))).flat();
  const nextSteps = await Promise.all(runs.map(async ({ agentId, run }) => {
    const runningSandboxes = (await db.listSandboxes({ runId: run.id }))
      .filter((sandbox) => sandbox.state === "running")
      .map((sandbox) => ({ id: sandbox.id, providerSandboxId: sandbox.provider_sandbox_id }));
    const ready = runningSandboxes.length === 0;
    const command = ready
      ? ["npm", "run", "cli", "--", "runs", "resume-branch", run.id]
      : ["npm", "run", "cli", "--", "runs", "inspect", run.id];
    return {
      action: ready ? "resume_branch" as const : "inspect_run" as const,
      reason: ready ? "stopped_branch_without_result_commit" as const : "running_sandbox_present" as const,
      agentId,
      runId: run.id,
      status: run.status,
      branchName: run.run_branch,
      workerId: run.worker_id,
      command,
      runningSandboxes,
    };
  }));
  const ready = nextSteps.filter((step) => step.action === "resume_branch").length;
  const blocked = nextSteps.length - ready;
  const resumeSession = ["npm", "run", "cli", "--", "runs", "resume-session", session.session];
  return {
    counts: {
      total: nextSteps.length,
      ready,
      blocked,
      stoppedBranchWithoutResultCommit: ready,
      runningSandboxPresent: blocked,
    },
    actions: {
      resume_branch: ready,
      inspect_run: blocked,
    },
    commands: {
      resumeSession,
      resumeSessionDryRun: [...resumeSession, "--dry-run"],
      resumeNext: [...resumeSession, "--next"],
      inspectBranches: ["npm", "run", "cli", "--", "runs", "session-branches", session.session, "--server", "--resumable"],
    },
    nextSteps: nextSteps.slice(0, nextStepLimit),
  };
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

const executeWorkerSessionApplyActionCommand = async (
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  action: WorkerSessionApplyActionSummary,
  filter: Record<string, unknown>,
): Promise<{
  result: { exitCode: number | null; stdout: string; stderr: string };
  output: unknown;
  execution: Awaited<ReturnType<typeof writeWorkerSessionApplyActionExecutionRecord>>;
}> => {
  const observedAt = new Date().toISOString();
  const result = await runCliContinuationCommand(projectRoot, baseUrl, action.command);
  const output = parseJsonMaybe(result.stdout);
  const execution = await writeWorkerSessionApplyActionExecutionRecord(projectRoot, {
    session: sessionName,
    observedAt,
    completedAt: new Date().toISOString(),
    status: result.exitCode === 0 ? "executed" : "failed",
    filter,
    applyId: action.applyId,
    source: action.source,
    action: action.action,
    command: action.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    ...(result.stderr ? { stderr: result.stderr } : {}),
    output,
  });
  return { result, output, execution };
};

const executeDrainContinuationCommand = async <T extends { command: string[] }>(
  cwd: string,
  baseUrl: string,
  drain: T,
): Promise<T & { exitCode: number | null; output: unknown; stderr?: string }> => {
  const result = await runCliContinuationCommand(cwd, baseUrl, drain.command);
  return {
    ...drain,
    exitCode: result.exitCode,
    output: parseJsonMaybe(result.stdout),
    ...(result.stderr ? { stderr: result.stderr } : {}),
  };
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
