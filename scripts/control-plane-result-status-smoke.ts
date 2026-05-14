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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-result-status-smoke-"));
const sessionName = `result-status-${Date.now().toString(36)}`;
const workerId = "result-status-worker";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-result-status-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-result-status-smoke",
};

const { app, db } = await buildServer(settings);

try {
  const agent = await db.createAgent({
    name: "result-status-agent",
    repoUrl: "https://github.com/threadbeat-result-status-smoke/agent.git",
    currentRef: "main",
  });
  await writeWorkerSessionRecord(agent.id);
  const run = await db.createAgentRun({
    agentId: agent.id,
    objective: "control-plane result status command queue",
    inputRef: "main",
    runBranch: `threadbeat/runs/${sessionName}`,
  });
  await db.claimAgentRun(run.id, workerId);
  const resultCommit = "0123456789abcdef0123456789abcdef01234567";
  await db.updateAgentRunCompleted({
    id: run.id,
    status: "completed",
    resultCommit,
  });

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const checkoutCommand = `npm run cli -- runs checkout ${run.id} --dir ./checkouts/${sessionName}-control-plane-results/${run.id}`;
  const reviewCommand = `npm run cli -- runs review ${run.id} --checkout-dir ./checkouts/${sessionName}-control-plane-results/${run.id}`;
  const recordReviewedCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --record-reviewed --run ${run.id}`;
  const recordSkippedCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --record-skipped --run ${run.id}`;

  const summary = await cliJson<{
    results: {
      counts: { resultCommits: number; pending: number };
      inspection: {
        count: number;
        nextSteps: Array<{
          runId: string;
          resultCommit: string;
          commands: { checkoutBranch: string[]; reviewRun: string[] };
        }>;
      };
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(summary.results.counts.resultCommits, 1);
  assert.equal(summary.results.counts.pending, 1);
  assert.equal(summary.results.inspection.count, 1);
  assert.equal(summary.results.inspection.nextSteps[0]?.runId, run.id);
  assert.equal(summary.results.inspection.nextSteps[0]?.resultCommit, resultCommit);
  assert.equal(summary.results.inspection.nextSteps[0]?.commands.checkoutBranch.join(" "), checkoutCommand);
  assert.equal(summary.results.inspection.nextSteps[0]?.commands.reviewRun.join(" "), reviewCommand);

  const commandSummary = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === checkoutCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === reviewCommand));

  const shellSummary = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(shellSummary, new RegExp(checkoutCommand));
  assert.match(shellSummary, new RegExp(reviewCommand));

  const resultInspectionCommands = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "pending",
    "--commands-only",
  ]);
  assert.ok(resultInspectionCommands.commands.some((command) => command.command.join(" ") === checkoutCommand));
  assert.ok(resultInspectionCommands.commands.some((command) => command.command.join(" ") === reviewCommand));
  assert.ok(resultInspectionCommands.commands.some((command) => command.command.join(" ") === recordReviewedCommand));
  assert.ok(resultInspectionCommands.commands.some((command) => command.command.join(" ") === recordSkippedCommand));

  const resultInspectionShell = await cliText(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "pending",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(resultInspectionShell, new RegExp(recordReviewedCommand));
  assert.match(resultInspectionShell, new RegExp(recordSkippedCommand));

  const resultInspectionText = await cliText(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "pending",
    "--format",
    "text",
  ]);
  assert.match(resultInspectionText, /result_inspections:/);
  assert.match(resultInspectionText, /review_state: pending/);
  assert.match(resultInspectionText, new RegExp(`run: ${run.id}`));
  assert.match(resultInspectionText, new RegExp(`result_commit: ${resultCommit}`));
  assert.match(resultInspectionText, new RegExp(`checkout: ${checkoutCommand}`));
  assert.match(resultInspectionText, new RegExp(`review: ${reviewCommand}`));
  assert.match(resultInspectionText, new RegExp(`record_reviewed: ${recordReviewedCommand}`));
  assert.match(resultInspectionText, new RegExp(`record_skipped: ${recordSkippedCommand}`));
  assert.match(resultInspectionText, /result_commit_url: https:\/\/github.com\/threadbeat-result-status-smoke\/agent\/commit\//);

  const nextResultInspection = await cliJson<{
    count: number;
    filter: { reviewStates: string[]; limit: number };
    resultCommits: Array<{ runId: string; reviewState: string }>;
  }>(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--next",
  ]);
  assert.equal(nextResultInspection.count, 1);
  assert.deepEqual(nextResultInspection.filter.reviewStates, ["pending"]);
  assert.equal(nextResultInspection.filter.limit, 1);
  assert.equal(nextResultInspection.resultCommits[0]?.runId, run.id);
  assert.equal(nextResultInspection.resultCommits[0]?.reviewState, "pending");

  const nextResultInspectionText = await cliText(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--next",
    "--format",
    "text",
  ]);
  assert.match(nextResultInspectionText, /filter: run=all review_state=pending limit=1/);
  assert.match(nextResultInspectionText, new RegExp(`run: ${run.id}`));
  assert.match(nextResultInspectionText, new RegExp(`next: ${reviewCommand}`));

  const nextResultInspectionShell = await cliText(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--next",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(nextResultInspectionShell, new RegExp(reviewCommand));
  assert.match(nextResultInspectionShell, new RegExp(recordReviewedCommand));

  const reviewed = await cliJson<{ review: { reviewId: string; action: string; runId: string; resultCommit: string; reviewedBy: string } }>(baseUrl, [
    "runs",
    "session-result-reviews",
    sessionName,
    "--server",
    "--record-reviewed",
    "--run",
    run.id,
    "--reviewed-by",
    "result-status-smoke",
  ]);
  assert.equal(reviewed.review.action, "reviewed");
  assert.equal(reviewed.review.runId, run.id);
  assert.equal(reviewed.review.resultCommit, resultCommit);
  assert.equal(reviewed.review.reviewedBy, "result-status-smoke");

  const reviewedStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(reviewedStatusText, /result_reviews: count=1 reviewed=1 skipped=0/);
  assert.match(reviewedStatusText, /recent_result_reviews:/);
  assert.match(reviewedStatusText, new RegExp(`review: ${reviewed.review.reviewId}`));
  assert.match(reviewedStatusText, /action: reviewed/);
  assert.match(reviewedStatusText, new RegExp(`run: ${run.id}`));
  assert.match(reviewedStatusText, /reviewed_by: result-status-smoke/);

  const inspectReviewCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --review ${reviewed.review.reviewId} --run ${run.id} --limit 20`;
  const reviewedStatusCommands = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(reviewedStatusCommands.commands.some((command) => command.command.join(" ") === inspectReviewCommand));

  const reviewedStatusShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(reviewedStatusShell, new RegExp(inspectReviewCommand));

  const reviewedResultInspectionCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --review ${reviewed.review.reviewId} --limit 20`;
  const reviewedInspectionText = await cliText(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "reviewed",
    "--format",
    "text",
  ]);
  assert.match(reviewedInspectionText, /result_inspections:/);
  assert.match(reviewedInspectionText, /review_state: reviewed/);
  assert.match(reviewedInspectionText, new RegExp(`latest_review: ${reviewed.review.reviewId}`));
  assert.match(reviewedInspectionText, /reviewed_by: result-status-smoke/);
  assert.match(reviewedInspectionText, new RegExp(`next: ${reviewedResultInspectionCommand}`));
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane result status smoke passed");

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
    workers: [{ workerId, pid: null, stdoutPath, stderrPath }],
    stoppedAt: "2026-05-14T00:00:01.000Z",
  }, null, 2)}\n`);
}

async function cliJson<T>(baseUrl: string, args: string[]): Promise<T> {
  const { stdout } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
    maxBuffer: 1024 * 1024,
  });
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
