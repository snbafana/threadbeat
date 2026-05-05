import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = process.argv.slice(2);

const dryRun = process.env.THREADBEAT_DRY_RUN === "1" || args.includes("--dry-run");
const heartbeatIdArgIndex = args.indexOf("--heartbeat-id");
const heartbeatId =
  heartbeatIdArgIndex >= 0 && args[heartbeatIdArgIndex + 1]
    ? args[heartbeatIdArgIndex + 1]
    : null;

const baseUrl =
  process.env.THREADBEAT_BASE_URL ??
  "https://threadbeat-control-plane.snbafana.workers.dev";
const provider = process.env.THREADBEAT_PI_PROVIDER ?? "deepseek";
const model = process.env.THREADBEAT_PI_MODEL ?? "deepseek-v4-flash";
const thinking = process.env.THREADBEAT_PI_THINKING ?? "off";
const limit = Number(process.env.THREADBEAT_LIMIT ?? "5");

function usage() {
  console.error(
    "Usage: node scripts/run-due-heartbeats.mjs [--dry-run] [--heartbeat-id <hb_id>]",
  );
}

if (args.includes("--help")) {
  usage();
  process.exit(0);
}

async function api(method, route, body) {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    headers: {
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data.ok === false) {
    throw new Error(`${method} ${route} failed: ${data.error ?? response.status}`);
  }
  return data;
}

function buildPrompt(heartbeat, markdown) {
  return [
    "# Threadbeat heartbeat",
    "",
    `heartbeat_id: ${heartbeat.id}`,
    `session_id: ${heartbeat.session_id}`,
    `title: ${heartbeat.title}`,
    `cadence_seconds: ${heartbeat.cadence}`,
    `contents_path: ${heartbeat.contents}`,
    `last_tick: ${heartbeat.last_tick ?? "null"}`,
    `next_tick: ${heartbeat.next_tick ?? "null"}`,
    `now: ${new Date().toISOString()}`,
    "",
    "Read the markdown contents below and execute this heartbeat.",
    "Return a concise note with:",
    "1. what you observed",
    "2. the next action",
    "3. any stake or state update worth carrying forward",
    "",
    "## Markdown contents",
    "",
    markdown,
  ].join("\n");
}

async function runPi(prompt) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "pi",
      [
        "--provider",
        provider,
        "--model",
        model,
        "--thinking",
        thinking,
        "--print",
        "--no-session",
        "--no-tools",
        "--mode",
        "text",
        "--system-prompt",
        "You are a server-side heartbeat executor for threadbeat. Execute the heartbeat faithfully and return a compact, high-signal result.",
        prompt,
      ],
      {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `pi exited with code ${code}`));
      }
    });
  });
}

async function loadTargets() {
  if (heartbeatId) {
    const { heartbeat } = await api("GET", `/api/heartbeats/${heartbeatId}`);
    return [heartbeat];
  }

  const { heartbeats } = await api("GET", "/api/heartbeats/due");
  return heartbeats.slice(0, limit);
}

async function executeHeartbeat(heartbeat) {
  const contentsPath = path.resolve(repoRoot, heartbeat.contents);
  const markdown = await readFile(contentsPath, "utf8");
  const promptSnapshot = buildPrompt(heartbeat, markdown);

  if (dryRun) {
    const output = [
      "[dry-run]",
      `title: ${heartbeat.title}`,
      `contents: ${heartbeat.contents}`,
      `executed_at: ${new Date().toISOString()}`,
    ].join("\n");

    await api("POST", "/api/runs", {
      heartbeatId: heartbeat.id,
      executor: "pi-deepseek",
      model,
      status: "succeeded",
      promptSnapshot,
      output,
    });
    await api("POST", `/api/heartbeats/${heartbeat.id}/tick`);
    return { heartbeatId: heartbeat.id, status: "succeeded", dryRun: true };
  }

  try {
    const output = await runPi(promptSnapshot);
    await api("POST", "/api/runs", {
      heartbeatId: heartbeat.id,
      executor: "pi-deepseek",
      model,
      status: "succeeded",
      promptSnapshot,
      output,
    });
    await api("POST", `/api/heartbeats/${heartbeat.id}/tick`);
    return { heartbeatId: heartbeat.id, status: "succeeded" };
  } catch (error) {
    await api("POST", "/api/runs", {
      heartbeatId: heartbeat.id,
      executor: "pi-deepseek",
      model,
      status: "failed",
      promptSnapshot,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      heartbeatId: heartbeat.id,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const targets = await loadTargets();
  if (targets.length === 0) {
    console.log(JSON.stringify({ ok: true, processed: 0, message: "no due heartbeats" }, null, 2));
    return;
  }

  const results = [];
  for (const heartbeat of targets) {
    results.push(await executeHeartbeat(heartbeat));
  }

  console.log(JSON.stringify({ ok: true, processed: results.length, results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
