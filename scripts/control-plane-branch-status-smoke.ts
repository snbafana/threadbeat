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
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "threadbeat-branch-status-smoke-"));
const sessionName = `branch-status-${Date.now().toString(36)}`;
const workerId = "branch-status-worker";

const settings: Settings = {
  projectRoot: path.resolve("."),
  dbUrl: `file:${path.join(tempRoot, "threadbeat.db")}`,
  host: "127.0.0.1",
  port: 0,
  modalMode: "dry-run",
  modalAppName: "threadbeat-branch-status-smoke",
  modalImage: "python:3.13-slim",
  githubOwner: "threadbeat-branch-status-smoke",
};

const { app, db } = await buildServer(settings);

try {
  const agent = await db.createAgent({
    name: "branch-status-agent",
    repoUrl: "https://github.com/threadbeat-branch-status-smoke/agent.git",
    currentRef: "main",
  });
  await writeWorkerSessionRecord(agent.id);
  const run = await db.createAgentRun({
    agentId: agent.id,
    objective: "control-plane branch resume command queue",
    inputRef: "main",
    runBranch: `threadbeat/runs/${sessionName}`,
  });
  await db.updateAgentRunCompleted({ id: run.id, status: "stopped" });

  await app.listen({ host: settings.host, port: settings.port });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://${settings.host}:${address.port}`;

  const branchResumeQueueCommand = `npm run cli -- runs session-branches ${sessionName} --server --resumable --branch-action resume_branch --limit 5 --commands-only --format shell`;
  const branchTerminalsCommand = `npm run cli -- runs session-control-plane-branch-terminals ${sessionName} --server`;
  const branchTerminalsResumableCommand = `npm run cli -- runs session-control-plane-branch-terminals ${sessionName} --server --status resumable`;
  const branchNativeNextCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server`;
  const branchNativeRecoverDryRunCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server --recover-next --dry-run`;
  const branchNativeRecoverConfirmCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server --recover-next --confirm`;
  const branchNativeRecoverLoopDryRunCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server --recover-next --until-empty --dry-run`;
  const branchNativeRecoverLoopConfirmCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server --recover-next --until-empty --confirm`;
  const controlPlaneRecoverNextDryRunCommand = `npm run cli -- runs session-control-plane-recover-next ${sessionName} --server --dry-run`;
  const controlPlaneRecoverNextConfirmCommand = `npm run cli -- runs session-control-plane-recover-next ${sessionName} --server --confirm`;
  const controlPlaneRecoverNextLoopConfirmCommand = `npm run cli -- runs session-control-plane-recover-next ${sessionName} --server --confirm --until-empty --max-steps 3 --interval-ms 0 --lines 1`;
  const resumeBranchCommand = `npm run cli -- runs resume-branch ${run.id}`;
  const resumeBranchDryRunCommand = `${resumeBranchCommand} --dry-run`;

  const summary = await cliJson<{
    branches: {
      counts: { ready: number };
      inspection: { count: number; nextSteps: Array<{ runId: string; commands: { resumeBranch: string[] | null } }> };
    };
    commands: { branchResumeCommandQueue: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
  ]);
  assert.equal(summary.branches.counts.ready, 1);
  assert.equal(summary.branches.inspection.count, 1);
  assert.equal(summary.branches.inspection.nextSteps[0]?.runId, run.id);
  assert.equal(summary.branches.inspection.nextSteps[0]?.commands.resumeBranch?.join(" "), resumeBranchCommand);
  assert.equal(summary.commands.branchResumeCommandQueue.join(" "), branchResumeQueueCommand);

  const commandSummary = await cliJson<{ commands: Array<{ command: string[] }> }>(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--commands-only",
  ]);
  assert.ok(commandSummary.commands.some((command) => command.command.join(" ") === branchResumeQueueCommand));

  const textSummary = await cliText(baseUrl, [
    "runs",
    "session-control-plane-status",
    sessionName,
    "--server",
    "--summary",
    "--format",
    "text",
  ]);
  assert.match(textSummary, /branch_inspection:/);
  assert.match(textSummary, new RegExp(`resume_queue: ${branchResumeQueueCommand}`));
  assert.match(textSummary, new RegExp(`resume: ${resumeBranchCommand}`));

  const branchQueueShell = await cliText(baseUrl, [
    "runs",
    "session-branches",
    sessionName,
    "--server",
    "--resumable",
    "--branch-action",
    "resume_branch",
    "--limit",
    "5",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(branchQueueShell, new RegExp(`^${resumeBranchCommand}$`, "m"));

  const branchTerminals = await cliJson<{
    count: number;
    summary: { resumable: number; stoppedWithoutResultCommit: number; dryRunnable: number };
    commands: { resumeQueue: string[]; queue: Array<{ action: string; runId: string; command: string[] }> };
    terminalBranches: Array<{
      runId: string;
      reason: string;
      commands: { resumeBranch: string[] | null; resumeBranchDryRun: string[] };
    }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-branch-terminals",
    sessionName,
    "--server",
  ]);
  assert.equal(branchTerminals.count, 1);
  assert.equal(branchTerminals.summary.resumable, 1);
  assert.equal(branchTerminals.summary.stoppedWithoutResultCommit, 1);
  assert.equal(branchTerminals.summary.dryRunnable, 1);
  assert.equal(branchTerminals.commands.resumeQueue.join(" "), branchResumeQueueCommand);
  assert.equal(branchTerminals.terminalBranches[0]?.runId, run.id);
  assert.equal(branchTerminals.terminalBranches[0]?.reason, "stopped_branch_without_result_commit");
  assert.equal(branchTerminals.terminalBranches[0]?.commands.resumeBranch?.join(" "), resumeBranchCommand);
  assert.equal(branchTerminals.terminalBranches[0]?.commands.resumeBranchDryRun.join(" "), resumeBranchDryRunCommand);
  assert.ok(branchTerminals.commands.queue.some((command) => command.action === "resume_branch" && command.runId === run.id && command.command.join(" ") === resumeBranchCommand));
  assert.ok(branchTerminals.commands.queue.some((command) => command.action === "resume_branch_dry_run" && command.runId === run.id && command.command.join(" ") === resumeBranchDryRunCommand));

  const branchTerminalsText = await cliText(baseUrl, [
    "runs",
    "session-control-plane-branch-terminals",
    sessionName,
    "--server",
    "--format",
    "text",
  ]);
  assert.match(branchTerminalsText, /branch_resume_terminals:/);
  assert.match(branchTerminalsText, /summary: resumable=1 stopped_without_result_commit=1/);
  assert.match(branchTerminalsText, new RegExp(`resume: ${resumeBranchCommand}`));
  assert.match(branchTerminalsText, new RegExp(`resume_dry_run: ${resumeBranchDryRunCommand}`));

  const branchTerminalsShell = await cliText(baseUrl, [
    "runs",
    "session-control-plane-branch-terminals",
    sessionName,
    "--server",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(branchTerminalsShell, new RegExp(`^${resumeBranchCommand}$`, "m"));
  assert.match(branchTerminalsShell, new RegExp(`^${resumeBranchDryRunCommand}$`, "m"));

  const branchNativeNext = await cliJson<{
    ok: boolean;
    counts: { branchReady: number; branchActions: number };
    branchActions: Array<{ runId: string; commands: { resumeBranch: string[] | null } }>;
    commands: Array<{ command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
  ]);
  assert.equal(branchNativeNext.ok, true);
  assert.equal(branchNativeNext.counts.branchReady, 1);
  assert.equal(branchNativeNext.counts.branchActions, 1);
  assert.equal(branchNativeNext.branchActions[0]?.runId, run.id);
  assert.equal(branchNativeNext.branchActions[0]?.commands.resumeBranch?.join(" "), resumeBranchCommand);
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchNativeNextCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchNativeRecoverDryRunCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchNativeRecoverConfirmCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchNativeRecoverLoopDryRunCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchNativeRecoverLoopConfirmCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchResumeQueueCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchTerminalsCommand));
  assert.ok(branchNativeNext.commands.some((command) => command.command.join(" ") === branchTerminalsResumableCommand));
  const branchNativeBranchCommands = await cliText(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--surface",
    "branch",
    "--commands-only",
    "--format",
    "shell",
  ]);
  assert.match(branchNativeBranchCommands, new RegExp(`^${branchTerminalsCommand}$`, "m"));
  assert.match(branchNativeBranchCommands, new RegExp(`^${branchTerminalsResumableCommand}$`, "m"));
  assert.match(branchNativeBranchCommands, new RegExp(`^${branchResumeQueueCommand}$`, "m"));
  assert.match(branchNativeBranchCommands, new RegExp(`^${resumeBranchCommand}$`, "m"));
  assert.doesNotMatch(branchNativeBranchCommands, new RegExp(`^${branchNativeRecoverDryRunCommand}$`, "m"));
  const branchNativeRecoverNextCommands = await cliJson<{
    commandSurfaces: string[];
    commands: Array<{ surfaces: string[]; command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--surface",
    "recover_next",
    "--commands-only",
  ]);
  assert.deepEqual(branchNativeRecoverNextCommands.commandSurfaces, ["recover_next"]);
  assert.ok(branchNativeRecoverNextCommands.commands.length > 0);
  assert.ok(branchNativeRecoverNextCommands.commands.every((command) => command.surfaces.includes("recover_next")));
  assert.ok(branchNativeRecoverNextCommands.commands.some((command) => command.command.join(" ") === branchNativeRecoverDryRunCommand));
  assert.ok(!branchNativeRecoverNextCommands.commands.some((command) => command.command.join(" ") === branchResumeQueueCommand));

  const branchNativeRecoverDryRun = await cliJson<{
    dryRun: boolean;
    confirmed: boolean;
    selectedAction: string;
    counts: { branchReady: number };
    recoverNext: { dryRun: boolean; selected: { surface: string; action: string; reason: string } };
    executed: { command: string[]; exitCode: number | null };
    after: null;
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--recover-next",
    "--dry-run",
    "--lines",
    "1",
  ]);
  assert.equal(branchNativeRecoverDryRun.dryRun, true);
  assert.equal(branchNativeRecoverDryRun.confirmed, false);
  assert.equal(branchNativeRecoverDryRun.selectedAction, "recover_next");
  assert.equal(branchNativeRecoverDryRun.counts.branchReady, 1);
  assert.equal(branchNativeRecoverDryRun.recoverNext.dryRun, true);
  assert.equal(branchNativeRecoverDryRun.recoverNext.selected.surface, "branch");
  assert.equal(branchNativeRecoverDryRun.recoverNext.selected.action, "resume_branch");
  assert.equal(branchNativeRecoverDryRun.executed.command.join(" "), `${controlPlaneRecoverNextDryRunCommand} --lines 1`);
  assert.equal(branchNativeRecoverDryRun.executed.exitCode, 0);
  assert.equal(branchNativeRecoverDryRun.after, null);

  const branchNativeRecoverDryRunText = await cliText(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--recover-next",
    "--dry-run",
    "--lines",
    "1",
    "--format",
    "text",
  ]);
  assert.match(branchNativeRecoverDryRunText, /branch_native_next_recovery:/);
  assert.match(branchNativeRecoverDryRunText, /dry_run: true/);
  assert.match(branchNativeRecoverDryRunText, /action: recover_next/);
  assert.match(branchNativeRecoverDryRunText, /surface: branch/);
  assert.match(branchNativeRecoverDryRunText, /selected: resume_branch/);
  assert.match(branchNativeRecoverDryRunText, new RegExp(`command: ${controlPlaneRecoverNextDryRunCommand} --lines 1`));

  const branchNativeRecoverConfirm = await cliJson<{
    dryRun: boolean;
    confirmed: boolean;
    selectedAction: string;
    counts: { branchReady: number };
    recoverNext: { dryRun: boolean; selected: { surface: string; action: string; reason: string } };
    executed: { command: string[]; exitCode: number | null };
    after: { counts: { branchReady: number; branchActions: number } };
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--recover-next",
    "--confirm",
    "--lines",
    "1",
  ]);
  assert.equal(branchNativeRecoverConfirm.dryRun, false);
  assert.equal(branchNativeRecoverConfirm.confirmed, true);
  assert.equal(branchNativeRecoverConfirm.selectedAction, "recover_next");
  assert.equal(branchNativeRecoverConfirm.counts.branchReady, 1);
  assert.equal(branchNativeRecoverConfirm.recoverNext.dryRun, false);
  assert.equal(branchNativeRecoverConfirm.recoverNext.selected.surface, "branch");
  assert.equal(branchNativeRecoverConfirm.recoverNext.selected.action, "resume_branch");
  assert.equal(branchNativeRecoverConfirm.executed.command.join(" "), `${controlPlaneRecoverNextConfirmCommand} --lines 1`);
  assert.equal(branchNativeRecoverConfirm.executed.exitCode, 0);
  assert.equal(branchNativeRecoverConfirm.after.counts.branchReady, 0);
  assert.equal(branchNativeRecoverConfirm.after.counts.branchActions, 0);

  const requeuedRun = await db.getAgentRun(run.id);
  assert.equal(requeuedRun?.status, "planned");
  assert.equal(requeuedRun?.worker_id, null);

  const branchNativeAfterConfirm = await cliJson<{
    counts: { branchReady: number; branchActions: number };
    branchActions: unknown[];
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
  ]);
  assert.equal(branchNativeAfterConfirm.counts.branchReady, 0);
  assert.equal(branchNativeAfterConfirm.counts.branchActions, 0);
  assert.equal(branchNativeAfterConfirm.branchActions.length, 0);

  const loopRunA = await db.createAgentRun({
    agentId: agent.id,
    objective: "control-plane branch native recover loop a",
    inputRef: "main",
    runBranch: `threadbeat/runs/${sessionName}-loop-a`,
  });
  const loopRunB = await db.createAgentRun({
    agentId: agent.id,
    objective: "control-plane branch native recover loop b",
    inputRef: "main",
    runBranch: `threadbeat/runs/${sessionName}-loop-b`,
  });
  await db.updateAgentRunCompleted({ id: loopRunA.id, status: "stopped" });
  await db.updateAgentRunCompleted({ id: loopRunB.id, status: "stopped" });

  const branchNativeBeforeLoop = await cliJson<{
    counts: { branchReady: number; branchActions: number };
    commands: Array<{ command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
  ]);
  assert.equal(branchNativeBeforeLoop.counts.branchReady, 2);
  assert.equal(branchNativeBeforeLoop.counts.branchActions, 2);
  assert.ok(branchNativeBeforeLoop.commands.some((command) => command.command.join(" ") === branchNativeRecoverLoopDryRunCommand));
  assert.ok(branchNativeBeforeLoop.commands.some((command) => command.command.join(" ") === branchNativeRecoverLoopConfirmCommand));

  const branchNativeRecoverLoopConfirm = await cliJson<{
    dryRun: boolean;
    confirmed: boolean;
    selectedAction: string;
    recoverNext: {
      untilEmpty: boolean;
      executedSteps: number;
      stoppedReason: string;
      loopAdvanceId: string;
      advanceId: string;
      advancePath: string;
      cycles: Array<{ ok: boolean; selected: null | { surface?: string; action?: string } }>;
    };
    executed: { command: string[]; exitCode: number | null };
    after: { counts: { branchReady: number; branchActions: number } };
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--recover-next",
    "--until-empty",
    "--confirm",
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
    "--lines",
    "1",
  ]);
  assert.equal(branchNativeRecoverLoopConfirm.dryRun, false);
  assert.equal(branchNativeRecoverLoopConfirm.confirmed, true);
  assert.equal(branchNativeRecoverLoopConfirm.selectedAction, "recover_next");
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.untilEmpty, true);
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.executedSteps, 2);
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.stoppedReason, "empty");
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.loopAdvanceId, branchNativeRecoverLoopConfirm.recoverNext.advanceId);
  assert.match(branchNativeRecoverLoopConfirm.recoverNext.advancePath, /control-plane-advances/);
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.cycles.length, 3);
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.cycles[0]?.selected?.surface, "branch");
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.cycles[0]?.selected?.action, "resume_branch");
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.cycles[1]?.selected?.surface, "branch");
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.cycles[1]?.selected?.action, "resume_branch");
  assert.equal(branchNativeRecoverLoopConfirm.recoverNext.cycles[2]?.selected, null);
  assert.equal(branchNativeRecoverLoopConfirm.executed.command.join(" "), controlPlaneRecoverNextLoopConfirmCommand);
  assert.equal(branchNativeRecoverLoopConfirm.executed.exitCode, 0);
  assert.equal(branchNativeRecoverLoopConfirm.after.counts.branchReady, 0);
  assert.equal(branchNativeRecoverLoopConfirm.after.counts.branchActions, 0);

  const requeuedLoopRunA = await db.getAgentRun(loopRunA.id);
  const requeuedLoopRunB = await db.getAgentRun(loopRunB.id);
  assert.equal(requeuedLoopRunA?.status, "planned");
  assert.equal(requeuedLoopRunA?.worker_id, null);
  assert.equal(requeuedLoopRunB?.status, "planned");
  assert.equal(requeuedLoopRunB?.worker_id, null);

  const recoverNextLoopHistory = await cliJson<{
    loopAdvanceId: string;
    count: number;
    summary: { completed: boolean; steps: number; resumeAttempts: number; failedExecutions: number; dryRunRecords: number; stoppedReasons: string[] };
    records: Array<{ kind: string; stepIndex: number | null; stoppedReason: string | null; selectedSurface: string | null; selectedAction: string | null }>;
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    branchNativeRecoverLoopConfirm.recoverNext.loopAdvanceId,
    "--recover-next-loop-history",
  ]);
  assert.equal(recoverNextLoopHistory.loopAdvanceId, branchNativeRecoverLoopConfirm.recoverNext.loopAdvanceId);
  assert.equal(recoverNextLoopHistory.count, 4);
  assert.equal(recoverNextLoopHistory.summary.completed, true);
  assert.equal(recoverNextLoopHistory.summary.steps, 3);
  assert.equal(recoverNextLoopHistory.summary.resumeAttempts, 0);
  assert.equal(recoverNextLoopHistory.summary.failedExecutions, 0);
  assert.equal(recoverNextLoopHistory.summary.dryRunRecords, 0);
  assert.deepEqual(recoverNextLoopHistory.summary.stoppedReasons, ["empty"]);
  assert.ok(recoverNextLoopHistory.records.some((record) => (
    record.kind === "step"
    && record.stepIndex === 1
    && record.selectedSurface === "branch"
    && record.selectedAction === "resume_branch"
  )));
  assert.ok(recoverNextLoopHistory.records.some((record) => (
    record.kind === "step"
    && record.stepIndex === 2
    && record.selectedSurface === "branch"
    && record.selectedAction === "resume_branch"
  )));
  assert.ok(recoverNextLoopHistory.records.some((record) => (
    record.kind === "loop"
    && record.stoppedReason === "empty"
  )));

  const interruptedLoopRun = await db.createAgentRun({
    agentId: agent.id,
    objective: "control-plane branch native interrupted recover loop",
    inputRef: "main",
    runBranch: `threadbeat/runs/${sessionName}-interrupted-loop`,
  });
  await db.updateAgentRunCompleted({ id: interruptedLoopRun.id, status: "stopped" });

  const branchNativeRecoverLoopDryRun = await cliJson<{
    recoverNext: {
      dryRun: boolean;
      untilEmpty: boolean;
      loopAdvanceId: string;
      advanceId: string;
      advancePath: string;
      executedSteps: number;
      stoppedReason: string;
    };
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--recover-next",
    "--until-empty",
    "--dry-run",
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
    "--lines",
    "1",
  ]);
  assert.equal(branchNativeRecoverLoopDryRun.recoverNext.dryRun, true);
  assert.equal(branchNativeRecoverLoopDryRun.recoverNext.untilEmpty, true);
  assert.equal(branchNativeRecoverLoopDryRun.recoverNext.loopAdvanceId, branchNativeRecoverLoopDryRun.recoverNext.advanceId);
  assert.equal(branchNativeRecoverLoopDryRun.recoverNext.executedSteps, 1);
  assert.equal(branchNativeRecoverLoopDryRun.recoverNext.stoppedReason, "dry_run");

  await fs.rm(branchNativeRecoverLoopDryRun.recoverNext.advancePath, { force: true });
  const interruptedLoopId = branchNativeRecoverLoopDryRun.recoverNext.loopAdvanceId;
  const recoverNextIncompleteLoopQueueCommand = `npm run cli -- runs session-control-plane-alert ${sessionName} --server --surface recover_next --reason incomplete_recover_next_loop --commands-only --format shell`;
  const branchNativeInterruptedLoopDryRunCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server --recover-next --until-empty --resume-loop ${interruptedLoopId} --max-steps 3 --interval-ms 0 --dry-run`;
  const branchNativeInterruptedLoopConfirmCommand = `npm run cli -- runs session-branch-native-next ${sessionName} --server --recover-next --until-empty --resume-loop ${interruptedLoopId} --max-steps 3 --interval-ms 0 --confirm`;
  const interruptedLoopResumeCommand = `npm run cli -- runs session-control-plane-recover-next ${sessionName} --server --until-empty --resume-loop ${interruptedLoopId} --max-steps 3 --interval-ms 0 --dry-run`;
  const interruptedLoopHistoryCommand = `npm run cli -- runs session-control-plane-advances ${sessionName} --server --loop-advance-id ${interruptedLoopId} --recover-next-loop-history`;
  const interruptedLoopExecuteResumeCommand = `${interruptedLoopHistoryCommand} --execute-resume --confirm`;

  const branchNativeWithInterruptedLoop = await cliJson<{
    counts: { recoverNextIncompleteLoops: number; failedRecoverNextResumeLoops: number };
    recoverNextLoops: Array<{
      loopAdvanceId: string;
      steps: number;
      dryRun: boolean;
      lastStepIndex: number | null;
      stoppedReason: string | null;
      resumeCommand: string[];
      inspectHistoryCommand: string[];
      executeResumeCommand: string[];
    }>;
    failedRecoverNextResumeLoops: unknown[];
    commands: Array<{ command: string[] }>;
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
  ]);
  assert.equal(branchNativeWithInterruptedLoop.counts.recoverNextIncompleteLoops, 1);
  assert.equal(branchNativeWithInterruptedLoop.counts.failedRecoverNextResumeLoops, 0);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops.length, 1);
  assert.equal(branchNativeWithInterruptedLoop.failedRecoverNextResumeLoops.length, 0);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.loopAdvanceId, interruptedLoopId);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.steps, 1);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.dryRun, true);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.lastStepIndex, 1);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.stoppedReason, "dry_run");
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.resumeCommand.join(" "), interruptedLoopResumeCommand);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.inspectHistoryCommand.join(" "), interruptedLoopHistoryCommand);
  assert.equal(branchNativeWithInterruptedLoop.recoverNextLoops[0]?.executeResumeCommand.join(" "), interruptedLoopExecuteResumeCommand);
  assert.ok(branchNativeWithInterruptedLoop.commands.some((command) => command.command.join(" ") === recoverNextIncompleteLoopQueueCommand));
  assert.ok(branchNativeWithInterruptedLoop.commands.some((command) => command.command.join(" ") === branchNativeInterruptedLoopDryRunCommand));
  assert.ok(branchNativeWithInterruptedLoop.commands.some((command) => command.command.join(" ") === branchNativeInterruptedLoopConfirmCommand));
  assert.ok(branchNativeWithInterruptedLoop.commands.some((command) => command.command.join(" ") === interruptedLoopResumeCommand));
  assert.ok(branchNativeWithInterruptedLoop.commands.some((command) => command.command.join(" ") === interruptedLoopHistoryCommand));
  assert.ok(branchNativeWithInterruptedLoop.commands.some((command) => command.command.join(" ") === interruptedLoopExecuteResumeCommand));

  const branchNativeInterruptedLoopText = await cliText(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--format",
    "text",
  ]);
  assert.match(branchNativeInterruptedLoopText, /recover_next_incomplete_loops: 1/);
  assert.match(branchNativeInterruptedLoopText, new RegExp(`loop: ${interruptedLoopId}`));
  assert.match(branchNativeInterruptedLoopText, /branch_native_resume_dry_run: npm run cli -- runs session-branch-native-next/);
  assert.match(branchNativeInterruptedLoopText, /branch_native_resume_confirm: npm run cli -- runs session-branch-native-next/);
  assert.match(branchNativeInterruptedLoopText, /resume: npm run cli -- runs session-control-plane-recover-next/);
  assert.match(branchNativeInterruptedLoopText, /inspect_history: npm run cli -- runs session-control-plane-advances/);
  assert.match(branchNativeInterruptedLoopText, /execute_resume: npm run cli -- runs session-control-plane-advances/);

  const branchNativeInterruptedLoopConfirm = await cliJson<{
    recoverNext: {
      dryRun: boolean;
      resumed: boolean;
      previousSteps: number;
      executedSteps: number;
      stoppedReason: string;
      loopAdvanceId: string;
    };
    executed: { command: string[]; exitCode: number | null };
    after: { counts: { branchReady: number; recoverNextIncompleteLoops: number } };
  }>(baseUrl, [
    "runs",
    "session-branch-native-next",
    sessionName,
    "--server",
    "--recover-next",
    "--until-empty",
    "--resume-loop",
    interruptedLoopId,
    "--confirm",
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
    "--lines",
    "1",
  ]);
  assert.equal(branchNativeInterruptedLoopConfirm.recoverNext.dryRun, false);
  assert.equal(branchNativeInterruptedLoopConfirm.recoverNext.resumed, true);
  assert.equal(branchNativeInterruptedLoopConfirm.recoverNext.previousSteps, 1);
  assert.equal(branchNativeInterruptedLoopConfirm.recoverNext.executedSteps, 2);
  assert.equal(branchNativeInterruptedLoopConfirm.recoverNext.stoppedReason, "empty");
  assert.equal(branchNativeInterruptedLoopConfirm.recoverNext.loopAdvanceId, interruptedLoopId);
  assert.equal(branchNativeInterruptedLoopConfirm.executed.exitCode, 0);
  assert.deepEqual(branchNativeInterruptedLoopConfirm.executed.command, [
    "npm",
    "run",
    "cli",
    "--",
    "runs",
    "session-control-plane-recover-next",
    sessionName,
    "--server",
    "--confirm",
    "--until-empty",
    "--resume-loop",
    interruptedLoopId,
    "--max-steps",
    "3",
    "--interval-ms",
    "0",
    "--lines",
    "1",
  ]);
  assert.equal(branchNativeInterruptedLoopConfirm.after.counts.branchReady, 0);
  assert.equal(branchNativeInterruptedLoopConfirm.after.counts.recoverNextIncompleteLoops, 0);

  const requeuedInterruptedLoopRun = await db.getAgentRun(interruptedLoopRun.id);
  assert.equal(requeuedInterruptedLoopRun?.status, "planned");
  assert.equal(requeuedInterruptedLoopRun?.worker_id, null);

  const completedInterruptedLoopHistory = await cliJson<{
    loopAdvanceId: string;
    summary: { completed: boolean; steps: number; stoppedReasons: string[] };
  }>(baseUrl, [
    "runs",
    "session-control-plane-advances",
    sessionName,
    "--server",
    "--loop-advance-id",
    interruptedLoopId,
    "--recover-next-loop-history",
  ]);
  assert.equal(completedInterruptedLoopHistory.loopAdvanceId, interruptedLoopId);
  assert.equal(completedInterruptedLoopHistory.summary.completed, true);
  assert.equal(completedInterruptedLoopHistory.summary.steps, 3);
  assert.deepEqual(completedInterruptedLoopHistory.summary.stoppedReasons, ["dry_run", "empty"]);
} finally {
  await app.close();
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.json`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.out.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", `${sessionName}.err.log`), { force: true });
  await fs.rm(path.join(".threadbeat", "worker-sessions", "control-plane-advances", sessionName), { recursive: true, force: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
}

console.log("control-plane branch status smoke passed");

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
