import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionBranchRecoveryExecutionRecord = {
  executionId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  status: "executed" | "partial" | "noop";
  filter: Record<string, unknown>;
  selected: number;
  resumed: Array<{
    agentId: string;
    runId: string;
    objective: string;
    branchName: string;
    resultCommit: string | null;
    workerId: string | null;
    status?: string;
  }>;
  skipped: Array<{
    agentId: string;
    runId: string;
    objective: string;
    branchName: string;
    resultCommit: string | null;
    workerId: string | null;
    reason: string;
  }>;
  nextStep?: unknown;
};

export async function listWorkerSessionBranchRecoveryExecutionRecords(
  projectRoot: string,
  sessionName: string,
  limit = 20,
): Promise<WorkerSessionBranchRecoveryExecutionRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const executionDir = workerSessionBranchRecoveryExecutionDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(executionDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(executionDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionBranchRecoveryExecutionRecord;
      }));
    return records
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeWorkerSessionBranchRecoveryExecutionRecord(
  projectRoot: string,
  record: Omit<WorkerSessionBranchRecoveryExecutionRecord, "executionId"> & { executionId?: string },
): Promise<{ path: string; record: WorkerSessionBranchRecoveryExecutionRecord }> {
  assertSafeWorkerSessionName(record.session);
  const executionRecord: WorkerSessionBranchRecoveryExecutionRecord = {
    ...record,
    executionId: record.executionId ?? createBranchRecoveryExecutionId(record.observedAt),
  };
  assertSafeWorkerSessionName(executionRecord.executionId);
  const executionPath = workerSessionBranchRecoveryExecutionPath(
    projectRoot,
    executionRecord.session,
    executionRecord.executionId,
  );
  await fs.mkdir(path.dirname(executionPath), { recursive: true });
  await fs.writeFile(executionPath, `${JSON.stringify(executionRecord, null, 2)}\n`);
  return { path: executionPath, record: executionRecord };
}

function workerSessionBranchRecoveryExecutionDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "branch-recovery-executions", sessionName);
}

function workerSessionBranchRecoveryExecutionPath(projectRoot: string, sessionName: string, executionId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(executionId);
  return path.join(workerSessionBranchRecoveryExecutionDir(projectRoot, sessionName), `${executionId}.json`);
}

function createBranchRecoveryExecutionId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
