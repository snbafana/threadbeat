import "dotenv/config";

import assert from "node:assert/strict";
import { GitStorage } from "@pierre/storage";

import { CodeStorageService, redactRemoteUrl } from "../src/codeStorage.js";
import type { Settings } from "../src/config.js";

const codeStorageName = process.env.CODE_STORAGE_NAME ?? process.env.PIERRE_CODE_STORAGE_NAME;
const codeStoragePrivateKey =
  process.env.CODE_STORAGE_PRIVATE_KEY
  ?? process.env.PIERRE_PRIVATE_KEY
  ?? process.env.PIERRE_CODE_STORAGE_PRIVATE_KEY;

if (!codeStorageName || !codeStoragePrivateKey) {
  console.log("Code.Storage live smoke skipped: CODE_STORAGE_NAME and CODE_STORAGE_PRIVATE_KEY are not set");
  process.exit(0);
}

const repoId = `threadbeat-live-smoke-${Date.now().toString(36)}`;
const settings: Settings = {
  projectRoot: process.cwd(),
  dbUrl: "file::memory:",
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-code-storage-live-smoke",
  modalImage: "python:3.13-slim",
  codeStorageName,
  codeStoragePrivateKey,
};

const agent = {
  id: repoId,
  name: "Code.Storage Live Smoke",
  repo_url: "https://github.com/octocat/Hello-World.git",
  default_branch: "master",
  current_ref: "master",
};

const service = new CodeStorageService(settings);
const created = await service.createRepository({ agent, dryRun: false, repoId });
let deleted = false;

try {
  assert.equal(created.live, true);
  assert.equal(created.codeStorageRepoId, repoId);
  assert.equal(created.organizationName, codeStorageName);
  assert.ok(created.remoteUrl?.includes(".code.storage/"));
  assert.equal(created.remoteUrlRedacted, redactRemoteUrl(created.remoteUrl));
} finally {
  if (process.env.CODE_STORAGE_LIVE_SMOKE_KEEP !== "1") {
    const store = new GitStorage({ name: codeStorageName, key: codeStoragePrivateKey });
    await store.deleteRepo({ id: repoId });
    deleted = true;
  }
}

console.log(JSON.stringify({
  ok: true,
  codeStorageRepoId: created.codeStorageRepoId,
  deleted,
  organizationName: created.organizationName,
  remoteUrlRedacted: created.remoteUrlRedacted,
  source: created.source,
}, null, 2));
