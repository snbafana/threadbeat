import assert from "node:assert/strict";

import { createHostedGitProvider } from "../src/hostedGit.js";
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

console.log("hosted git tests passed");
