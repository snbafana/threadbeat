import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { deriveGitHubLinks } from "../src/gitLinks.js";
import { listWorkerSessionBranchRecoveryExecutionRecords } from "../src/workerSessionBranchRecovery.js";
import { summarizeWorkerSessionControlPlaneTickDecision } from "../src/workerSessionControlPlaneTicks.js";

const baseUrl = normalizeBaseUrl(process.env.THREADBEAT_BASE_URL ?? "http://127.0.0.1:8000");
const workerSessionDir = path.join(process.cwd(), ".threadbeat", "worker-sessions");
const STALE_RUNNING_DRAIN_CONTINUATION_MS = 10 * 60 * 1000;

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
        reviewRun: ["npm", "run", "cli", "--", "runs", "review", status.run.id, "--checkout-dir", checkoutDir],
        inspectResult: ["npm", "run", "cli", "--", "runs", "inspect-result", status.run.id, "--checkout-dir", checkoutDir],
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
  if (subcommandName === "inspect-result") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs inspect-result requires a run id");
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      await printJson(await requestJson("GET", `/api/runs/${encodeURIComponent(id)}/result-inspection`));
      return;
    }
    const checkoutDir = options["checkout-dir"] ?? `./checkouts/${id}-result`;
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(id)}/status?limit=1`) as {
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
    };
    const repository = await requestJson("GET", `/api/agents/${encodeURIComponent(status.run.agent_id)}/repository`) as {
      repository: { repoUrl: string; repoWebUrl: string | null };
    };
    const resultLinks = deriveGitHubLinks(repository.repository.repoUrl, {
      commitRef: status.run.result_commit,
      compareBaseRef: status.run.input_ref,
      compareHeadRef: status.run.result_commit,
      treeRef: status.run.result_commit,
    });
    const commands = {
      inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", id],
      checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", id, "--dir", checkoutDir],
      reviewRun: ["npm", "run", "cli", "--", "runs", "review", id, "--checkout-dir", checkoutDir],
      inspectResult: ["npm", "run", "cli", "--", "runs", "inspect-result", id, "--checkout-dir", checkoutDir],
      resumeBranch: status.run.status === "stopped" && status.run.result_commit === null
        ? ["npm", "run", "cli", "--", "runs", "resume-branch", id]
        : null,
      showCommit: status.run.result_commit
        ? ["git", "-C", checkoutDir, "show", "--stat", "--oneline", status.run.result_commit]
        : null,
      changedFiles: status.run.result_commit
        ? ["git", "-C", checkoutDir, "diff", "--name-status", `refs/threadbeat/bases/${id}...${status.run.result_commit}`]
        : null,
      diff: status.run.result_commit
        ? ["git", "-C", checkoutDir, "diff", `refs/threadbeat/bases/${id}...${status.run.result_commit}`]
        : null,
    };
    if (!status.run.result_commit) {
      await printJson({
        run: {
          id: status.run.id,
          agentId: status.run.agent_id,
          status: status.run.status,
          objective: status.run.objective,
          baseRef: status.run.input_ref,
          branchName: status.run.run_branch,
          resultCommit: null,
          workerId: status.run.worker_id,
        },
        repository: repository.repository,
        result: {
          available: false,
          reason: status.run.status === "stopped"
            ? "stopped_branch_without_result_commit"
            : "result_commit_not_recorded",
        },
        commands,
      });
      return;
    }
    const checkout = await checkoutRunBranch(id, path.resolve(checkoutDir));
    const baseRef = `refs/threadbeat/bases/${id}`;
    const diffRange = `${baseRef}...${status.run.result_commit}`;
    const [shortstatOutput, statOutput, changedOutput, commitOutput] = await Promise.all([
      git(["diff", "--shortstat", diffRange], checkout.checkout.dir),
      git(["diff", "--stat", diffRange], checkout.checkout.dir),
      git(["diff", "--name-status", diffRange], checkout.checkout.dir),
      git(["log", "--format=%H%x09%s", `${baseRef}..${status.run.result_commit}`], checkout.checkout.dir),
    ]);
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
        resultTreeUrl: resultLinks.treeUrl,
        resultCommitUrl: resultLinks.commitUrl,
        resultCompareUrl: resultLinks.compareUrl,
      },
      checkout: checkout.checkout,
      result: {
        available: true,
        commit: status.run.result_commit,
        baseRef: checkout.review.baseRef,
        baseCommit: checkout.review.baseCommit,
        matchesCheckoutHead: checkout.checkout.matchesResultCommit,
        shortstat: shortstatOutput.trim(),
        stat: statOutput.trim().split("\n").filter(Boolean),
        changedFiles: changedOutput.trim()
          ? changedOutput.trim().split("\n").map((line) => {
            const [fileStatus, ...filePath] = line.split("\t");
            return { status: fileStatus, path: filePath.join("\t") };
          })
          : [],
        commits: commitOutput.trim()
          ? commitOutput.trim().split("\n").map((line) => {
            const [sha, ...subject] = line.split("\t");
            return { sha, subject: subject.join("\t") };
          })
          : [],
      },
      commands,
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
        inspectResult: ["npm", "run", "cli", "--", "runs", "inspect-result", id, "--checkout-dir", checkoutDir],
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
    if (options.inspect === "1") {
      await printJson(await requestJson("GET", `/api/runs/${encodeURIComponent(id)}/resume-inspection`));
      return;
    }
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/resume-branch`, {
      dryRun: options["dry-run"] === "1",
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
    const checkoutDir = options["checkout-dir"] ?? `./checkouts/${id}`;
    let polls = 0;
    while (true) {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", options.limit);
      const status = await requestJson("GET", withQuery(`/api/runs/${encodeURIComponent(id)}/status`, params)) as {
        run: {
          id: string;
          input_ref: string;
          result_commit: string | null;
          run_branch: string;
          status: string;
          worker_id: string | null;
        };
      };
      const commands = {
        checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", status.run.id, "--dir", checkoutDir],
        reviewRun: ["npm", "run", "cli", "--", "runs", "review", status.run.id, "--checkout-dir", checkoutDir],
        inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", status.run.id],
        resumeBranch: status.run.status === "stopped" && status.run.result_commit === null
          ? ["npm", "run", "cli", "--", "runs", "resume-branch", status.run.id]
          : null,
      };
      const state = status.run.result_commit
        ? "result"
        : status.run.status === "stopped"
          ? "resumable"
          : status.run.status;
      const warning = status.run.status === "completed" && status.run.result_commit === null
        ? "completed_without_result_commit"
        : null;
      console.log(JSON.stringify({
        ...status,
        branch: {
          baseRef: status.run.input_ref,
          branchName: status.run.run_branch,
          resultCommit: status.run.result_commit,
          workerId: status.run.worker_id,
          state,
          warning,
        },
        commands,
        nextStep: state === "resumable"
          ? {
              action: "resume_branch",
              reason: "stopped_branch_without_result_commit",
              command: commands.resumeBranch,
            }
          : ["completed", "failed", "stopped"].includes(status.run.status)
            ? {
                action: status.run.status === "failed" ? "inspect_run" : "review_branch",
                reason: warning ?? (status.run.result_commit ? "result_commit_available" : "terminal_run"),
                command: status.run.status === "failed" ? commands.inspectRun : commands.reviewRun,
              }
            : null,
      }));
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
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs branches --format must be json or shell");
    }
    if (options.session && (options.agent || options.agents)) {
      throw new Error("runs branches accepts either --session or --agent/--agents");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs branches --commands-only requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs branches --format requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs branches --format shell requires --commands-only");
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
              inspectResult: ["npm", "run", "cli", "--", "runs", "inspect-result", run.id, "--checkout-dir", `${checkoutCommandRootDir}/${run.id}`],
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
      const nextSteps = visibleRuns.map(({ agentId, run }) => ({
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
      }));
      const commandQueue = nextSteps.map((step) => ({
        action: step.action,
        reason: step.reason,
        agentId: step.agentId,
        runId: step.runId,
        status: step.status,
        state: step.state,
        warning: step.warning,
        workerId: step.workerId,
        location: step.location,
        branchName: step.branchName,
        resultCommit: step.resultCommit,
        command: step.command,
      }));
      const output = {
        observedAt,
        ...(options.session ? { session: options.session } : {}),
        checkoutDir: checkoutCommandRootDir,
        summary,
        ...(options["commands-only"] === "1" ? { commands: commandQueue } : { nextSteps }),
      };
      if (outputFormat === "shell") {
        printCommandQueueShell(commandQueue);
      } else {
        await printJson(output);
      }
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
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs results --format must be json or shell");
    }
    if (options.session && (options.agent || options.agents)) {
      throw new Error("runs results accepts either --session or --agent/--agents");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs results --commands-only requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs results --format requires --next");
    }
    if (options.limit && options.next !== "1") {
      throw new Error("runs results --limit requires --next");
    }
    if (options.offset && options.next !== "1") {
      throw new Error("runs results --offset requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs results --format shell requires --commands-only");
    }
    if (options.server === "1") {
      if (!options.session) {
        throw new Error("runs results --server requires --session");
      }
      if (options["changed-only"] === "1" || options["changed-path"]) {
        throw new Error("runs results --server does not support changed checkout filters");
      }
      const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
      if (branchActionFilter && [...branchActionFilter].some((action) => action !== "resume_branch" && action !== "review_branch")) {
        throw new Error("runs results --server --branch-action must be resume_branch or review_branch");
      }
      const statusList = parseList(options.status ?? "completed,stopped");
      const runFilter = options.run ? new Set(parseList(options.run)) : null;
      const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
      const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
      if (outputFormat === "shell" && maxPolls !== 1) {
        throw new Error("runs results --format shell supports one poll");
      }
      const rowLimit = options.limit ? parsePositiveInteger(options.limit, "--limit") : null;
      const rowOffset = options.offset ? parseNonNegativeInteger(options.offset, "--offset") : 0;
      const checkoutCommandRootDir = options["checkout-dir"] ?? `./checkouts/${options.session}-results`;
      type ServerResultCommit = {
        agentId: string;
        runId: string;
        status: string;
        state: string;
        objective: string;
        workerId: string | null;
        location: string | null;
        branchName: string;
        resultCommit: string | null;
        links: Record<string, unknown>;
        commands: Record<string, unknown>;
      };
      type ServerBranchStep = {
        action: string;
        reason: string;
        agentId: string;
        runId: string;
        status: string;
        state: string;
        warning?: string | null;
        objective: string;
        workerId: string | null;
        location: string | null;
        branchName: string;
        resultCommit: string | null;
        command: string[];
        commands: Record<string, unknown>;
      };
      type ServerBranchesResponse = {
        ok: true;
        observedAt: string;
        session: string;
        checkoutDir: string;
        filter: {
          statuses: string[];
          resumable: boolean;
          workerId: string | null;
          branchAction?: string[];
          runIds?: string[];
          limit?: number | null;
          offset?: number;
          totalResultCommits?: number;
          visibleResultCommits?: number;
          totalNextSteps?: number;
          visibleNextSteps?: number;
          hasMore?: boolean;
          nextOffset?: number | null;
        };
        summary: { agents: number; total: number; resultCommits: number; resumable: number; warnings: number };
        resultCommits: ServerResultCommit[];
        resumableBranches: unknown[];
        nextSteps: ServerBranchStep[];
        agents: unknown[];
      };
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const params = new URLSearchParams();
        params.set("status", statusList.join(","));
        params.set("checkoutDir", checkoutCommandRootDir);
        if (options["worker-id"]) params.set("workerId", options["worker-id"]);
        if (options["branch-action"]) params.set("branchAction", options["branch-action"]);
        if (options.run) params.set("runId", options.run);
        if (rowLimit) params.set("limit", String(rowLimit));
        if (rowOffset > 0) params.set("offset", String(rowOffset));
        const response = await requestJson(
          "GET",
          withQuery(`/api/worker-sessions/${encodeURIComponent(options.session)}/branches`, params),
        ) as ServerBranchesResponse;
        const resultCommits = response.resultCommits;
        const nextSteps = response.nextSteps;
        const nextCommandQueue = nextSteps.map((step) => ({
          scope: "branch",
          action: step.action,
          reason: step.reason,
          agentId: step.agentId,
          runId: step.runId,
          status: step.status,
          state: step.state,
          workerId: step.workerId,
          location: step.location,
          branchName: step.branchName,
          resultCommit: step.resultCommit,
          command: step.command,
        }));
        const summary = {
          ...response.summary,
          changed: null,
          changedFiles: null,
        };
        const output = options.next === "1"
          ? {
            observedAt: response.observedAt,
            session: response.session,
            ...(runFilter ? { runFilter: Array.from(runFilter) } : {}),
            checkoutDir: response.checkoutDir,
            filter: response.filter,
            summary,
            ...(options["commands-only"] === "1"
              ? { commands: nextCommandQueue }
              : { resultCommits, nextSteps }),
          }
          : {
            observedAt: response.observedAt,
            session: response.session,
            ...(runFilter ? { runFilter: Array.from(runFilter) } : {}),
            checkoutDir: response.checkoutDir,
            filter: response.filter,
            summary,
            resultCommits,
            resumableBranches: response.resumableBranches,
            agents: response.agents,
        };
        if (outputFormat === "shell") {
          printCommandQueueShell(nextCommandQueue);
        } else if (maxPolls === 1) {
          await printJson(output);
        } else {
          console.log(JSON.stringify(output));
          if (poll + 1 < maxPolls) await sleep(intervalMs);
        }
      }
      return;
    }
    const session = options.session ? await readWorkerSession(options.session) : null;
    const sessionWorkerIds = session ? new Set(session.workers.map((worker) => worker.workerId)) : null;
    const workerIdFilter = options["worker-id"] ?? null;
    const agentIds = session
      ? workerSessionAgentIds(session)
      : parseList(options.agents ?? required(options.agent, "--agent, --agents, or --session"));
    const statusList = parseList(options.status ?? "completed,stopped");
    const statusFilter = new Set(statusList);
    const runFilter = options.run ? new Set(parseList(options.run)) : null;
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
    if (outputFormat === "shell" && maxPolls !== 1) {
      throw new Error("runs results --format shell supports one poll");
    }
    const rowLimit = options.limit ? parsePositiveInteger(options.limit, "--limit") : null;
    const rowOffset = options.offset ? parseNonNegativeInteger(options.offset, "--offset") : 0;
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
          .filter((run) => runFilter === null || runFilter.has(run.id))
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
                inspectResult: [
                  "npm",
                  "run",
                  "cli",
                  "--",
                  "runs",
                  "inspect-result",
                  run.id,
                  "--checkout-dir",
                  `${checkoutCommandRootDir}/${run.id}`,
                ],
                resumeBranch: run.status === "stopped" && !run.result_commit
                  ? ["npm", "run", "cli", "--", "runs", "resume-branch", run.id]
                  : null,
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
      const resultCommits = agents.flatMap((agent) => agent.runs
        .filter((run) => run.resultCommit)
        .map((run) => ({
          agentId: agent.agentId,
          runId: run.id,
          status: run.status,
          state: run.state,
          objective: run.objective,
          workerId: run.workerId,
          location: run.location ?? null,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          links: {
            resultCommitUrl: run.links.resultCommitUrl,
            resultTreeUrl: run.links.resultTreeUrl,
            resultCompareUrl: run.links.resultCompareUrl,
          },
          commands: {
            inspectRun: run.commands.inspectRun,
            inspectResult: run.commands.inspectResult,
            checkoutBranch: run.commands.checkoutBranch,
            reviewRun: run.commands.reviewRun,
          },
        })));
      const snapshot = {
        observedAt: new Date().toISOString(),
        ...(options.session ? { session: options.session } : {}),
        ...(runFilter ? { runFilter: Array.from(runFilter) } : {}),
        ...(checkoutRootDir ? { checkoutDir: checkoutRootDir } : {}),
        summary: {
          agents: agents.length,
          total: visibleRuns.length,
          resultCommits: resultCommits.length,
          resumable: visibleRuns.filter((run) => run.state === "resumable").length,
          warnings: visibleRuns.filter((run) => run.warning).length,
          changed: changedCount,
          changedFiles: changedFiles?.length ?? null,
        },
        ...(changedFiles ? { changedFiles } : {}),
        resultCommits,
        agents,
      };
      const nextSteps = agents.flatMap((agent) => agent.runs.map((run) => {
        const review = (run as typeof run & { review?: { changedFiles: unknown[]; commits: unknown[]; error?: unknown } }).review;
        const hasReviewChange = review
          ? review.changedFiles.length > 0 || review.commits.length > 0 || Boolean(review.error)
          : false;
        return {
          action: hasReviewChange
            ? "review_changed_result"
            : run.state === "resumable"
              ? "resume_branch"
              : "review_result",
          reason: hasReviewChange
            ? "changed_result_branch"
            : run.state === "resumable"
              ? "stopped_branch_without_result_commit"
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
          command: hasReviewChange
            ? run.commands.reviewRun
            : run.state === "resumable" && run.commands.resumeBranch
              ? run.commands.resumeBranch
              : run.commands.reviewRun,
          commands: run.commands,
        };
      }));
      const nextCommandQueue = nextSteps.map((step) => ({
        action: step.action,
        reason: step.reason,
        agentId: step.agentId,
        runId: step.runId,
        status: step.status,
        state: step.state,
        workerId: step.workerId,
        location: step.location,
        branchName: step.branchName,
        resultCommit: step.resultCommit,
        changedFiles: step.changedFiles,
        commits: step.commits,
        command: step.command,
      }));
      const pageEnd = rowLimit ? rowOffset + rowLimit : undefined;
      const visibleResultCommits = rowOffset > 0 || rowLimit
        ? resultCommits.slice(rowOffset, pageEnd)
        : resultCommits;
      const visibleNextSteps = rowOffset > 0 || rowLimit
        ? nextSteps.slice(rowOffset, pageEnd)
        : nextSteps;
      const visibleNextCommandQueue = rowOffset > 0 || rowLimit
        ? nextCommandQueue.slice(rowOffset, pageEnd)
        : nextCommandQueue;
      const pageFilter = rowOffset > 0 || rowLimit
        ? {
          ...(rowLimit ? { limit: rowLimit } : {}),
          offset: rowOffset,
          totalResultCommits: resultCommits.length,
          visibleResultCommits: visibleResultCommits.length,
          totalNextSteps: nextSteps.length,
          visibleNextSteps: visibleNextSteps.length,
          ...pageCursor(rowLimit, rowOffset, Math.max(resultCommits.length, nextSteps.length)),
        }
        : null;
      const output = options.next === "1"
        ? {
          observedAt: snapshot.observedAt,
          ...(options.session ? { session: options.session } : {}),
          ...(runFilter ? { runFilter: Array.from(runFilter) } : {}),
          ...(checkoutRootDir ? { checkoutDir: checkoutRootDir } : {}),
          ...(pageFilter ? { filter: pageFilter } : {}),
          summary: snapshot.summary,
          ...(options["commands-only"] === "1"
            ? { commands: visibleNextCommandQueue }
            : { resultCommits: visibleResultCommits, nextSteps: visibleNextSteps }),
        }
        : snapshot;
      if (outputFormat === "shell") {
        printCommandQueueShell(visibleNextCommandQueue);
      } else if (maxPolls === 1) {
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
    const sessionName = required(options.session, "--session");
    if (options.wait === "1" && options["until-empty"] !== "1") {
      throw new Error("runs supervise --wait requires --until-empty so the worker session can finish");
    }
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
    const superviseActions = {
      sessionStatus: ["npm", "run", "cli", "--", "runs", "session-status", sessionName, "--recoverable", "--include-stopped"],
      sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", sessionName, "--recoverable", "--include-stopped", "--next"],
      sessionSummary: ["npm", "run", "cli", "--", "runs", "session-summary", sessionName, "--next"],
      sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", sessionName, "--next", "--max-polls", "30", "--interval-ms", "10000"],
      monitor: ["npm", "run", "cli", "--", "runs", "monitor", "--agents", agentIds.join(","), "--status", "planned,running,stopped", "--next", "--checkout-dir", `./checkouts/${sessionName}-monitor`],
      sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", sessionName, "--include-stopped"],
      branchQueue: ["npm", "run", "cli", "--", "runs", "branches", "--session", sessionName, "--next"],
      results: ["npm", "run", "cli", "--", "runs", "results", "--session", sessionName],
      checkoutSession: ["npm", "run", "cli", "--", "runs", "checkout-session", sessionName, "--dir", `./checkouts/${sessionName}`],
      sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", sessionName],
      stopSession: ["npm", "run", "cli", "--", "runs", "stop-session", sessionName, "--recover"],
      recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", sessionName],
      resumeSession: ["npm", "run", "cli", "--", "runs", "resume-session", sessionName],
      restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", sessionName, "--recover"],
      restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", sessionName, "--recover", "--resume-stopped"],
    };
    const session = await startDetachedWorkerSession(
      sessionName,
      workerCount,
      workerPrefix,
      workerArgs,
    );
    const response: {
      before: Awaited<ReturnType<typeof agentBacklog>>;
      recovered: Omit<RecoverStaleRunResult, "run">[];
      session: WorkerSession;
      actions: typeof superviseActions;
      after: Awaited<ReturnType<typeof agentBacklog>>;
      wait?: unknown;
    } = {
      before,
      recovered: recovered.map(({ run: _run, ...item }) => item),
      session,
      actions: superviseActions,
      after: await agentBacklog(agentIds),
    };
    if (options.wait === "1") {
      const waitIntervalMs = parsePositiveInteger(options["wait-interval-ms"] ?? options["interval-ms"] ?? "2000", "--wait-interval-ms");
      const maxPolls = parsePositiveInteger(options["max-polls"] ?? "60", "--max-polls");
      let polls = 0;
      let finalStatus = await workerSessionStatus(sessionName, new Set(["planned", "running", "stopped", "completed", "failed"]));
      while (polls < maxPolls) {
        finalStatus = await workerSessionStatus(sessionName, new Set(["planned", "running", "stopped", "completed", "failed"]));
        polls += 1;
        const workers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
        if (workers.every((worker) => !worker.alive)) break;
        if (polls >= maxPolls) break;
        await sleep(waitIntervalMs);
      }
      const finalWorkers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
      const aliveWorkers = finalWorkers.filter((worker) => worker.alive).length;
      const statuses: Record<string, number> = {};
      for (const agent of finalStatus.agents) {
        for (const [status, count] of Object.entries(agent.statuses)) {
          statuses[status] = (statuses[status] ?? 0) + count;
        }
      }
      response.wait = {
        completed: aliveWorkers === 0,
        timedOut: aliveWorkers > 0,
        polls,
        intervalMs: waitIntervalMs,
        summary: {
          workers: {
            total: finalWorkers.length,
            alive: aliveWorkers,
            dead: finalWorkers.length - aliveWorkers,
          },
          agents: finalStatus.agents.length,
          runs: finalStatus.agents.reduce((sum, agent) => sum + agent.total, 0),
          statuses,
        },
        status: finalStatus,
        commands: {
          sessionWatch: superviseActions.sessionWatch,
          sessionSummary: superviseActions.sessionSummary,
          sessionSummaryWatch: superviseActions.sessionSummaryWatch,
          monitor: superviseActions.monitor,
          sessionReview: superviseActions.sessionReview,
          branchQueue: superviseActions.branchQueue,
          results: superviseActions.results,
          checkoutSession: superviseActions.checkoutSession,
          sessionLogs: superviseActions.sessionLogs,
          stopSession: superviseActions.stopSession,
          recoverSession: superviseActions.recoverSession,
          resumeSession: superviseActions.resumeSession,
          restartSession: superviseActions.restartSession,
          restartSessionWithStopped: superviseActions.restartSessionWithStopped,
        },
        nextStep: aliveWorkers > 0
          ? {
            action: "continue_watch",
            reason: "workers_still_alive",
            command: superviseActions.sessionSummaryWatch,
          }
          : {
            action: "review_session",
            reason: "bounded_session_finished",
            command: superviseActions.sessionReview,
          },
      };
      response.after = await agentBacklog(agentIds);
    }
    await printJson(response);
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
    if (options.wait === "1" && options["until-empty"] !== "1") {
      throw new Error("runs dispatch --wait requires --until-empty so the worker session can finish");
    }
    const workerArgs = ["--agents", agentIds.join(",")];
    for (const flag of ["limit", "concurrency", "interval-ms", "idle-exit-after", "message", "prompt", "task"]) {
      if (options[flag]) workerArgs.push(`--${flag}`, options[flag]);
    }
    for (const flag of ["bootstrap", "check-runtime", "boot", "finalize", "recover", "include-stopped", "resume-stopped", "until-empty"]) {
      if (options[flag] === "1") workerArgs.push(`--${flag}`);
    }
    if (options.loop === "1" || options["until-empty"] !== "1") workerArgs.push("--loop");
    const sessionName = required(options.session, "--session");
    const dispatchActions = {
      sessionStatus: ["npm", "run", "cli", "--", "runs", "session-status", sessionName, "--recoverable", "--include-stopped"],
      sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", sessionName, "--recoverable", "--include-stopped", "--next"],
      sessionSummary: ["npm", "run", "cli", "--", "runs", "session-summary", sessionName, "--next"],
      sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", sessionName, "--next", "--max-polls", "30", "--interval-ms", "10000"],
      monitor: ["npm", "run", "cli", "--", "runs", "monitor", "--agents", agentIds.join(","), "--status", "planned,running,stopped", "--next", "--checkout-dir", `./checkouts/${sessionName}-monitor`],
      sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", sessionName, "--include-stopped"],
      branchQueue: ["npm", "run", "cli", "--", "runs", "branches", "--session", sessionName, "--next"],
      results: ["npm", "run", "cli", "--", "runs", "results", "--session", sessionName],
      checkoutSession: ["npm", "run", "cli", "--", "runs", "checkout-session", sessionName, "--dir", `./checkouts/${sessionName}`],
      sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", sessionName],
      stopSession: ["npm", "run", "cli", "--", "runs", "stop-session", sessionName, "--recover"],
      recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", sessionName],
      resumeSession: ["npm", "run", "cli", "--", "runs", "resume-session", sessionName],
      restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", sessionName, "--recover"],
      restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", sessionName, "--recover", "--resume-stopped"],
    };
    if (options["dry-run"] === "1") {
      const recoveryPreview = options.recover === "1"
        ? await recoverStaleRuns(
          agentIds,
          undefined,
          parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
          undefined,
          options["include-stopped"] === "1",
          true,
        )
        : [];
      await printJson({
        assignment,
        dryRun: true,
        planned: queueItems,
        ...(options.recover === "1" ? {
          recoveryPreview: recoveryPreview.map(({ run: _run, ...item }) => item),
        } : {}),
        session: {
          session: sessionName,
          workerCount,
          workerPrefix,
          command: ["runs", "work", ...workerArgs],
        },
        actions: dispatchActions,
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
    const response: {
      assignment: string;
      queued: Array<{ agentId: string; objective: string; plan: unknown; run: unknown }>;
      recovered?: Omit<RecoverStaleRunResult, "run">[];
      session: WorkerSession;
      actions: typeof dispatchActions;
      backlog: Awaited<ReturnType<typeof agentBacklog>>;
      wait?: unknown;
    } = {
      assignment,
      queued,
      ...(options.recover === "1" ? { recovered: recovered.map(({ run: _run, ...item }) => item) } : {}),
      session,
      actions: dispatchActions,
      backlog: await agentBacklog(agentIds),
    };
    if (options.wait === "1") {
      const waitIntervalMs = parsePositiveInteger(options["wait-interval-ms"] ?? options["interval-ms"] ?? "2000", "--wait-interval-ms");
      const maxPolls = parsePositiveInteger(options["max-polls"] ?? "60", "--max-polls");
      let polls = 0;
      let finalStatus = await workerSessionStatus(sessionName, new Set(["planned", "running", "stopped", "completed", "failed"]));
      while (polls < maxPolls) {
        finalStatus = await workerSessionStatus(sessionName, new Set(["planned", "running", "stopped", "completed", "failed"]));
        polls += 1;
        const workers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
        if (workers.every((worker) => !worker.alive)) break;
        if (polls >= maxPolls) break;
        await sleep(waitIntervalMs);
      }
      const finalWorkers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
      const aliveWorkers = finalWorkers.filter((worker) => worker.alive).length;
      const statuses: Record<string, number> = {};
      for (const agent of finalStatus.agents) {
        for (const [status, count] of Object.entries(agent.statuses)) {
          statuses[status] = (statuses[status] ?? 0) + count;
        }
      }
      response.wait = {
        completed: aliveWorkers === 0,
        timedOut: aliveWorkers > 0,
        polls,
        intervalMs: waitIntervalMs,
        summary: {
          workers: {
            total: finalWorkers.length,
            alive: aliveWorkers,
            dead: finalWorkers.length - aliveWorkers,
          },
          agents: finalStatus.agents.length,
          runs: finalStatus.agents.reduce((sum, agent) => sum + agent.total, 0),
          statuses,
        },
        status: finalStatus,
        commands: {
          sessionWatch: dispatchActions.sessionWatch,
          sessionSummary: dispatchActions.sessionSummary,
          sessionSummaryWatch: dispatchActions.sessionSummaryWatch,
          monitor: dispatchActions.monitor,
          sessionReview: dispatchActions.sessionReview,
          branchQueue: dispatchActions.branchQueue,
          results: dispatchActions.results,
          checkoutSession: dispatchActions.checkoutSession,
          sessionLogs: dispatchActions.sessionLogs,
          stopSession: dispatchActions.stopSession,
          recoverSession: dispatchActions.recoverSession,
          resumeSession: dispatchActions.resumeSession,
          restartSession: dispatchActions.restartSession,
          restartSessionWithStopped: dispatchActions.restartSessionWithStopped,
        },
        nextStep: aliveWorkers > 0
          ? {
            action: "continue_watch",
            reason: "workers_still_alive",
            command: dispatchActions.sessionSummaryWatch,
          }
          : {
            action: "review_session",
            reason: "bounded_session_finished",
            command: dispatchActions.sessionReview,
          },
      };
      response.backlog = await agentBacklog(agentIds);
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "sessions") {
    const options = parseOptions(args);
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs sessions --format must be json or shell");
    }
    if (options["needs-action"] === "1" && options.next !== "1") {
      throw new Error("runs sessions --needs-action requires --next");
    }
    if (options.action && options.next !== "1") {
      throw new Error("runs sessions --action requires --next");
    }
    if (options["branch-action"] && options.next !== "1") {
      throw new Error("runs sessions --branch-action requires --next");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs sessions --commands-only requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs sessions --format requires --next");
    }
    if (options["older-than-ms"] && options.next !== "1") {
      throw new Error("runs sessions --older-than-ms requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs sessions --format shell requires --commands-only");
    }
    const sessionLimit = options.limit ? parsePositiveInteger(options.limit, "--limit") : null;
    const sessionOffset = options.offset ? parseNonNegativeInteger(options.offset, "--offset") : 0;
    if (options.summary === "1" || options.next === "1") {
      const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
      const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
      const drainContinuationOlderThanMs = options["older-than-ms"]
        ? parsePositiveInteger(options["older-than-ms"], "--older-than-ms")
        : STALE_RUNNING_DRAIN_CONTINUATION_MS;
      const preserveOlderThanOption = options["older-than-ms"]
        ? ["--older-than-ms", String(drainContinuationOlderThanMs)]
        : [];
      if (outputFormat === "shell" && maxPolls !== 1) {
        throw new Error("runs sessions --format shell supports one poll");
      }
      const actionFilter = options.action ? new Set(parseList(options.action)) : null;
      const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
      const collectFleetSummary = async () => {
        const allSessionNames = options.session ? [options.session] : await listWorkerSessionNames();
        const sessionNames = (sessionLimit || sessionOffset > 0) && !options.session
          ? await listWorkerSessionNames(sessionLimit ?? undefined, sessionOffset)
          : allSessionNames;
        const sessions = await mapConcurrent(sessionNames, 4, async (listedSessionName) => {
          try {
            const status = await workerSessionStatus(listedSessionName, new Set(["planned", "running", "stopped"]));
            const sessionWorkerIds = new Set(status.session.workers.map((worker) => worker.workerId));
            const resultCheckoutDir = `./checkouts/${listedSessionName}-results`;
            const resumableCheckoutDir = `./checkouts/${listedSessionName}-resumable`;
            const agentIds = workerSessionAgentIds(status.session);
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
              for (const run of listed.runs) {
                statuses[run.status] = (statuses[run.status] ?? 0) + 1;
              }
              return {
                agentId,
                total: listed.runs.length,
                statuses,
                resultCommits: listed.runs.filter((run) => run.result_commit).length,
                resumableStopped: listed.runs.filter((run) => run.status === "stopped" && !run.result_commit).length,
                resumableBranchRows: listed.runs
                  .filter((run) => run.status === "stopped" && !run.result_commit)
                  .map((run) => ({
                    session: listedSessionName,
                    agentId,
                    runId: run.id,
                    status: run.status,
                    objective: run.objective,
                    workerId: run.worker_id,
                    location: run.worker_id === null
                      ? "unassigned"
                      : sessionWorkerIds.has(run.worker_id)
                        ? "session_worker"
                        : "other_worker",
                    branchName: run.run_branch,
                    resultCommit: run.result_commit,
                    commands: {
                      inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
                      checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${resumableCheckoutDir}/${run.id}`],
                      reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${resumableCheckoutDir}/${run.id}`],
                      resumeBranch: ["npm", "run", "cli", "--", "runs", "resume-branch", run.id],
                      sessionBranches: ["npm", "run", "cli", "--", "runs", "branches", "--session", listedSessionName, "--next"],
                    },
                  })),
                resultCommitRows: listed.runs
                  .filter((run) => run.result_commit)
                  .map((run) => ({
                    session: listedSessionName,
                    agentId,
                    runId: run.id,
                    status: run.status,
                    objective: run.objective,
                    workerId: run.worker_id,
                    location: run.worker_id === null
                      ? "unassigned"
                      : sessionWorkerIds.has(run.worker_id)
                        ? "session_worker"
                        : "other_worker",
                    branchName: run.run_branch,
                    resultCommit: run.result_commit,
                    commands: {
                      inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
                      checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${resultCheckoutDir}/${run.id}`],
                      reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${resultCheckoutDir}/${run.id}`],
                      sessionResults: ["npm", "run", "cli", "--", "runs", "results", "--session", listedSessionName, "--next"],
                    },
                  })),
              };
            });
            const resumableBranches = agents.flatMap((agent) => agent.resumableBranchRows);
            const resultCommits = agents.flatMap((agent) => agent.resultCommitRows);
            const summaryAgents = agents.map(({ resumableBranchRows: _resumableBranchRows, resultCommitRows: _resultCommitRows, ...agent }) => agent);
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
            const aliveWorkers = sessionWorkers.filter((worker) => worker.alive).length;
            const drainContinuationResetNextSteps = options.next === "1"
              ? await workerSessionDrainContinuationResetNextSteps(listedSessionName, drainContinuationOlderThanMs)
              : [];
            const drainContinuationResets = drainContinuationResetNextSteps.reduce((sum, step) => sum + step.count, 0);
            const commands = {
              sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", listedSessionName, "--next", "--max-polls", "30", "--interval-ms", "10000", ...preserveOlderThanOption],
              sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", listedSessionName, "--include-stopped"],
              resultsNext: ["npm", "run", "cli", "--", "runs", "results", "--session", listedSessionName, "--next"],
              recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", listedSessionName],
              restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", listedSessionName, "--recover"],
              restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", listedSessionName, "--recover", "--resume-stopped"],
              sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", listedSessionName],
              stopSession: ["npm", "run", "cli", "--", "runs", "stop-session", listedSessionName, "--recover"],
              archiveSessionPreview: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", listedSessionName, "--dry-run"],
              archiveSession: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", listedSessionName],
            };
            const drainContinuationResetNextStep = drainContinuationResetNextSteps[0]
              ? {
                action: drainContinuationResetNextSteps[0].action,
                reason: drainContinuationResetNextSteps[0].reason,
                count: drainContinuationResetNextSteps[0].count,
                command: drainContinuationResetNextSteps[0].command,
              }
              : null;
            const nextStep = drainContinuationResetNextStep ?? (aliveWorkers > 0
              ? {
                action: "continue_watch",
                reason: "workers_still_alive",
                command: commands.sessionSummaryWatch,
              }
              : (totals.statuses.running ?? 0) > 0
                ? {
                  action: "recover_session",
                  reason: "stale_running_claims",
                  command: commands.recoverSession,
                }
                : totals.resumableStopped > 0
                  ? {
                    action: "restart_session_with_stopped",
                    reason: "resumable_stopped_branches",
                    command: commands.restartSessionWithStopped,
                  }
                  : (totals.statuses.planned ?? 0) > 0
                    ? {
                      action: "restart_session",
                      reason: "planned_runs_waiting",
                      command: commands.restartSession,
                    }
                    : totals.resultCommits > 0
                      ? {
                        action: "inspect_results",
                        reason: "result_commits_available",
                        command: commands.resultsNext,
                      }
                      : totals.runs === 0
                        ? {
                          action: "archive_session_preview",
                          reason: "dead_session_without_runs",
                          command: commands.archiveSessionPreview,
                        }
                        : {
                          action: "review_session",
                          reason: "no_active_work",
                          command: commands.sessionReview,
                        });
            return {
              session: {
                session: status.session.session,
                command: status.session.command,
                startedAt: status.session.startedAt,
                stoppedAt: status.session.stoppedAt ?? null,
                restartedAt: status.session.restartedAt ?? null,
                workers: {
                  total: sessionWorkers.length,
                  alive: aliveWorkers,
                  dead: sessionWorkers.length - aliveWorkers,
                },
              },
              totals,
              resumableBranches,
              resultCommits,
              agents: summaryAgents,
              ...(options.next === "1" ? { commands, nextStep, drainContinuationResets, drainContinuationResetNextSteps } : {}),
            };
          } catch (error) {
            const commands = {
              archiveSessionPreview: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", listedSessionName, "--dry-run"],
              archiveSession: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", listedSessionName],
            };
            return {
              session: { session: listedSessionName },
              error: error instanceof Error ? error.message : String(error),
              ...(options.next === "1" ? {
                commands,
                nextStep: {
                  action: "archive_session_preview",
                  reason: "unavailable_session_record",
                  command: commands.archiveSessionPreview,
                },
              } : {}),
            };
          }
        });
        let visibleSessions = options["needs-action"] === "1"
          ? sessions.filter((session) => (
            "nextStep" in session
            && session.nextStep?.action !== "continue_watch"
          ))
          : sessions;
        if (actionFilter) {
          visibleSessions = visibleSessions.filter((session) => (
            "nextStep" in session
            && session.nextStep
            && actionFilter.has(session.nextStep.action)
          ));
        }
        const totals = {
          sessions: visibleSessions.length,
          unavailable: visibleSessions.filter((session) => "error" in session).length,
          workers: {
            total: visibleSessions.reduce((sum, session) => sum + ("totals" in session ? session.session.workers.total : 0), 0),
            alive: visibleSessions.reduce((sum, session) => sum + ("totals" in session ? session.session.workers.alive : 0), 0),
            dead: visibleSessions.reduce((sum, session) => sum + ("totals" in session ? session.session.workers.dead : 0), 0),
          },
          runs: visibleSessions.reduce((sum, session) => sum + ("totals" in session ? session.totals.runs : 0), 0),
          resultCommits: visibleSessions.reduce((sum, session) => sum + ("totals" in session ? session.totals.resultCommits : 0), 0),
          resumableStopped: visibleSessions.reduce((sum, session) => sum + ("totals" in session ? session.totals.resumableStopped : 0), 0),
          drainContinuationResets: visibleSessions.reduce((sum, session) => sum + ("drainContinuationResets" in session ? session.drainContinuationResets ?? 0 : 0), 0),
          statuses: {} as Record<string, number>,
        };
        for (const session of visibleSessions) {
          if (!("totals" in session)) continue;
          for (const [runStatus, count] of Object.entries(session.totals.statuses)) {
            totals.statuses[runStatus] = (totals.statuses[runStatus] ?? 0) + count;
          }
        }
        const visibleResultCommits = visibleSessions.flatMap((session) => ("resultCommits" in session ? session.resultCommits : []));
        const visibleResumableBranches = visibleSessions.flatMap((session) => ("resumableBranches" in session ? session.resumableBranches : []));
        const allBranchActionQueue = [
          ...visibleResumableBranches.map((run) => ({
            session: run.session,
            action: "resume_branch",
            reason: "stopped_branch_without_result_commit",
            agentId: run.agentId,
            runId: run.runId,
            status: run.status,
            objective: run.objective,
            workerId: run.workerId,
            location: run.location,
            branchName: run.branchName,
            resultCommit: run.resultCommit,
            command: run.commands.resumeBranch,
            commands: run.commands,
          })),
          ...visibleResultCommits.map((run) => ({
            session: run.session,
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
        const branchActionQueue = branchActionFilter
          ? allBranchActionQueue.filter((item) => branchActionFilter.has(item.action))
          : allBranchActionQueue;
        const resultCommits = branchActionFilter && !branchActionFilter.has("review_branch")
          ? []
          : visibleResultCommits;
        const resumableBranches = branchActionFilter && !branchActionFilter.has("resume_branch")
          ? []
          : visibleResumableBranches;
        const branchActions = branchActionQueue.reduce((counts, item) => {
          counts[item.action] = (counts[item.action] ?? 0) + 1;
          return counts;
        }, {} as Record<string, number>);
        const actionQueue = visibleSessions
          .filter((session) => "nextStep" in session && session.nextStep)
          .map((session) => ({
            session: session.session.session,
            action: session.nextStep!.action,
            reason: session.nextStep!.reason,
            ...("count" in session.nextStep! ? { count: session.nextStep!.count } : {}),
            command: session.nextStep!.command,
          }));
        const nextActions = actionQueue.reduce((counts, item) => {
          counts[item.action] = (counts[item.action] ?? 0) + 1;
          return counts;
        }, {} as Record<string, number>);
        const filter = {
          ...(options["needs-action"] === "1" ? { needsAction: true } : {}),
          ...(actionFilter ? { action: [...actionFilter] } : {}),
          ...(branchActionFilter ? { branchAction: [...branchActionFilter] } : {}),
          ...(sessionLimit || sessionOffset > 0 ? {
            ...(sessionLimit ? { limit: sessionLimit } : {}),
            offset: sessionOffset,
            totalSessionRecords: allSessionNames.length,
            scannedSessions: sessions.length,
            ...pageCursor(sessionLimit, sessionOffset, allSessionNames.length),
          } : {}),
          ...(
            options["needs-action"] === "1" || actionFilter || branchActionFilter
              ? { totalSessions: sessions.length }
              : {}
          ),
        };
        const commandQueue = [
          ...actionQueue.map((item) => ({
            scope: "session",
            session: item.session,
            action: item.action,
            reason: item.reason,
            ...("count" in item ? { count: item.count } : {}),
            command: item.command,
          })),
          ...branchActionQueue.map((item) => ({
            scope: "branch",
            session: item.session,
            action: item.action,
            reason: item.reason,
            agentId: item.agentId,
            runId: item.runId,
            status: item.status,
            objective: item.objective,
            workerId: item.workerId,
            location: item.location,
            branchName: item.branchName,
            resultCommit: item.resultCommit,
            command: item.command,
          })),
        ];
        if (options["commands-only"] === "1") {
          return {
            observedAt: new Date().toISOString(),
            ...(Object.keys(filter).length > 0 ? { filter } : {}),
            totals,
            nextActions,
            branchActions,
            commands: commandQueue,
          };
        }
        return {
          observedAt: new Date().toISOString(),
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
          totals,
          ...(options.next === "1" ? { nextActions, actionQueue, branchActions, branchActionQueue } : {}),
          resumableBranches,
          resultCommits,
          sessions: visibleSessions,
        };
      };
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const output = await collectFleetSummary();
        if (outputFormat === "shell") {
          printCommandQueueShell((output as CommandQueueOutput).commands);
        } else if (maxPolls === 1) {
          await printJson(output);
        } else {
          console.log(JSON.stringify(output));
          if (poll + 1 < maxPolls) await sleep(intervalMs);
        }
      }
      return;
    }
    const allSessionNames = options.session ? [options.session] : await listWorkerSessionNames();
    const sessions = await listWorkerSessions(
      options.session,
      sessionLimit && !options.session ? sessionLimit : null,
      !options.session ? sessionOffset : 0,
    );
    await printJson({
      ...(sessionLimit || sessionOffset > 0 ? {
        filter: {
          ...(sessionLimit ? { limit: sessionLimit } : {}),
          offset: sessionOffset,
          totalSessionRecords: allSessionNames.length,
          scannedSessions: sessions.length,
          ...pageCursor(sessionLimit, sessionOffset, allSessionNames.length),
        },
      } : {}),
      sessions,
    });
    return;
  }
  if (subcommandName === "archive-sessions") {
    const options = parseOptions(args);
    const sessionNames = options.session ? [options.session] : await listWorkerSessionNames();
    const archivedAt = new Date().toISOString();
    const archiveDir = path.join(workerSessionDir, "archive", archivedAt.replace(/[:.]/g, "-"));
    const archived: Array<{
      session: string;
      reason: string;
      workers: { total: number; alive: number; dead: number } | null;
      paths: { sessionFile: string; logDir: string; destinationFile: string; destinationLogDir: string };
      dryRun: boolean;
      error?: string;
    }> = [];
    const skipped: Array<{
      session: string;
      reason: string;
      workers: { total: number; alive: number; dead: number } | null;
      error?: string;
    }> = [];
    for (const sessionName of sessionNames) {
      assertSafeSessionName(sessionName);
      const sessionFile = workerSessionPath(sessionName);
      const logDir = workerSessionLogDir(sessionName);
      const destinationFile = path.join(archiveDir, `${sessionName}.json`);
      const destinationLogDir = path.join(archiveDir, sessionName);
      try {
        const session = await readWorkerSession(sessionName);
        const alive = session.workers.filter((worker) => processIsAlive(worker.pid)).length;
        const workers = { total: session.workers.length, alive, dead: session.workers.length - alive };
        if (alive > 0) {
          skipped.push({ session: sessionName, reason: "workers_alive", workers });
          continue;
        }
        archived.push({
          session: sessionName,
          reason: workers.total === 0 ? "no_recorded_workers" : "all_workers_dead",
          workers,
          paths: { sessionFile, logDir, destinationFile, destinationLogDir },
          dryRun: options["dry-run"] === "1",
        });
      } catch (error) {
        archived.push({
          session: sessionName,
          reason: "unreadable_session_record",
          workers: null,
          paths: { sessionFile, logDir, destinationFile, destinationLogDir },
          dryRun: options["dry-run"] === "1",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (options["dry-run"] !== "1" && archived.length > 0) {
      await fs.mkdir(archiveDir, { recursive: true });
      for (const item of archived) {
        if (await pathExists(item.paths.sessionFile)) {
          await fs.rename(item.paths.sessionFile, item.paths.destinationFile);
        }
        if (await pathExists(item.paths.logDir)) {
          await fs.rename(item.paths.logDir, item.paths.destinationLogDir);
        }
      }
    }
    await printJson({
      archivedAt,
      dryRun: options["dry-run"] === "1",
      archiveDir,
      archived,
      skipped,
      note: "Archived local worker-session metadata only; run records and Git branches are unchanged.",
    });
    return;
  }
  if (subcommandName === "session-wait") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-wait <session>");
    const waitIntervalMs = parsePositiveInteger(options["wait-interval-ms"] ?? options["interval-ms"] ?? "2000", "--wait-interval-ms");
    const maxPolls = parsePositiveInteger(options["max-polls"] ?? "60", "--max-polls");
    const statusFilter = new Set(parseList(options.status ?? "planned,running,stopped,completed,failed"));
    const sessionAgentIds = workerSessionAgentIds(await readWorkerSession(requiredSessionName));
    const actions = {
      sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", requiredSessionName, "--recoverable", "--include-stopped", "--next"],
      sessionSummary: ["npm", "run", "cli", "--", "runs", "session-summary", requiredSessionName, "--next"],
      sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", requiredSessionName, "--next", "--max-polls", "30", "--interval-ms", "10000"],
      monitor: ["npm", "run", "cli", "--", "runs", "monitor", "--agents", sessionAgentIds.join(","), "--status", "planned,running,stopped", "--next", "--checkout-dir", `./checkouts/${requiredSessionName}-monitor`],
      sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", requiredSessionName, "--include-stopped"],
      branchQueue: ["npm", "run", "cli", "--", "runs", "branches", "--session", requiredSessionName, "--next"],
      results: ["npm", "run", "cli", "--", "runs", "results", "--session", requiredSessionName],
      checkoutSession: ["npm", "run", "cli", "--", "runs", "checkout-session", requiredSessionName, "--dir", `./checkouts/${requiredSessionName}`],
      sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", requiredSessionName],
      stopSession: ["npm", "run", "cli", "--", "runs", "stop-session", requiredSessionName, "--recover"],
      recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", requiredSessionName],
      recoverStopped: ["npm", "run", "cli", "--", "runs", "recover-session", requiredSessionName, "--include-stopped"],
      resumeSession: ["npm", "run", "cli", "--", "runs", "resume-session", requiredSessionName],
      restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", requiredSessionName, "--recover"],
      restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", requiredSessionName, "--recover", "--resume-stopped"],
    };
    let polls = 0;
    let finalStatus = await workerSessionStatus(requiredSessionName, statusFilter);
    while (polls < maxPolls) {
      finalStatus = await workerSessionStatus(requiredSessionName, statusFilter);
      polls += 1;
      const workers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
      if (workers.every((worker) => !worker.alive)) break;
      if (polls >= maxPolls) break;
      await sleep(waitIntervalMs);
    }
    const finalWorkers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & {
      alive: boolean;
      runs: Array<SessionVisibleRun & { agentId: string }>;
    }>;
    const aliveWorkers = finalWorkers.filter((worker) => worker.alive).length;
    const recoveryPreview = options.recoverable === "1"
      ? await recoverableSessionRuns(finalStatus, options)
      : null;
    const recoverableActive = recoveryPreview?.filter((run) => run.currentStatus !== "stopped" && !run.skipped).length ?? 0;
    const recoverableStopped = recoveryPreview?.filter((run) => run.currentStatus === "stopped" && !run.skipped).length ?? 0;
    const resumableBranches = [
      ...finalWorkers.flatMap((worker) => worker.runs
        .filter((run) => run.status === "stopped" && run.resultCommit === null)),
      ...finalStatus.agents.flatMap((agent) => agent.unassigned
        .filter((run) => run.status === "stopped" && run.resultCommit === null)),
    ];
    const statuses: Record<string, number> = {};
    for (const agent of finalStatus.agents) {
      for (const [status, count] of Object.entries(agent.statuses)) {
        statuses[status] = (statuses[status] ?? 0) + count;
      }
    }
    const nextStep = aliveWorkers > 0
      ? {
        action: "continue_watch",
        reason: "workers_still_alive",
        command: actions.sessionSummaryWatch,
      }
      : recoverableActive > 0
        ? {
          action: "recover_session",
          reason: "stale_running_claims",
          count: recoverableActive,
          command: actions.recoverSession,
        }
        : resumableBranches.length > 0
          ? {
            action: "restart_session_with_stopped",
            reason: "dead_workers_and_resumable_branches",
            count: resumableBranches.length,
            command: actions.restartSessionWithStopped,
          }
          : recoverableStopped > 0
            ? {
              action: "recover_stopped",
              reason: "unfinished_stopped_branches",
              count: recoverableStopped,
              command: actions.recoverStopped,
            }
            : {
              action: "review_session",
              reason: "bounded_session_finished",
              command: actions.sessionReview,
            };
    await printJson({
      session: requiredSessionName,
      completed: aliveWorkers === 0,
      timedOut: aliveWorkers > 0,
      polls,
      intervalMs: waitIntervalMs,
      summary: {
        workers: {
          total: finalWorkers.length,
          alive: aliveWorkers,
          dead: finalWorkers.length - aliveWorkers,
        },
        agents: finalStatus.agents.length,
        runs: finalStatus.agents.reduce((sum, agent) => sum + agent.total, 0),
        statuses,
        resumableBranches: resumableBranches.length,
        recoveryCandidates: (recoveryPreview ?? []).filter((run) => !run.skipped).length,
        recoverableActive,
        recoverableStopped,
      },
      status: finalStatus,
      ...(recoveryPreview ? { recoveryPreview } : {}),
      commands: actions,
      nextStep,
    });
    return;
  }
  if (subcommandName === "session-actions") {
    const sessionName = required(args[0], "runs session-actions <session>");
    const session = await readWorkerSession(sessionName);
    const agentIds = workerSessionAgentIds(session);
    await printJson({
      session: {
        session: session.session,
        command: session.command,
        startedAt: session.startedAt,
        stoppedAt: session.stoppedAt ?? null,
        restartedAt: session.restartedAt ?? null,
        workers: session.workers.length,
      },
      actions: {
        sessionStatus: ["npm", "run", "cli", "--", "runs", "session-status", sessionName, "--recoverable", "--include-stopped"],
        sessionWait: ["npm", "run", "cli", "--", "runs", "session-wait", sessionName],
        sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", sessionName, "--recoverable", "--include-stopped", "--next"],
        sessionSummary: ["npm", "run", "cli", "--", "runs", "session-summary", sessionName, "--next"],
        sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", sessionName, "--next", "--max-polls", "30", "--interval-ms", "10000"],
        fleetSummary: ["npm", "run", "cli", "--", "runs", "sessions", "--session", sessionName, "--summary", "--next"],
        fleetSummaryWatch: ["npm", "run", "cli", "--", "runs", "sessions", "--session", sessionName, "--summary", "--next", "--max-polls", "30", "--interval-ms", "10000"],
        fleetNeedsAction: ["npm", "run", "cli", "--", "runs", "sessions", "--session", sessionName, "--summary", "--next", "--needs-action"],
        fleetNeedsActionWatch: ["npm", "run", "cli", "--", "runs", "sessions", "--session", sessionName, "--summary", "--next", "--needs-action", "--max-polls", "30", "--interval-ms", "10000"],
        monitor: ["npm", "run", "cli", "--", "runs", "monitor", "--agents", agentIds.join(","), "--status", "planned,running,stopped", "--next", "--checkout-dir", `./checkouts/${sessionName}-monitor`],
        sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", sessionName, "--include-stopped"],
        branchQueue: ["npm", "run", "cli", "--", "runs", "branches", "--session", sessionName, "--next"],
        results: ["npm", "run", "cli", "--", "runs", "results", "--session", sessionName],
        resultsNext: ["npm", "run", "cli", "--", "runs", "results", "--session", sessionName, "--next"],
        changedResults: [
          "npm",
          "run",
          "cli",
          "--",
          "runs",
          "results",
          "--session",
          sessionName,
          "--checkout-dir",
          `./checkouts/${sessionName}-results`,
          "--changed-only",
          "--next",
        ],
        checkoutSession: ["npm", "run", "cli", "--", "runs", "checkout-session", sessionName, "--dir", `./checkouts/${sessionName}`],
        sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", sessionName],
        stopSession: ["npm", "run", "cli", "--", "runs", "stop-session", sessionName, "--recover"],
        stopSessionIncludeStopped: ["npm", "run", "cli", "--", "runs", "stop-session", sessionName, "--recover", "--include-stopped"],
        recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", sessionName],
        recoverStopped: ["npm", "run", "cli", "--", "runs", "recover-session", sessionName, "--include-stopped"],
        resumeSession: ["npm", "run", "cli", "--", "runs", "resume-session", sessionName],
        restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", sessionName, "--recover"],
        restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", sessionName, "--recover", "--resume-stopped"],
        archiveSessionPreview: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", sessionName, "--dry-run"],
        archiveSession: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", sessionName],
      },
    });
    return;
  }
  if (subcommandName === "session-status") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-status --format must be json or shell");
    }
    if (options.next === "1" && options.recoverable !== "1") {
      throw new Error("runs session-status --next requires --recoverable");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs session-status --commands-only requires --next");
    }
    if (options["branch-action"] && options.next !== "1") {
      throw new Error("runs session-status --branch-action requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs session-status --format requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-status --format shell requires --commands-only");
    }
    const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
    const statusFilter = new Set(parseList(options.status ?? "planned,running,stopped"));
    const requiredSessionName = required(sessionName, "runs session-status <session>");
    const status = await workerSessionStatus(requiredSessionName, statusFilter);
    const recoveryPreview = options.recoverable === "1"
      ? await recoverableSessionRuns(status, options)
      : null;
    const recoverableStoppedRunIds = new Set((recoveryPreview ?? [])
      .filter((run) => run.currentStatus === "stopped" && !run.skipped)
      .map((run) => run.runId));
    const recoverStoppedCommand = recoverableStoppedRunIds.size > 0
      ? ["npm", "run", "cli", "--", "runs", "recover-session", status.session.session, "--include-stopped"]
      : null;
    const resumableCheckoutDir = `./checkouts/${status.session.session}-resumable`;
    const sessionWorkers = status.session.workers as Array<WorkerSession["workers"][number] & {
      runs: Array<SessionVisibleRun & { agentId: string }>;
    }>;
    const branchNextSteps = recoveryPreview ? [
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
    ].map((run) => ({
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
      command: ["npm", "run", "cli", "--", "runs", "resume-branch", run.runId],
      commands: {
        checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.runId, "--dir", `${resumableCheckoutDir}/${run.runId}`],
        resumeBranch: ["npm", "run", "cli", "--", "runs", "resume-branch", run.runId],
        recoverStopped: recoverableStoppedRunIds.has(run.runId) ? recoverStoppedCommand : null,
      },
    })) : null;
    const branchActionQueue = branchNextSteps
      ? branchActionFilter
        ? branchNextSteps.filter((item) => branchActionFilter.has(item.action))
        : branchNextSteps
      : [];
    const branchActions = branchActionQueue.reduce((counts, item) => {
      counts[item.action] = (counts[item.action] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    const [drainWorkerNextSteps, watchWorkerNextSteps] = options.next === "1" && !branchActionFilter
      ? await Promise.all([
        drainContinuationWorkerNextSteps(status.session.session),
        sessionWatchWorkerNextSteps(status.session.session),
      ])
      : [[], []];
    const drainWorkerActions = drainWorkerNextSteps.reduce((counts, item) => {
      counts[item.action] = (counts[item.action] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    const watchWorkerActions = watchWorkerNextSteps.reduce((counts, item) => {
      counts[item.action] = (counts[item.action] ?? 0) + 1;
      return counts;
    }, {} as Record<string, number>);
    const drainContinuationResetNextSteps = options.next === "1" && !branchActionFilter
      ? await workerSessionDrainContinuationResetNextSteps(status.session.session)
      : [];
    const drainContinuationResetActions = drainContinuationResetNextSteps.reduce((counts, item) => {
      counts[item.action] = (counts[item.action] ?? 0) + item.count;
      return counts;
    }, {} as Record<string, number>);
    const visibleBranchNextSteps = branchActionFilter && !branchActionFilter.has("resume_branch")
      ? []
      : branchNextSteps;
    const filter = {
      ...(branchActionFilter ? { branchAction: [...branchActionFilter] } : {}),
      ...(branchActionFilter ? { totalBranchNextSteps: branchNextSteps?.length ?? 0 } : {}),
    };
    const commandQueue: Array<Record<string, unknown> & { command: string[] }> = branchActionQueue.map((item) => ({
      scope: "branch",
      session: status.session.session,
      action: item.action,
      reason: item.reason,
      agentId: item.agentId,
      runId: item.runId,
      status: item.status,
      objective: item.objective,
      workerId: item.workerId,
      location: item.location,
      branchName: item.branchName,
      resultCommit: item.resultCommit,
      command: item.command,
    }));
    commandQueue.push(...drainWorkerNextSteps.map((item) => ({
      scope: "drain_worker",
      session: status.session.session,
      action: item.action,
      reason: item.reason,
      workerId: item.workerId,
      pid: item.pid,
      queuedContinuations: item.queuedContinuations,
      command: item.command,
    })));
    commandQueue.push(...watchWorkerNextSteps.map((item) => ({
      scope: "watch_worker",
      session: status.session.session,
      action: item.action,
      reason: item.reason,
      workerId: item.workerId,
      watchId: item.watchId,
      pid: item.pid,
      stoppedAt: item.stoppedAt,
      command: item.command,
    })));
    commandQueue.push(...drainContinuationResetNextSteps.map((item) => ({
      scope: "drain_continuation",
      session: status.session.session,
      action: item.action,
      reason: item.reason,
      count: item.count,
      continuationIds: item.continuationIds,
      olderThanMs: item.olderThanMs,
      command: item.command,
    })));
    const output = {
      observedAt: new Date().toISOString(),
      ...status,
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
      ...(recoveryPreview ? { recoveryPreview } : {}),
      ...(branchNextSteps && options["commands-only"] !== "1" ? { branchNextSteps: visibleBranchNextSteps } : {}),
      ...(options.next === "1" && options["commands-only"] !== "1" && !branchActionFilter ? { drainWorkerNextSteps } : {}),
      ...(options.next === "1" && options["commands-only"] !== "1" && !branchActionFilter ? { watchWorkerNextSteps } : {}),
      ...(options.next === "1" && options["commands-only"] !== "1" && !branchActionFilter ? { drainContinuationResetNextSteps } : {}),
      ...(options.next === "1" ? {
        branchActions,
        branchActionQueue,
        ...(branchActionFilter ? {} : { drainWorkerActions, watchWorkerActions, drainContinuationResetActions }),
      } : {}),
      ...(options["commands-only"] === "1" ? { commands: commandQueue } : {}),
    };
    if (outputFormat === "shell") {
      printCommandQueueShell(commandQueue);
    } else {
      await printJson(output);
    }
    return;
  }
  if (subcommandName === "session-summary") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-summary --format must be json or shell");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs session-summary --commands-only requires --next");
    }
    if (options.action && options.next !== "1") {
      throw new Error("runs session-summary --action requires --next");
    }
    if (options["branch-action"] && options.next !== "1") {
      throw new Error("runs session-summary --branch-action requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs session-summary --format requires --next");
    }
    if (options["older-than-ms"] && options.next !== "1") {
      throw new Error("runs session-summary --older-than-ms requires --next");
    }
    if (options.offset && options.next !== "1") {
      throw new Error("runs session-summary --offset requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-summary --format shell requires --commands-only");
    }
    const actionFilter = options.action ? new Set(parseList(options.action)) : null;
    const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
    const requiredSessionName = required(sessionName, "runs session-summary <session>");
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : 1;
    const rowLimit = options.limit ? parsePositiveInteger(options.limit, "--limit") : null;
    const rowOffset = options.offset ? parseNonNegativeInteger(options.offset, "--offset") : 0;
    const drainContinuationOlderThanMs = options["older-than-ms"]
      ? parsePositiveInteger(options["older-than-ms"], "--older-than-ms")
      : STALE_RUNNING_DRAIN_CONTINUATION_MS;
    const preserveOlderThanOption = options["older-than-ms"]
      ? ["--older-than-ms", String(drainContinuationOlderThanMs)]
      : [];
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const status = await workerSessionStatus(requiredSessionName, new Set(["planned", "running", "stopped"]));
      const sessionWorkerIds = new Set(status.session.workers.map((worker) => worker.workerId));
      const resultCheckoutDir = `./checkouts/${requiredSessionName}-results`;
      const resumableCheckoutDir = `./checkouts/${requiredSessionName}-resumable`;
      const agentIds = workerSessionAgentIds(status.session);
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
        for (const run of listed.runs) {
          statuses[run.status] = (statuses[run.status] ?? 0) + 1;
        }
        return {
          agentId,
          total: listed.runs.length,
          statuses,
          resultCommits: listed.runs.filter((run) => run.result_commit).length,
          resumableStopped: listed.runs.filter((run) => run.status === "stopped" && !run.result_commit).length,
          resumableBranchRows: listed.runs
            .filter((run) => run.status === "stopped" && !run.result_commit)
            .map((run) => ({
              agentId,
              runId: run.id,
              status: run.status,
              objective: run.objective,
              workerId: run.worker_id,
              location: run.worker_id === null
                ? "unassigned"
                : sessionWorkerIds.has(run.worker_id)
                  ? "session_worker"
                  : "other_worker",
              branchName: run.run_branch,
              resultCommit: run.result_commit,
              commands: {
                inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
                checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${resumableCheckoutDir}/${run.id}`],
                reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${resumableCheckoutDir}/${run.id}`],
                resumeBranch: ["npm", "run", "cli", "--", "runs", "resume-branch", run.id],
              },
            })),
          resultCommitRows: listed.runs
            .filter((run) => run.result_commit)
            .map((run) => ({
              agentId,
              runId: run.id,
              status: run.status,
              objective: run.objective,
              workerId: run.worker_id,
              location: run.worker_id === null
                ? "unassigned"
                : sessionWorkerIds.has(run.worker_id)
                  ? "session_worker"
                  : "other_worker",
              branchName: run.run_branch,
              resultCommit: run.result_commit,
              commands: {
                inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
                checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${resultCheckoutDir}/${run.id}`],
                reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${resultCheckoutDir}/${run.id}`],
              },
            })),
        };
      });
      const resumableBranches = agents.flatMap((agent) => agent.resumableBranchRows);
      const resultCommits = agents.flatMap((agent) => agent.resultCommitRows);
      const summaryAgents = agents.map(({ resumableBranchRows: _resumableBranchRows, resultCommitRows: _resultCommitRows, ...agent }) => agent);
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
      const aliveWorkers = sessionWorkers.filter((worker) => worker.alive).length;
      const drainContinuationResetNextSteps = options.next === "1"
        ? await workerSessionDrainContinuationResetNextSteps(requiredSessionName, drainContinuationOlderThanMs)
        : [];
      const drainContinuationResets = drainContinuationResetNextSteps.reduce((sum, step) => sum + step.count, 0);
      const commands = options.next === "1"
        ? {
          sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", requiredSessionName, "--recoverable", "--include-stopped", "--next"],
          sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", requiredSessionName, "--next", "--max-polls", "30", "--interval-ms", "10000", ...preserveOlderThanOption],
          sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", requiredSessionName, "--include-stopped"],
          results: ["npm", "run", "cli", "--", "runs", "results", "--session", requiredSessionName],
          resultsNext: ["npm", "run", "cli", "--", "runs", "results", "--session", requiredSessionName, "--next"],
          changedResults: [
            "npm",
            "run",
            "cli",
            "--",
            "runs",
            "results",
            "--session",
            requiredSessionName,
            "--checkout-dir",
            `./checkouts/${requiredSessionName}-results`,
            "--changed-only",
            "--next",
          ],
          checkoutSession: ["npm", "run", "cli", "--", "runs", "checkout-session", requiredSessionName, "--dir", `./checkouts/${requiredSessionName}`],
          recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", requiredSessionName],
          restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", requiredSessionName, "--recover"],
          restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", requiredSessionName, "--recover", "--resume-stopped"],
          archiveSessionPreview: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", requiredSessionName, "--dry-run"],
          archiveSession: ["npm", "run", "cli", "--", "runs", "archive-sessions", "--session", requiredSessionName],
        }
        : null;
      const drainContinuationResetNextStep = drainContinuationResetNextSteps[0]
        ? {
          action: drainContinuationResetNextSteps[0].action,
          reason: drainContinuationResetNextSteps[0].reason,
          count: drainContinuationResetNextSteps[0].count,
          command: drainContinuationResetNextSteps[0].command,
        }
        : null;
      const nextStep = commands
        ? drainContinuationResetNextStep ?? (aliveWorkers > 0
          ? {
            action: "continue_watch",
            reason: "workers_still_alive",
            command: commands.sessionSummaryWatch,
          }
          : (totals.statuses.running ?? 0) > 0
            ? {
              action: "recover_session",
              reason: "stale_running_claims",
              command: commands.recoverSession,
            }
            : totals.resumableStopped > 0
              ? {
                action: "restart_session_with_stopped",
                reason: "resumable_stopped_branches",
                command: commands.restartSessionWithStopped,
              }
              : (totals.statuses.planned ?? 0) > 0
                ? {
                  action: "restart_session",
                  reason: "planned_runs_waiting",
                  command: commands.restartSession,
                }
                : totals.resultCommits > 0
                  ? {
                    action: "inspect_results",
                    reason: "result_commits_available",
                    command: commands.resultsNext,
                  }
                  : totals.runs === 0
                    ? {
                      action: "archive_session_preview",
                      reason: "dead_session_without_runs",
                      command: commands.archiveSessionPreview,
                    }
                    : {
                      action: "review_session",
                      reason: "no_active_work",
                      command: commands.sessionReview,
                    })
        : null;
      const allActionQueue = nextStep
        ? [{
          session: requiredSessionName,
          action: nextStep.action,
          reason: nextStep.reason,
          ...("count" in nextStep ? { count: nextStep.count } : {}),
          command: nextStep.command,
        }]
        : [];
      const actionQueue = actionFilter
        ? allActionQueue.filter((item) => actionFilter.has(item.action))
        : allActionQueue;
      const nextActions = actionQueue.reduce((counts, item) => {
        counts[item.action] = (counts[item.action] ?? 0) + 1;
        return counts;
      }, {} as Record<string, number>);
      const allBranchActionQueue = [
        ...resumableBranches.map((run) => ({
          session: requiredSessionName,
          action: "resume_branch",
          reason: "stopped_branch_without_result_commit",
          agentId: run.agentId,
          runId: run.runId,
          status: run.status,
          objective: run.objective,
          workerId: run.workerId,
          location: run.location,
          branchName: run.branchName,
          resultCommit: run.resultCommit,
          command: run.commands.resumeBranch,
          commands: run.commands,
        })),
        ...resultCommits.map((run) => ({
          session: requiredSessionName,
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
      const branchActionQueue = branchActionFilter
        ? allBranchActionQueue.filter((item) => branchActionFilter.has(item.action))
        : allBranchActionQueue;
      const pageEnd = rowLimit ? rowOffset + rowLimit : undefined;
      const limitedBranchActionQueue = rowOffset > 0 || rowLimit
        ? branchActionQueue.slice(rowOffset, pageEnd)
        : branchActionQueue;
      const branchActions = limitedBranchActionQueue.reduce((counts, item) => {
        counts[item.action] = (counts[item.action] ?? 0) + 1;
        return counts;
      }, {} as Record<string, number>);
      const visibleResumableBranches = branchActionFilter && !branchActionFilter.has("resume_branch")
        ? []
        : rowOffset > 0 || rowLimit
          ? resumableBranches.slice(rowOffset, pageEnd)
          : resumableBranches;
      const visibleResultCommits = branchActionFilter && !branchActionFilter.has("review_branch")
        ? []
        : rowOffset > 0 || rowLimit
          ? resultCommits.slice(rowOffset, pageEnd)
          : resultCommits;
      const filter = {
        ...(actionFilter ? { action: [...actionFilter] } : {}),
        ...(branchActionFilter ? { branchAction: [...branchActionFilter] } : {}),
        ...(rowLimit || rowOffset > 0 ? {
          ...(rowLimit ? { limit: rowLimit } : {}),
          offset: rowOffset,
          totalResultCommits: resultCommits.length,
          visibleResultCommits: visibleResultCommits.length,
          totalResumableBranches: resumableBranches.length,
          visibleResumableBranches: visibleResumableBranches.length,
          totalQueuedBranchActions: branchActionQueue.length,
          visibleBranchActions: limitedBranchActionQueue.length,
          ...pageCursor(rowLimit, rowOffset, Math.max(resultCommits.length, resumableBranches.length, branchActionQueue.length)),
        } : {}),
        ...(actionFilter || branchActionFilter ? {
          totalActions: allActionQueue.length,
          totalBranchActions: allBranchActionQueue.length,
        } : {}),
      };
      const commandQueue = [
        ...actionQueue.map((item) => ({
          scope: "session",
          session: item.session,
          action: item.action,
          reason: item.reason,
          ...("count" in item ? { count: item.count } : {}),
          command: item.command,
        })),
        ...limitedBranchActionQueue.map((item) => ({
          scope: "branch",
          session: item.session,
          action: item.action,
          reason: item.reason,
          agentId: item.agentId,
          runId: item.runId,
          status: item.status,
          objective: item.objective,
          workerId: item.workerId,
          location: item.location,
          branchName: item.branchName,
          resultCommit: item.resultCommit,
          command: item.command,
        })),
      ];
      const output = {
        observedAt: new Date().toISOString(),
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        session: {
          session: status.session.session,
          command: status.session.command,
          startedAt: status.session.startedAt,
          stoppedAt: status.session.stoppedAt ?? null,
          restartedAt: status.session.restartedAt ?? null,
          workers: {
            total: sessionWorkers.length,
            alive: aliveWorkers,
            dead: sessionWorkers.length - aliveWorkers,
          },
        },
        totals,
        ...(commands ? { drainContinuationResets } : {}),
        ...(options["commands-only"] === "1"
          ? {}
          : {
            resumableBranches: visibleResumableBranches,
            resultCommits: visibleResultCommits,
            ...(commands ? { drainContinuationResetNextSteps } : {}),
          }),
        agents: summaryAgents,
        ...(commands ? {
          commands,
          nextStep,
          nextActions,
          actionQueue,
          branchActions,
          branchActionQueue: limitedBranchActionQueue,
        } : {}),
        ...(options["commands-only"] === "1" ? { commands: commandQueue } : {}),
      };
      if (outputFormat === "shell") {
        printCommandQueueShell(commandQueue);
      } else if (maxPolls === 1) {
        await printJson(output);
      } else {
        console.log(JSON.stringify(output));
        if (poll + 1 < maxPolls) await sleep(intervalMs);
      }
    }
    return;
  }
  if (subcommandName === "session-review") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-review --format must be json or shell");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs session-review --commands-only requires --next");
    }
    if (options.action && options.next !== "1") {
      throw new Error("runs session-review --action requires --next");
    }
    if (options["branch-action"] && options.next !== "1") {
      throw new Error("runs session-review --branch-action requires --next");
    }
    if (options.limit && options.next !== "1") {
      throw new Error("runs session-review --limit requires --next");
    }
    if (options.offset && options.next !== "1") {
      throw new Error("runs session-review --offset requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs session-review --format requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-review --format shell requires --commands-only");
    }
    const actionFilter = options.action ? new Set(parseList(options.action)) : null;
    const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
    const rowLimit = options.limit ? parsePositiveInteger(options.limit, "--limit") : null;
    const rowOffset = options.offset ? parseNonNegativeInteger(options.offset, "--offset") : 0;
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
    const filteredNextSteps = actionFilter
      ? nextSteps.filter((step) => actionFilter.has(step.action))
      : nextSteps;
    const filteredBranchNextSteps = branchActionFilter
      ? branchNextSteps.filter((step) => branchActionFilter.has(step.action))
      : branchNextSteps;
    const pageEnd = rowLimit ? rowOffset + rowLimit : undefined;
    const limitedNextSteps = rowOffset > 0 || rowLimit
      ? filteredNextSteps.slice(rowOffset, pageEnd)
      : filteredNextSteps;
    const limitedBranchNextSteps = rowOffset > 0 || rowLimit
      ? filteredBranchNextSteps.slice(rowOffset, pageEnd)
      : filteredBranchNextSteps;
    const commandQueue = [
      ...filteredNextSteps.map((step) => ({
        scope: "session",
        action: step.action,
        reason: step.reason,
        count: step.count,
        command: step.command,
      })),
      ...filteredBranchNextSteps.map((step) => ({
        scope: "branch",
        action: step.action,
        reason: step.reason,
        agentId: step.agentId,
        runId: step.runId,
        status: step.status,
        objective: step.objective,
        workerId: step.workerId,
        location: step.location,
        branchName: step.branchName,
        resultCommit: step.resultCommit,
        recoverable: "recoverable" in step ? step.recoverable : null,
        command: step.command,
      })),
    ];
    const limitedCommandQueue = rowOffset > 0 || rowLimit
      ? commandQueue.slice(rowOffset, pageEnd)
      : commandQueue;
    const filter = {
      ...(actionFilter ? { action: [...actionFilter] } : {}),
      ...(branchActionFilter ? { branchAction: [...branchActionFilter] } : {}),
      ...(actionFilter || branchActionFilter || rowLimit || rowOffset > 0 ? {
        totalNextSteps: nextSteps.length,
        totalBranchNextSteps: branchNextSteps.length,
      } : {}),
      ...(rowLimit || rowOffset > 0 ? {
        ...(rowLimit ? { limit: rowLimit } : {}),
        offset: rowOffset,
        visibleNextSteps: limitedNextSteps.length,
        visibleBranchNextSteps: limitedBranchNextSteps.length,
        totalCommands: commandQueue.length,
        visibleCommands: limitedCommandQueue.length,
        ...pageCursor(rowLimit, rowOffset, Math.max(filteredNextSteps.length, filteredBranchNextSteps.length, commandQueue.length)),
      } : {}),
    };
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
        sessionSummary: ["npm", "run", "cli", "--", "runs", "session-summary", status.session.session, "--next"],
        sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", status.session.session, "--next", "--max-polls", "30", "--interval-ms", "10000"],
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
    if (options.next === "1" && outputFormat === "shell") {
      printCommandQueueShell(limitedCommandQueue);
      return;
    }
    await printJson(options.next === "1"
      ? {
        observedAt: sessionReview.observedAt,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        session: sessionReview.session,
        summary,
        ...(options["commands-only"] === "1"
          ? { commands: limitedCommandQueue }
          : { nextSteps: limitedNextSteps, branchNextSteps: limitedBranchNextSteps }),
      }
      : sessionReview);
    return;
  }
  if (subcommandName === "session-apply") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-apply <session>");
    const queueSource = options.source ?? "review";
    if (queueSource !== "review" && queueSource !== "status" && queueSource !== "watch" && queueSource !== "branches") {
      throw new Error("runs session-apply --source must be review, status, watch, or branches");
    }
    const applyActionFilter = options["apply-action"] ? new Set(parseList(options["apply-action"])) : null;
    if (!options.action && !options["branch-action"] && !applyActionFilter) {
      throw new Error("runs session-apply requires --action, --apply-action, or --branch-action");
    }
    if (applyActionFilter && queueSource !== "watch") {
      throw new Error("runs session-apply --apply-action requires --source watch");
    }
    if (applyActionFilter && (options.action || options["branch-action"])) {
      throw new Error("runs session-apply --apply-action cannot be combined with --action or --branch-action");
    }
    if (
      applyActionFilter
      && [...applyActionFilter].some((action) => (
        action !== "retry_failed"
        && action !== "resume_pending"
        && action !== "review_ready_results"
        && action !== "inspect_drain_continuation_resets"
      ))
    ) {
      throw new Error("runs session-apply --apply-action must be retry_failed, resume_pending, review_ready_results, or inspect_drain_continuation_resets");
    }
    if (options["until-empty"] === "1") {
      if (queueSource !== "watch") {
        throw new Error("runs session-apply --until-empty requires --source watch");
      }
      if (options.resume === "1") {
        throw new Error("runs session-apply --until-empty cannot be combined with --resume");
      }
      if (options["continue-prefix"] && options["apply-id"]) {
        throw new Error("runs session-apply --continue-prefix cannot be combined with --apply-id");
      }
      const continuePrefix = options["continue-prefix"] ?? null;
      const applyIdPrefix = continuePrefix ?? options["apply-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");
      assertSafeSessionName(applyIdPrefix);
      const maxPolls = parsePositiveInteger(options["max-polls"] ?? "10", "--max-polls");
      const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
      let startPoll = 1;
      if (continuePrefix) {
        const applyRecords = await listSessionApplyRecords(requiredSessionName);
        const matchingRecords = applyRecords
          .map((record) => ({ record, parts: sessionApplyDrainParts(record.applyId) }))
          .filter((entry): entry is { record: SessionApplyRecord; parts: { prefix: string; poll: number } } => (
            entry.record.source === "watch" && entry.parts?.prefix === continuePrefix
          ));
        if (matchingRecords.length === 0) {
          throw new Error(`watch drain prefix ${continuePrefix} has no recorded apply polls`);
        }
        const doneRecord = matchingRecords.find((entry) => entry.record.selected === 0);
        if (doneRecord) {
          throw new Error(`watch drain prefix ${continuePrefix} is already done at ${doneRecord.record.applyId}`);
        }
        const failedRecord = matchingRecords.find((entry) => entry.record.executions.some((execution) => execution.exitCode !== 0));
        if (failedRecord) {
          throw new Error(`watch drain prefix ${continuePrefix} stopped on failure at ${failedRecord.record.applyId}; resume that apply before continuing`);
        }
        startPoll = Math.max(...matchingRecords.map((entry) => entry.parts.poll)) + 1;
      }
      const polls: Array<{
        poll: number;
        applyId: string;
        applyPath: string;
        selected: number;
        commandsToRun: number;
        unselectedQueueCommands: number;
        hasMore: boolean;
        exitCode: number | null;
        failed: number;
      }> = [];
      let done = false;
      let remaining = 0;
      const finalPoll = startPoll + maxPolls - 1;
      for (let poll = startPoll; poll <= finalPoll; poll += 1) {
        const pollApplyId = `${applyIdPrefix}-${String(poll).padStart(3, "0")}`;
        const pollResult = await runCliWorker([
          "runs",
          "session-apply",
          requiredSessionName,
          "--source",
          "watch",
          ...(options.action ? ["--action", options.action] : []),
          ...(options["apply-action"] ? ["--apply-action", options["apply-action"]] : []),
          ...(options["branch-action"] ? ["--branch-action", options["branch-action"]] : []),
          ...(options["include-stopped"] === "1" ? ["--include-stopped"] : []),
          ...(options.status ? ["--status", options.status] : []),
          ...(options["checkout-dir"] ? ["--checkout-dir", options["checkout-dir"]] : []),
          ...(options["changed-only"] === "1" ? ["--changed-only"] : []),
          ...(options["changed-path"] ? ["--changed-path", options["changed-path"]] : []),
          ...(options.limit ? ["--limit", options.limit] : []),
          ...(options.concurrency ? ["--concurrency", options.concurrency] : []),
          "--apply-id",
          pollApplyId,
          ...(options["dry-run"] === "1" ? ["--dry-run"] : []),
        ]);
        const pollOutput = parseJsonMaybe(pollResult.stdout) as {
          applyId?: string;
          applyPath?: string;
          selected?: number;
          commandsToRun?: unknown[];
          applySelection?: {
            unselectedQueueCommands?: number;
            hasMore?: boolean;
          };
          executions?: Array<{ exitCode: number | null }>;
        } | null;
        if (!pollOutput) {
          throw new Error(pollResult.stderr || pollResult.stdout || "runs session-apply --until-empty failed to parse poll output");
        }
        remaining = pollOutput.commandsToRun?.length ?? 0;
        const failed = pollOutput.executions?.filter((execution) => execution.exitCode !== 0).length ?? 0;
        polls.push({
          poll,
          applyId: pollOutput.applyId ?? pollApplyId,
          applyPath: pollOutput.applyPath ?? workerSessionApplyPath(requiredSessionName, pollApplyId),
          selected: pollOutput.selected ?? 0,
          commandsToRun: remaining,
          unselectedQueueCommands: pollOutput.applySelection?.unselectedQueueCommands ?? 0,
          hasMore: pollOutput.applySelection?.hasMore ?? false,
          exitCode: pollResult.exitCode,
          failed,
        });
        if ((pollOutput.selected ?? 0) === 0) {
          done = true;
          remaining = 0;
          break;
        }
        if (options["dry-run"] === "1") break;
        if (pollResult.exitCode !== 0) {
          process.exitCode = 1;
          break;
        }
        if (poll < finalPoll) await sleep(intervalMs);
      }
      const lastPoll = polls.at(-1) ?? null;
      const stoppedReason = done
        ? "empty"
        : options["dry-run"] === "1"
          ? "dry_run"
          : lastPoll && (lastPoll.exitCode !== 0 || lastPoll.failed > 0)
            ? "failed"
            : polls.length >= maxPolls
              ? "max_polls"
              : "stopped";
      await printJson({
        observedAt: new Date().toISOString(),
        session: requiredSessionName,
        source: queueSource,
        dryRun: options["dry-run"] === "1",
        applyIdPrefix,
        ...(continuePrefix ? { continuePrefix } : {}),
        untilEmpty: {
          done,
          remaining,
          unselectedQueueCommands: lastPoll?.unselectedQueueCommands ?? 0,
          hasMore: lastPoll?.hasMore ?? false,
          stoppedReason,
          polls: polls.length,
          startPoll,
          maxPolls,
        },
        polls,
      });
      return;
    }
    if (queueSource === "status") {
      const statusBranchActions = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
      const statusActions = options.action ? new Set(parseList(options.action)) : null;
      const allowedStatusActions = new Set([
        "reset_failed_drain_continuations",
        "reset_running_drain_continuations",
      ]);
      if (statusActions && statusBranchActions) {
        throw new Error("runs session-apply --source status cannot combine --action with --branch-action");
      }
      if (statusBranchActions && (statusBranchActions.size !== 1 || !statusBranchActions.has("resume_branch"))) {
        throw new Error("runs session-apply --source status supports --branch-action resume_branch only");
      }
      if (statusActions && [...statusActions].some((action) => !allowedStatusActions.has(action))) {
        throw new Error("runs session-apply --source status supports --action reset_failed_drain_continuations,reset_running_drain_continuations only");
      }
      if (options["checkout-dir"] || options["changed-only"] === "1" || options["changed-path"] || options["result-status"]) {
        throw new Error("runs session-apply --source status does not support result checkout filters");
      }
    }
    if (queueSource === "branches") {
      const branchesBranchActions = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
      if (options.action || applyActionFilter) {
        throw new Error("runs session-apply --source branches supports --branch-action only");
      }
      if (!branchesBranchActions || branchesBranchActions.size !== 1 || !branchesBranchActions.has("resume_branch")) {
        throw new Error("runs session-apply --source branches supports --branch-action resume_branch only");
      }
      if (options["include-stopped"] === "1" || options["changed-only"] === "1" || options["changed-path"] || options["result-status"]) {
        throw new Error("runs session-apply --source branches does not support include-stopped or result checkout filters");
      }
    }
    const applyId = options["apply-id"] ?? new Date().toISOString().replace(/[:.]/g, "-");
    assertSafeSessionName(applyId);
    const applyPath = workerSessionApplyPath(requiredSessionName, applyId);
    const existingApply = options.resume === "1"
      ? await readSessionApplyRecord(requiredSessionName, applyId)
      : null;
    if (options.resume !== "1" && options["apply-id"] && await pathExists(applyPath)) {
      throw new Error(`session apply ${applyId} already exists for ${requiredSessionName}; use --resume`);
    }
    const queueArgs = queueSource === "status"
      ? [
        "runs",
        "session-status",
        requiredSessionName,
        "--recoverable",
        "--next",
        "--commands-only",
        ...(options["include-stopped"] === "1" ? ["--include-stopped"] : []),
        ...(options.status ? ["--status", options.status] : []),
        ...(options["branch-action"] ? ["--branch-action", options["branch-action"]] : []),
      ]
      : queueSource === "watch"
        ? [
          "runs",
          "session-watch",
          requiredSessionName,
          "--recoverable",
          "--next",
          "--commands-only",
          "--action-queue",
          "--max-polls",
          "1",
          "--interval-ms",
          "1",
          ...(options["include-stopped"] === "1" ? ["--include-stopped"] : []),
          ...(options.status ? ["--status", options.status] : []),
          ...(options["checkout-dir"] ? ["--checkout-dir", options["checkout-dir"]] : []),
          ...(options["apply-action"] ? ["--apply-action", options["apply-action"]] : []),
          ...(options["changed-only"] === "1" ? ["--changed-only"] : []),
          ...(options["changed-path"] ? ["--changed-path", options["changed-path"]] : []),
        ]
      : queueSource === "branches"
        ? [
          "runs",
          "session-branches",
          requiredSessionName,
          "--server",
          "--resumable",
          "--commands-only",
          ...(options.status ? ["--status", options.status] : []),
          ...(options["worker-id"] ? ["--worker-id", options["worker-id"]] : []),
          ...(options["checkout-dir"] ? ["--checkout-dir", options["checkout-dir"]] : []),
        ]
      : [
        "runs",
        "session-review",
        requiredSessionName,
        "--next",
        "--commands-only",
        ...(options["include-stopped"] === "1" ? ["--include-stopped"] : []),
        ...(options.action ? ["--action", options.action] : []),
        ...(options["branch-action"] ? ["--branch-action", options["branch-action"]] : []),
        ...(options["checkout-dir"] ? ["--checkout-dir", options["checkout-dir"]] : []),
        ...(options["changed-only"] === "1" ? ["--changed-only"] : []),
        ...(options["changed-path"] ? ["--changed-path", options["changed-path"]] : []),
        ...(options["result-status"] ? ["--result-status", options["result-status"]] : []),
      ];
    const queueResult = await runCliWorker(queueArgs);
    if (queueResult.exitCode !== 0) {
      throw new Error(queueResult.stderr || queueResult.stdout || `runs session-apply failed to build ${queueSource} queue`);
    }
    const queue = JSON.parse(queueResult.stdout) as {
      observedAt: string;
      filter?: Record<string, unknown>;
      commands: Array<{
        scope: string;
        action: string;
        reason?: string;
        runId?: string;
        count?: number;
        continuationIds?: string[];
        olderThanMs?: number;
        command: string[];
      }>;
    };
    const queueCommands = queue.commands.map((item) => ({
      ...item,
      reason: item.reason ?? `${item.action}_from_${queueSource}_queue`,
    }));
    const actionFilter = options.action ? new Set(parseList(options.action)) : null;
    const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
    const filteredQueueCommands = queueSource === "watch" || queueSource === "status" || queueSource === "branches"
      ? queueCommands.filter((item) => (
        applyActionFilter
          ? item.scope === "apply" && applyActionFilter.has(item.action)
          : item.scope === "branch"
            ? branchActionFilter?.has(item.action)
            : actionFilter?.has(item.action)
      ))
      : queueCommands;
    const runFilter = options.run ? new Set(parseList(options.run)) : null;
    const limit = options.limit ? parsePositiveInteger(options.limit, "--limit") : null;
    const candidateQueueCommands = runFilter
      ? filteredQueueCommands.filter((item) => item.runId && runFilter.has(item.runId))
      : filteredQueueCommands;
    const selectedFromQueue = candidateQueueCommands.slice(0, limit ?? undefined);
    const selectedCommands = existingApply?.commands ?? selectedFromQueue;
    const applySelection = {
      totalQueueCommands: queueCommands.length,
      filteredQueueCommands: filteredQueueCommands.length,
      candidateQueueCommands: candidateQueueCommands.length,
      selectedQueueCommands: selectedFromQueue.length,
      unselectedQueueCommands: Math.max(candidateQueueCommands.length - selectedFromQueue.length, 0),
      hasMore: selectedFromQueue.length < candidateQueueCommands.length,
    };
    const resumeFilter = parseSessionApplyResumeFilter(options["resume-filter"] ?? "failed,pending");
    const commandStates = sessionApplyCommandStates(existingApply);
    const skippedCompleted = selectedCommands.filter((item) => commandStates.get(commandKey(item.command))?.succeeded).length;
    const pendingCommands = options.resume === "1"
      ? selectedCommands.filter((item) => {
        const state = commandStates.get(commandKey(item.command));
        if (state?.succeeded) return false;
        if (state?.failed) return resumeFilter.has("failed");
        return resumeFilter.has("pending");
      })
      : selectedCommands;
    const skippedByResumeFilter = options.resume === "1"
      ? selectedCommands.length - skippedCompleted - pendingCommands.length
      : 0;
    const responseBase = {
      observedAt: queue.observedAt,
      session: requiredSessionName,
      source: queueSource,
      applyId,
      applyPath,
      dryRun: options["dry-run"] === "1",
      resume: options.resume === "1",
      resumeFilter: options.resume === "1" ? [...resumeFilter] : [],
      filter: {
        ...(queue.filter ?? {}),
        ...(actionFilter ? { action: [...actionFilter] } : {}),
        ...(applyActionFilter ? { applyAction: [...applyActionFilter] } : {}),
        ...(branchActionFilter ? { branchAction: [...branchActionFilter] } : {}),
        ...(options["include-stopped"] === "1" ? { includeStopped: true } : {}),
        ...(options.status ? { status: parseList(options.status) } : {}),
        ...(runFilter ? { run: [...runFilter] } : {}),
        ...(limit ? { limit } : {}),
        ...(options["checkout-dir"] ? { checkoutDir: options["checkout-dir"] } : {}),
        ...(options["changed-only"] === "1" ? { changedOnly: true } : {}),
        ...(options["changed-path"] ? { changedPath: parseList(options["changed-path"]) } : {}),
      },
      selected: selectedCommands.length,
      skippedCompleted,
      skippedByResumeFilter,
      applySelection,
      commands: selectedCommands,
      commandsToRun: pendingCommands,
    };
    if (options["dry-run"] === "1") {
      await printJson(responseBase);
      return;
    }
    if ((queueSource === "status" || queueSource === "branches") && branchActionFilter?.has("resume_branch") && !actionFilter && !applyActionFilter) {
      const startedAt = existingApply?.startedAt ?? new Date().toISOString();
      const initialRecord = {
        ...responseBase,
        startedAt,
        updatedAt: new Date().toISOString(),
        executions: existingApply?.executions ?? [],
      };
      await writeSessionApplyRecord(initialRecord);
      if (pendingCommands.length === 0) {
        await printJson(initialRecord);
        return;
      }
      const resumeRunIds = pendingCommands.map((item) => required(item.runId, "resume_branch runId"));
      const resumePayload = {
        runIds: resumeRunIds,
        limit: resumeRunIds.length,
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
      };
      const resumeOutput = await requestJson("POST", `/api/worker-sessions/${encodeURIComponent(requiredSessionName)}/resume-branches`, resumePayload) as {
        resumed: Array<{
          runId: string;
          branchName: string;
          objective: string;
          resultCommit: string | null;
          workerId: string | null;
          status?: string;
          skipped?: string;
          run?: { status: string; worker_id: string | null };
        }>;
      };
      const resumedByRunId = new Map(resumeOutput.resumed.map((item) => [item.runId, item]));
      const executions = pendingCommands.map((item) => {
        const runId = required(item.runId, "resume_branch runId");
        const resumed = resumedByRunId.get(runId);
        const failed = !resumed || Boolean(resumed.skipped);
        const output = failed
          ? { ok: false, error: resumed?.skipped ?? "run was not resumed" }
          : {
            ok: true,
            resumed: {
              runId: resumed.runId,
              branchName: resumed.branchName,
              objective: resumed.objective,
              resultCommit: resumed.resultCommit,
              workerId: resumed.workerId,
              status: resumed.status,
            },
            run: resumed.run,
          };
        return {
          scope: item.scope,
          action: item.action,
          reason: item.reason,
          runId,
          command: item.command,
          exitCode: failed ? 1 : 0,
          stdout: JSON.stringify(output),
          stderr: failed ? String(output.error) : "",
          output,
        };
      });
      const allExecutions = [...(existingApply?.executions ?? []), ...executions];
      const record = {
        ...responseBase,
        startedAt,
        updatedAt: new Date().toISOString(),
        executions: allExecutions,
      };
      await writeSessionApplyRecord(record);
      if (executions.some((execution) => execution.exitCode !== 0)) process.exitCode = 1;
      await printJson({ ...record, executions: allExecutions });
      return;
    }
    if (queueSource === "status" && actionFilter && !branchActionFilter && !applyActionFilter) {
      await writeSessionApplyRecord({
        ...responseBase,
        startedAt: existingApply?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        executions: existingApply?.executions ?? [],
      });
      const executions = [];
      for (const item of pendingCommands) {
        try {
          const output = item.action === "reset_failed_drain_continuations"
            ? await resetFailedWorkerSessionDrainContinuations(requiredSessionName, { continuationIds: item.continuationIds })
            : await resetRunningWorkerSessionDrainContinuations(requiredSessionName, { olderThanMs: item.olderThanMs });
          executions.push({
            scope: item.scope,
            action: item.action,
            reason: item.reason,
            runId: item.runId ?? null,
            command: item.command,
            exitCode: 0,
            stdout: JSON.stringify(output),
            stderr: "",
            output,
          });
        } catch (error) {
          const output = { ok: false, error: error instanceof Error ? error.message : String(error) };
          executions.push({
            scope: item.scope,
            action: item.action,
            reason: item.reason,
            runId: item.runId ?? null,
            command: item.command,
            exitCode: 1,
            stdout: JSON.stringify(output),
            stderr: output.error,
            output,
          });
        }
      }
      const allExecutions = [...(existingApply?.executions ?? []), ...executions];
      const record = {
        ...responseBase,
        startedAt: existingApply?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        executions: allExecutions,
      };
      await writeSessionApplyRecord(record);
      if (executions.some((execution) => execution.exitCode !== 0)) process.exitCode = 1;
      await printJson({ ...record, executions: allExecutions });
      return;
    }
    await writeSessionApplyRecord({
      ...responseBase,
      startedAt: existingApply?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executions: existingApply?.executions ?? [],
    });
    const executions = await mapConcurrent(
      pendingCommands,
      parsePositiveInteger(options.concurrency ?? "1", "--concurrency"),
      async (item) => {
        const execution = await runCliWorker(cliCommandArgs(item.command));
        return {
          scope: item.scope,
          action: item.action,
          reason: item.reason,
          runId: item.runId ?? null,
          command: item.command,
          exitCode: execution.exitCode,
          stdout: execution.stdout,
          stderr: execution.stderr,
          output: parseJsonMaybe(execution.stdout),
        };
      },
    );
    const allExecutions = [...(existingApply?.executions ?? []), ...executions];
    const record = {
      ...responseBase,
      startedAt: existingApply?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      executions: allExecutions,
    };
    await writeSessionApplyRecord(record);
    if (executions.some((execution) => execution.exitCode !== 0)) process.exitCode = 1;
    await printJson({ ...record, executions: allExecutions });
    return;
  }
  if (subcommandName === "session-applies") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-applies <session>");
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("--format must be json or shell");
    }
    if (options.summary === "1" && outputFormat !== "json") {
      throw new Error("runs session-applies --summary requires --format json");
    }
    if (options["ready-results"] === "1" && outputFormat !== "shell") {
      throw new Error("runs session-applies --ready-results requires --format shell");
    }
    if (options["summary-group"] && outputFormat !== "shell") {
      throw new Error("runs session-applies --summary-group requires --format shell");
    }
    if (
      options["summary-group"]
      && options["summary-group"] !== "resume-needed"
      && options["summary-group"] !== "ready-to-review"
      && options["summary-group"] !== "drain-prefixes"
      && options["summary-group"] !== "drain-resets"
    ) {
      throw new Error("runs session-applies --summary-group must be resume-needed, ready-to-review, drain-prefixes, or drain-resets");
    }
    if (options["summary-group"] && options["ready-results"] === "1") {
      throw new Error("runs session-applies --summary-group cannot be combined with --ready-results");
    }
    if (options["action-queue"] === "1" && (options["summary-group"] || options["ready-results"] === "1")) {
      throw new Error("runs session-applies --action-queue cannot be combined with --summary-group or --ready-results");
    }
    if (options["action-queue"] === "1" && options.summary === "1") {
      throw new Error("runs session-applies --action-queue cannot be combined with --summary");
    }
    if (options["action-executions"] === "1" && outputFormat !== "json") {
      throw new Error("runs session-applies --action-executions requires json output");
    }
    if (options["action-executions"] === "1" && options["action-queue"] === "1") {
      throw new Error("runs session-applies --action-executions cannot be combined with --action-queue");
    }
    if (
      options["continue-drains"] === "1"
      && (
        outputFormat !== "json"
        || options["apply-id"]
        || options.summary === "1"
        || options["action-queue"] === "1"
        || options["summary-group"]
        || options["ready-results"] === "1"
      )
    ) {
      throw new Error("runs session-applies --continue-drains requires json output and cannot be combined with apply inspection or summary/action queue modes");
    }
    if (options["changed-only"] === "1" && !options["checkout-dir"]) {
      throw new Error("runs session-applies --changed-only requires --checkout-dir");
    }
    if (options["changed-path"] && !options["checkout-dir"]) {
      throw new Error("runs session-applies --changed-path requires --checkout-dir");
    }
    if (options["ack-reset-audit"] === "1" && !options["apply-id"]) {
      throw new Error("runs session-applies --ack-reset-audit requires --apply-id");
    }
    if (options["ack-reset-audit"] === "1" && outputFormat !== "json") {
      throw new Error("runs session-applies --ack-reset-audit requires json output");
    }
    if (options["ack-reset-audit"] === "1" && options["action-queue"] === "1") {
      throw new Error("runs session-applies --ack-reset-audit cannot be combined with --action-queue");
    }
    if (options.server === "1") {
      if (outputFormat !== "json" && !(outputFormat === "shell" && options["action-queue"] === "1")) {
        throw new Error("runs session-applies --server requires json output unless --action-queue --format shell is used");
      }
      if (options["ack-reset-audit"] === "1") {
        const applyId = required(
          options["apply-id"],
          "runs session-applies --server --ack-reset-audit requires --apply-id",
        );
        await printJson(await acknowledgeWorkerSessionApplyResetAudit(
          requiredSessionName,
          applyId,
          { dryRun: options["dry-run"] === "1" },
        ));
        return;
      }
      if (options["action-executions"] === "1") {
        await printJson(await fetchWorkerSessionApplyActionExecutions(requiredSessionName, {
          executionId: options.execution,
          applyId: options["apply-id"],
          action: options["apply-action"],
          status: options.status,
          limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
        }));
        return;
      }
      if (options["action-queue"] === "1") {
        if (options["execute-next"] === "1" && options["execute-queued"] === "1") {
          throw new Error("runs session-applies --server --action-queue cannot combine --execute-next and --execute-queued");
        }
        if (options["execute-queued"] === "1") {
          if (outputFormat !== "json") {
            throw new Error("runs session-applies --server --action-queue --execute-queued requires json output");
          }
          const executeOptions = {
            applyId: options["apply-id"],
            source: options.source,
            action: options["apply-action"],
            limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
            maxActions: options["max-actions"] ? parsePositiveInteger(options["max-actions"], "--max-actions") : null,
            stopOnFailure: options["continue-on-failure"] !== "1",
          };
          if (options.detach === "1") {
            const worker = await startDetachedApplyActionWorker(requiredSessionName, {
              workerId: options["worker-id"],
              ...executeOptions,
              untilEmpty: options["until-empty"] === "1",
              maxPolls: options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null,
              intervalMs: options["interval-ms"] ? parsePositiveInteger(options["interval-ms"], "--interval-ms") : null,
            });
            await printJson({ ok: true, session: requiredSessionName, worker });
            return;
          }
          const response = options["until-empty"] === "1"
            ? await executeQueuedWorkerSessionApplyActionLoop(requiredSessionName, {
              ...executeOptions,
              maxPolls: options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null,
              intervalMs: options["interval-ms"] ? parsePositiveInteger(options["interval-ms"], "--interval-ms") : null,
            })
            : await executeQueuedWorkerSessionApplyActions(requiredSessionName, executeOptions);
          if (applyActionExecutionResponses(response).some((execution) => execution.exitCode !== 0)) process.exitCode = 1;
          if (options["record-worker"]) {
            await completeApplyActionWorkerRunSummary(requiredSessionName, options["record-worker"], response);
          }
          await printJson(response);
          return;
        }
        if (options.detach === "1") {
          throw new Error("runs session-applies --server --action-queue --detach requires --execute-queued");
        }
        if (options["execute-next"] === "1") {
          if (outputFormat !== "json") {
            throw new Error("runs session-applies --server --action-queue --execute-next requires json output");
          }
          await printJson(await executeNextWorkerSessionApplyAction(requiredSessionName, {
            applyId: options["apply-id"],
            source: options.source,
            action: options["apply-action"],
            limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
          }));
          return;
        }
        const actionQueue = await fetchWorkerSessionApplyActions(requiredSessionName, {
          applyId: options["apply-id"],
          source: options.source,
          limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
        });
        if (outputFormat === "shell") {
          for (const action of actionQueue.actionQueue.actions) {
            console.log(action.command.map(shellArg).join(" "));
          }
          return;
        }
        await printJson(actionQueue);
        return;
      }
      if (
        options.summary === "1"
        || options["summary-group"]
        || options["ready-results"] === "1"
        || options["continue-drains"] === "1"
      ) {
        throw new Error("runs session-applies --server cannot be combined with local summary, action queue, or drain continuation modes");
      }
      await printJson(await fetchWorkerSessionApplies(requiredSessionName, {
        applyId: options["apply-id"],
        source: options.source,
        limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
      }));
      return;
    }
    if (options["apply-id"]) {
      const applyId = options["apply-id"];
      const record = await readSessionApplyRecord(requiredSessionName, applyId);
      if (!record) throw new Error(`session apply ${applyId} does not exist for ${requiredSessionName}`);
      const runStatusIndex = (
        outputFormat === "json"
        || options["ready-results"] === "1"
        || options["action-queue"] === "1"
        || options["summary-group"] === "ready-to-review"
      )
        ? await sessionApplyRunStatusIndex(requiredSessionName)
        : null;
      let summary = summarizeSessionApplyRecord(record, runStatusIndex);
      if (options["ack-reset-audit"] === "1") {
        if (summary.drainContinuationResetExecutions.length === 0) {
          throw new Error(`session apply ${applyId} has no drain continuation reset audit to acknowledge`);
        }
        const acknowledgedAt = record.resetAuditAcknowledgedAt ?? new Date().toISOString();
        const updatedRecord = {
          ...record,
          updatedAt: new Date().toISOString(),
          resetAuditAcknowledgedAt: acknowledgedAt,
          resetAuditAcknowledgedBy: "session-applies",
        };
        if (options["dry-run"] !== "1") {
          await writeSessionApplyRecord(updatedRecord);
        }
        summary = summarizeSessionApplyRecord(updatedRecord, runStatusIndex);
        await printJson({
          session: requiredSessionName,
          applyId,
          applyPath: workerSessionApplyPath(requiredSessionName, applyId),
          dryRun: options["dry-run"] === "1",
          resetAudit: {
            acknowledged: true,
            acknowledgedAt,
            acknowledgedBy: updatedRecord.resetAuditAcknowledgedBy,
          },
          summary,
          record: updatedRecord,
        });
        return;
      }
      if (outputFormat === "shell") {
        const command = sessionApplyShellCommand(summary, options);
        if (command) console.log(command.map(shellArg).join(" "));
        return;
      }
      if (options["action-queue"] === "1") {
        await printJson({
          session: requiredSessionName,
          applyId,
          applyPath: workerSessionApplyPath(requiredSessionName, applyId),
          actionQueue: summarizeSessionApplyActionQueue([summary], options),
        });
        return;
      }
      await printJson({
        session: requiredSessionName,
        applyId,
        applyPath: workerSessionApplyPath(requiredSessionName, applyId),
        summary,
        pendingCommands: summary.pendingCommands,
        failedExecutions: record.executions.filter((execution) => execution.exitCode !== 0),
        record,
      });
      return;
    }
    if (options["continue-drains"] === "1") {
      const readiness = await fetchWorkerSessionApplyDrains(requiredSessionName, options["drain-prefix"]);
      const drains = readiness.drains.filter((drain) => drain.continueCommand);
      const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null;
      const intervalMs = options["interval-ms"] ? parsePositiveInteger(options["interval-ms"], "--interval-ms") : null;
      const commands = drains.map((drain) => ({
        prefix: drain.prefix,
        nextApplyId: drain.nextApplyId,
        command: sessionApplyDrainContinueCommandWithOptions(drain.continueCommand as string[], {
          dryRun: options["dry-run"] === "1",
          maxPolls,
          intervalMs,
        }),
      }));
      const results = await mapConcurrent(
        commands,
        parsePositiveInteger(options.concurrency ?? "1", "--concurrency"),
        async (item) => {
          const result = await runCliWorker(cliCommandArgs(item.command));
          return {
            ...item,
            exitCode: result.exitCode,
            output: parseJsonMaybe(result.stdout),
            ...(result.stderr ? { stderr: result.stderr } : {}),
          };
        },
      );
      const observedAt = new Date().toISOString();
      const succeeded = results.filter((result) => result.exitCode === 0).length;
      const failed = results.filter((result) => result.exitCode !== 0).length;
      const continuation = await writeWorkerSessionDrainContinuationRecord({
        continuationId: createDrainContinuationId(observedAt),
        session: requiredSessionName,
        observedAt,
        status: failed > 0 ? "failed" : "executed",
        dryRun: options["dry-run"] === "1",
        filter: {
          ...(options["drain-prefix"] ? { drainPrefix: parseList(options["drain-prefix"]) } : {}),
          ...(maxPolls ? { maxPolls } : {}),
          ...(intervalMs ? { intervalMs } : {}),
          concurrency: parsePositiveInteger(options.concurrency ?? "1", "--concurrency"),
        },
        readinessSource: "server",
        readinessCounts: readiness.counts,
        continueDrains: {
          dryRun: options["dry-run"] === "1",
          selected: commands.length,
          succeeded,
          failed,
        },
        ...(failed > 0 ? { error: `drain continuation completed with ${failed} failed drain(s)` } : {}),
        drains: results,
      });
      if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
      await printJson({
        observedAt,
        session: requiredSessionName,
        continuationId: continuation.record.continuationId,
        continuationPath: continuation.path,
        readinessSource: "server",
        readinessCounts: readiness.counts,
        continueDrains: {
          dryRun: options["dry-run"] === "1",
          selected: commands.length,
          succeeded,
          failed,
        },
        drains: results,
      });
      return;
    }
    const records = await listSessionApplyRecords(requiredSessionName);
    if (outputFormat === "shell") {
      if (options["summary-group"] === "drain-prefixes") {
        const applies = records.map((record) => summarizeSessionApplyRecord(record));
        for (const drain of summarizeSessionApplies(applies).groups.drainPrefixes) {
          if (drain.continueCommand) console.log(drain.continueCommand.map(shellArg).join(" "));
        }
        return;
      }
      const runStatusIndex = (
        options["ready-results"] === "1"
        || options["action-queue"] === "1"
        || options["summary-group"] === "ready-to-review"
      )
        ? await sessionApplyRunStatusIndex(requiredSessionName)
        : null;
      for (const apply of records.map((record) => summarizeSessionApplyRecord(record, runStatusIndex))) {
        const command = sessionApplyShellCommand(apply, options);
        if (command) console.log(command.map(shellArg).join(" "));
      }
      return;
    }
    const runStatusIndex = await sessionApplyRunStatusIndex(requiredSessionName);
    const applies = records.map((record) => summarizeSessionApplyRecord(record, runStatusIndex));
    if (options["action-queue"] === "1") {
      await printJson({
        session: requiredSessionName,
        applyDir: workerSessionApplyDir(requiredSessionName),
        count: applies.length,
        actionQueue: summarizeSessionApplyActionQueue(applies, options),
      });
      return;
    }
    await printJson({
      session: requiredSessionName,
      applyDir: workerSessionApplyDir(requiredSessionName),
      count: applies.length,
      ...(options.summary === "1" ? { summary: summarizeSessionApplies(applies) } : {}),
      applies,
    });
    return;
  }
  if (subcommandName === "session-drains") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-drains <session>");
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("--format must be json or shell");
    }
    const response = await fetchWorkerSessionApplyDrains(requiredSessionName, options["drain-prefix"]);
    if (outputFormat === "shell") {
      for (const drain of response.drains) {
        if (drain.continueCommand) console.log(drain.continueCommand.map(shellArg).join(" "));
      }
      return;
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "session-drain-continuations") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-drain-continuations <session>");
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json") {
      throw new Error("runs session-drain-continuations only supports --format json");
    }
    if (options.queue === "1") {
      await printJson(await queueWorkerSessionDrainContinuations(requiredSessionName, {
        ...(options["drain-prefix"] ? { drainPrefix: parseList(options["drain-prefix"]) } : {}),
        dryRun: options["dry-run"] === "1",
        ...(options["max-polls"] ? { maxPolls: parsePositiveInteger(options["max-polls"], "--max-polls") } : {}),
        ...(options["interval-ms"] ? { intervalMs: parsePositiveInteger(options["interval-ms"], "--interval-ms") } : {}),
      }));
      return;
    }
    if (options.detach === "1") {
      if (options["execute-queued"] !== "1") {
        throw new Error("runs session-drain-continuations --detach requires --execute-queued");
      }
      const worker = await startDetachedDrainContinuationWorker(requiredSessionName, {
        workerId: options["worker-id"],
        ...(options["max-continuations"] ? { maxContinuations: parsePositiveInteger(options["max-continuations"], "--max-continuations") } : {}),
      });
      await printJson({ ok: true, session: requiredSessionName, worker });
      return;
    }
    if (options["reset-running"] === "1") {
      const response = await resetRunningWorkerSessionDrainContinuations(requiredSessionName, {
        ...(options["older-than-ms"] ? { olderThanMs: parsePositiveInteger(options["older-than-ms"], "--older-than-ms") } : {}),
      });
      await printJson(response);
      return;
    }
    if (options["reset-failed"] === "1") {
      const response = await resetFailedWorkerSessionDrainContinuations(requiredSessionName, {
        ...(options.continuation ? { continuationIds: parseList(options.continuation) } : {}),
      });
      await printJson(response);
      return;
    }
    if (options.execute) {
      const response = await executeWorkerSessionDrainContinuation(requiredSessionName, options.execute);
      if (response.continuation.continueDrains.failed > 0) process.exitCode = 1;
      await printJson(response);
      return;
    }
    if (options["execute-next"] === "1") {
      const response = await executeNextWorkerSessionDrainContinuation(requiredSessionName);
      if (response.continuation?.continueDrains.failed) process.exitCode = 1;
      await printJson(response);
      return;
    }
    if (options["execute-queued"] === "1") {
      const response = await executeQueuedWorkerSessionDrainContinuations(requiredSessionName, {
        ...(options["max-continuations"] ? { maxContinuations: parsePositiveInteger(options["max-continuations"], "--max-continuations") } : {}),
      });
      if (response.continuations.some((continuation) => continuation.continueDrains.failed > 0)) process.exitCode = 1;
      await printJson(response);
      return;
    }
    const response = await fetchWorkerSessionDrainContinuations(
      requiredSessionName,
      options.limit,
      options.status ? parseList(options.status) : undefined,
    );
    await printJson(response);
    return;
  }
  if (subcommandName === "session-drain-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      await printJson(await fetchWorkerSessionDrainWorkers(required(sessionName, "runs session-drain-workers <session> --server"), {
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      }));
      return;
    }
    const workers = await listDrainContinuationWorkers(
      {
        ...(sessionName ? { sessionName } : {}),
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        includeRetired: options["include-retired"] === "1",
      },
      parsePositiveInteger(options.lines ?? "20", "--lines"),
    );
    await printJson({
      session: sessionName ?? null,
      count: workers.length,
      workers,
    });
    return;
  }
  if (subcommandName === "stop-drain-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      const response = await stopWorkerSessionDrainWorkersViaServer(required(sessionName, "runs stop-drain-workers <session> --server"), {
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        retire: options.retire === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      });
      await printJson(response);
      return;
    }
    const response = await stopDrainContinuationWorkers(required(sessionName, "runs stop-drain-workers <session>"), {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
      retire: options.retire === "1",
      lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
    });
    await printJson(response);
    return;
  }
  if (subcommandName === "restart-drain-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      const response = await restartWorkerSessionDrainWorkerViaServer(required(sessionName, "runs restart-drain-workers <session> --server"), {
        workerId: required(options["worker-id"], "runs restart-drain-workers <session> --server --worker-id <id>"),
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      });
      await printJson(response);
      return;
    }
    const response = await restartDrainContinuationWorkers(required(sessionName, "runs restart-drain-workers <session>"), {
      workerId: required(options["worker-id"], "runs restart-drain-workers <session> --worker-id <id>"),
      includeRetired: options["include-retired"] === "1",
      lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
    });
    await printJson(response);
    return;
  }
  if (subcommandName === "ensure-drain-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs ensure-drain-worker requires --server");
    }
    await printJson(await ensureWorkerSessionDrainWorkerViaServer(
      required(sessionName, "runs ensure-drain-worker <session> --server"),
      {
        workerId: options["worker-id"],
        ...(options["max-continuations"] ? { maxContinuations: parsePositiveInteger(options["max-continuations"], "--max-continuations") } : {}),
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-apply-action-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      const requiredSessionName = required(sessionName, "runs session-apply-action-workers <session> --server");
      await printJson(await fetchWorkerSessionApplyActionWorkers(requiredSessionName, {
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      }));
      return;
    }
    const workers = await listApplyActionWorkers(
      {
        ...(sessionName ? { sessionName } : {}),
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        includeRetired: options["include-retired"] === "1",
      },
      parsePositiveInteger(options.lines ?? "20", "--lines"),
    );
    await printJson({
      session: sessionName ?? null,
      count: workers.length,
      workers,
    });
    return;
  }
  if (subcommandName === "session-apply-action-workers-next") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-apply-action-workers-next requires --server");
    }
    await printJson(await fetchWorkerSessionApplyActionWorkerNextSteps(
      required(sessionName, "runs session-apply-action-workers-next <session> --server"),
    ));
    return;
  }
  if (subcommandName === "ensure-apply-action-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs ensure-apply-action-worker requires --server");
    }
    await printJson(await ensureWorkerSessionApplyActionWorkerViaServer(
      required(sessionName, "runs ensure-apply-action-worker <session> --server"),
      {
        workerId: options["worker-id"],
        applyId: options["apply-id"],
        source: options.source,
        action: options["apply-action"],
        limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
        maxActions: options["max-actions"] ? parsePositiveInteger(options["max-actions"], "--max-actions") : null,
        continueOnFailure: options["continue-on-failure"] === "1",
        untilEmpty: options["until-empty"] === "1",
        maxPolls: options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : null,
        intervalMs: options["interval-ms"] ? parsePositiveInteger(options["interval-ms"], "--interval-ms") : null,
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-status") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-status requires --server");
    }
    const status = await fetchWorkerSessionControlPlaneStatus(
      required(sessionName, "runs session-control-plane-status <session> --server"),
      { lines: parsePositiveInteger(options.lines ?? "5", "--lines") },
    );
    await printJson(options.summary === "1"
      ? summarizeWorkerSessionControlPlaneStatus(status)
      : status);
    return;
  }
  if (subcommandName === "session-control-plane-alerts") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-alerts requires --server");
    }
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-control-plane-alerts --format must be json or shell");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-control-plane-alerts --format shell requires --commands-only");
    }
    const alerts = await fetchWorkerSessionControlPlaneAlerts(
      required(sessionName, "runs session-control-plane-alerts <session> --server"),
      {
        limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : 20,
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
        severity: options.severity,
        surface: options.surface,
        reason: options.reason,
        runId: options.run,
        workerId: options.worker,
        applyId: options.apply,
        executionId: options.execution,
        continuationId: options.continuation,
        action: options.action,
      },
    );
    if (options["commands-only"] === "1") {
      const commands = alerts.alerts.map((alert) => ({
        scope: "control_plane_alert",
        surface: alert.surface,
        severity: alert.severity,
        reason: alert.reason,
        count: alert.count,
        runId: alert.runId,
        workerId: alert.workerId,
        applyId: alert.applyId,
        executionId: alert.executionId,
        continuationIds: alert.continuationIds,
        action: alert.action,
        command: alert.command,
      }));
      if (outputFormat === "shell") {
        printCommandQueueShell(commands);
      } else {
        const { alerts: _alerts, ...rest } = alerts;
        await printJson({ ...rest, commands });
      }
      return;
    }
    await printJson(alerts);
    return;
  }
  if (subcommandName === "session-control-plane-alert") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-alert requires --server");
    }
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-control-plane-alert --format must be json or shell");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-control-plane-alert --format shell requires --commands-only");
    }
    const alert = await fetchWorkerSessionControlPlaneAlertPreview(
      required(sessionName, "runs session-control-plane-alert <session> --server"),
      {
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
        severity: options.severity,
        surface: options.surface,
        reason: options.reason,
        runId: options.run,
        workerId: options.worker,
        applyId: options.apply,
        executionId: options.execution,
        continuationId: options.continuation,
        action: options.action,
      },
    );
    if (options["commands-only"] === "1") {
      const commands = workerSessionControlPlaneAlertPreviewCommands(alert);
      if (outputFormat === "shell") {
        printCommandQueueShell(commands);
      } else {
        const { alert: _alert, preview: _preview, ...rest } = alert;
        await printJson({ ...rest, commands });
      }
      return;
    }
    await printJson(alert);
    return;
  }
  if (subcommandName === "session-control-plane-alert-execute") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-alert-execute requires --server");
    }
    const response = await executeWorkerSessionControlPlaneAlert(
      required(sessionName, "runs session-control-plane-alert-execute <session> --server"),
      {
        dryRun: options["dry-run"] === "1",
        confirm: options.confirm === "1",
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
        detailCommand: options["detail-command"],
        severity: options.severity,
        surface: options.surface,
        reason: options.reason,
        runId: options.run,
        workerId: options.worker,
        applyId: options.apply,
        executionId: options.execution,
        continuationId: options.continuation,
        action: options.action,
      },
    );
    if (response.executed?.exitCode !== undefined && response.executed.exitCode !== null && response.executed.exitCode !== 0) {
      process.exitCode = 1;
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "session-control-plane-advance") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-advance requires --server");
    }
    const response = await executeWorkerSessionControlPlaneAdvance(
      required(sessionName, "runs session-control-plane-advance <session> --server"),
      {
        dryRun: options["dry-run"] === "1",
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
      },
    );
    if (response.executed?.exitCode !== undefined && response.executed.exitCode !== null && response.executed.exitCode !== 0) {
      process.exitCode = 1;
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "session-control-plane-advance-loop") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-advance-loop requires --server");
    }
    const response = await executeWorkerSessionControlPlaneAdvanceLoop(
      required(sessionName, "runs session-control-plane-advance-loop <session> --server"),
      {
        dryRun: options["dry-run"] === "1",
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
        maxSteps: parsePositiveInteger(options["max-steps"] ?? "10", "--max-steps"),
        intervalMs: parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
      },
    );
    if (response.advances.some((advance) => (
      advance.executed?.exitCode !== undefined
      && advance.executed.exitCode !== null
      && advance.executed.exitCode !== 0
    ))) {
      process.exitCode = 1;
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "session-control-plane-advances") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    const requiredSessionName = required(sessionName, "runs session-control-plane-advances <session> --server");
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-advances requires --server");
    }
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-control-plane-advances --format must be json or shell");
    }
    const executeConfirmation = options["execute-confirmation"] === "1";
    const executeNextConfirmation = options["execute-next-confirmation"] === "1";
    const drainConfirmations = options["drain-confirmations"] === "1";
    const confirmationExecutionModes = [executeConfirmation, executeNextConfirmation, drainConfirmations].filter(Boolean).length;
    if (confirmationExecutionModes > 1) {
      throw new Error("runs session-control-plane-advances confirmation execution modes are mutually exclusive");
    }
    if (confirmationExecutionModes > 0 && outputFormat !== "json") {
      throw new Error("runs session-control-plane-advances confirmation execution requires json output");
    }
    if (confirmationExecutionModes > 0 && options["commands-only"] === "1") {
      throw new Error("runs session-control-plane-advances confirmation execution cannot be combined with --commands-only");
    }
    if (confirmationExecutionModes > 0 && options["confirmation-queue"] === "1") {
      throw new Error("runs session-control-plane-advances confirmation execution cannot be combined with --confirmation-queue");
    }
    if (confirmationExecutionModes > 0 && options.confirm !== "1") {
      throw new Error("runs session-control-plane-advances confirmation execution requires --confirm");
    }
    if (options["confirmation-queue"] === "1" && outputFormat !== "json" && options["commands-only"] !== "1") {
      throw new Error("runs session-control-plane-advances --confirmation-queue requires json output unless --commands-only is used");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-control-plane-advances --format shell requires --commands-only");
    }
    const limit = parsePositiveInteger(
      options.limit ?? (confirmationExecutionModes > 0 ? "100" : "20"),
      "--limit",
    );
    const advances = await fetchWorkerSessionControlPlaneAdvances(
      requiredSessionName,
      {
        limit,
        advanceId: options.advance ?? options["advance-id"],
        blocked: options.blocked === "1" || options["confirmation-queue"] === "1" || confirmationExecutionModes > 0 ? true : undefined,
        mutating: options.mutating === "1" || options["confirmation-queue"] === "1" || confirmationExecutionModes > 0 ? true : undefined,
      },
    );
    if (executeConfirmation || executeNextConfirmation) {
      const advance = executeConfirmation
        ? workerSessionControlPlaneAdvanceById(
          advances.advances,
          required(options["advance-id"], "runs session-control-plane-advances --execute-confirmation requires --advance-id"),
        )
        : workerSessionControlPlaneNextConfirmationAdvance(advances.advances);
      const response = await executeWorkerSessionControlPlaneAlert(
        requiredSessionName,
        workerSessionControlPlaneAdvanceConfirmationExecuteOptions(requiredSessionName, advance, {
          dryRun: options["dry-run"] === "1",
        }),
      );
      if (response.executed?.exitCode !== undefined && response.executed.exitCode !== null && response.executed.exitCode !== 0) {
        process.exitCode = 1;
      }
      await printJson({ ...response, sourceAdvanceId: advance.advanceId });
      return;
    }
    if (drainConfirmations) {
      const maxConfirmations = parsePositiveInteger(options["max-confirmations"] ?? "3", "--max-confirmations");
      const drainPage = async (page: WorkerSessionControlPlaneAdvancesResponse): Promise<{
        ok: true;
        session: string;
        dryRun: boolean;
        maxConfirmations: number;
        availableConfirmations: number;
        attemptedConfirmations: number;
        stoppedReason: "empty" | "drained" | "failed" | "max_confirmations";
        results: Array<WorkerSessionControlPlaneAlertExecuteResponse & { sourceAdvanceId: string }>;
      }> => {
        const commands = workerSessionControlPlaneAdvanceConfirmationCommands(page.advances);
        const selectedCommands = commands.slice(0, maxConfirmations);
        const results: Array<WorkerSessionControlPlaneAlertExecuteResponse & { sourceAdvanceId: string }> = [];
        let stoppedReason: "empty" | "drained" | "failed" | "max_confirmations" = selectedCommands.length === 0 ? "empty" : "drained";
        for (const command of selectedCommands) {
          const advance = workerSessionControlPlaneAdvanceById(page.advances, command.advanceId);
          const response = await executeWorkerSessionControlPlaneAlert(
            requiredSessionName,
            workerSessionControlPlaneAdvanceConfirmationExecuteOptions(requiredSessionName, advance, {
              dryRun: options["dry-run"] === "1",
            }),
          );
          results.push({ ...response, sourceAdvanceId: advance.advanceId });
          if (response.executed?.exitCode !== undefined && response.executed.exitCode !== null && response.executed.exitCode !== 0) {
            process.exitCode = 1;
            stoppedReason = "failed";
            break;
          }
        }
        if (stoppedReason === "drained" && commands.length > selectedCommands.length) {
          stoppedReason = "max_confirmations";
        }
        return {
          ok: true,
          session: requiredSessionName,
          dryRun: options["dry-run"] === "1",
          maxConfirmations,
          availableConfirmations: commands.length,
          attemptedConfirmations: results.length,
          stoppedReason,
          results,
        };
      };
      if (options["until-empty"] === "1") {
        const maxSteps = parsePositiveInteger(options["max-steps"] ?? "10", "--max-steps");
        const intervalMs = parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms");
        const cycles: Array<Awaited<ReturnType<typeof drainPage>>> = [];
        let stoppedReason: "empty" | "dry_run" | "failed" | "max_steps" = "max_steps";
        let page = advances;
        for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
          const cycle = await drainPage(page);
          cycles.push(cycle);
          if (cycle.stoppedReason === "empty") {
            stoppedReason = "empty";
            break;
          }
          if (cycle.stoppedReason === "failed") {
            stoppedReason = "failed";
            break;
          }
          if (options["dry-run"] === "1") {
            stoppedReason = "dry_run";
            break;
          }
          if (stepIndex + 1 < maxSteps) {
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
            page = await fetchWorkerSessionControlPlaneAdvances(requiredSessionName, {
              limit,
              blocked: true,
              mutating: true,
            });
          }
        }
        await printJson({
          ok: true,
          session: requiredSessionName,
          dryRun: options["dry-run"] === "1",
          untilEmpty: true,
          maxSteps,
          intervalMs,
          maxConfirmations,
          executedSteps: cycles.length,
          stoppedReason,
          availableConfirmations: cycles.at(-1)?.availableConfirmations ?? 0,
          attemptedConfirmations: cycles.reduce((total, cycle) => total + cycle.attemptedConfirmations, 0),
          cycles,
        });
        return;
      }
      await printJson(await drainPage(advances));
      return;
    }
    if (options["commands-only"] === "1") {
      const commands = workerSessionControlPlaneAdvanceConfirmationCommands(advances.advances);
      if (outputFormat === "shell") {
        printCommandQueueShell(commands);
      } else {
        const { advances: _advances, ...rest } = advances;
        await printJson({ ...rest, commands });
      }
      return;
    }
    if (options["confirmation-queue"] === "1") {
      const { advances: _advances, ...rest } = advances;
      await printJson({
        ...rest,
        confirmationQueue: workerSessionControlPlaneAdvanceConfirmationQueue(advances.advances),
      });
      return;
    }
    await printJson(advances);
    return;
  }
  if (subcommandName === "start-control-plane-advance-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs start-control-plane-advance-worker requires --server");
    }
    await printJson(await startWorkerSessionControlPlaneAdvanceWorker(
      required(sessionName, "runs start-control-plane-advance-worker <session> --server"),
      {
        workerId: options["worker-id"],
        dryRun: options["dry-run"] === "1",
        maxSteps: parsePositiveInteger(options["max-steps"] ?? "10", "--max-steps"),
        intervalMs: parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
        drainConfirmations: options["drain-confirmations"] === "1",
        confirm: options.confirm === "1",
        maxConfirmations: parsePositiveInteger(options["max-confirmations"] ?? "3", "--max-confirmations"),
        untilEmpty: options["until-empty"] === "1",
      },
    ));
    return;
  }
  if (subcommandName === "ensure-control-plane-advance-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs ensure-control-plane-advance-worker requires --server");
    }
    await printJson(await ensureWorkerSessionControlPlaneAdvanceWorker(
      required(sessionName, "runs ensure-control-plane-advance-worker <session> --server"),
      {
        workerId: options["worker-id"],
        dryRun: options["dry-run"] === "1",
        maxSteps: parsePositiveInteger(options["max-steps"] ?? "10", "--max-steps"),
        intervalMs: parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
        drainConfirmations: options["drain-confirmations"] === "1",
        confirm: options.confirm === "1",
        maxConfirmations: parsePositiveInteger(options["max-confirmations"] ?? "3", "--max-confirmations"),
        untilEmpty: options["until-empty"] === "1",
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-advance-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-advance-workers requires --server");
    }
    await printJson(await fetchWorkerSessionControlPlaneAdvanceWorkers(
      required(sessionName, "runs session-control-plane-advance-workers <session> --server"),
      {
        workerId: options["worker-id"],
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-advance-workers-next") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-advance-workers-next requires --server");
    }
    await printJson(await fetchWorkerSessionControlPlaneAdvanceWorkerNextSteps(
      required(sessionName, "runs session-control-plane-advance-workers-next <session> --server"),
      { workerId: options["worker-id"] },
    ));
    return;
  }
  if (subcommandName === "restart-control-plane-advance-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs restart-control-plane-advance-workers requires --server");
    }
    await printJson(await restartWorkerSessionControlPlaneAdvanceWorker(
      required(sessionName, "runs restart-control-plane-advance-workers <session> --server"),
      {
        workerId: required(options["worker-id"], "runs restart-control-plane-advance-workers <session> --server --worker-id <id>"),
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "stop-control-plane-advance-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs stop-control-plane-advance-workers requires --server");
    }
    await printJson(await stopWorkerSessionControlPlaneAdvanceWorkers(
      required(sessionName, "runs stop-control-plane-advance-workers <session> --server"),
      {
        workerId: options["worker-id"],
        retire: options.retire === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-tick") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-tick requires --server");
    }
    await printJson(await executeWorkerSessionControlPlaneTick(
      required(sessionName, "runs session-control-plane-tick <session> --server"),
      {
        dryRun: options["dry-run"] === "1",
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-tick-loop") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-tick-loop requires --server");
    }
    await printJson(await executeWorkerSessionControlPlaneTickLoop(
      required(sessionName, "runs session-control-plane-tick-loop <session> --server"),
      {
        dryRun: options["dry-run"] === "1",
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
        maxTicks: parsePositiveInteger(options["max-ticks"] ?? "10", "--max-ticks"),
        intervalMs: parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-ticks") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-control-plane-ticks <session>");
    const limit = options.limit ? parsePositiveInteger(options.limit, "--limit") : 20;
    const tickIds = options.tick ? parseList(options.tick) : [];
    await printJson(options.server === "1"
      ? await fetchWorkerSessionControlPlaneTicks(requiredSessionName, { limit, tickIds })
      : await listWorkerSessionControlPlaneTickRecords(requiredSessionName, { limit, tickIds }));
    return;
  }
  if (subcommandName === "session-control-plane-timeline") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-timeline requires --server");
    }
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-control-plane-timeline --format must be json or shell");
    }
    if (options.summary === "1" && options["commands-only"] === "1") {
      throw new Error("runs session-control-plane-timeline --summary cannot be combined with --commands-only");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-control-plane-timeline --format shell requires --commands-only");
    }
    const lines = parsePositiveInteger(options.lines ?? "5", "--lines");
    const requiredSessionName = required(sessionName, "runs session-control-plane-timeline <session> --server");
    const timeline = await fetchWorkerSessionControlPlaneTimeline(
      requiredSessionName,
      {
        limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : 20,
        lines,
        source: options.source,
        event: options.event,
        status: options.status,
        tickId: options.tick,
        advanceId: options.advance,
        workerId: options.worker,
        executionId: options.execution,
        applyId: options.apply,
        runId: options.run,
      },
    );
    if (options["commands-only"] === "1") {
      const commands = workerSessionControlPlaneTimelineCommands(timeline);
      if (outputFormat === "shell") {
        printCommandQueueShell(commands);
      } else {
        const { events, ...rest } = timeline;
        await printJson({ ...rest, commands });
      }
      return;
    }
    await printJson(options.summary === "1"
      ? summarizeWorkerSessionControlPlaneTimeline(timeline, lines)
      : timeline);
    return;
  }
  if (subcommandName === "start-control-plane-tick-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs start-control-plane-tick-worker requires --server");
    }
    await printJson(await startWorkerSessionControlPlaneTickWorker(
      required(sessionName, "runs start-control-plane-tick-worker <session> --server"),
      {
        workerId: options["worker-id"],
        dryRun: options["dry-run"] === "1",
        maxTicks: parsePositiveInteger(options["max-ticks"] ?? "10", "--max-ticks"),
        intervalMs: parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
        lines: parsePositiveInteger(options.lines ?? "5", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "ensure-control-plane-tick-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs ensure-control-plane-tick-worker requires --server");
    }
    await printJson(await ensureWorkerSessionControlPlaneTickWorker(
      required(sessionName, "runs ensure-control-plane-tick-worker <session> --server"),
      {
        workerId: options["worker-id"],
        dryRun: options["dry-run"] === "1",
        maxTicks: parsePositiveInteger(options["max-ticks"] ?? "10", "--max-ticks"),
        intervalMs: parseNonNegativeInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-tick-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-tick-workers requires --server");
    }
    await printJson(await fetchWorkerSessionControlPlaneTickWorkers(
      required(sessionName, "runs session-control-plane-tick-workers <session> --server"),
      {
        workerId: options["worker-id"],
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-control-plane-tick-workers-next") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs session-control-plane-tick-workers-next requires --server");
    }
    await printJson(await fetchWorkerSessionControlPlaneTickWorkerNextSteps(
      required(sessionName, "runs session-control-plane-tick-workers-next <session> --server"),
      { workerId: options["worker-id"] },
    ));
    return;
  }
  if (subcommandName === "restart-control-plane-tick-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs restart-control-plane-tick-workers requires --server");
    }
    await printJson(await restartWorkerSessionControlPlaneTickWorker(
      required(sessionName, "runs restart-control-plane-tick-workers <session> --server"),
      {
        workerId: required(options["worker-id"], "runs restart-control-plane-tick-workers <session> --server --worker-id <id>"),
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "stop-control-plane-tick-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server !== "1") {
      throw new Error("runs stop-control-plane-tick-workers requires --server");
    }
    await printJson(await stopWorkerSessionControlPlaneTickWorkers(
      required(sessionName, "runs stop-control-plane-tick-workers <session> --server"),
      {
        workerId: options["worker-id"],
        retire: options.retire === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      },
    ));
    return;
  }
  if (subcommandName === "session-branch-recovery-executions") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (options.server !== "1") {
      throw new Error("runs session-branch-recovery-executions requires --server");
    }
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-branch-recovery-executions --format must be json or shell");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-branch-recovery-executions --format shell requires --commands-only");
    }
    const requiredSessionName = required(sessionName, "runs session-branch-recovery-executions <session> --server");
    const response = await fetchWorkerSessionBranchRecoveryExecutions(
      requiredSessionName,
      {
        executionId: options.execution,
        runId: options.run,
        status: options.status,
        limit: options.limit ? parsePositiveInteger(options.limit, "--limit") : null,
      },
    );
    if (options["commands-only"] === "1") {
      const commands = workerSessionBranchRecoveryExecutionCommands(requiredSessionName, response.executions, {
        checkoutRoot: options["checkout-dir"] ?? `./checkouts/${requiredSessionName}-branch-recovery`,
      });
      if (outputFormat === "shell") {
        printCommandQueueShell(commands);
      } else {
        const { executions, ...rest } = response;
        await printJson({ ...rest, commands });
      }
      return;
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "session-branches") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const outputFormat = options.format ?? "json";
    if (options.server !== "1") {
      throw new Error("runs session-branches requires --server");
    }
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-branches --format must be json or shell");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-branches --format shell requires --commands-only");
    }
    const branchActionFilter = options["branch-action"] ? new Set(parseList(options["branch-action"])) : null;
    if (branchActionFilter && [...branchActionFilter].some((action) => action !== "resume_branch" && action !== "review_branch")) {
      throw new Error("runs session-branches --branch-action must be resume_branch or review_branch");
    }
    const response = await fetchWorkerSessionBranches(
      required(sessionName, "runs session-branches <session> --server"),
      {
        ...(options.status ? { status: options.status } : {}),
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        ...(options["checkout-dir"] ? { checkoutDir: options["checkout-dir"] } : {}),
        ...(options["branch-action"] ? { branchAction: options["branch-action"] } : {}),
        ...(options.run ? { runId: options.run } : {}),
        ...(options.limit ? { limit: parsePositiveInteger(options.limit, "--limit") } : {}),
        ...(options.offset ? { offset: parseNonNegativeInteger(options.offset, "--offset") } : {}),
        resumable: options.resumable === "1",
      },
    );
    if (options["commands-only"] === "1") {
      const commands = response.nextSteps.map((step) => ({
        scope: "branch",
        action: step.action,
        reason: step.reason,
        agentId: step.agentId,
        runId: step.runId,
        status: step.status,
        state: step.state,
        warning: step.warning,
        workerId: step.workerId,
        location: step.location,
        branchName: step.branchName,
        resultCommit: step.resultCommit,
        command: step.command,
      }));
      if (outputFormat === "shell") {
        printCommandQueueShell(commands);
      } else {
        const { agents, nextSteps, ...rest } = response;
        await printJson({ ...rest, commands });
      }
      return;
    }
    await printJson(response);
    return;
  }
  if (subcommandName === "stop-apply-action-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      const requiredSessionName = required(sessionName, "runs stop-apply-action-workers <session> --server");
      await printJson(await stopWorkerSessionApplyActionWorkersViaServer(requiredSessionName, {
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        retire: options.retire === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      }));
      return;
    }
    const response = await stopApplyActionWorkers(required(sessionName, "runs stop-apply-action-workers <session>"), {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
      retire: options.retire === "1",
      lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
    });
    await printJson(response);
    return;
  }
  if (subcommandName === "restart-apply-action-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options.server === "1") {
      const requiredSessionName = required(sessionName, "runs restart-apply-action-workers <session> --server");
      await printJson(await restartWorkerSessionApplyActionWorkerViaServer(requiredSessionName, {
        workerId: required(options["worker-id"], "runs restart-apply-action-workers <session> --server --worker-id <id>"),
        includeRetired: options["include-retired"] === "1",
        lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
      }));
      return;
    }
    const response = await restartApplyActionWorkers(required(sessionName, "runs restart-apply-action-workers <session>"), {
      workerId: required(options["worker-id"], "runs restart-apply-action-workers <session> --worker-id <id>"),
      includeRetired: options["include-retired"] === "1",
      lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
    });
    await printJson(response);
    return;
  }
  if (subcommandName === "start-session-watch-worker") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    if (options["apply-action"] && options["action-queue"] !== "1") {
      throw new Error("runs start-session-watch-worker --apply-action requires --action-queue");
    }
    const worker = await startDetachedSessionWatchWorker(required(sessionName, "runs start-session-watch-worker <session>"), {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
      ...(options["watch-id"] ? { watchId: options["watch-id"] } : {}),
      maxPolls: parsePositiveInteger(options["max-polls"] ?? "60", "--max-polls"),
      intervalMs: parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms"),
      recoverable: options.recoverable === "1",
      includeStopped: options["include-stopped"] === "1",
      actionQueue: options["action-queue"] === "1",
      ...(options["apply-action"] ? { applyAction: options["apply-action"] } : {}),
    });
    await printJson(worker);
    return;
  }
  if (subcommandName === "session-watch-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const workers = await listSessionWatchWorkers(
      {
        ...(sessionName ? { sessionName } : {}),
        ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
        includeRetired: options["include-retired"] === "1",
      },
      parsePositiveInteger(options.lines ?? "20", "--lines"),
    );
    await printJson({
      session: sessionName ?? null,
      count: workers.length,
      workers,
    });
    return;
  }
  if (subcommandName === "stop-session-watch-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const response = await stopSessionWatchWorkers(required(sessionName, "runs stop-session-watch-workers <session>"), {
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
      retire: options.retire === "1",
      lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
    });
    await printJson(response);
    return;
  }
  if (subcommandName === "restart-session-watch-workers") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const response = await restartSessionWatchWorkers(required(sessionName, "runs restart-session-watch-workers <session>"), {
      workerId: required(options["worker-id"], "runs restart-session-watch-workers <session> --worker-id <id>"),
      includeRetired: options["include-retired"] === "1",
      lines: parsePositiveInteger(options.lines ?? "20", "--lines"),
    });
    await printJson(response);
    return;
  }
  if (subcommandName === "session-watches") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-watches <session>");
    const watches = options["watch-id"]
      ? [await readSessionWatchRecord(requiredSessionName, options["watch-id"])].filter((watch): watch is SessionWatchRecord => watch !== null)
      : await listSessionWatchRecords(requiredSessionName);
    await printJson({
      session: requiredSessionName,
      count: watches.length,
      watches: watches.slice(0, parsePositiveInteger(options.limit ?? "20", "--limit")),
    });
    return;
  }
  if (subcommandName === "session-watch") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs session-watch <session>");
    const outputFormat = options.format ?? "json";
    if (outputFormat !== "json" && outputFormat !== "shell") {
      throw new Error("runs session-watch --format must be json or shell");
    }
    if (options["commands-only"] === "1" && options.next !== "1") {
      throw new Error("runs session-watch --commands-only requires --next");
    }
    if (options.format && options.next !== "1") {
      throw new Error("runs session-watch --format requires --next");
    }
    if (outputFormat === "shell" && options["commands-only"] !== "1") {
      throw new Error("runs session-watch --format shell requires --commands-only");
    }
    const applyActionFilter = options["apply-action"] ? new Set(parseList(options["apply-action"])) : null;
    if (applyActionFilter && (options.next !== "1" || options["action-queue"] !== "1")) {
      throw new Error("runs session-watch --apply-action requires --next --action-queue");
    }
    if (
      applyActionFilter
      && [...applyActionFilter].some((action) => (
        action !== "retry_failed"
        && action !== "resume_pending"
        && action !== "review_ready_results"
        && action !== "inspect_drain_continuation_resets"
      ))
    ) {
      throw new Error("runs session-watch --apply-action must be retry_failed, resume_pending, review_ready_results, or inspect_drain_continuation_resets");
    }
    const untilEmpty = options["until-empty"] === "1";
    if (untilEmpty && options.next !== "1") {
      throw new Error("runs session-watch --until-empty requires --next");
    }
    if (untilEmpty && outputFormat === "shell") {
      throw new Error("runs session-watch --until-empty requires json output");
    }
    if (options["watch-id"] && outputFormat === "shell") {
      throw new Error("runs session-watch --watch-id requires json output");
    }
    const watchId = options["watch-id"] ?? null;
    if (watchId) assertSafeSessionName(watchId);
    const statusFilter = new Set(parseList(options.status ?? "planned,running,stopped"));
    const intervalMs = parsePositiveInteger(options["interval-ms"] ?? "2000", "--interval-ms");
    const maxPolls = options["max-polls"] ? parsePositiveInteger(options["max-polls"], "--max-polls") : outputFormat === "shell" ? 1 : untilEmpty ? 60 : null;
    if (outputFormat === "shell" && maxPolls !== 1) {
      throw new Error("runs session-watch --format shell supports one poll");
    }
    const branchCheckoutDir = options["checkout-dir"] ?? `./checkouts/${requiredSessionName}-resumable`;
    const actionQueueOptions = { ...options, "checkout-dir": branchCheckoutDir };
    let polls = 0;
    let watchRecord: SessionWatchRecord | null = null;
    if (watchId) {
      const startedAt = new Date().toISOString();
      watchRecord = {
        session: requiredSessionName,
        watchId,
        watchPath: workerSessionWatchPath(requiredSessionName, watchId),
        startedAt,
        updatedAt: startedAt,
        status: "running",
        command: ["runs", "session-watch", requiredSessionName, ...optionArgs],
        filter: {
          status: [...statusFilter],
          recoverable: options.recoverable === "1",
          includeStopped: options["include-stopped"] === "1",
          next: options.next === "1",
          actionQueue: options["action-queue"] === "1",
          untilEmpty,
          checkoutDir: branchCheckoutDir,
          intervalMs,
          ...(maxPolls !== null ? { maxPolls } : {}),
          ...(applyActionFilter ? { applyAction: [...applyActionFilter] } : {}),
        },
        polls: [],
      };
      await writeSessionWatchRecord(watchRecord);
    }
    while (true) {
      let commandQueueLength: number | null = null;
      const status = await workerSessionStatus(requiredSessionName, statusFilter);
      const recoveryPreview = options.recoverable === "1"
        ? await recoverableSessionRuns(status, options)
        : null;
      const applyActionQueue = options["action-queue"] === "1"
        ? await sessionApplyActionQueue(requiredSessionName, actionQueueOptions)
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
            .map((run) => ({
              agentId: run.agentId,
              runId: run.id,
              objective: run.objective,
              branchName: run.branchName,
              resultCommit: run.resultCommit,
              workerId: worker.workerId,
              location: "session_worker",
            }))),
          ...status.agents.flatMap((agent) => agent.unassigned
            .filter((run) => run.status === "stopped" && run.resultCommit === null)
            .map((run) => ({
              agentId: agent.agentId,
              runId: run.id,
              objective: run.objective,
              branchName: run.branchName,
              resultCommit: run.resultCommit,
              workerId: null,
              location: "unassigned",
            }))),
        ];
        const recoverableActive = recoveryPreview?.filter((run) => run.currentStatus !== "stopped" && !run.skipped).length ?? 0;
        const recoverableStopped = recoveryPreview?.filter((run) => run.currentStatus === "stopped" && !run.skipped).length ?? 0;
        const recoverableStoppedRunIds = new Set((recoveryPreview ?? [])
          .filter((run) => run.currentStatus === "stopped" && !run.skipped)
          .map((run) => run.runId));
        const recoverStoppedCommand = recoverableStopped > 0
          ? ["npm", "run", "cli", "--", "runs", "recover-session", status.session.session, "--include-stopped"]
          : null;
        const branchNextSteps = resumableBranches.map((run) => ({
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
          command: ["npm", "run", "cli", "--", "runs", "resume-branch", run.runId],
          commands: {
            checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.runId, "--dir", `${branchCheckoutDir}/${run.runId}`],
            inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.runId],
            reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.runId, "--checkout-dir", `${branchCheckoutDir}/${run.runId}`],
            watchRun: ["npm", "run", "cli", "--", "runs", "watch", run.runId, "--checkout-dir", `${branchCheckoutDir}/${run.runId}`],
            resumeBranch: ["npm", "run", "cli", "--", "runs", "resume-branch", run.runId],
            recoverStopped: recoverableStoppedRunIds.has(run.runId) ? recoverStoppedCommand : null,
          },
        }));
        const statuses: Record<string, number> = {};
        for (const agent of status.agents) {
          for (const [runStatus, count] of Object.entries(agent.statuses)) {
            statuses[runStatus] = (statuses[runStatus] ?? 0) + count;
          }
        }
        const nextSteps = [
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
            command: recoverStoppedCommand,
          }] : []),
          ...(resumableBranches.length > 0 ? [{
            action: "resume_session",
            reason: "resumable_branch_runs",
            count: resumableBranches.length,
            command: ["npm", "run", "cli", "--", "runs", "resume-session", status.session.session],
          }] : []),
        ].filter((step): step is {
          action: string;
          reason: string;
          count: number;
          command: string[];
        } => step.command !== null);
        const [drainWorkerNextSteps, watchWorkerNextSteps] = await Promise.all([
          drainContinuationWorkerNextSteps(status.session.session),
          sessionWatchWorkerNextSteps(status.session.session),
        ]);
        const branchRecoveryExecutions = await listWorkerSessionBranchRecoveryExecutionRecords(
          process.cwd(),
          status.session.session,
          5,
        );
        const branchRecoveryExecutionCounts = summarizeBranchRecoveryExecutionStatuses(branchRecoveryExecutions);
        const drainContinuationResetNextSteps = await workerSessionDrainContinuationResetNextSteps(status.session.session);
        const drainContinuationResets = drainContinuationResetNextSteps.reduce((sum, step) => sum + step.count, 0);
        const applyQueueActions = applyActionFilter
          ? (applyActionQueue?.actions ?? []).filter((step) => applyActionFilter.has(step.action))
          : applyActionQueue?.actions ?? [];
        const commandQueue = [
          ...nextSteps.map((step) => ({
            scope: "session",
            session: status.session.session,
            action: step.action,
            reason: step.reason,
            count: step.count,
            command: step.command,
          })),
          ...branchNextSteps.map((step) => ({
            scope: "branch",
            session: status.session.session,
            action: step.action,
            reason: step.reason,
            agentId: step.agentId,
            runId: step.runId,
            status: step.status,
            objective: step.objective,
            workerId: step.workerId,
            location: step.location,
            branchName: step.branchName,
            resultCommit: step.resultCommit,
            command: step.command,
          })),
          ...drainWorkerNextSteps.map((step) => ({
            scope: "drain_worker",
            session: status.session.session,
            action: step.action,
            reason: step.reason,
            workerId: step.workerId,
            pid: step.pid,
            queuedContinuations: step.queuedContinuations,
            command: step.command,
          })),
          ...watchWorkerNextSteps.map((step) => ({
            scope: "watch_worker",
            session: status.session.session,
            action: step.action,
            reason: step.reason,
            workerId: step.workerId,
            watchId: step.watchId,
            pid: step.pid,
            stoppedAt: step.stoppedAt,
            command: step.command,
          })),
          ...drainContinuationResetNextSteps.map((step) => ({
            scope: "drain_continuation",
            session: status.session.session,
            action: step.action,
            reason: step.reason,
            count: step.count,
            continuationIds: step.continuationIds,
            olderThanMs: step.olderThanMs,
            command: step.command,
          })),
          ...applyQueueActions.map((step) => ({
            scope: "apply",
            session: status.session.session,
            action: step.action,
            reason: step.action === "retry_failed"
              ? "session_apply_failed_commands"
              : step.action === "resume_pending"
                ? "session_apply_pending_commands"
                : step.action === "review_ready_results"
                  ? "session_apply_ready_results"
                  : "session_apply_drain_continuation_resets",
            applyId: step.applyId,
            selected: step.selected,
            failed: step.failed,
            pending: step.pending,
            resultRuns: step.resultRuns,
            resetCount: step.resetCount,
            resetActions: step.resetActions,
            continuationIds: step.continuationIds,
            resetReasons: step.resetReasons,
            command: step.command,
          })),
        ];
        commandQueueLength = commandQueue.length;
        const output = {
          observedAt,
          ...(applyActionFilter ? { filter: { applyAction: [...applyActionFilter] } } : {}),
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
            branchNextSteps: branchNextSteps.length,
            branchRecoveryExecutions: branchRecoveryExecutionCounts.recent,
            branchRecoveryExecuted: branchRecoveryExecutionCounts.executed,
            branchRecoveryPartial: branchRecoveryExecutionCounts.partial,
            branchRecoveryNoop: branchRecoveryExecutionCounts.noop,
            drainWorkerRestarts: drainWorkerNextSteps.length,
            watchWorkerRestarts: watchWorkerNextSteps.length,
            drainContinuationResets,
            applyActions: applyActionQueue?.counts.actionable ?? 0,
            applyResumeNeeded: applyActionQueue?.counts.resumeNeeded ?? 0,
            applyReadyToReview: applyActionQueue?.counts.readyToReview ?? 0,
            applyResetAudits: applyActionQueue?.counts.resetAudits ?? 0,
            applyResetAuditsAcknowledged: applyActionQueue?.counts.resetAuditsAcknowledged ?? 0,
            applyResetAuditsTotal: applyActionQueue?.counts.resetAuditsTotal ?? 0,
            ...(applyActionFilter ? { filteredApplyActions: applyQueueActions.length } : {}),
          },
          checkoutDir: branchCheckoutDir,
          ...(untilEmpty ? {
            untilEmpty: {
              done: commandQueue.length === 0,
              remaining: commandQueue.length,
              poll: polls + 1,
              maxPolls,
            },
          } : {}),
          ...(options["commands-only"] === "1" ? { commands: commandQueue } : {
            nextSteps,
            branchNextSteps,
            branchRecoveryExecutions: {
              counts: branchRecoveryExecutionCounts,
              recent: branchRecoveryExecutions,
            },
            drainWorkerNextSteps,
            watchWorkerNextSteps,
            drainContinuationResetNextSteps,
            ...(applyActionQueue ? { actionQueue: applyActionQueue } : {}),
          }),
        };
        if (outputFormat === "shell") {
          printCommandQueueShell(commandQueue);
        } else {
          console.log(JSON.stringify(output));
        }
        if (watchRecord) {
          await appendSessionWatchRecordPoll(watchRecord, {
            poll: polls + 1,
            observedAt,
            remaining: commandQueueLength,
            output,
          });
        }
      } else {
        const output = {
          observedAt,
          ...status,
          ...(recoveryPreview ? { recoveryPreview } : {}),
          ...(applyActionQueue ? { actionQueue: applyActionQueue } : {}),
        };
        console.log(JSON.stringify(output));
        if (watchRecord) {
          await appendSessionWatchRecordPoll(watchRecord, {
            poll: polls + 1,
            observedAt,
            remaining: null,
            output,
          });
        }
      }
      polls += 1;
      const reachedEmpty = untilEmpty && commandQueueLength === 0;
      const reachedMaxPolls = maxPolls !== null && polls >= maxPolls;
      if (watchRecord && (reachedEmpty || reachedMaxPolls)) {
        await completeSessionWatchRecord(watchRecord, reachedEmpty ? "empty" : "max_polls");
      }
      if (reachedEmpty) return;
      if (reachedMaxPolls) return;
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
    const stopped = await Promise.all(session.workers.map(async (worker) => {
      const result = await stopProcessGroup(worker.pid);
      return {
        workerId: worker.workerId,
        pid: worker.pid,
        stopped: !result.alive,
        signalSent: result.signalSent,
        forced: result.forced,
        alive: result.alive,
      };
    }));
    session.stoppedAt = new Date().toISOString();
    await writeWorkerSession(session);
    const workerIds = new Set(session.workers.map((worker) => worker.workerId));
    const recovered = options.recover === "1"
      ? await recoverStaleRuns(
        workerSessionAgentIds(session),
        { workerId: session.session },
        parsePositiveInteger(options.concurrency ?? "4", "--concurrency"),
        workerIds,
        options["include-stopped"] === "1",
        false,
        options["include-stopped"] === "1",
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
    const requiredSessionName = required(sessionName, "runs recover-session <session>");
    const runIds = options.run ? parseList(options.run) : undefined;
    const limit = options.limit ? parsePositiveInteger(options.limit, "--limit") : undefined;
    if (options.server === "1") {
      await printJson(await requestJson("POST", `/api/worker-sessions/${encodeURIComponent(requiredSessionName)}/recover-branches`, {
        dryRun: options["dry-run"] === "1",
        includeStopped: options["include-stopped"] === "1",
        ...(limit ? { limit } : {}),
        ...(runIds ? { runIds } : {}),
      }));
      return;
    }
    const session = await readWorkerSession(requiredSessionName);
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
    const recoverCommand = ["npm", "run", "cli", "--", "runs", "recover-session", session.session];
    if (options["include-stopped"] === "1") recoverCommand.push("--include-stopped");
    const recoverActions = {
      sessionWait: ["npm", "run", "cli", "--", "runs", "session-wait", session.session],
      sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", session.session, "--recoverable", "--include-stopped", "--next"],
      sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", session.session, "--include-stopped"],
      restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", session.session, "--recover"],
      recoverSession: recoverCommand,
    };
    const status = options["dry-run"] === "1"
      ? null
      : await workerSessionStatus(session.session, new Set(["planned", "running", "stopped"]));
    const aliveWorkers = status
      ? (status.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>).filter((worker) => worker.alive).length
      : 0;
    const changedRuns = recovered.filter((item) => !item.skipped).length;
    await printJson({
      session: session.session,
      recovered: recovered.map(({ run: _run, ...item }) => item),
      actions: recoverActions,
      nextStep: options["dry-run"] === "1"
        ? {
          action: "recover_session",
          reason: "dry_run_preview",
          count: changedRuns,
          command: recoverActions.recoverSession,
        }
        : changedRuns > 0 && aliveWorkers > 0
          ? {
            action: "wait_session",
            reason: "recovered_runs_for_live_workers",
            count: changedRuns,
            command: recoverActions.sessionWait,
          }
          : changedRuns > 0
            ? {
              action: "restart_session",
              reason: "recovered_runs_without_live_workers",
              count: changedRuns,
              command: recoverActions.restartSession,
            }
            : {
              action: "review_session",
              reason: "no_runs_recovered",
              count: 0,
              command: recoverActions.sessionReview,
            },
      ...(options["dry-run"] === "1" ? {} : {
        status,
      }),
    });
    return;
  }
  if (subcommandName === "resume-session") {
    const [sessionName, ...optionArgs] = args;
    const options = parseOptions(optionArgs);
    const requiredSessionName = required(sessionName, "runs resume-session <session>");
    const next = options.next === "1";
    const limit = options.limit
      ? parsePositiveInteger(options.limit, "--limit")
      : next ? 1 : undefined;
    const runIds = options.run ? parseList(options.run) : undefined;
    await printJson(await requestJson("POST", `/api/worker-sessions/${encodeURIComponent(requiredSessionName)}/resume-branches`, {
      dryRun: options["dry-run"] === "1",
      ...(options["worker-id"] ? { workerId: options["worker-id"] } : {}),
      ...(limit ? { limit } : {}),
      ...(runIds ? { runIds } : {}),
    }));
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
    const response: {
      session: string;
      restarted: Array<{ workerId: string; pid: number | null }>;
      recovered: Omit<RecoverStaleRunResult, "run">[];
      status: Awaited<ReturnType<typeof workerSessionStatus>>;
      wait?: unknown;
    } = {
      session: session.session,
      restarted,
      recovered: recovered.map(({ run: _run, ...item }) => item),
      status: await workerSessionStatus(session.session, new Set(["planned", "running", "stopped"])),
    };
    if (options.wait === "1") {
      const waitIntervalMs = parsePositiveInteger(options["wait-interval-ms"] ?? options["interval-ms"] ?? "2000", "--wait-interval-ms");
      const maxPolls = parsePositiveInteger(options["max-polls"] ?? "60", "--max-polls");
      let polls = 0;
      let finalStatus = await workerSessionStatus(session.session, new Set(["planned", "running", "stopped", "completed", "failed"]));
      while (polls < maxPolls) {
        finalStatus = await workerSessionStatus(session.session, new Set(["planned", "running", "stopped", "completed", "failed"]));
        polls += 1;
        const workers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
        if (workers.every((worker) => !worker.alive)) break;
        if (polls >= maxPolls) break;
        await sleep(waitIntervalMs);
      }
      const finalWorkers = finalStatus.session.workers as Array<WorkerSession["workers"][number] & { alive: boolean }>;
      const aliveWorkers = finalWorkers.filter((worker) => worker.alive).length;
      const statuses: Record<string, number> = {};
      for (const agent of finalStatus.agents) {
        for (const [status, count] of Object.entries(agent.statuses)) {
          statuses[status] = (statuses[status] ?? 0) + count;
        }
      }
      const restartActions = {
        sessionWatch: ["npm", "run", "cli", "--", "runs", "session-watch", session.session, "--recoverable", "--include-stopped", "--next"],
        sessionSummaryWatch: ["npm", "run", "cli", "--", "runs", "session-summary", session.session, "--next", "--max-polls", "30", "--interval-ms", "10000"],
        monitor: ["npm", "run", "cli", "--", "runs", "monitor", "--agents", workerSessionAgentIds(session).join(","), "--status", "planned,running,stopped", "--next", "--checkout-dir", `./checkouts/${session.session}-monitor`],
        sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", session.session, "--include-stopped"],
        branchQueue: ["npm", "run", "cli", "--", "runs", "branches", "--session", session.session, "--next"],
        results: ["npm", "run", "cli", "--", "runs", "results", "--session", session.session],
        checkoutSession: ["npm", "run", "cli", "--", "runs", "checkout-session", session.session, "--dir", `./checkouts/${session.session}`],
        sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", session.session],
        stopSession: ["npm", "run", "cli", "--", "runs", "stop-session", session.session, "--recover"],
        recoverSession: ["npm", "run", "cli", "--", "runs", "recover-session", session.session],
        resumeSession: ["npm", "run", "cli", "--", "runs", "resume-session", session.session],
        restartSession: ["npm", "run", "cli", "--", "runs", "restart-session", session.session, "--recover"],
        restartSessionWithStopped: ["npm", "run", "cli", "--", "runs", "restart-session", session.session, "--recover", "--resume-stopped"],
      };
      response.wait = {
        completed: aliveWorkers === 0,
        timedOut: aliveWorkers > 0,
        polls,
        intervalMs: waitIntervalMs,
        summary: {
          workers: {
            total: finalWorkers.length,
            alive: aliveWorkers,
            dead: finalWorkers.length - aliveWorkers,
          },
          agents: finalStatus.agents.length,
          runs: finalStatus.agents.reduce((sum, agent) => sum + agent.total, 0),
          statuses,
        },
        status: finalStatus,
        commands: restartActions,
        nextStep: aliveWorkers > 0
          ? {
            action: "continue_watch",
            reason: "workers_still_alive",
            command: restartActions.sessionSummaryWatch,
          }
          : {
            action: "review_session",
            reason: "bounded_session_finished",
            command: restartActions.sessionReview,
          },
      };
      response.status = finalStatus;
    }
    await printJson(response);
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
    const checkoutDir = options["checkout-dir"] ?? "./checkouts/monitor";
    for (let poll = 0; poll < maxPolls; poll += 1) {
      const agents = [];
      for (const agentId of agentIds) {
        const params = new URLSearchParams();
        if (statusList) params.set("status", statusList.join(","));
        const listed = await requestJson("GET", withQuery(`/api/agents/${encodeURIComponent(agentId)}/runs`, params)) as {
          runs: Array<{
            id: string;
            objective: string;
            input_ref: string;
            run_branch: string;
            status: string;
            result_commit: string | null;
          }>;
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
          const warning = status.run.status === "completed" && run.result_commit === null
            ? "completed_without_result_commit"
            : null;
          const resumable = status.run.status === "stopped" && run.result_commit === null;
          return {
            id: status.run.id,
            status: status.run.status,
            objective: run.objective,
            baseRef: run.input_ref,
            branchName: run.run_branch,
            resultCommit: run.result_commit,
            warning,
            resumable,
            workerId: status.run.worker_id,
            commands: {
              claimRun: ["npm", "run", "cli", "--", "runs", "claim", run.id],
              watchRun: ["npm", "run", "cli", "--", "runs", "watch", run.id],
              inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", run.id],
              checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", run.id, "--dir", `${checkoutDir}/${run.id}`],
              reviewRun: ["npm", "run", "cli", "--", "runs", "review", run.id, "--checkout-dir", `${checkoutDir}/${run.id}`],
              resumeBranch: resumable
                ? ["npm", "run", "cli", "--", "runs", "resume-branch", run.id]
                : null,
            },
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
        const nextSteps = agents.flatMap((agent) => agent.runs.map((run) => {
          const action = run.status === "planned"
            ? "claim_run"
            : run.status === "running"
              ? "watch_run"
              : run.resumable
                ? "resume_branch"
                : "inspect_run";
          const command = action === "claim_run"
            ? run.commands.claimRun
            : action === "watch_run"
              ? run.commands.watchRun
              : action === "resume_branch" && run.commands.resumeBranch
                ? run.commands.resumeBranch
                : run.commands.inspectRun;
          return {
            action,
            reason: run.status === "planned"
              ? "queued_run"
              : run.status === "running"
                ? "active_run"
                : run.resumable
                  ? "stopped_branch_without_result_commit"
                  : run.warning ?? (run.resultCommit ? "result_commit_available" : "terminal_run"),
            agentId: agent.agentId,
            runId: run.id,
            status: run.status,
            objective: run.objective,
            baseRef: run.baseRef,
            branchName: run.branchName,
            resultCommit: run.resultCommit,
            warning: run.warning,
            resumable: run.resumable,
            workerId: run.workerId,
            command,
            commands: run.commands,
          };
        }));
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
            resumable: nextSteps.filter((step) => step.resumable).length,
            warnings: nextSteps.filter((step) => step.warning !== null).length,
          },
          checkoutDir,
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
        let resumeInspection: {
          recovery: { ready: boolean; reason: string };
          nextStep: { action: string; command: string[] };
        } | null = null;
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
        if (run.status === "stopped") {
          resumeInspection = await requestJson("GET", `/api/runs/${encodeURIComponent(run.id)}/resume-inspection`) as {
            recovery: { ready: boolean; reason: string };
            nextStep: { action: string; command: string[] };
          };
          if (!resumeInspection.recovery.ready) {
            return {
              agentId: run.agent_id,
              runId: run.id,
              skipped: resumeInspection.recovery.reason,
              resumeInspection,
            };
          }
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
          ...(resumeInspection ? { resumeInspection } : {}),
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
    if (key === "ack-reset-audit" || key === "action-executions" || key === "action-queue" || key === "blocked" || key === "bootstrap" || key === "boot" || key === "changed-only" || key === "check-runtime" || key === "checkout" || key === "commands-only" || key === "confirm" || key === "confirmation-queue" || key === "continue-drains" || key === "continue-on-failure" || key === "detach" || key === "drain-confirmations" || key === "execute-confirmation" || key === "execute-next-confirmation" || key === "execute-next" || key === "execute-queued" || key === "finalize" || key === "include-retired" || key === "include-stopped" || key === "inspect" || key === "live" || key === "dry-run" || key === "loop" || key === "mutating" || key === "needs-action" || key === "next" || key === "no-bootstrap" || key === "queue" || key === "ready-results" || key === "recover" || key === "recoverable" || key === "reset-failed" || key === "reset-running" || key === "resumable" || key === "resume" || key === "resume-stopped" || key === "retire" || key === "server" || key === "summary" || key === "until-empty" || key === "wait") {
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

type CommandQueueOutput = {
  commands: Array<{ command: string[] }>;
};

type ControlPlaneTimelineCommand = {
  scope: "control_plane_timeline";
  source: string;
  event: string;
  action: "inspect_tick" | "inspect_advance" | "inspect_worker" | "inspect_apply_action_execution" | "inspect_branch_recovery_execution" | "run_selected_command";
  reason: string;
  tickId: string | null;
  advanceId: string | null;
  workerId: string | null;
  executionId: string | null;
  applyId: string | null;
  runIds: string[];
  command: string[];
};

type ControlPlaneAdvanceConfirmationCommand = {
  scope: "control_plane_advance";
  advanceId: string;
  completedAt: string;
  surface: WorkerSessionControlPlaneAdvanceAction["surface"] | null;
  action: string | null;
  selectedReason: string | null;
  detailCommand: string | null;
  blocked: boolean;
  mutating: boolean;
  reason: string | null;
  runId: string | null;
  workerId: string | null;
  applyId: string | null;
  executionId: string | null;
  command: string[];
};

type ControlPlaneAdvanceConfirmationGroup = {
  surface: WorkerSessionControlPlaneAdvanceAction["surface"] | null;
  action: string | null;
  selectedReason: string | null;
  detailCommand: string | null;
  reason: string | null;
  count: number;
  commandCount: number;
  advanceIds: string[];
  runIds: string[];
  workerIds: string[];
  applyIds: string[];
  executionIds: string[];
  commands: Array<{ command: string[] }>;
};

function cliCommandArgs(command: string[]): string[] {
  const prefix = ["npm", "run", "cli", "--"];
  if (prefix.some((part, index) => command[index] !== part)) {
    throw new Error(`expected npm run cli command, got: ${command.join(" ")}`);
  }
  return command.slice(prefix.length);
}

function commandKey(command: string[]): string {
  return JSON.stringify(command);
}

function parseJsonMaybe(value: string): unknown {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function printCommandQueueShell(commands: CommandQueueOutput["commands"]): void {
  for (const item of commands) {
    console.log(item.command.map(shellArg).join(" "));
  }
}

function workerSessionBranchRecoveryExecutionCommands(
  sessionName: string,
  executions: WorkerSessionBranchRecoveryExecutionRecord[],
  options: { checkoutRoot: string },
): Array<{
  scope: "branch_recovery_execution" | "branch_recovery_run";
  action: "inspect_execution" | "inspect_run" | "inspect_branch" | "review_branch";
  reason: string;
  executionId: string;
  status: WorkerSessionBranchRecoveryExecutionRecord["status"];
  runId: string | null;
  workerId: string | null;
  branchName: string | null;
  resultCommit: string | null;
  command: string[];
}> {
  return executions.flatMap((execution) => {
    const inspectExecution = {
      scope: "branch_recovery_execution" as const,
      action: "inspect_execution" as const,
      reason: execution.status,
      executionId: execution.executionId,
      status: execution.status,
      runId: null,
      workerId: null,
      branchName: null,
      resultCommit: null,
      command: [
        "npm",
        "run",
        "cli",
        "--",
        "runs",
        "session-branch-recovery-executions",
        sessionName,
        "--server",
        "--execution",
        execution.executionId,
      ],
    };
    const resumed = execution.resumed.map((run) => {
      const resultCommit = run.resultCommit ?? null;
      const checkoutDir = `${options.checkoutRoot}/${execution.executionId}/${run.runId}`;
      return {
        scope: "branch_recovery_run" as const,
        action: resultCommit ? "review_branch" as const : "inspect_run" as const,
        reason: resultCommit ? "result_commit_available" : "resumed_branch",
        executionId: execution.executionId,
        status: execution.status,
        runId: run.runId,
        workerId: run.workerId,
        branchName: run.branchName ?? null,
        resultCommit,
        command: resultCommit
          ? ["npm", "run", "cli", "--", "runs", "review", run.runId, "--checkout-dir", checkoutDir]
          : ["npm", "run", "cli", "--", "runs", "inspect", run.runId],
      };
    });
    const skipped = execution.skipped.map((run) => ({
      scope: "branch_recovery_run" as const,
      action: "inspect_branch" as const,
      reason: run.reason,
      executionId: execution.executionId,
      status: execution.status,
      runId: run.runId,
      workerId: run.workerId,
      branchName: run.branchName ?? null,
      resultCommit: run.resultCommit ?? null,
      command: [
        "npm",
        "run",
        "cli",
        "--",
        "runs",
        "session-branches",
        sessionName,
        "--server",
        "--run",
        run.runId,
        "--limit",
        "1",
        "--commands-only",
      ],
    }));
    return [inspectExecution, ...resumed, ...skipped];
  });
}

function workerSessionControlPlaneTimelineCommands(
  timeline: WorkerSessionControlPlaneTimelineResponse,
): ControlPlaneTimelineCommand[] {
  return timeline.events.flatMap((event) => {
    const common = {
      scope: "control_plane_timeline" as const,
      source: event.source,
      event: event.event,
      reason: event.reason ?? event.status ?? event.state ?? event.event,
      tickId: event.tickId ?? null,
      advanceId: event.advanceId ?? null,
      workerId: event.workerId ?? null,
      executionId: event.executionId ?? null,
      applyId: event.applyId ?? null,
      runIds: event.runIds ?? [],
    };
    if (event.source === "tick") {
      return [{
        ...common,
        action: "inspect_tick" as const,
        command: [
          "npm",
          "run",
          "cli",
          "--",
          "runs",
          "session-control-plane-ticks",
          timeline.session,
          "--server",
          ...(event.tickId ? ["--tick", event.tickId] : []),
          "--limit",
          String(timeline.filter.limit),
        ],
      }];
    }
    if (event.source === "advance") {
      const commands: ControlPlaneTimelineCommand[] = [{
        ...common,
        action: "inspect_advance" as const,
        command: [
          "npm",
          "run",
          "cli",
          "--",
          "runs",
          "session-control-plane-advances",
          timeline.session,
          "--server",
          ...(event.advanceId ? ["--advance", event.advanceId] : []),
          "--limit",
          String(timeline.filter.limit),
        ],
      }];
      if (event.command) {
        commands.push({
          ...common,
          action: "run_selected_command" as const,
          command: event.command,
        });
      }
      return commands;
    }
    if (event.source === "control_plane_advance_worker" || event.source === "control_plane_tick_worker") {
      return [{
        ...common,
        action: "inspect_worker" as const,
        command: [
          "npm",
          "run",
          "cli",
          "--",
          "runs",
          event.source === "control_plane_advance_worker" ? "session-control-plane-advance-workers" : "session-control-plane-tick-workers",
          timeline.session,
          "--server",
          ...(event.workerId ? ["--worker-id", event.workerId] : []),
          "--include-retired",
          "--lines",
          String(timeline.filter.lines),
        ],
      }];
    }
    if (event.source === "apply_action_execution") {
      return [{
        ...common,
        action: "inspect_apply_action_execution" as const,
        command: [
          "npm",
          "run",
          "cli",
          "--",
          "runs",
          "session-applies",
          timeline.session,
          "--server",
          "--action-executions",
          ...(event.applyId ? ["--apply-id", event.applyId] : []),
          ...(event.applyAction ? ["--apply-action", event.applyAction] : []),
          ...(event.status ? ["--status", event.status] : []),
          ...(event.executionId ? ["--execution", event.executionId] : []),
          "--limit",
          String(timeline.filter.limit),
        ],
      }];
    }
    if (event.source === "branch_recovery_execution") {
      return [{
        ...common,
        action: "inspect_branch_recovery_execution" as const,
        command: [
          "npm",
          "run",
          "cli",
          "--",
          "runs",
          "session-branch-recovery-executions",
          timeline.session,
          "--server",
          ...(event.executionId ? ["--execution", event.executionId] : []),
          "--commands-only",
        ],
      }];
    }
    return [];
  });
}

function workerSessionControlPlaneAdvanceConfirmationCommands(
  advances: WorkerSessionControlPlaneAdvancesResponse["advances"],
): ControlPlaneAdvanceConfirmationCommand[] {
  const seen = new Set<string>();
  return advances.flatMap((advance) => {
    const command = advance.executionSafety?.confirmationCommand;
    if (!command) return [];
    const key = commandKey(command);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      scope: "control_plane_advance" as const,
      advanceId: advance.advanceId,
      completedAt: advance.completedAt,
      surface: advance.selected?.surface ?? null,
      action: advance.selected?.action ?? null,
      selectedReason: advance.selected?.reason ?? null,
      detailCommand: advance.executionSafety?.detailCommand ?? advance.selected?.detailCommand ?? null,
      blocked: advance.executionSafety?.blocked ?? false,
      mutating: advance.executionSafety?.mutating ?? false,
      reason: advance.executionSafety?.reason ?? null,
      runId: advance.selected?.runId ?? null,
      workerId: advance.selected?.workerId ?? null,
      applyId: advance.selected?.applyId ?? null,
      executionId: advance.selected?.executionId ?? null,
      command,
    }];
  });
}

function workerSessionControlPlaneAdvanceConfirmationQueue(
  advances: WorkerSessionControlPlaneAdvancesResponse["advances"],
): {
  summary: { advances: number; groups: number; commands: number };
  groups: ControlPlaneAdvanceConfirmationGroup[];
} {
  const commands = workerSessionControlPlaneAdvanceConfirmationCommands(advances);
  const groups = new Map<string, ControlPlaneAdvanceConfirmationGroup>();
  for (const item of commands) {
    const key = JSON.stringify([item.surface, item.action, item.selectedReason, item.detailCommand, item.reason]);
    const group = groups.get(key) ?? {
      surface: item.surface,
      action: item.action,
      selectedReason: item.selectedReason,
      detailCommand: item.detailCommand,
      reason: item.reason,
      count: 0,
      commandCount: 0,
      advanceIds: [],
      runIds: [],
      workerIds: [],
      applyIds: [],
      executionIds: [],
      commands: [],
    };
    group.count += 1;
    group.advanceIds.push(item.advanceId);
    pushUnique(group.runIds, item.runId);
    pushUnique(group.workerIds, item.workerId);
    pushUnique(group.applyIds, item.applyId);
    pushUnique(group.executionIds, item.executionId);
    group.commands.push({ command: item.command });
    group.commandCount = group.commands.length;
    groups.set(key, group);
  }
  const grouped = [...groups.values()].sort((left, right) => (
    right.count - left.count
    || String(left.surface).localeCompare(String(right.surface))
    || String(left.action).localeCompare(String(right.action))
    || String(left.detailCommand).localeCompare(String(right.detailCommand))
  ));
  return {
    summary: {
      advances: advances.length,
      groups: grouped.length,
      commands: commands.length,
    },
    groups: grouped,
  };
}

function pushUnique(values: string[], value: string | null): void {
  if (value && !values.includes(value)) values.push(value);
}

function workerSessionControlPlaneAdvanceById(
  advances: WorkerSessionControlPlaneAdvancesResponse["advances"],
  advanceId: string,
): WorkerSessionControlPlaneAdvancesResponse["advances"][number] {
  const advance = advances.find((record) => record.advanceId === advanceId);
  if (!advance) throw new Error(`blocked confirmation advance not found in the selected page: ${advanceId}`);
  return advance;
}

function workerSessionControlPlaneNextConfirmationAdvance(
  advances: WorkerSessionControlPlaneAdvancesResponse["advances"],
): WorkerSessionControlPlaneAdvancesResponse["advances"][number] {
  const advance = advances.find((record) => record.executionSafety?.confirmationCommand);
  if (!advance) throw new Error("no blocked confirmation advance found in the selected page");
  return advance;
}

function workerSessionControlPlaneAdvanceConfirmationExecuteOptions(
  sessionName: string,
  advance: WorkerSessionControlPlaneAdvancesResponse["advances"][number],
  options: { dryRun: boolean },
): Parameters<typeof executeWorkerSessionControlPlaneAlert>[1] {
  const command = advance.executionSafety?.confirmationCommand;
  if (!command) throw new Error(`control-plane advance ${advance.advanceId} does not have a confirmation command`);
  const commandArgs = cliCommandArgs(command);
  const [mode, subcommandName, commandSessionName, ...optionArgs] = commandArgs;
  if (mode !== "runs" || subcommandName !== "session-control-plane-alert-execute") {
    throw new Error(`control-plane advance ${advance.advanceId} confirmation command is not an alert execution command`);
  }
  if (commandSessionName !== sessionName) {
    throw new Error(`control-plane advance ${advance.advanceId} confirmation command targets ${commandSessionName}, expected ${sessionName}`);
  }
  const commandOptions = parseOptions(optionArgs);
  if (commandOptions.server !== "1" || commandOptions.confirm !== "1") {
    throw new Error(`control-plane advance ${advance.advanceId} confirmation command is missing --server or --confirm`);
  }
  return {
    dryRun: options.dryRun,
    confirm: true,
    lines: parsePositiveInteger(commandOptions.lines ?? "5", "--lines"),
    detailCommand: commandOptions["detail-command"],
    severity: commandOptions.severity,
    surface: commandOptions.surface,
    reason: commandOptions.reason,
    runId: commandOptions.run,
    workerId: commandOptions.worker,
    applyId: commandOptions.apply,
    executionId: commandOptions.execution,
    action: commandOptions.action,
  };
}

function summarizeBranchRecoveryExecutionStatuses<T extends { status: string }>(records: T[]): {
  recent: number;
  executed: number;
  partial: number;
  noop: number;
} {
  return {
    recent: records.length,
    executed: records.filter((record) => record.status === "executed").length,
    partial: records.filter((record) => record.status === "partial").length,
    noop: records.filter((record) => record.status === "noop").length,
  };
}

function shellArg(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a non-negative integer`);
  return parsed;
}

function pageCursor(limit: number | null, offset: number, total: number): { hasMore: boolean; nextOffset: number | null } {
  const nextOffset = limit ? offset + limit : null;
  const hasMore = nextOffset !== null && nextOffset < total;
  return { hasMore, nextOffset: hasMore ? nextOffset : null };
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

type WorkerSessionApplyDrainsResponse = {
  counts: {
    total: number;
    needsContinuation: number;
    done: number;
    stoppedOnFailure: number;
  };
  drains: Array<{
    prefix: string;
    nextApplyId: string;
    continueCommand: string[] | null;
  }>;
};

type WorkerSessionAppliesResponse = {
  ok: true;
  session: string;
  count: number;
  returned: number;
  filter: Record<string, unknown>;
  summary: {
    counts: {
      total: number;
      succeeded: number;
      failed: number;
      pending: number;
      dryRun: number;
    };
    applies: Array<{
      applyId: string;
      source: string;
      selected: number;
      succeeded: number;
      failed: number;
      pending: number;
    }>;
  };
  applies: SessionApplyRecord[];
};

type WorkerSessionApplyResetAuditAckResponse = {
  ok: true;
  session: string;
  applyId: string;
  applyPath: string;
  dryRun: boolean;
  resetAudit: {
    acknowledged: true;
    acknowledgedAt: string;
    acknowledgedBy?: string;
  };
  summary: {
    applyId: string;
    source: string;
    selected: number;
    succeeded: number;
    failed: number;
    pending: number;
  };
  record: SessionApplyRecord;
};

type WorkerSessionApplyActionsResponse = {
  ok: true;
  session: string;
  count: number;
  returned: number;
  filter: Record<string, unknown>;
  actionQueue: {
    counts: {
      total: number;
      actionable: number;
      resumeNeeded: number;
      resetAudits: number;
      resetAuditsAcknowledged: number;
      resetAuditsTotal: number;
      waiting: number;
      failed: number;
      pending: number;
    };
    actions: Array<{
      applyId: string;
      source: string;
      action: "retry_failed" | "resume_pending" | "inspect_drain_continuation_resets";
      selected: number;
      failed: number;
      pending: number;
      resetCount: number;
      resetActions: Array<"reset_failed_drain_continuations" | "reset_running_drain_continuations">;
      continuationIds: string[];
      resetReasons: string[];
      command: string[];
      ackCommand?: string[];
    }>;
  };
};

type ExecuteNextWorkerSessionApplyActionResponse = {
  ok: true;
  session: string;
  executed: boolean;
  filter: Record<string, unknown>;
  action?: WorkerSessionApplyActionsResponse["actionQueue"]["actions"][number];
  actionQueue?: WorkerSessionApplyActionsResponse["actionQueue"];
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  output?: unknown;
  executionPath?: string;
  execution?: WorkerSessionApplyActionExecutionRecord;
};

type ExecuteQueuedWorkerSessionApplyActionsResponse = {
  ok: true;
  session: string;
  executed: number;
  stoppedOnFailure: boolean;
  remainingQueued: number;
  filter: Record<string, unknown>;
  actionQueue: WorkerSessionApplyActionsResponse["actionQueue"];
  executions: Array<{
    action: WorkerSessionApplyActionsResponse["actionQueue"]["actions"][number];
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    output?: unknown;
    executionPath: string;
    execution: WorkerSessionApplyActionExecutionRecord;
  }>;
};

type ExecuteQueuedWorkerSessionApplyActionsLoopResponse = {
  ok: true;
  session: string;
  observedAt: string;
  completedAt: string;
  executed: number;
  failed: number;
  maxPolls: number;
  intervalMs: number;
  stoppedReason: "empty" | "failed_action" | "max_polls" | "repeated_action";
  remainingQueued: number;
  repeatedActions: string[];
  filter: Record<string, unknown>;
  polls: Array<ExecuteQueuedWorkerSessionApplyActionsResponse & {
    poll: number;
    observedAt: string;
  }>;
};

type WorkerSessionApplyActionExecutionRecord = {
  executionId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  status: "executed" | "failed";
  filter: Record<string, unknown>;
  applyId: string;
  source: string;
  action: WorkerSessionApplyActionsResponse["actionQueue"]["actions"][number]["action"];
  command: string[];
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  output?: unknown;
};

type WorkerSessionApplyActionExecutionsResponse = {
  ok: true;
  session: string;
  count: number;
  filter: Record<string, unknown>;
  executions: WorkerSessionApplyActionExecutionRecord[];
};

type WorkerSessionBranchRecoveryExecutionRecord = {
  executionId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  status: "executed" | "partial" | "noop";
  filter: Record<string, unknown>;
  selected: number;
  resumed: Array<{
    agentId?: string;
    runId: string;
    objective?: string;
    branchName?: string;
    resultCommit?: string | null;
    status?: string;
    workerId: string | null;
  }>;
  skipped: Array<{
    agentId?: string;
    runId: string;
    objective?: string;
    branchName?: string;
    resultCommit?: string | null;
    reason: string;
    workerId: string | null;
  }>;
  nextStep?: unknown;
};

type WorkerSessionBranchRecoveryExecutionsResponse = {
  ok: true;
  session: string;
  count: number;
  filter: Record<string, unknown>;
  executions: WorkerSessionBranchRecoveryExecutionRecord[];
};

type WorkerSessionDrainContinuationRecord = {
  continuationId: string;
  session: string;
  observedAt: string;
  status?: "queued" | "running" | "executed" | "failed";
  startedAt?: string;
  completedAt?: string;
  resetAt?: string;
  resetReason?: string;
  previousStartedAt?: string;
  error?: string;
  dryRun: boolean;
  filter: Record<string, unknown>;
  readinessSource: "server";
  readinessCounts: WorkerSessionApplyDrainsResponse["counts"];
  continueDrains: {
    dryRun: boolean;
    selected: number;
    succeeded: number;
    failed: number;
  };
  drains: Array<{
    prefix: string;
    nextApplyId: string;
    command: string[];
    exitCode: number | null;
    output?: unknown;
    stderr?: string;
  }>;
};

type WorkerSessionDrainContinuationsResponse = {
  ok: true;
  session: string;
  count: number;
  continuations: WorkerSessionDrainContinuationRecord[];
};

type QueueWorkerSessionDrainContinuationsResponse = {
  ok: true;
  session: string;
  continuationPath: string;
  continuation: WorkerSessionDrainContinuationRecord;
};

type ExecuteWorkerSessionDrainContinuationResponse = QueueWorkerSessionDrainContinuationsResponse;

type ExecuteNextWorkerSessionDrainContinuationResponse = {
  ok: true;
  session: string;
  executed: boolean;
  continuationPath: string | null;
  continuation: WorkerSessionDrainContinuationRecord | null;
};

type WorkerSessionControlPlaneTickRecord = {
  tickId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  status: "dry_run" | "executed" | "partial" | "noop";
  planned: {
    branchRecovery: null | { action: "recover_stale_running_run" | "resume_next_branch"; runIds: string[]; command: string[] };
    applyAction: null | { action: "execute_next_apply_action"; actionable: number };
    drainContinuation: null | { action: "execute_next_drain_continuation"; queued: number };
  };
  executed: {
    branchRecovery: unknown | null;
    applyAction: unknown | null;
    drainContinuation: unknown | null;
  };
  before: Awaited<ReturnType<typeof fetchWorkerSessionControlPlaneStatus>>;
  after: Awaited<ReturnType<typeof fetchWorkerSessionControlPlaneStatus>>;
};

type WorkerSessionControlPlaneRecoveryNextStep = {
  action: string;
  reason: string;
  workerId: string;
  mode?: "advance_loop" | "confirmation_drain";
  command: string[];
  commands: Record<string, string[]>;
  api?: unknown;
};

type WorkerSessionControlPlaneTickWithDecision = WorkerSessionControlPlaneTickRecord & {
  decision: ReturnType<typeof summarizeWorkerSessionControlPlaneTickDecision>;
};

type WorkerSessionControlPlaneStatusResponse = {
  ok: true;
  session: string;
  workers: {
    watch: { total: number; alive: number; stopped: number; retired: number };
    drain: { total: number; alive: number; stopped: number; retired: number };
    applyAction: { total: number; alive: number; stopped: number; retired: number };
    controlPlaneAdvance: {
      total: number;
      alive: number;
      stopped: number;
      retired: number;
      completed: number;
      modes: {
        advance_loop: { total: number; alive: number; stopped: number; retired: number; completed: number };
        confirmation_drain: { total: number; alive: number; stopped: number; retired: number; completed: number };
      };
      latestResults: Array<{
        workerId: string;
        mode: "advance_loop" | "confirmation_drain";
        lifecycle: { state: string; restartable: boolean; reason: string };
        latestResult: {
          ok?: boolean;
          session?: string;
          dryRun?: boolean;
          untilEmpty?: boolean;
          stoppedReason?: string;
          maxSteps?: number;
          intervalMs?: number;
          maxConfirmations?: number;
          executedSteps?: number;
          attemptedConfirmations?: number;
          availableConfirmations?: number;
          cycles?: number;
          results?: number;
          sourceAdvanceId?: string;
          detailCommand?: string;
        };
      }>;
    };
    controlPlaneTick: { total: number; alive: number; stopped: number; retired: number; completed: number };
  };
  queues: {
    applyActions: {
      total: number;
      actionable: number;
      resumeNeeded: number;
      resetAudits: number;
      resetAuditsAcknowledged: number;
      resetAuditsTotal: number;
      waiting: number;
      failed: number;
      pending: number;
    };
    applyActionNextSteps: {
      count: number;
      nextSteps: Array<WorkerSessionApplyActionsResponse["actionQueue"]["actions"][number] & {
        executeCommand: string[];
      }>;
    };
    applyActionExecutions: {
      counts: { recent: number; executed: number; failed: number };
      recent: WorkerSessionApplyActionExecutionRecord[];
    };
    drainContinuations: { total: number; queued: number; running: number; executed: number; failed: number };
  };
  branches: {
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
      recent: WorkerSessionBranchRecoveryExecutionRecord[];
    };
  };
  staleRuns: {
    counts: {
      total: number;
      ready: number;
      blocked: number;
      staleRunningClaimWithoutRunningSandbox: number;
      runningSandboxPresent: number;
    };
    actions: { recover_session_run: number; inspect_run: number };
    commands: { recoverSession: string[]; recoverSessionDryRun: string[]; inspectSession: string[] };
    nextSteps: Array<{
      action: "recover_session_run" | "inspect_run";
      reason: "stale_running_claim_without_running_sandbox" | "running_sandbox_present";
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
    actions: Record<string, number>;
    nextSteps: {
      watchWorkers: WorkerSessionControlPlaneRecoveryNextStep[];
      drainWorkers: WorkerSessionControlPlaneRecoveryNextStep[];
      applyActionWorkers: WorkerSessionControlPlaneRecoveryNextStep[];
      controlPlaneAdvanceWorkers: WorkerSessionControlPlaneRecoveryNextStep[];
      controlPlaneTickWorkers: WorkerSessionControlPlaneRecoveryNextStep[];
    };
  };
};

type WorkerSessionControlPlaneAlertsResponse = {
  ok: true;
  session: string;
  observedAt: string;
  limit: number;
  filter: {
    severities: string[];
    surfaces: string[];
    reasons: string[];
    runIds: string[];
    workerIds: string[];
    applyIds: string[];
    executionIds: string[];
    continuationIds: string[];
    actions: string[];
    totalAlerts: number;
    visibleAlerts: number;
    hasMore: boolean;
  };
  summary: { total: number; errors: number; warnings: number };
  alerts: Array<{
    surface: "apply_action" | "drain_continuation" | "branch" | "stale_run" | "worker_recovery";
    severity: "error" | "warning";
    reason: string;
    count: number;
    command: string[];
    runId?: string;
    workerId?: string;
    applyId?: string;
    executionId?: string;
    continuationIds?: string[];
    action?: string;
  }>;
  recentTimeline: {
    count: number;
    counts: Record<string, number>;
    events: WorkerSessionControlPlaneTimelineResponse["events"];
  };
  commands: { fullStatus: string[]; timelineFailures: string[] };
};

type WorkerSessionControlPlaneAlertPreviewResponse = {
  ok: true;
  session: string;
  observedAt: string;
  filter: WorkerSessionControlPlaneAlertsResponse["filter"];
  matchCount: number;
  alert: WorkerSessionControlPlaneAlertsResponse["alerts"][number] | null;
  preview: {
    command: string[];
    fullStatus: string[];
    timelineFailures: string[];
  } | null;
  details: ({
    kind: "run_resume_inspection";
    inspection: {
      run: { id: string; status: string; resultCommit: string | null; branchName: string; workerId: string | null };
      recovery: { ready: boolean; reason: string; runningSandboxes: Array<{ id: string; providerSandboxId: string | null }> };
      links: { branchTreeUrl: string | null; resultCommitUrl: string | null };
      nextStep: { action: string; reason: string; command: string[] };
    };
  } | {
    kind: "apply_action_execution";
    execution: WorkerSessionApplyActionExecutionRecord;
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
    continuations: WorkerSessionDrainContinuationRecord[];
    commands: { inspectFailed: string[]; resetFailed: string[]; resetSelectedFailed: string[] | null };
  }) | null;
  recentTimeline: WorkerSessionControlPlaneAlertsResponse["recentTimeline"];
};

type WorkerSessionControlPlaneAdvanceAction = {
  surface: "stale_run" | "branch" | "apply_action" | "drain_continuation" | "worker_recovery";
  action: string;
  reason: string;
  count: number;
  command: string[];
  detailCommand?: string;
  runId?: string;
  workerId?: string;
  applyId?: string;
  executionId?: string;
  continuationIds?: string[];
};

type WorkerSessionControlPlaneAdvanceResponse = {
  ok: true;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  advanceId: string;
  advancePath: string;
  selected: WorkerSessionControlPlaneAdvanceAction | null;
  executed: { command: string[]; exitCode: number | null; stdout?: string; stderr?: string; output: unknown } | null;
  before: WorkerSessionControlPlaneStatusResponse;
  after: WorkerSessionControlPlaneStatusResponse;
};

type WorkerSessionControlPlaneAlertExecuteResponse = WorkerSessionControlPlaneAdvanceResponse & {
  alert: WorkerSessionControlPlaneAlertPreviewResponse["alert"];
  details: WorkerSessionControlPlaneAlertPreviewResponse["details"];
  filter: WorkerSessionControlPlaneAlertPreviewResponse["filter"];
  detailCommand: string;
  executionSafety: {
    detailCommand: string;
    mutating: boolean;
    confirmationRequired: boolean;
    confirmed: boolean;
    blocked: boolean;
    reason: string | null;
    confirmationCommand: string[] | null;
  };
};

type WorkerSessionControlPlaneAdvancesResponse = {
  ok: true;
  session: string;
  filter: { limit: number; advanceIds: string[]; blocked: boolean | null; mutating: boolean | null };
  count: number;
  summary: {
    total: number;
    dryRun: number;
    executed: number;
    failed: number;
    blocked: number;
    mutating: number;
  };
  advances: Array<Omit<WorkerSessionControlPlaneAdvanceResponse, "ok" | "advancePath"> & {
    executionSafety?: WorkerSessionControlPlaneAlertExecuteResponse["executionSafety"];
  }>;
};

type WorkerSessionControlPlaneAdvanceLoopResponse = {
  ok: true;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  maxSteps: number;
  intervalMs: number;
  executedSteps: number;
  stoppedReason: "noop" | "dry_run" | "action_failed" | "max_steps";
  advances: WorkerSessionControlPlaneAdvanceResponse[];
};

type WorkerSessionControlPlaneTimelineResponse = {
  ok: true;
  session: string;
  filter: {
    sources: string[];
    events: string[];
    statuses: string[];
    tickIds: string[];
    advanceIds: string[];
    workerIds: string[];
    executionIds: string[];
    applyIds: string[];
    runIds: string[];
    limit: number;
    lines: number;
  };
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
      observedAt: string;
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
    observedAt: string;
    source: string;
    event: string;
    tickId?: string;
    advanceId?: string;
    workerId?: string;
    executionId?: string;
    applyId?: string;
    applySource?: string;
    applyAction?: string;
    runIds?: string[];
    resumedRunIds?: string[];
    skippedRunIds?: string[];
    branchNames?: string[];
    skippedReasons?: string[];
    status?: string;
    exitCode?: number | null;
    state?: string;
    restartable?: boolean;
    dryRun?: boolean;
    selectedSurface?: string;
    selectedAction?: string;
    selectedCount?: number;
    command?: string[];
    reason?: string;
    pid?: number | null;
    previousPid?: number | null;
    selected?: number;
    resumedCount?: number;
    skippedCount?: number;
  }>;
};

type ExecuteQueuedWorkerSessionDrainContinuationsResponse = {
  ok: true;
  session: string;
  executed: number;
  remainingQueued: number;
  continuations: WorkerSessionDrainContinuationRecord[];
};

type ResetRunningWorkerSessionDrainContinuationsResponse = {
  ok: true;
  session: string;
  inspected: number;
  running: number;
  resetCount: number;
  skippedRunning: number;
  continuations: WorkerSessionDrainContinuationRecord[];
};

type ResetFailedWorkerSessionDrainContinuationsResponse = {
  ok: true;
  session: string;
  inspected: number;
  failed: number;
  resetCount: number;
  skippedFailed: number;
  continuations: WorkerSessionDrainContinuationRecord[];
};

async function fetchWorkerSessionApplyDrains(
  sessionName: string,
  drainPrefix?: string,
): Promise<WorkerSessionApplyDrainsResponse> {
  const params = new URLSearchParams();
  if (drainPrefix) params.set("drainPrefix", drainPrefix);
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drains`, params),
  ) as WorkerSessionApplyDrainsResponse;
}

async function fetchWorkerSessionApplies(
  sessionName: string,
  options: { applyId?: string; source?: string; limit?: number | null },
): Promise<WorkerSessionAppliesResponse> {
  const params = new URLSearchParams();
  if (options.applyId) params.set("applyId", options.applyId);
  if (options.source) params.set("source", options.source);
  if (options.limit) params.set("limit", String(options.limit));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/applies`, params),
  ) as WorkerSessionAppliesResponse;
}

async function acknowledgeWorkerSessionApplyResetAudit(
  sessionName: string,
  applyId: string,
  options: { dryRun: boolean },
): Promise<WorkerSessionApplyResetAuditAckResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/applies/${encodeURIComponent(applyId)}/reset-audit/ack`,
    { dryRun: options.dryRun },
  ) as WorkerSessionApplyResetAuditAckResponse;
}

async function fetchWorkerSessionApplyActions(
  sessionName: string,
  options: { applyId?: string; source?: string; limit?: number | null },
): Promise<WorkerSessionApplyActionsResponse> {
  const params = new URLSearchParams();
  if (options.applyId) params.set("applyId", options.applyId);
  if (options.source) params.set("source", options.source);
  if (options.limit) params.set("limit", String(options.limit));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-actions`, params),
  ) as WorkerSessionApplyActionsResponse;
}

async function fetchWorkerSessionApplyActionExecutions(
  sessionName: string,
  options: { executionId?: string; applyId?: string; action?: string; status?: string; limit?: number | null },
): Promise<WorkerSessionApplyActionExecutionsResponse> {
  const params = new URLSearchParams();
  if (options.executionId) params.set("executionId", options.executionId);
  if (options.applyId) params.set("applyId", options.applyId);
  if (options.action) params.set("action", options.action);
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", String(options.limit));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-action-executions`, params),
  ) as WorkerSessionApplyActionExecutionsResponse;
}

async function fetchWorkerSessionBranchRecoveryExecutions(
  sessionName: string,
  options: { executionId?: string; runId?: string; status?: string; limit?: number | null },
): Promise<WorkerSessionBranchRecoveryExecutionsResponse> {
  const params = new URLSearchParams();
  if (options.executionId) params.set("executionId", options.executionId);
  if (options.runId) params.set("runId", options.runId);
  if (options.status) params.set("status", options.status);
  if (options.limit) params.set("limit", String(options.limit));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/branch-recovery-executions`, params),
  ) as WorkerSessionBranchRecoveryExecutionsResponse;
}

async function fetchWorkerSessionDrainWorkers(
  sessionName: string,
  options: { workerId?: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  workers: Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
}> {
  const params = new URLSearchParams();
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.includeRetired) params.set("includeRetired", "1");
  params.set("lines", String(options.lines));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/drain-workers`, params),
  ) as {
    ok: true;
    session: string;
    count: number;
    workers: Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
  };
}

async function ensureWorkerSessionDrainWorkerViaServer(
  sessionName: string,
  options: { workerId?: string; maxContinuations?: number; lines: number },
): Promise<{
  ok: true;
  session: string;
  action: "existing" | "restarted" | "started" | "blocked";
  reason: string;
  worker: unknown;
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/drain-workers/ensure`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      ...(options.maxContinuations ? { maxContinuations: options.maxContinuations } : {}),
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    action: "existing" | "restarted" | "started" | "blocked";
    reason: string;
    worker: unknown;
    workers: unknown[];
  };
}

async function fetchWorkerSessionApplyActionWorkers(
  sessionName: string,
  options: { workerId?: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  workers: Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
}> {
  const params = new URLSearchParams();
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.includeRetired) params.set("includeRetired", "1");
  params.set("lines", String(options.lines));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-action-workers`, params),
  ) as {
    ok: true;
    session: string;
    count: number;
    workers: Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
  };
}

async function ensureWorkerSessionApplyActionWorkerViaServer(
  sessionName: string,
  options: {
    workerId?: string;
    applyId?: string;
    source?: string;
    action?: string;
    limit?: number | null;
    maxActions?: number | null;
    continueOnFailure: boolean;
    untilEmpty: boolean;
    maxPolls?: number | null;
    intervalMs?: number | null;
    lines: number;
  },
): Promise<{
  ok: true;
  session: string;
  action: "existing" | "restarted" | "started" | "blocked";
  reason: string;
  worker: unknown;
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-action-workers/ensure`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      ...(options.applyId ? { applyId: options.applyId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.maxActions ? { maxActions: options.maxActions } : {}),
      continueOnFailure: options.continueOnFailure,
      untilEmpty: options.untilEmpty,
      ...(options.maxPolls ? { maxPolls: options.maxPolls } : {}),
      ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    action: "existing" | "restarted" | "started" | "blocked";
    reason: string;
    worker: unknown;
    workers: unknown[];
  };
}

async function fetchWorkerSessionApplyActionWorkerNextSteps(
  sessionName: string,
): Promise<{
  ok: true;
  session: string;
  count: number;
  nextSteps: Array<{
    action: "restart_apply_action_worker";
    reason: "stopped_apply_action_worker";
    workerId: string;
    pid: number | null;
    stoppedAt: string;
    command: string[];
    commands: {
      restartApplyActionWorker: string[];
      inspectApplyActionWorkers: string[];
      retireApplyActionWorker: string[];
    };
    api: {
      restart: { method: "POST"; url: string; payload: { workerId: string } };
      inspect: { method: "GET"; url: string };
      retire: { method: "POST"; url: string; payload: { workerId: string; retire: true } };
    };
  }>;
  actions: { restart_apply_action_worker: number };
}> {
  return await requestJson(
    "GET",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-action-workers/next`,
  ) as {
    ok: true;
    session: string;
    count: number;
    nextSteps: Array<{
      action: "restart_apply_action_worker";
      reason: "stopped_apply_action_worker";
      workerId: string;
      pid: number | null;
      stoppedAt: string;
      command: string[];
      commands: {
        restartApplyActionWorker: string[];
        inspectApplyActionWorkers: string[];
        retireApplyActionWorker: string[];
      };
      api: {
        restart: { method: "POST"; url: string; payload: { workerId: string } };
        inspect: { method: "GET"; url: string };
        retire: { method: "POST"; url: string; payload: { workerId: string; retire: true } };
      };
    }>;
    actions: { restart_apply_action_worker: number };
  };
}

async function fetchWorkerSessionControlPlaneStatus(
  sessionName: string,
  options: { lines: number },
): Promise<WorkerSessionControlPlaneStatusResponse> {
  return await requestJson(
    "GET",
    withQuery(
      `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-status`,
      new URLSearchParams({ lines: String(options.lines) }),
    ),
  ) as WorkerSessionControlPlaneStatusResponse;
}

async function fetchWorkerSessionControlPlaneAlerts(
  sessionName: string,
  options: {
    limit: number;
    lines: number;
    severity?: string;
    surface?: string;
    reason?: string;
    runId?: string;
    workerId?: string;
    applyId?: string;
    executionId?: string;
    continuationId?: string;
    action?: string;
  },
): Promise<WorkerSessionControlPlaneAlertsResponse> {
  const params = new URLSearchParams({ limit: String(options.limit), lines: String(options.lines) });
  if (options.severity) params.set("severity", options.severity);
  if (options.surface) params.set("surface", options.surface);
  if (options.reason) params.set("reason", options.reason);
  if (options.runId) params.set("runId", options.runId);
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.applyId) params.set("applyId", options.applyId);
  if (options.executionId) params.set("executionId", options.executionId);
  if (options.continuationId) params.set("continuationId", options.continuationId);
  if (options.action) params.set("action", options.action);
  return await requestJson(
    "GET",
    withQuery(
      `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-alerts`,
      params,
    ),
  ) as WorkerSessionControlPlaneAlertsResponse;
}

async function fetchWorkerSessionControlPlaneAlertPreview(
  sessionName: string,
  options: {
    lines: number;
    severity?: string;
    surface?: string;
    reason?: string;
    runId?: string;
    workerId?: string;
    applyId?: string;
    executionId?: string;
    continuationId?: string;
    action?: string;
  },
): Promise<WorkerSessionControlPlaneAlertPreviewResponse> {
  const params = new URLSearchParams({ lines: String(options.lines) });
  if (options.severity) params.set("severity", options.severity);
  if (options.surface) params.set("surface", options.surface);
  if (options.reason) params.set("reason", options.reason);
  if (options.runId) params.set("runId", options.runId);
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.applyId) params.set("applyId", options.applyId);
  if (options.executionId) params.set("executionId", options.executionId);
  if (options.continuationId) params.set("continuationId", options.continuationId);
  if (options.action) params.set("action", options.action);
  return await requestJson(
    "GET",
    withQuery(
      `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-alert`,
      params,
    ),
  ) as WorkerSessionControlPlaneAlertPreviewResponse;
}

async function executeWorkerSessionControlPlaneAlert(
  sessionName: string,
  options: {
    dryRun: boolean;
    confirm: boolean;
    lines: number;
    detailCommand?: string;
    severity?: string;
    surface?: string;
    reason?: string;
    runId?: string;
    workerId?: string;
    applyId?: string;
    executionId?: string;
    continuationId?: string;
    action?: string;
  },
): Promise<WorkerSessionControlPlaneAlertExecuteResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-alert/execute`,
    {
      dryRun: options.dryRun,
      confirm: options.confirm,
      lines: options.lines,
      detailCommand: options.detailCommand,
      severity: options.severity,
      surface: options.surface,
      reason: options.reason,
      runId: options.runId,
      workerId: options.workerId,
      applyId: options.applyId,
      executionId: options.executionId,
      continuationId: options.continuationId,
      action: options.action,
    },
  ) as WorkerSessionControlPlaneAlertExecuteResponse;
}

function workerSessionControlPlaneAlertPreviewCommands(
  preview: WorkerSessionControlPlaneAlertPreviewResponse,
): Array<{
  scope: "control_plane_alert";
  surface: string;
  severity: string;
  reason: string;
  count: number;
  runId?: string;
  workerId?: string;
  applyId?: string;
  executionId?: string;
  continuationIds?: string[];
  action?: string;
  command: string[];
}> {
  if (!preview.alert) return [];
  const base = {
    scope: "control_plane_alert" as const,
    surface: preview.alert.surface,
    severity: preview.alert.severity,
    reason: preview.alert.reason,
    count: preview.alert.count,
    runId: preview.alert.runId,
    workerId: preview.alert.workerId,
    applyId: preview.alert.applyId,
    executionId: preview.alert.executionId,
    continuationIds: preview.alert.continuationIds,
  };
  const commands = [
    { ...base, action: preview.alert.action, command: preview.alert.command },
  ];
  if (preview.details?.kind === "apply_action_execution") {
    commands.push(
      { ...base, action: "inspect_apply", command: preview.details.commands.inspectApply },
      { ...base, action: "inspect_apply_action_executions", command: preview.details.commands.inspectApplyActionExecutions },
      { ...base, action: "execute_apply_action", command: preview.details.commands.executeAction },
    );
    if (preview.details.commands.acknowledgeResetAudit) {
      commands.push({ ...base, action: "acknowledge_reset_audit", command: preview.details.commands.acknowledgeResetAudit });
    }
  }
  if (preview.details?.kind === "drain_continuations") {
    commands.push(
      { ...base, action: "inspect_failed_drain_continuations", command: preview.details.commands.inspectFailed },
      { ...base, action: "reset_failed_drain_continuations", command: preview.details.commands.resetFailed },
    );
    if (preview.details.commands.resetSelectedFailed) {
      commands.push({ ...base, action: "reset_selected_failed_drain_continuations", command: preview.details.commands.resetSelectedFailed });
    }
  }
  const seen = new Set<string>();
  return commands.filter((entry) => {
    const key = commandKey(entry.command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectWorkerSessionControlPlaneNextActions(
  status: WorkerSessionControlPlaneStatusResponse,
): Array<WorkerSessionControlPlaneAdvanceAction> {
  const nextActions: Array<WorkerSessionControlPlaneAdvanceAction> = [];
  const staleRun = status.staleRuns.nextSteps.find((step) => step.action === "recover_session_run");
  if (staleRun) {
    nextActions.push({
      surface: "stale_run",
      action: "recover_stale_run",
      reason: staleRun.reason,
      count: status.staleRuns.counts.ready,
      command: staleRun.command,
      runId: staleRun.runId,
      ...(staleRun.workerId ? { workerId: staleRun.workerId } : {}),
    });
  }
  const branch = status.branches.nextSteps.find((step) => step.action === "resume_branch");
  if (branch) {
    nextActions.push({
      surface: "branch",
      action: "resume_branch",
      reason: branch.reason,
      count: status.branches.counts.ready,
      command: branch.command,
      runId: branch.runId,
      ...(branch.workerId ? { workerId: branch.workerId } : {}),
    });
  }
  const applyAction = status.queues.applyActionNextSteps.nextSteps[0];
  if (applyAction) {
    nextActions.push({
      surface: "apply_action",
      action: "execute_next_apply_action",
      reason: applyAction.action,
      count: status.queues.applyActions.actionable,
      command: applyAction.executeCommand,
      applyId: applyAction.applyId,
    });
  }
  if (status.queues.drainContinuations.queued > 0) {
    nextActions.push({
      surface: "drain_continuation",
      action: "execute_next_drain_continuation",
      reason: "queued_drain_continuation",
      count: status.queues.drainContinuations.queued,
      command: ["npm", "run", "cli", "--", "runs", "session-drain-continuations", status.session, "--execute-next"],
    });
  }
  const workerRecovery = [
    ...status.recovery.nextSteps.watchWorkers,
    ...status.recovery.nextSteps.drainWorkers,
    ...status.recovery.nextSteps.applyActionWorkers,
    ...status.recovery.nextSteps.controlPlaneAdvanceWorkers,
    ...status.recovery.nextSteps.controlPlaneTickWorkers,
  ][0];
  if (workerRecovery) {
    nextActions.push({
      surface: "worker_recovery",
      action: workerRecovery.action,
      reason: workerRecovery.reason,
      count: status.recovery.count,
      command: workerRecovery.command,
      workerId: workerRecovery.workerId,
    });
  }
  return nextActions;
}

function summarizeWorkerSessionControlPlaneStatus(
  status: WorkerSessionControlPlaneStatusResponse,
): {
  ok: true;
  session: string;
  needsAction: boolean;
  workers: WorkerSessionControlPlaneStatusResponse["workers"];
  queues: {
    applyActions: Pick<WorkerSessionControlPlaneStatusResponse["queues"]["applyActions"], "total" | "actionable" | "resumeNeeded" | "resetAudits" | "waiting" | "failed" | "pending">;
    drainContinuations: Pick<WorkerSessionControlPlaneStatusResponse["queues"]["drainContinuations"], "total" | "queued" | "running" | "failed">;
    applyActionExecutions: WorkerSessionControlPlaneStatusResponse["queues"]["applyActionExecutions"]["counts"];
  };
  branches: {
    counts: WorkerSessionControlPlaneStatusResponse["branches"]["counts"];
    actions: WorkerSessionControlPlaneStatusResponse["branches"]["actions"];
    executions: WorkerSessionControlPlaneStatusResponse["branches"]["executions"]["counts"];
  };
  staleRuns: {
    counts: WorkerSessionControlPlaneStatusResponse["staleRuns"]["counts"];
    actions: WorkerSessionControlPlaneStatusResponse["staleRuns"]["actions"];
  };
  recovery: {
    count: number;
    actions: Record<string, number>;
  };
  nextActions: WorkerSessionControlPlaneAdvanceAction[];
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
} {
  const nextActions = selectWorkerSessionControlPlaneNextActions(status);
  return {
    ok: true,
    session: status.session,
    needsAction: nextActions.length > 0,
    workers: status.workers,
    queues: {
      applyActions: {
        total: status.queues.applyActions.total,
        actionable: status.queues.applyActions.actionable,
        resumeNeeded: status.queues.applyActions.resumeNeeded,
        resetAudits: status.queues.applyActions.resetAudits,
        waiting: status.queues.applyActions.waiting,
        failed: status.queues.applyActions.failed,
        pending: status.queues.applyActions.pending,
      },
      drainContinuations: {
        total: status.queues.drainContinuations.total,
        queued: status.queues.drainContinuations.queued,
        running: status.queues.drainContinuations.running,
        failed: status.queues.drainContinuations.failed,
      },
      applyActionExecutions: status.queues.applyActionExecutions.counts,
    },
    branches: {
      counts: status.branches.counts,
      actions: status.branches.actions,
      executions: status.branches.executions.counts,
    },
    staleRuns: {
      counts: status.staleRuns.counts,
      actions: status.staleRuns.actions,
    },
    recovery: {
      count: status.recovery.count,
      actions: status.recovery.actions,
    },
    nextActions,
    commands: {
      fullStatus: ["npm", "run", "cli", "--", "runs", "session-control-plane-status", status.session, "--server"],
      advance: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", status.session, "--server"],
      advanceDryRun: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance", status.session, "--server", "--dry-run"],
      advanceLoop: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance-loop", status.session, "--server"],
      advanceLoopDryRun: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance-loop", status.session, "--server", "--dry-run"],
      tick: ["npm", "run", "cli", "--", "runs", "session-control-plane-tick", status.session, "--server"],
      tickDryRun: ["npm", "run", "cli", "--", "runs", "session-control-plane-tick", status.session, "--server", "--dry-run"],
      timelineSummary: ["npm", "run", "cli", "--", "runs", "session-control-plane-timeline", status.session, "--server", "--summary"],
    },
  };
}

async function executeWorkerSessionControlPlaneAdvance(
  sessionName: string,
  options: { dryRun: boolean; lines: number },
): Promise<WorkerSessionControlPlaneAdvanceResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance`,
    { dryRun: options.dryRun, lines: options.lines },
  ) as WorkerSessionControlPlaneAdvanceResponse;
}

async function executeWorkerSessionControlPlaneAdvanceLoop(
  sessionName: string,
  options: { dryRun: boolean; lines: number; maxSteps: number; intervalMs: number },
): Promise<WorkerSessionControlPlaneAdvanceLoopResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-loop`,
    {
      dryRun: options.dryRun,
      lines: options.lines,
      maxSteps: options.maxSteps,
      intervalMs: options.intervalMs,
    },
  ) as WorkerSessionControlPlaneAdvanceLoopResponse;
}

async function fetchWorkerSessionControlPlaneAdvances(
  sessionName: string,
  options: { limit: number; advanceId?: string; blocked?: boolean; mutating?: boolean },
): Promise<WorkerSessionControlPlaneAdvancesResponse> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.advanceId) params.set("advanceId", options.advanceId);
  if (options.blocked !== undefined) params.set("blocked", String(options.blocked));
  if (options.mutating !== undefined) params.set("mutating", String(options.mutating));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advances`, params),
  ) as WorkerSessionControlPlaneAdvancesResponse;
}

async function startWorkerSessionControlPlaneAdvanceWorker(
  sessionName: string,
  options: { workerId?: string; dryRun: boolean; maxSteps: number; intervalMs: number; lines: number; drainConfirmations?: boolean; confirm?: boolean; maxConfirmations?: number; untilEmpty?: boolean },
): Promise<{
  ok: true;
  session: string;
  worker: unknown;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-workers`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      dryRun: options.dryRun,
      maxSteps: options.maxSteps,
      intervalMs: options.intervalMs,
      lines: options.lines,
      drainConfirmations: options.drainConfirmations ?? false,
      confirm: options.confirm ?? false,
      maxConfirmations: options.maxConfirmations ?? 3,
      untilEmpty: options.untilEmpty ?? false,
    },
  ) as { ok: true; session: string; worker: unknown };
}

async function ensureWorkerSessionControlPlaneAdvanceWorker(
  sessionName: string,
  options: { workerId?: string; dryRun: boolean; maxSteps: number; intervalMs: number; lines: number; drainConfirmations?: boolean; confirm?: boolean; maxConfirmations?: number; untilEmpty?: boolean },
): Promise<{
  ok: true;
  session: string;
  action: "existing" | "restarted" | "started" | "blocked";
  reason: string;
  worker: unknown;
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-workers/ensure`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      dryRun: options.dryRun,
      maxSteps: options.maxSteps,
      intervalMs: options.intervalMs,
      lines: options.lines,
      drainConfirmations: options.drainConfirmations ?? false,
      confirm: options.confirm ?? false,
      maxConfirmations: options.maxConfirmations ?? 3,
      untilEmpty: options.untilEmpty ?? false,
    },
  ) as {
    ok: true;
    session: string;
    action: "existing" | "restarted" | "started" | "blocked";
    reason: string;
    worker: unknown;
    workers: unknown[];
  };
}

async function fetchWorkerSessionControlPlaneAdvanceWorkers(
  sessionName: string,
  options: { workerId?: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  workers: unknown[];
}> {
  const params = new URLSearchParams();
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.includeRetired) params.set("includeRetired", "1");
  params.set("lines", String(options.lines));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-workers`, params),
  ) as { ok: true; session: string; count: number; workers: unknown[] };
}

async function fetchWorkerSessionControlPlaneAdvanceWorkerNextSteps(
  sessionName: string,
  options: { workerId?: string } = {},
): Promise<{
  ok: true;
  session: string;
  count: number;
  nextSteps: unknown[];
  actions: { restart_control_plane_advance_worker: number };
}> {
  const params = new URLSearchParams();
  if (options.workerId) params.set("workerId", options.workerId);
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-workers/next`, params),
  ) as {
    ok: true;
    session: string;
    count: number;
    nextSteps: unknown[];
    actions: { restart_control_plane_advance_worker: number };
  };
}

async function restartWorkerSessionControlPlaneAdvanceWorker(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  restarted: unknown[];
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-workers/restart`,
    {
      workerId: options.workerId,
      includeRetired: options.includeRetired,
      lines: options.lines,
    },
  ) as { ok: true; session: string; count: number; restarted: unknown[]; workers: unknown[] };
}

async function stopWorkerSessionControlPlaneAdvanceWorkers(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  stopped: unknown[];
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-advance-workers/stop`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      retire: options.retire,
      lines: options.lines,
    },
  ) as { ok: true; session: string; count: number; stopped: unknown[]; workers: unknown[] };
}

async function executeWorkerSessionControlPlaneTick(
  sessionName: string,
  options: { dryRun: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  tickPath: string;
  tick: WorkerSessionControlPlaneTickRecord;
  planned: WorkerSessionControlPlaneTickRecord["planned"];
  executed: WorkerSessionControlPlaneTickRecord["executed"];
  before: Awaited<ReturnType<typeof fetchWorkerSessionControlPlaneStatus>>;
  after: Awaited<ReturnType<typeof fetchWorkerSessionControlPlaneStatus>>;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick`,
    { dryRun: options.dryRun, lines: options.lines },
  ) as {
    ok: true;
    session: string;
    observedAt: string;
    completedAt: string;
    dryRun: boolean;
    tickPath: string;
    tick: WorkerSessionControlPlaneTickRecord;
    planned: WorkerSessionControlPlaneTickRecord["planned"];
    executed: WorkerSessionControlPlaneTickRecord["executed"];
    before: Awaited<ReturnType<typeof fetchWorkerSessionControlPlaneStatus>>;
    after: Awaited<ReturnType<typeof fetchWorkerSessionControlPlaneStatus>>;
  };
}

async function executeWorkerSessionControlPlaneTickLoop(
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
  ticks: WorkerSessionControlPlaneTickRecord[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-loop`,
    {
      dryRun: options.dryRun,
      lines: options.lines,
      maxTicks: options.maxTicks,
      intervalMs: options.intervalMs,
    },
  ) as {
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
    ticks: WorkerSessionControlPlaneTickRecord[];
  };
}

async function fetchWorkerSessionControlPlaneTicks(
  sessionName: string,
  options: { limit?: number; tickIds?: string[] } = {},
): Promise<{
  ok: true;
  session: string;
  filter?: { tickIds: string[] };
  count: number;
  ticks: WorkerSessionControlPlaneTickWithDecision[];
}> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 20) });
  if (options.tickIds && options.tickIds.length > 0) params.set("tickId", options.tickIds.join(","));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-ticks`, params),
  ) as {
    ok: true;
    session: string;
    filter?: { tickIds: string[] };
    count: number;
    ticks: WorkerSessionControlPlaneTickWithDecision[];
  };
}

async function listWorkerSessionControlPlaneTickRecords(
  sessionName: string,
  options: { limit?: number; tickIds?: string[] } = {},
): Promise<{
  ok: true;
  session: string;
  filter: { tickIds: string[] };
  count: number;
  ticks: WorkerSessionControlPlaneTickWithDecision[];
}> {
  const limit = options.limit ?? 20;
  const tickIdFilter = options.tickIds && options.tickIds.length > 0 ? new Set(options.tickIds) : null;
  const tickDir = workerSessionControlPlaneTickDir(sessionName);
  try {
    const entries = await fs.readdir(tickDir, { withFileTypes: true });
    const ticks = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(tickDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionControlPlaneTickRecord;
      }));
    const filteredTicks = ticks.filter((tick) => !tickIdFilter || tickIdFilter.has(tick.tickId));
    return {
      ok: true,
      session: sessionName,
      filter: { tickIds: options.tickIds ?? [] },
      count: Math.min(filteredTicks.length, limit),
      ticks: filteredTicks
        .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
        .slice(0, limit)
        .map((tick) => ({
          ...tick,
          decision: summarizeWorkerSessionControlPlaneTickDecision(tick),
        })),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, session: sessionName, filter: { tickIds: options.tickIds ?? [] }, count: 0, ticks: [] };
    }
    throw error;
  }
}

async function fetchWorkerSessionControlPlaneTimeline(
  sessionName: string,
  options: {
    limit: number;
    lines: number;
    source?: string;
    event?: string;
    status?: string;
    tickId?: string;
    advanceId?: string;
    workerId?: string;
    executionId?: string;
    applyId?: string;
    runId?: string;
  },
): Promise<WorkerSessionControlPlaneTimelineResponse> {
  const params = new URLSearchParams({ limit: String(options.limit), lines: String(options.lines) });
  if (options.source) params.set("source", options.source);
  if (options.event) params.set("event", options.event);
  if (options.status) params.set("status", options.status);
  if (options.tickId) params.set("tickId", options.tickId);
  if (options.advanceId) params.set("advanceId", options.advanceId);
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.executionId) params.set("executionId", options.executionId);
  if (options.applyId) params.set("applyId", options.applyId);
  if (options.runId) params.set("runId", options.runId);
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-timeline`, params),
  ) as WorkerSessionControlPlaneTimelineResponse;
}

function summarizeWorkerSessionControlPlaneTimeline(
  timeline: WorkerSessionControlPlaneTimelineResponse,
  latestLimit: number,
): {
  ok: true;
  session: string;
  filter: WorkerSessionControlPlaneTimelineResponse["filter"];
  events: { total: number; counts: Record<string, number> };
  decisions: WorkerSessionControlPlaneTimelineResponse["decisions"];
  latestEvents: Array<{
    observedAt: string;
    source: string;
    event: string;
    tickId?: string;
    advanceId?: string;
    workerId?: string;
    executionId?: string;
    status?: string;
    exitCode?: number | null;
    state?: string;
    reason?: string;
    restartable?: boolean;
    dryRun?: boolean;
    selectedSurface?: string;
    selectedAction?: string;
    selectedCount?: number;
    selected?: number;
    resumedCount?: number;
    skippedCount?: number;
  }>;
  commands: { fullTimeline: string[] };
} {
  return {
    ok: true,
    session: timeline.session,
    filter: timeline.filter,
    events: {
      total: timeline.count,
      counts: timeline.counts,
    },
    decisions: timeline.decisions,
    latestEvents: timeline.events.slice(0, latestLimit).map((event) => ({
      observedAt: event.observedAt,
      source: event.source,
      event: event.event,
      tickId: event.tickId,
      advanceId: event.advanceId,
      workerId: event.workerId,
      executionId: event.executionId,
      status: event.status,
      exitCode: event.exitCode,
      state: event.state,
      reason: event.reason,
      restartable: event.restartable,
      dryRun: event.dryRun,
      selectedSurface: event.selectedSurface,
      selectedAction: event.selectedAction,
      selectedCount: event.selectedCount,
      selected: event.selected,
      resumedCount: event.resumedCount,
      skippedCount: event.skippedCount,
    })),
    commands: {
      fullTimeline: [
        "npm", "run", "cli", "--", "runs", "session-control-plane-timeline", timeline.session, "--server",
        ...(timeline.filter.sources.length > 0 ? ["--source", timeline.filter.sources.join(",")] : []),
        ...(timeline.filter.events.length > 0 ? ["--event", timeline.filter.events.join(",")] : []),
        ...(timeline.filter.statuses.length > 0 ? ["--status", timeline.filter.statuses.join(",")] : []),
        ...(timeline.filter.tickIds.length > 0 ? ["--tick", timeline.filter.tickIds.join(",")] : []),
        ...(timeline.filter.advanceIds.length > 0 ? ["--advance", timeline.filter.advanceIds.join(",")] : []),
        ...(timeline.filter.workerIds.length > 0 ? ["--worker", timeline.filter.workerIds.join(",")] : []),
        ...(timeline.filter.executionIds.length > 0 ? ["--execution", timeline.filter.executionIds.join(",")] : []),
        ...(timeline.filter.applyIds.length > 0 ? ["--apply", timeline.filter.applyIds.join(",")] : []),
        ...(timeline.filter.runIds.length > 0 ? ["--run", timeline.filter.runIds.join(",")] : []),
      ],
    },
  };
}

async function startWorkerSessionControlPlaneTickWorker(
  sessionName: string,
  options: { workerId?: string; dryRun: boolean; maxTicks: number; intervalMs: number; lines: number },
): Promise<{
  ok: true;
  session: string;
  worker: unknown;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-workers`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      dryRun: options.dryRun,
      maxTicks: options.maxTicks,
      intervalMs: options.intervalMs,
      lines: options.lines,
    },
  ) as { ok: true; session: string; worker: unknown };
}

async function ensureWorkerSessionControlPlaneTickWorker(
  sessionName: string,
  options: { workerId?: string; dryRun: boolean; maxTicks: number; intervalMs: number; lines: number },
): Promise<{
  ok: true;
  session: string;
  action: "existing" | "restarted" | "started" | "blocked";
  reason: string;
  worker: unknown;
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-workers/ensure`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      dryRun: options.dryRun,
      maxTicks: options.maxTicks,
      intervalMs: options.intervalMs,
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    action: "existing" | "restarted" | "started" | "blocked";
    reason: string;
    worker: unknown;
    workers: unknown[];
  };
}

async function fetchWorkerSessionControlPlaneTickWorkers(
  sessionName: string,
  options: { workerId?: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  workers: unknown[];
}> {
  const params = new URLSearchParams();
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.includeRetired) params.set("includeRetired", "1");
  params.set("lines", String(options.lines));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-workers`, params),
  ) as { ok: true; session: string; count: number; workers: unknown[] };
}

async function fetchWorkerSessionControlPlaneTickWorkerNextSteps(
  sessionName: string,
  options: { workerId?: string } = {},
): Promise<{
  ok: true;
  session: string;
  count: number;
  nextSteps: unknown[];
  actions: { restart_control_plane_tick_worker: number };
}> {
  const params = new URLSearchParams();
  if (options.workerId) params.set("workerId", options.workerId);
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-workers/next`, params),
  ) as {
    ok: true;
    session: string;
    count: number;
    nextSteps: unknown[];
    actions: { restart_control_plane_tick_worker: number };
  };
}

async function restartWorkerSessionControlPlaneTickWorker(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  restarted: unknown[];
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-workers/restart`,
    {
      workerId: options.workerId,
      includeRetired: options.includeRetired,
      lines: options.lines,
    },
  ) as { ok: true; session: string; count: number; restarted: unknown[]; workers: unknown[] };
}

async function stopWorkerSessionControlPlaneTickWorkers(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  stopped: unknown[];
  workers: unknown[];
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/control-plane-tick-workers/stop`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      retire: options.retire,
      lines: options.lines,
    },
  ) as { ok: true; session: string; count: number; stopped: unknown[]; workers: unknown[] };
}

async function fetchWorkerSessionBranches(
  sessionName: string,
  options: {
    status?: string;
    workerId?: string;
    checkoutDir?: string;
    branchAction?: string;
    runId?: string;
    limit?: number;
    offset?: number;
    resumable: boolean;
  },
): Promise<{
  ok: true;
  observedAt: string;
  session: string;
  checkoutDir: string;
  filter: {
    statuses: string[];
    resumable: boolean;
    workerId: string | null;
    branchAction?: string[];
    runIds?: string[];
    limit?: number | null;
    offset?: number;
    totalNextSteps?: number;
    visibleNextSteps?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  };
  summary: { agents: number; total: number; resultCommits: number; resumable: number; warnings: number };
  resultCommits: unknown[];
  resumableBranches: unknown[];
  nextSteps: Array<{
    action: string;
    reason: string;
    agentId: string;
    runId: string;
    status: string;
    state: string;
    warning?: string | null;
    workerId: string | null;
    location: string | null;
    branchName: string;
    resultCommit: string | null;
    command: string[];
  }>;
  agents: unknown[];
}> {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.workerId) params.set("workerId", options.workerId);
  if (options.checkoutDir) params.set("checkoutDir", options.checkoutDir);
  if (options.branchAction) params.set("branchAction", options.branchAction);
  if (options.runId) params.set("runId", options.runId);
  if (options.limit) params.set("limit", String(options.limit));
  if (options.offset && options.offset > 0) params.set("offset", String(options.offset));
  if (options.resumable) params.set("resumable", "1");
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/branches`, params),
	  ) as {
	    ok: true;
	    observedAt: string;
	    session: string;
	    checkoutDir: string;
	    filter: {
	      statuses: string[];
	      resumable: boolean;
	      workerId: string | null;
	      branchAction?: string[];
	      runIds?: string[];
	      limit?: number | null;
	      offset?: number;
	      totalNextSteps?: number;
	      visibleNextSteps?: number;
	      hasMore?: boolean;
	      nextOffset?: number | null;
	    };
	    summary: { agents: number; total: number; resultCommits: number; resumable: number; warnings: number };
	    resultCommits: unknown[];
	    resumableBranches: unknown[];
	    nextSteps: Array<{
	      action: string;
      reason: string;
      agentId: string;
	      runId: string;
	      status: string;
	      state: string;
	      warning?: string | null;
	      workerId: string | null;
	      location: string | null;
	      branchName: string;
	      resultCommit: string | null;
	      command: string[];
	    }>;
	    agents: unknown[];
	  };
}

async function stopWorkerSessionDrainWorkersViaServer(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/drain-workers/stop`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      retire: options.retire,
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    count: number;
    stopped: Array<{
      workerId: string;
      pid: number | null;
      aliveBefore: boolean;
      stopped: boolean;
      signalSent: boolean;
      forced: boolean;
      alive: boolean;
      stoppedAt: string;
      retiredAt?: string;
    }>;
    workers: Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
  };
}

async function restartWorkerSessionDrainWorkerViaServer(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/drain-workers/restart`,
    {
      workerId: options.workerId,
      includeRetired: options.includeRetired,
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    count: number;
    restarted: Array<{
      workerId: string;
      previousPid: number | null;
      pid: number | null;
      restartedAt: string;
      restartCount: number;
      command: string[];
    }>;
    workers: Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
  };
}

async function stopWorkerSessionApplyActionWorkersViaServer(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-action-workers/stop`,
    {
      ...(options.workerId ? { workerId: options.workerId } : {}),
      retire: options.retire,
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    count: number;
    stopped: Array<{
      workerId: string;
      pid: number | null;
      aliveBefore: boolean;
      stopped: boolean;
      signalSent: boolean;
      forced: boolean;
      alive: boolean;
      stoppedAt: string;
      retiredAt?: string;
    }>;
    workers: Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
  };
}

async function restartWorkerSessionApplyActionWorkerViaServer(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  ok: true;
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
}> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-action-workers/restart`,
    {
      workerId: options.workerId,
      includeRetired: options.includeRetired,
      lines: options.lines,
    },
  ) as {
    ok: true;
    session: string;
    count: number;
    restarted: Array<{
      workerId: string;
      previousPid: number | null;
      pid: number | null;
      restartedAt: string;
      restartCount: number;
      command: string[];
    }>;
    workers: Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>;
  };
}

async function executeNextWorkerSessionApplyAction(
  sessionName: string,
  options: { applyId?: string; source?: string; action?: string; limit?: number | null },
): Promise<ExecuteNextWorkerSessionApplyActionResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-actions/execute-next`,
    {
      ...(options.applyId ? { applyId: options.applyId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    },
  ) as ExecuteNextWorkerSessionApplyActionResponse;
}

async function executeQueuedWorkerSessionApplyActions(
  sessionName: string,
  options: {
    applyId?: string;
    source?: string;
    action?: string;
    limit?: number | null;
    maxActions?: number | null;
    stopOnFailure: boolean;
  },
): Promise<ExecuteQueuedWorkerSessionApplyActionsResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-actions/execute-queued`,
    {
      ...(options.applyId ? { applyId: options.applyId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.maxActions ? { maxActions: options.maxActions } : {}),
      stopOnFailure: options.stopOnFailure,
    },
  ) as ExecuteQueuedWorkerSessionApplyActionsResponse;
}

async function executeQueuedWorkerSessionApplyActionLoop(
  sessionName: string,
  options: {
    applyId?: string;
    source?: string;
    action?: string;
    limit?: number | null;
    maxActions?: number | null;
    stopOnFailure: boolean;
    maxPolls?: number | null;
    intervalMs?: number | null;
  },
): Promise<ExecuteQueuedWorkerSessionApplyActionsLoopResponse> {
  const observedAt = new Date().toISOString();
  const maxPolls = options.maxPolls ?? 10;
  const intervalMs = options.intervalMs ?? 2000;
  const seenActionKeys = new Set<string>();
  const polls: ExecuteQueuedWorkerSessionApplyActionsLoopResponse["polls"] = [];
  let stoppedReason: ExecuteQueuedWorkerSessionApplyActionsLoopResponse["stoppedReason"] = "max_polls";
  let repeatedActions: string[] = [];
  let remainingQueued = 0;
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const response = await executeQueuedWorkerSessionApplyActions(sessionName, options);
    polls.push({ ...response, poll, observedAt: new Date().toISOString() });
    for (const execution of response.executions) {
      seenActionKeys.add(workerSessionApplyActionKey(execution.action));
    }
    if (response.stoppedOnFailure) {
      stoppedReason = "failed_action";
      remainingQueued = response.remainingQueued;
      break;
    }
    const nextQueue = await fetchWorkerSessionApplyActions(sessionName, {
      applyId: options.applyId,
      source: options.source,
      limit: options.limit,
    });
    const nextActions = nextQueue.actionQueue.actions
      .filter((action) => !options.action || action.action === options.action);
    remainingQueued = nextActions.length;
    if (nextActions.length === 0) {
      stoppedReason = "empty";
      break;
    }
    repeatedActions = nextActions
      .map(workerSessionApplyActionKey)
      .filter((key) => seenActionKeys.has(key));
    if (repeatedActions.length > 0) {
      stoppedReason = "repeated_action";
      break;
    }
    if (poll < maxPolls) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  const executions = applyActionExecutionResponses({ polls });
  return {
    ok: true,
    session: sessionName,
    observedAt,
    completedAt: new Date().toISOString(),
    executed: executions.length,
    failed: executions.filter((execution) => execution.exitCode !== 0).length,
    maxPolls,
    intervalMs,
    stoppedReason,
    remainingQueued,
    repeatedActions,
    filter: {
      ...(options.applyId ? { applyId: options.applyId } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.action ? { action: options.action } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
      ...(options.maxActions ? { maxActions: options.maxActions } : {}),
      stopOnFailure: options.stopOnFailure,
    },
    polls,
  };
}

function applyActionExecutionResponses(
  response: ExecuteQueuedWorkerSessionApplyActionsResponse | { polls: ExecuteQueuedWorkerSessionApplyActionsLoopResponse["polls"] },
): ExecuteQueuedWorkerSessionApplyActionsResponse["executions"] {
  return "polls" in response
    ? response.polls.flatMap((poll) => poll.executions)
    : response.executions;
}

function workerSessionApplyActionKey(
  action: WorkerSessionApplyActionsResponse["actionQueue"]["actions"][number],
): string {
  return `${action.applyId}:${action.source}:${action.action}`;
}

async function completeApplyActionWorkerRunSummary(
  sessionName: string,
  workerId: string,
  response: ExecuteQueuedWorkerSessionApplyActionsResponse | ExecuteQueuedWorkerSessionApplyActionsLoopResponse,
): Promise<void> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(workerId);
  const worker = await readApplyActionWorkerEventually(sessionName, workerId);
  await writeApplyActionWorker({
    ...worker,
    lastRun: summarizeApplyActionWorkerRun(response),
  });
}

async function readApplyActionWorkerEventually(sessionName: string, workerId: string): Promise<ApplyActionWorker> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await readApplyActionWorker(sessionName, workerId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await sleep(50);
    }
  }
  return await readApplyActionWorker(sessionName, workerId);
}

function summarizeApplyActionWorkerRun(
  response: ExecuteQueuedWorkerSessionApplyActionsResponse | ExecuteQueuedWorkerSessionApplyActionsLoopResponse,
): ApplyActionWorkerRunSummary {
  const loopResponse = "polls" in response;
  const polls = loopResponse
    ? response.polls.map((poll) => ({
      poll: poll.poll,
      observedAt: poll.observedAt,
      executed: poll.executed,
      failed: poll.executions.filter((execution) => execution.exitCode !== 0).length,
      remainingQueued: poll.remainingQueued,
      stoppedOnFailure: poll.stoppedOnFailure,
    }))
    : [{
      poll: 1,
      observedAt: new Date().toISOString(),
      executed: response.executed,
      failed: response.executions.filter((execution) => execution.exitCode !== 0).length,
      remainingQueued: response.remainingQueued,
      stoppedOnFailure: response.stoppedOnFailure,
    }];
  const failed = loopResponse
    ? response.failed
    : response.executions.filter((execution) => execution.exitCode !== 0).length;
  return {
    recordedAt: new Date().toISOString(),
    status: failed > 0 ? "failed" : "completed",
    executed: response.executed,
    failed,
    remainingQueued: response.remainingQueued,
    stoppedReason: loopResponse
      ? response.stoppedReason
      : response.stoppedOnFailure
        ? "failed_action"
        : "batch_complete",
    ...(loopResponse ? {
      maxPolls: response.maxPolls,
      intervalMs: response.intervalMs,
      repeatedActions: response.repeatedActions,
    } : {}),
    filter: response.filter,
    polls,
  };
}

async function queueWorkerSessionDrainContinuations(
  sessionName: string,
  options: { drainPrefix?: string[]; dryRun: boolean; maxPolls?: number; intervalMs?: number },
): Promise<QueueWorkerSessionDrainContinuationsResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations`,
    {
      ...(options.drainPrefix ? { drainPrefix: options.drainPrefix } : {}),
      dryRun: options.dryRun,
      ...(options.maxPolls ? { maxPolls: options.maxPolls } : {}),
      ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
    },
  ) as QueueWorkerSessionDrainContinuationsResponse;
}

async function executeWorkerSessionDrainContinuation(
  sessionName: string,
  continuationId: string,
): Promise<ExecuteWorkerSessionDrainContinuationResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations/${encodeURIComponent(continuationId)}/execute`,
  ) as ExecuteWorkerSessionDrainContinuationResponse;
}

async function executeNextWorkerSessionDrainContinuation(
  sessionName: string,
): Promise<ExecuteNextWorkerSessionDrainContinuationResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations/execute-next`,
  ) as ExecuteNextWorkerSessionDrainContinuationResponse;
}

async function executeQueuedWorkerSessionDrainContinuations(
  sessionName: string,
  options: { maxContinuations?: number },
): Promise<ExecuteQueuedWorkerSessionDrainContinuationsResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations/execute-queued`,
    {
      ...(options.maxContinuations ? { maxContinuations: options.maxContinuations } : {}),
    },
  ) as ExecuteQueuedWorkerSessionDrainContinuationsResponse;
}

async function resetRunningWorkerSessionDrainContinuations(
  sessionName: string,
  options: { olderThanMs?: number },
): Promise<ResetRunningWorkerSessionDrainContinuationsResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations/reset-running`,
    {
      ...(options.olderThanMs ? { olderThanMs: options.olderThanMs } : {}),
    },
  ) as ResetRunningWorkerSessionDrainContinuationsResponse;
}

async function resetFailedWorkerSessionDrainContinuations(
  sessionName: string,
  options: { continuationIds?: string[] },
): Promise<ResetFailedWorkerSessionDrainContinuationsResponse> {
  return await requestJson(
    "POST",
    `/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations/reset-failed`,
    {
      ...(options.continuationIds ? { continuationIds: options.continuationIds } : {}),
    },
  ) as ResetFailedWorkerSessionDrainContinuationsResponse;
}

async function fetchWorkerSessionDrainContinuations(
  sessionName: string,
  limit?: string,
  status?: string[],
): Promise<WorkerSessionDrainContinuationsResponse> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", limit);
  if (status && status.length > 0) params.set("status", status.join(","));
  return await requestJson(
    "GET",
    withQuery(`/api/worker-sessions/${encodeURIComponent(sessionName)}/apply-drain-continuations`, params),
  ) as WorkerSessionDrainContinuationsResponse;
}

async function writeWorkerSessionDrainContinuationRecord(
  record: WorkerSessionDrainContinuationRecord,
): Promise<{ path: string; record: WorkerSessionDrainContinuationRecord }> {
  const continuationPath = workerSessionDrainContinuationPath(record.session, record.continuationId);
  await fs.mkdir(path.dirname(continuationPath), { recursive: true });
  await fs.writeFile(continuationPath, `${JSON.stringify(record, null, 2)}\n`);
  return { path: continuationPath, record };
}

function createDrainContinuationId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${Math.random().toString(16).slice(2, 10)}`;
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

type DrainContinuationWorker = {
  session: string;
  workerId: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  stoppedAt?: string;
  stopResult?: StopProcessGroupResult & { aliveBefore: boolean };
  retiredAt?: string;
  restartedAt?: string;
  restartCount?: number;
  previousPid?: number | null;
};

type ApplyActionWorker = {
  session: string;
  workerId: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  stoppedAt?: string;
  stopResult?: StopProcessGroupResult & { aliveBefore: boolean };
  retiredAt?: string;
  restartedAt?: string;
  restartCount?: number;
  previousPid?: number | null;
  lastRun?: ApplyActionWorkerRunSummary;
};

type ApplyActionWorkerRunSummary = {
  recordedAt: string;
  status: "completed" | "failed";
  executed: number;
  failed: number;
  remainingQueued: number;
  stoppedReason: "batch_complete" | ExecuteQueuedWorkerSessionApplyActionsLoopResponse["stoppedReason"];
  maxPolls?: number;
  intervalMs?: number;
  repeatedActions?: string[];
  filter: Record<string, unknown>;
  polls: Array<{
    poll: number;
    observedAt: string;
    executed: number;
    failed: number;
    remainingQueued: number;
    stoppedOnFailure: boolean;
  }>;
};

type SessionWatchWorker = {
  session: string;
  workerId: string;
  watchId: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  stoppedAt?: string;
  stopResult?: StopProcessGroupResult & { aliveBefore: boolean };
  retiredAt?: string;
  restartedAt?: string;
  restartCount?: number;
  previousPid?: number | null;
};

type SessionApplyCommand = {
  scope: string;
  action: string;
  reason: string;
  runId?: string;
  count?: number;
  continuationIds?: string[];
  olderThanMs?: number;
  command: string[];
};

type SessionApplyExecution = {
  scope: string;
  action: string;
  reason: string;
  runId: string | null;
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  output: unknown;
};

type SessionApplyRecord = {
  observedAt: string;
  session: string;
  source?: string;
  applyId: string;
  applyPath: string;
  dryRun: boolean;
  resume: boolean;
  resumeFilter?: string[];
  filter: Record<string, unknown>;
  selected: number;
  skippedCompleted: number;
  skippedByResumeFilter?: number;
  commands: SessionApplyCommand[];
  commandsToRun?: SessionApplyCommand[];
  startedAt: string;
  updatedAt: string;
  resetAuditAcknowledgedAt?: string;
  resetAuditAcknowledgedBy?: string;
  executions: SessionApplyExecution[];
};

type SessionVisibleRun = {
  id: string;
  status: string;
  objective: string;
  branchName: string;
  resultCommit: string | null;
};

type SessionApplyRunStatus = {
  agentId: string;
  runId: string;
  status: string;
  objective: string;
  branchName: string;
  resultCommit: string | null;
  workerId: string | null;
  location: "session_worker" | "unassigned" | "other_worker";
  resumable: boolean;
  reviewable: boolean;
  nextAction: "resume_branch" | "review_branch" | "wait_for_worker" | "dispatch_worker";
};

type SessionApplySummary = {
  session: string;
  applyId: string;
  applyPath: string;
  source?: string;
  filter: Record<string, unknown>;
  observedAt: string;
  startedAt: string;
  updatedAt: string;
  selected: number;
  skippedCompleted: number;
  executions: number;
  succeeded: number;
  failed: number;
  pending: number;
  resetAuditAcknowledgedAt?: string;
  actions: {
    resumeApply: string[];
    retryFailed: string[];
    resumePending: string[];
    inspectResults: string[] | null;
    reviewReadyResults: string[] | null;
  };
  pendingCommands: SessionApplyCommand[];
  failedCommands: SessionApplyCommand[];
  drainContinuationResetExecutions: Array<{
    action: "reset_failed_drain_continuations" | "reset_running_drain_continuations";
    state: "succeeded" | "failed";
    resetCount: number;
    inspected?: number;
    failed?: number;
    running?: number;
    skippedFailed?: number;
    skippedRunning?: number;
    continuationIds: string[];
    resetReasons: string[];
    command: string[];
  }>;
  affectedRuns: Array<{
    runId: string;
    action: string;
    reason: string;
    state: "succeeded" | "failed" | "pending";
    commands: {
      inspectRun: string[];
      inspectResults: string[];
      checkoutBranch: string[];
      reviewRun: string[];
    };
    currentRun: SessionApplyRunStatus | null;
  }>;
};

type SessionApplyDrainContinuationResetGroupItem = Pick<SessionApplySummary, "applyId" | "selected"> & {
  resetActions: Array<"reset_failed_drain_continuations" | "reset_running_drain_continuations">;
  states: Array<"succeeded" | "failed">;
  resetCount: number;
  inspected: number;
  failed: number;
  running: number;
  skippedFailed: number;
  skippedRunning: number;
  continuationIds: string[];
  resetReasons: string[];
  commands: string[][];
};

type SessionWatchRecord = {
  session: string;
  watchId: string;
  watchPath: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: "running" | "completed";
  stoppedReason?: "empty" | "max_polls";
  command: string[];
  filter: Record<string, unknown>;
  polls: Array<{
    poll: number;
    observedAt: string;
    remaining: number | null;
    output: unknown;
  }>;
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
  const logDir = workerSessionLogDir(sessionName);
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

async function startDetachedDrainContinuationWorker(
  sessionName: string,
  options: { workerId?: string; maxContinuations?: number },
): Promise<DrainContinuationWorker & { alive: boolean }> {
  assertSafeSessionName(sessionName);
  const workerId = options.workerId ?? createDrainContinuationWorkerId();
  assertSafeSessionName(workerId);
  const workerDir = drainContinuationWorkerDir(sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = drainContinuationWorkerPath(sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`drain continuation worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = [
    "runs",
    "session-drain-continuations",
    sessionName,
    "--execute-queued",
    ...(options.maxContinuations ? ["--max-continuations", String(options.maxContinuations)] : []),
  ];
  const stdout = await fs.open(stdoutPath, "a");
  const stderr = await fs.open(stderrPath, "a");
  try {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...command], {
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const worker: DrainContinuationWorker = {
      session: sessionName,
      workerId,
      baseUrl,
      startedAt: new Date().toISOString(),
      command,
      pid: child.pid ?? null,
      stdoutPath,
      stderrPath,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(toStoredDrainContinuationWorker(worker), null, 2)}\n`, { flag: "wx" });
    return { ...worker, alive: processIsAlive(worker.pid) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function startDetachedApplyActionWorker(
  sessionName: string,
  options: {
    workerId?: string;
    applyId?: string;
    source?: string;
    action?: string;
    limit?: number | null;
    maxActions?: number | null;
    stopOnFailure: boolean;
    untilEmpty: boolean;
    maxPolls?: number | null;
    intervalMs?: number | null;
  },
): Promise<ApplyActionWorker & { alive: boolean }> {
  assertSafeSessionName(sessionName);
  const workerId = options.workerId ?? createApplyActionWorkerId();
  assertSafeSessionName(workerId);
  const workerDir = applyActionWorkerDir(sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = applyActionWorkerPath(sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`apply action worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--record-worker",
    workerId,
    ...(options.applyId ? ["--apply-id", options.applyId] : []),
    ...(options.source ? ["--source", options.source] : []),
    ...(options.action ? ["--apply-action", options.action] : []),
    ...(options.limit ? ["--limit", String(options.limit)] : []),
    ...(options.maxActions ? ["--max-actions", String(options.maxActions)] : []),
    ...(options.stopOnFailure ? [] : ["--continue-on-failure"]),
    ...(options.untilEmpty ? ["--until-empty"] : []),
    ...(options.maxPolls ? ["--max-polls", String(options.maxPolls)] : []),
    ...(options.intervalMs ? ["--interval-ms", String(options.intervalMs)] : []),
  ];
  const stdout = await fs.open(stdoutPath, "a");
  const stderr = await fs.open(stderrPath, "a");
  try {
    const startedAt = new Date().toISOString();
    const initialWorker: ApplyActionWorker = {
      session: sessionName,
      workerId,
      baseUrl,
      startedAt,
      command,
      pid: null,
      stdoutPath,
      stderrPath,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(toStoredApplyActionWorker(initialWorker), null, 2)}\n`, { flag: "wx" });
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...command], {
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readApplyActionWorker(sessionName, workerId);
    const worker: ApplyActionWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeApplyActionWorker(worker);
    return { ...worker, alive: processIsAlive(worker.pid) };
  } catch (error) {
    await fs.rm(recordPath, { force: true });
    throw error;
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function startDetachedSessionWatchWorker(
  sessionName: string,
  options: {
    workerId?: string;
    watchId?: string;
    maxPolls: number;
    intervalMs: number;
    recoverable: boolean;
    includeStopped: boolean;
    actionQueue: boolean;
    applyAction?: string;
  },
): Promise<SessionWatchWorker & { alive: boolean }> {
  assertSafeSessionName(sessionName);
  const workerId = options.workerId ?? createSessionWatchWorkerId();
  assertSafeSessionName(workerId);
  const watchId = options.watchId ?? `${workerId}-watch`;
  assertSafeSessionName(watchId);
  const workerDir = sessionWatchWorkerDir(sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = sessionWatchWorkerPath(sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`session watch worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = [
    "runs",
    "session-watch",
    sessionName,
    "--next",
    "--until-empty",
    "--watch-id",
    watchId,
    "--max-polls",
    String(options.maxPolls),
    "--interval-ms",
    String(options.intervalMs),
    ...(options.recoverable ? ["--recoverable"] : []),
    ...(options.includeStopped ? ["--include-stopped"] : []),
    ...(options.actionQueue ? ["--action-queue"] : []),
    ...(options.applyAction ? ["--apply-action", options.applyAction] : []),
  ];
  const stdout = await fs.open(stdoutPath, "a");
  const stderr = await fs.open(stderrPath, "a");
  try {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...command], {
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const worker: SessionWatchWorker = {
      session: sessionName,
      workerId,
      watchId,
      baseUrl,
      startedAt: new Date().toISOString(),
      command,
      pid: child.pid ?? null,
      stdoutPath,
      stderrPath,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(toStoredSessionWatchWorker(worker), null, 2)}\n`, { flag: "wx" });
    return { ...worker, alive: processIsAlive(worker.pid) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function listDrainContinuationWorkers(
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<DrainContinuationWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  const sessionNames = options.sessionName ? [options.sessionName] : await listDrainContinuationWorkerSessionNames();
  const workers = await Promise.all(sessionNames.map(async (sessionName) => {
    assertSafeSessionName(sessionName);
    try {
      const entries = await fs.readdir(drainContinuationWorkerDir(sessionName), { withFileTypes: true });
      return await Promise.all(entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && (!options.workerId || entry.name === `${options.workerId}.json`)
        ))
        .map(async (entry) => {
          const worker = await readDrainContinuationWorker(sessionName, entry.name.replace(/\.json$/, ""));
          if (worker.retiredAt && !options.includeRetired) return null;
          return {
            ...worker,
            alive: processIsAlive(worker.pid),
            stdout: { path: worker.stdoutPath, lines: await tailFileLines(worker.stdoutPath, lines) },
            stderr: { path: worker.stderrPath, lines: await tailFileLines(worker.stderrPath, lines) },
          };
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }));
  return workers.flat().filter((worker): worker is NonNullable<typeof worker> => worker !== null).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function listApplyActionWorkers(
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  const sessionNames = options.sessionName ? [options.sessionName] : await listApplyActionWorkerSessionNames();
  const workers = await Promise.all(sessionNames.map(async (sessionName) => {
    assertSafeSessionName(sessionName);
    try {
      const entries = await fs.readdir(applyActionWorkerDir(sessionName), { withFileTypes: true });
      return await Promise.all(entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && (!options.workerId || entry.name === `${options.workerId}.json`)
        ))
        .map(async (entry) => {
          const worker = await readApplyActionWorker(sessionName, entry.name.replace(/\.json$/, ""));
          if (worker.retiredAt && !options.includeRetired) return null;
          return {
            ...worker,
            alive: processIsAlive(worker.pid),
            stdout: { path: worker.stdoutPath, lines: await tailFileLines(worker.stdoutPath, lines) },
            stderr: { path: worker.stderrPath, lines: await tailFileLines(worker.stderrPath, lines) },
          };
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }));
  return workers.flat().filter((worker): worker is NonNullable<typeof worker> => worker !== null).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function listSessionWatchWorkers(
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<SessionWatchWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  const sessionNames = options.sessionName ? [options.sessionName] : await listSessionWatchWorkerSessionNames();
  const workers = await Promise.all(sessionNames.map(async (sessionName) => {
    assertSafeSessionName(sessionName);
    try {
      const entries = await fs.readdir(sessionWatchWorkerDir(sessionName), { withFileTypes: true });
      return await Promise.all(entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && (!options.workerId || entry.name === `${options.workerId}.json`)
        ))
        .map(async (entry) => {
          const worker = await readSessionWatchWorker(sessionName, entry.name.replace(/\.json$/, ""));
          if (worker.retiredAt && !options.includeRetired) return null;
          return {
            ...worker,
            alive: processIsAlive(worker.pid),
            stdout: { path: worker.stdoutPath, lines: await tailFileLines(worker.stdoutPath, lines) },
            stderr: { path: worker.stderrPath, lines: await tailFileLines(worker.stderrPath, lines) },
          };
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }));
  return workers.flat().filter((worker): worker is NonNullable<typeof worker> => worker !== null).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

async function listDrainContinuationWorkerSessionNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(drainContinuationWorkerRootDir(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listApplyActionWorkerSessionNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(applyActionWorkerRootDir(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function listSessionWatchWorkerSessionNames(): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionWatchWorkerRootDir(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function stopDrainContinuationWorkers(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Awaited<ReturnType<typeof listDrainContinuationWorkers>>;
}> {
  assertSafeSessionName(sessionName);
  if (options.workerId) assertSafeSessionName(options.workerId);
  const workers = await listDrainContinuationWorkers({
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`drain continuation worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: DrainContinuationWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeDrainContinuationWorker(updated);
    stopped.push({
      workerId: worker.workerId,
      pid: worker.pid,
      aliveBefore,
      stopped: !result.alive,
      signalSent: result.signalSent,
      forced: result.forced,
      alive: result.alive,
      stoppedAt,
      ...(updated.retiredAt ? { retiredAt: updated.retiredAt } : {}),
    });
  }
  return {
    session: sessionName,
    count: stopped.length,
    stopped,
    workers: await listDrainContinuationWorkers({
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

async function stopApplyActionWorkers(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Awaited<ReturnType<typeof listApplyActionWorkers>>;
}> {
  assertSafeSessionName(sessionName);
  if (options.workerId) assertSafeSessionName(options.workerId);
  const workers = await listApplyActionWorkers({
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`apply action worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: ApplyActionWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeApplyActionWorker(updated);
    stopped.push({
      workerId: worker.workerId,
      pid: worker.pid,
      aliveBefore,
      stopped: !result.alive,
      signalSent: result.signalSent,
      forced: result.forced,
      alive: result.alive,
      stoppedAt,
      ...(updated.retiredAt ? { retiredAt: updated.retiredAt } : {}),
    });
  }
  return {
    session: sessionName,
    count: stopped.length,
    stopped,
    workers: await listApplyActionWorkers({
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

async function stopSessionWatchWorkers(
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    watchId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Awaited<ReturnType<typeof listSessionWatchWorkers>>;
}> {
  assertSafeSessionName(sessionName);
  if (options.workerId) assertSafeSessionName(options.workerId);
  const workers = await listSessionWatchWorkers({
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`session watch worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: SessionWatchWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeSessionWatchWorker(updated);
    stopped.push({
      workerId: worker.workerId,
      watchId: worker.watchId,
      pid: worker.pid,
      aliveBefore,
      stopped: !result.alive,
      signalSent: result.signalSent,
      forced: result.forced,
      alive: result.alive,
      stoppedAt,
      ...(updated.retiredAt ? { retiredAt: updated.retiredAt } : {}),
    });
  }
  return {
    session: sessionName,
    count: stopped.length,
    stopped,
    workers: await listSessionWatchWorkers({
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

async function restartSessionWatchWorkers(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    watchId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Awaited<ReturnType<typeof listSessionWatchWorkers>>;
}> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(options.workerId);
  let worker: SessionWatchWorker;
  try {
    worker = await readSessionWatchWorker(sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`session watch worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`session watch worker '${options.workerId}' is retired; pass --include-retired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`session watch worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`session watch worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const restartedAt = new Date().toISOString();
    const updated: SessionWatchWorker = {
      ...worker,
      baseUrl,
      startedAt: restartedAt,
      pid: child.pid ?? null,
      stoppedAt: undefined,
      stopResult: undefined,
      retiredAt: undefined,
      restartedAt,
      restartCount: (worker.restartCount ?? 0) + 1,
      previousPid: worker.pid,
    };
    await writeSessionWatchWorker(updated);
    return {
      session: sessionName,
      count: 1,
      restarted: [{
        workerId: updated.workerId,
        watchId: updated.watchId,
        previousPid: updated.previousPid ?? null,
        pid: updated.pid,
        restartedAt,
        restartCount: updated.restartCount ?? 1,
        command: updated.command,
      }],
      workers: await listSessionWatchWorkers({
        sessionName,
        workerId: options.workerId,
        includeRetired: true,
      }, options.lines),
    };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function restartDrainContinuationWorkers(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Awaited<ReturnType<typeof listDrainContinuationWorkers>>;
}> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(options.workerId);
  let worker: DrainContinuationWorker;
  try {
    worker = await readDrainContinuationWorker(sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`drain continuation worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`drain continuation worker '${options.workerId}' is retired; pass --include-retired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`drain continuation worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`drain continuation worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const restartedAt = new Date().toISOString();
    const updated: DrainContinuationWorker = {
      ...worker,
      baseUrl,
      startedAt: restartedAt,
      pid: child.pid ?? null,
      stoppedAt: undefined,
      stopResult: undefined,
      retiredAt: undefined,
      restartedAt,
      restartCount: (worker.restartCount ?? 0) + 1,
      previousPid: worker.pid,
    };
    await writeDrainContinuationWorker(updated);
    return {
      session: sessionName,
      count: 1,
      restarted: [{
        workerId: updated.workerId,
        previousPid: updated.previousPid ?? null,
        pid: updated.pid,
        restartedAt,
        restartCount: updated.restartCount ?? 1,
        command: updated.command,
      }],
      workers: await listDrainContinuationWorkers({
        sessionName,
        workerId: options.workerId,
        includeRetired: true,
      }, options.lines),
    };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function restartApplyActionWorkers(
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Awaited<ReturnType<typeof listApplyActionWorkers>>;
}> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(options.workerId);
  let worker: ApplyActionWorker;
  try {
    worker = await readApplyActionWorker(sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`apply action worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`apply action worker '${options.workerId}' is retired; pass --include-retired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`apply action worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`apply action worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const restartedAt = new Date().toISOString();
    const pendingRestart: ApplyActionWorker = {
      ...worker,
      baseUrl,
      startedAt: restartedAt,
      pid: null,
      stoppedAt: undefined,
      stopResult: undefined,
      retiredAt: undefined,
      restartedAt,
      restartCount: (worker.restartCount ?? 0) + 1,
      previousPid: worker.pid,
      lastRun: undefined,
    };
    await writeApplyActionWorker(pendingRestart);
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readApplyActionWorker(sessionName, options.workerId);
    const updated: ApplyActionWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeApplyActionWorker(updated);
    return {
      session: sessionName,
      count: 1,
      restarted: [{
        workerId: updated.workerId,
        previousPid: updated.previousPid ?? null,
        pid: updated.pid,
        restartedAt,
        restartCount: updated.restartCount ?? 1,
        command: updated.command,
      }],
      workers: await listApplyActionWorkers({
        sessionName,
        workerId: options.workerId,
        includeRetired: true,
      }, options.lines),
    };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function drainContinuationWorkerNextSteps(sessionName: string): Promise<Array<{
  action: "restart_drain_worker";
  reason: "stopped_drain_worker" | "queued_drain_continuations_without_worker";
  workerId: string;
  pid: number | null;
  stoppedAt?: string;
  queuedContinuations: number;
  command: string[];
  commands: {
    restartDrainWorker: string[];
    inspectDrainWorkers: string[];
  };
}>> {
  assertSafeSessionName(sessionName);
  const [workers, queued] = await Promise.all([
    listDrainContinuationWorkers({ sessionName }, 1),
    fetchWorkerSessionDrainContinuations(sessionName, "100", ["queued"]),
  ]);
  const queuedContinuations = queued.continuations.length;
  return workers
    .filter((worker) => !worker.alive && (worker.stoppedAt || queuedContinuations > 0))
    .map((worker) => {
      const restartDrainWorker = ["npm", "run", "cli", "--", "runs", "restart-drain-workers", sessionName, "--worker-id", worker.workerId];
      return {
        action: "restart_drain_worker" as const,
        reason: worker.stoppedAt ? "stopped_drain_worker" as const : "queued_drain_continuations_without_worker" as const,
        workerId: worker.workerId,
        pid: worker.pid,
        ...(worker.stoppedAt ? { stoppedAt: worker.stoppedAt } : {}),
        queuedContinuations,
        command: restartDrainWorker,
        commands: {
          restartDrainWorker,
          inspectDrainWorkers: ["npm", "run", "cli", "--", "runs", "session-drain-workers", sessionName, "--worker-id", worker.workerId],
        },
      };
    });
}

async function sessionWatchWorkerNextSteps(sessionName: string): Promise<Array<{
  action: "restart_session_watch_worker";
  reason: "stopped_session_watch_worker";
  workerId: string;
  watchId: string;
  pid: number | null;
  stoppedAt: string;
  command: string[];
  commands: {
    restartSessionWatchWorker: string[];
    inspectSessionWatchWorkers: string[];
    retireSessionWatchWorker: string[];
  };
}>> {
  assertSafeSessionName(sessionName);
  const workers = await listSessionWatchWorkers({ sessionName }, 1);
  return workers
    .filter((worker) => !worker.alive && Boolean(worker.stoppedAt))
    .map((worker) => {
      const restartSessionWatchWorker = ["npm", "run", "cli", "--", "runs", "restart-session-watch-workers", sessionName, "--worker-id", worker.workerId];
      return {
        action: "restart_session_watch_worker" as const,
        reason: "stopped_session_watch_worker" as const,
        workerId: worker.workerId,
        watchId: worker.watchId,
        pid: worker.pid,
        stoppedAt: worker.stoppedAt as string,
        command: restartSessionWatchWorker,
        commands: {
          restartSessionWatchWorker,
          inspectSessionWatchWorkers: ["npm", "run", "cli", "--", "runs", "session-watch-workers", sessionName, "--worker-id", worker.workerId],
          retireSessionWatchWorker: ["npm", "run", "cli", "--", "runs", "stop-session-watch-workers", sessionName, "--worker-id", worker.workerId, "--retire"],
        },
      };
    });
}

type DrainContinuationResetNextStep = {
  action: "reset_failed_drain_continuations" | "reset_running_drain_continuations";
  reason: "failed_drain_continuations" | "stale_running_drain_continuations";
  count: number;
  continuationIds: string[];
  olderThanMs?: number;
  command: string[];
  commands: Record<string, string[]>;
};

async function workerSessionDrainContinuationResetNextSteps(
  sessionName: string,
  olderThanMs = STALE_RUNNING_DRAIN_CONTINUATION_MS,
): Promise<DrainContinuationResetNextStep[]> {
  assertSafeSessionName(sessionName);
  const [failed, running] = await Promise.all([
    readWorkerSessionDrainContinuationRecords(sessionName, ["failed"]),
    readWorkerSessionDrainContinuationRecords(sessionName, ["running"]),
  ]);
  const nowMs = Date.now();
  const stale = running.filter((record) => {
    const startedAtMs = Date.parse(record.startedAt ?? record.observedAt);
    return Number.isFinite(startedAtMs) && nowMs - startedAtMs >= olderThanMs;
  });
  const steps: DrainContinuationResetNextStep[] = [];
  if (failed.length > 0) {
    const failedContinuationIds = failed.map((record) => record.continuationId);
    const resetFailedDrainContinuations = [
      "npm",
      "run",
      "cli",
      "--",
      "runs",
      "session-drain-continuations",
      sessionName,
      "--reset-failed",
      "--continuation",
      failedContinuationIds.join(","),
    ];
    steps.push({
      action: "reset_failed_drain_continuations",
      reason: "failed_drain_continuations",
      count: failed.length,
      continuationIds: failedContinuationIds,
      command: resetFailedDrainContinuations,
      commands: {
        inspectDrainContinuations: ["npm", "run", "cli", "--", "runs", "session-drain-continuations", sessionName, "--status", "failed"],
        resetFailedDrainContinuations,
      },
    });
  }
  if (stale.length === 0) return steps;
  const resetRunningDrainContinuations = [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-drain-continuations",
    sessionName,
    "--reset-running",
    "--older-than-ms",
    String(olderThanMs),
  ];
  steps.push({
    action: "reset_running_drain_continuations",
    reason: "stale_running_drain_continuations",
    count: stale.length,
    continuationIds: stale.map((record) => record.continuationId),
    olderThanMs,
    command: resetRunningDrainContinuations,
    commands: {
      inspectDrainContinuations: ["npm", "run", "cli", "--", "runs", "session-drain-continuations", sessionName, "--status", "running"],
      resetRunningDrainContinuations,
    },
  });
  return steps;
}

async function readWorkerSessionDrainContinuationRecords(
  sessionName: string,
  status?: Array<NonNullable<WorkerSessionDrainContinuationRecord["status"]>>,
): Promise<WorkerSessionDrainContinuationRecord[]> {
  assertSafeSessionName(sessionName);
  const statusFilter = status && status.length > 0 ? new Set(status) : null;
  const continuationDir = workerSessionDrainContinuationDir(sessionName);
  try {
    const entries = await fs.readdir(continuationDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(continuationDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionDrainContinuationRecord;
      }));
    return records
      .filter((record) => !statusFilter || (record.status && statusFilter.has(record.status)))
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readDrainContinuationWorker(sessionName: string, workerId: string): Promise<DrainContinuationWorker> {
  const text = await fs.readFile(drainContinuationWorkerPath(sessionName, workerId), "utf8");
  return JSON.parse(text) as DrainContinuationWorker;
}

async function writeDrainContinuationWorker(worker: DrainContinuationWorker): Promise<void> {
  await fs.writeFile(drainContinuationWorkerPath(worker.session, worker.workerId), `${JSON.stringify(toStoredDrainContinuationWorker(worker), null, 2)}\n`);
}

function toStoredDrainContinuationWorker(worker: DrainContinuationWorker): DrainContinuationWorker {
  return {
    session: worker.session,
    workerId: worker.workerId,
    baseUrl: worker.baseUrl,
    startedAt: worker.startedAt,
    command: worker.command,
    pid: worker.pid,
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
    ...(worker.stoppedAt !== undefined ? { stoppedAt: worker.stoppedAt } : {}),
    ...(worker.stopResult !== undefined ? { stopResult: worker.stopResult } : {}),
    ...(worker.retiredAt !== undefined ? { retiredAt: worker.retiredAt } : {}),
    ...(worker.restartedAt !== undefined ? { restartedAt: worker.restartedAt } : {}),
    ...(worker.restartCount !== undefined ? { restartCount: worker.restartCount } : {}),
    ...(worker.previousPid !== undefined ? { previousPid: worker.previousPid } : {}),
  };
}

async function readApplyActionWorker(sessionName: string, workerId: string): Promise<ApplyActionWorker> {
  const text = await fs.readFile(applyActionWorkerPath(sessionName, workerId), "utf8");
  return JSON.parse(text) as ApplyActionWorker;
}

async function writeApplyActionWorker(worker: ApplyActionWorker): Promise<void> {
  await fs.writeFile(applyActionWorkerPath(worker.session, worker.workerId), `${JSON.stringify(toStoredApplyActionWorker(worker), null, 2)}\n`);
}

function toStoredApplyActionWorker(worker: ApplyActionWorker): ApplyActionWorker {
  return {
    session: worker.session,
    workerId: worker.workerId,
    baseUrl: worker.baseUrl,
    startedAt: worker.startedAt,
    command: worker.command,
    pid: worker.pid,
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
    ...(worker.stoppedAt !== undefined ? { stoppedAt: worker.stoppedAt } : {}),
    ...(worker.stopResult !== undefined ? { stopResult: worker.stopResult } : {}),
    ...(worker.retiredAt !== undefined ? { retiredAt: worker.retiredAt } : {}),
    ...(worker.restartedAt !== undefined ? { restartedAt: worker.restartedAt } : {}),
    ...(worker.restartCount !== undefined ? { restartCount: worker.restartCount } : {}),
    ...(worker.previousPid !== undefined ? { previousPid: worker.previousPid } : {}),
    ...(worker.lastRun !== undefined ? { lastRun: worker.lastRun } : {}),
  };
}

async function listWorkerSessions(
  sessionName?: string,
  limit?: number | null,
  offset = 0,
): Promise<Array<WorkerSession & { workers: Array<WorkerSession["workers"][number] & { alive: boolean }> }>> {
  const names = sessionName ? [sessionName] : await listWorkerSessionNames(limit ?? undefined, offset);
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

async function listWorkerSessionNames(limit?: number, offset = 0): Promise<string[]> {
  try {
    const entries = await fs.readdir(workerSessionDir);
    const names = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .sort();
    if (!limit && offset === 0) return names;
    const sessionsWithStats = await Promise.all(names.map(async (name) => {
      const stat = await fs.stat(workerSessionPath(name));
      return { name, mtimeMs: stat.mtimeMs };
    }));
    const end = limit ? offset + limit : undefined;
    return sessionsWithStats
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
      .slice(offset, end)
      .map((session) => session.name);
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

async function readSessionWatchWorker(sessionName: string, workerId: string): Promise<SessionWatchWorker> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(workerId);
  const text = await fs.readFile(sessionWatchWorkerPath(sessionName, workerId), "utf8");
  return JSON.parse(text) as SessionWatchWorker;
}

async function writeSessionWatchWorker(worker: SessionWatchWorker): Promise<void> {
  await fs.writeFile(sessionWatchWorkerPath(worker.session, worker.workerId), `${JSON.stringify(toStoredSessionWatchWorker(worker), null, 2)}\n`);
}

function toStoredSessionWatchWorker(worker: SessionWatchWorker): SessionWatchWorker {
  return {
    session: worker.session,
    workerId: worker.workerId,
    watchId: worker.watchId,
    baseUrl: worker.baseUrl,
    startedAt: worker.startedAt,
    command: worker.command,
    pid: worker.pid,
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
    ...(worker.stoppedAt !== undefined ? { stoppedAt: worker.stoppedAt } : {}),
    ...(worker.stopResult !== undefined ? { stopResult: worker.stopResult } : {}),
    ...(worker.retiredAt !== undefined ? { retiredAt: worker.retiredAt } : {}),
    ...(worker.restartedAt !== undefined ? { restartedAt: worker.restartedAt } : {}),
    ...(worker.restartCount !== undefined ? { restartCount: worker.restartCount } : {}),
    ...(worker.previousPid !== undefined ? { previousPid: worker.previousPid } : {}),
  };
}

async function readSessionApplyRecord(sessionName: string, applyId: string): Promise<SessionApplyRecord | null> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(applyId);
  try {
    const text = await fs.readFile(workerSessionApplyPath(sessionName, applyId), "utf8");
    return JSON.parse(text) as SessionApplyRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listSessionApplyRecords(sessionName: string): Promise<SessionApplyRecord[]> {
  assertSafeSessionName(sessionName);
  const applyDir = workerSessionApplyDir(sessionName);
  try {
    const entries = await fs.readdir(applyDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(applyDir, entry.name), "utf8");
        return JSON.parse(text) as SessionApplyRecord;
      }));
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeSessionApplyRecord(record: SessionApplyRecord): Promise<void> {
  await fs.mkdir(path.dirname(record.applyPath), { recursive: true });
  await fs.writeFile(record.applyPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function readSessionWatchRecord(sessionName: string, watchId: string): Promise<SessionWatchRecord | null> {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(watchId);
  try {
    const text = await fs.readFile(workerSessionWatchPath(sessionName, watchId), "utf8");
    return JSON.parse(text) as SessionWatchRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function listSessionWatchRecords(sessionName: string): Promise<SessionWatchRecord[]> {
  assertSafeSessionName(sessionName);
  const watchDir = workerSessionWatchDir(sessionName);
  try {
    const entries = await fs.readdir(watchDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(watchDir, entry.name), "utf8");
        return JSON.parse(text) as SessionWatchRecord;
      }));
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeSessionWatchRecord(record: SessionWatchRecord): Promise<void> {
  await fs.mkdir(path.dirname(record.watchPath), { recursive: true });
  await fs.writeFile(record.watchPath, `${JSON.stringify(record, null, 2)}\n`);
}

async function appendSessionWatchRecordPoll(
  record: SessionWatchRecord,
  poll: SessionWatchRecord["polls"][number],
): Promise<void> {
  record.polls.push(poll);
  record.updatedAt = poll.observedAt;
  await writeSessionWatchRecord(record);
}

async function completeSessionWatchRecord(
  record: SessionWatchRecord,
  stoppedReason: NonNullable<SessionWatchRecord["stoppedReason"]>,
): Promise<void> {
  const completedAt = new Date().toISOString();
  record.status = "completed";
  record.stoppedReason = stoppedReason;
  record.completedAt = completedAt;
  record.updatedAt = completedAt;
  await writeSessionWatchRecord(record);
}

function summarizeSessionApplyRecord(
  record: SessionApplyRecord,
  runStatusIndex: Map<string, SessionApplyRunStatus> | null = null,
): SessionApplySummary {
  const commandStates = sessionApplyCommandStates(record);
  const failedCommands = record.commands.filter((command) => {
    const state = commandStates.get(commandKey(command.command));
    return state?.failed === true && state.succeeded !== true;
  });
  const pendingCommands = record.commands.filter((command) => !commandStates.has(commandKey(command.command)));
  const affectedRuns = sessionApplyAffectedRuns(record, commandStates, runStatusIndex);
  const drainContinuationResetExecutions = sessionApplyDrainContinuationResetExecutions(record);
  const affectedRunIds = affectedRuns.map((run) => run.runId);
  const readyResultRunIds = affectedRuns
    .filter((run) => run.currentRun?.resultCommit)
    .map((run) => run.runId);
  return {
    session: record.session,
    applyId: record.applyId,
    applyPath: record.applyPath,
    source: record.source,
    filter: record.filter,
    observedAt: record.observedAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    selected: record.selected,
    skippedCompleted: record.skippedCompleted,
    executions: record.executions.length,
    succeeded: record.executions.filter((execution) => execution.exitCode === 0).length,
    failed: record.executions.filter((execution) => execution.exitCode !== 0).length,
    pending: pendingCommands.length,
    ...(record.resetAuditAcknowledgedAt ? { resetAuditAcknowledgedAt: record.resetAuditAcknowledgedAt } : {}),
    actions: {
      resumeApply: sessionApplyResumeCommand(record),
      retryFailed: sessionApplyResumeCommand(record, ["failed"]),
      resumePending: sessionApplyResumeCommand(record, ["pending"]),
      inspectResults: affectedRunIds.length > 0
        ? ["npm", "run", "cli", "--", "runs", "results", "--session", record.session, "--run", affectedRunIds.join(","), "--next"]
        : null,
      reviewReadyResults: readyResultRunIds.length > 0
        ? ["npm", "run", "cli", "--", "runs", "results", "--session", record.session, "--run", readyResultRunIds.join(","), "--next", "--commands-only"]
        : null,
    },
    pendingCommands,
    failedCommands,
    drainContinuationResetExecutions,
    affectedRuns,
  };
}

function sessionApplyDrainContinuationResetExecutions(
  record: SessionApplyRecord,
): SessionApplySummary["drainContinuationResetExecutions"] {
  return record.executions
    .filter((execution): execution is SessionApplyExecution & {
      action: "reset_failed_drain_continuations" | "reset_running_drain_continuations";
    } => execution.action === "reset_failed_drain_continuations" || execution.action === "reset_running_drain_continuations")
    .map((execution) => {
      const output = plainRecord(execution.output);
      const inspected = numberFromUnknown(output?.inspected);
      const failed = numberFromUnknown(output?.failed);
      const running = numberFromUnknown(output?.running);
      const skippedFailed = numberFromUnknown(output?.skippedFailed);
      const skippedRunning = numberFromUnknown(output?.skippedRunning);
      const continuations = Array.isArray(output?.continuations)
        ? output.continuations
          .map((item) => plainRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
        : [];
      return {
        action: execution.action,
        state: execution.exitCode === 0 ? "succeeded" : "failed",
        resetCount: numberFromUnknown(output?.resetCount) ?? 0,
        ...(inspected !== null ? { inspected } : {}),
        ...(failed !== null ? { failed } : {}),
        ...(running !== null ? { running } : {}),
        ...(skippedFailed !== null ? { skippedFailed } : {}),
        ...(skippedRunning !== null ? { skippedRunning } : {}),
        continuationIds: continuations
          .map((continuation) => stringFromUnknown(continuation.continuationId))
          .filter((continuationId): continuationId is string => continuationId !== null),
        resetReasons: [...new Set(continuations
          .map((continuation) => stringFromUnknown(continuation.resetReason))
          .filter((resetReason): resetReason is string => resetReason !== null))],
        command: execution.command,
      };
    });
}

function sessionApplyReadyResultsCommand(
  summary: SessionApplySummary,
  options: Record<string, string>,
): string[] | null {
  if (!summary.actions.reviewReadyResults) return null;
  return [
    ...summary.actions.reviewReadyResults,
    ...(options["checkout-dir"] ? ["--checkout-dir", options["checkout-dir"]] : []),
    ...(options["changed-only"] === "1" ? ["--changed-only"] : []),
    ...(options["changed-path"] ? ["--changed-path", options["changed-path"]] : []),
  ];
}

function sessionApplyResetInspectionCommand(summary: SessionApplySummary): string[] | null {
  if (summary.resetAuditAcknowledgedAt) return null;
  if (summary.drainContinuationResetExecutions.length === 0) return null;
  return ["npm", "run", "cli", "--", "runs", "session-applies", summary.session, "--apply-id", summary.applyId];
}

function sessionApplyShellCommand(
  summary: SessionApplySummary,
  options: Record<string, string>,
): string[] | null {
  if (options["action-queue"] === "1") {
    if (summary.failed > 0) return summary.actions.retryFailed;
    if (summary.pending > 0) return summary.actions.resumePending;
    return sessionApplyReadyResultsCommand(summary, options) ?? sessionApplyResetInspectionCommand(summary);
  }
  if (options["ready-results"] === "1" || options["summary-group"] === "ready-to-review") {
    return sessionApplyReadyResultsCommand(summary, options);
  }
  if (options["summary-group"] === "resume-needed") {
    if (summary.failed > 0) return summary.actions.retryFailed;
    if (summary.pending > 0) return summary.actions.resumePending;
    return null;
  }
  if (options["summary-group"] === "drain-resets") {
    return sessionApplyResetInspectionCommand(summary);
  }
  return summary.actions.resumeApply;
}

function summarizeSessionApplyActionQueue(
  applies: SessionApplySummary[],
  options: Record<string, string>,
): {
  counts: {
    total: number;
    actionable: number;
    resumeNeeded: number;
    readyToReview: number;
    resetAudits: number;
    resetAuditsAcknowledged: number;
    resetAuditsTotal: number;
    waiting: number;
    failed: number;
    pending: number;
  };
  actions: Array<Pick<SessionApplySummary, "applyId" | "failed" | "pending" | "selected"> & {
    action: "retry_failed" | "resume_pending" | "review_ready_results" | "inspect_drain_continuation_resets";
    resultRuns: string[];
    resetCount: number;
    resetActions: Array<"reset_failed_drain_continuations" | "reset_running_drain_continuations">;
    continuationIds: string[];
    resetReasons: string[];
    command: string[];
  }>;
} {
  const actions: Array<Pick<SessionApplySummary, "applyId" | "failed" | "pending" | "selected"> & {
    action: "retry_failed" | "resume_pending" | "review_ready_results" | "inspect_drain_continuation_resets";
    resultRuns: string[];
    resetCount: number;
    resetActions: Array<"reset_failed_drain_continuations" | "reset_running_drain_continuations">;
    continuationIds: string[];
    resetReasons: string[];
    command: string[];
  }> = [];
  for (const apply of applies) {
    if (apply.failed > 0) {
      actions.push({
        applyId: apply.applyId,
        action: "retry_failed",
        failed: apply.failed,
        pending: apply.pending,
        selected: apply.selected,
        resultRuns: [],
        resetCount: 0,
        resetActions: [],
        continuationIds: [],
        resetReasons: [],
        command: apply.actions.retryFailed,
      });
      continue;
    }
    if (apply.pending > 0) {
      actions.push({
        applyId: apply.applyId,
        action: "resume_pending",
        failed: apply.failed,
        pending: apply.pending,
        selected: apply.selected,
        resultRuns: [],
        resetCount: 0,
        resetActions: [],
        continuationIds: [],
        resetReasons: [],
        command: apply.actions.resumePending,
      });
      continue;
    }
    const command = sessionApplyReadyResultsCommand(apply, options);
    if (command) {
      actions.push({
        applyId: apply.applyId,
        action: "review_ready_results",
        failed: apply.failed,
        pending: apply.pending,
        selected: apply.selected,
        resultRuns: apply.affectedRuns
          .filter((run) => run.currentRun?.resultCommit)
          .map((run) => run.runId),
        resetCount: 0,
        resetActions: [],
        continuationIds: [],
        resetReasons: [],
        command,
      });
      continue;
    }
    const resetInspectionCommand = sessionApplyResetInspectionCommand(apply);
    if (!resetInspectionCommand) continue;
    actions.push({
      applyId: apply.applyId,
      action: "inspect_drain_continuation_resets",
      failed: apply.failed,
      pending: apply.pending,
      selected: apply.selected,
      resultRuns: [],
      resetCount: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + execution.resetCount, 0),
      resetActions: [...new Set(apply.drainContinuationResetExecutions.map((execution) => execution.action))],
      continuationIds: [...new Set(apply.drainContinuationResetExecutions.flatMap((execution) => execution.continuationIds))],
      resetReasons: [...new Set(apply.drainContinuationResetExecutions.flatMap((execution) => execution.resetReasons))],
      command: resetInspectionCommand,
    });
  }
  return {
    counts: {
      total: applies.length,
      actionable: actions.length,
      resumeNeeded: actions.filter((action) => action.action === "retry_failed" || action.action === "resume_pending").length,
      readyToReview: actions.filter((action) => action.action === "review_ready_results").length,
      resetAudits: actions.filter((action) => action.action === "inspect_drain_continuation_resets").length,
      resetAuditsAcknowledged: applies.filter((apply) => (
        apply.drainContinuationResetExecutions.length > 0 && apply.resetAuditAcknowledgedAt
      )).length,
      resetAuditsTotal: applies.filter((apply) => apply.drainContinuationResetExecutions.length > 0).length,
      waiting: applies.length - actions.length,
      failed: applies.reduce((sum, apply) => sum + apply.failed, 0),
      pending: applies.reduce((sum, apply) => sum + apply.pending, 0),
    },
    actions,
  };
}

async function sessionApplyActionQueue(
  sessionName: string,
  options: Record<string, string>,
): Promise<ReturnType<typeof summarizeSessionApplyActionQueue>> {
  const records = await listSessionApplyRecords(sessionName);
  const runStatusIndex = await sessionApplyRunStatusIndex(sessionName);
  const applies = records.map((record) => summarizeSessionApplyRecord(record, runStatusIndex));
  return summarizeSessionApplyActionQueue(applies, options);
}

function summarizeSessionApplies(applies: SessionApplySummary[]): {
  counts: {
    total: number;
    resumeNeeded: number;
    readyToReview: number;
    waiting: number;
    drainPrefixes: number;
    drainContinuationResetApplies: number;
    drainContinuationResets: number;
    failed: number;
    pending: number;
  };
  groups: {
    resumeNeeded: Array<Pick<SessionApplySummary, "applyId" | "failed" | "pending" | "selected"> & { command: string[] }>;
    readyToReview: Array<Pick<SessionApplySummary, "applyId" | "selected"> & { resultRuns: string[]; command: string[] }>;
    waiting: Array<Pick<SessionApplySummary, "applyId" | "selected"> & { affectedRuns: number }>;
    drainContinuationResets: SessionApplyDrainContinuationResetGroupItem[];
    drainPrefixes: Array<{
      prefix: string;
      polls: number;
      applyIds: string[];
      latestApplyId: string;
      updatedAt: string;
      selected: number;
      succeeded: number;
      failed: number;
      pending: number;
      done: boolean;
      stoppedOnFailure: boolean;
      nextApplyId: string;
      continueCommand: string[] | null;
    }>;
  };
} {
  const resumeNeeded = applies
    .filter((apply) => apply.failed > 0 || apply.pending > 0)
    .map((apply) => ({
      applyId: apply.applyId,
      failed: apply.failed,
      pending: apply.pending,
      selected: apply.selected,
      command: apply.failed > 0 ? apply.actions.retryFailed : apply.actions.resumePending,
    }));
  const readyToReview = applies
    .filter((apply) => apply.actions.reviewReadyResults)
    .map((apply) => ({
      applyId: apply.applyId,
      selected: apply.selected,
      resultRuns: apply.affectedRuns
        .filter((run) => run.currentRun?.resultCommit)
        .map((run) => run.runId),
      command: apply.actions.reviewReadyResults as string[],
    }));
  const drainContinuationResets = summarizeSessionApplyDrainContinuationResets(applies);
  const waiting = applies
    .filter((apply) => (
      apply.failed === 0
      && apply.pending === 0
      && !apply.actions.reviewReadyResults
      && apply.drainContinuationResetExecutions.length === 0
    ))
    .map((apply) => ({
      applyId: apply.applyId,
      selected: apply.selected,
      affectedRuns: apply.affectedRuns.length,
    }));
  const drainPrefixes = summarizeSessionApplyDrainPrefixes(applies);
  return {
    counts: {
      total: applies.length,
      resumeNeeded: resumeNeeded.length,
      readyToReview: readyToReview.length,
      waiting: waiting.length,
      drainPrefixes: drainPrefixes.length,
      drainContinuationResetApplies: drainContinuationResets.length,
      drainContinuationResets: drainContinuationResets.reduce((sum, apply) => sum + apply.resetCount, 0),
      failed: applies.reduce((sum, apply) => sum + apply.failed, 0),
      pending: applies.reduce((sum, apply) => sum + apply.pending, 0),
    },
    groups: { resumeNeeded, readyToReview, waiting, drainContinuationResets, drainPrefixes },
  };
}

function summarizeSessionApplyDrainContinuationResets(
  applies: SessionApplySummary[],
): SessionApplyDrainContinuationResetGroupItem[] {
  return applies
    .filter((apply) => apply.drainContinuationResetExecutions.length > 0)
    .map((apply) => ({
      applyId: apply.applyId,
      selected: apply.selected,
      resetActions: [...new Set(apply.drainContinuationResetExecutions.map((execution) => execution.action))],
      states: [...new Set(apply.drainContinuationResetExecutions.map((execution) => execution.state))],
      resetCount: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + execution.resetCount, 0),
      inspected: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + (execution.inspected ?? 0), 0),
      failed: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + (execution.failed ?? 0), 0),
      running: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + (execution.running ?? 0), 0),
      skippedFailed: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + (execution.skippedFailed ?? 0), 0),
      skippedRunning: apply.drainContinuationResetExecutions.reduce((sum, execution) => sum + (execution.skippedRunning ?? 0), 0),
      continuationIds: [...new Set(apply.drainContinuationResetExecutions.flatMap((execution) => execution.continuationIds))],
      resetReasons: [...new Set(apply.drainContinuationResetExecutions.flatMap((execution) => execution.resetReasons))],
      commands: apply.drainContinuationResetExecutions.map((execution) => execution.command),
    }))
    .sort((left, right) => right.applyId.localeCompare(left.applyId));
}

function sessionApplyDrainParts(applyId: string): { prefix: string; poll: number } | null {
  const match = /^(.*)-(\d{3})$/.exec(applyId);
  if (!match) return null;
  return { prefix: match[1], poll: Number(match[2]) };
}

function summarizeSessionApplyDrainPrefixes(applies: SessionApplySummary[]): Array<{
  prefix: string;
  polls: number;
  applyIds: string[];
  latestApplyId: string;
  updatedAt: string;
  selected: number;
  succeeded: number;
  failed: number;
  pending: number;
  done: boolean;
  stoppedOnFailure: boolean;
  nextApplyId: string;
  continueCommand: string[] | null;
}> {
  const groups = new Map<string, Array<SessionApplySummary & { drainPoll: number }>>();
  for (const apply of applies) {
    if (apply.source !== "watch") continue;
    const parts = sessionApplyDrainParts(apply.applyId);
    if (!parts) continue;
    const entries = groups.get(parts.prefix) ?? [];
    entries.push({ ...apply, drainPoll: parts.poll });
    groups.set(parts.prefix, entries);
  }
  return [...groups.entries()]
    .map(([prefix, entries]) => {
      const ordered = entries.sort((left, right) => left.drainPoll - right.drainPoll);
      const latest = ordered.reduce((left, right) => left.updatedAt >= right.updatedAt ? left : right);
      const lastPollEntry = ordered.at(-1) as SessionApplySummary & { drainPoll: number };
      const nextPoll = Math.max(...ordered.map((entry) => entry.drainPoll)) + 1;
      const done = ordered.some((entry) => entry.selected === 0);
      const stoppedOnFailure = ordered.some((entry) => entry.failed > 0);
      return {
        prefix,
        polls: ordered.length,
        applyIds: ordered.map((entry) => entry.applyId),
        latestApplyId: latest.applyId,
        updatedAt: latest.updatedAt,
        selected: ordered.reduce((sum, entry) => sum + entry.selected, 0),
        succeeded: ordered.reduce((sum, entry) => sum + entry.succeeded, 0),
        failed: ordered.reduce((sum, entry) => sum + entry.failed, 0),
        pending: ordered.reduce((sum, entry) => sum + entry.pending, 0),
        done,
        stoppedOnFailure,
        nextApplyId: `${prefix}-${String(nextPoll).padStart(3, "0")}`,
        continueCommand: done || stoppedOnFailure ? null : sessionApplyDrainContinueCommand(prefix, lastPollEntry),
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function sessionApplyDrainContinueCommand(prefix: string, latest: SessionApplySummary): string[] | null {
  if (latest.source !== "watch") return null;
  const applyIdIndex = latest.actions.resumeApply.indexOf("--apply-id");
  if (applyIdIndex < 0) return null;
  const command = latest.actions.resumeApply.slice(0, applyIdIndex);
  if (!command.includes("--action") && !command.includes("--apply-action") && !command.includes("--branch-action")) return null;
  if (latest.filter.includeStopped === true) command.push("--include-stopped");
  const status = stringListFromUnknown(latest.filter.status);
  if (status.length > 0) command.push("--status", status.join(","));
  const run = stringListFromUnknown(latest.filter.run);
  if (run.length > 0) command.push("--run", run.join(","));
  if (typeof latest.filter.limit === "string" || typeof latest.filter.limit === "number") {
    command.push("--limit", String(latest.filter.limit));
  }
  if (typeof latest.filter.checkoutDir === "string") command.push("--checkout-dir", latest.filter.checkoutDir);
  if (latest.filter.changedOnly === true) command.push("--changed-only");
  const changedPath = stringListFromUnknown(latest.filter.changedPath);
  if (changedPath.length > 0) command.push("--changed-path", changedPath.join(","));
  command.push("--continue-prefix", prefix, "--until-empty");
  return command;
}

function sessionApplyDrainContinueCommandWithOptions(
  command: string[],
  options: { dryRun: boolean; maxPolls: number | null; intervalMs: number | null },
): string[] {
  return [
    ...command,
    ...(options.maxPolls ? ["--max-polls", String(options.maxPolls)] : []),
    ...(options.intervalMs ? ["--interval-ms", String(options.intervalMs)] : []),
    ...(options.dryRun ? ["--dry-run"] : []),
  ];
}

function sessionApplyCommandStates(record: SessionApplyRecord | null): Map<string, { succeeded: boolean; failed: boolean }> {
  const states = new Map<string, { succeeded: boolean; failed: boolean }>();
  for (const execution of record?.executions ?? []) {
    const key = commandKey(execution.command);
    const state = states.get(key) ?? { succeeded: false, failed: false };
    if (execution.exitCode === 0) state.succeeded = true;
    else state.failed = true;
    states.set(key, state);
  }
  return states;
}

function sessionApplyAffectedRuns(
  record: SessionApplyRecord,
  commandStates: Map<string, { succeeded: boolean; failed: boolean }>,
  runStatusIndex: Map<string, SessionApplyRunStatus> | null,
): Array<{
    runId: string;
    action: string;
    reason: string;
    state: "succeeded" | "failed" | "pending";
    commands: {
      inspectRun: string[];
      inspectResults: string[];
      checkoutBranch: string[];
      reviewRun: string[];
    };
    currentRun: SessionApplyRunStatus | null;
  }> {
  const seenRunIds = new Set<string>();
  const checkoutRoot = `./checkouts/${record.session}-applies/${record.applyId}`;
  return record.commands
    .filter((command): command is SessionApplyCommand & { runId: string } => Boolean(command.runId))
    .filter((command) => {
      if (seenRunIds.has(command.runId)) return false;
      seenRunIds.add(command.runId);
      return true;
    })
    .map((command) => {
      const state = commandStates.get(commandKey(command.command));
      const runCheckoutDir = `${checkoutRoot}/${command.runId}`;
      return {
        runId: command.runId,
        action: command.action,
        reason: command.reason,
        state: state?.succeeded ? "succeeded" : state?.failed ? "failed" : "pending",
        commands: {
          inspectRun: ["npm", "run", "cli", "--", "runs", "inspect", command.runId],
          inspectResults: ["npm", "run", "cli", "--", "runs", "results", "--session", record.session, "--run", command.runId, "--next"],
          checkoutBranch: ["npm", "run", "cli", "--", "runs", "checkout", command.runId, "--dir", runCheckoutDir],
          reviewRun: ["npm", "run", "cli", "--", "runs", "review", command.runId, "--checkout-dir", runCheckoutDir],
        },
        currentRun: runStatusIndex?.get(command.runId) ?? null,
      };
    });
}

async function sessionApplyRunStatusIndex(sessionName: string): Promise<Map<string, SessionApplyRunStatus> | null> {
  try {
    const status = await workerSessionStatus(sessionName, new Set(["planned", "running", "stopped", "completed", "failed"]));
    const sessionWorkers = status.session.workers as Array<WorkerSession["workers"][number] & {
      runs: Array<SessionVisibleRun & { agentId: string }>;
    }>;
    const rows: SessionApplyRunStatus[] = [
      ...sessionWorkers.flatMap((worker) => worker.runs.map((run) => sessionApplyRunStatusRow(run, {
        agentId: run.agentId,
        workerId: worker.workerId,
        location: "session_worker",
      }))),
      ...status.agents.flatMap((agent) => [
        ...agent.unassigned.map((run) => sessionApplyRunStatusRow(run, {
          agentId: agent.agentId,
          workerId: null,
          location: "unassigned",
        })),
        ...agent.otherWorkers.map((run) => sessionApplyRunStatusRow(run, {
          agentId: agent.agentId,
          workerId: run.workerId,
          location: "other_worker",
        })),
      ]),
    ];
    return new Map(rows.map((row) => [row.runId, row]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sessionApplyRunStatusRow(
  run: SessionVisibleRun,
  context: { agentId: string; workerId: string | null; location: "session_worker" | "unassigned" | "other_worker" },
): SessionApplyRunStatus {
  const resumable = run.status === "stopped" && run.resultCommit === null;
  const reviewable = run.resultCommit !== null;
  const nextAction = resumable
    ? "resume_branch"
    : reviewable
      ? "review_branch"
      : context.location === "unassigned"
        ? "dispatch_worker"
        : "wait_for_worker";
  return {
    agentId: context.agentId,
    runId: run.id,
    status: run.status,
    objective: run.objective,
    branchName: run.branchName,
    resultCommit: run.resultCommit,
    workerId: context.workerId,
    location: context.location,
    resumable,
    reviewable,
    nextAction,
  };
}

function parseSessionApplyResumeFilter(value: string): Set<"failed" | "pending"> {
  const allowed = new Set(["failed", "pending"]);
  const parsed = parseList(value);
  if (parsed.length === 0) throw new Error("--resume-filter must include failed, pending, or failed,pending");
  for (const item of parsed) {
    if (!allowed.has(item)) throw new Error("--resume-filter must be failed, pending, or failed,pending");
  }
  return new Set(parsed as Array<"failed" | "pending">);
}

function sessionApplyResumeCommand(record: SessionApplyRecord, resumeFilter?: Array<"failed" | "pending">): string[] {
  const command = ["npm", "run", "cli", "--", "runs", "session-apply", record.session];
  if (record.source && record.source !== "review") {
    command.push("--source", record.source);
  }
  const branchAction = stringListFromUnknown(record.filter.branchAction);
  const applyAction = stringListFromUnknown(record.filter.applyAction);
  const action = stringListFromUnknown(record.filter.action);
  const fallbackActions = [...new Set(record.commands.map((item) => item.action))];
  const hasBranchCommands = record.commands.some((item) => item.scope === "branch");
  const hasApplyCommands = record.commands.some((item) => item.scope === "apply");
  if (branchAction.length > 0) {
    command.push("--branch-action", branchAction.join(","));
  } else if (applyAction.length > 0) {
    command.push("--apply-action", applyAction.join(","));
  } else if (action.length > 0) {
    command.push("--action", action.join(","));
  } else if (hasBranchCommands && fallbackActions.length > 0) {
    command.push("--branch-action", fallbackActions.join(","));
  } else if (hasApplyCommands && fallbackActions.length > 0) {
    command.push("--apply-action", fallbackActions.join(","));
  } else if (fallbackActions.length > 0) {
    command.push("--action", fallbackActions.join(","));
  }
  command.push("--apply-id", record.applyId, "--resume");
  if (resumeFilter && resumeFilter.join(",") !== "failed,pending") {
    command.push("--resume-filter", resumeFilter.join(","));
  }
  return command;
}

function stringListFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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

function workerSessionLogDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(workerSessionDir, sessionName);
}

function workerSessionApplyDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(workerSessionDir, "apply", sessionName);
}

function workerSessionApplyPath(sessionName: string, applyId: string): string {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(applyId);
  return path.join(workerSessionApplyDir(sessionName), `${applyId}.json`);
}

function workerSessionWatchDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(workerSessionDir, "watch", sessionName);
}

function workerSessionWatchPath(sessionName: string, watchId: string): string {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(watchId);
  return path.join(workerSessionWatchDir(sessionName), `${watchId}.json`);
}

function workerSessionDrainContinuationDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(workerSessionDir, "drain-continuations", sessionName);
}

function workerSessionDrainContinuationPath(sessionName: string, continuationId: string): string {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(continuationId);
  return path.join(workerSessionDrainContinuationDir(sessionName), `${continuationId}.json`);
}

function workerSessionControlPlaneTickDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(workerSessionDir, "control-plane-ticks", sessionName);
}

function drainContinuationWorkerRootDir(): string {
  return path.join(workerSessionDir, "drain-continuation-workers");
}

function drainContinuationWorkerDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(drainContinuationWorkerRootDir(), sessionName);
}

function drainContinuationWorkerPath(sessionName: string, workerId: string): string {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(workerId);
  return path.join(drainContinuationWorkerDir(sessionName), `${workerId}.json`);
}

function applyActionWorkerRootDir(): string {
  return path.join(workerSessionDir, "apply-action-workers");
}

function applyActionWorkerDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(applyActionWorkerRootDir(), sessionName);
}

function applyActionWorkerPath(sessionName: string, workerId: string): string {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(workerId);
  return path.join(applyActionWorkerDir(sessionName), `${workerId}.json`);
}

function sessionWatchWorkerRootDir(): string {
  return path.join(workerSessionDir, "watch-workers");
}

function sessionWatchWorkerDir(sessionName: string): string {
  assertSafeSessionName(sessionName);
  return path.join(sessionWatchWorkerRootDir(), sessionName);
}

function sessionWatchWorkerPath(sessionName: string, workerId: string): string {
  assertSafeSessionName(sessionName);
  assertSafeSessionName(workerId);
  return path.join(sessionWatchWorkerDir(sessionName), `${workerId}.json`);
}

function createDrainContinuationWorkerId(): string {
  return `drain-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

function createApplyActionWorkerId(): string {
  return `apply-action-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

function createSessionWatchWorkerId(): string {
  return `watch-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
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

type StopProcessGroupResult = {
  signalSent: boolean;
  forced: boolean;
  alive: boolean;
};

async function stopProcessGroup(pid: number | null): Promise<StopProcessGroupResult> {
  if (!pid) return { signalSent: false, forced: false, alive: false };
  const target = process.platform === "win32" ? pid : -pid;
  let signalSent = false;
  try {
    process.kill(target, "SIGTERM");
    signalSent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      return { signalSent, forced: false, alive: processIsAlive(pid) };
    }
    signalSent = true;
  }
  await waitForProcessExit(pid, 750);
  if (!processIsAlive(pid)) return { signalSent, forced: false, alive: false };

  let forced = false;
  try {
    process.kill(target, "SIGKILL");
    forced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") {
      return { signalSent, forced, alive: processIsAlive(pid) };
    }
  }
  await waitForProcessExit(pid, 750);
  return { signalSent, forced, alive: processIsAlive(pid) };
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await sleep(50);
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
  runs inspect-result <run> [--server] [--checkout-dir ./checkouts/run-result]
  runs checkout <run> --dir ./checkouts/run
  runs review <run> [--checkout-dir ./checkouts/run]
  runs checkout-session <name> --dir ./checkouts [--status completed,stopped] [--resumable] [--worker-id worker-a] [--concurrency 2]
  runs claim <run> [--worker-id worker-a]
  runs requeue <run> [--worker-id worker-a]
  runs resume-branch <run> [--inspect] [--dry-run] [--worker-id worker-a]
  runs recover --agent <agent>|--agents <agent,agent> [--include-stopped] [--dry-run] [--worker-id worker-a] [--concurrency 4]
  runs watch <run> [--limit 20] [--interval-ms 2000] [--max-polls 10]
  runs backlog --agent <agent>|--agents <agent,agent>
  runs branches --agent <agent>|--agents <agent,agent>|--session <name> [--status completed,stopped] [--resumable] [--worker-id worker-a] [--checkout-dir ./checkouts] [--next] [--commands-only] [--format json|shell]
  runs results --agent <agent>|--agents <agent,agent>|--session <name> [--server] [--status completed,stopped] [--worker-id worker-a] [--branch-action resume_branch|review_branch] [--run run_id[,run_id]] [--checkout-dir ./checkouts] [--changed-only] [--changed-path path[,path]] [--next] [--limit 20] [--offset 20] [--commands-only] [--format json|shell] [--interval-ms 2000] [--max-polls 1]
  runs workers --agent <agent>|--agents <agent,agent> [--status running]
  runs sessions [--session <name>] [--summary] [--next] [--limit 10] [--offset 10] [--commands-only] [--format json|shell] [--needs-action] [--action continue_watch] [--branch-action review_branch] [--older-than-ms 600000] [--interval-ms 2000] [--max-polls 1]
  runs archive-sessions [--session <name>] [--dry-run]
  runs session-wait <name> [--recoverable] [--include-stopped] [--max-polls 60] [--interval-ms 2000]
  runs session-actions <name>
  runs session-status <name> [--status planned,running,stopped] [--recoverable] [--include-stopped] [--next] [--commands-only] [--branch-action resume_branch] [--format json|shell]
  runs session-summary <name> [--next] [--limit 20] [--offset 20] [--commands-only] [--format json|shell] [--action continue_watch] [--branch-action resume_branch|review_branch] [--older-than-ms 600000] [--interval-ms 2000] [--max-polls 1]
  runs session-review <name> [--include-stopped] [--next] [--limit 20] [--offset 20] [--commands-only] [--format json|shell] [--action review_changed_results] [--branch-action resume_branch|review_branch] [--checkout-dir ./checkouts] [--changed-only] [--changed-path path[,path]] [--lines 20] [--status planned,running,stopped]
  runs session-apply <name> (--action recover_session|recover_stopped|resume_session|review_changed_results|retry_failed|resume_pending|review_ready_results|reset_failed_drain_continuations|reset_running_drain_continuations|--apply-action retry_failed|resume_pending|review_ready_results|inspect_drain_continuation_resets|--branch-action resume_branch|review_branch) [--source review|status|watch|branches] [--include-stopped] [--run run_id[,run_id]] [--limit 1] [--dry-run] [--apply-id id] [--resume] [--resume-filter failed|pending|failed,pending] [--until-empty] [--continue-prefix prefix] [--max-polls 10] [--interval-ms 2000] [--concurrency 1]
  runs session-applies <name> [--server] [--apply-id id] [--ack-reset-audit] [--summary] [--action-queue] [--execute-next|--execute-queued] [--max-actions 10] [--until-empty] [--max-polls 10] [--interval-ms 2000] [--continue-on-failure] [--detach] [--worker-id id] [--action-executions] [--execution execution_id] [--summary-group resume-needed|ready-to-review|drain-prefixes|drain-resets] [--continue-drains] [--drain-prefix prefix[,prefix]] [--ready-results] [--format json|shell] [--checkout-dir ./checkouts] [--changed-only] [--changed-path path[,path]]
  runs session-drains <name> [--drain-prefix prefix[,prefix]] [--format json|shell]
  runs session-drain-continuations <name> [--queue] [--execute continuation_id|--execute-next|--execute-queued|--reset-running|--reset-failed] [--older-than-ms 600000] [--continuation id[,id]] [--detach] [--worker-id id] [--max-continuations 10] [--status queued,running,executed,failed] [--drain-prefix prefix[,prefix]] [--dry-run] [--max-polls 10] [--interval-ms 2000] [--limit 20] [--format json]
  runs session-drain-workers [name] [--server] [--worker-id id] [--include-retired] [--lines 20]
  runs stop-drain-workers <name> [--server] [--worker-id id] [--retire] [--lines 20]
  runs restart-drain-workers <name> [--server] --worker-id id [--include-retired] [--lines 20]
  runs ensure-drain-worker <name> --server [--worker-id id] [--max-continuations n] [--lines 20]
  runs session-apply-action-workers [name] [--server] [--worker-id id] [--include-retired] [--lines 20]
  runs session-apply-action-workers-next <name> --server
  runs ensure-apply-action-worker <name> --server [--worker-id id] [--apply-id id] [--source source] [--apply-action action] [--limit n] [--max-actions n] [--continue-on-failure] [--until-empty] [--max-polls n] [--interval-ms n] [--lines 20]
  runs session-control-plane-status <name> --server [--summary] [--lines 5]
  runs session-control-plane-alerts <name> --server [--severity error,warning] [--surface branch,stale_run,apply_action,drain_continuation,worker_recovery] [--reason running_sandbox_present] [--run run_id] [--worker worker_id] [--apply apply_id] [--execution execution_id] [--continuation continuation_id] [--action inspect_run] [--limit 20] [--lines 5] [--commands-only] [--format json|shell]
  runs session-control-plane-alert <name> --server [--severity error,warning] [--surface branch,stale_run,apply_action,drain_continuation,worker_recovery] [--reason running_sandbox_present] [--run run_id] [--worker worker_id] [--apply apply_id] [--execution execution_id] [--continuation continuation_id] [--action inspect_run] [--lines 5] [--commands-only] [--format json|shell]
  runs session-control-plane-alert-execute <name> --server [--severity error,warning] [--surface branch,stale_run,apply_action,drain_continuation,worker_recovery] [--reason running_sandbox_present] [--run run_id] [--worker worker_id] [--apply apply_id] [--execution execution_id] [--continuation continuation_id] [--action inspect_run] [--detail-command inspect_apply|inspect_apply_action_executions|execute_apply_action|acknowledge_reset_audit|inspect_failed_drain_continuations|reset_failed_drain_continuations|reset_selected_failed_drain_continuations] [--dry-run] [--confirm] [--lines 5]
  runs session-control-plane-advance <name> --server [--dry-run] [--lines 5]
  runs session-control-plane-advance-loop <name> --server [--dry-run] [--max-steps 10] [--interval-ms 2000] [--lines 5]
  runs session-control-plane-advances <name> --server [--advance advance_id] [--blocked] [--mutating] [--confirmation-queue] [--execute-confirmation --advance-id id --confirm] [--execute-next-confirmation --confirm] [--drain-confirmations --confirm --max-confirmations 3] [--until-empty --max-steps 10 --interval-ms 2000] [--dry-run] [--limit 20] [--commands-only] [--format json|shell]
  runs start-control-plane-advance-worker <name> --server [--worker-id id] [--dry-run] [--max-steps 10] [--interval-ms 2000] [--lines 5] [--drain-confirmations --confirm --max-confirmations 3 --until-empty]
  runs ensure-control-plane-advance-worker <name> --server [--worker-id id] [--dry-run] [--max-steps 10] [--interval-ms 2000] [--lines 20] [--drain-confirmations --confirm --max-confirmations 3 --until-empty]
  runs session-control-plane-advance-workers <name> --server [--worker-id id] [--include-retired] [--lines 20]
  runs session-control-plane-advance-workers-next <name> --server [--worker-id id]
  runs restart-control-plane-advance-workers <name> --server --worker-id id [--include-retired] [--lines 20]
  runs stop-control-plane-advance-workers <name> --server [--worker-id id] [--retire] [--lines 20]
  runs session-control-plane-tick <name> --server [--dry-run] [--lines 5]
  runs session-control-plane-tick-loop <name> --server [--dry-run] [--max-ticks 10] [--interval-ms 2000] [--lines 5]
  runs session-control-plane-ticks <name> [--server] [--tick tick_id[,tick_id]] [--limit 20]
  runs session-control-plane-timeline <name> --server [--summary] [--source tick,branch_recovery_execution] [--event tick_recorded,branch_recovery_executed] [--status executed,noop] [--tick tick_id] [--advance advance_id] [--worker worker_id] [--execution execution_id] [--apply apply_id] [--run run_id] [--limit 20] [--lines 5] [--commands-only] [--format json|shell]
  runs start-control-plane-tick-worker <name> --server [--worker-id id] [--dry-run] [--max-ticks 10] [--interval-ms 2000] [--lines 5]
  runs ensure-control-plane-tick-worker <name> --server [--worker-id id] [--dry-run] [--max-ticks 10] [--interval-ms 2000] [--lines 20]
  runs session-control-plane-tick-workers <name> --server [--worker-id id] [--include-retired] [--lines 20]
  runs session-control-plane-tick-workers-next <name> --server [--worker-id id]
  runs restart-control-plane-tick-workers <name> --server --worker-id id [--include-retired] [--lines 20]
  runs stop-control-plane-tick-workers <name> --server [--worker-id id] [--retire] [--lines 20]
  runs session-branch-recovery-executions <name> --server [--execution execution_id[,execution_id]] [--run run_id[,run_id]] [--status executed,partial,noop] [--limit 20] [--commands-only] [--checkout-dir ./checkouts/name-branch-recovery] [--format json|shell]
  runs session-branches <name> --server [--status completed,stopped] [--resumable] [--worker-id worker-a] [--branch-action resume_branch|review_branch] [--run run_id[,run_id]] [--limit 20] [--offset 20] [--checkout-dir ./checkouts/name-branches] [--commands-only] [--format json|shell]
  runs stop-apply-action-workers <name> [--server] [--worker-id id] [--retire] [--lines 20]
  runs restart-apply-action-workers <name> [--server] --worker-id id [--include-retired] [--lines 20]
  runs session-watch <name> [--status planned,running,stopped] [--recoverable] [--include-stopped] [--next] [--action-queue] [--apply-action retry_failed|resume_pending|review_ready_results|inspect_drain_continuation_resets] [--until-empty] [--watch-id id] [--commands-only] [--format json|shell] [--checkout-dir ./checkouts] [--interval-ms 2000] [--max-polls 10]
  runs session-watches <name> [--watch-id id] [--limit 20]
  runs start-session-watch-worker <name> [--worker-id id] [--watch-id id] [--recoverable] [--include-stopped] [--action-queue] [--apply-action retry_failed|resume_pending|review_ready_results|inspect_drain_continuation_resets] [--max-polls 60] [--interval-ms 2000]
  runs session-watch-workers [name] [--worker-id id] [--include-retired] [--lines 20]
  runs stop-session-watch-workers <name> [--worker-id id] [--retire] [--lines 20]
  runs restart-session-watch-workers <name> --worker-id id [--include-retired] [--lines 20]
  runs session-logs <name> [--lines 80]
  runs stop-session <name> [--recover] [--include-stopped] [--concurrency 4]
  runs recover-session <name> [--server] [--include-stopped] [--dry-run] [--concurrency 4] [--limit 1] [--run run_id[,run_id]]
  runs resume-session <name> [--worker-id worker-a] [--dry-run] [--next] [--limit 1] [--run run_id[,run_id]]
  runs restart-session <name> [--recover] [--resume-stopped] [--no-bootstrap] [--wait] [--max-polls 60] [--concurrency 4]
  runs stop-matching --agent <agent>|--agents <agent,agent> [--status planned] [--concurrency 4]
  runs monitor --agent <agent>|--agents <agent,agent> [--status planned,running,stopped] [--next] [--checkout-dir ./checkouts/monitor] [--limit 3] [--interval-ms 2000] [--max-polls 1]
  runs supervise --agent <agent>|--agents <agent,agent> --session <name> [--workers 1] [--worker-prefix worker] [--recover] [--include-stopped] [--resume-stopped] [--loop|--until-empty] [--wait] [--max-polls 60]
  runs dispatch --agents <agent,agent> (--objectives-file ./tasks.txt|--objective "task") --session <name> [--assignment fanout|round-robin] [--dry-run] [--workers 1] [--worker-prefix worker] [--bootstrap] [--boot] [--recover] [--include-stopped] [--until-empty] [--wait] [--max-polls 60]
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
