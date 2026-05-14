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
  const nextResultInspectionCommand = `npm run cli -- runs session-result-inspections ${sessionName} --server --next`;
  const nextResultReviewCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server`;
  const resultCommitViewCommand = `npm run cli -- runs session-result-inspections ${sessionName} --server --result-commits`;
  const pendingResultCommitViewCommand = `npm run cli -- runs session-result-inspections ${sessionName} --server --review-state pending --result-commits`;
  const recordNextReviewedCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server --record-reviewed`;
  const recordNextSkippedCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server --record-skipped`;
  const latestResultReviewsCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --latest`;
  const recordReviewedCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --record-reviewed --run ${run.id} --result-commit ${resultCommit}`;
  const recordSkippedCommand = `npm run cli -- runs session-result-reviews ${sessionName} --server --record-skipped --run ${run.id} --result-commit ${resultCommit}`;
  const recordScopedReviewedCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server --run ${run.id} --result-commit ${resultCommit} --record-reviewed`;
  const recordScopedSkippedCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server --run ${run.id} --result-commit ${resultCommit} --record-skipped`;
  const recordNextSelectedReviewedCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server --record-reviewed --run ${run.id} --result-commit ${resultCommit}`;
  const recordNextSelectedSkippedCommand = `npm run cli -- runs session-result-review-next ${sessionName} --server --record-skipped --run ${run.id} --result-commit ${resultCommit}`;
  const failedResultReviewAttemptsCommand = `npm run cli -- runs session-control-plane-timeline ${sessionName} --server --source result_review --event result_review_record_failed --status failed`;

  const summary = await cliJson<{
    needsAction: boolean;
    nextRecovery: {
      kind: string;
      surface?: string;
      action: string;
      reason: string;
      count: number;
      command: string[];
      dryRunCommand: string[];
    } | null;
    nextActions: Array<{ surface: string; action: string; reason: string; runId?: string; resultCommit?: string; command: string[] }>;
    commands: {
      nextResultInspection: string[];
      nextResultReview: string[];
      resultCommitView: string[];
      pendingResultCommitView: string[];
      recordNextReviewed: string[];
      recordNextSkipped: string[];
      latestResultReviews: string[];
      failedResultReviewAttempts: string[];
    };
    results: {
      counts: { resultCommits: number; pending: number; reviewed: number; skipped: number };
      reviews: { counts: { failed: number }; failedAttempts: { count: number } };
      inspection: {
        count: number;
        nextSteps: Array<{
          runId: string;
          resultCommit: string;
          commands: { inspectResult: string[]; checkoutBranch: string[]; reviewRun: string[]; recordReviewed: string[]; recordSkipped: string[] };
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
  assert.equal(summary.needsAction, true);
  assert.equal(summary.results.counts.resultCommits, 1);
  assert.equal(summary.results.counts.pending, 1);
  assert.equal(summary.results.counts.reviewed, 0);
  assert.equal(summary.results.counts.skipped, 0);
  assert.equal(summary.results.inspection.count, 1);
  assert.equal(summary.results.inspection.nextSteps[0]?.runId, run.id);
  assert.equal(summary.results.inspection.nextSteps[0]?.resultCommit, resultCommit);
  assert.equal(summary.nextRecovery?.kind, "control_plane_action");
  assert.equal(summary.nextRecovery?.surface, "result_inspection");
  assert.equal(summary.nextRecovery?.action, "review_result");
  assert.equal(summary.nextRecovery?.reason, "result_commit_available");
  assert.equal(summary.nextRecovery?.count, 1);
  assert.deepEqual(summary.nextRecovery?.command, summary.results.inspection.nextSteps[0]?.commands.inspectResult);
  assert.deepEqual(summary.nextRecovery?.dryRunCommand, summary.results.inspection.nextSteps[0]?.commands.inspectResult);
  assert.ok(summary.nextActions.some((action) => (
    action.surface === "result_inspection"
    && action.action === "review_result"
    && action.runId === run.id
    && action.resultCommit === resultCommit
    && action.command.join(" ") === summary.results.inspection.nextSteps[0]?.commands.inspectResult.join(" ")
  )));
  assert.equal(summary.results.inspection.nextSteps[0]?.commands.checkoutBranch.join(" "), checkoutCommand);
  assert.equal(summary.results.inspection.nextSteps[0]?.commands.reviewRun.join(" "), reviewCommand);
  assert.equal(summary.results.inspection.nextSteps[0]?.commands.recordReviewed.join(" "), recordScopedReviewedCommand);
  assert.equal(summary.results.inspection.nextSteps[0]?.commands.recordSkipped.join(" "), recordScopedSkippedCommand);
  assert.equal(summary.commands.nextResultInspection.join(" "), nextResultInspectionCommand);
  assert.equal(summary.commands.nextResultReview.join(" "), nextResultReviewCommand);
  assert.equal(summary.commands.resultCommitView.join(" "), resultCommitViewCommand);
  assert.equal(summary.commands.pendingResultCommitView.join(" "), pendingResultCommitViewCommand);
  assert.equal(summary.commands.recordNextReviewed.join(" "), recordNextReviewedCommand);
  assert.equal(summary.commands.recordNextSkipped.join(" "), recordNextSkippedCommand);
  assert.equal(summary.commands.latestResultReviews.join(" "), latestResultReviewsCommand);
  assert.equal(summary.commands.failedResultReviewAttempts.join(" "), failedResultReviewAttemptsCommand);
  assert.equal(summary.results.reviews.counts.failed, 0);
  assert.equal(summary.results.reviews.failedAttempts.count, 0);

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
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === recordScopedReviewedCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === recordScopedSkippedCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === nextResultInspectionCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === nextResultReviewCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === resultCommitViewCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === pendingResultCommitViewCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === recordNextReviewedCommand));
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === recordNextSkippedCommand));

  const pendingStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(pendingStatusText, new RegExp(`inspect_next: ${nextResultInspectionCommand}`));
  assert.match(pendingStatusText, new RegExp(`result_commits: ${resultCommitViewCommand}`));
  assert.match(pendingStatusText, new RegExp(`pending_result_commits: ${pendingResultCommitViewCommand}`));
  assert.match(pendingStatusText, new RegExp(`review_next: ${nextResultReviewCommand}`));
  assert.match(pendingStatusText, new RegExp(`record_next_reviewed: ${recordNextReviewedCommand}`));
  assert.match(pendingStatusText, new RegExp(`record_next_skipped: ${recordNextSkippedCommand}`));
  assert.match(pendingStatusText, /next_recovery:\n  kind: control_plane_action\n  action: review_result\n  reason: result_commit_available/);
  assert.match(pendingStatusText, /next_actions:\n  - surface: result_inspection/);
  assert.match(pendingStatusText, new RegExp(`record_reviewed: ${recordScopedReviewedCommand}`));
  assert.match(pendingStatusText, new RegExp(`record_skipped: ${recordScopedSkippedCommand}`));
  assert.match(pendingStatusText, new RegExp(`latest: ${latestResultReviewsCommand}`));
  assert.match(pendingStatusText, /result_reviews: count=0 reviewed=0 skipped=0 failed_attempts=0/);

  const watchedUntilResultInspection = await cliJson<{
    untilAction: { done: boolean; reason: string | null; command: string[] | null; dryRunCommand: string[] | null };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--watch",
    "--until-action",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
  ]);
  assert.equal(watchedUntilResultInspection.untilAction.done, true);
  assert.equal(watchedUntilResultInspection.untilAction.reason, "control_plane_action:review_result");
  assert.deepEqual(watchedUntilResultInspection.untilAction.command, summary.results.inspection.nextSteps[0]?.commands.inspectResult);
  assert.deepEqual(watchedUntilResultInspection.untilAction.dryRunCommand, summary.results.inspection.nextSteps[0]?.commands.inspectResult);

  const reviewNext = await cliJson<{
    count: number;
    filter: { reviewStates: string[]; limit: number };
    resultCommits: Array<{ runId: string; reviewState: string }>;
  }>(baseUrl, [
    "runs",
    "session-result-review-next",
    sessionName,
    "--server",
  ]);
  assert.equal(reviewNext.count, 1);
  assert.deepEqual(reviewNext.filter.reviewStates, ["pending"]);
  assert.equal(reviewNext.filter.limit, 1);
  assert.equal(reviewNext.resultCommits[0]?.runId, run.id);
  assert.equal(reviewNext.resultCommits[0]?.reviewState, "pending");

  const reviewNextText = await cliText(baseUrl, [
    "runs",
    "session-result-review-next",
    sessionName,
    "--server",
    "--format",
    "text",
  ]);
  assert.match(reviewNextText, /result_review_next:/);
  assert.match(reviewNextText, /review_state=pending limit=1/);
  assert.match(reviewNextText, new RegExp(`run: ${run.id}`));
  assert.match(reviewNextText, new RegExp(`review: ${reviewCommand}`));
  assert.match(reviewNextText, new RegExp(`record_reviewed: ${recordReviewedCommand}`));
  assert.match(reviewNextText, new RegExp(`record_skipped: ${recordSkippedCommand}`));
  assert.match(reviewNextText, new RegExp(`record_next_reviewed: ${recordNextSelectedReviewedCommand}`));
  assert.match(reviewNextText, new RegExp(`record_next_skipped: ${recordNextSelectedSkippedCommand}`));

  const reviewNextShell = await cliText(baseUrl, [
    "runs",
    "session-result-review-next",
    sessionName,
    "--server",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(reviewNextShell, new RegExp(reviewCommand));
  assert.match(reviewNextShell, new RegExp(recordReviewedCommand));
  assert.match(reviewNextShell, new RegExp(recordSkippedCommand));

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
  assert.match(shellSummary, new RegExp(recordScopedReviewedCommand));
  assert.match(shellSummary, new RegExp(recordScopedSkippedCommand));
  assert.match(shellSummary, new RegExp(nextResultInspectionCommand));
  assert.match(shellSummary, new RegExp(nextResultReviewCommand));
  assert.match(shellSummary, new RegExp(recordNextReviewedCommand));
  assert.match(shellSummary, new RegExp(recordNextSkippedCommand));

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

  const resultCommitView = await cliJson<{
    count: number;
    summary: { resultCommits: number; pending: number; reviewed: number; skipped: number };
    commands: { inspectAll: string[]; inspectPending: string[]; reviewNext: string[] };
    resultCommits: Array<{
      runId: string;
      branchName: string;
      resultCommit: string;
      reviewState: string;
      commands: {
        checkoutBranch: string[];
        reviewRun: string[];
        recordReviewed: string[];
        recordSkipped: string[];
      };
    }>;
  }>(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "pending",
    "--result-commits",
  ]);
  assert.equal(resultCommitView.count, 1);
  assert.equal(resultCommitView.summary.resultCommits, 1);
  assert.equal(resultCommitView.summary.pending, 1);
  assert.equal(resultCommitView.commands.inspectPending.join(" "), `npm run cli -- runs session-result-inspections ${sessionName} --server --review-state pending --result-commits`);
  assert.equal(resultCommitView.commands.reviewNext.join(" "), nextResultReviewCommand);
  assert.equal(resultCommitView.resultCommits[0]?.runId, run.id);
  assert.equal(resultCommitView.resultCommits[0]?.branchName, run.run_branch);
  assert.equal(resultCommitView.resultCommits[0]?.resultCommit, resultCommit);
  assert.equal(resultCommitView.resultCommits[0]?.reviewState, "pending");
  assert.equal(resultCommitView.resultCommits[0]?.commands.checkoutBranch.join(" "), checkoutCommand);
  assert.equal(resultCommitView.resultCommits[0]?.commands.reviewRun.join(" "), reviewCommand);
  assert.equal(resultCommitView.resultCommits[0]?.commands.recordReviewed.join(" "), recordReviewedCommand);
  assert.equal(resultCommitView.resultCommits[0]?.commands.recordSkipped.join(" "), recordSkippedCommand);

  const resultCommitViewText = await cliText(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "pending",
    "--result-commits",
    "--format",
    "text",
  ]);
  assert.match(resultCommitViewText, /result_commit_view:/);
  assert.match(resultCommitViewText, new RegExp(`inspect_pending: npm run cli -- runs session-result-inspections ${sessionName} --server --review-state pending --result-commits`));
  assert.match(resultCommitViewText, new RegExp(`review_next: ${nextResultReviewCommand}`));
  assert.match(resultCommitViewText, new RegExp(`run: ${run.id}`));
  assert.match(resultCommitViewText, new RegExp(`branch: ${run.run_branch}`));
  assert.match(resultCommitViewText, new RegExp(`result_commit: ${resultCommit}`));
  assert.match(resultCommitViewText, new RegExp(`checkout: ${checkoutCommand}`));
  assert.match(resultCommitViewText, new RegExp(`review: ${reviewCommand}`));
  assert.match(resultCommitViewText, new RegExp(`record_reviewed: ${recordReviewedCommand}`));
  assert.match(resultCommitViewText, new RegExp(`record_skipped: ${recordSkippedCommand}`));

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

  const staleGuard = await cliFailure(baseUrl, [
    "runs",
    "session-result-review-next",
    sessionName,
    "--server",
    "--record-reviewed",
    "--result-commit",
    "ffffffffffffffffffffffffffffffffffffffff",
  ]);
  assert.match(staleGuard.stderr, /result commit changed: expected ffffffffffffffffffffffffffffffffffffffff/);

  const failedReviewTimeline = await cliJson<{
    count: number;
    counts: Record<string, number>;
    filter: { sources: string[]; events: string[]; statuses: string[]; runIds: string[] };
    events: Array<{
      source: string;
      event: string;
      attemptId?: string;
      status?: string;
      reason?: string;
      runIds?: string[];
      resultCommit?: string;
      expectedResultCommit?: string;
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-timeline",
    sessionName,
    "--server",
    "--source",
    "result_review",
    "--event",
    "result_review_record_failed",
    "--status",
    "failed",
    "--run",
    run.id,
  ]);
  assert.deepEqual(failedReviewTimeline.filter.sources, ["result_review"]);
  assert.deepEqual(failedReviewTimeline.filter.events, ["result_review_record_failed"]);
  assert.deepEqual(failedReviewTimeline.filter.statuses, ["failed"]);
  assert.deepEqual(failedReviewTimeline.filter.runIds, [run.id]);
  assert.equal(failedReviewTimeline.count, 1);
  assert.equal(failedReviewTimeline.counts.result_review_record_failed, 1);
  assert.equal(failedReviewTimeline.events[0]?.source, "result_review");
  assert.equal(failedReviewTimeline.events[0]?.event, "result_review_record_failed");
  assert.equal(failedReviewTimeline.events[0]?.status, "failed");
  assert.ok(failedReviewTimeline.events[0]?.attemptId);
  assert.match(failedReviewTimeline.events[0]?.reason ?? "", /result commit changed/);
  assert.ok(failedReviewTimeline.events[0]?.runIds?.includes(run.id));
  assert.equal(failedReviewTimeline.events[0]?.expectedResultCommit, "ffffffffffffffffffffffffffffffffffffffff");

  const failedAttemptStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(failedAttemptStatusText, /result_reviews: count=0 reviewed=0 skipped=0 failed_attempts=1/);
  assert.match(failedAttemptStatusText, new RegExp(`failed_attempts: ${failedResultReviewAttemptsCommand}`));
  assert.match(failedAttemptStatusText, /recent_failed_result_reviews:/);
  assert.match(failedAttemptStatusText, new RegExp(`run: ${run.id}`));
  assert.match(failedAttemptStatusText, /expected_result_commit: ffffffffffffffffffffffffffffffffffffffff/);
  assert.match(failedAttemptStatusText, /error: run .* result commit changed/);

  const failedAttemptStatusCommands = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(failedAttemptStatusCommands.commands.some((command) => command.command.join(" ") === failedResultReviewAttemptsCommand));

  const nextRecordDryRun = await cliJson<{
    dryRun: boolean;
    recorded: boolean;
    selected: { runId: string; resultCommit: string; reviewState: string };
    review: { reviewId: string; action: string; runId: string; resultCommit: string; reviewedBy: string };
  }>(baseUrl, [
    "runs",
    "session-result-review-next",
    sessionName,
    "--server",
    "--record-reviewed",
    "--dry-run",
    "--reviewed-by",
    "result-status-smoke",
  ]);
  assert.equal(nextRecordDryRun.dryRun, true);
  assert.equal(nextRecordDryRun.recorded, false);
  assert.equal(nextRecordDryRun.selected.runId, run.id);
  assert.equal(nextRecordDryRun.selected.resultCommit, resultCommit);
  assert.equal(nextRecordDryRun.selected.reviewState, "pending");
  assert.equal(nextRecordDryRun.review.reviewId, "dry-run");
  assert.equal(nextRecordDryRun.review.action, "reviewed");
  assert.equal(nextRecordDryRun.review.runId, run.id);
  assert.equal(nextRecordDryRun.review.resultCommit, resultCommit);
  assert.equal(nextRecordDryRun.review.reviewedBy, "result-status-smoke");

  const nextRecordDryRunText = await cliText(baseUrl, [
    "runs",
    "session-result-review-next",
    sessionName,
    "--server",
    "--record-skipped",
    "--dry-run",
    "--reviewed-by",
    "result-status-smoke",
    "--format",
    "text",
  ]);
  assert.match(nextRecordDryRunText, /result_review_next_record:/);
  assert.match(nextRecordDryRunText, /dry_run: true/);
  assert.match(nextRecordDryRunText, /recorded: false/);
  assert.match(nextRecordDryRunText, /action: skipped/);
  assert.match(nextRecordDryRunText, new RegExp(`run: ${run.id}`));
  assert.match(nextRecordDryRunText, new RegExp(`result_commit: ${resultCommit}`));

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
  assert.match(reviewedStatusText, new RegExp(`latest: ${latestResultReviewsCommand}`));
  assert.match(reviewedStatusText, /result_inspection: none \(reviewed=1 skipped=0\)/);
  assert.match(reviewedStatusText, new RegExp(`inspect_reviewed: npm run cli -- runs session-result-inspections ${sessionName} --server --review-state reviewed`));
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
  assert.ok(reviewedStatusCommands.commands.some((command) => command.command.join(" ") === latestResultReviewsCommand));

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
  assert.match(reviewedStatusShell, new RegExp(latestResultReviewsCommand));

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

  await new Promise((resolve) => setTimeout(resolve, 5));
  const skipped = await cliJson<{ review: { reviewId: string; action: string; runId: string; resultCommit: string; reviewedBy: string } }>(baseUrl, [
    "runs",
    "session-result-reviews",
    sessionName,
    "--server",
    "--record-skipped",
    "--run",
    run.id,
    "--reviewed-by",
    "result-status-smoke",
  ]);
  assert.equal(skipped.review.action, "skipped");
  assert.equal(skipped.review.runId, run.id);
  assert.equal(skipped.review.resultCommit, resultCommit);
  assert.equal(skipped.review.reviewedBy, "result-status-smoke");

  const latestReviews = await cliJson<{
    count: number;
    filter: { latest: boolean; action: string[] };
    reviews: Array<{ reviewId: string; action: string; runId: string; resultCommit: string }>;
  }>(baseUrl, [
    "runs",
    "session-result-reviews",
    sessionName,
    "--server",
    "--latest",
    "--run",
    run.id,
  ]);
  assert.equal(latestReviews.count, 1);
  assert.equal(latestReviews.filter.latest, true);
  assert.deepEqual(latestReviews.filter.action, []);
  assert.equal(latestReviews.reviews[0]?.reviewId, skipped.review.reviewId);
  assert.equal(latestReviews.reviews[0]?.action, "skipped");
  assert.equal(latestReviews.reviews[0]?.runId, run.id);
  assert.equal(latestReviews.reviews[0]?.resultCommit, resultCommit);

  const latestReviewsText = await cliText(baseUrl, [
    "runs",
    "session-result-reviews",
    sessionName,
    "--server",
    "--latest",
    "--run",
    run.id,
    "--format",
    "text",
  ]);
  assert.match(latestReviewsText, /result_reviews:/);
  assert.match(latestReviewsText, /latest=true/);
  assert.match(latestReviewsText, new RegExp(`review: ${skipped.review.reviewId}`));
  assert.match(latestReviewsText, /action: skipped/);
  assert.match(latestReviewsText, new RegExp(`run: ${run.id}`));
  assert.match(latestReviewsText, new RegExp(`result_commit: ${resultCommit}`));

  const latestReviewedReviews = await cliJson<{ count: number; filter: { latest: boolean; action: string[] }; reviews: unknown[] }>(baseUrl, [
    "runs",
    "session-result-reviews",
    sessionName,
    "--server",
    "--latest",
    "--run",
    run.id,
    "--action",
    "reviewed",
  ]);
  assert.equal(latestReviewedReviews.count, 0);
  assert.equal(latestReviewedReviews.filter.latest, true);
  assert.deepEqual(latestReviewedReviews.filter.action, ["reviewed"]);
  assert.deepEqual(latestReviewedReviews.reviews, []);

  const skippedStatusText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(skippedStatusText, /result_reviews: count=2 reviewed=1 skipped=1/);
  assert.match(skippedStatusText, new RegExp(`latest: ${latestResultReviewsCommand}`));
  assert.match(skippedStatusText, /result_inspection: none \(reviewed=0 skipped=1\)/);
  assert.match(skippedStatusText, new RegExp(`inspect_skipped: npm run cli -- runs session-result-inspections ${sessionName} --server --review-state skipped`));

  const skippedStatusCommands = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(skippedStatusCommands.commands.some((command) => (
    command.command.join(" ") === `npm run cli -- runs session-result-inspections ${sessionName} --server --review-state skipped`
  )));
  assert.ok(skippedStatusCommands.commands.some((command) => command.command.join(" ") === latestResultReviewsCommand));

  const skippedResultInspections = await cliJson<{
    summary: { resultCommits: number; pending: number; reviewed: number; skipped: number };
    resultCommits: Array<{
      runId: string;
      reviewState: string;
      latestReview: null | { reviewId: string; action: string; reviewedBy: string };
      nextStep: { action: string; reason: string; command: string[] };
    }>;
  }>(baseUrl, [
    "runs",
    "session-result-inspections",
    sessionName,
    "--server",
    "--review-state",
    "skipped",
  ]);
  assert.equal(skippedResultInspections.summary.resultCommits, 1);
  assert.equal(skippedResultInspections.summary.skipped, 1);
  assert.equal(skippedResultInspections.resultCommits[0]?.runId, run.id);
  assert.equal(skippedResultInspections.resultCommits[0]?.reviewState, "skipped");
  assert.equal(skippedResultInspections.resultCommits[0]?.latestReview?.reviewId, skipped.review.reviewId);
  assert.equal(skippedResultInspections.resultCommits[0]?.latestReview?.action, "skipped");
  assert.equal(skippedResultInspections.resultCommits[0]?.latestReview?.reviewedBy, "result-status-smoke");
  assert.equal(skippedResultInspections.resultCommits[0]?.nextStep.action, "inspect_review");
  assert.equal(skippedResultInspections.resultCommits[0]?.nextStep.reason, "result_commit_skipped");
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "result-review-attempts", sessionName), { recursive: true, force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "result-reviews", sessionName), { recursive: true, force: true });
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

async function cliFailure(baseUrl: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", "--silent", "cli", "--", ...args], {
      cwd: path.resolve("."),
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      maxBuffer: 1024 * 1024,
    });
    assert.fail(`expected CLI failure, got stdout=${stdout} stderr=${stderr}`);
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}
