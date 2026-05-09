import assert from "node:assert/strict";

import {
  isValidAgentVersionName,
  isValidBranchName,
  planEditBranch,
  planRunBranch,
  validateAgentVersionName,
  validateBranchName,
  versionBranch,
} from "../src/agentService.js";

const fixedNow = new Date("2026-05-08T14:15:16.789Z");

const runPlan = planRunBranch({
  currentVersion: "v0.3",
  objective: "  Build a local DB + Git planning loop!  ",
  runId: "run_123",
  now: fixedNow,
});

assert.deepEqual(runPlan, {
  kind: "run",
  objective: "Build a local DB + Git planning loop!",
  inputBranch: "threadbeat/versions/v0.3",
  runBranch: "threadbeat/runs/v0.3/20260508T141516Z-run-123-build-a-local-db-git-planning-loop",
  metadata: {
    timestamp: "20260508T141516Z",
    runId: "run-123",
    objectiveSlug: "build-a-local-db-git-planning-loop",
  },
});

const sameRunPlanFromStringDate = planRunBranch({
  currentVersion: "v0.3",
  objective: "Build a local DB + Git planning loop!",
  runId: "run_123",
  now: "2026-05-08T14:15:16.789Z",
});

assert.equal(sameRunPlanFromStringDate.runBranch, runPlan.runBranch);

const editPlan = planEditBranch({
  fromVersion: "v0.3",
  toVersion: "v0.4-alpha",
  objective: "Ship runtime abstraction",
  runId: "edit/456",
  now: fixedNow,
});

assert.deepEqual(editPlan, {
  kind: "edit",
  objective: "Ship runtime abstraction",
  inputBranch: "threadbeat/versions/v0.3",
  runBranch: "threadbeat/edits/v0.3-to-v0.4-alpha/20260508T141516Z-edit-456-ship-runtime-abstraction",
  outputBranch: "threadbeat/versions/v0.4-alpha",
  metadata: {
    timestamp: "20260508T141516Z",
    runId: "edit-456",
    objectiveSlug: "ship-runtime-abstraction",
  },
});

assert.equal(versionBranch("release_2026.05"), "threadbeat/versions/release_2026.05");

assert.equal(isValidBranchName("threadbeat/runs/v0.3/ok"), true);
assert.equal(isValidBranchName("threadbeat//runs"), false);
assert.equal(isValidBranchName("threadbeat/runs/feature..bad"), false);
assert.equal(isValidBranchName("threadbeat/runs/bad.lock"), false);
assert.equal(isValidBranchName("threadbeat/runs/bad branch"), false);
assert.equal(isValidBranchName("-threadbeat/runs/bad"), false);

assert.equal(isValidAgentVersionName("v0.4-alpha_1"), true);
assert.equal(isValidAgentVersionName("bad/version"), false);
assert.equal(isValidAgentVersionName("bad version"), false);
assert.equal(isValidAgentVersionName("bad..version"), false);
assert.equal(isValidAgentVersionName("bad.lock"), false);

assert.throws(() => validateBranchName("bad branch"), /invalid branch name/);
assert.throws(() => validateAgentVersionName("bad/version"), /invalid agent version name/);
assert.throws(
  () => planRunBranch({
    currentVersion: "v0.3",
    objective: "   ",
    runId: "run_123",
    now: fixedNow,
  }),
  /objective must be a non-empty string/,
);
assert.throws(
  () => planEditBranch({
    fromVersion: "v0.3",
    toVersion: "bad/version",
    objective: "Ship runtime abstraction",
    runId: "edit/456",
    now: fixedNow,
  }),
  /invalid agent version name/,
);
