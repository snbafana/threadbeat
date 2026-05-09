import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPiAgentPrompt,
  runPiAgentExecutor,
  type PiAgentSessionFactory,
} from "../src/agentPiExecutor.js";
import { copyAgentTemplate, writeRunInput } from "../src/agentTemplate.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-pi-executor-"));
const repoPath = path.join(tempRoot, "agent-repo");
const prompts: string[] = [];

try {
  await copyAgentTemplate(repoPath);
  await writeRunInput(repoPath, {
    objective: "Prove the Pi executor contract.",
    metadata: { runId: "run_pi_executor" },
  });

  const sessionFactory: PiAgentSessionFactory = async (options) => ({
    sessionId: "pi_session_test",
    messages: [],
    async prompt(text: string): Promise<void> {
      prompts.push(text);
      assert.equal(options.repoPath, repoPath);
      assert.equal(options.provider, "deepseek");
      assert.equal(options.model, "deepseek-v4-flash");
      await fs.mkdir(path.join(options.repoPath, "work", "outputs"), { recursive: true });
      await fs.writeFile(
        path.join(options.repoPath, "work", "outputs", "result.md"),
        "# Pi executor result\n\nThe injected session wrote the required output file.\n",
        "utf8",
      );
    },
    getLastAssistantText: () => "Wrote work/outputs/result.md",
    dispose: () => undefined,
  });

  const result = await runPiAgentExecutor({
    projectRoot: path.resolve("."),
    repoPath,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinking: "off",
    timeoutMs: 5_000,
    sessionFactory,
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.executor, "pi-sdk");
  assert.equal(result.sessionId, "pi_session_test");
  assert.equal(result.assistantText, "Wrote work/outputs/result.md");
  assert.match(prompts[0], /Read `work\/inputs\/task\.md`/);
  assert.match(prompts[0], /Do not skip writing `work\/outputs\/result\.md`/);
  assert.equal(buildPiAgentPrompt(), prompts[0]);

  const output = await fs.readFile(path.join(repoPath, "work", "outputs", "result.md"), "utf8");
  assert.match(output, /Pi executor result/);

  const summary = JSON.parse(
    await fs.readFile(path.join(repoPath, "work", "outputs", "run-summary.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(summary.status, "succeeded");
  assert.equal(summary.executor, "pi-sdk");
  assert.equal(summary.sessionId, "pi_session_test");

  await assert.rejects(
    runPiAgentExecutor({
      projectRoot: path.resolve("."),
      repoPath: path.join(tempRoot, "missing-input-repo"),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "off",
      timeoutMs: 5_000,
      sessionFactory,
    }),
    /Missing run input/,
  );

  const noOutputRepo = path.join(tempRoot, "no-output-repo");
  await copyAgentTemplate(noOutputRepo);
  await writeRunInput(noOutputRepo, { objective: "Do not write output." });
  await assert.rejects(
    runPiAgentExecutor({
      projectRoot: path.resolve("."),
      repoPath: noOutputRepo,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinking: "off",
      timeoutMs: 5_000,
      sessionFactory: async () => ({
        sessionId: "pi_session_no_output",
        async prompt(): Promise<void> {
          return undefined;
        },
        getLastAssistantText: () => "Skipped output",
        dispose: () => undefined,
      }),
    }),
    /Pi completed without writing/,
  );
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
