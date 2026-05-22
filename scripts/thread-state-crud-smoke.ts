import assert from "node:assert/strict";

import { createApp } from "../src/api/app.js";
import { close } from "../src/db/client.js";

const app = createApp();

try {
  const agent = {
    id: `thread-agent-${Date.now()}`,
    name: "thread state smoke agent",
    repoUrl: "https://github.com/snbafana/threadbeat-research-agent-harness.git",
    defaultBranch: "main",
  };
  const createAgent = await app.inject({ method: "POST", url: "/api/agents", payload: agent });
  assert.equal(createAgent.statusCode, 200, createAgent.body);

  const createThread = await app.inject({
    method: "POST",
    url: "/api/threads",
    payload: {
      title: "thread state smoke",
      agentId: agent.id,
      goalJson: {
        text: "prove durable thread state CRUD",
        mode: "smoke",
      },
    },
  });
  assert.equal(createThread.statusCode, 200, createThread.body);
  const thread = createThread.json<{ thread: { id: string; status: string; goal: { text: string } } }>().thread;
  assert.equal(thread.status, "queued");
  assert.equal(thread.goal.text, "prove durable thread state CRUD");

  const messagePayload = { role: "human", contentJson: { text: "start from the smoke seed" } };
  const createMessage = await app.inject({
    method: "POST",
    url: `/api/threads/${thread.id}/messages`,
    payload: messagePayload,
  });
  assert.equal(createMessage.statusCode, 200, createMessage.body);
  const message = createMessage.json<{ message: { id: string; content: { text: string } } }>().message;
  assert.equal(message.content.text, messagePayload.contentJson.text);

  const firstSandbox = await app.inject({
    method: "POST",
    url: `/api/threads/${thread.id}/sandboxes`,
    payload: {
      provider: "daytona",
      externalId: `sandbox-${Date.now()}-1`,
      idleExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.equal(firstSandbox.statusCode, 200, firstSandbox.body);
  assert.equal(firstSandbox.json<{ sandbox: { index: number } }>().sandbox.index, 1);

  const secondSandbox = await app.inject({
    method: "POST",
    url: `/api/threads/${thread.id}/sandboxes`,
    payload: {
      provider: "daytona",
      externalId: `sandbox-${Date.now()}-2`,
    },
  });
  assert.equal(secondSandbox.statusCode, 200, secondSandbox.body);
  const currentSandbox = secondSandbox.json<{ sandbox: { id: string; index: number } }>().sandbox;
  assert.equal(currentSandbox.index, 2);

  const listSandboxes = await app.inject({ method: "GET", url: `/api/threads/${thread.id}/sandboxes` });
  assert.equal(listSandboxes.statusCode, 200, listSandboxes.body);
  const sandboxList = listSandboxes.json<{ sandboxes: Array<{ index: number }>; current: { id: string; index: number } }>();
  assert.deepEqual(sandboxList.sandboxes.map((sandbox) => sandbox.index), [1, 2]);
  assert.equal(sandboxList.current.id, currentSandbox.id);

  const createArtifact = await app.inject({
    method: "POST",
    url: `/api/threads/${thread.id}/artifacts`,
    payload: {
      kind: "trace",
      uri: `r2://threadbeat-smoke/${thread.id}/trace.jsonl`,
      contentType: "application/jsonl",
      sizeBytes: 128,
      summaryJson: { rows: 2 },
    },
  });
  assert.equal(createArtifact.statusCode, 200, createArtifact.body);

  const heartbeat = await app.inject({
    method: "POST",
    url: `/api/threads/${thread.id}/heartbeats`,
    payload: {
      title: "thread heartbeat",
      cadenceSeconds: 60,
      messageJson: { text: "continue the thread smoke" },
      nextTickAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(heartbeat.statusCode, 200, heartbeat.body);
  const heartbeatId = heartbeat.json<{ heartbeat: { id: string } }>().heartbeat.id;

  const drain = await app.inject({ method: "POST", url: "/api/heartbeats/drain-due", payload: { limit: 50 } });
  assert.equal(drain.statusCode, 200, drain.body);
  const drained = drain.json<{ result: { processed: number; messages: Array<{ heartbeatId: string; messageId: string }> } }>().result;
  assert.ok(drained.processed >= 1);
  assert.ok(
    drained.messages.some((item) => item.heartbeatId === heartbeatId),
    `expected drain to process heartbeat ${heartbeatId}`,
  );

  const messages = await app.inject({ method: "GET", url: `/api/threads/${thread.id}/messages` });
  assert.equal(messages.statusCode, 200, messages.body);
  assert.deepEqual(
    messages.json<{ messages: Array<{ role: string; content: { text: string } }> }>().messages.map((item) => [item.role, item.content.text]),
    [["human", "start from the smoke seed"], ["heartbeat", "continue the thread smoke"]],
  );

  const events = await app.inject({ method: "GET", url: `/api/events?threadId=${thread.id}` });
  assert.equal(events.statusCode, 200, events.body);
  assert.ok(
    events.json<{ events: Array<{ type: string; source: string }> }>().events.some((event) => (
      event.type === "message.created" && event.source === `heartbeat:${heartbeatId}`
    )),
    "heartbeat drain should emit a thread message event",
  );

  console.log(JSON.stringify({ ok: true, threadId: thread.id, heartbeatId }, null, 2));
} finally {
  await app.close();
  await close();
}
