import "dotenv/config";

import assert from "node:assert/strict";

import { buildServer } from "../src/server.js";
import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE } from "../src/config.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import {
  cliJsonLarge as cliJson,
  stopRunSandboxes,
  type CliCommandResponse,
  type CliMessagesResponse,
  type CliRunResponse,
  type CliSandboxResponse,
  type CliStdoutCommandResponse,
} from "./cli-smoke-utils.js";
import { skipUnlessGitHubToken, skipUnlessModalCredentials } from "./script-auth-utils.js";
import { printJson } from "./script-output-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptServerBaseUrl, scriptSettings } from "./settings-utils.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepoIfCreated,
  githubRepoPath,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = DEFAULT_GITHUB_OWNER;
const githubOwnerType = DEFAULT_GITHUB_OWNER_TYPE;
const githubToken = resolveGitHubToken();

skipUnlessModalCredentials("Modal agent boot live smoke");
skipUnlessGitHubToken(githubToken, "Modal agent boot live smoke");

await assertCanCleanUpSmokeRepo(githubToken, "Modal agent boot live smoke");

const tempRoot = await createScriptTempRoot("threadbeat-modal-agent-boot-live-smoke");
const repoId = `threadbeat-modal-agent-boot-${Date.now().toString(36)}`;
const useRealPiImage = process.argv.includes("--real-pi");
const settings = scriptSettings({
  modalMode: "live",
  modalAppName: "threadbeat-modal-agent-boot-live-smoke",
  tempRoot,
  overrides: {
    modalInstallSandboxPi: useRealPiImage,
    modalImageCommands: useRealPiImage
      ? buildModalImageCommands({ installSandboxPi: true })
      : ["RUN printf '#!/bin/sh\\necho sandbox-pi \"$@\"\\n' > /usr/local/bin/pi && chmod +x /usr/local/bin/pi"],
    githubOwner,
    githubOwnerType,
    githubToken,
  },
});

const { app } = await buildServer(settings);
let repoPath: string | undefined;
let runId: string | undefined;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const baseUrl = scriptServerBaseUrl(settings.host, app.server.address());

  const initialized = await cliJson<{
    agent: { id: string };
    hostedRepo: { namespace: string; providerRepoId: string };
    initialized: { commitSha: string; filesWritten: string[] } | null;
  }>(baseUrl, [
    "agents",
    "init",
    "--name",
    "modal-agent-boot-live-smoke-agent",
    "--id",
    repoId,
    "--repo-id",
    repoId,
  ]);
  repoPath = githubRepoPath(githubOwner, repoId);
  assert.equal(initialized.hostedRepo.namespace, githubOwner);
  assert.equal(initialized.hostedRepo.providerRepoId, repoId);
  assert.match(initialized.initialized?.commitSha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(initialized.initialized?.filesWritten.includes("AGENTS.md"));
  assert.ok(initialized.initialized?.filesWritten.includes(".pi/prompts/heartbeat.md"));

  const planned = await cliJson<CliRunResponse>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    initialized.agent.id,
    "--objective",
    "modal agent boot live smoke",
  ]);
  runId = planned.run.id;

  await cliJson<CliSandboxResponse>(baseUrl, [
    "runs",
    "sandbox",
    runId,
    "--bootstrap",
  ]);

  const runtime = await cliJson<CliStdoutCommandResponse>(baseUrl, [
    "runs",
    "check-runtime",
    runId,
  ]);
  assert.equal(runtime.result.exitCode, 0);
  assert.match(runtime.result.stdout, /agent runtime ready/);

  const messages = await cliJson<CliMessagesResponse>(baseUrl, [
    "messages",
    "list",
    "--run",
    runId,
  ]);
  assert.ok(messages.messages.some((message) => message.type === "agent_runtime_check_completed"));

  if (!useRealPiImage) {
    const booted = await cliJson<CliCommandResponse>(baseUrl, [
      "runs",
      "boot",
      runId,
    ]);

    assert.equal(booted.result.exitCode, 0);
    assert.match(booted.result.stdout, /sandbox-pi/);
    assert.match(booted.result.stdout, /--mode json -p/);

    const bootMessages = await cliJson<CliMessagesResponse>(baseUrl, [
      "messages",
      "list",
      "--run",
      runId,
    ]);
    assert.ok(bootMessages.messages.some((message) => message.type === "agent_boot_completed"));
  }

  const cleanup = await stopRunSandboxes(baseUrl, runId);
  assert.equal(cleanup.stoppedCount, 1);

  printJson({
    repoPath,
  });
} finally {
  if (runId) {
    try {
      await stopRunSandboxes(scriptServerBaseUrl(settings.host, app.server.address()), runId);
    } catch {}
  }
  await app.close();
  await removeScriptTempRoot(tempRoot);
  await deleteGitHubRepoIfCreated(githubToken, repoPath);
}
