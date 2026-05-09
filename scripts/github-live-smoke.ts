import "dotenv/config";

import assert from "node:assert/strict";

import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE } from "../src/config.js";
import { GitHubHostedGitProvider } from "../src/hostedGit.js";
import { skipUnlessGitHubToken } from "./script-auth-utils.js";
import { printJson } from "./script-output-utils.js";
import { scriptSettings } from "./settings-utils.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepoIfCreated,
  githubRepoPath,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = DEFAULT_GITHUB_OWNER;
const githubOwnerType = DEFAULT_GITHUB_OWNER_TYPE;
const githubToken = resolveGitHubToken();

skipUnlessGitHubToken(githubToken, "GitHub live smoke");

const repoId = `threadbeat-live-smoke-${Date.now().toString(36)}`;
const settings = scriptSettings({
  dbUrl: "file::memory:",
  modalAppName: "threadbeat-github-live-smoke",
  overrides: {
    githubOwner,
    githubOwnerType,
    githubToken,
  },
});

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
  repoPath = githubRepoPath(created.namespace, created.providerRepoId);
} finally {
  await deleteGitHubRepoIfCreated(githubToken, repoPath);
}

printJson({
  repoPath,
});
