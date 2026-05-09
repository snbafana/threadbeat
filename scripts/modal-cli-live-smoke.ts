import "dotenv/config";

import assert from "node:assert/strict";

import { buildServer } from "../src/server.js";
import { cliJson, stopRunSandboxes, type CliAgentResponse, type CliCommandResponse } from "./cli-smoke-utils.js";
import { skipUnlessModalCredentials } from "./script-auth-utils.js";
import { printJson } from "./script-output-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptServerBaseUrl, scriptSettings } from "./settings-utils.js";

skipUnlessModalCredentials("Modal CLI live smoke");

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
  const baseUrl = scriptServerBaseUrl(settings.host, app.server.address());

  const agent = await cliJson<CliAgentResponse>(baseUrl, [
    "agents",
    "create",
    "--name",
    "modal-cli-live-smoke-agent",
    "--repo",
    "https://github.com/octocat/Hello-World.git",
    "--branch",
    "master",
  ]);

  const stepped = await cliJson<CliCommandResponse & {
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
      await stopRunSandboxes(scriptServerBaseUrl(settings.host, app.server.address()), runId);
    } catch {}
  }
  await app.close();
  await removeScriptTempRoot(tempRoot);
}
