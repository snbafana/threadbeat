import assert from "node:assert/strict";

import { buildAgentBootPlan } from "../src/agentBoot.js";

const plan = buildAgentBootPlan({
  objective: "continue research on git-backed agents",
  runId: "run_123",
});

assert.equal(plan.promptPath, ".pi/prompts/heartbeat.md");
assert.equal(plan.taskPath, "tasks/inbox/run_123.md");
assert.deepEqual(plan.command.slice(0, 2), ["bash", "-lc"]);
assert.match(plan.command[2] ?? "", /cat > 'tasks\/inbox\/run_123\.md'/);
assert.match(plan.command[2] ?? "", /continue research on git-backed agents/);
assert.match(plan.command[2] ?? "", /command -v pi/);
assert.match(plan.command[2] ?? "", /pi --prompt-file '\.pi\/prompts\/heartbeat\.md' --message-file 'tasks\/inbox\/run_123\.md'/);

const customPlan = buildAgentBootPlan({
  objective: "self review",
  promptPath: ".pi/prompts/self-review.md",
  runId: "run_custom",
  taskPath: "tasks/inbox/self-review.md",
});

assert.equal(customPlan.promptPath, ".pi/prompts/self-review.md");
assert.equal(customPlan.taskPath, "tasks/inbox/self-review.md");

assert.throws(
  () => buildAgentBootPlan({ objective: "bad", promptPath: "/tmp/prompt.md", runId: "run_123" }),
  /relative repo path/,
);
assert.throws(
  () => buildAgentBootPlan({ objective: "bad", runId: "../run" }),
  /unsafe path characters/,
);

console.log("agent boot tests passed");
