import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type SessionApplyCommand = {
  action?: string;
  command: string[];
  scope?: string;
};

type SessionApplyExecution = {
  action?: string;
  command: string[];
  exitCode: number | null;
  output?: unknown;
};

type SessionApplyRecord = {
  observedAt?: string;
  session: string;
  applyId: string;
  applyPath?: string;
  source: string;
  dryRun?: boolean;
  filter: Record<string, unknown>;
  updatedAt: string;
  resetAuditAcknowledgedAt?: string;
  resetAuditAcknowledgedBy?: string;
  selected: number;
  commands: SessionApplyCommand[];
  executions: SessionApplyExecution[];
};

type WorkerSessionApplyDrain = {
  prefix: string;
  polls: number;
  applyIds: string[];
  latestApplyId: string;
  updatedAt: string;
  selected: number;
  succeeded: number;
  failed: number;
  pending: number;
  done: boolean;
  stoppedOnFailure: boolean;
  needsContinuation: boolean;
  nextApplyId: string;
  continueCommand: string[] | null;
};

type WorkerSessionApplyAction = {
  applyId: string;
  source: string;
  action: "retry_failed" | "resume_pending" | "inspect_drain_continuation_resets";
  selected: number;
  failed: number;
  pending: number;
  resetCount: number;
  resetActions: Array<"reset_failed_drain_continuations" | "reset_running_drain_continuations">;
  continuationIds: string[];
  resetReasons: string[];
  command: string[];
  ackCommand?: string[];
};

type WorkerSessionDrainContinuationRecord = {
  continuationId: string;
  session: string;
  observedAt: string;
  status?: "queued" | "running" | "executed" | "failed";
  startedAt?: string;
  completedAt?: string;
  resetAt?: string;
  resetReason?: string;
  previousStartedAt?: string;
  error?: string;
  dryRun: boolean;
  filter: Record<string, unknown>;
  readinessSource?: string;
  readinessCounts: {
    total: number;
    needsContinuation: number;
    done: number;
    stoppedOnFailure: number;
  };
  continueDrains: {
    dryRun: boolean;
    selected: number;
    succeeded: number;
    failed: number;
  };
  drains: Array<{
    prefix: string;
    nextApplyId: string;
    command: string[];
    exitCode: number | null;
    output?: unknown;
    stderr?: string;
  }>;
};

type QueueWorkerSessionDrainContinuationsOptions = {
  drainPrefix?: string[];
  dryRun?: boolean;
  maxPolls?: number;
  intervalMs?: number;
};

type ExecuteQueuedWorkerSessionDrainContinuationsOptions = {
  maxContinuations?: number;
};

type ResetRunningWorkerSessionDrainContinuationsOptions = {
  olderThanMs?: number;
};

type ResetFailedWorkerSessionDrainContinuationsOptions = {
  continuationIds?: string[];
};

type WorkerSessionDrainContinuationExecution = WorkerSessionDrainContinuationRecord["drains"][number] & {
  output?: unknown;
  stderr?: string;
};

