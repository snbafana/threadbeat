import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-smoke-"));

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-smoke",
  modalImage: "python:3.13-slim",
};

const { app } = await buildServer(settings);

try {
  const agentResponse = await app.inject({
    method: "POST",
    url: "/api/agents",
    payload: {
      name: "smoke-agent",
      repoUrl: "https://github.com/example/agent.git",
      defaultBranch: "main",
    },
  });
  assert.equal(agentResponse.statusCode, 200);
  const agentBody = JSON.parse(agentResponse.body) as { agent: { id: string } };

  const sandboxResponse = await app.inject({
    method: "POST",
    url: `/api/agents/${agentBody.agent.id}/sandboxes`,
  });
  assert.equal(sandboxResponse.statusCode, 200);
  const sandboxBody = JSON.parse(sandboxResponse.body) as { sandbox: { id: string; state: string } };
  assert.equal(sandboxBody.sandbox.state, "running");

  const execResponse = await app.inject({
    method: "POST",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}/exec`,
    payload: { command: "pwd" },
  });
  assert.equal(execResponse.statusCode, 200);
  assert.match(execResponse.body, /dry-run/);

  const stopResponse = await app.inject({
    method: "POST",
    url: `/api/sandboxes/${sandboxBody.sandbox.id}/stop`,
  });
  assert.equal(stopResponse.statusCode, 200);
  assert.match(stopResponse.body, /stopped/);

  const messagesResponse = await app.inject({
    method: "GET",
    url: `/api/messages?sandboxId=${sandboxBody.sandbox.id}`,
  });
  assert.equal(messagesResponse.statusCode, 200);
  assert.match(messagesResponse.body, /exec_completed/);
} finally {
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
