import assert from "node:assert/strict";

import { createApp } from "../src/api/app.js";
import { close } from "../src/db/client.js";

const app = createApp();

try {
  const agent = {
    id: `heartbeat-smoke-${Date.now()}`,
    name: "heartbeat smoke agent",
    repoUrl: "https://github.com/snbafana/threadbeat-research-agent-harness.git",
    defaultBranch: "main",
  };

  const createAgent = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: agent,
  });
  assert.equal(createAgent.statusCode, 200, createAgent.body);

  const prompt = "Run one research heartbeat tick and report the best next search.";
  const createHeartbeat = await app.inject({
    method: "POST",
    url: `/api/agents/${agent.id}/heartbeats`,
    payload: {
      title: "research heartbeat smoke",
      cadenceSeconds: 60,
      prompt,
      nextTickAt: new Date(Date.now() - 1000).toISOString(),
      inputs: {
        files: [{
          path: "heartbeat.md",
          content: "seed context",
        }],
      },
    },
  });
  assert.equal(createHeartbeat.statusCode, 200, createHeartbeat.body);
  const heartbeat = createHeartbeat.json<{ heartbeat: { id: string; spec: { ask: string } } }>().heartbeat;
  assert.equal(heartbeat.spec.ask, prompt);

  const drain = await app.inject({
    method: "POST",
    url: "/api/heartbeats/drain-due",
    payload: { limit: 1 },
  });
  assert.equal(drain.statusCode, 200, drain.body);
  const result = drain.json<{ result: { processed: number; created: Array<{ heartbeatId: string; taskId: string }> } }>().result;
  assert.equal(result.processed, 1);
  assert.equal(result.created[0]?.heartbeatId, heartbeat.id);

  const taskId = result.created[0]?.taskId;
  assert.ok(taskId, "heartbeat should create a task");

  const taskResponse = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
  assert.equal(taskResponse.statusCode, 200, taskResponse.body);
  const task = taskResponse.json<{ task: { agentId: string; status: string; spec: { ask: string } } }>().task;
  assert.equal(task.agentId, agent.id);
  assert.equal(task.status, "queued");
  assert.equal(task.spec.ask, prompt);

  const eventsResponse = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}` });
  assert.equal(eventsResponse.statusCode, 200, eventsResponse.body);
  const events = eventsResponse.json<{ events: Array<{ type: string; source: string }> }>().events;
  assert.ok(events.some((event) => event.type === "task.created" && event.source === `heartbeat:${heartbeat.id}`));

  const heartbeatResponse = await app.inject({ method: "GET", url: `/api/heartbeats/${heartbeat.id}` });
  assert.equal(heartbeatResponse.statusCode, 200, heartbeatResponse.body);
  const updated = heartbeatResponse.json<{ heartbeat: { lastTickAt?: string; nextTickAt: string } }>().heartbeat;
  assert.ok(updated.lastTickAt, "heartbeat should record lastTickAt");
  assert.ok(new Date(updated.nextTickAt).getTime() > Date.now(), "heartbeat should advance nextTickAt");

  const secondDrain = await app.inject({
    method: "POST",
    url: "/api/heartbeats/drain-due",
    payload: { limit: 1 },
  });
  assert.equal(secondDrain.statusCode, 200, secondDrain.body);
  assert.equal(secondDrain.json<{ result: { processed: number } }>().result.processed, 0);

  console.log(JSON.stringify({ ok: true, heartbeatId: heartbeat.id, taskId }, null, 2));
} finally {
  await app.close();
  await close();
}