export async function listWorkerSessionApplyRecords(projectRoot: string, sessionName: string): Promise<SessionApplyRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const applyDir = workerSessionApplyDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(applyDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(applyDir, entry.name), "utf8");
        return JSON.parse(text) as SessionApplyRecord;
      }));
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readWorkerSessionApplyRecord(
  projectRoot: string,
  sessionName: string,
  applyId: string,
): Promise<SessionApplyRecord | null> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(applyId);
  try {
    const text = await fs.readFile(workerSessionApplyPath(projectRoot, sessionName, applyId), "utf8");
    return JSON.parse(text) as SessionApplyRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function acknowledgeWorkerSessionApplyResetAudit(
  projectRoot: string,
  sessionName: string,
  applyId: string,
  options: { dryRun?: boolean; acknowledgedBy?: string } = {},
): Promise<{ path: string; record: SessionApplyRecord; acknowledgedAt: string }> {
  const record = await readWorkerSessionApplyRecord(projectRoot, sessionName, applyId);
  if (!record) throw new Error(`session apply ${applyId} does not exist for ${sessionName}`);
  const resetExecutions = sessionApplyDrainContinuationResetExecutions(record);
  if (resetExecutions.length === 0) {
    throw new Error(`session apply ${applyId} has no drain continuation reset audit to acknowledge`);
  }
  const acknowledgedAt = record.resetAuditAcknowledgedAt ?? new Date().toISOString();
  const updatedRecord: SessionApplyRecord = {
    ...record,
    updatedAt: new Date().toISOString(),
    resetAuditAcknowledgedAt: acknowledgedAt,
    resetAuditAcknowledgedBy: options.acknowledgedBy ?? "server",
  };
  const applyPath = workerSessionApplyPath(projectRoot, sessionName, applyId);
  if (options.dryRun !== true) {
    await writeWorkerSessionApplyRecord(projectRoot, updatedRecord);
  }
  return { path: applyPath, record: updatedRecord, acknowledgedAt };
}

export function summarizeWorkerSessionApplyRecords(records: SessionApplyRecord[]): {
  counts: {
    total: number;
    succeeded: number;
    failed: number;
    pending: number;
    dryRun: number;
  };
  applies: Array<ReturnType<typeof summarizeApplyRecord>>;
} {
  const applies = records.map((record) => summarizeApplyRecord(record));
  return {
    counts: {
      total: applies.length,
      succeeded: applies.reduce((sum, apply) => sum + apply.succeeded, 0),
      failed: applies.reduce((sum, apply) => sum + apply.failed, 0),
      pending: applies.reduce((sum, apply) => sum + apply.pending, 0),
      dryRun: records.filter((record) => record.dryRun === true).length,
    },
    applies,
  };
}

export function summarizeWorkerSessionApplyActionQueue(records: SessionApplyRecord[]): {
  counts: {
    total: number;
    actionable: number;
    resumeNeeded: number;
    resetAudits: number;
    resetAuditsAcknowledged: number;
    resetAuditsTotal: number;
    waiting: number;
    failed: number;
    pending: number;
  };
  actions: WorkerSessionApplyAction[];
} {
  const actions: WorkerSessionApplyAction[] = [];
  const applies = records.map((record) => ({ record, summary: summarizeApplyRecord(record) }));
  for (const { record, summary } of applies) {
    if (summary.failed > 0) {
      actions.push({
        applyId: record.applyId,
        source: record.source,
        action: "retry_failed",
        selected: record.selected,
        failed: summary.failed,
        pending: summary.pending,
        resetCount: 0,
        resetActions: [],
        continuationIds: [],
        resetReasons: [],
        command: sessionApplyResumeCommand(record, ["failed"]),
      });
      continue;
    }
    if (summary.pending > 0) {
      actions.push({
        applyId: record.applyId,
        source: record.source,
        action: "resume_pending",
        selected: record.selected,
        failed: summary.failed,
        pending: summary.pending,
        resetCount: 0,
        resetActions: [],
        continuationIds: [],
        resetReasons: [],
        command: sessionApplyResumeCommand(record, ["pending"]),
      });
      continue;
    }
    if (record.resetAuditAcknowledgedAt) continue;
    const resetSummary = summarizeSessionApplyDrainContinuationResets(record);
    if (resetSummary.resetActions.length === 0) continue;
    actions.push({
      applyId: record.applyId,
      source: record.source,
      action: "inspect_drain_continuation_resets",
      selected: record.selected,
      failed: summary.failed,
      pending: summary.pending,
      resetCount: resetSummary.resetCount,
      resetActions: resetSummary.resetActions,
      continuationIds: resetSummary.continuationIds,
      resetReasons: resetSummary.resetReasons,
      command: sessionApplyResetInspectionCommand(record),
      ackCommand: sessionApplyResetAckCommand(record),
    });
  }
  const resetAuditRecords = applies.filter(({ record }) => (
    sessionApplyDrainContinuationResetExecutions(record).length > 0
  ));
  return {
    counts: {
      total: records.length,
      actionable: actions.length,
      resumeNeeded: actions.filter((action) => action.action === "retry_failed" || action.action === "resume_pending").length,
      resetAudits: actions.filter((action) => action.action === "inspect_drain_continuation_resets").length,
      resetAuditsAcknowledged: resetAuditRecords.filter(({ record }) => record.resetAuditAcknowledgedAt).length,
      resetAuditsTotal: resetAuditRecords.length,
      waiting: records.length - actions.length,
      failed: applies.reduce((sum, apply) => sum + apply.summary.failed, 0),
      pending: applies.reduce((sum, apply) => sum + apply.summary.pending, 0),
    },
    actions,
  };
}

export async function listWorkerSessionDrainContinuationRecords(
  projectRoot: string,
  sessionName: string,
  limit = 20,
): Promise<WorkerSessionDrainContinuationRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const continuationDir = workerSessionDrainContinuationDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(continuationDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(continuationDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionDrainContinuationRecord;
      }));
    return records
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function queueWorkerSessionDrainContinuations(
  projectRoot: string,
  sessionName: string,
  options: QueueWorkerSessionDrainContinuationsOptions = {},
): Promise<{ path: string; record: WorkerSessionDrainContinuationRecord }> {
  assertSafeWorkerSessionName(sessionName);
  const records = await listWorkerSessionApplyRecords(projectRoot, sessionName);
  const summary = summarizeWorkerSessionApplyDrains(records);
  const prefixFilter = options.drainPrefix && options.drainPrefix.length > 0
    ? new Set(options.drainPrefix)
    : null;
  const drains = summary.drains
    .filter((drain) => drain.continueCommand)
    .filter((drain) => !prefixFilter || prefixFilter.has(drain.prefix));
  const readinessCounts = {
    total: drains.length,
    needsContinuation: drains.filter((drain) => drain.needsContinuation).length,
    done: drains.filter((drain) => drain.done).length,
    stoppedOnFailure: drains.filter((drain) => drain.stoppedOnFailure).length,
  };
  const observedAt = new Date().toISOString();
  const record: WorkerSessionDrainContinuationRecord = {
    continuationId: createDrainContinuationId(observedAt),
    session: sessionName,
    observedAt,
    status: "queued",
    dryRun: options.dryRun === true,
    filter: {
      ...(prefixFilter ? { drainPrefix: [...prefixFilter] } : {}),
      ...(options.maxPolls ? { maxPolls: options.maxPolls } : {}),
      ...(options.intervalMs ? { intervalMs: options.intervalMs } : {}),
    },
    readinessSource: "server",
    readinessCounts,
    continueDrains: {
      dryRun: options.dryRun === true,
      selected: drains.length,
      succeeded: 0,
      failed: 0,
    },
    drains: drains.map((drain) => ({
      prefix: drain.prefix,
      nextApplyId: drain.nextApplyId,
      command: sessionApplyDrainContinueCommandWithOptions(drain.continueCommand as string[], {
        dryRun: options.dryRun === true,
        maxPolls: options.maxPolls ?? null,
        intervalMs: options.intervalMs ?? null,
      }),
      exitCode: null,
    })),
  };
  return await writeWorkerSessionDrainContinuationRecord(projectRoot, record);
}

