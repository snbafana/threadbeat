import assert from "node:assert/strict";

import { buildAgentBootPlan, buildAgentRuntimeCheckPlan } from "../src/agentBoot.js";

const plan = buildAgentBootPlan({
  objective: "continue research on git-backed agents",
  runId: "run_123",
});

assert.equal(plan.promptPath, ".pi/prompts/heartbeat.md");
assert.equal(plan.piCommand, "pi");
assert.equal(plan.piExecutable, "pi");
assert.equal(plan.piProvider, "deepseek");
assert.equal(plan.piModel, "deepseek-v4-flash");
assert.equal(plan.piApiKeyEnv, "DEEPSEEK_API_KEY");
assert.equal(plan.taskPath, "tasks/inbox/run_123.md");
assert.deepEqual(plan.command.slice(0, 2), ["bash", "-lc"]);
assert.match(plan.command[2] ?? "", /test -f '\.pi\/prompts\/heartbeat\.md'/);
assert.match(plan.command[2] ?? "", /cat > 'tasks\/inbox\/run_123\.md'/);
assert.match(plan.command[2] ?? "", /continue research on git-backed agents/);
assert.match(plan.command[2] ?? "", /command -v 'pi'/);
assert.match(plan.command[2] ?? "", /DEEPSEEK_API_KEY is not set/);
assert.match(plan.command[2] ?? "", /cat > "\$HOME\/\.pi\/agent\/models\.json"/);
assert.match(plan.command[2] ?? "", /"baseUrl": "https:\/\/api\.deepseek\.com"/);
assert.match(plan.command[2] ?? "", /cat '\.pi\/prompts\/heartbeat\.md'/);
assert.match(plan.command[2] ?? "", /cat 'tasks\/inbox\/run_123\.md'/);
assert.match(plan.command[2] ?? "", /pi --provider 'deepseek' --model 'deepseek-v4-flash' --api-key "\$DEEPSEEK_API_KEY" --mode json -p/);

const customPlan = buildAgentBootPlan({
  agentPiApiKeyEnv: "CUSTOM_API_KEY",
  agentPiCommand: "npx --yes @example/pi",
  agentPiModel: "custom-model",
  agentPiProvider: "custom-provider",
  objective: "self review",
  promptPath: ".pi/prompts/self-review.md",
  runId: "run_custom",
  taskPath: "tasks/inbox/self-review.md",
});

assert.equal(customPlan.promptPath, ".pi/prompts/self-review.md");
assert.equal(customPlan.piCommand, "npx --yes @example/pi");
assert.equal(customPlan.piExecutable, "npx");
assert.equal(customPlan.piProvider, "custom-provider");
assert.equal(customPlan.piModel, "custom-model");
assert.equal(customPlan.piApiKeyEnv, "CUSTOM_API_KEY");
assert.equal(customPlan.taskPath, "tasks/inbox/self-review.md");

assert.throws(
  () => buildAgentBootPlan({ objective: "bad", promptPath: "/tmp/prompt.md", runId: "run_123" }),
  /relative repo path/,
);
assert.throws(
  () => buildAgentBootPlan({ objective: "bad", runId: "../run" }),
  /unsafe path characters/,
);
assert.throws(
  () => buildAgentBootPlan({ agentPiCommand: "pi\nrm -rf /", objective: "bad", runId: "run_123" }),
  /single shell command line/,
);
assert.throws(
  () => buildAgentBootPlan({ agentPiApiKeyEnv: "BAD-NAME", objective: "bad", runId: "run_123" }),
  /shell env variable name/,
);

const runtimeCheck = buildAgentRuntimeCheckPlan({ agentPiCommand: "pi" });
assert.equal(runtimeCheck.piCommand, "pi");
assert.match(runtimeCheck.command[2] ?? "", /test -f AGENTS\.md/);
assert.match(runtimeCheck.command[2] ?? "", /test -f \.pi\/prompts\/heartbeat\.md/);
assert.match(runtimeCheck.command[2] ?? "", /command -v 'pi'/);
assert.match(runtimeCheck.command[2] ?? "", /cat > "\$HOME\/\.pi\/agent\/models\.json"/);
assert.match(runtimeCheck.command[2] ?? "", /pi --list-models 'deepseek' \| grep -F 'deepseek-v4-flash'/);
assert.match(runtimeCheck.command[2] ?? "", /agent runtime ready/);

const customRuntimeCheck = buildAgentRuntimeCheckPlan({
  agentPiCommand: "npx --yes @example/pi",
  agentPiProvider: "custom-provider",
  agentPiModel: "custom-model",
});
assert.match(customRuntimeCheck.command[2] ?? "", /command -v 'npx'/);
assert.match(customRuntimeCheck.command[2] ?? "", /npx --yes @example\/pi --list-models 'custom-provider' \| grep -F 'custom-model'/);
assert.match(customRuntimeCheck.command[2] ?? "", /npx --yes @example\/pi --help/);

console.log("agent boot tests passed");
