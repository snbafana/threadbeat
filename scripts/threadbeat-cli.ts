import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = normalizeBaseUrl(process.env.THREADBEAT_BASE_URL ?? "http://127.0.0.1:8000");
const workerSessionDir = path.join(process.cwd(), ".threadbeat", "worker-sessions");

const [command, subcommand, ...rest] = process.argv.slice(2);

try {
  await main(command, subcommand, rest);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(commandName?: string, subcommandName?: string, args: string[] = []): Promise<void> {
  if (!commandName || commandName === "help" || commandName === "--help") {
    printHelp();
    return;
  }

  if (commandName === "agents") {
    await agents(subcommandName, args);
    return;
  }

  if (commandName === "sandboxes") {
    await sandboxes(subcommandName, args);
    return;
  }

  if (commandName === "runs") {
    await runs(subcommandName, args);
    return;
  }

  if (commandName === "heartbeats") {
    await heartbeats(subcommandName, args);
    return;
  }

  if (commandName === "hosted-git") {
    await hostedGit(subcommandName);
    return;
  }

  if (commandName === "messages") {
    await messages(subcommandName, args);
    return;
  }

  if (commandName === "health") {
    await printJson(await requestJson("GET", "/health"));
    return;
  }

  if (commandName === "preflight") {
    await printJson(await requestJson("GET", "/api/preflight"));
    return;
  }

  throw new Error(`unknown command: ${commandName}`);
}

async function agents(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    await printJson(await requestJson("GET", "/api/agents"));
    return;
  }
  if (subcommandName === "create") {
    const options = parseOptions(args);
    await printJson(await requestJson("POST", "/api/agents", {
      name: required(options.name, "--name"),
      repoUrl: required(options.repo, "--repo"),
      ...(options.branch ? { currentRef: options.branch } : {}),
    }));
    return;
  }
  if (subcommandName === "template") {
    const options = parseOptions(args);
    const response = await requestJson("POST", "/api/agent-template", {
      name: required(options.name, "--name"),
      ...(options.id ? { id: options.id } : {}),
      ...(options.description ? { description: options.description } : {}),
    });
    const outDir = options.out;
    if (!outDir) {
      await printJson(response);
      return;
    }
    const template = readTemplateResponse(response);
    const written = await materializeTemplate(template.files, outDir);
    await printJson({ outDir: path.resolve(outDir), written });
    return;
  }
  if (subcommandName === "init") {
    const options = parseOptions(args);
    if (options.live === "1" && options["dry-run"] === "1") {
      throw new Error("agents init cannot use both --live and --dry-run");
    }
    const dryRun = options.live === "1"
      ? false
      : options["dry-run"] === "1"
        ? true
        : undefined;
    await printJson(await requestJson("POST", "/api/agents/from-template", {
      name: required(options.name, "--name"),
      ...(options.id ? { id: options.id } : {}),
      ...(options["repo-id"] ? { repoId: options["repo-id"] } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.branch ? { defaultBranch: options.branch } : {}),
      ...(dryRun === undefined ? {} : { dryRun }),
    }));
    return;
  }
  if (subcommandName === "get") {
    const id = args[0];
    if (!id) throw new Error("agents get requires an id");
    await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}`));
    return;
  }
  if (subcommandName === "repo") {
    const id = args[0];
    if (!id) throw new Error(`agents ${subcommandName} requires an id`);
    await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}/repository`));
    return;
  }
  if (subcommandName === "hosted-git") {
    const id = args[0];
    if (!id) throw new Error("agents hosted-git requires an agent id");
    await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}/hosted-git`));
    return;
  }
  throw new Error(`unknown agents command: ${subcommandName}`);
}

async function hostedGit(subcommandName?: string): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    await printJson(await requestJson("GET", "/api/hosted-git/repos"));
    return;
  }
  throw new Error(`unknown hosted-git command: ${subcommandName}`);
}

async function sandboxes(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    const agentId = options.agent;
    const runId = options.run;
    const params = new URLSearchParams();
    if (agentId) params.set("agentId", agentId);
    if (runId) params.set("runId", runId);
    await printJson(await requestJson("GET", withQuery("/api/sandboxes", params)));
    return;
  }
  if (subcommandName === "get") {
    const id = args[0];
    if (!id) throw new Error("sandboxes get requires a sandbox id");
    await printJson(await requestJson("GET", `/api/sandboxes/${encodeURIComponent(id)}`));
    return;
  }
  if (subcommandName === "start") {
    const options = parseOptions(args);
    const agentId = required(options.agent, "--agent");
    await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/sandboxes`));
    return;
  }
  if (subcommandName === "stop-running") {
    const options = parseOptions(args);
    const agentId = options.agent;
    const runId = options.run;
    if (!agentId && !runId) throw new Error("sandboxes stop-running requires --agent or --run");
    await printJson(await requestJson("POST", "/api/sandboxes/stop-running", {
      ...(agentId ? { agentId } : {}),
      ...(runId ? { runId } : {}),
    }));
    return;
  }
  if (subcommandName === "exec") {
    const [sandboxId, ...commandArgs] = args;
    if (!sandboxId) throw new Error("sandboxes exec requires a sandbox id");
    const separatorIndex = commandArgs.indexOf("--");
    const optionArgs = separatorIndex >= 0 ? commandArgs.slice(0, separatorIndex) : [];
    const options = parseOptions(optionArgs);
    const command = separatorIndex >= 0 ? commandArgs.slice(separatorIndex + 1).join(" ") : commandArgs.join(" ");
    if (!command.trim()) throw new Error("sandboxes exec requires a command");
    await printJson(await requestJson("POST", `/api/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
      command,
      ...(options["timeout-ms"] ? { timeoutMs: options["timeout-ms"] } : {}),
    }));
    return;
  }
  if (subcommandName === "stop") {
    const id = args[0];
    if (!id) throw new Error("sandboxes stop requires a sandbox id");
    await printJson(await requestJson("POST", `/api/sandboxes/${encodeURIComponent(id)}/stop`));
    return;
  }
  if (subcommandName === "bootstrap") {
    const id = args[0];
    if (!id) throw new Error("sandboxes bootstrap requires a sandbox id");
    await printJson(await requestJson("POST", `/api/sandboxes/${encodeURIComponent(id)}/bootstrap`));
    return;
  }
  throw new Error(`unknown sandboxes command: ${subcommandName}`);
}

async function runs(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    const agentId = required(options.agent, "--agent");
    await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`));
    return;
  }
  if (subcommandName === "get") {
    const id = args[0];
    if (!id) throw new Error("runs get requires a run id");
    await printJson(await requestJson("GET", `/api/runs/${encodeURIComponent(id)}`));
    return;
  }
  if (subcommandName === "status") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs status requires a run id");
    const options = parseOptions(optionArgs);
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", options.limit);
    await printJson(await requestJson("GET", withQuery(`/api/runs/${encodeURIComponent(id)}/status`, params)));
    return;
  }
  if (subcommandName === "claim") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs claim requires a run id");
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/claim`, {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
    }));
    return;
  }
  if (subcommandName === "requeue") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs requeue requires a run id");
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/requeue`, {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
    }));
    return;
  }
  if (subcommandName === "watch") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs watch requires a run id");
    const options = parseOptions(optionArgs);
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null;
    let polls = 0;
    while (true) {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", options.limit);
      const status = await requestJson("GET", withQuery(`/api/runs/${encodeURIComponent(id)}/status`, params)) as {
        run: { status: string };
      };
      console.log(JSON.stringify(status));
      polls += 1;
      if (["completed", "failed", "stopped"].includes(status.run.status)) return;
      if (maxPolls !== null && polls >= maxPolls) return;
      await sleep(intervalMs);
    }
  }
  if (subcommandName === "backlog") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    await printJson({ agents: await agentBacklog(agentIds) });
    return;
  }
  if (subcommandName === "workers") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const statusFilter = new Set(parseList(options.status ?? "running"));
    const agents = await mapConcurrent(agentIds, 4, async (agentId) => {
      const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
        runs: Array<{ id: string; status: string; worker_id: string | null }>;
      };
      const workerRuns: Record<string, Array<{ id: string; status: string }>> = {};
      const unassigned: Array<{ id: string; status: string }> = [];
      for (const run of listed.runs.filter((item) => statusFilter.has(item.status))) {
        const item = { id: run.id, status: run.status };
        if (!run.worker_id) {
          unassigned.push(item);
          continue;
        }
        workerRuns[run.worker_id] ??= [];
        workerRuns[run.worker_id].push(item);
      }
      return {
        agentId,
        workers: Object.entries(workerRuns).map(([workerId, runs]) => ({ workerId, runs })),
        unassigned,
      };
    });
    await printJson({ agents });
    return;
  }
  if (subcommandName === "recover") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const workerPayload = options["worker-id"] ? { workerId: options["worker-id"] } : undefined;
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const recovered = await recoverStaleRuns(agentIds, workerPayload, concurrency);
    await printJson({ recovered: recovered.map(({ run: _run, ...item }) => item) });
    return;
  }
  if (subcommandName === "supervise") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const workerCount = parsePositiveInteger(options.workers ?? "1", "--workers");
    const workerPrefix = options["worker-prefix"] ?? "worker";
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const before = await agentBacklog(agentIds);
    const recovered = options.recover === "1"
      ? await recoverStaleRuns(agentIds, undefined, concurrency)
      : [];
    const workerArgs = ["--agents", agentIds.join(",")];
    for (const flag of ["limit", "concurrency", "interval-ms", "idle-exit-after", "message", "prompt", "task"]) {
      if (options[flag]) workerArgs.push(`--${flag}`, options[flag]);
    }
    for (const flag of ["bootstrap", "check-runtime", "boot", "finalize", "recover", "until-empty"]) {
      if (options[flag] === "1") workerArgs.push(`--${flag}`);
    }
    if (options.loop === "1" || options["until-empty"] !== "1") workerArgs.push("--loop");
    const session = await startDetachedWorkerSession(
      required(options.session, "--session"),
      workerCount,
      workerPrefix,
      workerArgs,
    );
    await printJson({
      before,
      recovered: recovered.map(({ run: _run, ...item }) => item),
      session,
      after: await agentBacklog(agentIds),
    });
    return;
  }
  if (subcommandName === "sessions") {
    const options = parseOptions(args);
    await printJson({ sessions: await listWorkerSessions(options.session) });
    return;
  }
  if (subcommandName === "session-status") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const statusFilter = new Set(parseList(options.status ?? "planned,running"));
    await printJson(await workerSessionStatus(required(sessionName, "runs session-status <session>"), statusFilter));
    return;
  }
  if (subcommandName === "session-watch") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-watch <session>");
    const statusFilter = new Set(parseList(options.status ?? "planned,running"));
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null;
    let polls = 0;
    while (true) {
      console.log(JSON.stringify({
        observedAt: new Date().toISOString(),
        ...(await workerSessionStatus(requiredSessionName, statusFilter)),
      }));
      polls += 1;
      if (maxPolls !== null && polls >= maxPolls) return;
      await sleep(intervalMs);
    }
  }
  if (subcommandName === "stop-session") {
    const sessionName = required(args[0], "runs stop-session <session>");
    const session = await readWorkerSession(sessionName);
    const stopped = session.workers.map((worker) => {
      const stopped = stopProcessGroup(worker.pid);
      return { workerId: worker.workerId, pid: worker.pid, stopped };
    });
    session.stoppedAt = new Date().toISOString();
    await writeWorkerSession(session);
    await printJson({ session: session.session, stopped });
    return;
  }
  if (subcommandName === "stop-matching") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const statusFilter = new Set(parseList(options.status ?? "planned"));
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const runsToStop: Array<{ agentId: string; id: string; status: string }> = [];
    for (const agentId of agentIds) {
      const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
        runs: Array<{ id: string; status: string }>;
      };
      runsToStop.push(...listed.runs
        .filter((run) => statusFilter.has(run.status))
        .map((run) => ({ agentId, id: run.id, status: run.status })));
    }
    const stopped = await mapConcurrent(runsToStop, concurrency, async (run) => {
      await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/stop`);
      return { agentId: run.agentId, runId: run.id, previousStatus: run.status };
    });
    await printJson({ stopped });
    return;
  }
  if (subcommandName === "monitor") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const statusFilter = options.status ? new Set(parseList(options.status)) : null;
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const agents = [];
      for (const agentId of agentIds) {
        const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
          runs: Array<{ id: string; status: string }>;
        };
        const visibleRuns = statusFilter ? listed.runs.filter((run) => statusFilter.has(run.status)) : listed.runs;
        const runs = await mapConcurrent(visibleRuns, 4, async (run) => {
          const params = new URLSearchParams();
          params.set("limit", options.limit ?? "3");
          const status = await requestJson("GET", withQuery(`/api/runs/${encodeURIComponent(run.id)}/status`, params)) as {
            run: { id: string; status: string; worker_id: string | null };
            sandboxes: Array<{ state: string }>;
            messages: Array<{ type: string; text: string }>;
          };
          return {
            id: status.run.id,
            status: status.run.status,
            workerId: status.run.worker_id,
            sandboxes: status.sandboxes.map((sandbox) => sandbox.state),
            messages: status.messages.map((message) => ({
              type: message.type,
              text: message.text,
            })),
          };
        });
        agents.push({ agentId, runs });
      }
      console.log(JSON.stringify({ agents }));
      if (poll + 1 < maxPolls) await sleep(intervalMs);
    }
    return;
  }
  if (subcommandName === "plan") {
    const options = parseOptions(args);
    const agentId = required(options.agent, "--agent");
    await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, runPlanPayload(options)));
    return;
  }
  if (subcommandName === "queue") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const objectives = await readObjectivesFile(required(options["objectives-file"], "--objectives-file"));
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const queueItems = agentIds.flatMap((agentId) => objectives.map((objective) => ({ agentId, objective })));
    const queued = await mapConcurrent(queueItems, concurrency, async (item) => {
      const planned = await requestJson("POST", `/api/agents/${encodeURIComponent(item.agentId)}/runs`, {
        objective: item.objective,
        ...(options["input-ref"] ? { inputRef: options["input-ref"] } : {}),
        ...(options.prefix ? { prefix: options.prefix } : {}),
      }) as { plan: unknown; run: unknown };
      return { agentId: item.agentId, objective: item.objective, ...planned };
    });
    await printJson({ queued });
    return;
  }
  if (subcommandName === "step") {
    const separatorIndex = args.indexOf("--");
    const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
    const rawCommandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
    const options = parseOptions(optionArgs);
    const command = rawCommandArgs.join(" ");
    if (!command.trim()) throw new Error("runs step requires a command after --");
    const runId = options.run ?? await planRunForStep(options);
    const sandboxResponse = await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/sandbox`, {
      bootstrap: options.bootstrap === "1",
    }) as { sandbox: unknown; bootstrap?: unknown };
    const execResponse = await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/exec`, {
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }) as { result: unknown };
    const finalizeResponse = options.finalize === "1"
      ? await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/finalize`, {
        ...(options.message ? { commitMessage: options.message } : {}),
      }) as { result: unknown }
      : null;
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(runId)}/status`);
    await printJson({
      sandbox: sandboxResponse.sandbox,
      ...(sandboxResponse.bootstrap ? { bootstrap: sandboxResponse.bootstrap } : {}),
      result: execResponse.result,
      ...(finalizeResponse ? { finalized: finalizeResponse.result } : {}),
      status,
    });
    return;
  }
  if (subcommandName === "launch") {
    const options = parseOptions(args);
    const agentIds = parseList(required(options.agents, "--agents"));
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const results = await mapConcurrent(agentIds, concurrency, async (agentId) => {
      const planned = await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, runPlanPayload(options)) as {
        plan: unknown;
        run: { id: string };
      };
      const sandboxed = await requestJson("POST", `/api/runs/${encodeURIComponent(planned.run.id)}/sandbox`, {
        bootstrap: options.bootstrap === "1",
      }) as { sandbox: unknown; bootstrap?: unknown };
      const runtime = options["check-runtime"] === "1"
        ? await requestJson("POST", `/api/runs/${encodeURIComponent(planned.run.id)}/check-runtime`)
        : null;
      const booted = options.boot === "1"
        ? await requestJson("POST", `/api/runs/${encodeURIComponent(planned.run.id)}/boot`, {
          ...(options.prompt ? { promptPath: options.prompt } : {}),
          ...(options.task ? { taskPath: options.task } : {}),
        })
        : null;
      const status = await requestJson("GET", `/api/runs/${encodeURIComponent(planned.run.id)}/status`);
      return {
        agentId,
        run: planned.run,
        plan: planned.plan,
        sandbox: sandboxed.sandbox,
        ...(sandboxed.bootstrap ? { bootstrap: sandboxed.bootstrap } : {}),
        ...(runtime ? { runtime } : {}),
        ...(booted ? { boot: booted } : {}),
        status,
      };
    });
    await printJson({ runs: results });
    return;
  }
  if (subcommandName === "work") {
    const options = parseOptions(args);
    if (options.workers) {
      const workerCount = parsePositiveInteger(options.workers, "--workers");
      const workerPrefix = options["worker-prefix"] ?? options["worker-id"] ?? "worker";
      const workerArgs = args.filter((arg, index) => {
        const previous = args[index - 1];
        return arg !== "--workers"
          && previous !== "--workers"
          && arg !== "--worker-prefix"
          && previous !== "--worker-prefix"
          && arg !== "--worker-id"
          && previous !== "--worker-id"
          && arg !== "--detach"
          && arg !== "--session"
          && previous !== "--session";
      });
      if (options.detach === "1") {
        const session = await startDetachedWorkerSession(
          required(options.session, "--session"),
          workerCount,
          workerPrefix,
          workerArgs,
        );
        await printJson({ session });
        return;
      }
      const workers = await mapConcurrent(Array.from({ length: workerCount }, (_, index) => index + 1), workerCount, async (workerNumber) => {
        const workerId = `${workerPrefix}-${workerNumber}`;
        const result = await runCliWorker(["runs", "work", ...workerArgs, "--worker-id", workerId]);
        return { workerId, ...result };
      });
      await printJson({ workers });
      if (workers.some((worker) => worker.exitCode !== 0)) process.exitCode = 1;
      return;
    }
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const concurrency = parsePositiveInteger(options.concurrency ?? "2", "--concurrency");
    const limit = parsePositiveInteger(options.limit ?? "10", "--limit");
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "5000", "--interval-ms");
    const idleExitAfter = parsePositiveInteger(options["idle-exit-after"] ?? "1", "--idle-exit-after");
    const workerPayload = options["worker-id"] ? { workerId: options["worker-id"] } : undefined;
    const untilEmpty = options["until-empty"] === "1";
    const processed: unknown[] = [];
    const recovered: unknown[] = [];
    let idlePasses = 0;

    do {
      const plannedRuns = [];
      for (const agentId of agentIds) {
        const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
          runs: Array<{ id: string; agent_id: string; status: string }>;
        };
        plannedRuns.push(...listed.runs.filter((run) => run.status === "planned"));
      }
      if (options.recover === "1") {
        const recoveredRuns = await recoverStaleRuns(agentIds, workerPayload, concurrency);
        recovered.push(...recoveredRuns.map(({ run: _run, ...item }) => item));
        plannedRuns.push(...recoveredRuns.flatMap((item) => item.run ? [item.run] : []));
      }
      const batchLimit = untilEmpty ? limit : limit - processed.length;
      const work = plannedRuns.slice(0, batchLimit);
      if (work.length === 0) {
        idlePasses += 1;
        if ((!untilEmpty && options.loop !== "1") || idlePasses >= idleExitAfter) break;
        await sleep(intervalMs);
        continue;
      }
      idlePasses = 0;
      const results = await mapConcurrent(work, concurrency, async (run) => {
        const claimed = await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/claim`, workerPayload, [409]) as {
          ok: boolean;
          run?: { agent_id: string };
          error?: string;
        };
        if (!claimed.run) {
          return {
            agentId: run.agent_id,
            runId: run.id,
            skipped: claimed.error ?? "run was not claimed",
          };
        }
        const sandboxed = await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/sandbox`, {
          bootstrap: options.bootstrap === "1",
        }) as { sandbox: unknown; bootstrap?: unknown };
        const runtime = options["check-runtime"] === "1"
          ? await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/check-runtime`)
          : null;
        const booted = options.boot === "1"
          ? await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/boot`, {
            ...(options.prompt ? { promptPath: options.prompt } : {}),
            ...(options.task ? { taskPath: options.task } : {}),
          })
          : null;
        const finalized = options.finalize === "1"
          ? await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/finalize`, {
            ...(options.message ? { commitMessage: options.message } : {}),
          })
          : null;
        const status = await requestJson("GET", `/api/runs/${encodeURIComponent(run.id)}/status`);
        return {
          agentId: claimed.run.agent_id,
          runId: run.id,
          sandbox: sandboxed.sandbox,
          ...(sandboxed.bootstrap ? { bootstrap: sandboxed.bootstrap } : {}),
          ...(runtime ? { runtime } : {}),
          ...(booted ? { boot: booted } : {}),
          ...(finalized ? { finalized } : {}),
          status,
        };
      });
      processed.push(...results);
    } while ((untilEmpty || options.loop === "1") && (untilEmpty || processed.length < limit));

    await printJson({ processed, recovered, idlePasses });
    return;
  }
  if (subcommandName === "sandbox") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error(`runs ${subcommandName} requires a run id`);
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/sandbox`, {
      bootstrap: options.bootstrap === "1",
    }));
    return;
  }
  if (subcommandName === "restart-sandbox") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs restart-sandbox requires a run id");
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/restart-sandbox`, {
      bootstrap: options.bootstrap === "1",
    }));
    return;
  }
  if (subcommandName === "exec") {
    const [id, ...commandArgs] = args;
    if (!id) throw new Error("runs exec requires a run id");
    const separatorIndex = commandArgs.indexOf("--");
    const optionArgs = separatorIndex >= 0 ? commandArgs.slice(0, separatorIndex) : [];
    const rawCommandArgs = separatorIndex >= 0 ? commandArgs.slice(separatorIndex + 1) : commandArgs;
    const options = parseOptions(optionArgs);
    const command = rawCommandArgs.join(" ");
    if (!command.trim()) throw new Error("runs exec requires a command");
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/exec`, {
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options["timeout-ms"] ? { timeoutMs: options["timeout-ms"] } : {}),
    }));
    return;
  }
  if (subcommandName === "boot") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs boot requires a run id");
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/boot`, {
      ...(options.objective ? { objective: options.objective } : {}),
      ...(options.prompt ? { promptPath: options.prompt } : {}),
      ...(options.task ? { taskPath: options.task } : {}),
    }));
    return;
  }
  if (subcommandName === "check-runtime") {
    const id = args[0];
    if (!id) throw new Error("runs check-runtime requires a run id");
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/check-runtime`));
    return;
  }
  if (subcommandName === "finalize") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs finalize requires a run id");
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/finalize`, {
      ...(options.message ? { commitMessage: options.message } : {}),
    }));
    return;
  }
  if (subcommandName === "stop") {
    const id = args[0];
    if (!id) throw new Error("runs stop requires a run id");
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/stop`));
    return;
  }
  throw new Error(`unknown runs command: ${subcommandName}`);
}

async function heartbeats(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    const params = new URLSearchParams();
    const agentId = options.agent;
    if (agentId) params.set("agentId", agentId);
    await printJson(await requestJson("GET", withQuery("/api/heartbeats", params)));
    return;
  }
  if (subcommandName === "get") {
    const id = args[0];
    if (!id) throw new Error("heartbeats get requires a heartbeat id");
    await printJson(await requestJson("GET", `/api/heartbeats/${encodeURIComponent(id)}`));
    return;
  }
  throw new Error(`unknown heartbeats command: ${subcommandName}`);
}

async function messages(subcommandName?: string, args: string[] = []): Promise<void> {
  const rawArgs = subcommandName ? [subcommandName, ...args] : args;
  const mode = rawArgs[0] === "list" || rawArgs[0] === "listen" ? rawArgs[0] : undefined;
  const options = parseOptions(mode ? rawArgs.slice(1) : rawArgs);
  const params = new URLSearchParams();
  const agentId = options.agent;
  const runId = options.run;
  const sandboxId = options.sandbox;
  if (agentId) params.set("agentId", agentId);
  if (runId) params.set("runId", runId);
  if (sandboxId) params.set("sandboxId", sandboxId);
  if (options.limit) params.set("limit", options.limit);

  if (mode === "listen") {
    const response = await fetch(`${baseUrl}${withQuery("/api/messages/listen", params)}`);
    if (!response.ok || !response.body) throw new Error(`listen failed: ${response.status}`);
    for await (const event of ndjson(response.body)) {
      console.log(JSON.stringify(event));
    }
    return;
  }

  await printJson(await requestJson("GET", withQuery("/api/messages", params)));
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "bootstrap" || key === "boot" || key === "check-runtime" || key === "detach" || key === "finalize" || key === "live" || key === "dry-run" || key === "loop" || key === "recover" || key === "until-empty") {
      options[key] = "1";
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function parseList(value: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) throw new Error("expected at least one value");
  return values;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCliWorker(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...args], {
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
}

async function agentBacklog(agentIds: string[]): Promise<Array<{ agentId: string; total: number; statuses: Record<string, number> }>> {
  return await mapConcurrent(agentIds, 4, async (agentId) => {
    const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
      runs: Array<{ status: string }>;
    };
    const statuses: Record<string, number> = {};
    for (const run of listed.runs) {
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    }
    return { agentId, total: listed.runs.length, statuses };
  });
}

type RecoverStaleRunResult = {
  agentId: string;
  runId: string;
  status?: string;
  skipped?: string;
  run?: { id: string; agent_id: string; status: string };
};

async function recoverStaleRuns(
  agentIds: string[],
  workerPayload: { workerId: string } | undefined,
  concurrency: number,
): Promise<RecoverStaleRunResult[]> {
  const runningRuns = [];
  for (const agentId of agentIds) {
    const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
      runs: Array<{ id: string; agent_id: string; status: string }>;
    };
    runningRuns.push(...listed.runs.filter((run) => run.status === "running"));
  }
  return await mapConcurrent(runningRuns, concurrency, async (run) => {
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(run.id)}/status?limit=1`) as {
      sandboxes: Array<{ state: string }>;
    };
    if (status.sandboxes.some((sandbox) => sandbox.state === "running")) {
      return { agentId: run.agent_id, runId: run.id, skipped: "run has a running sandbox" };
    }
    const requeued = await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/requeue`, workerPayload, [409]) as {
      run?: { id: string; agent_id: string; status: string };
      error?: string;
    };
    if (!requeued.run) {
      return { agentId: run.agent_id, runId: run.id, skipped: requeued.error ?? "run was not requeued" };
    }
    return {
      agentId: requeued.run.agent_id,
      runId: requeued.run.id,
      status: requeued.run.status,
      run: requeued.run,
    };
  });
}

type WorkerSession = {
  session: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  workers: Array<{
    workerId: string;
    pid: number | null;
    stdoutPath: string;
    stderrPath: string;
  }>;
  stoppedAt?: string;
};

async function startDetachedWorkerSession(
  sessionName: string,
  workerCount: number,
  workerPrefix: string,
  workerArgs: string[],
): Promise<WorkerSession> {
  assertSafeSessionName(sessionName);
  await fs.mkdir(workerSessionDir, { recursive: true });
  const sessionPath = workerSessionPath(sessionName);
  await fs.writeFile(sessionPath, "", { encoding: "utf8", flag: "wx" });
  const logDir = path.join(workerSessionDir, sessionName);
  await fs.mkdir(logDir, { recursive: true });
  const session: WorkerSession = {
    session: sessionName,
    baseUrl,
    startedAt: new Date().toISOString(),
    command: ["runs", "work", ...workerArgs],
    workers: [],
  };
  try {
    for (let workerNumber = 1; workerNumber <= workerCount; workerNumber += 1) {
      const workerId = `${workerPrefix}-${workerNumber}`;
      const stdoutPath = path.join(logDir, `${workerId}.out.log`);
      const stderrPath = path.join(logDir, `${workerId}.err.log`);
      const stdout = await fs.open(stdoutPath, "a");
      const stderr = await fs.open(stderrPath, "a");
      const child = spawn("npm", ["run", "--silent", "cli", "--", "runs", "work", ...workerArgs, "--worker-id", workerId], {
        detached: true,
        env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
        stdio: ["ignore", stdout.fd, stderr.fd],
      });
      child.unref();
      await stdout.close();
      await stderr.close();
      session.workers.push({ workerId, pid: child.pid ?? null, stdoutPath, stderrPath });
    }
    await writeWorkerSession(session);
    return session;
  } catch (error) {
    await fs.rm(sessionPath, { force: true });
    throw error;
  }
}

async function listWorkerSessions(sessionName?: string): Promise<Array<WorkerSession & { workers: Array<WorkerSession["workers"][number] & { alive: boolean }> }>> {
  const names = sessionName ? [sessionName] : await listWorkerSessionNames();
  return await Promise.all(names.map(async (name) => {
    const session = await readWorkerSession(name);
    return {
      ...session,
      workers: session.workers.map((worker) => ({ ...worker, alive: processIsAlive(worker.pid) })),
    };
  }));
}

async function workerSessionStatus(sessionName: string, statusFilter: Set<string>): Promise<{
  session: WorkerSession & {
    workers: Array<WorkerSession["workers"][number] & {
      alive: boolean;
      runs: Array<{ agentId: string; id: string; status: string }>;
    }>;
  };
  agents: Array<{
    agentId: string;
    total: number;
    statuses: Record<string, number>;
    unassigned: Array<{ id: string; status: string }>;
    otherWorkers: Array<{ id: string; status: string; workerId: string }>;
  }>;
}> {
  const session = await readWorkerSession(sessionName);
  const agentIds = workerSessionAgentIds(session);
  const workerRuns = new Map(session.workers.map((worker) => [worker.workerId, [] as Array<{ agentId: string; id: string; status: string }>]));
  const agents = await mapConcurrent(agentIds, 4, async (agentId) => {
    const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
      runs: Array<{ id: string; status: string; worker_id: string | null }>;
    };
    const statuses: Record<string, number> = {};
    const unassigned: Array<{ id: string; status: string }> = [];
    const otherWorkers: Array<{ id: string; status: string; workerId: string }> = [];
    for (const run of listed.runs) {
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
      if (!statusFilter.has(run.status)) continue;
      if (!run.worker_id) {
        unassigned.push({ id: run.id, status: run.status });
        continue;
      }
      const sessionRuns = workerRuns.get(run.worker_id);
      if (sessionRuns) {
        sessionRuns.push({ agentId, id: run.id, status: run.status });
        continue;
      }
      otherWorkers.push({ id: run.id, status: run.status, workerId: run.worker_id });
    }
    return { agentId, total: listed.runs.length, statuses, unassigned, otherWorkers };
  });
  return {
    session: {
      ...session,
      workers: session.workers.map((worker) => ({
        ...worker,
        alive: processIsAlive(worker.pid),
        runs: workerRuns.get(worker.workerId) ?? [],
      })),
    },
    agents,
  };
}

function workerSessionAgentIds(session: WorkerSession): string[] {
  const commandArgs = session.command[0] === "runs" && session.command[1] === "work"
    ? session.command.slice(2)
    : session.command;
  const options = parseOptions(commandArgs);
  return parseList(options.agents ?? required(options.agent, "recorded session --agent or --agents"));
}

async function listWorkerSessionNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(workerSessionDir);
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readWorkerSession(sessionName: string): Promise<WorkerSession> {
  assertSafeSessionName(sessionName);
  const text = await fs.readFile(workerSessionPath(sessionName), "utf8");
  return JSON.parse(text) as WorkerSession;
}

async function writeWorkerSession(session: WorkerSession): Promise<void> {
  await fs.writeFile(workerSessionPath(session.session), `${JSON.stringify(session, null, 2)}\n`);
}

function workerSessionPath(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(workerSessionDir, `${sessionName}.json`);
}

function assertSafeSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}

function processIsAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function stopProcessGroup(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function requestJson(method: string, path: string, payload?: unknown, okStatuses: number[] = []): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) as { ok?: boolean; error?: string } : {};
  if ((!response.ok || body.ok === false) && !okStatuses.includes(response.status)) {
    throw new Error(body.error ?? `${method} ${path} failed`);
  }
  return body;
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as Record<string, unknown>;
    }
  }
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function planRunForStep(options: Record<string, string>): Promise<string> {
  const agentId = required(options.agent, "--agent");
  const planned = await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, runPlanPayload(options));
  const run = (planned as { run?: { id?: unknown } }).run;
  if (!run || typeof run.id !== "string") throw new Error("planned run response did not include run.id");
  return run.id;
}

async function readObjectivesFile(filePath: string): Promise<string[]> {
  const text = await fs.readFile(filePath, "utf8");
  const objectives = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (objectives.length === 0) throw new Error("--objectives-file did not contain any objectives");
  return objectives;
}

type AgentTemplateResponse = {
  template: {
    files: Array<{ path: string; content: string }>;
  };
};

function readTemplateResponse(value: unknown): AgentTemplateResponse["template"] {
  const template = (value as AgentTemplateResponse).template;
  if (!template || !Array.isArray(template.files)) {
    throw new Error("template response did not include template files");
  }
  return template;
}

async function materializeTemplate(files: AgentTemplateResponse["template"]["files"], outDir: string): Promise<string[]> {
  const root = path.resolve(outDir);
  const written: string[] = [];
  for (const file of files) {
    if (!isSafeRelativePath(file.path)) throw new Error(`unsafe template path: ${file.path}`);
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
    written.push(file.path);
  }
  return written;
}

function isSafeRelativePath(value: string): boolean {
  return value !== "" && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
}

function runPlanPayload(options: Record<string, string>): Record<string, string> {
  return {
    objective: required(options.objective, "--objective"),
    ...(options["input-ref"] ? { inputRef: options["input-ref"] } : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`threadbeat

