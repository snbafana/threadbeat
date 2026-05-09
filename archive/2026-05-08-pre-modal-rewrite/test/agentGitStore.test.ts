import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  commitAll,
  createAgentVersionBranch,
  createEditBranch,
  createRunBranch,
  currentBranch,
  currentCommit,
  diff,
  ensureAgentRepo,
  mergeBranchToNewVersion,
  normalizeBranchName,
  runGit,
} from "../src/agentGitStore.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-git-store-"));
const repoPath = path.join(tempRoot, "agent-repo");
const runAt = new Date("2026-05-08T12:00:00.000Z");
const editAt = new Date("2026-05-08T12:05:00.000Z");

try {
  assert.equal(normalizeBranchName(" Agent v1.0 / Draft! "), "agent_v1.0_draft");
  assert.equal(normalizeBranchName("@{bad}..lock"), "bad__lock");

  const repoState = await ensureAgentRepo(repoPath);
  assert.equal(repoState.initialized, true);
  assert.equal(repoState.currentBranch, "main");

  await runGit(repoPath, ["config", "user.name", "Threadbeat Test"]);
  await runGit(repoPath, ["config", "user.email", "threadbeat-test@example.com"]);

  await fs.writeFile(path.join(repoPath, "notes.md"), "# Agent\n");
  const initialCommit = await commitAll(repoPath, "Initial agent contents");
  assert.equal(initialCommit.status, "committed");
  assert.match(initialCommit.hash, /^[0-9a-f]{40}$/);

  const noopCommit = await commitAll(repoPath, "Nothing to commit");
  assert.equal(noopCommit.status, "noop");
  assert.equal(noopCommit.reason, "no_changes");
  assert.equal(noopCommit.hash, initialCommit.hash);

  const versionBranch = await createAgentVersionBranch(repoPath, "Agent v1.0");
  assert.equal(versionBranch, "agent_v1.0");
  assert.equal(await currentBranch(repoPath), versionBranch);

  const runBranch = await createRunBranch(repoPath, {
    fromBranch: versionBranch,
    now: runAt,
    objectiveSlug: "Fix agent loop",
    runId: "run_ignored_when_slug_exists",
  });
  assert.equal(runBranch, "run_20260508t120000000z_fix_agent_loop__from_agent_v1.0");
  assert.equal(await currentBranch(repoPath), runBranch);

  await fs.appendFile(path.join(repoPath, "notes.md"), "\nRun branch update.\n");
  const runCommit = await commitAll(repoPath, "Run branch update");
  assert.equal(runCommit.status, "committed");

  const runDiff = await diff(repoPath, versionBranch, runBranch);
  assert.match(runDiff, /\+Run branch update\./);

  const editBranch = await createEditBranch(repoPath, {
    fromBranch: runBranch,
    now: editAt,
    objectiveSlug: "Promote result",
    toBranch: "Agent v2.0",
  });
  assert.equal(
    editBranch,
    "edit_20260508t120500000z_promote_result__run_20260508t120000000z_fix_agent_loop__from_agent_v1.0_to_agent_v2.0",
  );
  assert.equal(await currentBranch(repoPath), editBranch);

  await fs.appendFile(path.join(repoPath, "notes.md"), "Edit branch update.\n");
  const editCommit = await commitAll(repoPath, "Edit branch update");
  assert.equal(editCommit.status, "committed");

  const createVersionMerge = await mergeBranchToNewVersion(repoPath, {
    sourceBranch: editBranch,
    targetVersionBranch: "Agent v2.0",
  });
  assert.equal(createVersionMerge.status, "created");
  assert.equal(createVersionMerge.targetVersionBranch, "agent_v2.0");
  assert.equal(createVersionMerge.hash, editCommit.hash);
  assert.equal(await currentCommit(repoPath, "agent_v2.0"), editCommit.hash);

  const upToDateMerge = await mergeBranchToNewVersion(repoPath, {
    sourceBranch: editBranch,
    targetVersionBranch: "Agent v2.0",
  });
  assert.equal(upToDateMerge.status, "up_to_date");
  assert.equal(upToDateMerge.hash, editCommit.hash);
} finally {
  await fs.rm(tempRoot, { force: true, recursive: true });
}
