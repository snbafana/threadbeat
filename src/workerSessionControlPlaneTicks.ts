import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionControlPlaneTickRecord = {
  tickId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  status: "dry_run" | "executed" | "partial" | "noop";
  planned: {
    branchRecovery: null | { action: "recover_stale_running_run" | "resume_next_branch"; runIds: string[]; command: string[] };
    applyAction: null | { action: "execute_next_apply_action"; actionable: number };
    drainContinuation: null | { action: "execute_next_drain_continuation"; queued: number };
  };
  executed: {
    branchRecovery: unknown | null;
    applyAction: unknown | null;
    drainContinuation: unknown | null;
  };
  before: unknown;
  after: unknown;
};

export type WorkerSessionControlPlaneTickDecisionSummary = {
  statusReason: "dry_run" | "no_planned_actions" | "all_planned_actions_attempted" | "partial_execution";
  plannedCount: number;
  executedCount: number;
  planned: Array<{
    surface: "branch_recovery" | "apply_action" | "drain_continuation";
    action: string;
    runIds?: string[];
    actionable?: number;
    queued?: number;
    command?: string[];
  }>;
  executed: Array<{
    surface: "branch_recovery" | "apply_action" | "drain_continuation";
    exitCode: number | null;
    command?: string[];
    recoveredRunIds?: string[];
    resumedRunIds?: string[];
    executed?: boolean;
  }>;
  skipped: Array<{
    surface: "branch_recovery" | "apply_action" | "drain_continuation";
    action: string;
    reason: "dry_run" | "not_attempted";
  }>;
  notPlanned: Array<{
    surface: "branch_recovery" | "apply_action" | "drain_continuation";
    reason: "no_ready_stale_runs_or_branches" | "no_actionable_apply_actions" | "no_queued_drain_continuations";
    readyCount: number | null;
  }>;
  before: {
    staleRunRecoveries: number | null;
    branchRecoveries: number | null;
    applyActions: number | null;
    drainContinuations: number | null;
  };
  after: {
    staleRunRecoveries: number | null;
    branchRecoveries: number | null;
    applyActions: number | null;
    drainContinuations: number | null;
  };
};

export function summarizeWorkerSessionControlPlaneTickDecision(
  tick: WorkerSessionControlPlaneTickRecord,
): WorkerSessionControlPlaneTickDecisionSummary {
  const planned = [
    ...(tick.planned.branchRecovery
      ? [{
        surface: "branch_recovery" as const,
        action: tick.planned.branchRecovery.action,
        runIds: tick.planned.branchRecovery.runIds,
        command: tick.planned.branchRecovery.command,
      }]
      : []),
    ...(tick.planned.applyAction
      ? [{
        surface: "apply_action" as const,
        action: tick.planned.applyAction.action,
        actionable: tick.planned.applyAction.actionable,
      }]
      : []),
    ...(tick.planned.drainContinuation
      ? [{
        surface: "drain_continuation" as const,
        action: tick.planned.drainContinuation.action,
        queued: tick.planned.drainContinuation.queued,
      }]
      : []),
  ];
  const executed = [
    ...(tick.executed.branchRecovery
      ? [summarizeTickCommandExecution("branch_recovery" as const, tick.executed.branchRecovery)]
      : []),
    ...(tick.executed.applyAction
      ? [summarizeTickCommandExecution("apply_action" as const, tick.executed.applyAction)]
      : []),
    ...(tick.executed.drainContinuation
      ? [summarizeTickCommandExecution("drain_continuation" as const, tick.executed.drainContinuation)]
      : []),
  ];
  const executedSurfaces = new Set(executed.map((entry) => entry.surface));
  const skipped = planned
    .filter((entry) => !executedSurfaces.has(entry.surface))
    .map((entry) => ({
      surface: entry.surface,
      action: entry.action,
      reason: tick.dryRun ? "dry_run" as const : "not_attempted" as const,
    }));
  const beforeCounts = summarizeTickStatusCounts(tick.before);
  const afterCounts = summarizeTickStatusCounts(tick.after);
  const statusReason = tick.dryRun
    ? "dry_run"
    : planned.length === 0
      ? "no_planned_actions"
      : executed.length === planned.length
        ? "all_planned_actions_attempted"
        : "partial_execution";
  return {
    statusReason,
    plannedCount: planned.length,
    executedCount: executed.length,
    planned,
    executed,
    skipped,
    notPlanned: [
      ...(tick.planned.branchRecovery ? [] : [{
        surface: "branch_recovery" as const,
        reason: "no_ready_stale_runs_or_branches" as const,
        readyCount: sumNullable(beforeCounts.staleRunRecoveries, beforeCounts.branchRecoveries),
      }]),
      ...(tick.planned.applyAction ? [] : [{
        surface: "apply_action" as const,
        reason: "no_actionable_apply_actions" as const,
        readyCount: beforeCounts.applyActions,
      }]),
      ...(tick.planned.drainContinuation ? [] : [{
        surface: "drain_continuation" as const,
        reason: "no_queued_drain_continuations" as const,
        readyCount: beforeCounts.drainContinuations,
      }]),
    ],
    before: beforeCounts,
    after: afterCounts,
  };
}

