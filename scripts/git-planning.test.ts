import assert from "node:assert/strict";

import { getAgentRepositoryMetadata, planRunBranch } from "../src/agentRepository.js";
import { isValidBranchName, isValidGitRef, validateBranchName, validateGitRef } from "../src/git.js";
import { deriveGitHubLinks, parseGitHubHttpsRepoUrl } from "../src/gitLinks.js";

const agent = {
  id: "agt_testagent",
  name: "Research Agent",
  repo_url: "https://github.com/example/threadbeat-agent.git",
  current_ref: "feature/input-cleanup",
};

assert.equal(isValidBranchName("main"), true);
assert.equal(isValidBranchName("feature/input-cleanup"), true);
assert.equal(isValidBranchName("refs/heads/main"), false);
assert.equal(validateBranchName("bad..branch").ok, false);
assert.equal(validateBranchName("-bad").ok, false);
assert.equal(validateBranchName("bad branch").ok, false);

assert.equal(isValidGitRef("HEAD"), true);
assert.equal(isValidGitRef("refs/tags/v1.2.3"), true);
assert.equal(isValidGitRef("9fceb02a2e033b3d8d648f8c879b0ace0b534bb7"), true);
assert.equal(validateGitRef("refs/pull/1/head").ok, false);
assert.equal(validateGitRef("feature@{bad").ok, false);

assert.deepEqual(parseGitHubHttpsRepoUrl("https://github.com/example/threadbeat-agent.git"), {
  owner: "example",
  repo: "threadbeat-agent",
  webUrl: "https://github.com/example/threadbeat-agent",
});
assert.equal(parseGitHubHttpsRepoUrl("file:///tmp/threadbeat-agent.git"), null);
assert.equal(parseGitHubHttpsRepoUrl("/tmp/threadbeat-agent"), null);

assert.deepEqual(deriveGitHubLinks("file:///tmp/threadbeat-agent.git", {
  commitRef: "9fceb02a2e033b3d8d648f8c879b0ace0b534bb7",
  compareBaseRef: "main",
  compareHeadRef: "threadbeat/runs/example",
  treeRef: "main",
}), {
  commitUrl: null,
  compareUrl: null,
  repoUrl: null,
  treeUrl: null,
});

assert.deepEqual(deriveGitHubLinks(agent.repo_url, {
  commitRef: "9fceb02a2e033b3d8d648f8c879b0ace0b534bb7",
  compareBaseRef: "main",
  compareHeadRef: "threadbeat/runs/example",
  treeRef: "feature/input-cleanup",
}), {
  commitUrl: "https://github.com/example/threadbeat-agent/commit/9fceb02a2e033b3d8d648f8c879b0ace0b534bb7",
  compareUrl: "https://github.com/example/threadbeat-agent/compare/main...threadbeat/runs/example",
  repoUrl: "https://github.com/example/threadbeat-agent",
  treeUrl: "https://github.com/example/threadbeat-agent/tree/feature/input-cleanup",
});

assert.deepEqual(getAgentRepositoryMetadata(agent), {
  agentId: "agt_testagent",
  currentRef: "feature/input-cleanup",
  currentTreeUrl: "https://github.com/example/threadbeat-agent/tree/feature/input-cleanup",
  name: "Research Agent",
  repoUrl: "https://github.com/example/threadbeat-agent.git",
  repoWebUrl: "https://github.com/example/threadbeat-agent",
});

const plan = planRunBranch({
  agent,
  now: new Date("2026-05-08T12:34:56.789Z"),
  objective: "Add Git planning!",
  runId: "run_123",
});

assert.equal(
  plan.branchName,
  "threadbeat/runs/20260508T123456789z/agt_testagent/run_123-add_git_planning",
);

console.log("git planning tests passed");