export async function executeWorkerSessionDrainContinuationRecord(
  projectRoot: string,
  sessionName: string,
  continuationId: string,
  runCommand: (drain: WorkerSessionDrainContinuationRecord["drains"][number]) => Promise<WorkerSessionDrainContinuationExecution>,
): Promise<{ path: string; record: WorkerSessionDrainContinuationRecord }> {
  const existing = await readWorkerSessionDrainContinuationRecord(projectRoot, sessionName, continuationId);
  if (!existing) throw new Error(`drain continuation ${continuationId} does not exist for ${sessionName}`);
  if (existing.status === "executed") throw new Error(`drain continuation ${continuationId} is already executed`);
  if (existing.status === "running") throw new Error(`drain continuation ${continuationId} is already running`);
  if (existing.status === "failed") throw new Error(`drain continuation ${continuationId} has failed`);
  if (existing.status && existing.status !== "queued") throw new Error(`drain continuation ${continuationId} is ${existing.status}`);
  const startedAt = new Date().toISOString();
  const drains: WorkerSessionDrainContinuationExecution[] = [];
  const running: WorkerSessionDrainContinuationRecord = {
    ...existing,
    status: "running",
    startedAt,
  };
  await writeWorkerSessionDrainContinuationRecord(projectRoot, running);
  try {
    for (const drain of existing.drains) {
      drains.push(await runCommand(drain));
    }
  } catch (error) {
    const succeeded = drains.filter((drain) => drain.exitCode === 0).length;
    const remaining = existing.drains.slice(drains.length);
    const record: WorkerSessionDrainContinuationRecord = {
      ...running,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      continueDrains: {
        ...existing.continueDrains,
        succeeded,
        failed: Math.max(drains.length - succeeded, remaining.length, 1),
      },
      drains: [...drains, ...remaining],
    };
    await writeWorkerSessionDrainContinuationRecord(projectRoot, record);
    throw error;
  }
  const succeeded = drains.filter((drain) => drain.exitCode === 0).length;
  const failed = drains.filter((drain) => drain.exitCode !== 0).length;
  const record: WorkerSessionDrainContinuationRecord = {
    ...running,
    status: failed > 0 ? "failed" : "executed",
    completedAt: new Date().toISOString(),
    ...(failed > 0 ? { error: `drain continuation completed with ${failed} failed drain(s)` } : {}),
    continueDrains: {
      ...existing.continueDrains,
      succeeded,
      failed,
    },
    drains,
  };
  return await writeWorkerSessionDrainContinuationRecord(projectRoot, record);
}

