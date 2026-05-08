import "dotenv/config";

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runPiAgentExecutor } from "../src/agentPiExecutor.js";
import { copyAgentTemplate, writeRunInput } from "../src/agentTemplate.js";
import { loadSettings } from "../src/config.js";

if (process.env.THREADBEAT_LIVE_PI_AGENT_TEST !== "1") {
  console.log("Skipping live Pi agent executor smoke; set THREADBEAT_LIVE_PI_AGENT_TEST=1 to run.");
  process.exit(0);
}

const settings = loadSettings();
assert.ok(settings.deepseekApiKey, "DEEPSEEK_API_KEY is required for live Pi agent executor smoke");

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-live-pi-agent-"));
const repoPath = path.join(tempRoot, "agent-repo");
const keepRepo = process.env.THREADBEAT_KEEP_LIVE_PI_AGENT_REPO === "1";

try {
  console.log(`Running live Pi agent executor smoke in ${repoPath}`);
  await copyAgentTemplate(repoPath);
  await writeRunInput(repoPath, {
    objective: [
      "This is a live Threadbeat Pi executor smoke test.",
      "Read this task and write a short confirmation to work/outputs/result.md.",
      "The result file must include the exact phrase: live pi executor smoke passed.",
    ].join(" "),
    metadata: { test: "agentPiExecutor.live" },
  });

  const result = await runPiAgentExecutor({
    projectRoot: settings.projectRoot,
    repoPath,
    provider: settings.piProvider,
    model: settings.piModel,
    thinking: settings.piThinking,
    apiKey: settings.deepseekApiKey,
    timeoutMs: Math.max(settings.runTimeoutMs, 120_000),
  });

  assert.equal(result.status, "succeeded");
  const output = await fs.readFile(path.join(repoPath, "work", "outputs", "result.md"), "utf8");
  assert.match(output.toLowerCase(), /live pi executor smoke passed/);
  assert.match(result.assistantText, /work\/outputs\/result\.md/);

  console.log("Live Pi agent executor smoke passed.");
  console.log(`Pi session: ${result.sessionId}`);
  console.log(`Output file: ${path.join(repoPath, "work", "outputs", "result.md")}`);
  console.log(`Output preview:\n${output.trim()}`);
} finally {
  if (keepRepo) {
    console.log(`Kept live smoke repo at ${repoPath}`);
  } else {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
