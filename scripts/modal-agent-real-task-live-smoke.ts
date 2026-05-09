import "dotenv/config";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildModalImageCommands } from "../src/modalImage.js";
import { buildServer } from "../src/server.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  parseGitHubOwnerType,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const execFileAsync = promisify(execFile);
const githubOwner = process.env.THREADBEAT_GITHUB_OWNER;
const githubOwnerType = parseGitHubOwnerType(process.env.THREADBEAT_GITHUB_OWNER_TYPE ?? "auto");
const githubToken = await resolveGitHubToken();
const sandboxEnvNames = listEnv(process.env.THREADBEAT_SANDBOX_ENV_ALLOWLIST);
const sandboxEnv = collectEnv(sandboxEnvNames, process.env);

if (process.env.THREADBEAT_RUN_REAL_PI_TASK !== "1") {
  console.log("Modal agent real task live smoke skipped: set THREADBEAT_RUN_REAL_PI_TASK=1 to run it");
  process.exit(0);
}

if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
  console.log("Modal agent real task live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

if (!githubOwner || !githubToken) {
  console.log("Modal agent real task live smoke skipped: THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN/gh auth token are not set");
  process.exit(0);
}

if (Object.keys(sandboxEnv).length === 0) {
  console.log("Modal agent real task live smoke skipped: THREADBEAT_SANDBOX_ENV_ALLOWLIST did not resolve any sandbox env values");
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
  modalAppName: process.env.THREADBEAT_MODAL_APP_NAME ?? "threadbeat-modal-agent-real-task-live-smoke",
  modalImage: process.env.THREADBEAT_MODAL_IMAGE ?? "python:3.13-slim",
  modalInstallSandboxPi: true,
  modalImageCommands: buildModalImageCommands({ installSandboxPi: true }),
  sandboxEnv,
  sandboxEnvNames,
  hostedGitProvider: "github",
  githubOwner,
  githubOwnerType,
  githubToken,
};

const { app } = await buildServer(settings);
let repoPath: string | undefined;
let runId: string | undefined;
let deleted = false;

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

  const finalized = await cliJson<{ run: { result_commit: string; status: string } }>(baseUrl, [
    "runs",
    "finalize",
    runId,
    "--message",
    "Finalize real Pi task smoke",
  ]);
  assert.equal(finalized.run.status, "completed");
  assert.match(finalized.run.result_commit, /^[a-f0-9]{40}$/);

  console.log(JSON.stringify({
    ok: true,
    modalAppName: settings.modalAppName,
    repoPath,
    runId,
    sandboxEnvNames,
    resultCommit: finalized.run.result_commit,
  }, null, 2));
} finally {
  if (runId) {
    try {
      const address = app.server.address() as AddressInfo | null;
      if (address) await cliJson(`http://${settings.host}:${address.port}`, ["sandboxes", "stop-running", "--run", runId]);
    } catch {
      // Best-effort cleanup. Main assertions validate cleanup on the success path.
    }
  }
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (repoPath && process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP !== "1") {
    await deleteGitHubRepo(githubToken, repoPath);
    deleted = true;
  }
  if (repoPath) console.log(JSON.stringify({ cleanup: { deleted, repoPath } }, null, 2));
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      THREADBEAT_BASE_URL: baseUrl,
      THREADBEAT_GITHUB_OWNER_TYPE: githubOwnerType,
    },
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}

function listEnv(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);
}

function collectEnv(names: string[], source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(names.flatMap((name) => {
    const value = source[name];
    return value === undefined ? [] : [[name, value]];
  }));
}
