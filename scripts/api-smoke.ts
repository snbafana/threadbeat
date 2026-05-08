import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";
import { boolEnv, intEnv } from "../src/env.js";

type ApiResponse<T> = {
  statusCode: number;
  body: T;
};

type HttpMethod = "GET" | "POST" | "PATCH";

type ApiClient = {
  request<T>(method: HttpMethod, url: string, payload?: Record<string, unknown>): Promise<ApiResponse<T>>;
  close(): Promise<void>;
};

const baseUrl = process.env.THREADBEAT_BASE_URL;
const cadenceSeconds = intEnv("THREADBEAT_API_SMOKE_CADENCE_SECONDS", 1);
const shouldRunHeartbeat = boolEnv("THREADBEAT_API_SMOKE_RUN_HEARTBEAT", true);
const client = baseUrl ? remoteClient(baseUrl) : await localClient();

try {
  const health = await client.request<{ ok: boolean; runtime?: { mode: string } }>("GET", "/health");
  assert.equal(health.statusCode, 200);
  assert.equal(health.body.ok, true);

  const session = await client.request<{ session: { id: string } }>("POST", "/api/sessions", {
    name: `api-smoke-${new Date().toISOString()}`,
  });
  assert.equal(session.statusCode, 200);
  const sessionId = session.body.session.id;

  const heartbeat = await client.request<{ heartbeat: { id: string } }>("POST", "/api/heartbeats", {
    sessionId,
    title: "api smoke heartbeat",
    cadence: cadenceSeconds,
    contents: "contents/hosted-smoke.md",
    status: "active",
  });
  assert.equal(heartbeat.statusCode, 200);
  const heartbeatId = heartbeat.body.heartbeat.id;

  let runCount = 0;
  if (shouldRunHeartbeat) {
    await sleep((cadenceSeconds + 1) * 1000);
    const runOnce = await client.request<{ processed: number }>("POST", "/api/scheduler/run-once");
    assert.equal(runOnce.statusCode, 200);

    const runs = await client.request<{ runs: Array<{ status: string; model: string | null; error: string | null }> }>(
      "GET",
      `/api/runs?heartbeatId=${heartbeatId}`,
    );
    assert.equal(runs.statusCode, 200);
    assert.ok(runs.body.runs.length >= 1, `run-once processed ${runOnce.body.processed}, but no run was recorded`);
    assert.equal(runs.body.runs[0]?.status, "succeeded", runs.body.runs[0]?.error ?? "run did not succeed");
    runCount = runs.body.runs.length;
  }

  const events = await client.request<{ events: Array<{ type: string }> }>(
    "GET",
    `/api/events?heartbeatId=${heartbeatId}`,
  );
  assert.equal(events.statusCode, 200);

  console.log(
    JSON.stringify(
      {
        ok: true,
        target: baseUrl ?? "in-process",
        runtimeMode: health.body.runtime?.mode ?? null,
        sessionId,
        heartbeatId,
        ranHeartbeat: shouldRunHeartbeat,
        runCount,
        eventCount: events.body.events.length,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

function remoteClient(rawBaseUrl: string): ApiClient {
  const normalized = rawBaseUrl.endsWith("/") ? rawBaseUrl : `${rawBaseUrl}/`;
  return {
    async request<T>(
      method: HttpMethod,
      url: string,
      payload?: Record<string, unknown>,
    ): Promise<ApiResponse<T>> {
      const response = await fetch(new URL(url.replace(/^\//, ""), normalized), {
        method,
        headers: payload === undefined ? undefined : { "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return {
        statusCode: response.status,
        body: (await response.json()) as T,
      };
    },
    async close(): Promise<void> {},
  };
}

async function localClient(): Promise<ApiClient> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-api-smoke-"));
  await fs.mkdir(path.join(tempRoot, "contents"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "contents", "hosted-smoke.md"),
    "# API Smoke\n\nExercise one heartbeat through the API.",
  );

  const settings: Settings = {
    projectRoot: path.resolve("."),
    repoRoot: tempRoot,
    dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
    dbAuthToken: undefined,
    pollSeconds: 3600,
    maxDuePerPoll: 5,
    runTimeoutMs: intEnv("THREADBEAT_RUN_TIMEOUT_SECONDS", 300) * 1000,
    piDryRun: boolEnv("THREADBEAT_PI_DRY_RUN", true),
    piDryRunDelayMs: intEnv("THREADBEAT_PI_DRY_RUN_DELAY_MS", 0),
    piProvider: process.env.THREADBEAT_PI_PROVIDER ?? "deepseek",
    piModel: process.env.THREADBEAT_PI_MODEL ?? "deepseek-v4-flash",
    piThinking: (process.env.THREADBEAT_PI_THINKING ?? "off") as Settings["piThinking"],
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    logRequests: boolEnv("THREADBEAT_LOG_REQUESTS", false),
    port: 0,
  };
  const { app } = await buildServer(settings);

  return {
    async request<T>(
      method: HttpMethod,
      url: string,
      payload?: Record<string, unknown>,
    ): Promise<ApiResponse<T>> {
      const response = await app.inject({ method, url, payload });
      return { statusCode: response.statusCode, body: response.json() as T };
    },
    async close(): Promise<void> {
      await app.close();
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
