import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type SessionWatchWorker = {
  session: string;
  workerId: string;
  watchId: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  stoppedAt?: string;
  stopResult?: StopProcessGroupResult & { aliveBefore: boolean };
  retiredAt?: string;
  restartedAt?: string;
  restartCount?: number;
  previousPid?: number | null;
};

type StopProcessGroupResult = {
  stopped: boolean;
  signalSent: boolean;
  forced: boolean;
  alive: boolean;
};

type StartSessionWatchWorkerOptions = {
  workerId?: string;
  watchId?: string;
  maxPolls: number;
  intervalMs: number;
  recoverable: boolean;
  includeStopped: boolean;
  actionQueue: boolean;
  applyAction?: string;
};

export type SessionWatchWorkerNextStep = {
  action: "restart_session_watch_worker";
  reason: "stopped_session_watch_worker";
  workerId: string;
  watchId: string;
  pid: number | null;
  stoppedAt: string;
  command: string[];
  commands: {
    restartSessionWatchWorker: string[];
    inspectSessionWatchWorkers: string[];
    retireSessionWatchWorker: string[];
  };
  api: {
    restart: { method: "POST"; url: string; payload: { workerId: string } };
    inspect: { method: "GET"; url: string };
    retire: { method: "POST"; url: string; payload: { workerId: string; retire: true } };
  };
};

