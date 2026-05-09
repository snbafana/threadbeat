import assert from "node:assert/strict";

import { createHostedGitProvider, normalizeGitHubRepoName, redactHostedGitRemoteUrl } from "../src/hostedGit.js";
import type { Settings } from "../src/config.js";

const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: "file::memory:",
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-hosted-git-test",
  modalImage: "python:3.13-slim",
  hostedGitProvider: "code-storage",
  codeStorageName: "threadbeat-test",
};

const provider = createHostedGitProvider(settings);
assert.equal(provider.name, "code-storage");

const repo = await provider.createRepository({
  agent: {
    id: "agt_hosted_git",
    name: "Hosted Git Agent",
    repo_url: "https://github.com/example/hosted-git-agent.git",
    default_branch: "main",
    current_ref: "main",
  },
  dryRun: true,
  repoId: "hosted-git-store",
});

assert.deepEqual(repo, {
  defaultBranch: "main",
  live: false,
  namespace: "threadbeat-test",
  provider: "code-storage",
  providerRepoId: "hosted-git-store",
  remoteUrl: "https://t:DRY_RUN_TOKEN@threadbeat-test.code.storage/hosted-git-store.git",
  remoteUrlRedacted: "https://t:REDACTED@threadbeat-test.code.storage/hosted-git-store.git",
  source: {
    defaultBranch: "main",
    name: "hosted-git-agent",
    owner: "example",
    provider: "github",
  },
});

const githubSettings: Settings = {
  ...settings,
  hostedGitProvider: "github",
  githubOwner: "threadbeat-test",
};

const githubProvider = createHostedGitProvider(githubSettings);
assert.equal(githubProvider.name, "github");
assert.equal(normalizeGitHubRepoName("Agent Store!!"), "agent-store");
assert.equal(
  redactHostedGitRemoteUrl("https://x-access-token:SECRET@github.com/threadbeat-test/agent.git"),
  "https://x-access-token:REDACTED@github.com/threadbeat-test/agent.git",
);

const githubRepo = await githubProvider.createRepository({
  agent: {
    id: "agt_github",
    name: "GitHub Agent",
    repo_url: "https://github.com/example/github-agent.git",
    default_branch: "main",
    current_ref: "main",
  },
  dryRun: true,
  repoId: "github-agent-store",
});

assert.deepEqual(githubRepo, {
  defaultBranch: "main",
  live: false,
  namespace: "threadbeat-test",
  provider: "github",
  providerRepoId: "github-agent-store",
  remoteUrl: "https://x-access-token:DRY_RUN_TOKEN@github.com/threadbeat-test/github-agent-store.git",
  remoteUrlRedacted: "https://x-access-token:REDACTED@github.com/threadbeat-test/github-agent-store.git",
  source: {
    defaultBranch: "main",
    provider: "github",
    repo: "github-agent-store",
    webUrl: "https://github.com/threadbeat-test/github-agent-store",
  },
});

console.log("hosted git tests passed");
