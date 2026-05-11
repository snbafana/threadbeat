import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { deriveGitHubLinks } from "../src/gitLinks.js";

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
    const params = new URLSearchParams();
    if (options.status) params.set("status", options.status);
    await printJson(await requestJson("GET", withQuery(`/api/agents/${encodeURIComponent(agentId)}/runs`, params)));
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
  if (subcommandName === "inspect") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs inspect requires a run id");
    const options = parseOptions(optionArgs);
    const params = new URLSearchParams();
    params.set("limit", options.limit ?? "10");
    const status = await requestJson("GET", withQuery(`/api/runs/${encodeURIComponent(id)}/status`, params)) as {
      run: {
        id: string;
        agent_id: string;
        objective: string;
        input_ref: string;
        run_branch: string;
        result_commit: string | null;
        status: string;
        worker_id: string | null;
      };
      sandboxes: Array<{ id: string; state: string; provider_sandbox_id: string | null }>;
      messages: Array<{ id: string; type: string; text: string }>;
    };
    const repository = await requestJson("GET", `/api/agents/${encodeURIComponent(status.run.agent_id)}/repository`) as {
      repository: { repoUrl: string; repoWebUrl: string | null };
    };
    const branchLinks = deriveGitHubLinks(repository.repository.repoUrl, {
      compareBaseRef: status.run.input_ref,
      compareHeadRef: status.run.run_branch,
      treeRef: status.run.run_branch,
    });
    const resultLinks = deriveGitHubLinks(repository.repository.repoUrl, {
      commitRef: status.run.result_commit,
      compareBaseRef: status.run.input_ref,
      compareHeadRef: status.run.result_commit,
      treeRef: status.run.result_commit,
    });
    const checkoutDir = options["checkout-dir"] ?? `./checkouts/${status.run.id}`;
    const checkout = options.checkout === "1"
      ? await checkoutRunBranch(status.run.id, path.resolve(checkoutDir))
      : null;
    await printJson({
      run: {
        id: status.run.id,
        agentId: status.run.agent_id,
        status: status.run.status,
        objective: status.run.objective,
        baseRef: status.run.input_ref,
        branchName: status.run.run_branch,
        resultCommit: status.run.result_commit,
        workerId: status.run.worker_id,
      },
      repository: repository.repository,
      links: {
        repoUrl: branchLinks.repoUrl,
        branchTreeUrl: branchLinks.treeUrl,
        branchCompareUrl: branchLinks.compareUrl,
        resultTreeUrl: resultLinks.treeUrl,
        resultCommitUrl: resultLinks.commitUrl,
        resultCompareUrl: resultLinks.compareUrl,
      },
      commands: {
        checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", status.run.id, "--dir", checkoutDir],
        watchRun: ["npm", "run", "cli", "--", "runs", "watch", status.run.id],
        resumeBranch: status.run.status === "stopped" && status.run.result_commit === null
          ? ["npm", "run", "cli", "--", "runs", "resume-branch", status.run.id]
          : null,
      },
      sandboxes: status.sandboxes.map((sandbox) => ({
        id: sandbox.id,
        state: sandbox.state,
        providerSandboxId: sandbox.provider_sandbox_id,
      })),
      messages: status.messages,
      ...(checkout ? {
        checkout: checkout.checkout,
        review: checkout.review,
      } : {}),
    });
    return;
  }
  if (subcommandName === "checkout") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs checkout requires a run id");
    const options = parseOptions(optionArgs);
    const targetDir = path.resolve(required(options.dir, "--dir"));
    await printJson(await checkoutRunBranch(id, targetDir));
    return;
  }
  if (subcommandName === "review") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs review requires a run id");
    const options = parseOptions(optionArgs);
    const checkoutDir = options["checkout-dir"] ?? `./checkouts/${id}`;
    const reviewed = await checkoutRunBranch(id, path.resolve(checkoutDir));
    const baseRef = `refs/threadbeat/bases/${id}`;
    await printJson({
      run: reviewed.run,
      checkout: reviewed.checkout,
      review: reviewed.review,
      commands: {
        inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", id],
        checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", id, "--dir", checkoutDir],
        changedFiles: ["git", "-C", checkoutDir, "diff", "--name-status", `${baseRef}...HEAD`],
        diff: ["git", "-C", checkoutDir, "diff", `${baseRef}...HEAD`],
        commits: ["git", "-C", checkoutDir, "log", "--oneline", `${baseRef}..HEAD`],
      },
      repository: reviewed.repository,
    });
    return;
  }
  if (subcommandName === "checkout-session") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const session = await readWorkerSession(required(sessionName, "runs checkout-session <session>"));
    const rootDir = path.resolve(required(options.dir, "--dir"));
    const statusList = parseList(options.status ?? (options.resumable === "1" ? "stopped" : "completed,stopped"));
    const statusFilter = new Set(statusList);
    const workerIdFilter = options["worker-id"] ?? null;
    const concurrency = options.concurrency ? parsePositiveInteger(options.concurrency, "--concurrency") : 2;
    const agentIds = workerSessionAgentIds(session);
    const sessionWorkerIds = new Set(session.workers.map((worker) => worker.workerId));
    const runs = (await mapConcurrent(agentIds, 4, async (agentId) => {
      const listed = await requestJson("GET", withQuery(
        `/api/agents/${encodeURIComponent(agentId)}/runs`,
        new URLSearchParams({ status: statusList.join(",") }),
      )) as {
        runs: Array<{ id: string; objective: string; status: string; result_commit: string | null; worker_id: string | null }>;
      };
      return listed.runs
        .filter((run) => statusFilter.has(run.status))
        .filter((run) => workerIdFilter === null || run.worker_id === workerIdFilter)
        .filter((run) => options.resumable !== "1" || (run.status === "stopped" && !run.result_commit))
        .map((run) => ({
          ...run,
          agentId,
          location: run.worker_id === null
            ? "unassigned"
            : sessionWorkerIds.has(run.worker_id)
              ? "session_worker"
              : "other_worker",
        }));
    })).flat();
    const checkouts = await mapConcurrent(runs, concurrency, async (run) => {
      const checkout = await checkoutRunBranch(run.id, path.join(rootDir, run.id));
      return {
        ...checkout,
        run: {
          ...checkout.run,
          agentId: run.agentId,
          objective: run.objective,
          workerId: run.worker_id,
          location: run.location,
        },
      };
    });
    await printJson({
      session: session.session,
      dir: rootDir,
      total: checkouts.length,
      checkouts,
    });
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
  if (subcommandName === "resume-branch") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs resume-branch requires a run id");
    const options = parseOptions(optionArgs);
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(id)}/status?limit=1`) as {
      run: {
        id: string;
        agent_id: string;
        objective: string;
        run_branch: string;
        result_commit: string | null;
        status: string;
        worker_id: string | null;
      };
      sandboxes: Array<{ state: string }>;
    };
    const run = status.run;
    if (run.status !== "stopped" || run.result_commit !== null) {
      throw new Error(`runs resume-branch requires a stopped run without a result commit; ${run.id} is ${run.status}`);
    }
    if (status.sandboxes.some((sandbox) => sandbox.state === "running")) {
      throw new Error(`runs resume-branch cannot resume ${run.id} while it has a running sandbox`);
    }
    const branch = {
      agentId: run.agent_id,
      runId: run.id,
      objective: run.objective,
      branchName: run.run_branch,
      resultCommit: run.result_commit,
      workerId: run.worker_id,
      currentStatus: run.status,
    };
    if (options["dry-run"] === "1") {
      await printJson({ resumable: branch, dryRun: true });
      return;
    }
    const resumed = await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/requeue`, {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
    }) as { run: typeof run };
    await printJson({
      resumed: {
        ...branch,
        status: resumed.run.status,
        workerId: resumed.run.worker_id,
      },
      run: resumed.run,
    });
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
  if (subcommandName === "branches") {
    const options = parseOptions(args);
    if (options.session && (options.agent || options.agents)) {
      throw new Error("runs branches accepts either --session or --agent/--agents");
    }
    const session = options.session ? await readWorkerSession(options.session) : null;
    const sessionWorkerIds = session ? new Set(session.workers.map((worker) => worker.workerId)) : null;
    const workerIdFilter = options["worker-id"] ?? null;
    const agentIds = session
      ? workerSessionAgentIds(session)
      : parseList(options.agents ?? required(options.agent, "--agent, --agents, or --session"));
    const statusList = parseList(options.status ?? (options.resumable === "1" ? "stopped" : "completed,stopped"));
    const statusFilter = new Set(statusList);
    const checkoutCommandRootDir = options["checkout-dir"]
      ?? (options.session ? `./checkouts/${options.session}-branches` : "./checkouts/branches");
    const agents = await mapConcurrent(agentIds, 4, async (agentId) => {
      const [listed, repository] = await Promise.all([
        requestJson("GET", withQuery(
          `/api/agents/${encodeURIComponent(agentId)}/runs`,
          new URLSearchParams({ status: statusList.join(",") }),
        )) as Promise<{
          runs: Array<{
            id: string;
            objective: string;
            input_ref: string;
            run_branch: string;
            result_commit: string | null;
            status: string;
            worker_id: string | null;
          }>;
        }>,
        requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/repository`) as Promise<{
          repository: { repoUrl: string; repoWebUrl: string | null };
        }>,
      ]);
      const runs = listed.runs
        .filter((run) => statusFilter.has(run.status))
        .filter((run) => workerIdFilter === null || run.worker_id === workerIdFilter)
        .filter((run) => options.resumable !== "1" || (run.status === "stopped" && !run.result_commit))
        .map((run) => {
          const branchLinks = deriveGitHubLinks(repository.repository.repoUrl, {
            compareBaseRef: run.input_ref,
            compareHeadRef: run.run_branch,
            treeRef: run.run_branch,
          });
          const resultLinks = deriveGitHubLinks(repository.repository.repoUrl, {
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
            commands: {
              checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${checkoutCommandRootDir}/${run.id}`],
              reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${checkoutCommandRootDir}/${run.id}`],
              inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
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
            ...(sessionWorkerIds ? {
              location: run.worker_id === null
                ? "unassigned"
                : sessionWorkerIds.has(run.worker_id)
                  ? "session_worker"
                  : "other_worker",
            } : {}),
          };
        });
      return {
        agentId,
        repository: {
          repoWebUrl: repository.repository.repoWebUrl,
        },
        summary: {
          total: runs.length,
          resultCommits: runs.filter((run) => run.resultCommit).length,
          resumable: runs.filter((run) => run.state === "resumable").length,
          warnings: runs.filter((run) => run.warning).length,
        },
        runs,
      };
    });
    const visibleRuns = agents.flatMap((agent) => agent.runs.map((run) => ({ agentId: agent.agentId, run })));
    const observedAt = new Date().toISOString();
    const summary = {
      agents: agents.length,
      total: visibleRuns.length,
      resultCommits: visibleRuns.filter(({ run }) => run.resultCommit).length,
      resumable: visibleRuns.filter(({ run }) => run.state === "resumable").length,
      warnings: visibleRuns.filter(({ run }) => run.warning).length,
    };
    if (options.next === "1") {
      await printJson({
        observedAt,
        ...(options.session ? { session: options.session } : {}),
        checkoutDir: checkoutCommandRootDir,
        summary,
        nextSteps: visibleRuns.map(({ agentId, run }) => ({
          action: run.state === "resumable" ? "resume_branch" : "review_branch",
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
          location: run.location ?? null,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          command: run.state === "resumable" && run.commands.resumeBranch
            ? run.commands.resumeBranch
            : run.commands.reviewRun,
          commands: run.commands,
        })),
      });
      return;
    }
    await printJson({
      observedAt,
      ...(options.session ? { session: options.session } : {}),
      checkoutDir: checkoutCommandRootDir,
      summary,
      agents,
    });
    return;
  }
  if (subcommandName === "results") {
    const options = parseOptions(args);
    if (options.session && (options.agent || options.agents)) {
      throw new Error("runs results accepts either --session or --agent/--agents");
    }
    const session = options.session ? await readWorkerSession(options.session) : null;
    const sessionWorkerIds = session ? new Set(session.workers.map((worker) => worker.workerId)) : null;
    const workerIdFilter = options["worker-id"] ?? null;
    const agentIds = session
      ? workerSessionAgentIds(session)
      : parseList(options.agents ?? required(options.agent, "--agent, --agents, or --session"));
    const statusList = parseList(options.status ?? "completed,stopped");
    const statusFilter = new Set(statusList);
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
    const checkoutRootDir = options["checkout-dir"] ? path.resolve(options["checkout-dir"]) : null;
    const checkoutCommandRootDir = options["checkout-dir"]
      ?? (options.session ? `./checkouts/${options.session}-results` : "./checkouts/results");
    const checkoutConcurrency = options["checkout-concurrency"]
      ? parsePositiveInteger(options["checkout-concurrency"], "--checkout-concurrency")
      : 2;
    const changedPathFilter = options["changed-path"] ? new Set(parseList(options["changed-path"])) : null;
    if (options["changed-only"] === "1" && !checkoutRootDir) {
      throw new Error("runs results --changed-only requires --checkout-dir");
    }
    if (changedPathFilter && !checkoutRootDir) {
      throw new Error("runs results --changed-path requires --checkout-dir");
    }
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const agents = await mapConcurrent(agentIds, 4, async (agentId) => {
        const [listed, repository] = await Promise.all([
          requestJson("GET", withQuery(
            `/api/agents/${encodeURIComponent(agentId)}/runs`,
            new URLSearchParams({ status: statusList.join(",") }),
          )) as Promise<{
            runs: Array<{
              id: string;
              objective: string;
              input_ref: string;
              run_branch: string;
              result_commit: string | null;
              status: string;
              worker_id: string | null;
            }>;
          }>,
          requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/repository`) as Promise<{
            repository: { repoUrl: string; repoWebUrl: string | null };
          }>,
        ]);
        const runs = listed.runs
          .filter((run) => statusFilter.has(run.status))
          .filter((run) => workerIdFilter === null || run.worker_id === workerIdFilter)
          .map((run) => {
            const branchLinks = deriveGitHubLinks(repository.repository.repoUrl, {
              compareBaseRef: run.input_ref,
              compareHeadRef: run.run_branch,
              treeRef: run.run_branch,
            });
            const resultLinks = deriveGitHubLinks(repository.repository.repoUrl, {
              commitRef: run.result_commit,
              compareBaseRef: run.input_ref,
              compareHeadRef: run.result_commit,
              treeRef: run.result_commit,
            });
            const warning = run.status === "completed" && !run.result_commit
              ? "completed_without_result_commit"
              : null;
            return {
              id: run.id,
              status: run.status,
              state: run.result_commit ? "result" : run.status === "stopped" ? "resumable" : run.status,
              warning,
              objective: run.objective,
              baseRef: run.input_ref,
              branchName: run.run_branch,
              resultCommit: run.result_commit,
              workerId: run.worker_id,
              commands: {
                checkoutBranch: [
                  "npm",
                  "run",
                  "cli",
                  "--",
                  "runs",
                  "checkout",
                  run.id,
                  "--dir",
                  `${checkoutCommandRootDir}/${run.id}`,
                ],
                reviewRun: [
                  "npm",
                  "run",
                  "cli",
                  "--",
                  "runs",
                  "review",
                  run.id,
                  "--checkout-dir",
                  `${checkoutCommandRootDir}/${run.id}`,
                ],
                inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
              },
              ...(sessionWorkerIds ? {
                location: run.worker_id === null
                  ? "unassigned"
                  : sessionWorkerIds.has(run.worker_id)
                    ? "session_worker"
                    : "other_worker",
              } : {}),
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
        const checkoutByRunId = checkoutRootDir
          ? new Map((await mapConcurrent(runs, checkoutConcurrency, async (run) => (
            [run.id, await checkoutRunBranch(run.id, path.join(checkoutRootDir, run.id))] as const
          ))))
          : null;
        const visibleRuns = checkoutByRunId
          ? runs
            .map((run) => {
              const checkout = checkoutByRunId.get(run.id);
              return {
                ...run,
                checkout: checkout?.checkout,
                review: checkout?.review,
              };
            })
            .filter((run) => options["changed-only"] !== "1"
              || (run.review && (run.review.changedFiles.length > 0 || run.review.commits.length > 0 || run.review.error)))
            .filter((run) => !changedPathFilter
              || (run.review?.changedFiles ?? []).some((file) => changedPathFilter.has(file.path)))
          : runs;
        return {
          agentId,
          repository: {
            repoWebUrl: repository.repository.repoWebUrl,
          },
          summary: {
            total: visibleRuns.length,
            resultCommits: visibleRuns.filter((run) => run.resultCommit).length,
            resumable: visibleRuns.filter((run) => run.state === "resumable").length,
            warnings: visibleRuns.filter((run) => run.warning).length,
          },
          runs: visibleRuns,
        };
      });
      const visibleRuns = agents.flatMap((agent) => agent.runs);
      const changedCount = checkoutRootDir
        ? visibleRuns.filter((run) => {
          const review = (run as { review?: { changedFiles: unknown[]; commits: unknown[]; error?: unknown } }).review;
          return review && (review.changedFiles.length > 0 || review.commits.length > 0 || review.error);
        }).length
        : null;
      const changedFiles = checkoutRootDir
        ? agents.flatMap((agent) => agent.runs.flatMap((run) => {
          const review = (run as { review?: { changedFiles: Array<{ status: string; path: string }> } }).review;
          return (review?.changedFiles ?? []).map((file) => ({
            agentId: agent.agentId,
            runId: run.id,
            status: file.status,
            path: file.path,
            branchName: run.branchName,
            resultCommit: run.resultCommit,
          }));
        }))
        : null;
      const snapshot = {
        observedAt: new Date().toISOString(),
        ...(options.session ? { session: options.session } : {}),
        ...(checkoutRootDir ? { checkoutDir: checkoutRootDir } : {}),
        summary: {
          agents: agents.length,
          total: visibleRuns.length,
          resultCommits: visibleRuns.filter((run) => run.resultCommit).length,
          resumable: visibleRuns.filter((run) => run.state === "resumable").length,
          warnings: visibleRuns.filter((run) => run.warning).length,
          changed: changedCount,
          changedFiles: changedFiles?.length ?? null,
        },
        ...(changedFiles ? { changedFiles } : {}),
        agents,
      };
      const nextSteps = agents.flatMap((agent) => agent.runs.map((run) => {
        const review = (run as typeof run & { review?: { changedFiles: unknown[]; commits: unknown[]; error?: unknown } }).review;
        const hasReviewChange = review
          ? review.changedFiles.length > 0 || review.commits.length > 0 || Boolean(review.error)
          : false;
        return {
          action: hasReviewChange ? "review_changed_result" : "review_result",
          reason: hasReviewChange
            ? "changed_result_branch"
            : run.resultCommit
              ? "result_branch_available"
              : "branch_available",
          agentId: agent.agentId,
          runId: run.id,
          status: run.status,
          state: run.state,
          objective: run.objective,
          workerId: run.workerId,
          location: run.location ?? null,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          changedFiles: review?.changedFiles.length ?? null,
          commits: review?.commits.length ?? null,
          command: run.commands.reviewRun,
          commands: run.commands,
        };
      }));
      const output = options.next === "1"
        ? {
          observedAt: snapshot.observedAt,
          ...(options.session ? { session: options.session } : {}),
          ...(checkoutRootDir ? { checkoutDir: checkoutRootDir } : {}),
          summary: snapshot.summary,
          nextSteps,
        }
        : snapshot;
      if (maxPolls === 1) {
        await printJson(output);
      } else {
        console.log(JSON.stringify(output));
        if (poll + 1 < maxPolls) await sleep(intervalMs);
      }
    }
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
    const recovered = await recoverStaleRuns(
      agentIds,
      workerPayload,
      concurrency,
      undefined,
      options["include-stopped"] === "1",
      options["dry-run"] === "1",
    );
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
      ? await recoverStaleRuns(
        agentIds,
        undefined,
        concurrency,
        undefined,
        options["include-stopped"] === "1",
      )
      : [];
    const workerArgs = ["--agents", agentIds.join(",")];
    for (const flag of ["limit", "concurrency", "interval-ms", "idle-exit-after", "message", "prompt", "task"]) {
      if (options[flag]) workerArgs.push(`--${flag}`, options[flag]);
    }
    for (const flag of ["bootstrap", "check-runtime", "boot", "finalize", "recover", "include-stopped", "resume-stopped", "until-empty"]) {
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
  if (subcommandName === "dispatch") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const objectives = await readObjectivesInput(options);
    const queueConcurrency = parsePositiveInteger(options["queue-concurrency"] ?? options.concurrency ?? "4", "--queue-concurrency");
    const workerCount = parsePositiveInteger(options.workers ?? "1", "--workers");
    const workerPrefix = options["worker-prefix"] ?? "worker";
    const assignment = options.assignment ?? "fanout";
    const queueItems = assignObjectives(agentIds, objectives, assignment);
    const workerArgs = ["--agents", agentIds.join(",")];
    for (const flag of ["limit", "concurrency", "interval-ms", "idle-exit-after", "message", "prompt", "task"]) {
      if (options[flag]) workerArgs.push(`--${flag}`, options[flag]);
    }
    for (const flag of ["bootstrap", "check-runtime", "boot", "finalize", "recover", "include-stopped", "resume-stopped", "until-empty"]) {
      if (options[flag] === "1") workerArgs.push(`--${flag}`);
    }
    if (options.loop === "1" || options["until-empty"] !== "1") workerArgs.push("--loop");
    const sessionName = required(options.session, "--session");
    if (options["dry-run"] === "1") {
      await printJson({
        assignment,
        dryRun: true,
        planned: queueItems,
        session: {
          session: sessionName,
          workerCount,
          workerPrefix,
          command: ["runs", "work", ...workerArgs],
        },
      });
      return;
    }
    const queued = await mapConcurrent(queueItems, queueConcurrency, async (item) => {
      const planned = await requestJson("POST", `/api/agents/${encodeURIComponent(item.agentId)}/runs`, {
        objective: item.objective,
        ...(options["input-ref"] ? { inputRef: options["input-ref"] } : {}),
        ...(options.prefix ? { prefix: options.prefix } : {}),
      }) as { plan: unknown; run: unknown };
      return { agentId: item.agentId, objective: item.objective, ...planned };
    });
    const recovered = options.recover === "1"
      ? await recoverStaleRuns(
        agentIds,
        undefined,
        parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
        undefined,
        options["include-stopped"] === "1",
      )
      : [];
    const session = await startDetachedWorkerSession(
      sessionName,
      workerCount,
      workerPrefix,
      workerArgs,
    );
    await printJson({
      assignment,
      queued,
      ...(options.recover === "1" ? { recovered: recovered.map(({ run: _run, ...item }) => item) } : {}),
      session,
      backlog: await agentBacklog(agentIds),
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
    const statusFilter = new Set(parseList(options.status ?? "planned,running,stopped"));
    const requiredSessionName = required(sessionName, "runs session-status <session>");
    const status = await workerSessionStatus(requiredSessionName, statusFilter);
    const recoveryPreview = options.recoverable === "1"
      ? await recoverableSessionRuns(status, options)
      : null;
    await printJson({
      ...status,
      ...(recoveryPreview ? { recoveryPreview } : {}),
    });
    return;
  }
  if (subcommandName === "session-summary") {
    const sessionName = required(args[0], "runs session-summary <session>");
    const status = await workerSessionStatus(sessionName, new Set(["planned", "running", "stopped"]));
    const agentIds = workerSessionAgentIds(status.session);
    const agents = await mapConcurrent(agentIds, 4, async (agentId) => {
      const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
        runs: Array<{ id: string; status: string; result_commit: string | null }>;
      };
      const statuses: Record<string, number> = {};
      for (const run of listed.runs) {
        statuses[run.status] = (statuses[run.status] ?? 0) + 1;
      }
      return {
        agentId,
        total: listed.runs.length,
        statuses,
        resultCommits: listed.runs.filter((run) => run.result_commit).length,
        resumableStopped: listed.runs.filter((run) => run.status === "stopped" && !run.result_commit).length,
      };
    });
    const totals = {
      runs: agents.reduce((sum, agent) => sum + agent.total, 0),
      resultCommits: agents.reduce((sum, agent) => sum + agent.resultCommits, 0),
      resumableStopped: agents.reduce((sum, agent) => sum + agent.resumableStopped, 0),
      statuses: {} as Record<string, number>,
    };
    for (const agent of agents) {
      for (const [runStatus, count] of Object.entries(agent.statuses)) {
        totals.statuses[runStatus] = (totals.statuses[runStatus] ?? 0) + count;
      }
    }
    const sessionWorkers = status.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
    await printJson({
      observedAt: new Date().toISOString(),
      session: {
        session: status.session.session,
        command: status.session.command,
        startedAt: status.session.startedAt,
        stoppedAt: status.session.stoppedAt ?? null,
        restartedAt: status.session.restartedAt ?? null,
        workers: {
          total: sessionWorkers.length,
          alive: sessionWorkers.filter((worker) => worker.alive).length,
          dead: sessionWorkers.filter((worker) => !worker.alive).length,
        },
      },
      totals,
      agents,
    });
    return;
  }
  if (subcommandName === "session-review") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-review <session>");
    const statusFilter = new Set(parseList(options.status ?? "planned,running,stopped"));
    const status = await workerSessionStatus(requiredSessionName, statusFilter);
    const sessionWorkers = status.session.workers as Array<WorkerSession["workers"][number] & {
      alive: boolean;
      runs: Array<SessionVisibleRun & { agentId: string }>;
    }>;
    const sessionWorkerIds = new Set(sessionWorkers.map((worker) => worker.workerId));
    const resumableBranches = [
      ...sessionWorkers.flatMap((worker) => worker.runs
        .filter((run) => run.status === "stopped" && run.resultCommit === null)
        .map((run) => ({
          agentId: run.agentId,
          runId: run.id,
          objective: run.objective,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          workerId: worker.workerId,
          location: "session_worker",
        }))),
      ...status.agents.flatMap((agent) => [
        ...agent.unassigned
          .filter((run) => run.status === "stopped" && run.resultCommit === null)
          .map((run) => ({
            agentId: agent.agentId,
            runId: run.id,
            objective: run.objective,
            branchName: run.branchName,
            resultCommit: run.resultCommit,
            workerId: null,
            location: "unassigned",
          })),
        ...agent.otherWorkers
          .filter((run) => run.status === "stopped" && run.resultCommit === null)
          .map((run) => ({
            agentId: agent.agentId,
            runId: run.id,
            objective: run.objective,
            branchName: run.branchName,
            resultCommit: run.resultCommit,
            workerId: run.workerId,
            location: "other_worker",
          })),
      ]),
    ].map((run) => {
      const checkoutDir = `./checkouts/${status.session.session}-resumable`;
      return {
        ...run,
        commands: {
          checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.runId, "--dir", `${checkoutDir}/${run.runId}`],
          resumeBranch: ["npm", "run", "cli", "--", "runs", "resume-branch", run.runId],
          resumeSession: run.location === "other_worker"
            ? null
            : [
              "npm",
              "run",
              "cli",
              "--",
              "runs",
              "resume-session",
              status.session.session,
              ...(run.workerId ? ["--worker-id", run.workerId] : []),
            ],
          checkoutSession: run.location === "other_worker"
            ? null
            : [
              "npm",
              "run",
              "cli",
              "--",
              "runs",
              "checkout-session",
              status.session.session,
              "--dir",
              checkoutDir,
              "--resumable",
              ...(run.workerId ? ["--worker-id", run.workerId] : []),
            ],
        },
      };
    });
    const agentIds = workerSessionAgentIds(status.session);
    const recoveryPreview = await recoverStaleRuns(
      agentIds,
      undefined,
      parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
      undefined,
      options["include-stopped"] === "1",
      true,
    );
    const lines = parsePositiveInteger(options.lines ?? "20", "--lines");
    const checkoutRootDir = options["checkout-dir"] ? path.resolve(options["checkout-dir"]) : null;
    const changedPathFilter = options["changed-path"] ? new Set(parseList(options["changed-path"])) : null;
    if (options["changed-only"] === "1" && !checkoutRootDir) {
      throw new Error("runs session-review --changed-only requires --checkout-dir");
    }
    if (changedPathFilter && !checkoutRootDir) {
      throw new Error("runs session-review --changed-path requires --checkout-dir");
    }
    const resultStatusList = parseList(options["result-status"] ?? "completed,stopped");
    const resultStatusFilter = new Set(resultStatusList);
    const resultCheckoutDir = options["checkout-dir"] ?? `./checkouts/${status.session.session}-results`;
    const resultBranches = (await mapConcurrent(agentIds, 4, async (agentId) => {
      const listed = await requestJson("GET", withQuery(
        `/api/agents/${encodeURIComponent(agentId)}/runs`,
        new URLSearchParams({ status: resultStatusList.join(",") }),
      )) as {
        runs: Array<{
          id: string;
          objective: string;
          run_branch: string;
          result_commit: string | null;
          status: string;
          worker_id: string | null;
        }>;
      };
      return listed.runs
        .filter((run) => resultStatusFilter.has(run.status) && run.result_commit !== null)
        .map((run) => ({
          agentId,
          runId: run.id,
          status: run.status,
          objective: run.objective,
          branchName: run.run_branch,
          resultCommit: run.result_commit,
          workerId: run.worker_id,
          location: run.worker_id === null
            ? "unassigned"
            : sessionWorkerIds.has(run.worker_id)
              ? "session_worker"
              : "other_worker",
          commands: {
            checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${resultCheckoutDir}/${run.id}`],
            reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${resultCheckoutDir}/${run.id}`],
            inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
          },
        }));
    })).flat();
    const resultCheckouts = checkoutRootDir
      ? await mapConcurrent(agentIds, 4, async (agentId) => {
        const listed = await requestJson("GET", withQuery(
          `/api/agents/${encodeURIComponent(agentId)}/runs`,
          new URLSearchParams({ status: resultStatusList.join(",") }),
        )) as {
          runs: Array<{ id: string; status: string }>;
        };
        const runs = listed.runs.filter((run) => resultStatusFilter.has(run.status));
        const checkouts = await mapConcurrent(
          runs,
          parsePositiveInteger(options["checkout-concurrency"] ?? "2", "--checkout-concurrency"),
          async (run) => await checkoutRunBranch(run.id, path.join(checkoutRootDir, run.id)),
        );
        const visibleCheckouts = checkouts
          .filter((checkout) => options["changed-only"] !== "1"
            || checkout.review.changedFiles.length > 0
            || checkout.review.commits.length > 0
            || checkout.review.error)
          .filter((checkout) => !changedPathFilter
            || checkout.review.changedFiles.some((file) => changedPathFilter.has(file.path)));
        return { agentId, total: visibleCheckouts.length, checkouts: visibleCheckouts };
      })
      : null;
    const changedResults = resultCheckouts
      ? resultCheckouts.flatMap((agent) => agent.checkouts
        .filter((checkout) => checkout.review.changedFiles.length > 0 || checkout.review.commits.length > 0 || checkout.review.error)
        .map((checkout) => ({
          agentId: agent.agentId,
          runId: checkout.run.id,
          status: checkout.run.status,
          branchName: checkout.run.branchName,
          resultCommit: checkout.run.resultCommit,
          checkoutDir: checkout.checkout.dir,
          changedFiles: checkout.review.changedFiles,
          commits: checkout.review.commits,
          error: checkout.review.error ?? null,
          commands: {
            reviewRun: ["npm", "run", "cli", "--", "runs", "review", checkout.run.id, "--checkout-dir", checkout.checkout.dir],
          },
        })))
      : null;
    const deadWorkerCount = sessionWorkers.filter((worker) => !worker.alive).length;
    const canResumeSession = resumableBranches.some((run) => run.location !== "other_worker");
    const hasRecoverableActiveRun = recoveryPreview.some((item) => item.currentStatus !== "stopped");
    const hasRecoverableStoppedRun = recoveryPreview.some((item) => item.currentStatus === "stopped");
    const restartSessionCommand = deadWorkerCount > 0
      ? ["npm", "run", "cli", "--", "runs", "restart-session", status.session.session, "--recover"]
      : null;
    const restartSessionWithStoppedCommand = deadWorkerCount > 0 && canResumeSession
      ? ["npm", "run", "cli", "--", "runs", "restart-session", status.session.session, "--recover", "--resume-stopped"]
      : null;
    const recoverSessionCommand = hasRecoverableActiveRun
      ? ["npm", "run", "cli", "--", "runs", "recover-session", status.session.session]
      : null;
    const recoverStoppedCommand = hasRecoverableStoppedRun
      ? ["npm", "run", "cli", "--", "runs", "recover-session", status.session.session, "--include-stopped"]
      : null;
    const resumeSessionCommand = canResumeSession
      ? ["npm", "run", "cli", "--", "runs", "resume-session", status.session.session]
      : null;
    const branchQueueCommand = ["npm", "run", "cli", "--", "runs", "branches", "--session", status.session.session, "--next"];
    const changedResultsCommand = [
      "npm",
      "run",
      "cli",
      "--",
      "runs",
      "results",
      "--session",
      status.session.session,
      "--checkout-dir",
      resultCheckoutDir,
      "--changed-only",
      "--next",
    ];
    const shouldReviewChangedResults = changedResults === null
      ? resultBranches.length > 0
      : changedResults.length > 0;
    const recoverableStoppedRunIds = new Set(recoveryPreview
      .filter((run) => run.currentStatus === "stopped" && !run.skipped)
      .map((run) => run.runId));
    const nextSteps = [
      ...(restartSessionWithStoppedCommand ? [{
        action: "restart_session_with_stopped",
        reason: "dead_workers_and_resumable_branches",
        count: deadWorkerCount,
        command: restartSessionWithStoppedCommand,
      }] : []),
      ...(!restartSessionWithStoppedCommand && restartSessionCommand ? [{
        action: "restart_session",
        reason: "dead_workers",
        count: deadWorkerCount,
        command: restartSessionCommand,
      }] : []),
      ...(recoverSessionCommand ? [{
        action: "recover_session",
        reason: "stale_running_claims",
        count: recoveryPreview.filter((run) => run.currentStatus !== "stopped" && !run.skipped).length,
        command: recoverSessionCommand,
      }] : []),
      ...(recoverStoppedCommand ? [{
        action: "recover_stopped",
        reason: "unfinished_stopped_branches",
        count: recoveryPreview.filter((run) => run.currentStatus === "stopped" && !run.skipped).length,
        command: recoverStoppedCommand,
      }] : []),
      ...(resumeSessionCommand ? [{
        action: "resume_session",
        reason: "resumable_branch_runs",
        count: resumableBranches.filter((run) => run.location !== "other_worker").length,
        command: resumeSessionCommand,
      }] : []),
      ...(shouldReviewChangedResults ? [{
        action: "review_changed_results",
        reason: changedResults === null
          ? "result_branches_available"
          : "changed_results_found",
        count: changedResults?.length ?? resultBranches.length,
        command: changedResultsCommand,
      }] : []),
    ];
    const branchNextSteps = [
      ...resumableBranches.map((run) => ({
        action: "resume_branch",
        reason: "stopped_branch_without_result_commit",
        agentId: run.agentId,
        runId: run.runId,
        status: "stopped",
        objective: run.objective,
        workerId: run.workerId,
        location: run.location,
        branchName: run.branchName,
        resultCommit: run.resultCommit,
        recoverable: recoverableStoppedRunIds.has(run.runId),
        command: run.commands.resumeBranch,
        commands: {
          ...run.commands,
          recoverStopped: recoverableStoppedRunIds.has(run.runId) ? recoverStoppedCommand : null,
        },
      })),
      ...resultBranches.map((run) => ({
        action: "review_branch",
        reason: "result_commit_available",
        agentId: run.agentId,
        runId: run.runId,
        status: run.status,
        objective: run.objective,
        workerId: run.workerId,
        location: run.location,
        branchName: run.branchName,
        resultCommit: run.resultCommit,
        command: run.commands.reviewRun,
        commands: run.commands,
      })),
    ];
    const statuses: Record<string, number> = {};
    for (const agent of status.agents) {
      for (const [runStatus, count] of Object.entries(agent.statuses)) {
        statuses[runStatus] = (statuses[runStatus] ?? 0) + count;
      }
    }
    const agentSummaries = status.agents.map((agent) => {
      const agentChangedResults = changedResults?.filter((run) => run.agentId === agent.agentId) ?? null;
      return {
        agentId: agent.agentId,
        total: agent.total,
        statuses: agent.statuses,
        resultBranches: resultBranches.filter((run) => run.agentId === agent.agentId).length,
        resumableBranches: resumableBranches.filter((run) => run.agentId === agent.agentId).length,
        recoveryCandidates: recoveryPreview.filter((run) => run.agentId === agent.agentId && !run.skipped).length,
        changedResults: agentChangedResults?.length ?? null,
        changedFiles: agentChangedResults
          ? agentChangedResults.reduce((sum, run) => sum + run.changedFiles.length, 0)
          : null,
      };
    });
    const summary = {
      agents: status.agents.length,
      runs: status.agents.reduce((sum, agent) => sum + agent.total, 0),
      statuses,
      resultBranches: resultBranches.length,
      resumableBranches: resumableBranches.length,
      recoveryCandidates: recoveryPreview.filter((run) => !run.skipped).length,
      recoverableActive: recoveryPreview.filter((run) => run.currentStatus !== "stopped" && !run.skipped).length,
      recoverableStopped: recoveryPreview.filter((run) => run.currentStatus === "stopped" && !run.skipped).length,
      branchNextSteps: branchNextSteps.length,
      changedResults: changedResults?.length ?? null,
      changedFiles: changedResults
        ? changedResults.reduce((sum, run) => sum + run.changedFiles.length, 0)
        : null,
      agentSummaries,
    };
    const sessionReview = {
      observedAt: new Date().toISOString(),
      session: {
        session: status.session.session,
        command: status.session.command,
        startedAt: status.session.startedAt,
        stoppedAt: status.session.stoppedAt ?? null,
        restartedAt: status.session.restartedAt ?? null,
        workers: {
          total: sessionWorkers.length,
          alive: sessionWorkers.length - deadWorkerCount,
          dead: deadWorkerCount,
        },
      },
      summary,
      agents: status.agents,
      actions: {
        restartSession: restartSessionCommand,
        restartSessionWithStopped: restartSessionWithStoppedCommand,
        recoverSession: recoverSessionCommand,
        recoverStopped: recoverStoppedCommand,
        resumeSession: resumeSessionCommand,
        branchQueue: branchQueueCommand,
        changedResults: changedResultsCommand,
      },
      nextSteps,
      branchNextSteps,
      resumableBranches,
      resultBranches,
      recoveryPreview: recoveryPreview.map(({ run: _run, ...item }) => item),
      ...(checkoutRootDir ? { checkoutDir: checkoutRootDir, changedResults, resultCheckouts } : {}),
      logs: await Promise.all(sessionWorkers.map(async (worker) => ({
        workerId: worker.workerId,
        pid: worker.pid,
        alive: worker.alive,
        stdout: {
          path: worker.stdoutPath,
          lines: await tailFileLines(worker.stdoutPath, lines),
        },
        stderr: {
          path: worker.stderrPath,
          lines: await tailFileLines(worker.stderrPath, lines),
        },
      }))),
    };
    await printJson(options.next === "1"
      ? {
        observedAt: sessionReview.observedAt,
        session: sessionReview.session,
        summary,
        nextSteps,
        branchNextSteps,
      }
      : sessionReview);
    return;
  }
  if (subcommandName === "session-watch") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-watch <session>");
    const statusFilter = new Set(parseList(options.status ?? "planned,running,stopped"));
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null;
    let polls = 0;
    while (true) {
      const status = await workerSessionStatus(requiredSessionName, statusFilter);
      const recoveryPreview = options.recoverable === "1"
        ? await recoverableSessionRuns(status, options)
        : null;
      const observedAt = new Date().toISOString();
      if (options.next === "1") {
        const sessionWorkers = status.session.workers as Array<WorkerSession["workers"][number] & {
          alive: boolean;
          runs: Array<SessionVisibleRun & { agentId: string }>;
        }>;
        const deadWorkerCount = sessionWorkers.filter((worker) => !worker.alive).length;
        const resumableBranches = [
          ...sessionWorkers.flatMap((worker) => worker.runs
            .filter((run) => run.status === "stopped" && run.resultCommit === null)
            .map((run) => ({ runId: run.id, workerId: worker.workerId }))),
          ...status.agents.flatMap((agent) => agent.unassigned
            .filter((run) => run.status === "stopped" && run.resultCommit === null)
            .map((run) => ({ runId: run.id, workerId: null }))),
        ];
        const recoverableActive = recoveryPreview?.filter((run) => run.currentStatus !== "stopped" && !run.skipped).length ?? 0;
        const recoverableStopped = recoveryPreview?.filter((run) => run.currentStatus === "stopped" && !run.skipped).length ?? 0;
        const statuses: Record<string, number> = {};
        for (const agent of status.agents) {
          for (const [runStatus, count] of Object.entries(agent.statuses)) {
            statuses[runStatus] = (statuses[runStatus] ?? 0) + count;
          }
        }
        console.log(JSON.stringify({
          observedAt,
          session: {
            session: status.session.session,
            workers: {
              total: sessionWorkers.length,
              alive: sessionWorkers.length - deadWorkerCount,
              dead: deadWorkerCount,
            },
          },
          summary: {
            agents: status.agents.length,
            runs: status.agents.reduce((sum, agent) => sum + agent.total, 0),
            statuses,
            resumableBranches: resumableBranches.length,
            recoveryCandidates: recoverableActive + recoverableStopped,
          },
          nextSteps: [
            ...(deadWorkerCount > 0 && resumableBranches.length > 0 ? [{
              action: "restart_session_with_stopped",
              reason: "dead_workers_and_resumable_branches",
              count: deadWorkerCount,
              command: ["npm", "run", "cli", "--", "runs", "restart-session", status.session.session, "--recover", "--resume-stopped"],
            }] : []),
            ...(deadWorkerCount > 0 && resumableBranches.length === 0 ? [{
              action: "restart_session",
              reason: "dead_workers",
              count: deadWorkerCount,
              command: ["npm", "run", "cli", "--", "runs", "restart-session", status.session.session, "--recover"],
            }] : []),
            ...(recoverableActive > 0 ? [{
              action: "recover_session",
              reason: "stale_running_claims",
              count: recoverableActive,
              command: ["npm", "run", "cli", "--", "runs", "recover-session", status.session.session],
            }] : []),
            ...(recoverableStopped > 0 ? [{
              action: "recover_stopped",
              reason: "unfinished_stopped_branches",
              count: recoverableStopped,
              command: ["npm", "run", "cli", "--", "runs", "recover-session", status.session.session, "--include-stopped"],
            }] : []),
            ...(resumableBranches.length > 0 ? [{
              action: "resume_session",
              reason: "resumable_branch_runs",
              count: resumableBranches.length,
              command: ["npm", "run", "cli", "--", "runs", "resume-session", status.session.session],
            }] : []),
          ],
        }));
      } else {
        console.log(JSON.stringify({
          observedAt,
          ...status,
          ...(recoveryPreview ? { recoveryPreview } : {}),
        }));
      }
      polls += 1;
      if (maxPolls !== null && polls >= maxPolls) return;
      await sleep(intervalMs);
    }
  }
  if (subcommandName === "session-logs") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const session = await readWorkerSession(required(sessionName, "runs session-logs <session>"));
    const lines = parsePositiveInteger(options.lines ?? "80", "--lines");
    await printJson({
      session: session.session,
      workers: await Promise.all(session.workers.map(async (worker) => ({
        workerId: worker.workerId,
        pid: worker.pid,
        alive: processIsAlive(worker.pid),
        stdout: {
          path: worker.stdoutPath,
          lines: await tailFileLines(worker.stdoutPath, lines),
        },
        stderr: {
          path: worker.stderrPath,
          lines: await tailFileLines(worker.stderrPath, lines),
        },
      }))),
    });
    return;
  }
  if (subcommandName === "stop-session") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const session = await readWorkerSession(required(sessionName, "runs stop-session <session>"));
    const stopped = session.workers.map((worker) => {
      const stopped = stopProcessGroup(worker.pid);
      return { workerId: worker.workerId, pid: worker.pid, stopped };
    });
    session.stoppedAt = new Date().toISOString();
    await writeWorkerSession(session);
    const workerIds = new Set(session.workers.map((worker) => worker.workerId));
    const recovered = options.recover === "1"
      ? await recoverStaleRuns(
        workerSessionAgentIds(session),
        { workerId: session.session },
        parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
        workerIds,
      )
      : [];
    await printJson({
      session: session.session,
      stopped,
      ...(options.recover === "1" ? { recovered: recovered.map(({ run: _run, ...item }) => item) } : {}),
    });
    return;
  }
  if (subcommandName === "recover-session") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const session = await readWorkerSession(required(sessionName, "runs recover-session <session>"));
    const workerIds = new Set(session.workers.map((worker) => worker.workerId));
    const recovered = await recoverStaleRuns(
      workerSessionAgentIds(session),
      { workerId: session.session },
      parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
      workerIds,
      options["include-stopped"] === "1",
      options["dry-run"] === "1",
      options["include-stopped"] === "1",
    );
    await printJson({
      session: session.session,
      recovered: recovered.map(({ run: _run, ...item }) => item),
      ...(options["dry-run"] === "1" ? {} : {
        status: await workerSessionStatus(session.session, new Set(["planned", "running", "stopped"])),
      }),
    });
    return;
  }
  if (subcommandName === "resume-session") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const session = await readWorkerSession(required(sessionName, "runs resume-session <session>"));
    const sessionWorkerIds = new Set(session.workers.map((worker) => worker.workerId));
    const workerIds = options["worker-id"] ? new Set([options["worker-id"]]) : sessionWorkerIds;
    if (options["worker-id"] && !sessionWorkerIds.has(options["worker-id"])) {
      throw new Error(`worker ${options["worker-id"]} is not recorded in session ${session.session}`);
    }
    const includeUnassigned = !options["worker-id"];
    const candidateRuns: Array<{
      id: string;
      agent_id: string;
      objective: string;
      run_branch: string;
      result_commit: string | null;
      status: string;
      worker_id: string | null;
    }> = [];
    for (const agentId of workerSessionAgentIds(session)) {
      const listed = await requestJson("GET", withQuery(
        `/api/agents/${encodeURIComponent(agentId)}/runs`,
        new URLSearchParams({ status: "stopped" }),
      )) as {
        runs: Array<{
          id: string;
          agent_id: string;
          objective: string;
          run_branch: string;
          result_commit: string | null;
          status: string;
          worker_id: string | null;
        }>;
      };
      candidateRuns.push(...listed.runs.filter((run) => (
        run.result_commit === null
        && (run.worker_id === null ? includeUnassigned : workerIds.has(run.worker_id))
      )));
    }
    const operator = { workerId: options["worker-id"] ?? session.session };
    const resumed = await mapConcurrent(
      candidateRuns,
      parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
      async (run) => {
        const item = {
          agentId: run.agent_id,
          runId: run.id,
          objective: run.objective,
          branchName: run.run_branch,
          resultCommit: run.result_commit,
          workerId: run.worker_id,
        };
        if (options["dry-run"] === "1") return { ...item, currentStatus: run.status, dryRun: true };
        const requeued = await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/requeue`, operator, [409]) as {
          run?: { status: string; worker_id: string | null };
          error?: string;
        };
        if (!requeued.run) return { ...item, skipped: requeued.error ?? "run was not resumed" };
        return { ...item, status: requeued.run.status, workerId: requeued.run.worker_id };
      },
    );
    await printJson({
      session: session.session,
      resumed,
      ...(options["dry-run"] === "1" ? {} : {
        status: await workerSessionStatus(session.session, new Set(["planned", "running", "stopped"])),
      }),
    });
    return;
  }
  if (subcommandName === "restart-session") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const session = await readWorkerSession(required(sessionName, "runs restart-session <session>"));
    const workerIds = new Set(session.workers.map((worker) => worker.workerId));
    const recovered = options.recover === "1"
      ? await recoverStaleRuns(
        workerSessionAgentIds(session),
        { workerId: session.session },
        parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
        workerIds,
      )
      : [];
    const commandArgs = session.command[0] === "runs" && session.command[1] === "work"
      ? session.command.slice(2)
      : session.command;
    for (const flag of ["resume-stopped", "no-bootstrap"]) {
      if (options[flag] === "1" && !commandArgs.includes(`--${flag}`)) {
        commandArgs.push(`--${flag}`);
      }
    }
    const restarted = [];
    for (const worker of session.workers) {
      if (processIsAlive(worker.pid)) continue;
      const stdout = await fs.open(worker.stdoutPath, "a");
      const stderr = await fs.open(worker.stderrPath, "a");
      const child = spawn("npm", ["run", "--silent", "cli", "--", "runs", "work", ...commandArgs, "--worker-id", worker.workerId], {
        detached: true,
        env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
        stdio: ["ignore", stdout.fd, stderr.fd],
      });
      child.unref();
      await stdout.close();
      await stderr.close();
      worker.pid = child.pid ?? null;
      restarted.push({ workerId: worker.workerId, pid: worker.pid });
    }
    delete session.stoppedAt;
    session.restartedAt = new Date().toISOString();
    session.command = ["runs", "work", ...commandArgs];
    await writeWorkerSession(session);
    await printJson({
      session: session.session,
      restarted,
      recovered: recovered.map(({ run: _run, ...item }) => item),
      status: await workerSessionStatus(session.session, new Set(["planned", "running", "stopped"])),
    });
    return;
  }
  if (subcommandName === "stop-matching") {
    const options = parseOptions(args);
    const agentIds = parseList(options.agents ?? required(options.agent, "--agent or --agents"));
    const statusList = parseList(options.status ?? "planned");
    const statusFilter = new Set(statusList);
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const runsToStop: Array<{ agentId: string; id: string; status: string }> = [];
    for (const agentId of agentIds) {
      const listed = await requestJson("GET", withQuery(
        `/api/agents/${encodeURIComponent(agentId)}/runs`,
        new URLSearchParams({ status: statusList.join(",") }),
      )) as {
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
    const statusList = options.status ? parseList(options.status) : null;
    const statusFilter = statusList ? new Set(statusList) : null;
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const agents = [];
      for (const agentId of agentIds) {
        const params = new URLSearchParams();
        if (statusList) params.set("status", statusList.join(","));
        const listed = await requestJson("GET", withQuery(`/api/agents/${encodeURIComponent(agentId)}/runs`, params)) as {
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
            resumable: status.run.status === "stopped",
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
      if (options.next === "1") {
        const nextSteps = agents.flatMap((agent) => agent.runs.map((run) => ({
          action: run.status === "planned"
            ? "claim_run"
            : run.status === "running"
              ? "watch_run"
              : run.status === "stopped"
                ? "resume_branch"
                : "inspect_run",
          reason: run.status === "planned"
            ? "queued_run"
            : run.status === "running"
              ? "active_run"
              : run.status === "stopped"
                ? "stopped_branch"
                : "terminal_run",
          agentId: agent.agentId,
          runId: run.id,
          status: run.status,
          workerId: run.workerId,
          command: run.status === "planned"
            ? ["npm", "run", "cli", "--", "runs", "claim", run.id]
            : run.status === "running"
              ? ["npm", "run", "cli", "--", "runs", "watch", run.id]
              : run.status === "stopped"
                ? ["npm", "run", "cli", "--", "runs", "resume-branch", run.id]
                : ["npm", "run", "cli", "--", "runs", "inspect", run.id],
        })));
        const statuses: Record<string, number> = {};
        for (const agent of agents) {
          for (const run of agent.runs) {
            statuses[run.status] = (statuses[run.status] ?? 0) + 1;
          }
        }
        console.log(JSON.stringify({
          observedAt: new Date().toISOString(),
          summary: {
            agents: agents.length,
            runs: nextSteps.length,
            statuses,
          },
          nextSteps,
        }));
      } else {
        console.log(JSON.stringify({ agents }));
      }
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
    const objectives = await readObjectivesInput(options);
    const concurrency = parsePositiveInteger(options.concurrency ?? "4", "--concurrency");
    const assignment = options.assignment ?? "fanout";
    const queueItems = assignObjectives(agentIds, objectives, assignment);
    if (options["dry-run"] === "1") {
      await printJson({ assignment, dryRun: true, planned: queueItems });
      return;
    }
    const queued = await mapConcurrent(queueItems, concurrency, async (item) => {
      const planned = await requestJson("POST", `/api/agents/${encodeURIComponent(item.agentId)}/runs`, {
        objective: item.objective,
        ...(options["input-ref"] ? { inputRef: options["input-ref"] } : {}),
        ...(options.prefix ? { prefix: options.prefix } : {}),
      }) as { plan: unknown; run: unknown };
      return { agentId: item.agentId, objective: item.objective, ...planned };
    });
    await printJson({ assignment, queued });
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
      const workRuns = [];
      const plannedRuns = [];
      for (const agentId of agentIds) {
        const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
          runs: Array<{ id: string; agent_id: string; status: string; worker_id: string | null; result_commit: string | null }>;
        };
        if (options["resume-stopped"] === "1" && !(options.recover === "1" && options["include-stopped"] === "1")) {
          workRuns.push(...listed.runs.filter((run) => (
            run.status === "stopped"
            && run.result_commit === null
            && (run.worker_id === null || run.worker_id === workerPayload?.workerId)
          )));
        }
        plannedRuns.push(...listed.runs.filter((run) => run.status === "planned"));
      }
      if (options.recover === "1") {
        const recoveredRuns = await recoverStaleRuns(
          agentIds,
          workerPayload,
          concurrency,
          undefined,
          options["include-stopped"] === "1",
          false,
          options["include-stopped"] === "1",
        );
        recovered.push(...recoveredRuns.map(({ run: _run, ...item }) => item));
        workRuns.push(...recoveredRuns.flatMap((item) => item.run ? [item.run] : []));
      }
      workRuns.push(...plannedRuns);
      const batchLimit = untilEmpty ? limit : limit - processed.length;
      const work = workRuns.slice(0, batchLimit);
      if (work.length === 0) {
        idlePasses += 1;
        if ((!untilEmpty && options.loop !== "1") || idlePasses >= idleExitAfter) break;
        await sleep(intervalMs);
        continue;
      }
      idlePasses = 0;
      const results = await mapConcurrent(work, concurrency, async (run) => {
        let agentId = run.agent_id;
        if (run.status === "planned") {
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
          agentId = claimed.run.agent_id;
        }
        const sandboxed = await resumeRunSandbox(run.id, {
          bootstrap: options.bootstrap === "1" || (run.status === "stopped" && options["no-bootstrap"] !== "1"),
          allowRestart: run.status === "stopped",
        });
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
        const status = await requestJson("GET", `/api/runs/${encodeURIComponent(run.id)}/status`) as {
          run: {
            status: string;
            input_ref: string;
            run_branch: string;
            result_commit: string | null;
          };
        };
        return {
          agentId,
          runId: run.id,
          action: sandboxed.action,
          branch: {
            baseRef: status.run.input_ref,
            branchName: status.run.run_branch,
            resultCommit: status.run.result_commit,
            status: status.run.status,
          },
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
  if (subcommandName === "resume") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs resume requires a run id");
    const options = parseOptions(optionArgs);
    const sandboxed = await resumeRunSandbox(id, { bootstrap: options["no-bootstrap"] !== "1" });
    const runtime = options["check-runtime"] === "1"
      ? await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/check-runtime`)
      : null;
    const booted = options.boot === "1"
      ? await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/boot`, {
        ...(options.objective ? { objective: options.objective } : {}),
        ...(options.prompt ? { promptPath: options.prompt } : {}),
        ...(options.task ? { taskPath: options.task } : {}),
      })
      : null;
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(id)}/status?limit=5`) as {
      run: { id: string; status: string; run_branch: string; result_commit: string | null };
    };
    await printJson({
      action: sandboxed.action,
      run: {
        id: status.run.id,
        status: status.run.status,
        branchName: status.run.run_branch,
        resultCommit: status.run.result_commit,
      },
      sandbox: sandboxed.sandbox,
      ...(sandboxed.bootstrap ? { bootstrap: sandboxed.bootstrap } : {}),
      ...(runtime ? { runtime } : {}),
      ...(booted ? { boot: booted } : {}),
      status,
    });
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
    if (key === "bootstrap" || key === "boot" || key === "changed-only" || key === "check-runtime" || key === "checkout" || key === "detach" || key === "finalize" || key === "include-stopped" || key === "live" || key === "dry-run" || key === "loop" || key === "next" || key === "no-bootstrap" || key === "recover" || key === "recoverable" || key === "resumable" || key === "resume-stopped" || key === "until-empty") {
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

async function resumeRunSandbox(
  runId: string,
  input: { bootstrap: boolean; allowRestart?: boolean },
): Promise<{ action: "existing" | "started" | "restarted"; sandbox: unknown; bootstrap?: unknown }> {
  const initialStatus = await requestJson("GET", `/api/runs/${encodeURIComponent(runId)}/status?limit=5`) as {
    run: { status: string };
    sandboxes: Array<{ id: string; state: string }>;
  };
  if (initialStatus.run.status === "completed" || initialStatus.run.status === "failed") {
    throw new Error(`run is already ${initialStatus.run.status}`);
  }
  const runningSandbox = initialStatus.sandboxes.find((sandbox) => sandbox.state === "running");
  if (runningSandbox) return { action: "existing", sandbox: runningSandbox };
  const restartableSandbox = initialStatus.sandboxes.find((sandbox) => sandbox.state === "stopped" || sandbox.state === "failed");
  if (restartableSandbox) {
    if (input.allowRestart === false) {
      throw new Error(`run sandbox is already ${restartableSandbox.state}`);
    }
    const restarted = await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/restart-sandbox`, {
      bootstrap: input.bootstrap,
    }) as { sandbox: unknown; bootstrap?: unknown };
    return { action: "restarted", ...restarted };
  }
  if (initialStatus.sandboxes.length === 0) {
    const started = await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/sandbox`, {
      bootstrap: input.bootstrap,
    }) as { sandbox: unknown; bootstrap?: unknown };
    return { action: "started", ...started };
  }
  throw new Error(`run sandbox cannot resume from ${initialStatus.sandboxes.map((sandbox) => sandbox.state).join(", ")}`);
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

async function git(args: string[], cwd = process.cwd()): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
      reject(new Error(`git ${redactSecretUrl(args).join(" ")} failed: ${redactSecretUrlText(detail)}`));
    });
  });
}

