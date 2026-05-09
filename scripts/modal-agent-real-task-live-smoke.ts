import "dotenv/config";

import assert from "node:assert/strict";

import { collectPresentEnv, hasModalCredentials } from "../src/auth.js";
import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE } from "../src/config.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import { DEEPSEEK_API_KEY_ENV } from "../src/piModels.js";
import { buildServer } from "../src/server.js";
import { cliJsonHuge as cliJson, stopRunSandboxes } from "./cli-smoke-utils.js";
import { printJson, skipSmoke, skipUnless } from "./script-output-utils.js";
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
const sandboxEnvNames = [DEEPSEEK_API_KEY_ENV];
const sandboxEnv = collectPresentEnv(sandboxEnvNames, process.env);

if (!hasModalCredentials(process.env)) {
  skipSmoke("Modal agent real task live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
}

skipUnless(githubToken, "Modal agent real task live smoke skipped: gh auth token is not available");

if (Object.keys(sandboxEnv).length === 0) {
  skipSmoke(`Modal agent real task live smoke skipped: ${DEEPSEEK_API_KEY_ENV} is not set`);
}

await assertCanCleanUpSmokeRepo(githubToken, "Modal agent real task live smoke");

const tempRoot = await createScriptTempRoot("threadbeat-modal-agent-real-task-live-smoke");
const repoId = `threadbeat-modal-agent-real-task-${Date.now().toString(36)}`;
const settings = scriptSettings({
  modalMode: "live",
  modalAppName: "threadbeat-modal-agent-real-task-live-smoke",
  tempRoot,
  overrides: {
    modalInstallSandboxPi: true,
    modalImageCommands: buildModalImageCommands({ installSandboxPi: true }),
    sandboxEnv,
    sandboxEnvNames,
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
    "modal-agent-real-task-live-smoke-agent",
    "--id",
    repoId,
    "--repo-id",
    repoId,
  ]);
  repoPath = githubRepoPath(githubOwner, repoId);
  assert.equal(initialized.hostedRepo.namespace, githubOwner);
  assert.equal(initialized.hostedRepo.providerRepoId, repoId);
  assert.ok(initialized.initialized?.filesWritten.includes("AGENTS.md"));

  const planned = await cliJson<{ run: { id: string } }>(baseUrl, [
    "runs",
    "plan",
    "--agent",
    initialized.agent.id,
    "--objective",
    "Append exactly one JSONL decision entry to state/decisions.jsonl saying the Modal real Pi task smoke ran. Do not edit anything else unless needed.",
  ]);
  runId = planned.run.id;

  await cliJson(baseUrl, ["runs", "sandbox", runId, "--bootstrap"]);
  await cliJson(baseUrl, ["runs", "check-runtime", runId]);

  const booted = await cliJson<{
    result: { exitCode: number; stderr: string; stdout: string };
  }>(baseUrl, ["runs", "boot", runId]);
  assert.equal(booted.result.exitCode, 0, booted.result.stderr || booted.result.stdout);

  const status = await cliJson<{ result: { exitCode: number; stdout: string; stderr: string } }>(baseUrl, [
    "runs",
    "exec",
    runId,
    "--",
    "git",
    "status",
    "--short",
  ]);
  assert.equal(status.result.exitCode, 0);
  assert.notEqual(status.result.stdout.trim(), "", "expected Pi to mutate the bootstrapped agent repo");

  const finalized = await cliJson<{ result: { commitSha: string } }>(baseUrl, [
    "runs",
    "finalize",
    runId,
    "--message",
    "Finalize real Pi task smoke",
  ]);
  assert.match(finalized.result.commitSha, /^[a-f0-9]{40}$/);
  const finalizedRun = await cliJson<{ run: { result_commit: string; status: string } }>(baseUrl, [
    "runs",
    "get",
    runId,
  ]);
  assert.equal(finalizedRun.run.status, "completed");
  assert.equal(finalizedRun.run.result_commit, finalized.result.commitSha);

  printJson({
    repoPath,
    resultCommit: finalized.result.commitSha,
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
