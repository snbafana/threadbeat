import "dotenv/config";

import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type StreamEvent =
  | { type: "start"; runtime?: { model?: string; sessionId?: string | null; queueDepth?: number } }
  | { type: "delta"; text: string }
  | { type: "done"; text: string }
  | { type: "error"; error: string };

const baseUrl = normalizeBaseUrl(
  process.env.THREADBEAT_BASE_URL ??
    process.env.RAILWAY_URL ??
    "http://127.0.0.1:8000",
);

const rl = readline.createInterface({ input, output });
const scriptedInput = input.isTTY ? null : fs.readFileSync(0, "utf8").split(/\r?\n/);

console.log(`threadbeat TUI -> ${baseUrl}`);
console.log("Type a message. Commands: /help, /status, /reset, /clear, /exit");

try {
  for (;;) {
    const answer = await ask("\nyou > ");
    if (answer === null) break;
    const message = answer.trim();
    if (!message) continue;
    if (message === "/exit" || message === "/quit") break;
    if (message === "/help") {
      printHelp();
      continue;
    }
    if (message === "/clear") {
      console.clear();
      continue;
    }
    if (message === "/status") {
      await printStatus();
      continue;
    }
    if (message === "/reset") {
      await resetRuntime();
      continue;
    }

    await streamMessage(message);
  }
} finally {
  rl.close();
}

function normalizeBaseUrl(raw: string): string {
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function printHelp(): void {
  console.log(`
/help    show commands
/status  show server-side Pi runtime status
/reset   reset the server-side Pi runtime session
/clear   clear this terminal
/exit    quit

Set THREADBEAT_BASE_URL to target another server.
`);
}

async function ask(prompt: string): Promise<string | null> {
  if (scriptedInput) {
    const line = scriptedInput.shift();
    if (line === undefined) return null;
    output.write(prompt);
    output.write(`${line}\n`);
    return line;
  }
  try {
    return await rl.question(prompt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_USE_AFTER_CLOSE") return null;
    throw error;
  }
}

async function printStatus(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runtime/pi`);
  const body = (await response.json()) as { ok: boolean; runtime?: unknown; error?: string };
  if (!response.ok || !body.ok) throw new Error(body.error ?? `status failed: ${response.status}`);
  console.log(JSON.stringify(body.runtime, null, 2));
}

async function resetRuntime(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runtime/pi/reset`, { method: "POST" });
  const body = (await response.json()) as { ok: boolean; runtime?: unknown; error?: string };
  if (!response.ok || !body.ok) throw new Error(body.error ?? `reset failed: ${response.status}`);
  console.log("server-side Pi runtime reset");
}

async function streamMessage(message: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/runtime/pi/message/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`stream failed: ${response.status} ${await response.text()}`);
  }

  output.write("\npi  > ");
  const decoder = new TextDecoder();
  let buffer = "";
  let sawText = false;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as StreamEvent;
      if (event.type === "delta") {
        sawText = true;
        output.write(event.text);
      } else if (event.type === "error") {
        output.write(`\n[error] ${event.error}\n`);
      }
    }
  }

  if (!sawText) output.write("[no streamed text]");
  output.write("\n");
}
