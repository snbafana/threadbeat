import assert from "node:assert/strict";

import { close } from "../src/store/db.js";
import { createApp } from "../src/app.js";

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

  const upsertPayload = {
    ...payload,
    name: "agent registry smoke upserted",
    defaultBranch: "smoke-main",
  };
  const upsert = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: upsertPayload,
  });
  assert.equal(upsert.statusCode, 200, upsert.body);
  assert.deepEqual(upsert.json<{ agent: typeof upsertPayload }>().agent, upsertPayload);

  const updatePayload = {
    name: "agent registry smoke updated",
    repoUrl: "https://github.com/snbafana/threadbeat-agent.git",
    defaultBranch: "main",
  };
  const update = await app.inject({
    method: "PUT",
    url: `/api/agents/${payload.id}`,
    payload: updatePayload,
  });
  assert.equal(update.statusCode, 200, update.body);
  assert.deepEqual(update.json<{ agent: typeof payload }>().agent, {
    id: payload.id,
    ...updatePayload,
  });

  const get = await app.inject({ method: "GET", url: `/api/agents/${payload.id}` });
  assert.equal(get.statusCode, 200, get.body);
  assert.deepEqual(get.json<{ agent: typeof payload }>().agent, {
    id: payload.id,
    ...updatePayload,
  });

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

  const emptyUpdate = await app.inject({
    method: "PUT",
    url: `/api/agents/${payload.id}`,
    payload: {},
  });
  assert.equal(emptyUpdate.statusCode, 400, emptyUpdate.body);

  const missing = await app.inject({ method: "GET", url: "/api/agents/not-found" });
  assert.equal(missing.statusCode, 404, missing.body);

  const missingUpdate = await app.inject({
    method: "PUT",
    url: "/api/agents/not-found",
    payload: updatePayload,
  });
  assert.equal(missingUpdate.statusCode, 404, missingUpdate.body);

  const deleted = await app.inject({ method: "DELETE", url: `/api/agents/${payload.id}` });
  assert.equal(deleted.statusCode, 200, deleted.body);

  const deletedGet = await app.inject({ method: "GET", url: `/api/agents/${payload.id}` });
  assert.equal(deletedGet.statusCode, 404, deletedGet.body);

  const missingDelete = await app.inject({ method: "DELETE", url: "/api/agents/not-found" });
  assert.equal(missingDelete.statusCode, 404, missingDelete.body);

  console.log(JSON.stringify({ ok: true, agentId: payload.id }, null, 2));
} finally {
  await app.close();
  await close();
}
