import "dotenv/config";

const baseUrl = normalizeBaseUrl(
  process.env.THREADBEAT_BASE_URL ??
    process.env.RAILWAY_URL ??
    "https://threadbeat-production.up.railway.app",
);

const [command, subcommand, ...rest] = process.argv.slice(2);

try {
  await main(command, subcommand, rest);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(commandName?: string, subcommandName?: string, args: string[] = []): Promise<void> {
  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    printHelp();
    return;
  }

  if (commandName === "send") {
    const sendArgs = [subcommandName, ...args].filter((value): value is string => Boolean(value));
    const memoryMode = sendArgs.includes("--stateless") ? "stateless" : "shared";
    const message = await messageFromArgs(sendArgs.filter((arg) => arg !== "--stateless"));
    await streamMessage(message, memoryMode);
    return;
  }

  if (commandName === "listen") {
    await listen();
    return;
  }

  if (commandName === "status") {
    const options = parseOptions([subcommandName, ...args].filter((value): value is string => Boolean(value)));
    await printResult(await requestJson("GET", "/api/runtime/pi"), options, "status");
    return;
  }

  if (commandName === "reset") {
    const options = parseOptions([subcommandName, ...args].filter((value): value is string => Boolean(value)));
    await printResult(await requestJson("POST", "/api/runtime/pi/reset"), options, "status");
    return;
  }

  if (commandName === "scheduler" && subcommandName === "run-once") {
    await printJson(await requestJson("POST", "/api/scheduler/run-once"));
    return;
  }

  if (commandName === "sessions") {
    await sessions(subcommandName, args);
    return;
  }

  if (commandName === "heartbeats") {
    await heartbeats(subcommandName, args);
    return;
  }

  if (commandName === "runs") {
    const options = parseOptions([subcommandName, ...args].filter((value): value is string => Boolean(value)));
    const query = options.heartbeat ? `?heartbeatId=${encodeURIComponent(options.heartbeat)}` : "";
    await printQueryResult(`/api/runs${query}`, options, "runs");
    return;
  }

  if (commandName === "events") {
    const options = parseOptions([subcommandName, ...args].filter((value): value is string => Boolean(value)));
    const params = new URLSearchParams();
    if (options.heartbeat) params.set("heartbeatId", options.heartbeat);
    if (options.limit) params.set("limit", options.limit);
    const query = params.size ? `?${params.toString()}` : "";
    await printQueryResult(`/api/events${query}`, options, "events");
    return;
  }

  throw new Error(`unknown command: ${commandName}`);
}

async function sessions(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    await printResult(await requestJson("GET", "/api/sessions"), options, "sessions");
    return;
  }
  if (subcommandName === "create") {
    const name = args.join(" ").trim();
    if (!name) throw new Error("sessions create requires a name");
    await printJson(await requestJson("POST", "/api/sessions", { name }));
    return;
  }
  throw new Error(`unknown sessions command: ${subcommandName}`);
}

