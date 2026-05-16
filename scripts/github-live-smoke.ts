import "dotenv/config";

import assert from "node:assert/strict";

import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE, DEFAULT_MODAL_IMAGE, type Settings } from "../src/config.js";
import { GitHubHostedGitProvider } from "../src/hostedGit.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepo,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = DEFAULT_GITHUB_OWNER;
const githubOwnerType = DEFAULT_GITHUB_OWNER_TYPE;
const githubToken = resolveGitHubToken();

if (!githubToken) {
  console.log("GitHub live smoke skipped: gh auth token is not available");
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
  modalImage: DEFAULT_MODAL_IMAGE,
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
  if (repoPath) {
    await deleteGitHubRepo(githubToken, repoPath);
  }
}

console.log(JSON.stringify({
  repoPath,
}, null, 2));