export async function startWorkerSessionWatchWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: StartSessionWatchWorkerOptions,
): Promise<SessionWatchWorker & { alive: boolean }> {
  assertSafeWorkerSessionName(sessionName);
  if (options.applyAction && !options.actionQueue) {
    throw new Error("watch worker applyAction requires actionQueue");
  }
  const workerId = options.workerId ?? createSessionWatchWorkerId();
  assertSafeWorkerSessionName(workerId);
  const watchId = options.watchId ?? `${workerId}-watch`;
  assertSafeWorkerSessionName(watchId);
  const workerDir = sessionWatchWorkerDir(projectRoot, sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = sessionWatchWorkerPath(projectRoot, sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`session watch worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = [
    "runs",
    "session-watch",
    sessionName,
    "--next",
    "--until-empty",
    "--watch-id",
    watchId,
    "--max-polls",
    String(options.maxPolls),
    "--interval-ms",
    String(options.intervalMs),
    ...(options.recoverable ? ["--recoverable"] : []),
    ...(options.includeStopped ? ["--include-stopped"] : []),
    ...(options.actionQueue ? ["--action-queue"] : []),
    ...(options.applyAction ? ["--apply-action", options.applyAction] : []),
  ];
  const stdout = await fs.open(stdoutPath, "a");
  const stderr = await fs.open(stderrPath, "a");
  try {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const worker: SessionWatchWorker = {
      session: sessionName,
      workerId,
      watchId,
      baseUrl,
      startedAt: new Date().toISOString(),
      command,
      pid: child.pid ?? null,
      stdoutPath,
      stderrPath,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(worker, null, 2)}\n`, { flag: "wx" });
    return { ...worker, alive: processIsAlive(worker.pid) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function listWorkerSessionWatchWorkers(
  projectRoot: string,
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<SessionWatchWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  const sessionNames = options.sessionName ? [options.sessionName] : await listSessionWatchWorkerSessionNames(projectRoot);
  const workers = await Promise.all(sessionNames.map(async (sessionName) => {
    assertSafeWorkerSessionName(sessionName);
    try {
      const entries = await fs.readdir(sessionWatchWorkerDir(projectRoot, sessionName), { withFileTypes: true });
      return await Promise.all(entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && (!options.workerId || entry.name === `${options.workerId}.json`)
        ))
        .map(async (entry) => {
          const worker = await readWorkerSessionWatchWorker(projectRoot, sessionName, entry.name.replace(/\.json$/, ""));
          if (worker.retiredAt && !options.includeRetired) return null;
          return {
            ...worker,
            alive: processIsAlive(worker.pid),
            stdout: { path: worker.stdoutPath, lines: await tailFileLines(worker.stdoutPath, lines) },
            stderr: { path: worker.stderrPath, lines: await tailFileLines(worker.stderrPath, lines) },
          };
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }));
  return workers.flat().filter((worker): worker is NonNullable<typeof worker> => worker !== null).sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function stopWorkerSessionWatchWorkers(
  projectRoot: string,
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    watchId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Awaited<ReturnType<typeof listWorkerSessionWatchWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  const workers = await listWorkerSessionWatchWorkers(projectRoot, {
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`session watch worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: SessionWatchWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeWorkerSessionWatchWorker(projectRoot, updated);
    stopped.push({
      workerId: worker.workerId,
      watchId: worker.watchId,
      pid: worker.pid,
      aliveBefore,
      stopped: !result.alive,
      signalSent: result.signalSent,
      forced: result.forced,
      alive: result.alive,
      stoppedAt,
      ...(updated.retiredAt ? { retiredAt: updated.retiredAt } : {}),
    });
  }
  return {
    session: sessionName,
    count: stopped.length,
    stopped,
    workers: await listWorkerSessionWatchWorkers(projectRoot, {
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

export async function listWorkerSessionWatchWorkerNextSteps(
  projectRoot: string,
  sessionName: string,
): Promise<{
  session: string;
  count: number;
  nextSteps: SessionWatchWorkerNextStep[];
  actions: { restart_session_watch_worker: number };
}> {
  assertSafeWorkerSessionName(sessionName);
  const workers = await listWorkerSessionWatchWorkers(projectRoot, { sessionName }, 1);
  const nextSteps = workers
    .filter((worker) => !worker.alive && Boolean(worker.stoppedAt))
    .map((worker): SessionWatchWorkerNextStep => {
      const restartSessionWatchWorker = ["npm", "run", "cli", "--", "runs", "restart-session-watch-workers", sessionName, "--worker-id", worker.workerId];
      const encodedSession = encodeURIComponent(sessionName);
      const encodedWorker = encodeURIComponent(worker.workerId);
      return {
        action: "restart_session_watch_worker",
        reason: "stopped_session_watch_worker",
        workerId: worker.workerId,
        watchId: worker.watchId,
        pid: worker.pid,
        stoppedAt: worker.stoppedAt as string,
        command: restartSessionWatchWorker,
        commands: {
          restartSessionWatchWorker,
          inspectSessionWatchWorkers: ["npm", "run", "cli", "--", "runs", "session-watch-workers", sessionName, "--worker-id", worker.workerId],
          retireSessionWatchWorker: ["npm", "run", "cli", "--", "runs", "stop-session-watch-workers", sessionName, "--worker-id", worker.workerId, "--retire"],
        },
        api: {
          restart: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/watch-workers/restart`,
            payload: { workerId: worker.workerId },
          },
          inspect: {
            method: "GET",
            url: `/api/worker-sessions/${encodedSession}/watch-workers?workerId=${encodedWorker}`,
          },
          retire: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/watch-workers/stop`,
            payload: { workerId: worker.workerId, retire: true },
          },
        },
      };
    });
  return {
    session: sessionName,
    count: nextSteps.length,
    nextSteps,
    actions: { restart_session_watch_worker: nextSteps.length },
  };
}

export async function restartWorkerSessionWatchWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    watchId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Awaited<ReturnType<typeof listWorkerSessionWatchWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(options.workerId);
  let worker: SessionWatchWorker;
  try {
    worker = await readWorkerSessionWatchWorker(projectRoot, sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`session watch worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`session watch worker '${options.workerId}' is retired; pass includeRetired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`session watch worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`session watch worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const restartedAt = new Date().toISOString();
    const updated: SessionWatchWorker = {
      ...worker,
      baseUrl,
      startedAt: restartedAt,
      pid: child.pid ?? null,
      stoppedAt: undefined,
      stopResult: undefined,
      retiredAt: undefined,
      restartedAt,
      restartCount: (worker.restartCount ?? 0) + 1,
      previousPid: worker.pid,
    };
    await writeWorkerSessionWatchWorker(projectRoot, updated);
    return {
      session: sessionName,
      count: 1,
      restarted: [{
        workerId: updated.workerId,
        watchId: updated.watchId,
        previousPid: updated.previousPid ?? null,
        pid: updated.pid,
        restartedAt,
        restartCount: updated.restartCount ?? 1,
        command: updated.command,
      }],
      workers: await listWorkerSessionWatchWorkers(projectRoot, {
        sessionName,
        workerId: options.workerId,
        includeRetired: true,
      }, options.lines),
    };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

async function readWorkerSessionWatchWorker(projectRoot: string, sessionName: string, workerId: string): Promise<SessionWatchWorker> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(workerId);
  const text = await fs.readFile(sessionWatchWorkerPath(projectRoot, sessionName, workerId), "utf8");
  return JSON.parse(text) as SessionWatchWorker;
}

async function writeWorkerSessionWatchWorker(projectRoot: string, worker: SessionWatchWorker): Promise<void> {
  await fs.writeFile(sessionWatchWorkerPath(projectRoot, worker.session, worker.workerId), `${JSON.stringify(worker, null, 2)}\n`);
}

async function listSessionWatchWorkerSessionNames(projectRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionWatchWorkerRootDir(projectRoot), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function stopProcessGroup(pid: number | null): Promise<StopProcessGroupResult> {
  if (!pid || !processIsAlive(pid)) return { stopped: false, signalSent: false, forced: false, alive: false };
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      process.kill(pid, "SIGTERM");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!processIsAlive(pid)) return { stopped: true, signalSent: true, forced: false, alive: false };
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      process.kill(pid, "SIGKILL");
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  return { stopped: !processIsAlive(pid), signalSent: true, forced: true, alive: processIsAlive(pid) };
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sessionWatchWorkerRootDir(projectRoot: string): string {
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "watch-workers");
}

function sessionWatchWorkerDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(sessionWatchWorkerRootDir(projectRoot), sessionName);
}

function sessionWatchWorkerPath(projectRoot: string, sessionName: string, workerId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(workerId);
  return path.join(sessionWatchWorkerDir(projectRoot, sessionName), `${workerId}.json`);
}

function createSessionWatchWorkerId(): string {
  return `watch-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("worker session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