Commands:
  health
  preflight
  agents template --name <name> [--id <agent>] [--description "..."] [--out ./agent-repo]
  agents init --name <name> [--id <agent>] [--repo-id <repo>] [--branch main] [--description "..."] [--live|--dry-run]
  agents create --name <name> --repo <url> [--branch main]
  agents list
  agents get <agent>
  agents repo <agent>
  agents hosted-git <agent>
  hosted-git list
  runs list --agent <agent>
  runs get <run>
  runs status <run> [--limit 20]
  runs claim <run> [--worker-id worker-a]
  runs requeue <run> [--worker-id worker-a]
  runs recover --agent <agent>|--agents <agent,agent> [--worker-id worker-a] [--concurrency 4]
  runs watch <run> [--limit 20] [--interval-ms 2000] [--max-polls 10]
  runs backlog --agent <agent>|--agents <agent,agent>
  runs workers --agent <agent>|--agents <agent,agent> [--status running]
  runs sessions [--session <name>]
  runs session-status <name> [--status planned,running]
  runs session-watch <name> [--status planned,running] [--interval-ms 2000] [--max-polls 10]
  runs stop-session <name>
  runs stop-matching --agent <agent>|--agents <agent,agent> [--status planned] [--concurrency 4]
  runs monitor --agent <agent>|--agents <agent,agent> [--status planned,running] [--limit 3] [--interval-ms 2000] [--max-polls 1]
  runs supervise --agent <agent>|--agents <agent,agent> --session <name> [--workers 1] [--worker-prefix worker] [--recover] [--loop|--until-empty]
  runs plan --agent <agent> --objective <objective> [--input-ref main] [--prefix threadbeat/runs]
  runs queue --agent <agent>|--agents <agent,agent> --objectives-file ./tasks.txt [--input-ref main] [--prefix threadbeat/runs] [--concurrency 4]
  runs launch --agents <agent,agent> --objective <objective> [--bootstrap] [--check-runtime] [--boot] [--concurrency 4]
  runs work --agent <agent>|--agents <agent,agent> [--bootstrap] [--check-runtime] [--boot] [--finalize] [--recover] [--worker-id worker-a] [--loop|--until-empty] [--limit 10] [--concurrency 2]
  runs work --agent <agent>|--agents <agent,agent> --workers 3 [--worker-prefix worker] [--until-empty] [--limit 10]
  runs work --agent <agent>|--agents <agent,agent> --workers 3 --detach --session overnight [--worker-prefix worker] [--loop]
  runs step --agent <agent> --objective <objective> [--bootstrap] [--finalize] [--message "Finalize run"] -- <command>
  runs step --run <run> [--bootstrap] [--finalize] [--cwd /workspace/agent] -- <command>
  runs sandbox <run> [--bootstrap]
  runs restart-sandbox <run> [--bootstrap]
  runs exec <run> [--cwd /workspace/agent] [--timeout-ms 120000] -- <command>
  runs boot <run> [--objective "..."] [--prompt .pi/prompts/heartbeat.md] [--task tasks/inbox/run.md]
  runs check-runtime <run>
  runs finalize <run> [--message "Finalize run"]
  runs stop <run>
  sandboxes start --agent <agent>
  sandboxes list [--agent <agent>] [--run <run>]
  sandboxes get <sandbox>
  sandboxes exec <sandbox> [--timeout-ms 120000] -- <command>
  sandboxes stop-running [--agent <agent>] [--run <run>]
  sandboxes stop <sandbox>
  sandboxes bootstrap <sandbox>
  heartbeats list [--agent <agent>]
  heartbeats get <heartbeat>
  messages list [--agent <agent>] [--run <run>] [--sandbox <sandbox>] [--limit 50]
  messages listen [--agent <agent>] [--run <run>] [--sandbox <sandbox>]
`);
}
