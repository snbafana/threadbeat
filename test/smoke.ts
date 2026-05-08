import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import "./agentGitStore.test.js";
import "./agentLocalE2E.test.js";
import "./agentLocal.test.js";
import "./agentService.js";
import "./db-agents.js";
import { PiSharedSessionRuntime } from "../src/piRuntime.js";
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
  runTimeoutMs: 300_000,
  piDryRun: true,
  piDryRunDelayMs: 0,
  piProvider: "deepseek",
  piModel: "deepseek-v4-flash",
  piThinking: "off",
  deepseekApiKey: "test",
  logRequests: true,
  port: 0,
};

const { app } = await buildServer(settings);

try {
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().runtime.mode, "dry-run");
  assert.equal(health.json().runtime.queueDepth, 0);
  assert.equal(health.json().runtime.activeRun, null);
  assert.equal(health.json().runtime.lastRun, null);

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
  assert.equal(heartbeatRes.json().heartbeat.provider, "deepseek");
  assert.equal(heartbeatRes.json().heartbeat.model, "deepseek-v4-flash");

  await app.inject({
    method: "PATCH",
    url: `/api/heartbeats/${heartbeatId}`,
    payload: { cadence: 1, model: "deepseek-smoke-model" },
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
  assert.equal(runs.json().runs[0].model, "deepseek/deepseek-smoke-model");

  const runtimeAfterRun = await app.inject({ method: "GET", url: "/api/runtime/pi" });
  assert.equal(runtimeAfterRun.statusCode, 200);
  assert.equal(runtimeAfterRun.json().runtime.queueDepth, 0);
  assert.equal(runtimeAfterRun.json().runtime.runTimeoutMs, 300_000);
  assert.equal(runtimeAfterRun.json().runtime.activeRun, null);
  assert.equal(runtimeAfterRun.json().runtime.lastRun.heartbeatId, heartbeatId);
  assert.equal(runtimeAfterRun.json().runtime.lastRun.status, "succeeded");
  assert.equal(typeof runtimeAfterRun.json().runtime.lastRun.durationMs, "number");

  const streamRes = await app.inject({
    method: "POST",
    url: "/api/runtime/pi/message/stream",
    payload: { message: "stream smoke" },
  });
  assert.equal(streamRes.statusCode, 200);
  const streamEvents = streamRes
    .body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; text?: string; memoryMode?: string });
  assert.deepEqual(streamEvents.map((event) => event.type), ["start", "delta", "done"]);
  assert.equal(streamEvents[0].memoryMode, "shared");
  assert.match(streamEvents[1].text ?? "", /server-side Pi SDK/);

  const statelessStreamRes = await app.inject({
    method: "POST",
    url: "/api/runtime/pi/message/stream",
    payload: { message: "stateless stream smoke", memoryMode: "stateless" },
  });
  assert.equal(statelessStreamRes.statusCode, 200);
  const statelessEvents = statelessStreamRes
    .body
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; text?: string; memoryMode?: string });
  assert.deepEqual(statelessEvents.map((event) => event.type), ["start", "delta", "done"]);
  assert.equal(statelessEvents[0].memoryMode, "stateless");
  assert.match(statelessEvents[1].text ?? "", /stateless server-side Pi SDK/);

  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  const listenerEventsPromise = collectListenerEvents(baseUrl, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const broadcastSend = await fetch(`${baseUrl}/api/runtime/pi/message/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "listener smoke" }),
  });
  assert.equal(broadcastSend.status, 200);
  await broadcastSend.text();
  const listenerEvents = await listenerEventsPromise;
  assert.deepEqual(listenerEvents.map((event) => event.type), [
    "listener_connected",
    "message_started",
    "message_delta",
    "message_done",
  ]);
  assert.match(listenerEvents[2].text ?? "", /server-side Pi SDK/);

  const heartbeatListenerEventsPromise = collectListenerEvents(baseUrl, 5_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const broadcastHeartbeatRun = await app.inject({
    method: "POST",
    url: `/api/heartbeats/${heartbeatId}/run-now`,
    payload: { preserveCadence: true },
  });
  assert.equal(broadcastHeartbeatRun.statusCode, 200);
  const heartbeatListenerEvents = await heartbeatListenerEventsPromise;
  assert.deepEqual(heartbeatListenerEvents.map((event) => event.type), [
    "listener_connected",
    "message_started",
    "message_delta",
    "message_done",
  ]);
  assert.equal(heartbeatListenerEvents[1].source, "heartbeat");
  assert.equal(heartbeatListenerEvents[1].heartbeatId, heartbeatId);
  assert.match(heartbeatListenerEvents[2].text ?? "", /heartbeat_id/);

  const inactiveRes = await app.inject({
    method: "PATCH",
    url: `/api/heartbeats/${heartbeatId}`,
    payload: { status: "inactive" },
  });
  assert.equal(inactiveRes.statusCode, 200);

  const resumeRes = await app.inject({ method: "POST", url: `/api/heartbeats/${heartbeatId}/resume` });
  assert.equal(resumeRes.statusCode, 200);
  assert.equal(resumeRes.json().heartbeat.status, "active");

  const pauseRes = await app.inject({ method: "POST", url: `/api/heartbeats/${heartbeatId}/pause` });
  assert.equal(pauseRes.statusCode, 200);
  assert.equal(pauseRes.json().heartbeat.status, "inactive");

  const runNowRes = await app.inject({ method: "POST", url: `/api/heartbeats/${heartbeatId}/run-now` });
  assert.equal(runNowRes.statusCode, 200);
  assert.equal(runNowRes.json().run.status, "succeeded");
  assert.equal(runNowRes.json().heartbeat.status, "inactive");

  const preserveResumeRes = await app.inject({ method: "POST", url: `/api/heartbeats/${heartbeatId}/resume` });
  assert.equal(preserveResumeRes.statusCode, 200);
  const preserveBefore = preserveResumeRes.json().heartbeat;
  const preserveRunNowRes = await app.inject({
    method: "POST",
    url: `/api/heartbeats/${heartbeatId}/run-now`,
    payload: { preserveCadence: true },
  });
  assert.equal(preserveRunNowRes.statusCode, 200);
  assert.equal(preserveRunNowRes.json().run.status, "succeeded");
  assert.equal(preserveRunNowRes.json().heartbeat.next_tick, preserveBefore.next_tick);
  assert.equal(preserveRunNowRes.json().heartbeat.last_tick, preserveBefore.last_tick);
  const preservePauseRes = await app.inject({ method: "POST", url: `/api/heartbeats/${heartbeatId}/pause` });
  assert.equal(preservePauseRes.statusCode, 200);

  const missingContentsRes = await app.inject({
    method: "POST",
    url: "/api/heartbeats",
    payload: {
      sessionId,
      title: "missing markdown heartbeat",
      cadence: 1,
      contents: "contents/missing.md",
      provider: "deepseek",
      model: "deepseek-failure-model",
      status: "active",
    },
  });
  assert.equal(missingContentsRes.statusCode, 200);
  const missingHeartbeatId = missingContentsRes.json().heartbeat.id;

  await app.inject({ method: "POST", url: `/api/heartbeats/${missingHeartbeatId}/tick` });
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const failedRunOnce = await app.inject({ method: "POST", url: "/api/scheduler/run-once" });
  assert.equal(failedRunOnce.statusCode, 200);
  assert.equal(failedRunOnce.json().processed, 1);

  const failedRuns = await app.inject({
    method: "GET",
    url: `/api/runs?heartbeatId=${missingHeartbeatId}`,
  });
  assert.equal(failedRuns.statusCode, 200);
  assert.equal(failedRuns.json().runs.length, 1);
  assert.equal(failedRuns.json().runs[0].status, "failed");
  assert.match(failedRuns.json().runs[0].error, /missing\.md/);

  const rescheduledMissing = await app.inject({
    method: "GET",
    url: `/api/heartbeats/${missingHeartbeatId}`,
  });
  assert.equal(rescheduledMissing.statusCode, 200);
  assert.equal(typeof rescheduledMissing.json().heartbeat.last_tick, "string");
  assert.equal(typeof rescheduledMissing.json().heartbeat.next_tick, "string");

  const failedEvents = await app.inject({
    method: "GET",
    url: `/api/events?heartbeatId=${missingHeartbeatId}`,
  });
  assert.equal(failedEvents.statusCode, 200);
  const failedEventTypes = failedEvents.json().events.map((event: { type: string }) => event.type);
  assert.ok(failedEventTypes.includes("heartbeat_claimed"));
  assert.ok(failedEventTypes.includes("run_started"));
  assert.ok(failedEventTypes.includes("run_failed"));
  assert.ok(failedEventTypes.includes("heartbeat_rescheduled"));

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
  assert.equal(runtime.json().runtime.resetCount, 1);
  const runtimeEvents = await app.inject({
    method: "GET",
    url: "/api/events?limit=20",
  });
  assert.equal(runtimeEvents.statusCode, 200);
  const runtimeEventTypes = runtimeEvents
    .json()
    .events.filter((event: { source: string }) => event.source === "runtime")
    .map((event: { type: string }) => event.type);
  assert.ok(runtimeEventTypes.includes("runtime_reset_started"));
  assert.ok(runtimeEventTypes.includes("runtime_reset_completed"));

  const timeoutLifecycleEvents: string[] = [];
  const timeoutRuntime = new PiSharedSessionRuntime({
    ...settings,
    runTimeoutMs: 10,
    piDryRunDelayMs: 50,
  }, async (event) => {
    timeoutLifecycleEvents.push(event.type);
  });
  await assert.rejects(
    timeoutRuntime.run("slow dry-run prompt", "hb_timeout"),
    /timed out after 10ms/,
  );
  const timeoutStatus = timeoutRuntime.status();
  assert.equal(timeoutStatus.lastRun?.heartbeatId, "hb_timeout");
  assert.equal(timeoutStatus.lastRun?.status, "failed");
  assert.equal(timeoutStatus.resetCount, 1);
  assert.equal(timeoutStatus.running, true);
  assert.match(timeoutStatus.lastError ?? "", /timed out after 10ms/);
  assert.deepEqual(timeoutLifecycleEvents, [
    "runtime_reset_started",
    "runtime_reset_completed",
  ]);
} finally {
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

type ListenerEvent = { type: string; text?: string; source?: string; heartbeatId?: string };

async function collectListenerEvents(baseUrl: string, timeoutMs: number): Promise<ListenerEvent[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events: ListenerEvent[] = [];
  try {
    const response = await fetch(`${baseUrl}/api/runtime/pi/messages/listen?limit=4`, {
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return events;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ListenerEvent;
        events.push(event);
        if (event.type === "message_done") {
          await reader.cancel();
          return events;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
