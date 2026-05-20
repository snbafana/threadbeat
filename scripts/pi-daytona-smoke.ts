import assert from "node:assert/strict";

import * as sandbox from "../src/daytonaProvider.js";
import {
  installSamplePiRepoCommand,
  materializeSamplePiRepoCommand,
  piFixture,
  piInjectionCheckCommand,
  requireDeepseekKey,
  samplePiRepoPath,
} from "./smoke-helpers.js";

const deepseekKey = requireDeepseekKey();

const results = [];

results.push(await cloneAndDeletePlainRepo());
results.push(await cloneCurrentRepoAndCheckSamplePiInjection());

console.log(JSON.stringify({ ok: true, results }, null, 2));

async function cloneAndDeletePlainRepo() {
  const sandboxId = await sandbox.createSandbox({});
  let deleted = false;
  try {
    await sandbox.cloneRepo(sandboxId, "https://github.com/octocat/Hello-World.git", "master");
    const readme = await sandbox.runCommand(
      sandboxId,
      "pwd && (test -f README || test -f README.md) && git rev-parse --is-inside-work-tree",
      "workspace/repo",
      {},
      60,
    );
    assert.equal(readme.exitCode, 0, readme.stdout);
    assert.match(readme.stdout, /true/);
    return { name: "plain clone/delete", sandboxId, cloned: true, deleted: true };
  } finally {
    await sandbox.deleteSandbox(sandboxId);
    deleted = true;
    assert.equal(deleted, true);
  }
}

async function cloneCurrentRepoAndCheckSamplePiInjection() {
  const sandboxId = await sandbox.createSandbox({ DEEPSEEK_API_KEY: deepseekKey ?? "" });
  let deleted = false;
  try {
    await sandbox.cloneRepo(sandboxId, piFixture.repoUrl, piFixture.branch);
    const shape = await sandbox.runCommand(
      sandboxId,
      [
        "git rev-parse --is-inside-work-tree",
        "test -f package.json",
        "test -d src",
        "node --version",
        "npm --version",
      ].join(" && "),
      "workspace/repo",
      {},
      60,
    );
    assert.equal(shape.exitCode, 0, shape.stdout);

    const fixture = await sandbox.runCommand(
      sandboxId,
      materializeSamplePiRepoCommand(),
      "workspace/repo",
      {},
      60,
    );
    assert.equal(fixture.exitCode, 0, fixture.stdout);
    assert.match(fixture.stdout, /sample-pi-repo-created/);

    const node = await sandbox.runCommand(
      sandboxId,
      installSamplePiRepoCommand(),
      "workspace/repo",
      {},
      300,
    );
    assert.equal(node.exitCode, 0, node.stdout);
    assert.match(node.stdout, /v2[2-9]\./);

    const piCheck = await sandbox.runCommand(
      sandboxId,
      piInjectionCheckCommand(),
      samplePiRepoPath,
      { DEEPSEEK_API_KEY: deepseekKey ?? "" },
      240,
    );
    assert.equal(piCheck.exitCode, 0, piCheck.stdout);
    assert.match(piCheck.stdout, /pi-auth-ok/);

    return { name: "sample pi repo with credential injection", sandboxId, cloned: true, injected: true, deleted: true };
  } finally {
    await sandbox.deleteSandbox(sandboxId);
    deleted = true;
    assert.equal(deleted, true);
  }
}
