import fs from "node:fs/promises";

type Event = {
  seq: number;
  type: string;
  source: string;
  data?: Record<string, unknown>;
};

const args = parseArgs(process.argv.slice(2));
const baseUrl = apiUrl(args);

try {
  const agentId = value(args, "agent-id") ?? value(args, "agent");
  const ask = value(args, "ask") ?? args._.join(" ").trim();
  if (!agentId) throw new Error("usage: npm run railway:agent-run -- --agent-id <id> --ask <ask>");
  if (!ask) throw new Error("usage: npm run railway:agent-run -- --agent-id <id> --ask <ask>");

  if (value(args, "repo")) {
    await request("POST", "/api/agents", {
      id: agentId,
      name: value(args, "name") ?? agentId,
      repoUrl: value(args, "repo"),
      defaultBranch: value(args, "branch") ?? "main",
    });
  }

  const taskSpec = {
    ask,
    inputs: await inputs(args),
  };
  const created = await request<{
    task: { id: string; runBranch?: string; status: string };
  }>("POST", `/api/agents/${encodeURIComponent(agentId)}/tasks`, taskSpec);

  console.log(JSON.stringify({
    apiUrl: baseUrl,
    agentId,
    taskId: created.task.id,
    runBranch: created.task.runBranch,
    status: created.task.status,
  }, null, 2));

  const follow = flag(args, "follow") || flag(args, "drain");
  if (flag(args, "drain")) await drainAndFollow(created.task.id, follow);
  else if (follow) await followEvents(created.task.id);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function drainAndFollow(taskId: string, follow: boolean) {
  let after = 0;
  for (;;) {
    const drain = await request<{ result: { processed: number } }>("POST", "/api/worker/drain-once", {});
    if (follow) after = await printEvents(taskId, after);

    const task = await request<{ task: { status: string; error?: string } }>("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.task.status)) {
      if (follow) await printEvents(taskId, after);
      if (task.task.status !== "succeeded") throw new Error(`task ${taskId} ${task.task.status}: ${task.task.error ?? ""}`);
      return;
    }

    if (drain.result.processed === 0) await sleep(1000);
  }
}

async function followEvents(taskId: string) {
  let after = 0;
  let emptyPolls = 0;
  while (emptyPolls < 300) {
    const next = await printEvents(taskId, after);
    if (next === after) {
      emptyPolls += 1;
      await sleep(1000);
    } else {
      emptyPolls = 0;
      after = next;
    }
  }
}

async function printEvents(taskId: string, after: number) {
  const response = await request<{ events: Event[] }>(
    "GET",
    `/api/events?taskId=${encodeURIComponent(taskId)}&after=${after}&limit=100`,
  );
  for (const event of response.events) {
    after = Math.max(after, event.seq);
    if (event.type === "command.stdout" || event.type === "command.stderr") {
      process.stdout.write(String(event.data?.stdout ?? event.data?.stderr ?? ""));
      continue;
    }
    console.log(`[${event.seq}] ${event.source}:${event.type} ${JSON.stringify(event.data ?? {})}`);
  }
  return after;
}

async function inputs(args: Args) {
  const files = [];
  for (const entry of values(args, "file")) {
    const index = entry.indexOf("=");
    const source = index === -1 ? entry : entry.slice(0, index);
    const target = index === -1 ? entry : entry.slice(index + 1);
    files.push({ path: target, content: await fs.readFile(source, "utf8") });
  }
  return files.length ? { files } : undefined;
}

async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `${method} ${path} failed with ${response.status}`);
  return json;
}

type Args = Record<string, string[]> & { _: string[] };

function parseArgs(argv: string[]): Args {
  const parsed: Args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "drain" || key === "follow") {
      parsed[key] = ["true"];
      continue;
    }
    const next = argv[i + 1];
    if (!next) throw new Error(`missing value for --${key}`);
    parsed[key] = [...(parsed[key] ?? []), next];
    i += 1;
  }
  return parsed;
}

function apiUrl(args: Args) {
  const url = value(args, "api-url")
    ?? process.env.THREADBEAT_API_URL
    ?? process.env.RAILWAY_THREADBEAT_URL
    ?? railwayUrl();
  if (!url) {
    throw new Error("Set --api-url, THREADBEAT_API_URL, RAILWAY_THREADBEAT_URL, or RAILWAY_PUBLIC_DOMAIN.");
  }
  return url.replace(/\/$/, "");
}

function railwayUrl() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN ?? process.env.RAILWAY_STATIC_URL;
  if (!domain) return undefined;
  return domain.startsWith("http") ? domain : `https://${domain}`;
}

function value(args: Args, name: string) {
  return args[name]?.at(-1);
}

function values(args: Args, name: string) {
  return args[name] ?? [];
}

function flag(args: Args, name: string) {
  return value(args, name) === "true";
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
