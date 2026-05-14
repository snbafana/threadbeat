import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionControlPlaneWorkerReconciliationRecord = {
  reconciliationId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  confirmed: boolean;
  untilEmpty: boolean;
  status: "dry_run" | "executed" | "noop" | "failed" | "max_steps";
  stoppedReason?: string;
  filter: unknown;
  summary: {
    iterations: number;
    totalPlanned: number;
    totalExecuted: number;
    lastPlannedCount: number | null;
    lastNextPlannedCount: number | null;
    lastRemainingCount: number | null;
  };
  commands: {
    inspectWorkers?: string[];
    dryRun?: string[];
    confirm?: string[];
  };
};

export async function listWorkerSessionControlPlaneWorkerReconciliationRecords(
  projectRoot: string,
  sessionName: string,
  limit = 20,
): Promise<WorkerSessionControlPlaneWorkerReconciliationRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const reconciliationDir = workerSessionControlPlaneWorkerReconciliationDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(reconciliationDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(reconciliationDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionControlPlaneWorkerReconciliationRecord;
      }));
    return records
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeWorkerSessionControlPlaneWorkerReconciliationRecord(
  projectRoot: string,
  record: Omit<WorkerSessionControlPlaneWorkerReconciliationRecord, "reconciliationId"> & { reconciliationId?: string },
): Promise<{ path: string; record: WorkerSessionControlPlaneWorkerReconciliationRecord }> {
  assertSafeWorkerSessionName(record.session);
  const reconciliationRecord: WorkerSessionControlPlaneWorkerReconciliationRecord = {
    ...record,
    reconciliationId: record.reconciliationId ?? createControlPlaneWorkerReconciliationId(record.observedAt),
  };
  assertSafeWorkerSessionName(reconciliationRecord.reconciliationId);
  const reconciliationPath = workerSessionControlPlaneWorkerReconciliationPath(
    projectRoot,
    reconciliationRecord.session,
    reconciliationRecord.reconciliationId,
  );
  await fs.mkdir(path.dirname(reconciliationPath), { recursive: true });
  await fs.writeFile(reconciliationPath, `${JSON.stringify(reconciliationRecord, null, 2)}\n`);
  return { path: reconciliationPath, record: reconciliationRecord };
}

function workerSessionControlPlaneWorkerReconciliationDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-worker-reconciliations", sessionName);
}

function workerSessionControlPlaneWorkerReconciliationPath(
  projectRoot: string,
  sessionName: string,
  reconciliationId: string,
): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(reconciliationId);
  return path.join(workerSessionControlPlaneWorkerReconciliationDir(projectRoot, sessionName), `${reconciliationId}.json`);
}

function createControlPlaneWorkerReconciliationId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
