import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-smoke-"));
await fs.mkdir(path.join(tempRoot, "contents"), { recursive: true });
await fs.writeFile(path.join(tempRoot, "contents", "default.md"), "# Smoke\n\nCheck the loop.");

const settings: Settings = {
  projectRoot: path.resolve("."),
  repoRoot: tempRoot,
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  dbAuthToken: undefined,
  pollSeconds: 3600,
  maxDuePerPoll: 5,
  piDryRun: true,
  piProvider: "deepseek",
  piModel: "deepseek-v4-flash",
  piThinking: "off",
  deepseekApiKey: "test",
  port: 0,
};

const { app } = await buildServer(settings);

try {
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().runtime.mode, "dry-run");

  const sessionRes = await app.inject({
    method: "POST",
    url: "/api/sessions",
    payload: { name: "smoke" },
  });
  assert.equal(sessionRes.statusCode, 200);
  const sessionId = sessionRes.json().session.id;

  const invalid = await app.inject({
    method: "POST",
    url: "/api/heartbeats",
    payload: { sessionId, title: "bad", cadence: 10, contents: "nope.txt" },
  });
  assert.equal(invalid.statusCode, 400);

  const heartbeatRes = await app.inject({
    method: "POST",
    url: "/api/heartbeats",
    payload: {
      sessionId,
      title: "smoke heartbeat",
      cadence: 1,
      contents: "contents/default.md",
      status: "active",
    },
  });
  assert.equal(heartbeatRes.statusCode, 200);
  const heartbeatId = heartbeatRes.json().heartbeat.id;

  await app.inject({
    method: "PATCH",
    url: `/api/heartbeats/${heartbeatId}`,
    payload: { cadence: 1 },
  });
  await app.inject({ method: "POST", url: `/api/heartbeats/${heartbeatId}/tick` });
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const due = await app.inject({ method: "GET", url: "/api/heartbeats/due" });
  assert.equal(due.statusCode, 200);
  assert.equal(due.json().heartbeats.length, 1);

  const runOnce = await app.inject({ method: "POST", url: "/api/scheduler/run-once" });
  assert.equal(runOnce.statusCode, 200);
  assert.equal(runOnce.json().processed, 1);

  const runs = await app.inject({ method: "GET", url: "/api/runs" });
  assert.equal(runs.statusCode, 200);
  assert.equal(runs.json().runs.length, 1);
  assert.equal(runs.json().runs[0].status, "succeeded");

  const events = await app.inject({
    method: "GET",
    url: `/api/events?heartbeatId=${heartbeatId}`,
  });
  assert.equal(events.statusCode, 200);
  const eventTypes = events.json().events.map((event: { type: string }) => event.type);
  assert.ok(eventTypes.includes("heartbeat_claimed"));
  assert.ok(eventTypes.includes("run_started"));
  assert.ok(eventTypes.includes("contents_loaded"));
  assert.ok(eventTypes.includes("run_succeeded"));
  assert.ok(eventTypes.includes("heartbeat_rescheduled"));

  const runtime = await app.inject({ method: "POST", url: "/api/runtime/pi/reset" });
  assert.equal(runtime.statusCode, 200);
  assert.equal(runtime.json().runtime.running, true);
} finally {
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
