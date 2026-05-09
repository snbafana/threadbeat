import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Settings } from "../src/config.js";
import { Database } from "../src/db.js";
import { createSandboxProvider } from "../src/modalProvider.js";
import { MessageBus } from "../src/messageBus.js";
import { SandboxService } from "../src/sandboxService.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-bootstrap-smoke-"));

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-bootstrap-smoke",
  modalImage: "python:3.13-slim",
};

const db = new Database(settings.dbUrl, path.join(settings.projectRoot, "schema", "bootstrap.sql"));

try {
  await db.initSchema();
  const service = new SandboxService(db, createSandboxProvider(settings), new MessageBus());
  const agent = await db.createAgent({
    name: "bootstrap-smoke-agent",
    repoUrl: "https://github.com/example/agent.git",
    defaultBranch: "main",
  });

  const sandbox = await service.startForAgent(agent);
  const { results } = await service.bootstrap(sandbox);

  assert.deepEqual(
    results.map((result) => result.command.join(" ")),
    [
      "mkdir -p /workspace",
      "sh -lc command -v git >/dev/null || (apt-get update && apt-get install -y git)",
      "git clone -- https://github.com/example/agent.git /workspace/agent",
      "git -C /workspace/agent checkout main",
      "git -C /workspace/agent status --short --branch",
    ],
  );
  assert.ok(results.every((result) => result.exitCode === 0));

  const messages = await db.listMessages({ sandboxId: sandbox.id, limit: 100 });
  assert.ok(messages.some((message) => message.type === "bootstrap_started"));
  assert.ok(messages.some((message) => message.type === "bootstrap_completed"));
  assert.ok(messages.some((message) => message.type === "exec_completed" && message.text?.includes("git clone")));
} finally {
  await db.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
