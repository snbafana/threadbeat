import "dotenv/config";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import { buildServer } from "../src/server.js";
import { DEFAULT_GITHUB_OWNER, DEFAULT_GITHUB_OWNER_TYPE } from "../src/config.js";
import { cliJsonLarge as cliJson, stopRunSandboxes } from "./cli-smoke-utils.js";
import { createScriptTempRoot, removeScriptTempRoot, scriptSettings } from "./settings-utils.js";
import {
  assertCanCleanUpSmokeRepo,
  deleteGitHubRepoIfCreated,
  getGitHubFile,
  githubRepoPath,
  resolveGitHubToken,
} from "./github-smoke-utils.js";

const githubOwner = DEFAULT_GITHUB_OWNER;
const githubOwnerType = DEFAULT_GITHUB_OWNER_TYPE;
const githubToken = resolveGitHubToken();

if (!githubToken) {
  console.log("GitHub agent init CLI live smoke skipped: gh auth token is not available");
  process.exit(0);
}

await assertCanCleanUpSmokeRepo(githubToken, "GitHub agent init CLI live smoke");

const tempRoot = await createScriptTempRoot("threadbeat-github-agent-init-cli-smoke");
const repoId = `threadbeat-agent-init-cli-${Date.now().toString(36)}`;
const settings = scriptSettings({
  modalAppName: "threadbeat-github-agent-init-cli-live-smoke",
  tempRoot,
  overrides: {
    githubOwner,
    githubOwnerType,
    githubToken,
  },
});

const { app } = await buildServer(settings);
let repoPath: string | undefined;

try {
  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const initialized = await cliJson<{
    agent: { id: string; repo_url: string };
    hostedRepo: { namespace: string; providerRepoId: string };
    initialized: { commitSha: string; filesWritten: string[] } | null;
  }>(baseUrl, [
    "agents",
    "init",
    "--name",
    "GitHub Agent Init CLI Smoke",
    "--id",
    repoId,
    "--repo-id",
    repoId,
  ]);

  assert.equal(initialized.hostedRepo.namespace, githubOwner);
  assert.equal(initialized.hostedRepo.providerRepoId, repoId);
  assert.match(initialized.agent.repo_url, new RegExp(`github.com/${githubOwner}/${repoId}\\.git`));
  assert.match(initialized.initialized?.commitSha ?? "", /^[a-f0-9]{40}$/);
  assert.ok(initialized.initialized?.filesWritten.includes("AGENTS.md"));
  repoPath = githubRepoPath(githubOwner, repoId);

  const agentsMd = await getGitHubFile(githubToken, repoPath, "AGENTS.md");
  assert.match(agentsMd, /GitHub Agent Init CLI Smoke/);
  assert.match(agentsMd, /Self-Improvement Rules/);

  const stepped = await cliJson<{
    bootstrap?: Array<{ command: string[]; exitCode: number }>;
    result: { exitCode: number; stdout: string };
    status: { run: { id: string }; sandboxes: Array<{ state: string }> };
  }>(baseUrl, [
    "runs",
    "step",
    "--agent",
    initialized.agent.id,
    "--objective",
    "bootstrap initialized agent",
    "--bootstrap",
    "--cwd",
    "/workspace/agent",
    "--",
    "test -f AGENTS.md && test -d .pi/prompts && git status --short --branch",
  ]);
  assert.equal(stepped.result.exitCode, 0);
  assert.match(stepped.result.stdout, /\[dry-run\]/);
  assert.match(stepped.result.stdout, /test -f AGENTS\.md/);
  const bootstrap = stepped.bootstrap ?? [];
  assert.ok(bootstrap.every((result) => result.exitCode === 0));
  assert.ok(bootstrap.some((result) => result.command.join(" ").includes("git clone")));
  assert.ok(bootstrap.some((result) => result.command.join(" ").includes("git -C /workspace/agent push -u origin HEAD:threadbeat/runs/")));
  assert.ok(stepped.status.sandboxes.some((sandbox) => sandbox.state === "running"));

  const cleanup = await stopRunSandboxes(baseUrl, stepped.status.run.id);
  assert.equal(cleanup.stoppedCount, 1);
} finally {
  await app.close();
  await removeScriptTempRoot(tempRoot);
  await deleteGitHubRepoIfCreated(githubToken, repoPath);
}

console.log(JSON.stringify({
  repoPath,
}, null, 2));
