import assert from "node:assert/strict";

import type { Settings } from "../src/config.js";
import { MemoryTaskRepository } from "../src/db.js";
import type { SandboxHandle, SandboxProvider, CommandResult } from "../src/sandboxProvider.js";
import { createApp } from "../src/server.js";
import type { CommandSpec } from "../src/types.js";

const settings: Settings = {
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "memory",
  daytonaApiKey: undefined,
  daytonaApiUrl: undefined,
  daytonaTarget: undefined,
  sandboxEnvAllowlist: [],
  maxSandboxes: 1,
  runTimeoutSeconds: 600,
  commandTimeoutSeconds: 30,
};

class FakeSandboxProvider implements SandboxProvider {
  deleted = 0;

  async createSandbox(): Promise<SandboxHandle> {
    return { id: "fake-sandbox" };
  }

  async cloneRepo(): Promise<void> {}

  async runCommand(_sandbox: SandboxHandle, command: CommandSpec): Promise<CommandResult> {
    return { exitCode: 0, stdout: `${command.cmd}\n` };
  }

  async deleteSandbox(): Promise<void> {
    this.deleted += 1;
  }
}

const repository = new MemoryTaskRepository();
const provider = new FakeSandboxProvider();
const { app } = createApp(settings, repository, provider);

try {
  const create = await app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      setup: [{ cmd: "echo setup" }],
      main: { cmd: "echo main" },
      verify: [{ cmd: "echo verify" }],
    },
  });
  assert.equal(create.statusCode, 200);
  const taskId = create.json().task.id as string;

  const drain = await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
  assert.equal(drain.statusCode, 200);
  assert.equal(drain.json().result.processed, 1);

  const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
  assert.equal(task.json().task.status, "succeeded");

  const events = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}` });
  const eventTypes = events.json().events.map((event: { type: string }) => event.type);
  assert.ok(eventTypes.includes("command_stdout"));
  assert.ok(eventTypes.includes("sandbox_deleted"));
  assert.equal(provider.deleted, 1);

  console.log(JSON.stringify({ ok: true, taskId, events: eventTypes.length }, null, 2));
} finally {
  await app.close();
}
