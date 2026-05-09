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
import { buildModalImageCommands } from "../src/modalImage.js";
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

if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
  console.log("Modal agent boot live smoke skipped: MODAL_TOKEN_ID and MODAL_TOKEN_SECRET are not set");
  process.exit(0);
}

if (!githubOwner || !githubToken) {
  console.log("Modal agent boot live smoke skipped: THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN/gh auth token are not set");
  process.exit(0);
}

await assertCanCleanUpSmokeRepo(githubToken, "Modal agent boot live smoke");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-modal-agent-boot-live-smoke-"));
const repoId = `threadbeat-modal-agent-boot-${Date.now().toString(36)}`;
const useRealPiImage = process.env.THREADBEAT_MODAL_AGENT_BOOT_REAL_PI === "1";
const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "live",
  modalAppName: process.env.THREADBEAT_MODAL_APP_NAME ?? "threadbeat-modal-agent-boot-live-smoke",
  modalImage: process.env.THREADBEAT_MODAL_IMAGE ?? "python:3.13-slim",
  modalInstallSandboxPi: useRealPiImage,
  modalImageCommands: useRealPiImage
    ? buildModalImageCommands({ installSandboxPi: true })
    : ["RUN printf '#!/bin/sh\\necho sandbox-pi \"$@\"\\n' > /usr/local/bin/pi && chmod +x /usr/local/bin/pi"],
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
    agent: { current_commit: string | null; id: string; repo_url: string };
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
  assert.equal(initialized.agent.current_commit, initialized.initialized?.commitSha);
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
    plan: { piCommand: string };
    result: { exitCode: number; stdout: string };
  }>(baseUrl, [
    "runs",
    "check-runtime",
    runId,
  ]);
  assert.equal(runtime.result.exitCode, 0);
  assert.equal(runtime.plan.piCommand, "pi");
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
    assert.match(booted.result.stdout, /--mode json -p/);

    const bootMessages = await cliJson<{ messages: Array<{ type: string }> }>(baseUrl, [
      "messages",
      "list",
      "--run",
      runId,
    ]);
    assert.ok(bootMessages.messages.some((message) => message.type === "agent_boot_completed"));
  }

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
    realPiImage: useRealPiImage,
    repoPath,
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
  if (repoPath && process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP !== "1") {
    await deleteGitHubRepo(githubToken, repoPath);
    deleted = true;
  }
  if (repoPath) {
    console.log(JSON.stringify({ cleanup: { deleted, repoPath } }, null, 2));
  }
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      THREADBEAT_BASE_URL: baseUrl,
      THREADBEAT_GITHUB_OWNER_TYPE: githubOwnerType,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout) as T;
}
