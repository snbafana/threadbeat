import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { close } from "../src/store/db.js";

const app = createApp();

try {
  const agentId = `heartbeat-crud-agent-${Date.now()}`;
  const createAgent = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      id: agentId,
      name: "heartbeat crud smoke",
      repoUrl: "https://github.com/snbafana/threadbeat.git",
      defaultBranch: "main",
    },
  });
  assert.equal(createAgent.statusCode, 200, createAgent.body);

  const createHeartbeat = await app.inject({
    method: "POST",
    url: "/api/heartbeats",
    payload: {
      agentId,
      title: "daily finance heartbeat",
      cadenceSeconds: 60,
      specJson: {
        ask: "Create finance graphs for AAPL, MSFT, NVDA, and SPY.",
        inputs: {
          files: [
            {
              path: ".threadbeat/symbols.txt",
              content: "AAPL\nMSFT\nNVDA\nSPY\n",
            },
          ],
        },
      },
    },
  });
  assert.equal(createHeartbeat.statusCode, 200, createHeartbeat.body);
  const heartbeat = createHeartbeat.json<{
    heartbeat: { id: string; agentId: string; title: string; cadenceSeconds: number; status: string; spec: { ask: string }; nextTickAt?: string };
  }>().heartbeat;
  assert.equal(heartbeat.agentId, agentId);
  assert.equal(heartbeat.title, "daily finance heartbeat");
  assert.equal(heartbeat.cadenceSeconds, 60);
  assert.equal(heartbeat.status, "active");
  assert.equal(heartbeat.spec.ask, "Create finance graphs for AAPL, MSFT, NVDA, and SPY.");
  assert.ok(heartbeat.nextTickAt);

  const list = await app.inject({ method: "GET", url: `/api/heartbeats?agentId=${encodeURIComponent(agentId)}` });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json<{ heartbeats: unknown[] }>().heartbeats.length, 1);

  const get = await app.inject({ method: "GET", url: `/api/heartbeats/${heartbeat.id}` });
  assert.equal(get.statusCode, 200, get.body);

  const deleted = await app.inject({ method: "DELETE", url: `/api/heartbeats/${heartbeat.id}` });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(deleted.json<{ heartbeat: { id: string } }>().heartbeat.id, heartbeat.id);

  const missing = await app.inject({ method: "GET", url: `/api/heartbeats/${heartbeat.id}` });
  assert.equal(missing.statusCode, 404, missing.body);

  console.log(JSON.stringify({ ok: true, agentId, heartbeatId: heartbeat.id }, null, 2));
} finally {
  await app.close();
  await close();
}
