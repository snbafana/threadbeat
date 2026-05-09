import "dotenv/config";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";

const execFileAsync = promisify(execFile);

if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
  console.log("Modal agent boot live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-agent-boot-live-smoke-"));
const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "live",
  modalAppName: process.env.THREADBEAT_MODAL_APP_NAME ?? "threadbeat-modal-agent-boot-live-smoke",
  modalImage: process.env.THREADBEAT_MODAL_IMAGE ?? "python:3.13-slim",
  modalImageCommands: [
    "RUN printf '#!/bin/sh\\necho sandbox-pi \"$@\"\\n' > /usr/local/bin/pi && chmod +x /usr/local/bin/pi",
  ],
};

const { app } = await buildServer(settings);
let runId: string | undefined;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const agent = await cliJson<{ agent: { id: string } }>(baseUrl, [
    "agents",
    "create",
    "--name",
    "modal-agent-boot-live-smoke-agent",
    "--repo",
    "https://github.com/octocat/Hello-World.git",
    "--branch",
    "master",
  ]);

  const planned = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    agent.agent.id,
    "--objective",
    "modal agent boot live smoke",
  ]);
  runId = planned.run.id;

  await cliJson<{ sandbox: { id: string } }>(baseUrl, [
    "runs",
    "sandbox",
    runId,
    "--bootstrap",
  ]);

  const booted = await cliJson<{
    plan: { piCommand: string; promptPath: string; taskPath: string };
    result: { exitCode: number; stderr: string; stdout: string };
  }>(baseUrl, [
    "runs",
    "boot",
    runId,
  ]);

  assert.equal(booted.result.exitCode, 0);
  assert.equal(booted.plan.piCommand, "pi");
  assert.equal(booted.plan.promptPath, ".pi/prompts/heartbeat.md");
  assert.match(booted.plan.taskPath, /^tasks\/inbox\/run_/);
  assert.match(booted.result.stdout, /sandbox-pi/);
  assert.match(booted.result.stdout, /--prompt-file \.pi\/prompts\/heartbeat\.md/);
  assert.match(booted.result.stdout, /--message-file tasks\/inbox\/run_/);

  const cleanup = await cliJson<{ stopped: Array<{ state: string }> }>(baseUrl, [
    "sandboxes",
    "stop-running",
    "--run",
    runId,
  ]);
  assert.equal(cleanup.stopped.length, 1);
  assert.equal(cleanup.stopped[0]?.state, "stopped");

  console.log(JSON.stringify({
    ok: true,
    modalAppName: settings.modalAppName,
    modalImage: settings.modalImage,
    runId,
  }, null, 2));
} finally {
  if (runId) {
    try {
      const address = app.server.address() as AddressInfo | null;
      if (address) {
        await cliJson(`http://${settings.host}:${address.port}`, ["sandboxes", "stop-running", "--run", runId]);
      }
    } catch {
      // Best-effort cleanup. Main assertions validate cleanup on the success path.
    }
  }
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}