async function heartbeats(subcommandName?: string, args: string[] = []): Promise<void> {
  if (!subcommandName || subcommandName === "list") {
    const options = parseOptions(args);
    await printResult(await requestJson("GET", "/api/heartbeats"), options, "heartbeats");
    return;
  }

  if (subcommandName === "due") {
    const options = parseOptions(args);
    await printResult(await requestJson("GET", "/api/heartbeats/due"), options, "heartbeats");
    return;
  }

  if (subcommandName === "get") {
    const id = args[0];
    if (!id) throw new Error("heartbeats get requires an id");
    await printJson(await requestJson("GET", `/api/heartbeats/${encodeURIComponent(id)}`));
    return;
  }

  if (subcommandName === "create") {
    const options = parseOptions(args);
    const payload = {
      sessionId: required(options.session, "--session"),
      title: options.title ?? "heartbeat",
      cadence: Number.parseInt(options.cadence ?? "60", 10),
      contents: required(options.contents, "--contents"),
      provider: options.provider,
      model: options.model,
      status: options.inactive === "1" ? "inactive" : "active",
    };
    await printJson(await requestJson("POST", "/api/heartbeats", payload));
    return;
  }

  if (subcommandName === "patch") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("heartbeats patch requires an id");
    const options = parseOptions(optionArgs);
    const payload: Record<string, unknown> = {};
    if (options.title) payload.title = options.title;
    if (options.cadence) payload.cadence = Number.parseInt(options.cadence, 10);
    if (options.contents) payload.contents = options.contents;
    if (options.provider) payload.provider = options.provider;
    if (options.model) payload.model = options.model;
    if (options.status) payload.status = options.status;
    await printJson(await requestJson("PATCH", `/api/heartbeats/${encodeURIComponent(id)}`, payload));
    return;
  }

  if (subcommandName === "activate" || subcommandName === "deactivate") {
    const id = args[0];
    if (!id) throw new Error(`heartbeats ${subcommandName} requires an id`);
    await printJson(await requestJson("PATCH", `/api/heartbeats/${encodeURIComponent(id)}`, {
      status: subcommandName === "activate" ? "active" : "inactive",
    }));
    return;
  }

  if (subcommandName === "pause" || subcommandName === "resume" || subcommandName === "run-now") {
    const id = args[0];
    if (!id) throw new Error(`heartbeats ${subcommandName} requires an id`);
    await printJson(await requestJson("POST", `/api/heartbeats/${encodeURIComponent(id)}/${subcommandName}`));
    return;
  }

  if (subcommandName === "tick") {
    const id = args[0];
    if (!id) throw new Error("heartbeats tick requires an id");
    await printJson(await requestJson("POST", `/api/heartbeats/${encodeURIComponent(id)}/tick`));
    return;
  }

  if (subcommandName === "runs") {
    const [id, ...optionArgs] = args;
    if (!id) throw new Error("heartbeats runs requires an id");
    const options = parseOptions(optionArgs);
    await printQueryResult(`/api/runs?heartbeatId=${encodeURIComponent(id)}`, options, "runs");
    return;
  }

  throw new Error(`unknown heartbeats command: ${subcommandName}`);
}

function parseOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "inactive" || key === "table" || key === "json" || key === "follow") {
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

async function messageFromArgs(args: string[]): Promise<string> {
  const joined = args.join(" ").trim();
  if (joined) return joined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const message = Buffer.concat(chunks).toString("utf8").trim();
  if (!message) throw new Error("send requires a message argument or stdin");
  return message;
}

async function streamMessage(message: string, memoryMode: "shared" | "stateless"): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runtime/pi/message/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, memoryMode }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`send failed: ${response.status} ${await response.text()}`);
  }

  for await (const event of ndjson(response.body)) {
    if (event.type === "delta") process.stdout.write(event.text);
    if (event.type === "error") process.stderr.write(`\n[error] ${event.error}\n`);
  }
  process.stdout.write("\n");
}

async function listen(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runtime/pi/messages/listen`);
  if (!response.ok || !response.body) {
    throw new Error(`listen failed: ${response.status} ${await response.text()}`);
  }

  for await (const event of ndjson(response.body)) {
    if (event.type === "listener_connected") {
      console.log(`[connected] ${baseUrl}`);
    } else if (event.type === "message_started") {
      console.log(`\n[user:${event.messageId}] ${event.input}`);
      process.stdout.write(`[pi:${event.messageId}] `);
    } else if (event.type === "message_delta") {
      process.stdout.write(event.text);
    } else if (event.type === "message_done") {
      process.stdout.write("\n[done]\n");
    } else if (event.type === "message_error") {
      process.stdout.write(`\n[error] ${event.error}\n`);
    }
  }
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, string>> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as Record<string, string>;
    }
  }
}

async function requestJson(method: string, path: string, payload?: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) throw new Error(body.error ?? `${method} ${path} failed`);
  return body;
}

async function printQueryResult(path: string, options: Record<string, string>, tableKind: TableKind): Promise<void> {
  if (options.follow !== "1") {
    await printResult(await requestJson("GET", path), options, tableKind);
    return;
  }

  const followOptions = { ...options };
  if (followOptions.json !== "1") followOptions.table = "1";
  const pollMs = parsePositiveNumber(followOptions.poll ?? "2", "--poll") * 1000;
  const count = followOptions.count === undefined
    ? Number.POSITIVE_INFINITY
    : parsePositiveNumber(followOptions.count, "--count");

  for (let iteration = 0; iteration < count; iteration += 1) {
    if (iteration > 0) {
      await sleep(pollMs);
      process.stdout.write("\n");
    }
    console.log(`# ${new Date().toISOString()}`);
    await printResult(await requestJson("GET", path), followOptions, tableKind);
  }
}

async function printJson(value: unknown): Promise<void> {
  console.log(JSON.stringify(value, null, 2));
}

