import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionResultReviewRecord = {
  reviewId: string;
  session: string;
  observedAt: string;
  action: "reviewed" | "skipped";
  runId: string;
  agentId: string;
  objective: string;
  branchName: string;
  resultCommit: string;
  workerId: string | null;
  reviewedBy: string;
  note?: string;
  command: string[];
};

export async function listWorkerSessionResultReviewRecords(
  projectRoot: string,
  sessionName: string,
  limit = 20,
): Promise<WorkerSessionResultReviewRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const reviewDir = workerSessionResultReviewDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(reviewDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(reviewDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionResultReviewRecord;
      }));
    return records
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeWorkerSessionResultReviewRecord(
  projectRoot: string,
  record: Omit<WorkerSessionResultReviewRecord, "reviewId"> & { reviewId?: string },
): Promise<{ path: string; record: WorkerSessionResultReviewRecord }> {
  assertSafeWorkerSessionName(record.session);
  const reviewRecord: WorkerSessionResultReviewRecord = {
    ...record,
    reviewId: record.reviewId ?? createResultReviewId(record.observedAt),
  };
  assertSafeWorkerSessionName(reviewRecord.reviewId);
  const reviewPath = workerSessionResultReviewPath(projectRoot, reviewRecord.session, reviewRecord.reviewId);
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, `${JSON.stringify(reviewRecord, null, 2)}\n`);
  return { path: reviewPath, record: reviewRecord };
}

export function latestResultReviewByRunCommit(
  records: WorkerSessionResultReviewRecord[],
): Map<string, WorkerSessionResultReviewRecord> {
  const latest = new Map<string, WorkerSessionResultReviewRecord>();
  for (const record of [...records].sort((left, right) => left.observedAt.localeCompare(right.observedAt))) {
    latest.set(resultReviewRunCommitKey(record.runId, record.resultCommit), record);
  }
  return latest;
}

export function resultReviewRunCommitKey(runId: string, resultCommit: string): string {
  return `${runId}:${resultCommit}`;
}

function workerSessionResultReviewDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "result-reviews", sessionName);
}

function workerSessionResultReviewPath(projectRoot: string, sessionName: string, reviewId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(reviewId);
  return path.join(workerSessionResultReviewDir(projectRoot, sessionName), `${reviewId}.json`);
}

function createResultReviewId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
