import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSession = {
  session: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  workers: Array<{
    workerId: string;
    pid: number | null;
    stdoutPath: string;
    stderrPath: string;
  }>;
  stoppedAt?: string;
  restartedAt?: string;
};

export type WorkerSessionLogs = {
  session: string;
  baseUrl: string;
  startedAt: string;
  stoppedAt: string | null;
  restartedAt: string | null;
  command: string[];
  workers: Array<{
    workerId: string;
    pid: number | null;
    alive: boolean;
    stdout: { path: string; lines: string[] };
    stderr: { path: string; lines: string[] };
  }>;
  commands: {
    sessionStatus: string[];
    sessionSummaryNext: string[];
    sessionReview: string[];
    sessionLogs: string[];
    stopSessionRecover: string[];
    restartSessionRecover: string[];
  };
};

export async function readWorkerSession(
  projectRoot: string,
  sessionName: string,
): Promise<WorkerSession> {
  assertSafeWorkerSessionName(sessionName);
  const text = await fs.readFile(workerSessionPath(projectRoot, sessionName), "utf8");
  return JSON.parse(text) as WorkerSession;
}

export async function readWorkerSessionLogs(
  projectRoot: string,
  sessionName: string,
  lines: number,
): Promise<WorkerSessionLogs> {
  const session = await readWorkerSession(projectRoot, sessionName);
  return {
    session: session.session,
    baseUrl: session.baseUrl,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt ?? null,
    restartedAt: session.restartedAt ?? null,
    command: session.command,
    workers: await Promise.all(session.workers.map(async (worker) => ({
      workerId: worker.workerId,
      pid: worker.pid,
      alive: processIsAlive(worker.pid),
      stdout: {
        path: worker.stdoutPath,
        lines: await tailFileLines(resolveSessionFilePath(projectRoot, worker.stdoutPath), lines),
      },
      stderr: {
        path: worker.stderrPath,
        lines: await tailFileLines(resolveSessionFilePath(projectRoot, worker.stderrPath), lines),
      },
    }))),
    commands: {
      sessionStatus: ["npm", "run", "cli", "--", "runs", "session-status", session.session, "--recoverable", "--include-stopped"],
      sessionSummaryNext: ["npm", "run", "cli", "--", "runs", "session-summary", session.session, "--next"],
      sessionReview: ["npm", "run", "cli", "--", "runs", "session-review", session.session, "--include-stopped"],
      sessionLogs: ["npm", "run", "cli", "--", "runs", "session-logs", session.session],
      stopSessionRecover: ["npm", "run", "cli", "--", "runs", "stop-session", session.session, "--recover"],
      restartSessionRecover: ["npm", "run", "cli", "--", "runs", "restart-session", session.session, "--recover"],
    },
  };
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

function resolveSessionFilePath(projectRoot: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
}

function workerSessionPath(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", `${sessionName}.json`);
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("worker session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