async function printResult(value: unknown, options: Record<string, string>, tableKind?: TableKind): Promise<void> {
  if (options.table === "1" && options.json !== "1" && tableKind) {
    printTable(value, tableKind);
    return;
  }
  await printJson(value);
}

type TableKind = "status" | "sessions" | "heartbeats" | "runs" | "events";

function printTable(value: unknown, kind: TableKind): void {
  if (!isRecord(value)) {
    console.log(String(value));
    return;
  }

  if (kind === "status") {
    const runtime = isRecord(value.runtime) ? value.runtime : value;
    printRows([
      ["mode", runtime.mode],
      ["running", runtime.running],
      ["session", runtime.sessionId],
      ["active", runtime.activeRun ? "yes" : "no"],
      ["queue", runtime.queueDepth],
      ["resets", runtime.resetCount],
      ["last_error", runtime.lastError],
    ], ["field", "value"]);
    return;
  }

  const rows = extractRows(value, kind).map((row) => tableRow(row, kind));
  const headers = tableHeaders(kind);
  printRows(rows, headers);
}

function extractRows(value: Record<string, unknown>, kind: TableKind): Record<string, unknown>[] {
  const key = kind === "sessions" ? "sessions" : kind === "heartbeats" ? "heartbeats" : kind;
  const rows = value[key];
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord);
}

function tableHeaders(kind: TableKind): string[] {
  if (kind === "sessions") return ["id", "name", "created"];
  if (kind === "heartbeats") return ["id", "status", "cadence", "next_tick", "title"];
  if (kind === "runs") return ["id", "heartbeat", "status", "model", "created"];
  if (kind === "events") return ["created", "source", "type", "heartbeat", "run"];
  return ["field", "value"];
}

function tableRow(row: Record<string, unknown>, kind: TableKind): unknown[] {
  if (kind === "sessions") return [row.id, row.name, row.created_at];
  if (kind === "heartbeats") return [row.id, row.status, row.cadence, row.next_tick, row.title];
  if (kind === "runs") return [row.id, row.heartbeat_id, row.status, row.model, row.created_at];
  if (kind === "events") return [row.created_at, row.source, row.type, row.heartbeat_id, row.run_id];
  return [];
}

function printRows(rows: unknown[][], headers: string[]): void {
  const stringRows = rows.map((row) => row.map(formatCell));
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...stringRows.map((row) => row[index]?.length ?? 0),
  ));
  console.log(formatLine(headers, widths));
  console.log(formatLine(widths.map((width) => "-".repeat(width)), widths));
  for (const row of stringRows) console.log(formatLine(row, widths));
}

function formatLine(row: string[], widths: number[]): string {
  return row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd();
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, 80);
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePositiveNumber(value: string, name: string): number {
  const numberValue = Number.parseFloat(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return numberValue;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp(): void {
  console.log(`threadbeat CLI -> ${baseUrl}

Messaging:
  npm run cli -- send "message"
  npm run cli -- send --stateless "message"
  npm run cli -- listen
  npm run tui

Runtime:
  npm run cli -- status --table
  npm run cli -- reset
  npm run cli -- scheduler run-once

Sessions:
  npm run cli -- sessions list --table
  npm run cli -- sessions create "name"

Heartbeats:
  npm run cli -- heartbeats list --table
  npm run cli -- heartbeats due --table
  npm run cli -- heartbeats get <id>
  npm run cli -- heartbeats create --session <id> --title "name" --cadence 60 --contents contents/file.md
  npm run cli -- heartbeats patch <id> --cadence 120 --contents contents/file.md
  npm run cli -- heartbeats activate <id>
  npm run cli -- heartbeats deactivate <id>
  npm run cli -- heartbeats pause <id>
  npm run cli -- heartbeats resume <id>
  npm run cli -- heartbeats run-now <id>
  npm run cli -- heartbeats tick <id>
  npm run cli -- heartbeats runs <id> --table

Events:
  npm run cli -- runs --heartbeat <id> --table
  npm run cli -- runs --heartbeat <id> --follow --poll 2
  npm run cli -- events --heartbeat <id> --limit 20 --table
  npm run cli -- events --heartbeat <id> --limit 20 --follow --poll 2

Set THREADBEAT_BASE_URL to target local or hosted servers.
JSON remains the default; pass --table for compact terminal output.
Use --follow on runs/events to poll until stopped; pass --count <n> for bounded checks.
`);
}
