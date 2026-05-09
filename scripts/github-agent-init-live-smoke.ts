import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildServer } from "../src/server.js";
import type { Settings } from "../src/config.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  getGitHubFile,
  parseGitHubOwnerType,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = process.env.THREADBEAT_GITHUB_OWNER;
const githubOwnerType = parseGitHubOwnerType(process.env.THREADBEAT_GITHUB_OWNER_TYPE ?? "auto");
const githubToken = await resolveGitHubToken();

if (!githubOwner || !githubToken) {
  console.log("GitHub agent init live smoke skipped: THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN/gh auth token are not set");
  process.exit(0);
}

await assertCanCleanUpSmokeRepo(githubToken, "GitHub agent init live smoke");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-github-agent-init-smoke-"));
const repoId = `threadbeat-agent-init-${Date.now().toString(36)}`;
const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-github-agent-init-live-smoke",
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
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/from-template",
    payload: {
      dryRun: false,
      id: repoId,
      name: "GitHub Agent Init Smoke",
      repoId,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body) as {
    agent: { current_commit: string | null; repo_url: string };
    hostedRepo: { namespace: string; providerRepoId: string };
    initialized: { commitSha: string; filesWritten: string[] } | null;
  };
  assert.equal(body.hostedRepo.namespace, githubOwner);
  assert.equal(body.hostedRepo.providerRepoId, repoId);
  assert.match(body.agent.repo_url, new RegExp(`github.com/${githubOwner}/${repoId}\\.git`));
  assert.match(body.agent.current_commit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(body.agent.current_commit, body.initialized?.commitSha);
  assert.ok(body.initialized?.filesWritten.includes("AGENTS.md"));
  repoPath = `${githubOwner}/${repoId}`;

  const agentsMd = await getGitHubFile(githubToken, repoPath, "AGENTS.md");
  assert.match(agentsMd, /GitHub Agent Init Smoke/);
  assert.match(agentsMd, /Self-Improvement Rules/);
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
