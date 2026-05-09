import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = normalizeBaseUrl(process.env.THREADBEAT_BASE_URL ?? "http://127.0.0.1:8000");

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

  if (commandName === "code-storage") {
    await codeStorage(subcommandName, args);
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
      defaultBranch: options.branch,
      currentRef: options.ref,
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
    const outDir = option(options, "out", "dir");
    if (!outDir) {
      await printJson(response);
      return;
    }
    const template = readTemplateResponse(response);
    const written = await materializeTemplate(template, outDir);
    await printJson({ ok: true, template: { id: template.id, name: template.name }, outDir: path.resolve(outDir), written });
    return;
  }
  if (subcommandName === "init") {
    const options = parseOptions(args);
    if (options.live === "1" && option(options, "dry-run", "dryRun") === "1") {
      throw new Error("agents init cannot use both --live and --dry-run");
    }
    const dryRun = options.live === "1"
      ? false
      : option(options, "dry-run", "dryRun") === "1"
        ? true
        : undefined;
    await printJson(await requestJson("POST", "/api/agents/from-template", {
      name: required(options.name, "--name"),
      ...(options.id ? { id: options.id } : {}),
      ...(option(options, "repo-id", "repo") ? { repoId: option(options, "repo-id", "repo") } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.branch ? { defaultBranch: options.branch } : {}),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(option(options, "message", "commit-message") ? { commitMessage: option(options, "message", "commit-message") } : {}),
    }));
    return;
  }
  if (subcommandName === "get") {
    const id = args[0];
    if (!id) throw new Error("agents get requires an id");
    await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}`));
    return;
  }
  if (subcommandName === "repo" || subcommandName === "repository") {
    const id = args[0];
    if (!id) throw new Error(`agents ${subcommandName} requires an id`);
    await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}/repository`));
    return;
  }
  if (subcommandName === "code-storage") {
    const [id, action, ...optionArgs] = args;
    if (!id) throw new Error("agents code-storage requires an agent id");
    if (!action || action === "get") {
      await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}/code-storage`));
      return;
    }
    if (action === "create") {
      const options = parseOptions(optionArgs);
      await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(id)}/code-storage`, {
        dryRun: options.live === "1" ? false : true,
        repoId: options.id,
      }));
      return;
    }
    throw new Error(`unknown agents code-storage action: ${action}`);
  }
  if (subcommandName === "runs") {
    const [id, action, ...optionArgs] = args;
    if (!id) throw new Error("agents runs requires an agent id");
    if (!action || action === "list") {
      await printJson(await requestJson("GET", `/api/agents/${encodeURIComponent(id)}/runs`));
      return;
    }
    if (action === "plan") {
      const options = parseOptions(optionArgs);
      await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(id)}/runs`, runPlanPayload(options)));
      return;
    }
    throw new Error(`unknown agents runs action: ${action}`);
  }
  throw new Error(`unknown agents command: ${subcommandName}`);
}

async function codeStorage(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "repos" || subcommandName === "list") {
    await printJson(await requestJson("GET", "/api/code-storage/repos"));
    return;
  }
  if (subcommandName === "create") {
    const options = parseOptions(args);
    const agentId = required(option(options, "agent", "agent-id"), "--agent");
    await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/code-storage`, {
      dryRun: options.live === "1" ? false : true,
      repoId: options.id,
    }));
    return;
  }
  throw new Error(`unknown code-storage command: ${subcommandName}`);
}

