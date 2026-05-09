import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { hasModalCredentials } from "../src/auth.js";
import { buildServer } from "../src/server.js";
import { cliJson } from "./cli-smoke-utils.js";
import { scriptSettings } from "./settings-utils.js";

if (!hasModalCredentials(process.env)) {
  console.log("Modal CLI live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-cli-live-smoke-"));
const settings = scriptSettings({
  modalMode: "live",
  modalAppName: "threadbeat-modal-cli-live-smoke",
  tempRoot,
});

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
    result: { exitCode: number; stderr: string; stdout: string };
    status: { run: { id: string }; sandboxes: Array<{ state: string }> };
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
  runId = stepped.status.run.id;

  assert.equal(stepped.result.exitCode, 0);
  assert.match(`${stepped.result.stdout}${stepped.result.stderr}`, /Python/);
  assert.ok(stepped.status.sandboxes.some((sandbox) => sandbox.state === "running"));

  const cleanup = await cliJson<{ stoppedCount: number }>(baseUrl, [
    "sandboxes",
    "stop-running",
    "--run",
    runId,
  ]);
  assert.equal(cleanup.stoppedCount, 1);

  console.log(JSON.stringify({
    ok: true,
  }, null, 2));
} finally {
  if (runId) {
    try {
      const address = app.server.address() as AddressInfo | null;
      if (address) {
        await cliJson(`http://${settings.host}:${address.port}`, ["sandboxes", "stop-running", "--run", runId]);
      }
    } catch {}
  }
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
