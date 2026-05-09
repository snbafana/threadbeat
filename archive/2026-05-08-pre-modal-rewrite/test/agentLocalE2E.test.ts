import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  commitAll,
  createAgentVersionBranch,
  createRunBranch,
  currentCommit,
  diff,
  ensureAgentRepo,
  runGit,
} from "../src/agentGitStore.js";
import { planRunBranch } from "../src/agentService.js";
import { copyAgentTemplate, writeRunInput } from "../src/agentTemplate.js";
import {
  runPiAgentExecutor,
  type PiAgentSessionFactory,
} from "../src/agentPiExecutor.js";
import { Database } from "../src/db.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-agent-e2e-"));
const repoPath = path.join(tempRoot, "agent-repo");
const db = new Database(
  `file:${path.join(tempRoot, "threadbeat.db")}`,
  path.resolve("schema/bootstrap.sql"),
);

const testPiSessionFactory: PiAgentSessionFactory = async (options) => ({
  sessionId: "pi_session_local_e2e",
  messages: [],
  async prompt(): Promise<void> {
    await fs.mkdir(path.join(options.repoPath, "work", "outputs"), { recursive: true });
    await fs.writeFile(
      path.join(options.repoPath, "work", "outputs", "result.md"),
      "# Local Pi executor result\n\nThe test Pi session completed the local Git-backed run.\n",
      "utf8",
    );
  },
  getLastAssistantText: () => "Wrote work/outputs/result.md",
  dispose: () => undefined,
});

try {
  await db.initSchema();
  await ensureAgentRepo(repoPath);
  await runGit(repoPath, ["config", "user.name", "Threadbeat Test"]);
  await runGit(repoPath, ["config", "user.email", "threadbeat-test@example.com"]);

  await copyAgentTemplate(repoPath);
  const initialCommit = await commitAll(repoPath, "Initialize basic agent template");
  assert.equal(initialCommit.status, "committed");

  const agentVersion = await createAgentVersionBranch(repoPath, "threadbeat/versions/agent_v1");
  assert.equal(agentVersion, "threadbeat/versions/agent_v1");

  const agent = await db.createAgent({
    id: "agt_local_e2e",
    name: "local e2e agent",
    repoUrl: repoPath,
    currentVersion: agentVersion,
  });

  const plan = planRunBranch({
    currentVersion: "agent_v1",
    objective: "Prove local Git-backed agent execution.",
    runId: "run_local_e2e",
    now: "2026-05-08T12:00:00.000Z",
  });
  const runBranch = await createRunBranch(repoPath, {
    fromBranch: plan.inputBranch,
    now: new Date("2026-05-08T12:00:00.000Z"),
    objectiveSlug: plan.metadata.objectiveSlug,
    runId: "run_local_e2e",
  });

  const run = await db.createAgentRun({
    id: "arun_local_e2e",
    agentId: agent.id,
    kind: "run",
    inputBranch: plan.inputBranch,
    runBranch,
    objective: plan.objective,
    status: "running",
  });
  await db.appendAgentEvent({
    agentId: agent.id,
    runId: run.id,
    type: "run_started",
    data: { inputBranch: plan.inputBranch, runBranch },
  });

  await writeRunInput(repoPath, {
    objective: plan.objective,
    metadata: { agentId: agent.id, runId: run.id },
  });
  await runPiAgentExecutor({
    projectRoot: path.resolve("."),
    repoPath,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinking: "off",
    timeoutMs: 5_000,
    sessionFactory: testPiSessionFactory,
  });

  const outputCommit = await commitAll(repoPath, "Record local fake agent run output");
  assert.equal(outputCommit.status, "committed");
  await db.updateAgentRunStatus(run.id, "succeeded");
  await db.updateAgentRunOutputBranch(run.id, runBranch);
  await db.appendAgentEvent({
    agentId: agent.id,
    runId: run.id,
    type: "output_committed",
    data: { commit: outputCommit.hash, outputBranch: runBranch },
  });

  const patch = await diff(repoPath, plan.inputBranch, runBranch);
  assert.match(patch, /work\/inputs\/task\.md/);
  assert.match(patch, /work\/outputs\/result\.md/);

  const updatedRun = await db.getAgentRun(run.id);
  assert.equal(updatedRun?.status, "succeeded");
  assert.equal(updatedRun?.output_branch, runBranch);
  assert.equal(await currentCommit(repoPath, runBranch), outputCommit.hash);

  const events = await db.listAgentEvents({ runId: run.id });
  assert.deepEqual(
    events.map((event) => event.type).sort(),
    ["output_committed", "run_started"],
  );
} finally {
  await db.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
