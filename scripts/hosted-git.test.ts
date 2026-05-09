import assert from "node:assert/strict";

import { GitHubHostedGitProvider, createHostedGitProvider, normalizeGitHubRepoName, redactHostedGitRemoteUrl } from "../src/hostedGit.js";
import { RateLimitGuard } from "../src/rateLimit.js";
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

let now = 0;
const liveFetchCalls: Array<{ body: unknown; headers: Record<string, string>; method: string; url: string }> = [];
const liveProvider = new GitHubHostedGitProvider({
  ...githubSettings,
  githubToken: "token",
}, new RateLimitGuard(() => now), async (url, init) => {
  liveFetchCalls.push({
    body: JSON.parse(String(init?.body)),
    headers: init?.headers as Record<string, string>,
    method: init?.method ?? "GET",
    url: String(url),
  });
  return new Response(JSON.stringify({
    full_name: "threadbeat-test/github-agent-live-store",
    html_url: "https://github.com/threadbeat-test/github-agent-live-store",
    name: "github-agent-live-store",
  }), { status: 201 });
});

const liveRepo = await liveProvider.createRepository({
  agent: {
    id: "agt_github_live",
    name: "GitHub Live Agent",
    repo_url: "https://github.com/example/github-agent.git",
    default_branch: "main",
    current_ref: "main",
  },
  dryRun: false,
  repoId: "github-agent-live-store",
});
assert.equal(liveRepo.live, true);
assert.equal(liveRepo.remoteUrlRedacted, "https://x-access-token:REDACTED@github.com/threadbeat-test/github-agent-live-store.git");
assert.equal(liveFetchCalls.length, 1);
assert.deepEqual(liveFetchCalls[0]?.body, {
  auto_init: false,
  name: "github-agent-live-store",
  private: true,
});
assert.equal(liveFetchCalls[0]?.headers.authorization, "Bearer token");
assert.equal(liveFetchCalls[0]?.method, "POST");
assert.equal(liveFetchCalls[0]?.url, "https://api.github.com/orgs/threadbeat-test/repos");

await assert.rejects(
  () => liveProvider.createRepository({
    agent: {
      id: "agt_github_live_2",
      name: "GitHub Live Agent 2",
      repo_url: "https://github.com/example/github-agent.git",
      default_branch: "main",
      current_ref: "main",
    },
    dryRun: false,
    repoId: "github-agent-live-store-2",
  }),
  /hosted Git rate limit blocked request/,
);

now = 10_000;
const thirdRepo = await liveProvider.createRepository({
  agent: {
    id: "agt_github_live_3",
    name: "GitHub Live Agent 3",
    repo_url: "https://github.com/example/github-agent.git",
    default_branch: "main",
    current_ref: "main",
  },
  dryRun: false,
  repoId: "github-agent-live-store-3",
});
assert.equal(thirdRepo.live, true);

console.log("hosted git tests passed");
