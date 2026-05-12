import fs from "node:fs/promises";
import path from "node:path";

import {
  listWorkerSessionWatchWorkerNextSteps,
  type SessionWatchWorkerNextStep,
} from "./workerSessionWatchWorkers.js";

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

export type WorkerSessionNext = WorkerSessionLogs & {
  aliveWorkers: number;
  watchWorkerNextSteps: SessionWatchWorkerNextStep[];
  watchWorkerActions: { restart_session_watch_worker: number };
  nextStep: {
    action: "inspect_live_session" | "restart_session_watch_worker" | "restart_session" | "review_session";
    reason: "live_worker_session" | "stopped_session_watch_worker" | "stopped_worker_session" | "no_live_workers";
    count: number;
    command: string[];
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

export function workerSessionAgentIds(session: WorkerSession): string[] {
  const commandArgs = session.command[0] === "runs" && session.command[1] === "work"
    ? session.command.slice(2)
    : session.command;
  const options = parseCommandOptions(commandArgs);
  return parseList(options.agents ?? required(options.agent, "recorded session --agent or --agents"));
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

export async function readWorkerSessionNext(
  projectRoot: string,
  sessionName: string,
  lines: number,
): Promise<WorkerSessionNext> {
  const logs = await readWorkerSessionLogs(projectRoot, sessionName, lines);
  const watchWorkerNext = await listWorkerSessionWatchWorkerNextSteps(projectRoot, sessionName);
  const aliveWorkers = logs.workers.filter((worker) => worker.alive).length;
  const stoppedSession = logs.stoppedAt !== null;
  const nextStep = stoppedSession
    ? {
        action: "restart_session" as const,
        reason: "stopped_worker_session" as const,
        count: logs.workers.length,
        command: logs.commands.restartSessionRecover,
      }
    : aliveWorkers > 0
      ? {
          action: "inspect_live_session" as const,
          reason: "live_worker_session" as const,
          count: aliveWorkers,
          command: logs.commands.sessionSummaryNext,
        }
      : watchWorkerNext.nextSteps[0]
        ? {
            action: "restart_session_watch_worker" as const,
            reason: "stopped_session_watch_worker" as const,
            count: watchWorkerNext.count,
            command: watchWorkerNext.nextSteps[0].command,
          }
        : {
            action: "review_session" as const,
            reason: "no_live_workers" as const,
            count: logs.workers.length,
            command: logs.commands.sessionReview,
          };
  return {
    ...logs,
    aliveWorkers,
    watchWorkerNextSteps: watchWorkerNext.nextSteps,
    watchWorkerActions: watchWorkerNext.actions,
    nextStep,
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

function parseCommandOptions(args: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    if (equals !== -1) {
      options[arg.slice(2, equals)] = arg.slice(equals + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "1";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`missing ${label}`);
  return value;
}
