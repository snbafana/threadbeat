import "dotenv/config";

import assert from "node:assert/strict";

import type { Settings } from "../src/config.js";
import { GitHubHostedGitProvider } from "../src/hostedGit.js";

const githubOwner = process.env.THREADBEAT_GITHUB_OWNER;
const githubOwnerType = parseGitHubOwnerType(process.env.THREADBEAT_GITHUB_OWNER_TYPE ?? "org");
const githubToken = process.env.THREADBEAT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;

if (!githubOwner || !githubToken) {
  console.log("GitHub live smoke skipped: THREADBEAT_GITHUB_OWNER and THREADBEAT_GITHUB_TOKEN/GITHUB_TOKEN are not set");
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
  hostedGitProvider: "github",
  githubOwner,
  githubOwnerType,
  githubToken,
};

const agent = {
  id: repoId,
  name: "GitHub Live Smoke",
  repo_url: "https://github.com/octocat/Hello-World.git",
  default_branch: "main",
  current_ref: "main",
};

const provider = new GitHubHostedGitProvider(settings);
let created: Awaited<ReturnType<typeof provider.createRepository>> | undefined;
let deleted = false;

await assertCanCleanUpSmokeRepo(githubToken);

try {
  created = await provider.createRepository({ agent, dryRun: false, repoId });

  assert.equal(created.live, true);
  assert.equal(created.provider, "github");
  assert.equal(created.providerRepoId, repoId);
  assert.equal(created.namespace, githubOwner);
  assert.ok(created.remoteUrl?.includes(`github.com/`));
  assert.ok(created.remoteUrlRedacted?.includes("REDACTED"));
} finally {
  if (created && process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP !== "1") {
    const repoPath = githubRepoPathFromRemoteUrl(created.remoteUrl);
    const response = await fetch(`https://api.github.com/repos/${repoPath}`, {
      headers: githubHeaders(githubToken),
      method: "DELETE",
    });
    assert.equal(response.status, 204, `GitHub smoke repo delete failed (${response.status}): ${await response.text()}`);
    deleted = true;
  }
}

console.log(JSON.stringify({
  ok: true,
  deleted,
  namespace: created?.namespace,
  providerRepoId: created?.providerRepoId,
  remoteUrlRedacted: created?.remoteUrlRedacted,
  source: created?.source,
}, null, 2));

function parseGitHubOwnerType(value: string): "org" | "user" {
  if (value === "org" || value === "user") return value;
  throw new Error("THREADBEAT_GITHUB_OWNER_TYPE must be org or user");
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "threadbeat",
    "x-github-api-version": "2022-11-28",
  };
}

async function assertCanCleanUpSmokeRepo(token: string): Promise<void> {
  if (process.env.THREADBEAT_GITHUB_LIVE_SMOKE_KEEP === "1") return;
  const response = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token),
    method: "GET",
  });
  const scopes = response.headers.get("x-oauth-scopes") ?? "";
  const scopeSet = new Set(scopes.split(",").map((scope) => scope.trim()).filter(Boolean));
  if (!scopeSet.has("delete_repo")) {
    throw new Error(
      "GitHub live smoke requires a token with delete_repo scope so the temporary repo can be cleaned up. "
      + "Set THREADBEAT_GITHUB_LIVE_SMOKE_KEEP=1 to intentionally keep the repo.",
    );
  }
}

function githubRepoPathFromRemoteUrl(remoteUrl: string | null): string {
  if (!remoteUrl) throw new Error("GitHub smoke did not return a remote URL");
  const parsed = new URL(remoteUrl);
  return parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
}
