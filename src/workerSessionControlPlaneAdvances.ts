import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionControlPlaneAdvanceRecord = {
  advanceId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  selected: unknown | null;
  executed: unknown | null;
  executionSafety?: unknown;
  before: unknown;
  after: unknown;
};

export async function listWorkerSessionControlPlaneAdvanceRecords(
  projectRoot: string,
  sessionName: string,
  limit = 20,
): Promise<WorkerSessionControlPlaneAdvanceRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const advanceDir = workerSessionControlPlaneAdvanceDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(advanceDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(advanceDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionControlPlaneAdvanceRecord;
      }));
    return records
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeWorkerSessionControlPlaneAdvanceRecord(
  projectRoot: string,
  record: Omit<WorkerSessionControlPlaneAdvanceRecord, "advanceId"> & { advanceId?: string },
): Promise<{ path: string; record: WorkerSessionControlPlaneAdvanceRecord }> {
  assertSafeWorkerSessionName(record.session);
  const advanceRecord: WorkerSessionControlPlaneAdvanceRecord = {
    ...record,
    advanceId: record.advanceId ?? createControlPlaneAdvanceId(record.observedAt),
  };
  assertSafeWorkerSessionName(advanceRecord.advanceId);
  const advancePath = workerSessionControlPlaneAdvancePath(projectRoot, advanceRecord.session, advanceRecord.advanceId);
  await fs.mkdir(path.dirname(advancePath), { recursive: true });
  await fs.writeFile(advancePath, `${JSON.stringify(advanceRecord, null, 2)}\n`);
  return { path: advancePath, record: advanceRecord };
}

function workerSessionControlPlaneAdvanceDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-advances", sessionName);
}

function workerSessionControlPlaneAdvancePath(projectRoot: string, sessionName: string, advanceId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(advanceId);
  return path.join(workerSessionControlPlaneAdvanceDir(projectRoot, sessionName), `${advanceId}.json`);
}

function createControlPlaneAdvanceId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertSafeWorkerSessionName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`unsafe worker session name: ${name}`);
  }
}
