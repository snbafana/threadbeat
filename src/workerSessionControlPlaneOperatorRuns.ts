import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionControlPlaneOperatorRunRecord = {
  operatorRunId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  confirmed: boolean;
  status: "dry_run" | "executed" | "idle" | "failed";
  stoppedReason: "idle" | "max_cycles" | "action_failed";
  bounds: {
    maxCycles: number;
    cycleIntervalMs: number;
    lines: number;
    reconcileWorkers: boolean;
    recoverWorkerBundles?: boolean;
  };
  summary: {
    cycles: number;
    executedCycles: number;
    failedCycles: number;
    idleCycles: number;
    actionReasons: string[];
    deferredActionReasons?: string[];
    deferredActionSurfaces?: string[];
    advanceIds: string[];
    reconciliationIds: string[];
    needsActionAfter: boolean | null;
  };
  commands: {
    dryRun: string[];
    confirm: string[];
    status: string[];
  };
};

export type WorkerSessionControlPlaneOperatorRunSummary = {
  total: number;
  dryRun: number;
  executed: number;
  idle: number;
  failed: number;
  maxCycles: number;
  withReconciliation: number;
  withBundleRecovery: number;
};

export async function listWorkerSessionControlPlaneOperatorRunRecords(
  projectRoot: string,
  sessionName: string,
  options: { limit?: number; operatorRunIds?: string[] } = {},
): Promise<WorkerSessionControlPlaneOperatorRunRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const operatorRunDir = workerSessionControlPlaneOperatorRunDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(operatorRunDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(operatorRunDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionControlPlaneOperatorRunRecord;
      }));
    return records
      .filter((record) => !options.operatorRunIds || options.operatorRunIds.length === 0 || options.operatorRunIds.includes(record.operatorRunId))
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, options.limit ?? 20);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeWorkerSessionControlPlaneOperatorRunRecords(
  records: WorkerSessionControlPlaneOperatorRunRecord[],
): WorkerSessionControlPlaneOperatorRunSummary {
  return {
    total: records.length,
    dryRun: records.filter((record) => record.status === "dry_run").length,
    executed: records.filter((record) => record.status === "executed").length,
    idle: records.filter((record) => record.status === "idle").length,
    failed: records.filter((record) => record.status === "failed").length,
    maxCycles: records.filter((record) => record.stoppedReason === "max_cycles").length,
    withReconciliation: records.filter((record) => record.bounds.reconcileWorkers).length,
    withBundleRecovery: records.filter((record) => record.bounds.recoverWorkerBundles === true).length,
  };
}

export async function writeWorkerSessionControlPlaneOperatorRunRecord(
  projectRoot: string,
  record: Omit<WorkerSessionControlPlaneOperatorRunRecord, "operatorRunId"> & { operatorRunId?: string },
): Promise<{ path: string; record: WorkerSessionControlPlaneOperatorRunRecord }> {
  assertSafeWorkerSessionName(record.session);
  const operatorRunRecord: WorkerSessionControlPlaneOperatorRunRecord = {
    ...record,
    operatorRunId: record.operatorRunId ?? createControlPlaneOperatorRunId(record.observedAt),
  };
  assertSafeWorkerSessionName(operatorRunRecord.operatorRunId);
  const operatorRunPath = workerSessionControlPlaneOperatorRunPath(
    projectRoot,
    operatorRunRecord.session,
    operatorRunRecord.operatorRunId,
  );
  await fs.mkdir(path.dirname(operatorRunPath), { recursive: true });
  await fs.writeFile(operatorRunPath, `${JSON.stringify(operatorRunRecord, null, 2)}\n`);
  return { path: operatorRunPath, record: operatorRunRecord };
}

function workerSessionControlPlaneOperatorRunDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-operator-runs", sessionName);
}

function workerSessionControlPlaneOperatorRunPath(
  projectRoot: string,
  sessionName: string,
  operatorRunId: string,
): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(operatorRunId);
  return path.join(workerSessionControlPlaneOperatorRunDir(projectRoot, sessionName), `${operatorRunId}.json`);
}

function createControlPlaneOperatorRunId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
