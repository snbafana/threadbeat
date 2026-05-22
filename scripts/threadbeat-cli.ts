import fs from "node:fs/promises";

const baseUrl = process.env.THREADBEAT_API_URL ?? "http://127.0.0.1:8000";

const [command, subcommand, ...args] = process.argv.slice(2);

try {
  if (command === "thread" && subcommand === "create") {
    const file = args[0];
    if (!file) throw new Error("usage: thread create <json-file>");
    await print(await request("POST", "/api/threads", JSON.parse(await fs.readFile(file, "utf8"))));
  } else if (command === "thread" && subcommand === "list") {
    await print(await request("GET", "/api/threads"));
  } else if (command === "thread" && subcommand === "get") {
    const id = args[0];
    if (!id) throw new Error("usage: thread get <id>");
    await print(await request("GET", `/api/threads/${encodeURIComponent(id)}`));
  } else if (command === "message" && subcommand === "append") {
    const [threadId, file] = args;
    if (!threadId || !file) throw new Error("usage: message append <thread-id> <json-file>");
    await print(await request("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, JSON.parse(await fs.readFile(file, "utf8"))));
  } else if (command === "events" && subcommand === "follow") {
    await followEvents(args);
  } else if (command === "worker" && subcommand === "drain-once") {
    await print(await request("POST", "/api/worker/drain-once", {}));
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function followEvents(args: string[]): Promise<void> {
  const threadIndex = args.indexOf("--thread");
  const threadId = threadIndex >= 0 ? args[threadIndex + 1] : undefined;
  if (!threadId) throw new Error("usage: events follow --thread <id>");
  let after = 0;
  let emptyPolls = 0;
  while (emptyPolls < 30) {
    const response = await request<{ events: Array<{ seq: number; type: string; source: string; data?: unknown }> }>(
      "GET",
      `/api/events?threadId=${encodeURIComponent(threadId)}&after=${after}&limit=100`,
    );
    if (response.events.length === 0) {
      emptyPolls += 1;
      await sleep(1000);
      continue;
    }
    emptyPolls = 0;
    for (const event of response.events) {
      after = Math.max(after, event.seq);
      const data = event.data === undefined ? "" : ` ${JSON.stringify(event.data)}`;
      console.log(`[${event.seq}] ${event.source}:${event.type}${data}`);
    }
  }
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

async function print(value: unknown): Promise<void> {
  console.log(JSON.stringify(value, null, 2));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function usage(): void {
  console.log(`Usage:
  npm run cli -- thread create <json-file>
  npm run cli -- thread list
  npm run cli -- thread get <id>
  npm run cli -- message append <thread-id> <json-file>
  npm run cli -- events follow --thread <id>
  npm run cli -- worker drain-once`);
}
