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
    branchRecovery: null | { action: "resume_next_branch"; runIds: string[]; command: string[] };
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

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