async function sandboxes(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    const agentId = option(options, "agent", "agent-id");
    const runId = option(options, "run", "run-id");
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
    const agentId = required(option(options, "agent", "agent-id"), "--agent");
    await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/sandboxes`));
    return;
  }
  if (subcommandName === "stop-running") {
    const options = parseOptions(args);
    const agentId = option(options, "agent", "agent-id");
    const runId = option(options, "run", "run-id");
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
      ...(option(options, "timeout", "timeout-ms") ? { timeoutMs: option(options, "timeout", "timeout-ms") } : {}),
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
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("sandboxes bootstrap requires a sandbox id");
    await printJson(await requestJson("POST", `/api/sandboxes/${encodeURIComponent(id)}/bootstrap`, parseOptions(optionArgs)));
    return;
  }
  throw new Error(`unknown sandboxes command: ${subcommandName}`);
}

async function runs(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    const agentId = required(option(options, "agent", "agent-id"), "--agent");
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
    if (option(options, "limit")) params.set("limit", option(options, "limit") as string);
    await printJson(await requestJson("GET", withQuery(`/api/runs/${encodeURIComponent(id)}/status`, params)));
    return;
  }
  if (subcommandName === "plan") {
    const options = parseOptions(args);
    const agentId = required(option(options, "agent", "agent-id"), "--agent");
    await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, runPlanPayload(options)));
    return;
  }
  if (subcommandName === "step") {
    const separatorIndex = args.indexOf("--");
    const optionArgs = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
    const rawCommandArgs = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];
    const options = parseOptions(optionArgs);
    const command = rawCommandArgs.join(" ");
    if (!command.trim()) throw new Error("runs step requires a command after --");
    const runId = option(options, "run", "run-id") ?? await planRunForStep(options);
    const sandbox = await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/sandbox`, {
      bootstrap: options.bootstrap === "1",
    });
    const executed = await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/exec`, {
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const finalized = options.finalize === "1"
      ? await requestJson("POST", `/api/runs/${encodeURIComponent(runId)}/finalize`, {
        ...(option(options, "message", "commit-message") ? { commitMessage: option(options, "message", "commit-message") } : {}),
      })
      : null;
    const status = await requestJson("GET", `/api/runs/${encodeURIComponent(runId)}/status`);
    await printJson({ ok: true, runId, sandbox, executed, finalized, status });
    return;
  }
  if (subcommandName === "sandbox" || subcommandName === "start-sandbox") {
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
      ...(option(options, "timeout", "timeout-ms") ? { timeoutMs: option(options, "timeout", "timeout-ms") } : {}),
    }));
    return;
  }
  if (subcommandName === "boot") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("runs boot requires a run id");
    const options = parseOptions(optionArgs);
    await printJson(await requestJson("POST", `/api/runs/${encodeURIComponent(id)}/boot`, {
      ...(options.objective ? { objective: options.objective } : {}),
      ...(option(options, "prompt", "prompt-path") ? { promptPath: option(options, "prompt", "prompt-path") } : {}),
      ...(option(options, "task", "task-path") ? { taskPath: option(options, "task", "task-path") } : {}),
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
      ...(option(options, "message", "commit-message") ? { commitMessage: option(options, "message", "commit-message") } : {}),
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
    const agentId = option(options, "agent", "agent-id");
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
  const agentId = option(options, "agent", "agent-id");
  const runId = option(options, "run", "run-id");
  const sandboxId = option(options, "sandbox", "sandbox-id");
  if (agentId) params.set("agentId", agentId);
  if (runId) params.set("runId", runId);
  if (sandboxId) params.set("sandboxId", sandboxId);
  if (option(options, "limit")) params.set("limit", option(options, "limit") as string);

  if (mode === "listen" || options.follow === "1") {
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
    if (key === "bootstrap" || key === "finalize" || key === "follow" || key === "live" || key === "dry-run") {
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

async function requestJson(method: string, path: string, payload?: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) as { ok?: boolean; error?: string } : {};
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `${method} ${path} failed`);
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

function option(options: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (options[key]) return options[key];
  }
  return undefined;
}

async function planRunForStep(options: Record<string, string>): Promise<string> {
  const agentId = required(option(options, "agent", "agent-id"), "--agent");
  const planned = await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, runPlanPayload(options));
  const run = (planned as { run?: { id?: unknown } }).run;
  if (!run || typeof run.id !== "string") throw new Error("planned run response did not include run.id");
  return run.id;
}

type AgentTemplateResponse = {
  template: {
    id: string;
    name: string;
    files: Array<{ path: string; content: string }>;
  };
};

function readTemplateResponse(value: unknown): AgentTemplateResponse["template"] {
  const template = (value as AgentTemplateResponse).template;
  if (!template || typeof template.id !== "string" || typeof template.name !== "string" || !Array.isArray(template.files)) {
    throw new Error("template response did not include template files");
  }
  return template;
}

async function materializeTemplate(template: AgentTemplateResponse["template"], outDir: string): Promise<string[]> {
  const root = path.resolve(outDir);
  const written: string[] = [];
  for (const file of template.files) {
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
    ...(options.kind ? { kind: options.kind } : {}),
    ...(option(options, "input-ref", "input") ? { inputRef: option(options, "input-ref", "input") as string } : {}),
    ...(options.prefix ? { prefix: options.prefix } : {}),
    ...(option(options, "base-commit", "base") ? { baseCommit: option(options, "base-commit", "base") as string } : {}),
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
  agents template --name <name> [--id <agent_id>] [--description "..."] [--out ./agent-repo]
  agents init --name <name> [--id <agent_id>] [--repo-id <repo_id>] [--branch main] [--description "..."] [--live|--dry-run]
  agents create --name <name> --repo <url> [--branch main] [--ref main]
  agents list
  agents get <agent_id>
  agents repo <agent_id>
  agents code-storage <agent_id> [get]
  agents code-storage <agent_id> create [--id <code_storage_repo_id>] [--live]
  agents runs <agent_id> [list]
  agents runs <agent_id> plan --objective <objective> [--kind run] [--input-ref main] [--prefix threadbeat/runs]
  code-storage list
  code-storage create --agent <agent_id> [--id <code_storage_repo_id>] [--live]
  runs list --agent <agent_id>
  runs get <run_id>
  runs status <run_id> [--limit 20]
  runs plan --agent <agent_id> --objective <objective> [--kind run] [--input-ref main] [--prefix threadbeat/runs]
  runs step --agent <agent_id> --objective <objective> [--bootstrap] [--finalize] [--message "Finalize run"] -- <command>
  runs step --run <run_id> [--bootstrap] [--finalize] [--cwd /workspace/agent] -- <command>
  runs sandbox <run_id> [--bootstrap]
  runs restart-sandbox <run_id> [--bootstrap]
  runs exec <run_id> [--cwd /workspace/agent] [--timeout-ms 120000] -- <command>
  runs boot <run_id> [--objective "..."] [--prompt .pi/prompts/heartbeat.md] [--task tasks/inbox/run.md]
  runs check-runtime <run_id>
  runs finalize <run_id> [--message "Finalize run"]
  runs stop <run_id>
  sandboxes start --agent <agent_id>
  sandboxes list [--agent <agent_id>] [--run <run_id>]
  sandboxes get <sandbox_id>
  sandboxes exec <sandbox_id> [--timeout-ms 120000] -- <command>
  sandboxes stop-running [--agent <agent_id>] [--run <run_id>]
  sandboxes stop <sandbox_id>
  sandboxes bootstrap <sandbox_id>
  heartbeats list [--agent <agent_id>]
  heartbeats get <heartbeat_id>
  messages list [--agent <agent_id>] [--run <run_id>] [--sandbox <sandbox_id>] [--limit 50]
  messages listen [--agent <agent_id>] [--run <run_id>] [--sandbox <sandbox_id>]
  messages --follow [--agent <agent_id>] [--run <run_id>] [--sandbox <sandbox_id>]
`);
}