export async function executeNextWorkerSessionDrainContinuationRecord(
  projectRoot: string,
  sessionName: string,
  runCommand: (drain: WorkerSessionDrainContinuationRecord["drains"][number]) => Promise<WorkerSessionDrainContinuationExecution>,
): Promise<{ path: string; record: WorkerSessionDrainContinuationRecord } | null> {
  const records = await listWorkerSessionDrainContinuationRecords(projectRoot, sessionName, Number.MAX_SAFE_INTEGER);
  const next = records
    .filter((record) => record.status === "queued")
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt))
    .at(0);
  if (!next) return null;
  return await executeWorkerSessionDrainContinuationRecord(projectRoot, sessionName, next.continuationId, runCommand);
}

export async function executeQueuedWorkerSessionDrainContinuationRecords(
  projectRoot: string,
  sessionName: string,
  runCommand: (drain: WorkerSessionDrainContinuationRecord["drains"][number]) => Promise<WorkerSessionDrainContinuationExecution>,
  options: ExecuteQueuedWorkerSessionDrainContinuationsOptions = {},
): Promise<{
  executed: Array<{ path: string; record: WorkerSessionDrainContinuationRecord }>;
  remainingQueued: number;
}> {
  const maxContinuations = options.maxContinuations ?? 10;
  const executed: Array<{ path: string; record: WorkerSessionDrainContinuationRecord }> = [];
  for (let index = 0; index < maxContinuations; index += 1) {
    const next = await executeNextWorkerSessionDrainContinuationRecord(projectRoot, sessionName, runCommand);
    if (!next) break;
    executed.push(next);
  }
  const remainingQueued = (await listWorkerSessionDrainContinuationRecords(projectRoot, sessionName, Number.MAX_SAFE_INTEGER))
    .filter((record) => record.status === "queued")
    .length;
  return { executed, remainingQueued };
}

