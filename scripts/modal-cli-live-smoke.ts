import "dotenv/config";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { hasModalCredentials } from "../src/auth.js";
import { buildServer } from "../src/server.js";
import { cliJson, stopRunSandboxes } from "./cli-smoke-utils.js";
import { printJson, skipSmoke } from "./script-output-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptSettings } from "./settings-utils.js";

if (!hasModalCredentials(process.env)) {
  skipSmoke("Modal CLI live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
}

const tempRoot = await createScriptTempRoot("threadbeat-modal-cli-live-smoke");
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

  const cleanup = await stopRunSandboxes(baseUrl, runId);
  assert.equal(cleanup.stoppedCount, 1);

  printJson({
    ok: true,
  });
} finally {
  if (runId) {
    try {
      const address = app.server.address() as AddressInfo | null;
      if (address) {
        await stopRunSandboxes(`http://${settings.host}:${address.port}`, runId);
      }
    } catch {}
  }
  await app.close();
  await removeScriptTempRoot(tempRoot);
}
