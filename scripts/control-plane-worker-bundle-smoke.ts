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
const recoveryWorkerId = "bundle-recovery-worker";

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
    profile: { saved: boolean; reason: string; path: string; savedAt: string | null } | null;
    executed: Array<{ kind: string; workerId: string; actionResult: string | null }>;
    checks: { expectedCount: number; executedCount: number | null; seenAfterCount: number | null };
  }>(baseUrl, [...bundleArgs, "--confirm", "--save-profile"]);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.passed, true);
  assert.equal(confirmed.profile?.saved, true);
  assert.equal(confirmed.profile?.reason, "saved");
  assert.match(confirmed.profile?.path ?? "", /control-plane-worker-bundles/);
  assert.equal(confirmed.executed.length, 2);
  assert.equal(confirmed.checks.expectedCount, 2);
  assert.equal(confirmed.checks.executedCount, 2);
  assert.equal(confirmed.checks.seenAfterCount, 2);
  assert.ok(confirmed.executed.every((step) => step.actionResult === "started" || step.actionResult === "existing"));

  const profile = await cliJson<{
    exists: boolean;
    path: string;
    profile: { desired: { topologyWorkerId: string; includeResultReviewWorker: boolean; resultReviewWorkerId: string; reviewAction: string } } | null;
    current: { plan: { expected: number; actionable: number; blocked: number; existing: number }; commands: { confirm: string[] } } | null;
    commands: { dryRun: string[]; confirm: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-bundle",
    sessionName,
    "--server",
    "--lines",
    "1",
  ]);
  assert.equal(profile.exists, true);
  assert.match(profile.path, /control-plane-worker-bundles/);
  assert.equal(profile.profile?.desired.topologyWorkerId, topologyWorkerId);
  assert.equal(profile.profile?.desired.includeResultReviewWorker, true);
  assert.equal(profile.profile?.desired.resultReviewWorkerId, resultReviewWorkerId);
  assert.equal(profile.profile?.desired.reviewAction, "reviewed");
  assert.equal(profile.current?.plan.expected, 2);
  assert.equal(profile.current?.plan.actionable, 0);
  assert.ok((profile.current?.plan.blocked ?? 0) + (profile.current?.plan.existing ?? 0) === 2);
  assert.equal(profile.commands.confirm.join(" "), `npm run cli -- runs ensure-control-plane-worker-bundle ${sessionName} --server --from-profile --confirm --lines 1`);

  const profileList = await cliJson<{
    profileCount: number;
    summary: { sessions: number; expected: number; actionable: number; blocked: number; existing: number; passed: boolean | null };
    bundles: Array<{ session: string; exists: boolean; current: { plan: { expected: number; actionable: number; blocked: number; existing: number } } | null }>;
    commands: { recoverDryRun: string[]; recoverConfirm: string[]; recoverLoopDryRun: string[]; list: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--lines",
    "1",
  ]);
  assert.equal(profileList.profileCount, 1);
  assert.equal(profileList.summary.sessions, 1);
  assert.equal(profileList.summary.expected, 2);
  assert.equal(profileList.summary.actionable, 0);
  assert.ok(profileList.summary.blocked + profileList.summary.existing === 2);
  assert.equal(profileList.bundles[0]?.session, sessionName);
  assert.equal(profileList.bundles[0]?.exists, true);
  assert.equal(profileList.bundles[0]?.current?.plan.expected, 2);
  assert.equal(profileList.commands.list.join(" "), `npm run cli -- runs session-control-plane-worker-bundles --server --session ${sessionName} --lines 1`);
  assert.equal(profileList.commands.recoverDryRun.join(" "), `npm run cli -- runs recover-control-plane-worker-bundles --server --session ${sessionName} --lines 1 --dry-run`);
  assert.equal(profileList.commands.recoverConfirm.join(" "), `npm run cli -- runs recover-control-plane-worker-bundles --server --session ${sessionName} --lines 1 --confirm`);
  assert.equal(profileList.commands.recoverLoopDryRun.join(" "), `npm run cli -- runs recover-control-plane-worker-bundles --server --session ${sessionName} --lines 1 --loop --dry-run`);

  const fromProfile = await cliJson<{
    dryRun: boolean;
    desired: { topologyWorkerId: string; includeResultReviewWorker: boolean; resultReviewWorkerId: string; reviewAction: string };
    plan: { expected: number; actionable: number; blocked: number; existing: number };
  }>(baseUrl, [
    "runs",
    "ensure-control-plane-worker-bundle",
    sessionName,
    "--server",
    "--from-profile",
    "--dry-run",
  ]);
  assert.equal(fromProfile.dryRun, true);
  assert.equal(fromProfile.desired.topologyWorkerId, topologyWorkerId);
  assert.equal(fromProfile.desired.includeResultReviewWorker, true);
  assert.equal(fromProfile.desired.resultReviewWorkerId, resultReviewWorkerId);
  assert.equal(fromProfile.desired.reviewAction, "reviewed");
  assert.equal(fromProfile.plan.expected, 2);
  assert.equal(fromProfile.plan.actionable, 0);
  assert.ok(fromProfile.plan.blocked + fromProfile.plan.existing === 2);

  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advance-workers", sessionName), { recursive: true, force: true });

  const recoveryDryRun = await cliJson<{
    dryRun: boolean;
    profileCount: number;
    summary: { planned: number; actionable: number; blocked: number; executed: number; passed: boolean | null };
    results: Array<{ session: string; result: { plan: { expected: number; actionable: number } } }>;
  }>(baseUrl, [
    "runs",
    "recover-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--dry-run",
    "--lines",
    "1",
  ]);
  assert.equal(recoveryDryRun.dryRun, true);
  assert.equal(recoveryDryRun.profileCount, 1);
  assert.equal(recoveryDryRun.summary.planned, 2);
  assert.equal(recoveryDryRun.summary.actionable, 2);
  assert.equal(recoveryDryRun.summary.blocked, 0);
  assert.equal(recoveryDryRun.summary.executed, 0);
  assert.equal(recoveryDryRun.summary.passed, null);
  assert.equal(recoveryDryRun.results[0]?.session, sessionName);
  assert.equal(recoveryDryRun.results[0]?.result.plan.actionable, 2);

  const recoveryLoop = await cliJson<{
    dryRun: boolean;
    loop: boolean;
    stoppedReason: string;
    iterations: Array<{ poll: number; summary: { planned: number; actionable: number; executed: number; passed: boolean | null } }>;
    summary: { polls: number; profileCount: number; planned: number; actionable: number; executed: number; passed: boolean | null };
  }>(baseUrl, [
    "runs",
    "recover-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--dry-run",
    "--loop",
    "--max-polls",
    "2",
    "--interval-ms",
    "1",
    "--lines",
    "1",
  ]);
  assert.equal(recoveryLoop.dryRun, true);
  assert.equal(recoveryLoop.loop, true);
  assert.equal(recoveryLoop.stoppedReason, "max_polls");
  assert.equal(recoveryLoop.iterations.length, 2);
  assert.deepEqual(recoveryLoop.iterations.map((iteration) => iteration.poll), [1, 2]);
  assert.equal(recoveryLoop.summary.polls, 2);
  assert.equal(recoveryLoop.summary.profileCount, 1);
  assert.equal(recoveryLoop.summary.planned, 4);
  assert.equal(recoveryLoop.summary.actionable, 4);
  assert.equal(recoveryLoop.summary.executed, 0);
  assert.equal(recoveryLoop.summary.passed, null);

  const recoveryWorker = await cliJson<{
    worker: { workerId: string; mode: string; command: string[] };
  }>(baseUrl, [
    "runs",
    "start-control-plane-worker-bundle-recovery-worker",
    sessionName,
    "--server",
    "--worker-id",
    recoveryWorkerId,
    "--dry-run",
    "--max-polls",
    "1",
    "--interval-ms",
    "1",
    "--lines",
    "1",
  ]);
  assert.equal(recoveryWorker.worker.workerId, recoveryWorkerId);
  assert.equal(recoveryWorker.worker.mode, "bundle_recovery_loop");
  assert.equal(recoveryWorker.worker.command.join(" "), `runs recover-control-plane-worker-bundles --server --session ${sessionName} --loop --max-polls 1 --interval-ms 1 --lines 1 --progress-json --dry-run`);

  const recoveryWorkers = await cliJson<{
    count: number;
    workers: Array<{ workerId: string; mode: string; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-bundle-recovery-workers",
    sessionName,
    "--server",
    "--worker-id",
    recoveryWorkerId,
    "--include-retired",
    "--lines",
    "1",
  ]);
  assert.equal(recoveryWorkers.count, 1);
  assert.equal(recoveryWorkers.workers[0]?.workerId, recoveryWorkerId);
  assert.equal(recoveryWorkers.workers[0]?.mode, "bundle_recovery_loop");

  const recoveryConfirmed = await cliJson<{
    confirmed: boolean;
    profileCount: number;
    summary: { planned: number; actionable: number; blocked: number; executed: number; passed: boolean | null };
    results: Array<{ session: string; result: { passed: boolean | null; executed: Array<{ workerId: string }> } }>;
  }>(baseUrl, [
    "runs",
    "recover-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(recoveryConfirmed.confirmed, true);
  assert.equal(recoveryConfirmed.profileCount, 1);
  assert.equal(recoveryConfirmed.summary.planned, 2);
  assert.equal(recoveryConfirmed.summary.actionable, 2);
  assert.equal(recoveryConfirmed.summary.blocked, 0);
  assert.equal(recoveryConfirmed.summary.executed, 2);
  assert.equal(recoveryConfirmed.summary.passed, true);
  assert.equal(recoveryConfirmed.results[0]?.result.passed, true);
  assert.deepEqual(
    recoveryConfirmed.results[0]?.result.executed.map((step) => step.workerId),
    [topologyWorkerId, resultReviewWorkerId],
  );

  const text = await cliText(baseUrl, [...bundleArgs, "--dry-run", "--format", "text"]);
  assert.match(text, /control_plane_worker_bundle:/);
  assert.match(text, new RegExp(`topology=${topologyWorkerId}`));
  assert.match(text, new RegExp(`result_review=${resultReviewWorkerId}`));
  assert.match(text, /plan: expected=2 actionable=0 blocked=\d+ existing=\d+/);

  const profileText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-worker-bundle",
    sessionName,
    "--server",
    "--format",
    "text",
    "--lines",
    "1",
  ]);
  assert.match(profileText, /control_plane_worker_bundle_profile:/);
  assert.match(profileText, /exists: true/);
  assert.match(profileText, /plan: expected=2 actionable=0 blocked=\d+ existing=\d+/);

  const profileListText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--format",
    "text",
    "--lines",
    "1",
  ]);
  assert.match(profileListText, /control_plane_worker_bundle_profiles:/);
  assert.match(profileListText, /profile_count: 1/);
  assert.match(profileListText, new RegExp(`- ${sessionName} exists=true`));

  const recoveryText = await cliText(baseUrl, [
    "runs",
    "recover-control-plane-worker-bundles",
    "--server",
    "--session",
    sessionName,
    "--dry-run",
    "--format",
    "text",
    "--lines",
    "1",
  ]);
  assert.match(recoveryText, /control_plane_worker_bundle_recovery:/);
  assert.match(recoveryText, /profile_count: 1/);

  const aggregate = await cliJson<{
    summary: {
      topology: { total: number };
      resultReview: { total: number };
      bundleRecovery: { total: number; latestResults: { count: number; profileCount: number; planned: number; actionable: number; blocked: number; executed: number; polls: number } };
    };
    workers: Array<{ kind: string; workerId: string | null; commands: { inspect: string[]; restart: string[]; stop: string[]; retire: string[]; reconcileDryRun: string[]; reconcileConfirm: string[]; reconcileUntilEmptyConfirm: string[] } | null }>;
    commands: { inspectBundleRecoveryWorkers: string[]; inspectProgress: string[] };
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
  assert.equal(aggregate.summary.bundleRecovery.total, 1);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.count, 1);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.profileCount, 1);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.planned, 2);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.actionable, 2);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.blocked, 0);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.executed, 0);
  assert.equal(aggregate.summary.bundleRecovery.latestResults.polls, 1);
  assert.ok(aggregate.workers.some((worker) => worker.kind === "control_plane_topology" && worker.workerId === topologyWorkerId));
  assert.ok(aggregate.workers.some((worker) => worker.kind === "result_review" && worker.workerId === resultReviewWorkerId));
  const aggregateRecoveryWorker = aggregate.workers.find((worker) => worker.kind === "control_plane_bundle_recovery" && worker.workerId === recoveryWorkerId);
  assert.ok(aggregateRecoveryWorker);
  assert.equal(
    aggregateRecoveryWorker.commands?.inspect.join(" "),
    `npm run cli -- runs session-control-plane-worker-bundle-recovery-workers ${sessionName} --server --worker-id ${recoveryWorkerId} --include-retired`,
  );
  assert.equal(
    aggregateRecoveryWorker.commands?.restart.join(" "),
    `npm run cli -- runs restart-control-plane-worker-bundle-recovery-worker ${sessionName} --server --worker-id ${recoveryWorkerId} --include-retired`,
  );
  assert.equal(
    aggregateRecoveryWorker.commands?.stop.join(" "),
    `npm run cli -- runs stop-control-plane-worker-bundle-recovery-worker ${sessionName} --server --worker-id ${recoveryWorkerId}`,
  );
  assert.equal(
    aggregateRecoveryWorker.commands?.reconcileDryRun.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --worker-id ${recoveryWorkerId} --kind control-plane-bundle-recovery --include-retired --dry-run`,
  );
  assert.equal(
    aggregateRecoveryWorker.commands?.reconcileConfirm.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --worker-id ${recoveryWorkerId} --kind control-plane-bundle-recovery --include-retired --confirm`,
  );
  assert.equal(
    aggregateRecoveryWorker.commands?.reconcileUntilEmptyConfirm.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --worker-id ${recoveryWorkerId} --kind control-plane-bundle-recovery --include-retired --until-empty --max-steps 10 --interval-ms 2000 --confirm`,
  );
  assert.equal(
    aggregate.commands.inspectBundleRecoveryWorkers.join(" "),
    `npm run cli -- runs session-control-plane-worker-bundle-recovery-workers ${sessionName} --server --include-retired --lines 1`,
  );

  const aggregateText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-workers",
    sessionName,
    "--server",
    "--include-retired",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(aggregateText, /bundle_recovery: total=1 alive=0 stopped=0 completed=1 retired=0 exited_unrecorded=0 restartable=0/);
  assert.match(aggregateText, /profile_count=1,planned=2,actionable=2,blocked=0,executed=0,polls=1/);
  assert.match(aggregateText, new RegExp(`inspect_bundle_recovery: npm run cli -- runs session-control-plane-worker-bundle-recovery-workers ${sessionName} --server --include-retired --lines 1`));

  const bundleProgress = await cliJson<{
    count: number;
    progress: Array<{ kind: string; workerId: string | null; profileCount?: number; polls?: number }>;
    commands: { refresh: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-progress",
    sessionName,
    "--server",
    "--kind",
    "bundle-recovery",
    "--include-retired",
    "--limit",
    "5",
  ]);
  assert.equal(bundleProgress.count, 1);
  assert.equal(bundleProgress.progress[0]?.kind, "control_plane_bundle_recovery");
  assert.equal(bundleProgress.progress[0]?.workerId, recoveryWorkerId);
  assert.equal(bundleProgress.progress[0]?.profileCount, 1);
  assert.equal(bundleProgress.progress[0]?.polls, 1);
  assert.equal(
    bundleProgress.commands.refresh.join(" "),
    `npm run cli -- runs session-control-plane-worker-progress ${sessionName} --server --kind control-plane-bundle-recovery --include-retired --limit 5`,
  );

  const bundleRecoveryDrillDryRun = await cliJson<{
    dryRun: boolean;
    passed: boolean | null;
    kind: string;
    workerId: string;
    before: { worker: { kind: string; workerId: string | null; state: string | null } | null; commands: { stop: string[]; restart: string[]; aggregate: string[] } };
    checks: { workerSeenBefore: boolean; restartStepSeen: boolean };
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-drill",
    sessionName,
    "--server",
    "--kind",
    "bundle-recovery",
    "--worker-id",
    recoveryWorkerId,
    "--include-retired",
    "--dry-run",
    "--lines",
    "1",
  ]);
  assert.equal(bundleRecoveryDrillDryRun.dryRun, true);
  assert.equal(bundleRecoveryDrillDryRun.passed, null);
  assert.equal(bundleRecoveryDrillDryRun.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryDrillDryRun.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryDrillDryRun.checks.workerSeenBefore, true);
  assert.equal(bundleRecoveryDrillDryRun.before.worker?.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryDrillDryRun.before.worker?.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryDrillDryRun.before.worker?.state, "completed");
  assert.equal(
    bundleRecoveryDrillDryRun.before.commands.stop.join(" "),
    `npm run cli -- runs stop-control-plane-worker-bundle-recovery-worker ${sessionName} --server --worker-id ${recoveryWorkerId}`,
  );
  assert.equal(
    bundleRecoveryDrillDryRun.before.commands.restart.join(" "),
    `npm run cli -- runs restart-control-plane-worker-bundle-recovery-worker ${sessionName} --server --worker-id ${recoveryWorkerId} --include-retired`,
  );
  assert.equal(
    bundleRecoveryDrillDryRun.before.commands.aggregate.join(" "),
    `npm run cli -- runs session-control-plane-workers ${sessionName} --server --worker-id ${recoveryWorkerId} --include-retired --lines 1`,
  );

  const bundleRecoveryDrill = await cliJson<{
    confirmed: boolean;
    passed: boolean | null;
    kind: string;
    workerId: string;
    stopped: { count: number } | null;
    restarted: { count: number } | null;
    afterStop: { nextSteps: Array<{ kind: string; workerId: string | null; command: string[] }> } | null;
    afterRestart: { worker: { kind: string; workerId: string | null; alive: boolean; state: string | null } | null } | null;
    checks: {
      stopCount: number | null;
      restartStepSeen: boolean;
      restartCount: number | null;
      workerSeenAfterRestart: boolean | null;
      workerAliveAfterRestart: boolean | null;
      workerCompletedAfterRestart: boolean | null;
    };
  }>(baseUrl, [
    "runs",
    "session-control-plane-worker-drill",
    sessionName,
    "--server",
    "--kind",
    "bundle-recovery",
    "--worker-id",
    recoveryWorkerId,
    "--include-retired",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(bundleRecoveryDrill.confirmed, true);
  assert.equal(bundleRecoveryDrill.passed, true);
  assert.equal(bundleRecoveryDrill.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryDrill.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryDrill.stopped?.count, 1);
  assert.equal(bundleRecoveryDrill.restarted?.count, 1);
  assert.equal(bundleRecoveryDrill.checks.stopCount, 1);
  assert.equal(bundleRecoveryDrill.checks.restartStepSeen, true);
  assert.equal(bundleRecoveryDrill.checks.restartCount, 1);
  assert.equal(bundleRecoveryDrill.checks.workerSeenAfterRestart, true);
  assert.ok(bundleRecoveryDrill.checks.workerAliveAfterRestart === true || bundleRecoveryDrill.checks.workerCompletedAfterRestart === true);
  assert.ok(bundleRecoveryDrill.afterStop?.nextSteps.some((step) => (
    step.kind === "control_plane_bundle_recovery"
    && step.workerId === recoveryWorkerId
    && step.command.join(" ") === `npm run cli -- runs restart-control-plane-worker-bundle-recovery-worker ${sessionName} --server --worker-id ${recoveryWorkerId}`
  )));
  assert.equal(bundleRecoveryDrill.afterRestart?.worker?.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryDrill.afterRestart?.worker?.workerId, recoveryWorkerId);

  const stoppedForReconcile = await cliJson<{ count: number }>(baseUrl, [
    "runs",
    "stop-control-plane-worker-bundle-recovery-worker",
    sessionName,
    "--server",
    "--worker-id",
    recoveryWorkerId,
    "--lines",
    "1",
  ]);
  assert.equal(stoppedForReconcile.count, 1);

  const bundleRecoveryReconcileDryRun = await cliJson<{
    dryRun: boolean;
    confirmed: boolean;
    passed: boolean | null;
    filter: { workerId: string | null; kind: string | null; includeRetired: boolean };
    plan: { count: number; steps: Array<{ kind: string; workerId: string; command: string[] }> };
    executed: unknown[];
  }>(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--kind",
    "bundle-recovery",
    "--worker-id",
    recoveryWorkerId,
    "--include-retired",
    "--dry-run",
    "--lines",
    "1",
  ]);
  assert.equal(bundleRecoveryReconcileDryRun.dryRun, true);
  assert.equal(bundleRecoveryReconcileDryRun.confirmed, false);
  assert.equal(bundleRecoveryReconcileDryRun.passed, null);
  assert.equal(bundleRecoveryReconcileDryRun.filter.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryReconcileDryRun.filter.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryReconcileDryRun.filter.includeRetired, true);
  assert.equal(bundleRecoveryReconcileDryRun.plan.count, 1);
  assert.equal(bundleRecoveryReconcileDryRun.plan.steps[0]?.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryReconcileDryRun.plan.steps[0]?.workerId, recoveryWorkerId);
  assert.equal(
    bundleRecoveryReconcileDryRun.plan.steps[0]?.command.join(" "),
    `npm run cli -- runs restart-control-plane-worker-bundle-recovery-worker ${sessionName} --server --worker-id ${recoveryWorkerId}`,
  );
  assert.deepEqual(bundleRecoveryReconcileDryRun.executed, []);

  const bundleRecoveryReconcile = await cliJson<{
    confirmed: boolean;
    passed: boolean | null;
    plan: { count: number };
    executed: Array<{ kind: string; workerId: string; restartCount: number | null }>;
    checks: { plannedCount: number; executedCount: number | null; remainingCount: number | null };
    after: { workers: Array<{ kind: string; workerId: string | null; state: string | null }> } | null;
    reconciliationRecord: { reconciliationId: string; path: string };
  }>(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--kind",
    "bundle-recovery",
    "--worker-id",
    recoveryWorkerId,
    "--include-retired",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(bundleRecoveryReconcile.confirmed, true);
  assert.equal(bundleRecoveryReconcile.passed, true);
  assert.equal(bundleRecoveryReconcile.plan.count, 1);
  assert.equal(bundleRecoveryReconcile.executed.length, 1);
  assert.equal(bundleRecoveryReconcile.executed[0]?.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryReconcile.executed[0]?.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryReconcile.executed[0]?.restartCount, 1);
  assert.equal(bundleRecoveryReconcile.checks.plannedCount, 1);
  assert.equal(bundleRecoveryReconcile.checks.executedCount, 1);
  assert.equal(bundleRecoveryReconcile.checks.remainingCount, 0);
  assert.ok(bundleRecoveryReconcile.reconciliationRecord.reconciliationId);
  assert.ok(bundleRecoveryReconcile.reconciliationRecord.path.endsWith(".json"));
  const reconciledWorker = bundleRecoveryReconcile.after?.workers.find((worker) => worker.kind === "control_plane_bundle_recovery" && worker.workerId === recoveryWorkerId);
  assert.ok(reconciledWorker);
  assert.ok(reconciledWorker.state === "running" || reconciledWorker.state === "completed");

  const stoppedForReconcileLoop = await cliJson<{ count: number }>(baseUrl, [
    "runs",
    "stop-control-plane-worker-bundle-recovery-worker",
    sessionName,
    "--server",
    "--worker-id",
    recoveryWorkerId,
    "--lines",
    "1",
  ]);
  assert.equal(stoppedForReconcileLoop.count, 1);

  const bundleRecoveryReconcileLoop = await cliJson<{
    confirmed: boolean;
    untilEmpty: boolean;
    passed: boolean | null;
    stoppedReason: string;
    filter: { workerId: string | null; kind: string | null; includeRetired: boolean };
    summary: { iterations: number; totalPlanned: number; totalExecuted: number; lastNextPlannedCount: number | null; lastRemainingCount: number | null };
    iterations: Array<{ step: number; result: { plan: { count: number }; executed: Array<{ kind: string; workerId: string; restartCount: number | null }>; checks: { remainingCount: number | null } }; nextPlannedCount: number | null }>;
    commands: { confirm: string[] };
    reconciliationRecord: { reconciliationId: string; path: string };
  }>(baseUrl, [
    "runs",
    "session-control-plane-reconcile-workers",
    sessionName,
    "--server",
    "--kind",
    "bundle-recovery",
    "--worker-id",
    recoveryWorkerId,
    "--include-retired",
    "--until-empty",
    "--max-steps",
    "2",
    "--interval-ms",
    "1",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(bundleRecoveryReconcileLoop.confirmed, true);
  assert.equal(bundleRecoveryReconcileLoop.untilEmpty, true);
  assert.equal(bundleRecoveryReconcileLoop.passed, true);
  assert.equal(bundleRecoveryReconcileLoop.stoppedReason, "empty");
  assert.equal(bundleRecoveryReconcileLoop.filter.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryReconcileLoop.filter.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryReconcileLoop.filter.includeRetired, true);
  assert.equal(bundleRecoveryReconcileLoop.summary.iterations, 1);
  assert.equal(bundleRecoveryReconcileLoop.summary.totalPlanned, 1);
  assert.equal(bundleRecoveryReconcileLoop.summary.totalExecuted, 1);
  assert.equal(bundleRecoveryReconcileLoop.summary.lastNextPlannedCount, 0);
  assert.equal(bundleRecoveryReconcileLoop.summary.lastRemainingCount, 0);
  assert.equal(bundleRecoveryReconcileLoop.iterations[0]?.result.plan.count, 1);
  assert.equal(bundleRecoveryReconcileLoop.iterations[0]?.result.executed[0]?.kind, "control_plane_bundle_recovery");
  assert.equal(bundleRecoveryReconcileLoop.iterations[0]?.result.executed[0]?.workerId, recoveryWorkerId);
  assert.equal(bundleRecoveryReconcileLoop.iterations[0]?.result.executed[0]?.restartCount, 1);
  assert.equal(bundleRecoveryReconcileLoop.iterations[0]?.nextPlannedCount, 0);
  assert.equal(
    bundleRecoveryReconcileLoop.commands.confirm.join(" "),
    `npm run cli -- runs session-control-plane-reconcile-workers ${sessionName} --server --worker-id ${recoveryWorkerId} --kind control-plane-bundle-recovery --include-retired --lines 1 --until-empty --max-steps 2 --interval-ms 1 --confirm`,
  );
  assert.ok(bundleRecoveryReconcileLoop.reconciliationRecord.reconciliationId);
  assert.ok(bundleRecoveryReconcileLoop.reconciliationRecord.path.endsWith(".json"));
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.out.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.err.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-worker-bundles", `${sessionName}.json`), { force: true });
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
