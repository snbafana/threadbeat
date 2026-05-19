import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

import type { Settings } from "../src/config.js";
import { MemoryTaskRepository } from "../src/db.js";
import type { CommandResult, SandboxHandle, SandboxProvider } from "../src/sandboxProvider.js";
import { createApp } from "../src/server.js";
import type { CommandSpec, RepoSpec } from "../src/types.js";

async function testSuccessfulTask(): Promise<void> {
  const repository = new MemoryTaskRepository();
  const provider = new FakeSandboxProvider();
  const { app } = createApp(testSettings(), repository, provider);
  try {
    const taskId = await createTask(app, {
      repo: { url: "https://github.com/octocat/Hello-World.git", branch: "master" },
      setup: [{ cmd: "echo setup" }],
      main: { cmd: "echo main" },
      verify: [{ cmd: "echo verify" }],
    });
    await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    assert.equal(task.json().task.status, "succeeded");
    assert.deepEqual(provider.commands, ["echo setup", "echo main", "echo verify"]);
    assert.equal(provider.clones.length, 1);
    assert.equal(provider.deleted, 1);
  } finally {
    await app.close();
  }
}

async function testFailedTask(): Promise<void> {
  const repository = new MemoryTaskRepository();
  const provider = new FakeSandboxProvider({ failOn: "exit 2" });
  const { app } = createApp(testSettings(), repository, provider);
  try {
    const taskId = await createTask(app, {
      setup: [],
      main: { cmd: "exit 2" },
      verify: [{ cmd: "echo should-not-run" }],
    });
    await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
    const task = await app.inject({ method: "GET", url: `/api/tasks/${taskId}` });
    assert.equal(task.json().task.status, "failed");
    assert.equal(provider.commands.includes("echo should-not-run"), false);
    assert.equal(provider.deleted, 1);
  } finally {
    await app.close();
  }
}

async function testEventCursor(): Promise<void> {
  const repository = new MemoryTaskRepository();
  const provider = new FakeSandboxProvider();
  const { app } = createApp(testSettings(), repository, provider);
  try {
    const taskId = await createTask(app, { main: { cmd: "echo cursor" } });
    await app.inject({ method: "POST", url: "/api/worker/drain-once", payload: {} });
    const first = await app.inject({ method: "GET", url: `/api/events?taskId=${taskId}&limit=2` });
    const firstEvents = first.json().events as Array<{ seq: number }>;
    assert.equal(firstEvents.length, 2);
    const second = await app.inject({
      method: "GET",
      url: `/api/events?taskId=${taskId}&after=${firstEvents[1]?.seq}`,
    });
    const secondEvents = second.json().events as Array<{ seq: number }>;
    assert.ok(secondEvents.every((event) => event.seq > firstEvents[1]!.seq));
  } finally {
    await app.close();
  }
}

async function createTask(app: FastifyInstance, spec: Record<string, unknown>): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/api/tasks", payload: spec });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().task.id as string;
}

function testSettings(): Settings {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: "memory",
    maxSandboxes: 1,
    runTimeoutSeconds: 600,
    daytonaApiKey: undefined,
    daytonaApiUrl: undefined,
    daytonaTarget: undefined,
    sandboxEnvAllowlist: [],
    commandTimeoutSeconds: 30,
  };
}

class FakeSandboxProvider implements SandboxProvider {
  commands: string[] = [];
  clones: RepoSpec[] = [];
  deleted = 0;

  constructor(private readonly options: { failOn?: string } = {}) {}

  async createSandbox(): Promise<SandboxHandle> {
    return { id: "fake-sandbox" };
  }

  async cloneRepo(_sandbox: SandboxHandle, repo: RepoSpec): Promise<void> {
    this.clones.push(repo);
  }

  async runCommand(_sandbox: SandboxHandle, command: CommandSpec): Promise<CommandResult> {
    this.commands.push(command.cmd);
    if (this.options.failOn === command.cmd) return { exitCode: 2, stdout: "failed\n" };
    return { exitCode: 0, stdout: `${command.cmd}\n` };
  }

  async deleteSandbox(): Promise<void> {
    this.deleted += 1;
  }
}

await testSuccessfulTask();
await testFailedTask();
await testEventCursor();
console.log("smoke tests passed");
