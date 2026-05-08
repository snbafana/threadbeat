import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGENT_TEMPLATE_FILES,
  copyAgentTemplate,
  writeRunInput,
} from "../src/agentTemplate.js";
import { runFakeAgentExecutor } from "../src/agentFakeExecutor.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-agent-local-"));
const repoPath = path.join(tempRoot, "agent-repo");

const templateResult = await copyAgentTemplate(repoPath);
assert.deepEqual([...templateResult.created].sort(), [...AGENT_TEMPLATE_FILES].sort());
assert.deepEqual(templateResult.skipped, []);
assert.deepEqual(templateResult.overwritten, []);

for (const relativePath of AGENT_TEMPLATE_FILES) {
  await assertFileExists(path.join(repoPath, relativePath));
}

const settings = JSON.parse(
  await fs.readFile(path.join(repoPath, ".pi", "settings.json"), "utf8"),
) as Record<string, unknown>;
assert.equal(settings.prompt, ".pi/prompts/heartbeat.md");
assert.equal(settings.input, "work/inputs/task.md");
assert.equal(settings.output, "work/outputs/result.md");

await fs.writeFile(path.join(repoPath, "AGENTS.md"), "custom agent instructions\n", "utf8");
const secondTemplateResult = await copyAgentTemplate(repoPath);
assert.ok(secondTemplateResult.skipped.includes("AGENTS.md"));
assert.equal(await fs.readFile(path.join(repoPath, "AGENTS.md"), "utf8"), "custom agent instructions\n");

const inputResult = await writeRunInput(repoPath, {
  objective: "Prove local E2E works without Pi.",
  metadata: { runId: "run_local_1", priority: 2 },
});
assert.equal(inputResult.relativePath, "work/inputs/task.md");

const taskMarkdown = await fs.readFile(inputResult.inputPath, "utf8");
assert.match(taskMarkdown, /## Objective\n\nProve local E2E works without Pi\./);
assert.match(taskMarkdown, /"runId": "run_local_1"/);

const executorResult = await runFakeAgentExecutor(repoPath, {
  now: new Date("2026-05-08T12:00:00.000Z"),
});
assert.equal(executorResult.status, "succeeded");
assert.equal(executorResult.objective, "Prove local E2E works without Pi.");
assert.deepEqual(executorResult.metadata, { runId: "run_local_1", priority: 2 });

const resultMarkdown = await fs.readFile(path.join(repoPath, "work", "outputs", "result.md"), "utf8");
assert.match(resultMarkdown, /# Threadbeat fake executor result/);
assert.match(resultMarkdown, /executor: threadbeat-fake-executor/);
assert.match(resultMarkdown, /local E2E output without Pi/);

const summary = JSON.parse(
  await fs.readFile(path.join(repoPath, "work", "outputs", "run-summary.json"), "utf8"),
) as Record<string, unknown>;
assert.equal(summary.status, "succeeded");
assert.equal(summary.completedAt, "2026-05-08T12:00:00.000Z");
assert.equal(summary.objective, "Prove local E2E works without Pi.");

await assert.rejects(
  runFakeAgentExecutor(path.join(tempRoot, "missing-input-repo")),
  /Missing run input/,
);

async function assertFileExists(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  assert.equal(stat.isFile(), true);
}
