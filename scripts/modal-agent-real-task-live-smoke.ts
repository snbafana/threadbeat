import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { collectPresentEnv, hasModalCredentials } from "../src/auth.js";
import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE, DEFAULT_MODAL_IMAGE, type Settings } from "../src/config.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import { DEEPSEEK_API_KEY_ENV } from "../src/piModels.js";
import { buildServer } from "../src/server.js";
import { cliJson as runCliJson } from "./cli-smoke-utils.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = DEFAULT_GITHUB_OWNER;
const githubOwnerType = DEFAULT_GITHUB_OWNER_TYPE;
const githubToken = resolveGitHubToken();
const sandboxEnvNames = [DEEPSEEK_API_KEY_ENV];
const sandboxEnv = collectPresentEnv(sandboxEnvNames, process.env);

if (!hasModalCredentials(process.env)) {
  console.log("Modal agent real task live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

if (!githubToken) {
  console.log("Modal agent real task live smoke skipped: gh auth token is not available");
  process.exit(0);
}

if (Object.keys(sandboxEnv).length === 0) {
  console.log(`Modal agent real task live smoke skipped: ${DEEPSEEK_API_KEY_ENV} is not set`);
  process.exit(0);
}

await assertCanCleanUpSmokeRepo(githubToken, "Modal agent real task live smoke");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-agent-real-task-live-smoke-"));
const repoId = `threadbeat-modal-agent-real-task-${Date.now().toString(36)}`;
const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "live",
  modalAppName: "threadbeat-modal-agent-real-task-live-smoke",
  modalImage: DEFAULT_MODAL_IMAGE,
  modalInstallSandboxPi: true,
  modalImageCommands: buildModalImageCommands({ installSandboxPi: true }),
  sandboxEnv,
  sandboxEnvNames,
  githubOwner,
  githubOwnerType,
  githubToken,
};

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
    "modal-agent-real-task-live-smoke-agent",
    "--id",
    repoId,
    "--repo-id",
    repoId,
  ]);
  repoPath = `${githubOwner}/${repoId}`;
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

  console.log(JSON.stringify({
    repoPath,
    resultCommit: finalized.result.commitSha,
  }, null, 2));
} finally {
  if (runId) {
    try {
      const address = app.server.address() as AddressInfo | null;
      if (address) await cliJson(`http://${settings.host}:${address.port}`, ["sandboxes", "stop-running", "--run", runId]);
    } catch {}
  }
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (repoPath) {
    await deleteGitHubRepo(githubToken, repoPath);
  }
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  return runCliJson<T>(baseUrl, args, { maxBuffer: 20 * 1024 * 1024 });
}