export async function resetRunningWorkerSessionDrainContinuationRecords(
  projectRoot: string,
  sessionName: string,
  options: ResetRunningWorkerSessionDrainContinuationsOptions = {},
): Promise<{
  inspected: number;
  running: number;
  resetCount: number;
  skippedRunning: number;
  reset: Array<{ path: string; record: WorkerSessionDrainContinuationRecord }>;
}> {
  const records = await listWorkerSessionDrainContinuationRecords(projectRoot, sessionName, Number.MAX_SAFE_INTEGER);
  const running = records.filter((record) => record.status === "running");
  const nowMs = Date.now();
  const reset: Array<{ path: string; record: WorkerSessionDrainContinuationRecord }> = [];
  for (const record of running) {
    if (options.olderThanMs !== undefined) {
      const startedAtMs = Date.parse(record.startedAt ?? record.observedAt);
      if (!Number.isFinite(startedAtMs) || nowMs - startedAtMs < options.olderThanMs) continue;
    }
    const resetAt = new Date().toISOString();
    reset.push(await writeWorkerSessionDrainContinuationRecord(projectRoot, {
      ...record,
      status: "queued",
      startedAt: undefined,
      completedAt: undefined,
      resetAt,
      resetReason: "operator_reset_running",
      previousStartedAt: record.startedAt,
      error: undefined,
      continueDrains: {
        ...record.continueDrains,
        succeeded: 0,
        failed: 0,
      },
      drains: record.drains.map((drain) => ({
        prefix: drain.prefix,
        nextApplyId: drain.nextApplyId,
        command: drain.command,
        exitCode: null,
      })),
    }));
  }
  return {
    inspected: records.length,
    running: running.length,
    resetCount: reset.length,
    skippedRunning: running.length - reset.length,
    reset,
  };
}

export async function resetFailedWorkerSessionDrainContinuationRecords(
  projectRoot: string,
  sessionName: string,
  options: ResetFailedWorkerSessionDrainContinuationsOptions = {},
): Promise<{
  inspected: number;
  failed: number;
  resetCount: number;
  skippedFailed: number;
  reset: Array<{ path: string; record: WorkerSessionDrainContinuationRecord }>;
}> {
  const records = await listWorkerSessionDrainContinuationRecords(projectRoot, sessionName, Number.MAX_SAFE_INTEGER);
  const continuationIdFilter = options.continuationIds && options.continuationIds.length > 0
    ? new Set(options.continuationIds)
    : null;
  if (continuationIdFilter) {
    for (const continuationId of continuationIdFilter) {
      assertSafeWorkerSessionName(continuationId);
    }
  }
  const failed = records
    .filter((record) => record.status === "failed")
    .filter((record) => !continuationIdFilter || continuationIdFilter.has(record.continuationId));
  const reset: Array<{ path: string; record: WorkerSessionDrainContinuationRecord }> = [];
  for (const record of failed) {
    const resetAt = new Date().toISOString();
    reset.push(await writeWorkerSessionDrainContinuationRecord(projectRoot, {
      ...record,
      status: "queued",
      startedAt: undefined,
      completedAt: undefined,
      resetAt,
      resetReason: "operator_reset_failed",
      previousStartedAt: record.startedAt,
      error: undefined,
      continueDrains: {
        ...record.continueDrains,
        succeeded: 0,
        failed: 0,
      },
      drains: record.drains.map((drain) => ({
        prefix: drain.prefix,
        nextApplyId: drain.nextApplyId,
        command: drain.command,
        exitCode: null,
      })),
    }));
  }
  return {
    inspected: records.length,
    failed: failed.length,
    resetCount: reset.length,
    skippedFailed: failed.length - reset.length,
    reset,
  };
}

