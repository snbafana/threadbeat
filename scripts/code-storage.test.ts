import assert from "node:assert/strict";

import { CodeStorageService, redactRemoteUrl, sourceFromAgent } from "../src/codeStorage.js";
import type { Settings } from "../src/config.js";

const agent = {
  id: "agt_storage",
  name: "Storage Agent",
  repo_url: "https://github.com/example/storage-agent.git",
  default_branch: "main",
  current_ref: "main",
};

assert.deepEqual(sourceFromAgent(agent), {
  defaultBranch: "main",
  name: "storage-agent",
  owner: "example",
  provider: "github",
});

assert.equal(
  redactRemoteUrl("https://t:SECRET@example.code.storage/repo.git"),
  "https://t:REDACTED@example.code.storage/repo.git",
);

const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: "file::memory:",
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-code-storage-test",
  modalImage: "python:3.13-slim",
  codeStorageName: "threadbeat-test",
};

const created = await new CodeStorageService(settings).createRepository({
  agent,
  dryRun: true,
  repoId: "agent-store",
});

assert.deepEqual(created, {
  codeStorageRepoId: "agent-store",
  defaultBranch: "main",
  live: false,
  organizationName: "threadbeat-test",
  remoteUrl: "https://t:DRY_RUN_TOKEN@threadbeat-test.code.storage/agent-store.git",
  remoteUrlRedacted: "https://t:REDACTED@threadbeat-test.code.storage/agent-store.git",
  source: {
    defaultBranch: "main",
    name: "storage-agent",
    owner: "example",
    provider: "github",
  },
});

console.log("Code.Storage tests passed");
