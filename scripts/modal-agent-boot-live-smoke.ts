import "dotenv/config";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { hasModalCredentials } from "../src/auth.js";
import { buildServer } from "../src/server.js";
import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE } from "../src/config.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import { cliJson as runCliJson } from "./cli-smoke-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptSettings } from "./settings-utils.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = DEFAULT_GITHUB_OWNER;
const githubOwnerType = DEFAULT_GITHUB_OWNER_TYPE;
const githubToken = resolveGitHubToken();

if (!hasModalCredentials(process.env)) {
  console.log("Modal agent boot live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

if (!githubToken) {
  console.log("Modal agent boot live smoke skipped: gh auth token is not available");
  process.exit(0);
}

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
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

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
  repoPath = `${githubOwner}/${repoId}`;
  assert.equal(initialized.hostedRepo.namespace, githubOwner);
  assert.equal(initialized.hostedRepo.providerRepoId, repoId);
  assert.match(initialized.initialized?.commitSha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(initialized.initialized?.filesWritten.includes("AGENTS.md"));
  assert.ok(initialized.initialized?.filesWritten.includes(".pi/prompts/heartbeat.md"));

  const planned = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    initialized.agent.id,
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

  const runtime = await cliJson<{
    result: { exitCode: number; stdout: string };
  }>(baseUrl, [
    "runs",
    "check-runtime",
    runId,
  ]);
  assert.equal(runtime.result.exitCode, 0);
  assert.match(runtime.result.stdout, /agent runtime ready/);

  const messages = await cliJson<{ messages: Array<{ type: string }> }>(baseUrl, [
    "messages",
    "list",
    "--run",
    runId,
  ]);
  assert.ok(messages.messages.some((message) => message.type === "agent_runtime_check_completed"));

  if (!useRealPiImage) {
    const booted = await cliJson<{
      result: { exitCode: number; stderr: string; stdout: string };
    }>(baseUrl, [
      "runs",
      "boot",
      runId,
    ]);

    assert.equal(booted.result.exitCode, 0);
    assert.match(booted.result.stdout, /sandbox-pi/);
    assert.match(booted.result.stdout, /--mode json -p/);

    const bootMessages = await cliJson<{ messages: Array<{ type: string }> }>(baseUrl, [
      "messages",
      "list",
      "--run",
      runId,
    ]);
    assert.ok(bootMessages.messages.some((message) => message.type === "agent_boot_completed"));
  }

  const cleanup = await cliJson<{ stoppedCount: number }>(baseUrl, [
    "sandboxes",
    "stop-running",
    "--run",
    runId,
  ]);
  assert.equal(cleanup.stoppedCount, 1);

  console.log(JSON.stringify({
    repoPath,
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
  await removeScriptTempRoot(tempRoot);
  if (repoPath) {
    await deleteGitHubRepo(githubToken, repoPath);
  }
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  return runCliJson<T>(baseUrl, args, { maxBuffer: 10 * 1024 * 1024 });
}