async function checkoutRunBranch(id: string, targetDir: string) {
  const status = await requestJson("GET", `/api/runs/${encodeURIComponent(id)}/status?limit=1`) as {
    run: {
      id: string;
      agent_id: string;
      input_ref: string;
      run_branch: string;
      result_commit: string | null;
      status: string;
    };
  };
  const repository = await requestJson("GET", `/api/agents/${encodeURIComponent(status.run.agent_id)}/repository`) as {
    repository: { repoUrl: string; repoWebUrl: string | null };
  };
  const existed = await pathExists(targetDir);
  if (existed && !(await pathExists(path.join(targetDir, ".git")))) {
    throw new Error(`${targetDir} exists but is not a git checkout`);
  }
  if (!existed) {
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await git(["clone", "--no-checkout", "--", repository.repository.repoUrl, targetDir]);
  }
  await git(["fetch", "origin", `${status.run.run_branch}:refs/remotes/origin/${status.run.run_branch}`], targetDir);
  await git(["checkout", "-B", status.run.run_branch, `refs/remotes/origin/${status.run.run_branch}`], targetDir);
  const headCommit = (await git(["rev-parse", "HEAD"], targetDir)).trim();
  const reviewBaseRef = `refs/threadbeat/bases/${status.run.id}`;
  let review: {
    baseRef: string;
    baseCommit: string | null;
    headCommit: string;
    changedFiles: Array<{ status: string; path: string }>;
    commits: Array<{ sha: string; subject: string }>;
    error?: string;
  };
  try {
    await git(["fetch", "origin", `+${status.run.input_ref}:${reviewBaseRef}`], targetDir);
    const baseCommit = (await git(["rev-parse", reviewBaseRef], targetDir)).trim();
    const changedOutput = (await git(["diff", "--name-status", `${reviewBaseRef}...HEAD`], targetDir)).trim();
    const commitOutput = (await git(["log", "--format=%H%x09%s", `${reviewBaseRef}..HEAD`], targetDir)).trim();
    review = {
      baseRef: status.run.input_ref,
      baseCommit,
      headCommit,
      changedFiles: changedOutput
        ? changedOutput.split("\n").map((line) => {
          const [fileStatus, ...filePath] = line.split("\t");
          return { status: fileStatus, path: filePath.join("\t") };
        })
        : [],
      commits: commitOutput
        ? commitOutput.split("\n").map((line) => {
          const [sha, ...subject] = line.split("\t");
          return { sha, subject: subject.join("\t") };
        })
        : [],
    };
  } catch (error) {
    review = {
      baseRef: status.run.input_ref,
      baseCommit: null,
      headCommit,
      changedFiles: [],
      commits: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  return {
    run: {
      id: status.run.id,
      agentId: status.run.agent_id,
      status: status.run.status,
      baseRef: status.run.input_ref,
      branchName: status.run.run_branch,
      resultCommit: status.run.result_commit,
    },
    checkout: {
      dir: targetDir,
      created: !existed,
      branchName: status.run.run_branch,
      headCommit,
      matchesResultCommit: status.run.result_commit ? headCommit === status.run.result_commit : null,
    },
    review,
    repository: {
      repoWebUrl: repository.repository.repoWebUrl,
    },
  };
}

async function agentBacklog(agentIds: string[]): Promise<Array<{ agentId: string; total: number; statuses: Record<string, number>; resumableStopped: number }>> {
  return await mapConcurrent(agentIds, 4, async (agentId) => {
    const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
      runs: Array<{ status: string }>;
    };
    const statuses: Record<string, number> = {};
    for (const run of listed.runs) {
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
    }
    return { agentId, total: listed.runs.length, statuses, resumableStopped: statuses.stopped ?? 0 };
  });
}

type RecoverStaleRunResult = {
  agentId: string;
  runId: string;
  objective: string;
  branchName: string;
  resultCommit: string | null;
  workerId: string | null;
  status?: string;
  currentStatus?: string;
  dryRun?: boolean;
  skipped?: string;
  run?: { id: string; agent_id: string; status: string };
};

async function recoverStaleRuns(
  agentIds: string[],
  workerPayload: { workerId: string } | undefined,
  concurrency: number,
  workerIds?: Set<string>,
  includeStopped = false,
  dryRun = false,
  includeUnassignedStopped = false,
): Promise<RecoverStaleRunResult[]> {
  const candidateStatuses = includeStopped ? "running,stopped" : "running";
  const candidateRuns: Array<{
    id: string;
    agent_id: string;
    objective: string;
    run_branch: string;
    status: string;
    worker_id: string | null;
    result_commit: string | null;
  }> = [];
  for (const agentId of agentIds) {
    const listed = await requestJson("GET", withQuery(
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      new URLSearchParams({ status: candidateStatuses }),
    )) as {
      runs: Array<{
        id: string;
        agent_id: string;
        objective: string;
        run_branch: string;
        status: string;
        worker_id: string | null;
        result_commit: string | null;
      }>;
    };
    candidateRuns.push(...listed.runs.filter((run) => {
      const matchesWorker = !workerIds || (run.worker_id !== null && workerIds.has(run.worker_id));
      const isStoppedBranch = includeStopped && run.status === "stopped" && run.result_commit === null;
      const isUnassignedStoppedBranch = includeUnassignedStopped && run.worker_id === null && isStoppedBranch;
      return (matchesWorker || isUnassignedStoppedBranch) && (run.status === "running" || isStoppedBranch);
    }));
  }
  return await mapConcurrent(candidateRuns, concurrency, async (run) => {
    const runDetails = {
      agentId: run.agent_id,
      runId: run.id,
      objective: run.objective,
      branchName: run.run_branch,
      resultCommit: run.result_commit,
      workerId: run.worker_id,
    };
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(run.id)}/status?limit=1`) as {
      sandboxes: Array<{ state: string }>;
    };
    if (status.sandboxes.some((sandbox) => sandbox.state === "running")) {
      return { ...runDetails, skipped: "run has a running sandbox" };
    }
    if (dryRun) {
      return { ...runDetails, currentStatus: run.status, dryRun: true };
    }
    const requeued = await requestJson("POST", `/api/runs/${encodeURIComponent(run.id)}/requeue`, workerPayload, [409]) as {
      run?: {
        id: string;
        agent_id: string;
        objective: string;
        run_branch: string;
        result_commit: string | null;
        status: string;
        worker_id: string | null;
      };
      error?: string;
    };
    if (!requeued.run) {
      return { ...runDetails, skipped: requeued.error ?? "run was not requeued" };
    }
    return {
      agentId: requeued.run.agent_id,
      runId: requeued.run.id,
      objective: requeued.run.objective,
      branchName: requeued.run.run_branch,
      resultCommit: requeued.run.result_commit,
      workerId: requeued.run.worker_id,
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
  restartedAt?: string;
};

type SessionVisibleRun = {
  id: string;
  status: string;
  objective: string;
  branchName: string;
  resultCommit: string | null;
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
      runs: Array<SessionVisibleRun & { agentId: string }>;
    }>;
  };
  agents: Array<{
    agentId: string;
    total: number;
    statuses: Record<string, number>;
    resumableStopped: number;
    unassigned: SessionVisibleRun[];
    otherWorkers: Array<SessionVisibleRun & { workerId: string }>;
  }>;
}> {
  const session = await readWorkerSession(sessionName);
  const agentIds = workerSessionAgentIds(session);
  const workerRuns = new Map(session.workers.map((worker) => [
    worker.workerId,
    [] as Array<SessionVisibleRun & { agentId: string }>,
  ]));
  const agents = await mapConcurrent(agentIds, 4, async (agentId) => {
    const listed = await requestJson("GET", `/api/agents/${encodeURIComponent(agentId)}/runs`) as {
      runs: Array<{
        id: string;
        objective: string;
        run_branch: string;
        result_commit: string | null;
        status: string;
        worker_id: string | null;
      }>;
    };
    const statuses: Record<string, number> = {};
    let resumableStopped = 0;
    const unassigned: SessionVisibleRun[] = [];
    const otherWorkers: Array<SessionVisibleRun & { workerId: string }> = [];
    for (const run of listed.runs) {
      statuses[run.status] = (statuses[run.status] ?? 0) + 1;
      if (run.status === "stopped") resumableStopped += 1;
      if (!statusFilter.has(run.status)) continue;
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
    return { agentId, total: listed.runs.length, statuses, resumableStopped, unassigned, otherWorkers };
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

async function recoverableSessionRuns(
  status: Awaited<ReturnType<typeof workerSessionStatus>>,
  options: Record<string, string>,
): Promise<Array<Omit<RecoverStaleRunResult, "run">>> {
  const workerIds = new Set(status.session.workers.map((worker) => worker.workerId));
  const preview = await recoverStaleRuns(
    workerSessionAgentIds(status.session),
    undefined,
    parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
    workerIds,
    options["include-stopped"] === "1",
    true,
    options["include-stopped"] === "1",
  );
  return preview.map(({ run: _run, ...item }) => item);
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

async function tailFileLines(filePath: string, lineCount: number): Promise<string[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-lineCount);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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

async function readObjectivesInput(options: Record<string, string>): Promise<string[]> {
  if (options["objectives-file"] && options.objective) {
    throw new Error("use either --objectives-file or --objective, not both");
  }
  if (options.objective) return parseObjectivesText(options.objective, "--objective");
  return await readObjectivesFile(required(options["objectives-file"], "--objectives-file or --objective"));
}

async function readObjectivesFile(filePath: string): Promise<string[]> {
  return parseObjectivesText(await fs.readFile(filePath, "utf8"), "--objectives-file");
}

function parseObjectivesText(text: string, source: string): string[] {
  const objectives = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (objectives.length === 0) throw new Error(`${source} did not contain any objectives`);
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function redactSecretUrl(args: string[]): string[] {
  return args.map(redactSecretUrlText);
}

function redactSecretUrlText(value: string): string {
  return value.replace(/:\/\/([^:@/]+):([^@/]+)@/g, "://$1:REDACTED@");
}

function runPlanPayload(options: Record<string, string>): Record<string, string> {
  return {
    objective: required(options.objective, "--objective"),
    ...(options["input-ref"] ? { inputRef: options["input-ref"] } : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
  };
}

function assignObjectives(
  agentIds: string[],
  objectives: string[],
  assignment: string,
): Array<{ agentId: string; objective: string }> {
  if (assignment === "fanout") {
    return agentIds.flatMap((agentId) => objectives.map((objective) => ({ agentId, objective })));
  }
  if (assignment === "round-robin") {
    return objectives.map((objective, index) => ({
      agentId: agentIds[index % agentIds.length],
      objective,
    }));
  }
  throw new Error("--assignment must be fanout or round-robin");
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
  runs list --agent <agent> [--status planned,running,completed,stopped,failed]
  runs get <run>
  runs status <run> [--limit 20]
  runs inspect <run> [--limit 10] [--checkout] [--checkout-dir ./checkouts/run]
  runs checkout <run> --dir ./checkouts/run
  runs review <run> [--checkout-dir ./checkouts/run]
  runs checkout-session <name> --dir ./checkouts [--status completed,stopped] [--resumable] [--worker-id worker-a] [--concurrency 2]
  runs claim <run> [--worker-id worker-a]
  runs requeue <run> [--worker-id worker-a]
  runs resume-branch <run> [--dry-run] [--worker-id worker-a]
  runs recover --agent <agent>|--agents <agent,agent> [--include-stopped] [--dry-run] [--worker-id worker-a] [--concurrency 4]
  runs watch <run> [--limit 20] [--interval-ms 2000] [--max-polls 10]
  runs backlog --agent <agent>|--agents <agent,agent>
  runs branches --agent <agent>|--agents <agent,agent>|--session <name> [--status completed,stopped] [--resumable] [--worker-id worker-a] [--checkout-dir ./checkouts] [--next]
  runs results --agent <agent>|--agents <agent,agent>|--session <name> [--status completed,stopped] [--worker-id worker-a] [--checkout-dir ./checkouts] [--changed-only] [--changed-path path[,path]] [--next] [--interval-ms 2000] [--max-polls 1]
  runs workers --agent <agent>|--agents <agent,agent> [--status running]
  runs sessions [--session <name>]
  runs session-status <name> [--status planned,running,stopped]
  runs session-summary <name>
  runs session-review <name> [--include-stopped] [--next] [--checkout-dir ./checkouts] [--changed-only] [--changed-path path[,path]] [--lines 20] [--status planned,running,stopped]
  runs session-watch <name> [--status planned,running,stopped] [--recoverable] [--include-stopped] [--next] [--interval-ms 2000] [--max-polls 10]
  runs session-logs <name> [--lines 80]
  runs stop-session <name> [--recover] [--concurrency 4]
  runs recover-session <name> [--include-stopped] [--dry-run] [--concurrency 4]
  runs resume-session <name> [--worker-id worker-a] [--dry-run] [--concurrency 4]
  runs restart-session <name> [--recover] [--resume-stopped] [--no-bootstrap] [--concurrency 4]
  runs stop-matching --agent <agent>|--agents <agent,agent> [--status planned] [--concurrency 4]
  runs monitor --agent <agent>|--agents <agent,agent> [--status planned,running,stopped] [--next] [--limit 3] [--interval-ms 2000] [--max-polls 1]
  runs supervise --agent <agent>|--agents <agent,agent> --session <name> [--workers 1] [--worker-prefix worker] [--recover] [--include-stopped] [--resume-stopped] [--loop|--until-empty]
  runs dispatch --agents <agent,agent> (--objectives-file ./tasks.txt|--objective "task") --session <name> [--assignment fanout|round-robin] [--dry-run] [--workers 1] [--worker-prefix worker] [--bootstrap] [--boot] [--recover] [--include-stopped]
  runs plan --agent <agent> --objective <objective> [--input-ref main] [--prefix threadbeat/runs]
  runs queue --agent <agent>|--agents <agent,agent> (--objectives-file ./tasks.txt|--objective "task") [--assignment fanout|round-robin] [--dry-run] [--input-ref main] [--prefix threadbeat/runs] [--concurrency 4]
  runs launch --agents <agent,agent> --objective <objective> [--bootstrap] [--check-runtime] [--boot] [--concurrency 4]
  runs work --agent <agent>|--agents <agent,agent> [--bootstrap] [--check-runtime] [--boot] [--finalize] [--recover] [--resume-stopped] [--worker-id worker-a] [--loop|--until-empty] [--limit 10] [--concurrency 2]
  runs work --agent <agent>|--agents <agent,agent> --workers 3 [--worker-prefix worker] [--until-empty] [--limit 10]
  runs work --agent <agent>|--agents <agent,agent> --workers 3 --detach --session overnight [--worker-prefix worker] [--loop]
  runs step --agent <agent> --objective <objective> [--bootstrap] [--finalize] [--message "Finalize run"] -- <command>
  runs step --run <run> [--bootstrap] [--finalize] [--cwd /workspace/agent] -- <command>
  runs sandbox <run> [--bootstrap]
  runs restart-sandbox <run> [--bootstrap]
  runs resume <run> [--no-bootstrap] [--check-runtime] [--boot]
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
