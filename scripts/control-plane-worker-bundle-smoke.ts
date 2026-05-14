import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { Settings } from "../src/config.js";
import { buildServer } from "../src/server.js";

const execFileAsync = promisify(execFile);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-worker-bundle-smoke-"));
const sessionName = `worker-bundle-${Date.now().toString(36)}`;
const topologyWorkerId = "bundle-topology-worker";
const resultReviewWorkerId = "bundle-result-review-worker";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-worker-bundle-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-worker-bundle-smoke",
};

const { app, db } = await buildServer(settings);

try {
  const agent = await db.createAgent({
    name: "worker-bundle-agent",
    repoUrl: "https://github.com/threadbeat-worker-bundle-smoke/agent.git",
    currentRef: "main",
  });
  await writeWorkerSessionRecord(agent.id);

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const bundleArgs = [
    "runs",
    "ensure-control-plane-worker-bundle",
    sessionName,
    "--server",
    "--worker-dry-run",
    "1",
    "--topology-worker-id",
    topologyWorkerId,
    "--include-result-review-worker",
    "--result-review-worker-id",
    resultReviewWorkerId,
    "--record-reviewed",
    "--max-iterations",
    "1",
    "--loop-interval-ms",
    "1",
    "--max-results",
    "1",
    "--result-review-interval-ms",
    "1",
    "--reviewed-by",
    "worker-bundle-smoke",
    "--lines",
    "1",
  ];

  const dryRun = await cliJson<{
    dryRun: boolean;
    confirmed: boolean;
    passed: boolean | null;
    plan: {
      expected: number;
      actionable: number;
      blocked: number;
      commands: string[][];
      steps: Array<{ kind: string; workerId: string; action: string; reason: string; command: string[] }>;
    };
    commands: { confirm: string[]; dryRun: string[]; inspectWorkers: string[] };
  }>(baseUrl, [...bundleArgs, "--dry-run"]);
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.confirmed, false);
  assert.equal(dryRun.passed, null);
  assert.equal(dryRun.plan.expected, 2);
  assert.equal(dryRun.plan.actionable, 2);
  assert.equal(dryRun.plan.blocked, 0);
  assert.equal(dryRun.plan.steps[0]?.kind, "control_plane_topology");
  assert.equal(dryRun.plan.steps[0]?.workerId, topologyWorkerId);
  assert.equal(dryRun.plan.steps[0]?.action, "ensure_control_plane_topology_worker");
  assert.equal(dryRun.plan.steps[0]?.reason, "no_worker_record");
  assert.equal(dryRun.plan.steps[0]?.command.join(" "), `npm run cli -- runs ensure-control-plane-topology-worker ${sessionName} --server --worker-id ${topologyWorkerId} --dry-run --max-iterations 1 --loop-interval-ms 1 --lines 1`);
  assert.equal(dryRun.plan.steps[1]?.kind, "result_review");
  assert.equal(dryRun.plan.steps[1]?.workerId, resultReviewWorkerId);
  assert.equal(dryRun.plan.steps[1]?.action, "ensure_control_plane_result_review_worker");
  assert.equal(dryRun.plan.steps[1]?.command.join(" "), `npm run cli -- runs ensure-control-plane-result-review-worker ${sessionName} --server --worker-id ${resultReviewWorkerId} --record-reviewed --dry-run --max-results 1 --interval-ms 1 --reviewed-by worker-bundle-smoke --lines 1`);
  assert.equal(dryRun.commands.confirm.join(" "), `npm run cli -- runs ensure-control-plane-worker-bundle ${sessionName} --server --topology-worker-id ${topologyWorkerId} --worker-dry-run 1 --max-iterations 1 --loop-interval-ms 1 --include-result-review-worker --result-review-worker-id ${resultReviewWorkerId} --record-reviewed --max-results 1 --result-review-interval-ms 1 --reviewed-by worker-bundle-smoke --lines 1 --confirm`);

  const confirmed = await cliJson<{
    confirmed: boolean;
    passed: boolean | null;
    executed: Array<{ kind: string; workerId: string; actionResult: string | null }>;
    checks: { expectedCount: number; executedCount: number | null; seenAfterCount: number | null };
  }>(baseUrl, [...bundleArgs, "--confirm"]);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.passed, true);
  assert.equal(confirmed.executed.length, 2);
  assert.equal(confirmed.checks.expectedCount, 2);
  assert.equal(confirmed.checks.executedCount, 2);
  assert.equal(confirmed.checks.seenAfterCount, 2);
  assert.ok(confirmed.executed.every((step) => step.actionResult === "started" || step.actionResult === "existing"));

  const text = await cliText(baseUrl, [...bundleArgs, "--dry-run", "--format", "text"]);
  assert.match(text, /control_plane_worker_bundle:/);
  assert.match(text, new RegExp(`topology=${topologyWorkerId}`));
  assert.match(text, new RegExp(`result_review=${resultReviewWorkerId}`));
  assert.match(text, /plan: expected=2 actionable=0 blocked=0 existing=2/);

  const aggregate = await cliJson<{
    summary: { topology: { total: number }; resultReview: { total: number } };
    workers: Array<{ kind: string; workerId: string | null }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "1",
  ]);
  assert.equal(aggregate.summary.topology.total, 1);
  assert.equal(aggregate.summary.resultReview.total, 1);
  assert.ok(aggregate.workers.some((worker) => worker.kind === "control_plane_topology" && worker.workerId === topologyWorkerId));
  assert.ok(aggregate.workers.some((worker) => worker.kind === "result_review" && worker.workerId === resultReviewWorkerId));
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.out.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.err.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane worker bundle smoke passed");

async function writeWorkerSessionRecord(agentId: string): Promise<void> {
  const sessionDir = path.join(".threadbeat", "worker-sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const stdoutPath = path.join(sessionDir, `${sessionName}.out.log`);
  const stderrPath = path.join(sessionDir, `${sessionName}.err.log`);
  await fs.writeFile(stdoutPath, "");
  await fs.writeFile(stderrPath, "");
  await fs.writeFile(path.join(sessionDir, `${sessionName}.json`), `${JSON.stringify({
    session: sessionName,
    baseUrl: "http://127.0.0.1:0",
    startedAt: "2026-05-14T00:00:00.000Z",
    command: ["runs", "work", "--agent", agentId],
    workers: [{ workerId: "worker-bundle-session-worker", pid: null, stdoutPath, stderrPath }],
    stoppedAt: "2026-05-14T00:00:01.000Z",
  }, null, 2)}\n`);
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const stdout = await cliText(baseUrl, args);
  return JSON.parse(stdout) as T;
}

async function cliText(baseUrl: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}
