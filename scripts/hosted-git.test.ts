import assert from "node:assert/strict";

import { GitHubHostedGitProvider, normalizeGitHubRepoName, redactHostedGitRemoteUrl } from "../src/hostedGit.js";
import { RateLimitGuard } from "../src/rateLimit.js";
import { scriptSettings } from "./settings-utils.js";

const settings = scriptSettings({
  modalAppName: "threadbeat-hosted-git-test",
  overrides: { githubOwner: "threadbeat-test" },
});

const githubProvider = new GitHubHostedGitProvider(settings);
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
    current_ref: "main",
  },
  dryRun: true,
  repoId: "github-agent-store",
});

assert.deepEqual(githubRepo, {
  defaultBranch: "main",
  namespace: "threadbeat-test",
  providerRepoId: "github-agent-store",
  remoteUrl: "https://x-access-token:DRY_RUN_TOKEN@github.com/threadbeat-test/github-agent-store.git",
  remoteUrlRedacted: "https://x-access-token:REDACTED@github.com/threadbeat-test/github-agent-store.git",
});
const githubClone = await githubProvider.getCloneUrl({
  namespace: "threadbeat-test",
  repoId: "github-agent-store",
});
assert.deepEqual(githubClone, {
  remoteUrl: "https://x-access-token:DRY_RUN_TOKEN@github.com/threadbeat-test/github-agent-store.git",
  remoteUrlRedacted: "https://x-access-token:REDACTED@github.com/threadbeat-test/github-agent-store.git",
});

let now = 0;
const liveFetchCalls: Array<{ body: unknown; headers: Record<string, string>; method: string; url: string }> = [];
const liveProvider = new GitHubHostedGitProvider({
  ...settings,
  githubOwnerType: "org",
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
    name: "github-agent-live-store",
  }), { status: 201 });
});

const liveRepo = await liveProvider.createRepository({
  agent: {
    id: "agt_github_live",
    name: "GitHub Live Agent",
    repo_url: "https://github.com/example/github-agent.git",
    current_ref: "main",
  },
  dryRun: false,
  repoId: "github-agent-live-store",
});
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

const autoUserFetchCalls: Array<{ url: string }> = [];
const autoUserProvider = new GitHubHostedGitProvider({
  ...settings,
  githubOwner: "threadbeat-test",
  githubOwnerType: "auto",
  githubToken: "token",
}, new RateLimitGuard(() => 20_000), async (url) => {
  autoUserFetchCalls.push({ url: String(url) });
  if (String(url) === "https://api.github.com/user") {
    return new Response(JSON.stringify({ login: "threadbeat-test" }), { status: 200 });
  }
  return new Response(JSON.stringify({
    full_name: "threadbeat-test/auto-user-repo",
    name: "auto-user-repo",
  }), { status: 201 });
});
await autoUserProvider.createRepository({
  agent: {
    id: "agt_auto_user",
    name: "GitHub Auto User Agent",
    repo_url: "https://github.com/example/github-agent.git",
    current_ref: "main",
  },
  dryRun: false,
  repoId: "auto-user-repo",
});
assert.deepEqual(autoUserFetchCalls.map((call) => call.url), [
  "https://api.github.com/user",
  "https://api.github.com/user/repos",
]);

const autoOrgFetchCalls: Array<{ url: string }> = [];
const autoOrgProvider = new GitHubHostedGitProvider({
  ...settings,
  githubOwner: "threadbeat-org",
  githubOwnerType: "auto",
  githubToken: "token",
}, new RateLimitGuard(() => 30_000), async (url) => {
  autoOrgFetchCalls.push({ url: String(url) });
  if (String(url) === "https://api.github.com/user") {
    return new Response(JSON.stringify({ login: "threadbeat-user" }), { status: 200 });
  }
  return new Response(JSON.stringify({
    full_name: "threadbeat-org/auto-org-repo",
    name: "auto-org-repo",
  }), { status: 201 });
});
await autoOrgProvider.createRepository({
  agent: {
    id: "agt_auto_org",
    name: "GitHub Auto Org Agent",
    repo_url: "https://github.com/example/github-agent.git",
    current_ref: "main",
  },
  dryRun: false,
  repoId: "auto-org-repo",
});
assert.deepEqual(autoOrgFetchCalls.map((call) => call.url), [
  "https://api.github.com/user",
  "https://api.github.com/orgs/threadbeat-org/repos",
]);

await assert.rejects(
  () => liveProvider.createRepository({
    agent: {
      id: "agt_github_live_2",
      name: "GitHub Live Agent 2",
      repo_url: "https://github.com/example/github-agent.git",
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
    current_ref: "main",
  },
  dryRun: false,
  repoId: "github-agent-live-store-3",
});
assert.equal(thirdRepo.providerRepoId, "github-agent-live-store");

console.log("hosted git tests passed");
