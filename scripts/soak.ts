import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";

const intEnv = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolEnv = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const projectRoot = path.resolve(".");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-soak-"));
const durationSeconds = intEnv("THREADBEAT_SOAK_SECONDS", 3600);
const cadenceSeconds = intEnv("THREADBEAT_SOAK_CADENCE_SECONDS", 5);
const dryRun = boolEnv("THREADBEAT_PI_DRY_RUN", true);
const keepArtifacts = boolEnv("THREADBEAT_SOAK_KEEP_ARTIFACTS", false);

await fs.mkdir(path.join(tempRoot, "contents"), { recursive: true });
await fs.writeFile(
  path.join(tempRoot, "contents", "soak.md"),
  [
    "# Soak",
    "",
    "Exercise the scheduler, executor, runtime, SQL run log, and event log repeatedly.",
  ].join("\n"),
);

const settings: Settings = {
  projectRoot,
  repoRoot: tempRoot,
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  dbAuthToken: undefined,
  pollSeconds: cadenceSeconds,
  maxDuePerPoll: 1,
  runTimeoutMs: intEnv("THREADBEAT_RUN_TIMEOUT_SECONDS", 300) * 1000,
  piDryRun: dryRun,
  piDryRunDelayMs: intEnv("THREADBEAT_PI_DRY_RUN_DELAY_MS", 0),
  piProvider: process.env.THREADBEAT_PI_PROVIDER ?? "deepseek",
  piModel: process.env.THREADBEAT_PI_MODEL ?? "deepseek-v4-flash",
  piThinking: (process.env.THREADBEAT_PI_THINKING ?? "off") as Settings["piThinking"],
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  logRequests: boolEnv("THREADBEAT_LOG_REQUESTS", false),
  port: 0,
};

const { app, scheduler } = await buildServer(settings);

try {
  scheduler.stop();
  const sessionRes = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { name: "soak" },
  });
  assert.equal(sessionRes.statusCode, 200);
  const sessionId = sessionRes.json().session.id as string;

  const heartbeatRes = await app.inject({
    method: "POST",
    url: "/api/heartbeats",
    payload: {
      sessionId,
      title: "soak heartbeat",
      cadence: cadenceSeconds,
      contents: "contents/soak.md",
      status: "active",
    },
  });
  assert.equal(heartbeatRes.statusCode, 200);
  const heartbeatId = heartbeatRes.json().heartbeat.id as string;

  const startedAt = Date.now();
  const deadline = startedAt + durationSeconds * 1000;
  let iterations = 0;
  let succeeded = 0;
  let failed = 0;

  console.log(
    `threadbeat soak started: duration=${durationSeconds}s cadence=${cadenceSeconds}s dryRun=${dryRun} db=${settings.dbUrl}`,
  );

  while (Date.now() < deadline) {
    await sleep(cadenceSeconds * 1000);
    const runOnce = await app.inject({ method: "POST", url: "/api/scheduler/run-once" });
    assert.equal(runOnce.statusCode, 200);
    iterations += runOnce.json().processed as number;

    const runsRes = await app.inject({
      method: "GET",
      url: `/api/runs?heartbeatId=${heartbeatId}`,
    });
    assert.equal(runsRes.statusCode, 200);
    const runs = runsRes.json().runs as Array<{ status: string }>;
    succeeded = runs.filter((run) => run.status === "succeeded").length;
    failed = runs.filter((run) => run.status === "failed").length;
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `soak progress: elapsed=${elapsedSeconds}s iterations=${iterations} succeeded=${succeeded} failed=${failed}`,
    );
  }

  const eventsRes = await app.inject({
    method: "GET",
    url: `/api/events?heartbeatId=${heartbeatId}&limit=500`,
  });
  assert.equal(eventsRes.statusCode, 200);
  const events = eventsRes.json().events as Array<{ type: string }>;
  assert.ok(events.some((event) => event.type === "run_succeeded"));
  assert.equal(failed, 0);
  assert.ok(succeeded > 0);

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    JSON.stringify(
      {
        ok: true,
        dryRun,
        elapsedSeconds,
        cadenceSeconds,
        iterations,
        succeeded,
        failed,
        events: events.length,
        repoRoot: tempRoot,
        dbUrl: settings.dbUrl,
        artifactsKept: keepArtifacts,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  if (keepArtifacts) {
    console.log(`threadbeat soak artifacts kept at ${tempRoot}`);
  } else {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
