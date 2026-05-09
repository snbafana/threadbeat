import "dotenv/config";

import assert from "node:assert/strict";

import type { Settings } from "../src/config.js";
import { GitHubHostedGitProvider } from "../src/hostedGit.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  parseGitHubOwnerType,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = process.env.THREADBEAT_GITHUB_OWNER;
const githubOwnerType = parseGitHubOwnerType(process.env.THREADBEAT_GITHUB_OWNER_TYPE ?? "auto");
const githubToken = await resolveGitHubToken();

if (!githubOwner || !githubToken) {
  console.log("GitHub live smoke skipped: THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN/gh auth token are not set");
  process.exit(0);
}

const repoId = `threadbeat-live-smoke-${Date.now().toString(36)}`;
const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: "file::memory:",
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-github-live-smoke",
  modalImage: "python:3.13-slim",
  githubOwner,
  githubOwnerType,
  githubToken,
};

const agent = {
  id: repoId,
  name: "GitHub Live Smoke",
  repo_url: "https://github.com/octocat/Hello-World.git",
  current_ref: "main",
};

const provider = new GitHubHostedGitProvider(settings);
let repoPath: string | undefined;

await assertCanCleanUpSmokeRepo(githubToken, "GitHub live smoke");

try {
  const created = await provider.createRepository({ agent, dryRun: false, repoId });

  assert.equal(created.providerRepoId, repoId);
  assert.equal(created.namespace, githubOwner);
  assert.ok(created.remoteUrl?.includes(`github.com/`));
  assert.ok(created.remoteUrlRedacted?.includes("REDACTED"));
  repoPath = `${created.namespace}/${created.providerRepoId}`;
} finally {
  if (repoPath && process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP !== "1") {
    await deleteGitHubRepo(githubToken, repoPath);
  }
}

console.log(JSON.stringify({
  repoPath,
}, null, 2));
