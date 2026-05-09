import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import { buildAgentBootPlan, buildAgentRuntimeCheckPlan } from "./agentBoot.js";
import { getAgentRepositoryMetadata, planRunBranch } from "./agentRepository.js";
import { buildAgentTemplate } from "./agentTemplate.js";
import { createHostedGitProvider } from "./hostedGit.js";
import { createInitialCommit } from "./gitRepositoryBootstrap.js";
import { Database } from "./db.js";
import { createSandboxProvider } from "./modalProvider.js";
import { MessageBus } from "./messageBus.js";
import { runPlanFromRow } from "./runPlanning.js";
import { SandboxService } from "./sandboxService.js";
import type { Settings } from "./config.js";

type AppParts = {
  app: FastifyInstance;
  db: Database;
};

export const buildServer = async (settings: Settings): Promise<AppParts> => {
  const db = new Database(settings.dbUrl, path.join(settings.projectRoot, "schema", "bootstrap.sql"));
  await db.initSchema();

  const bus = new MessageBus();
  const hostedGit = createHostedGitProvider(settings);
  const sandboxService = new SandboxService(db, createSandboxProvider(settings), bus);
  const app = Fastify({ logger: true });

  app.addHook("onClose", async () => {
    await db.close();
  });

  app.get("/health", async () => ({
    ok: true,
    name: "threadbeat",
    modalMode: settings.modalMode,
    modalAppName: settings.modalAppName,
    modalImage: settings.modalImage,
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
      const defaultBranch = parseOptionalString(body.defaultBranch ?? body.default_branch) ?? "main";
      const template = buildAgentTemplate({
        name: parseString(body.name, "name"),
        id: parseOptionalString(body.id),
        description: parseOptionalString(body.description),
      });
      const provisionalAgent = {
        id: template.id,
        name: template.name,
        repo_url: `threadbeat-template://${template.id}`,
        default_branch: defaultBranch,
        current_ref: defaultBranch,
      };
      const dryRun = parseBoolean(body.dryRun ?? body.dry_run, defaultAgentTemplateDryRun(settings));
      const hostedRepo = await hostedGit.createRepository({
        agent: provisionalAgent,
        dryRun,
        repoId: parseOptionalString(body.repoId ?? body.repo_id) ?? template.id,
      });
      const initialized = hostedRepo.remoteUrl && !dryRun
        ? await createInitialCommit({
          branch: hostedRepo.defaultBranch,
          commitMessage: parseOptionalString(body.commitMessage ?? body.commit_message) ?? "Initialize Threadbeat agent",
          files: template.files,
          remoteUrl: hostedRepo.remoteUrl,
        })
        : null;
      const repoUrl = hostedAgentRepoUrl(hostedRepo);
      const metadata = getAgentRepositoryMetadata({
        ...provisionalAgent,
        repo_url: repoUrl,
        current_ref: hostedRepo.defaultBranch,
      });
      const agent = await db.createAgent({
        name: template.name,
        repoUrl,
        repoWebUrl: metadata.repoWebUrl,
        defaultBranch: hostedRepo.defaultBranch,
        currentRef: hostedRepo.defaultBranch,
        currentCommit: initialized?.commitSha,
      });
      const repo = await db.createCodeStorageRepo({
        agentId: agent.id,
        codeStorageRepoId: hostedRepo.providerRepoId,
        organizationName: hostedRepo.namespace,
        defaultBranch: hostedRepo.defaultBranch,
        remoteUrlRedacted: hostedRepo.remoteUrlRedacted,
        sourceProvider: hostedRepo.provider,
        sourceOwner: hostedGitSourceValue(hostedRepo.source, "owner") ?? hostedRepo.namespace,
        sourceName: hostedGitSourceValue(hostedRepo.source, "repo") ?? hostedGitSourceValue(hostedRepo.source, "name"),
        sourceDefaultBranch: hostedGitSourceValue(hostedRepo.source, "defaultBranch") ?? hostedRepo.defaultBranch,
      });
      await db.appendMessage({
        agentId: agent.id,
        source: "server",
        type: initialized ? "agent_template_repo_initialized" : "agent_template_repo_planned",
        text: initialized
          ? `Initialized hosted agent repo ${hostedRepo.providerRepoId} at ${initialized.commitSha}`
          : `Planned hosted agent repo ${hostedRepo.providerRepoId} from template`,
        data: { agent, hostedRepo: { ...hostedRepo, remoteUrl: hostedRepo.remoteUrlRedacted }, template, initialized },
      });
      return { ok: true, agent, codeStorageRepo: repo, hostedRepo: { ...hostedRepo, remoteUrl: hostedRepo.remoteUrlRedacted }, initialized, template };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/agents", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const repoUrl = parseString(body.repoUrl ?? body.repo_url, "repoUrl");
      const provisionalAgent = {
        id: "new-agent",
        name: parseString(body.name, "name"),
        repo_url: repoUrl,
        default_branch: parseOptionalString(body.defaultBranch ?? body.default_branch) ?? "main",
        current_ref:
          parseOptionalString(body.currentRef ?? body.current_ref)
          ?? parseOptionalString(body.defaultBranch ?? body.default_branch)
          ?? "main",
      };
      const metadata = getAgentRepositoryMetadata(provisionalAgent);
      const agent = await db.createAgent({
        name: provisionalAgent.name,
        repoUrl,
        repoWebUrl: metadata.repoWebUrl,
        defaultBranch: metadata.defaultBranch,
        currentRef: metadata.currentRef,
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

  app.get("/api/agents/:id/code-storage", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    return { ok: true, codeStorageRepo: await db.getCodeStorageRepoForAgent(id) };
  });

  app.post("/api/agents/:id/code-storage", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const existing = await db.getCodeStorageRepoForAgent(id);
      if (existing) return reply.code(409).send({ ok: false, error: "agent already has a Code.Storage repo" });
      const body = requestBody(request.body);
      const created = await hostedGit.createRepository({
        agent,
        dryRun: parseBoolean(body.dryRun ?? body.dry_run, !settings.codeStoragePrivateKey),
        repoId: parseOptionalString(body.repoId ?? body.repo_id),
      });
      const repo = await db.createCodeStorageRepo({
        agentId: agent.id,
        codeStorageRepoId: created.providerRepoId,
        organizationName: created.namespace,
        defaultBranch: created.defaultBranch,
        remoteUrlRedacted: created.remoteUrlRedacted,
        sourceProvider: codeStorageSourceValue(created.source, "provider"),
        sourceOwner: codeStorageSourceValue(created.source, "owner"),
        sourceName: codeStorageSourceValue(created.source, "name"),
        sourceDefaultBranch: codeStorageSourceValue(created.source, "defaultBranch"),
      });
      await db.appendMessage({
        agentId: agent.id,
        source: "code.storage",
        type: created.live ? "code_storage_repo_created" : "code_storage_repo_dry_run_created",
        text: `Code.Storage repo ${created.providerRepoId} registered for ${agent.name}`,
        data: { codeStorageRepo: repo, live: created.live },
      });
      return { ok: true, codeStorageRepo: repo, live: created.live };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/code-storage/repos", async () => ({
    ok: true,
    codeStorageRepos: await db.listCodeStorageRepos(),
  }));

  app.get("/api/agents/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const agent = await db.getAgent(id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    const runs = await db.listAgentRuns(id);
    return {
      ok: true,
      runs,
      plans: runs.map((run) => runPlanFromRow(agent, run)),
    };
  });

  app.post("/api/agents/:id/runs", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const agent = await db.getAgent(id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const body = requestBody(request.body);
      const objective = parseString(body.objective, "objective");
      const inputRef = parseOptionalString(body.inputRef ?? body.input_ref) ?? agent.current_ref;
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
        kind: parseOptionalString(body.kind) ?? "run",
        objective,
        inputRef: plan.sourceRef,
        runBranch: plan.branchName,
        baseCommit: parseOptionalString(body.baseCommit ?? body.base_commit),
        status: parseOptionalString(body.status) ?? "planned",
      });
      const persistedPlan = runPlanFromRow(agent, run);
      await db.appendMessage({
        agentId: agent.id,
        runId: run.id,
        source: "server",
        type: "agent_run_planned",
        text: `Planned ${run.kind} run ${run.id} on ${run.run_branch}`,
        data: { run, plan: persistedPlan },
      });
      return { ok: true, run, plan: persistedPlan };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = await db.getAgentRun(id);
    if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
    const agent = await db.getAgent(run.agent_id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    return { ok: true, run, plan: runPlanFromRow(agent, run) };
  });

  app.get("/api/runs/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const run = await db.getAgentRun(id);
    if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
    const agent = await db.getAgent(run.agent_id);
    if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
    const [sandboxes, messages] = await Promise.all([
      db.listSandboxes({ runId: run.id }),
      db.listMessages({ runId: run.id, limit: parsePositiveInt(query.limit, 20) }),
    ]);
    return {
      ok: true,
      run,
      plan: runPlanFromRow(agent, run),
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
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      await db.updateAgentRunStarted(run.id);
      const agent = await db.getAgent(run.agent_id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const [existingSandbox] = await db.listSandboxes({ runId: run.id });
      if (existingSandbox) {
        if (existingSandbox.state !== "running") {
          return reply.code(409).send({
            ok: false,
            error: `run sandbox is already ${existingSandbox.state}`,
          });
        }
        if (!parseBoolean(body.bootstrap, false)) {
          return { ok: true, run, sandbox: existingSandbox, existing: true };
        }
        const cloneUrl = await resolveCloneUrl(agent.id, run.input_ref);
        const bootstrap = await sandboxService.bootstrap(existingSandbox, cloneUrl);
        return { ok: true, run, sandbox: bootstrap.sandbox, bootstrap, existing: true };
      }
      const sandbox = await sandboxService.startForAgent(agent, {
        branch: run.run_branch,
        runId: run.id,
      });
      if (!parseBoolean(body.bootstrap, false)) return { ok: true, run, sandbox };
      const cloneUrl = await resolveCloneUrl(agent.id, run.input_ref);
      const bootstrap = await sandboxService.bootstrap(sandbox, cloneUrl);
      return { ok: true, run, sandbox: bootstrap.sandbox, bootstrap };
    } catch (error) {
      if (runId) await markRunFailed(runId, error);
      return reply.code(500).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/runs/:id/restart-sandbox", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = requestBody(request.body);
      const run = await db.getAgentRun(id);
      if (!run) return reply.code(404).send({ ok: false, error: "run not found" });
      if (run.status === "completed" || run.status === "failed") {
        return reply.code(409).send({ ok: false, error: `run is already ${run.status}` });
      }
      const agent = await db.getAgent(run.agent_id);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const [existingSandbox] = await db.listSandboxes({ runId: run.id });
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
      const restartedRun = await db.updateAgentRunRestarted(run.id);
      const sandbox = await sandboxService.startForAgent(agent, {
        branch: run.run_branch,
        runId: run.id,
      });
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        source: "server",
        type: "agent_run_sandbox_restarted",
        text: `Restarted run sandbox ${sandbox.id}`,
        data: { previousSandbox: existingSandbox, sandbox },
      });
      if (!parseBoolean(body.bootstrap, false)) {
        return { ok: true, run: restartedRun, sandbox, previousSandbox: existingSandbox };
      }
      const cloneUrl = await resolveCloneUrl(agent.id, run.input_ref);
      const bootstrap = await sandboxService.bootstrap(sandbox, cloneUrl);
      return {
        ok: true,
        run: restartedRun,
        sandbox: bootstrap.sandbox,
        previousSandbox: existingSandbox,
        bootstrap,
      };
    } catch (error) {
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
      await db.updateAgentRunStarted(run.id);
      const [sandbox] = await db.listSandboxes({ runId: run.id });
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const body = requestBody(request.body);
      const command = parseCommand(body.command);
      const cwd = parseOptionalString(body.cwd) ?? sandbox.workdir;
      const timeoutMs = parseOptionalInteger(body.timeoutMs ?? body.timeout_ms) ?? settings.sandboxExecTimeoutMs;
      const result = await sandboxService.exec(sandbox, command, { cwd, timeoutMs });
      return { ok: true, run, ...result };
    } catch (error) {
      if (runId) await markRunFailed(runId, error);
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
      await db.updateAgentRunStarted(run.id);
      const [sandbox] = await db.listSandboxes({ runId: run.id });
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const body = requestBody(request.body);
      const plan = buildAgentBootPlan({
        agentPiCommand: settings.agentPiCommand ?? "pi",
        objective: parseOptionalString(body.objective) ?? run.objective,
        promptPath: parseOptionalString(body.promptPath ?? body.prompt_path),
        runId: run.id,
        taskPath: parseOptionalString(body.taskPath ?? body.task_path),
      });
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        source: "server",
        type: "agent_boot_planned",
        text: `Booting sandbox Pi with ${plan.promptPath}`,
        data: plan,
      });
      const executed = await sandboxService.exec(sandbox, plan.command, {
        cwd: sandbox.workdir,
        timeoutMs: settings.agentBootTimeoutMs,
      });
      const failed = executed.result.exitCode !== 0;
      const updatedRun = failed
        ? await db.updateAgentRunFailed({
          id: run.id,
          resultSummary: executed.result.stderr || executed.result.stdout || `agent boot exited ${executed.result.exitCode}`,
        })
        : run;
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        source: "sandbox",
        type: failed ? "agent_boot_failed" : "agent_boot_completed",
        text: failed
          ? `Sandbox Pi boot failed with exit ${executed.result.exitCode}`
          : `Sandbox Pi boot completed with ${plan.promptPath}`,
        data: { plan, result: executed.result },
      });
      return { ok: true, run: updatedRun, plan, ...executed };
    } catch (error) {
      if (runId) await markRunFailed(runId, error);
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
      await db.updateAgentRunStarted(run.id);
      const [sandbox] = await db.listSandboxes({ runId: run.id });
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const plan = buildAgentRuntimeCheckPlan({ agentPiCommand: settings.agentPiCommand ?? "pi" });
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        source: "server",
        type: "agent_runtime_check_planned",
        text: `Checking sandbox agent runtime with ${plan.piCommand}`,
        data: plan,
      });
      const executed = await sandboxService.exec(sandbox, plan.command, {
        cwd: sandbox.workdir,
        timeoutMs: settings.sandboxExecTimeoutMs,
      });
      const failed = executed.result.exitCode !== 0;
      const updatedRun = failed
        ? await db.updateAgentRunFailed({
          id: run.id,
          resultSummary: executed.result.stderr || executed.result.stdout || `agent runtime check exited ${executed.result.exitCode}`,
        })
        : run;
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: sandbox.id,
        runId: run.id,
        source: "sandbox",
        type: failed ? "agent_runtime_check_failed" : "agent_runtime_check_completed",
        text: failed
          ? `Sandbox agent runtime check failed with exit ${executed.result.exitCode}`
          : `Sandbox agent runtime check completed with ${plan.piCommand}`,
        data: { plan, result: executed.result },
      });
      return { ok: true, run: updatedRun, plan, ...executed };
    } catch (error) {
      if (runId) await markRunFailed(runId, error);
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
      const [sandbox] = await db.listSandboxes({ runId: run.id });
      if (!sandbox) return reply.code(404).send({ ok: false, error: "run sandbox not found" });
      const body = requestBody(request.body);
      const commitMessage =
        parseOptionalString(body.commitMessage ?? body.commit_message)
        ?? `Finalize ${run.kind} ${run.id}`;
      const finalized = await sandboxService.finalizeRunBranch(sandbox, {
        commitMessage,
        timeoutMs: settings.sandboxExecTimeoutMs,
      });
      const completed = await db.updateAgentRunCompleted({
        id: run.id,
        resultCommit: finalized.result.commitSha,
        resultSummary: finalized.result.statusText.trim() || "No worktree changes reported before finalize",
        status: "completed",
      });
      return { ok: true, run: completed, ...finalized };
    } catch (error) {
      if (runId) await markRunFailed(runId, error);
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
      const [sandbox] = await db.listSandboxes({ runId: run.id });
      const stoppedSandbox = sandbox ? await sandboxService.stop(sandbox) : null;
      const stoppedRun = await db.updateAgentRunCompleted({
        id: run.id,
        resultSummary: stoppedSandbox
          ? `Stopped run sandbox ${stoppedSandbox.id}`
          : "Stopped run before sandbox start",
        status: "stopped",
      });
      await db.appendMessage({
        agentId: run.agent_id,
        sandboxId: stoppedSandbox?.id,
        runId: run.id,
        source: "server",
        type: "agent_run_stopped",
        text: `Stopped run ${run.id}`,
        data: { run: stoppedRun, sandbox: stoppedSandbox },
      });
      return { ok: true, run: stoppedRun, sandbox: stoppedSandbox };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  const resolveCloneUrl = async (
    agentId: string,
    baseRef: string,
  ): Promise<{ baseRef: string; pushRef?: boolean; repoUrl?: string; repoUrlRedacted?: string }> => {
    const repo = await db.getCodeStorageRepoForAgent(agentId);
    if (!repo) return { baseRef };
    const cloneUrl = await hostedGit.getCloneUrl({
      namespace: repo.organization_name,
      repoId: repo.code_storage_repo_id,
    });
    return {
      baseRef,
      pushRef: true,
      repoUrl: cloneUrl.remoteUrl,
      repoUrlRedacted: cloneUrl.remoteUrlRedacted,
    };
  };

  const markRunFailed = async (runId: string, error: unknown): Promise<void> => {
    const existing = await db.getAgentRun(runId);
    if (!existing || existing.status === "completed") return;
    await db.updateAgentRunFailed({
      id: runId,
      resultSummary: messageOf(error),
    });
  };

  app.get("/api/heartbeats", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return { ok: true, heartbeats: await db.listHeartbeats(queryValue(query, "agentId", "agent_id")) };
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
      const agentId = parseString(body.agentId ?? body.agent_id, "agentId");
      const agent = await db.getAgent(agentId);
      if (!agent) return reply.code(404).send({ ok: false, error: "agent not found" });
      const heartbeat = await db.createHeartbeat({
        agentId,
        title: parseOptionalString(body.title) ?? "heartbeat",
        cadenceSeconds: parsePositiveInt(body.cadenceSeconds ?? body.cadence_seconds, 60),
        action: parseString(body.action, "action"),
        status: parseOptionalString(body.status) ?? "active",
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
        agentId: queryValue(query, "agentId", "agent_id"),
        runId: queryValue(query, "runId", "run_id"),
      }),
    };
  });

  app.post("/api/sandboxes/stop-running", async (request, reply) => {
    try {
      const body = requestBody(request.body);
      const agentId = parseOptionalString(body.agentId ?? body.agent_id);
      const runId = parseOptionalString(body.runId ?? body.run_id);
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
      const stopped: typeof sandboxes = [];
      for (const sandbox of running) {
        stopped.push(await sandboxService.stop(sandbox));
      }
      await db.appendMessage({
        agentId,
        runId,
        source: "server",
        type: "sandboxes_stop_running_completed",
        text: `Stopped ${stopped.length} running sandbox${stopped.length === 1 ? "" : "es"}`,
        data: {
          filters: { agentId, runId },
          stoppedIds: stopped.map((sandbox) => sandbox.id),
          skippedIds: sandboxes.filter((sandbox) => sandbox.state !== "running").map((sandbox) => sandbox.id),
        },
      });
      return { ok: true, stopped, scanned: sandboxes.length };
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
      const timeoutMs = parseOptionalInteger(body.timeoutMs ?? body.timeout_ms) ?? settings.sandboxExecTimeoutMs;
      const result = await sandboxService.exec(sandbox, command, { timeoutMs });
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/sandboxes/:id/bootstrap", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "sandbox not found" });
      return { ok: true, result: await sandboxService.bootstrap(sandbox) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.post("/api/sandboxes/:id/stop", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const sandbox = await db.getSandbox(id);
      if (!sandbox) return reply.code(404).send({ ok: false, error: "sandbox not found" });
      return { ok: true, sandbox: await sandboxService.stop(sandbox) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: messageOf(error) });
    }
  });

  app.get("/api/messages", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      ok: true,
      messages: await db.listMessages({
        agentId: queryValue(query, "agentId", "agent_id"),
        runId: queryValue(query, "runId", "run_id"),
        sandboxId: queryValue(query, "sandboxId", "sandbox_id"),
        limit: parsePositiveInt(query.limit, 100),
      }),
    };
  });

  app.get("/api/messages/listen", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const agentId = queryValue(query, "agentId", "agent_id");
    const runId = queryValue(query, "runId", "run_id");
    const sandboxId = queryValue(query, "sandboxId", "sandbox_id");
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

const parsePositiveInt = (value: unknown, fallback: number): number => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("expected positive integer");
  return Math.floor(parsed);
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

const queryValue = (query: Record<string, string | undefined>, camelKey: string, snakeKey: string): string | undefined =>
  parseOptionalString(query[camelKey] ?? query[snakeKey]);

const nextId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return fallback;
};

const defaultAgentTemplateDryRun = (settings: Settings): boolean => {
  if (settings.hostedGitProvider === "github") {
    return !settings.githubOwner?.trim() || !settings.githubToken?.trim();
  }
  if (settings.hostedGitProvider === "code-storage") {
    return !settings.codeStoragePrivateKey?.trim();
  }
  return true;
};

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const codeStorageSourceValue = (source: unknown, key: string): string | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

const hostedGitSourceValue = codeStorageSourceValue;

const hostedAgentRepoUrl = (hostedRepo: {
  provider: string;
  namespace: string;
  providerRepoId: string;
  remoteUrl: string | null;
  remoteUrlRedacted: string | null;
  source: unknown;
}): string => {
  const webUrl = hostedGitSourceValue(hostedRepo.source, "webUrl");
  if (webUrl) return `${webUrl.replace(/\/+$/, "")}.git`;
  if (hostedRepo.provider === "github") {
    return `https://github.com/${hostedRepo.namespace}/${hostedRepo.providerRepoId}.git`;
  }
  return hostedRepo.remoteUrlRedacted ?? hostedRepo.remoteUrl ?? `${hostedRepo.provider}:${hostedRepo.namespace}/${hostedRepo.providerRepoId}`;
};
