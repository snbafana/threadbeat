import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Database } from "../src/db.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-db-agents-"));
const db = new Database(
  `file:${path.join(tempRoot, "threadbeat.db")}`,
  path.resolve("schema/bootstrap.sql"),
);

try {
  await db.initSchema();

  const agent = await db.createAgent({
    id: "agt_test",
    name: "local worker",
    repoUrl: "file:///tmp/threadbeat-agent.git",
  });
  assert.equal(agent.id, "agt_test");
  assert.equal(agent.repo_url, "file:///tmp/threadbeat-agent.git");
  assert.equal(agent.current_version, null);
  assert.equal(agent.status, "active");

  assert.deepEqual(
    (await db.listAgents()).map((row) => row.id),
    ["agt_test"],
  );
  assert.equal((await db.getAgent("agt_test"))?.name, "local worker");

  const updatedAgent = await db.updateAgentCurrentVersion("agt_test", "main");
  assert.equal(updatedAgent?.current_version, "main");

  const run = await db.createAgentRun({
    id: "arun_test",
    agentId: agent.id,
    kind: "edit",
    inputBranch: "main",
    runBranch: "threadbeat/run/arun_test",
    objective: "make a focused local edit",
  });
  assert.equal(run.status, "queued");
  assert.equal(run.output_branch, null);
  assert.equal(run.kind, "edit");

  const runningRun = await db.updateAgentRunStatus(run.id, "running");
  assert.equal(runningRun?.status, "running");

  const outputRun = await db.updateAgentRunOutputBranch(run.id, "threadbeat/output/arun_test");
  assert.equal(outputRun?.output_branch, "threadbeat/output/arun_test");

  assert.deepEqual(
    (await db.listAgentRuns(agent.id)).map((row) => row.id),
    [run.id],
  );
  assert.equal((await db.getAgentRun(run.id))?.objective, "make a focused local edit");

  const event = await db.appendAgentEvent({
    id: "aevt_test",
    agentId: agent.id,
    runId: run.id,
    type: "run_started",
    message: "run started",
    data: { runBranch: run.run_branch },
  });
  assert.equal(event.type, "run_started");
  assert.deepEqual(JSON.parse(event.data ?? "{}"), {
    runBranch: "threadbeat/run/arun_test",
  });

  await db.appendAgentEvent({
    id: "aevt_agent_only",
    agentId: agent.id,
    type: "agent_registered",
  });

  assert.deepEqual(
    (await db.listAgentEvents({ agentId: agent.id, limit: 10 })).map((row) => row.id).sort(),
    ["aevt_agent_only", "aevt_test"],
  );
  assert.deepEqual(
    (await db.listAgentEvents({ runId: run.id })).map((row) => row.id),
    ["aevt_test"],
  );
} finally {
  await db.close();
  await fs.rm(tempRoot, { recursive: true, force: true });
}