export async function listWorkerSessionControlPlaneTickRecords(
  projectRoot: string,
  sessionName: string,
  limit = 20,
): Promise<WorkerSessionControlPlaneTickRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const tickDir = workerSessionControlPlaneTickDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(tickDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(tickDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionControlPlaneTickRecord;
      }));
    return records
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeWorkerSessionControlPlaneTickRecord(
  projectRoot: string,
  record: Omit<WorkerSessionControlPlaneTickRecord, "tickId"> & { tickId?: string },
): Promise<{ path: string; record: WorkerSessionControlPlaneTickRecord }> {
  assertSafeWorkerSessionName(record.session);
  const tickRecord: WorkerSessionControlPlaneTickRecord = {
    ...record,
    tickId: record.tickId ?? createControlPlaneTickId(record.observedAt),
  };
  assertSafeWorkerSessionName(tickRecord.tickId);
  const tickPath = workerSessionControlPlaneTickPath(projectRoot, tickRecord.session, tickRecord.tickId);
  await fs.mkdir(path.dirname(tickPath), { recursive: true });
  await fs.writeFile(tickPath, `${JSON.stringify(tickRecord, null, 2)}\n`);
  return { path: tickPath, record: tickRecord };
}

function workerSessionControlPlaneTickDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-ticks", sessionName);
}

function workerSessionControlPlaneTickPath(projectRoot: string, sessionName: string, tickId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(tickId);
  return path.join(workerSessionControlPlaneTickDir(projectRoot, sessionName), `${tickId}.json`);
}

function createControlPlaneTickId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function summarizeTickCommandExecution(
  surface: "branch_recovery" | "apply_action" | "drain_continuation",
  execution: unknown,
): WorkerSessionControlPlaneTickDecisionSummary["executed"][number] {
  const record = objectRecord(execution);
  const output = objectRecord(record.output);
  return {
    surface,
    exitCode: typeof record.exitCode === "number" || record.exitCode === null ? record.exitCode : null,
    ...(Array.isArray(record.command) && record.command.every((part) => typeof part === "string")
      ? { command: record.command }
      : {}),
    ...runIdsFromOutput(output, "recovered", "recoveredRunIds"),
    ...runIdsFromOutput(output, "resumed", "resumedRunIds"),
    ...(typeof output.executed === "boolean" ? { executed: output.executed } : {}),
  };
}

function summarizeTickStatusCounts(value: unknown): WorkerSessionControlPlaneTickDecisionSummary["before"] {
  return {
    staleRunRecoveries: readNumberPath(value, ["staleRuns", "counts", "ready"]),
    branchRecoveries: readNumberPath(value, ["branches", "counts", "ready"]),
    applyActions: readNumberPath(value, ["queues", "applyActions", "actionable"]),
    drainContinuations: readNumberPath(value, ["queues", "drainContinuations", "queued"]),
  };
}

function readNumberPath(value: unknown, pathParts: string[]): number | null {
  let current = value;
  for (const part of pathParts) {
    const record = objectRecord(current);
    if (!(part in record)) return null;
    current = record[part];
  }
  return typeof current === "number" ? current : null;
}

function runIdsFromOutput(
  output: Record<string, unknown>,
  field: "recovered" | "resumed",
  resultField: "recoveredRunIds" | "resumedRunIds",
): Pick<WorkerSessionControlPlaneTickDecisionSummary["executed"][number], "recoveredRunIds" | "resumedRunIds"> {
  const rows = output[field];
  if (!Array.isArray(rows)) return {};
  const runIds = rows
    .map((row) => objectRecord(row).runId)
    .filter((runId): runId is string => typeof runId === "string");
  return runIds.length > 0 ? { [resultField]: runIds } : {};
}

function sumNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
