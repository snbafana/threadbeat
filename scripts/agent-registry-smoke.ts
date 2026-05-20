import assert from "node:assert/strict";

import { close } from "../src/db/client.js";
import { createApp } from "../src/api/app.js";

const app = createApp();

try {
  const payload = {
    id: `agent-smoke-${Date.now()}`,
    name: "agent registry smoke",
    repoUrl: "https://github.com/snbafana/threadbeat.git",
    defaultBranch: "main",
  };

  const create = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload,
  });
  assert.equal(create.statusCode, 200, create.body);
  assert.deepEqual(create.json<{ agent: typeof payload }>().agent, payload);

  const get = await app.inject({ method: "GET", url: `/api/agents/${payload.id}` });
  assert.equal(get.statusCode, 200, get.body);
  assert.deepEqual(get.json<{ agent: typeof payload }>().agent, payload);

  const list = await app.inject({ method: "GET", url: "/api/agents" });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(
    list.json<{ agents: typeof payload[] }>().agents.some((agent) => agent.id === payload.id),
    "created agent should be listed",
  );

  const bad = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: { name: "missing repo" },
  });
  assert.equal(bad.statusCode, 400, bad.body);

  const missing = await app.inject({ method: "GET", url: "/api/agents/not-found" });
  assert.equal(missing.statusCode, 404, missing.body);

  console.log(JSON.stringify({ ok: true, agent: payload }, null, 2));
} finally {
  await app.close();
  await close();
}
