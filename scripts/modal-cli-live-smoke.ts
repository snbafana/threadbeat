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
  console.log("Modal CLI live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-cli-live-smoke-"));
const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "live",
  modalAppName: process.env.THREADBEAT_MODAL_APP_NAME ?? "threadbeat-modal-cli-live-smoke",
  modalImage: process.env.THREADBEAT_MODAL_IMAGE ?? "python:3.13-slim",
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
    "modal-cli-live-smoke-agent",
    "--repo",
    "https://github.com/octocat/Hello-World.git",
    "--branch",
    "master",
  ]);

  const stepped = await cliJson<{
    executed: { result: { exitCode: number; stderr: string; stdout: string } };
    runId: string;
    status: { sandboxes: Array<{ state: string }> };
  }>(baseUrl, [
    "runs",
    "step",
    "--agent",
    agent.agent.id,
    "--objective",
    "modal cli live smoke",
    "--cwd",
    "/",
    "--",
    "python --version",
  ]);
  runId = stepped.runId;

  assert.equal(stepped.executed.result.exitCode, 0);
  assert.match(`${stepped.executed.result.stdout}${stepped.executed.result.stderr}`, /Python/);
  assert.ok(stepped.status.sandboxes.some((sandbox) => sandbox.state === "running"));

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
    stoppedSandboxes: cleanup.stopped.length,
  }, null, 2));
} finally {
  if (runId) {
    try {
      const address = app.server.address() as AddressInfo | null;
      if (address) {
        await cliJson(`http://${settings.host}:${address.port}`, ["sandboxes", "stop-running", "--run", runId]);
      }
    } catch {
      // Best-effort cleanup. The main assertions already validated cleanup.
    }
  }
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
  });
  return JSON.parse(stdout) as T;
}