export async function readWorkerSessionDrainContinuationRecord(
  projectRoot: string,
  sessionName: string,
  continuationId: string,
): Promise<WorkerSessionDrainContinuationRecord | null> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(continuationId);
  try {
    const text = await fs.readFile(workerSessionDrainContinuationPath(projectRoot, sessionName, continuationId), "utf8");
    return JSON.parse(text) as WorkerSessionDrainContinuationRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeWorkerSessionDrainContinuationRecord(
  projectRoot: string,
  record: WorkerSessionDrainContinuationRecord,
): Promise<{ path: string; record: WorkerSessionDrainContinuationRecord }> {
  assertSafeWorkerSessionName(record.session);
  assertSafeWorkerSessionName(record.continuationId);
  const continuationPath = workerSessionDrainContinuationPath(projectRoot, record.session, record.continuationId);
  await fs.mkdir(path.dirname(continuationPath), { recursive: true });
  await fs.writeFile(continuationPath, `${JSON.stringify(record, null, 2)}\n`);
  return { path: continuationPath, record };
}

async function writeWorkerSessionApplyRecord(
  projectRoot: string,
  record: SessionApplyRecord,
): Promise<{ path: string; record: SessionApplyRecord }> {
  assertSafeWorkerSessionName(record.session);
  assertSafeWorkerSessionName(record.applyId);
  const applyPath = workerSessionApplyPath(projectRoot, record.session, record.applyId);
  await fs.mkdir(path.dirname(applyPath), { recursive: true });
  await fs.writeFile(applyPath, `${JSON.stringify({ ...record, applyPath }, null, 2)}\n`);
  return { path: applyPath, record: { ...record, applyPath } };
}

export function summarizeWorkerSessionApplyDrains(records: SessionApplyRecord[]): {
  counts: {
    total: number;
    needsContinuation: number;
    done: number;
    stoppedOnFailure: number;
  };
  drains: WorkerSessionApplyDrain[];
} {
  const groups = new Map<string, Array<ReturnType<typeof summarizeApplyRecord> & { drainPoll: number }>>();
  for (const record of records) {
    if (record.source !== "watch") continue;
    const parts = sessionApplyDrainParts(record.applyId);
    if (!parts) continue;
    const entries = groups.get(parts.prefix) ?? [];
    entries.push({ ...summarizeApplyRecord(record), drainPoll: parts.poll });
    groups.set(parts.prefix, entries);
  }
  const drains = [...groups.entries()]
    .map(([prefix, entries]) => {
      const ordered = entries.sort((left, right) => left.drainPoll - right.drainPoll);
      const latest = ordered.reduce((left, right) => left.updatedAt >= right.updatedAt ? left : right);
      const lastPollEntry = ordered.at(-1) as ReturnType<typeof summarizeApplyRecord> & { drainPoll: number };
      const nextPoll = Math.max(...ordered.map((entry) => entry.drainPoll)) + 1;
      const done = ordered.some((entry) => entry.selected === 0);
      const stoppedOnFailure = ordered.some((entry) => entry.failed > 0);
      const continueCommand = done || stoppedOnFailure
        ? null
        : sessionApplyDrainContinueCommand(prefix, lastPollEntry);
      return {
        prefix,
        polls: ordered.length,
        applyIds: ordered.map((entry) => entry.applyId),
        latestApplyId: latest.applyId,
        updatedAt: latest.updatedAt,
        selected: ordered.reduce((sum, entry) => sum + entry.selected, 0),
        succeeded: ordered.reduce((sum, entry) => sum + entry.succeeded, 0),
        failed: ordered.reduce((sum, entry) => sum + entry.failed, 0),
        pending: ordered.reduce((sum, entry) => sum + entry.pending, 0),
        done,
        stoppedOnFailure,
        needsContinuation: continueCommand !== null,
        nextApplyId: `${prefix}-${String(nextPoll).padStart(3, "0")}`,
        continueCommand,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    counts: {
      total: drains.length,
      needsContinuation: drains.filter((drain) => drain.needsContinuation).length,
      done: drains.filter((drain) => drain.done).length,
      stoppedOnFailure: drains.filter((drain) => drain.stoppedOnFailure).length,
    },
    drains,
  };
}

function sessionApplyDrainContinuationResetExecutions(record: SessionApplyRecord): SessionApplyExecution[] {
  return record.executions
    .filter((execution) => (
      execution.action === "reset_failed_drain_continuations"
      || execution.action === "reset_running_drain_continuations"
    ));
}

function summarizeSessionApplyDrainContinuationResets(record: SessionApplyRecord): {
  resetCount: number;
  resetActions: Array<"reset_failed_drain_continuations" | "reset_running_drain_continuations">;
  continuationIds: string[];
  resetReasons: string[];
} {
  const executions = sessionApplyDrainContinuationResetExecutions(record);
  const continuationIds = new Set<string>();
  const resetReasons = new Set<string>();
  let resetCount = 0;
  for (const execution of executions) {
    const output = plainRecord(execution.output);
    resetCount += numberFromUnknown(output?.resetCount) ?? (execution.exitCode === 0 ? 1 : 0);
    const continuations = Array.isArray(output?.continuations) ? output.continuations : [];
    for (const item of continuations) {
      const continuation = plainRecord(item);
      const continuationId = stringFromUnknown(continuation?.continuationId);
      const resetReason = stringFromUnknown(continuation?.resetReason);
      if (continuationId) continuationIds.add(continuationId);
      if (resetReason) resetReasons.add(resetReason);
    }
  }
  return {
    resetCount,
    resetActions: [...new Set(executions
      .map((execution) => execution.action)
      .filter((action): action is "reset_failed_drain_continuations" | "reset_running_drain_continuations" => (
        action === "reset_failed_drain_continuations" || action === "reset_running_drain_continuations"
      )))],
    continuationIds: [...continuationIds],
    resetReasons: [...resetReasons],
  };
}

function summarizeApplyRecord(record: SessionApplyRecord): {
  applyId: string;
  source: string;
  filter: Record<string, unknown>;
  updatedAt: string;
  selected: number;
  succeeded: number;
  failed: number;
  pending: number;
  resumeApply: string[];
} {
  const commandStates = sessionApplyCommandStates(record);
  return {
    applyId: record.applyId,
    source: record.source,
    filter: record.filter,
    updatedAt: record.updatedAt,
    selected: record.selected,
    succeeded: record.executions.filter((execution) => execution.exitCode === 0).length,
    failed: record.executions.filter((execution) => execution.exitCode !== 0).length,
    pending: record.commands.filter((command) => !commandStates.has(commandKey(command.command))).length,
    resumeApply: sessionApplyResumeCommand(record),
  };
}

function sessionApplyDrainParts(applyId: string): { prefix: string; poll: number } | null {
  const match = /^(.*)-(\d{3})$/.exec(applyId);
  if (!match) return null;
  return { prefix: match[1], poll: Number(match[2]) };
}

function sessionApplyDrainContinueCommand(
  prefix: string,
  latest: ReturnType<typeof summarizeApplyRecord>,
): string[] | null {
  if (latest.source !== "watch") return null;
  const applyIdIndex = latest.resumeApply.indexOf("--apply-id");
  if (applyIdIndex < 0) return null;
  const command = latest.resumeApply.slice(0, applyIdIndex);
  if (!command.includes("--action") && !command.includes("--apply-action") && !command.includes("--branch-action")) return null;
  if (latest.filter.includeStopped === true) command.push("--include-stopped");
  const status = stringListFromUnknown(latest.filter.status);
  if (status.length > 0) command.push("--status", status.join(","));
  const run = stringListFromUnknown(latest.filter.run);
  if (run.length > 0) command.push("--run", run.join(","));
  if (typeof latest.filter.limit === "string" || typeof latest.filter.limit === "number") {
    command.push("--limit", String(latest.filter.limit));
  }
  if (typeof latest.filter.checkoutDir === "string") command.push("--checkout-dir", latest.filter.checkoutDir);
  if (latest.filter.changedOnly === true) command.push("--changed-only");
  const changedPath = stringListFromUnknown(latest.filter.changedPath);
  if (changedPath.length > 0) command.push("--changed-path", changedPath.join(","));
  command.push("--continue-prefix", prefix, "--until-empty");
  return command;
}

function sessionApplyDrainContinueCommandWithOptions(
  command: string[],
  options: { dryRun: boolean; maxPolls: number | null; intervalMs: number | null },
): string[] {
  return [
    ...command,
    ...(options.maxPolls ? ["--max-polls", String(options.maxPolls)] : []),
    ...(options.intervalMs ? ["--interval-ms", String(options.intervalMs)] : []),
    ...(options.dryRun ? ["--dry-run"] : []),
  ];
}

function sessionApplyResetInspectionCommand(record: SessionApplyRecord): string[] {
  return ["npm", "run", "cli", "--", "runs", "session-applies", record.session, "--server", "--apply-id", record.applyId];
}

function sessionApplyResetAckCommand(record: SessionApplyRecord): string[] {
  return [...sessionApplyResetInspectionCommand(record), "--ack-reset-audit"];
}

function sessionApplyResumeCommand(record: SessionApplyRecord, resumeFilter?: Array<"failed" | "pending">): string[] {
  const command = ["npm", "run", "cli", "--", "runs", "session-apply", record.session];
  if (record.source && record.source !== "review") command.push("--source", record.source);
  const branchAction = stringListFromUnknown(record.filter.branchAction);
  const applyAction = stringListFromUnknown(record.filter.applyAction);
  const action = stringListFromUnknown(record.filter.action);
  const fallbackActions = [...new Set(record.commands.map((item) => item.action).filter(Boolean))] as string[];
  const hasBranchCommands = record.commands.some((item) => item.scope === "branch");
  const hasApplyCommands = record.commands.some((item) => item.scope === "apply");
  if (branchAction.length > 0) {
    command.push("--branch-action", branchAction.join(","));
  } else if (applyAction.length > 0) {
    command.push("--apply-action", applyAction.join(","));
  } else if (action.length > 0) {
    command.push("--action", action.join(","));
  } else if (hasBranchCommands && fallbackActions.length > 0) {
    command.push("--branch-action", fallbackActions.join(","));
  } else if (hasApplyCommands && fallbackActions.length > 0) {
    command.push("--apply-action", fallbackActions.join(","));
  } else if (fallbackActions.length > 0) {
    command.push("--action", fallbackActions.join(","));
  }
  command.push("--apply-id", record.applyId, "--resume");
  if (resumeFilter && resumeFilter.length > 0) command.push("--resume-filter", resumeFilter.join(","));
  return command;
}

function sessionApplyCommandStates(record: SessionApplyRecord): Map<string, { succeeded: boolean; failed: boolean }> {
  const states = new Map<string, { succeeded: boolean; failed: boolean }>();
  for (const execution of record.executions ?? []) {
    const key = commandKey(execution.command);
    const state = states.get(key) ?? { succeeded: false, failed: false };
    if (execution.exitCode === 0) state.succeeded = true;
    else state.failed = true;
    states.set(key, state);
  }
  return states;
}

function commandKey(command: string[]): string {
  return JSON.stringify(command);
}

function stringListFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function workerSessionApplyDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "apply", sessionName);
}

function workerSessionApplyPath(projectRoot: string, sessionName: string, applyId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(applyId);
  return path.join(workerSessionApplyDir(projectRoot, sessionName), `${applyId}.json`);
}

function workerSessionDrainContinuationDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "drain-continuations", sessionName);
}

function workerSessionDrainContinuationPath(projectRoot: string, sessionName: string, continuationId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(continuationId);
  return path.join(workerSessionDrainContinuationDir(projectRoot, sessionName), `${continuationId}.json`);
}

function createDrainContinuationId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
