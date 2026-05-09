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
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  getGitHubFile,
  parseGitHubOwnerType,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const execFileAsync = promisify(execFile);
const githubOwner = process.env.THREADBEAT_GITHUB_OWNER;
const githubOwnerType = parseGitHubOwnerType(process.env.THREADBEAT_GITHUB_OWNER_TYPE ?? "auto");
const githubToken = await resolveGitHubToken();

if (!githubOwner || !githubToken) {
  console.log("GitHub agent init CLI live smoke skipped: THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN/gh auth token are not set");
  process.exit(0);
}

await assertCanCleanUpSmokeRepo(githubToken, "GitHub agent init CLI live smoke");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-github-agent-init-cli-smoke-"));
const repoId = `threadbeat-agent-init-cli-${Date.now().toString(36)}`;
const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-github-agent-init-cli-live-smoke",
  modalImage: "python:3.13-slim",
  hostedGitProvider: "github",
  githubOwner,
  githubOwnerType,
  githubToken,
};

const { app } = await buildServer(settings);
let repoPath: string | undefined;
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
    "GitHub Agent Init CLI Smoke",
    "--id",
    repoId,
    "--repo-id",
    repoId,
  ]);

  assert.equal(initialized.hostedRepo.namespace, githubOwner);
  assert.equal(initialized.hostedRepo.providerRepoId, repoId);
  assert.match(initialized.agent.repo_url, new RegExp(`github.com/${githubOwner}/${repoId}\\.git`));
  assert.match(initialized.agent.current_commit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(initialized.agent.current_commit, initialized.initialized?.commitSha);
  assert.ok(initialized.initialized?.filesWritten.includes("AGENTS.md"));
  repoPath = `${githubOwner}/${repoId}`;

  const agentsMd = await getGitHubFile(githubToken, repoPath, "AGENTS.md");
  assert.match(agentsMd, /GitHub Agent Init CLI Smoke/);
  assert.match(agentsMd, /Self-Improvement Rules/);

  const stepped = await cliJson<{
    executed: { result: { exitCode: number; stdout: string } };
    finalized: null;
    runId: string;
    sandbox: { bootstrap?: { results: Array<{ command: string[]; exitCode: number; stdout: string }> } };
    status: { sandboxes: Array<{ branch: string; state: string }> };
  }>(baseUrl, [
    "runs",
    "step",
    "--agent",
    initialized.agent.id,
    "--objective",
    "bootstrap initialized agent",
    "--bootstrap",
    "--cwd",
    "/workspace/agent",
    "--",
    "test -f AGENTS.md && test -d .pi/prompts && git status --short --branch",
  ]);
  assert.equal(stepped.executed.result.exitCode, 0);
  assert.match(stepped.executed.result.stdout, /\[dry-run\]/);
  assert.match(stepped.executed.result.stdout, /test -f AGENTS\.md/);
  assert.ok(stepped.sandbox.bootstrap?.results.every((result) => result.exitCode === 0));
  assert.ok(stepped.sandbox.bootstrap?.results.some((result) => result.command.join(" ").includes("git clone")));
  assert.ok(stepped.sandbox.bootstrap?.results.some((result) => result.command.join(" ").includes("git -C /workspace/agent push -u origin HEAD:threadbeat/runs/")));
  assert.ok(stepped.status.sandboxes.some((sandbox) => sandbox.state === "running" && sandbox.branch.startsWith("threadbeat/runs/")));

  const cleanup = await cliJson<{ stopped: Array<{ state: string }> }>(baseUrl, [
    "sandboxes",
    "stop-running",
    "--run",
    stepped.runId,
  ]);
  assert.ok(cleanup.stopped.some((sandbox) => sandbox.state === "stopped"));
} finally {
  await app.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (repoPath && process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP !== "1") {
    await deleteGitHubRepo(githubToken, repoPath);
    deleted = true;
  }
}

console.log(JSON.stringify({
  ok: true,
  deleted,
  repoPath,
}, null, 2));

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
