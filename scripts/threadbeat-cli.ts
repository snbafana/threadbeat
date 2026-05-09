import "dotenv/config";

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
  if (subcommandName === "exec") {
    const [sandboxId, ...commandArgs] = args;
    if (!sandboxId) throw new Error("sandboxes exec requires a sandbox id");
    const separatorIndex = commandArgs.indexOf("--");
    const command = separatorIndex >= 0 ? commandArgs.slice(separatorIndex + 1).join(" ") : commandArgs.join(" ");
    if (!command.trim()) throw new Error("sandboxes exec requires a command");
    await printJson(await requestJson("POST", `/api/sandboxes/${encodeURIComponent(sandboxId)}/exec`, { command }));
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
  if (subcommandName === "plan") {
    const options = parseOptions(args);
    const agentId = required(option(options, "agent", "agent-id"), "--agent");
    await printJson(await requestJson("POST", `/api/agents/${encodeURIComponent(agentId)}/runs`, runPlanPayload(options)));
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
    if (key === "bootstrap" || key === "follow" || key === "live") {
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
  runs plan --agent <agent_id> --objective <objective> [--kind run] [--input-ref main] [--prefix threadbeat/runs]
  runs sandbox <run_id> [--bootstrap]
  sandboxes start --agent <agent_id>
  sandboxes list [--agent <agent_id>] [--run <run_id>]
  sandboxes get <sandbox_id>
  sandboxes exec <sandbox_id> -- <command>
  sandboxes stop <sandbox_id>
  sandboxes bootstrap <sandbox_id>
  heartbeats list [--agent <agent_id>]
  heartbeats get <heartbeat_id>
  messages list [--agent <agent_id>] [--run <run_id>] [--sandbox <sandbox_id>] [--limit 50]
  messages listen [--agent <agent_id>] [--run <run_id>] [--sandbox <sandbox_id>]
  messages --follow [--agent <agent_id>] [--run <run_id>] [--sandbox <sandbox_id>]
`);
}
