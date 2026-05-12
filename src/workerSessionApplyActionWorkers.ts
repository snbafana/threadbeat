import fs from "node:fs/promises";
import path from "node:path";

export type ApplyActionWorkerRunSummary = {
  recordedAt: string;
  status: "completed" | "failed";
  executed: number;
  failed: number;
  remainingQueued: number;
  stoppedReason: "batch_complete" | "empty" | "failed_action" | "max_polls" | "repeated_action";
  maxPolls?: number;
  intervalMs?: number;
  repeatedActions?: string[];
  filter: Record<string, unknown>;
  polls: Array<{
    poll: number;
    observedAt: string;
    executed: number;
    failed: number;
    remainingQueued: number;
    stoppedOnFailure: boolean;
  }>;
};

export type ApplyActionWorker = {
  session: string;
  workerId: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  stoppedAt?: string;
  stopResult?: {
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    aliveBefore: boolean;
  };
  retiredAt?: string;
  restartedAt?: string;
  restartCount?: number;
  previousPid?: number | null;
  lastRun?: ApplyActionWorkerRunSummary;
};

export async function listWorkerSessionApplyActionWorkers(
  projectRoot: string,
  options: { sessionName: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  assertSafeWorkerSessionName(options.sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  try {
    const entries = await fs.readdir(applyActionWorkerDir(projectRoot, options.sessionName), { withFileTypes: true });
    const workers = await Promise.all(entries
      .filter((entry) => (
        entry.isFile()
        && entry.name.endsWith(".json")
        && (!options.workerId || entry.name === `${options.workerId}.json`)
      ))
      .map(async (entry) => {
        const worker = await readApplyActionWorker(projectRoot, options.sessionName, entry.name.replace(/\.json$/, ""));
        if (worker.retiredAt && !options.includeRetired) return null;
        return {
          ...worker,
          alive: processIsAlive(worker.pid),
          stdout: { path: worker.stdoutPath, lines: await tailFileLines(worker.stdoutPath, lines) },
          stderr: { path: worker.stderrPath, lines: await tailFileLines(worker.stderrPath, lines) },
        };
      }));
    return workers
      .filter((worker): worker is NonNullable<typeof worker> => worker !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readApplyActionWorker(projectRoot: string, sessionName: string, workerId: string): Promise<ApplyActionWorker> {
  const text = await fs.readFile(applyActionWorkerPath(projectRoot, sessionName, workerId), "utf8");
  return JSON.parse(text) as ApplyActionWorker;
}

function processIsAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function tailFileLines(filePath: string, lineCount: number): Promise<string[]> {
  if (lineCount <= 0) return [];
  try {
    const text = await fs.readFile(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    return lines.slice(-lineCount);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function applyActionWorkerRootDir(projectRoot: string): string {
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "apply-action-workers");
}

function applyActionWorkerDir(projectRoot: string, sessionName: string): string {
  return path.join(applyActionWorkerRootDir(projectRoot), sessionName);
}

function applyActionWorkerPath(projectRoot: string, sessionName: string, workerId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(workerId);
  return path.join(applyActionWorkerDir(projectRoot, sessionName), `${workerId}.json`);
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("worker session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
