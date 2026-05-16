import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type TerminalOverviewReplayLoopWorker = {
  session: string;
  workerId: string;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  dryRun: boolean;
  commandSurfaces: string[];
  actions: string[];
  maxSteps: number;
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

export async function startWorkerSessionTerminalOverviewReplayLoopWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: {
    workerId?: string;
    dryRun: boolean;
    commandSurfaces?: string[];
    actions?: string[];
    maxSteps: number;
  },
): Promise<TerminalOverviewReplayLoopWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }> {
  assertSafeWorkerSessionName(sessionName);
  const workerId = options.workerId ?? createTerminalOverviewReplayLoopWorkerId();
  assertSafeWorkerSessionName(workerId);
  const workerDir = terminalOverviewReplayLoopWorkerDir(projectRoot, sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = terminalOverviewReplayLoopWorkerPath(projectRoot, sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`terminal overview replay loop worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = buildTerminalOverviewReplayLoopWorkerCommand(sessionName, options);
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
    const worker: TerminalOverviewReplayLoopWorker = {
      session: sessionName,
      workerId,
      baseUrl,
      startedAt: new Date().toISOString(),
      command,
      pid: child.pid ?? null,
      stdoutPath,
      stderrPath,
      dryRun: options.dryRun,
      commandSurfaces: options.commandSurfaces ?? [],
      actions: options.actions ?? [],
      maxSteps: options.maxSteps,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(toStoredTerminalOverviewReplayLoopWorker(worker), null, 2)}\n`, { flag: "wx" });
    return {
      ...worker,
      alive: processIsAlive(worker.pid),
      stdout: { path: stdoutPath, lines: await tailFileLines(stdoutPath, 0) },
      stderr: { path: stderrPath, lines: await tailFileLines(stderrPath, 0) },
    };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function listWorkerSessionTerminalOverviewReplayLoopWorkers(
  projectRoot: string,
  options: { sessionName: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<TerminalOverviewReplayLoopWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  assertSafeWorkerSessionName(options.sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  try {
    const entries = await fs.readdir(terminalOverviewReplayLoopWorkerDir(projectRoot, options.sessionName), { withFileTypes: true });
    const workers = await Promise.all(entries
      .filter((entry) => (
        entry.isFile()
        && entry.name.endsWith(".json")
        && (!options.workerId || entry.name === `${options.workerId}.json`)
      ))
      .map(async (entry) => {
        const worker = await readTerminalOverviewReplayLoopWorker(projectRoot, options.sessionName, entry.name.replace(/\.json$/, ""));
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

export async function stopWorkerSessionTerminalOverviewReplayLoopWorkers(
  projectRoot: string,
  sessionName: string,
  options: { workerId?: string; retire: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  stopped: Array<{
    workerId: string;
    pid: number | null;
    aliveBefore: boolean;
    stopped: boolean;
    signalSent: boolean;
    forced: boolean;
    alive: boolean;
    stoppedAt: string;
    retiredAt?: string;
  }>;
  workers: Awaited<ReturnType<typeof listWorkerSessionTerminalOverviewReplayLoopWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  const workers = await listWorkerSessionTerminalOverviewReplayLoopWorkers(projectRoot, {
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`terminal overview replay loop worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: TerminalOverviewReplayLoopWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeTerminalOverviewReplayLoopWorker(projectRoot, updated);
    stopped.push({
      workerId: worker.workerId,
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
    workers: await listWorkerSessionTerminalOverviewReplayLoopWorkers(projectRoot, {
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

export async function restartWorkerSessionTerminalOverviewReplayLoopWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: { workerId: string; includeRetired: boolean; lines: number },
): Promise<{
  session: string;
  count: number;
  restarted: Array<{
    workerId: string;
    previousPid: number | null;
    pid: number | null;
    restartedAt: string;
    restartCount: number;
    command: string[];
  }>;
  workers: Awaited<ReturnType<typeof listWorkerSessionTerminalOverviewReplayLoopWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(options.workerId);
  let worker: TerminalOverviewReplayLoopWorker;
  try {
    worker = await readTerminalOverviewReplayLoopWorker(projectRoot, sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`terminal overview replay loop worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`terminal overview replay loop worker '${options.workerId}' is retired; pass includeRetired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`terminal overview replay loop worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`terminal overview replay loop worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const restartedAt = new Date().toISOString();
    const pendingRestart: TerminalOverviewReplayLoopWorker = {
      ...worker,
      baseUrl,
      startedAt: restartedAt,
      pid: null,
      stoppedAt: undefined,
      stopResult: undefined,
      retiredAt: undefined,
      restartedAt,
      restartCount: (worker.restartCount ?? 0) + 1,
      previousPid: worker.pid,
    };
    await writeTerminalOverviewReplayLoopWorker(projectRoot, pendingRestart);
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readTerminalOverviewReplayLoopWorker(projectRoot, sessionName, options.workerId);
    const updated: TerminalOverviewReplayLoopWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeTerminalOverviewReplayLoopWorker(projectRoot, updated);
    return {
      session: sessionName,
      count: 1,
      restarted: [{
        workerId: updated.workerId,
        previousPid: updated.previousPid ?? null,
        pid: updated.pid,
        restartedAt,
        restartCount: updated.restartCount ?? 1,
        command: updated.command,
      }],
      workers: await listWorkerSessionTerminalOverviewReplayLoopWorkers(projectRoot, {
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

function buildTerminalOverviewReplayLoopWorkerCommand(
  sessionName: string,
  options: {
    dryRun: boolean;
    commandSurfaces?: string[];
    actions?: string[];
    maxSteps: number;
  },
): string[] {
  return [
    "runs",
    "session-control-plane-terminal-overview",
    sessionName,
    "--server",
    "--replay-unreplayed-needs-action-loop",
    options.dryRun ? "--dry-run" : "--confirm",
    "--max-steps",
    String(options.maxSteps),
    ...((options.commandSurfaces?.length ?? 0) > 0 ? ["--surface", options.commandSurfaces!.join(",")] : []),
    ...((options.actions?.length ?? 0) > 0 ? ["--action", options.actions!.join(",")] : []),
  ];
}

async function readTerminalOverviewReplayLoopWorker(
  projectRoot: string,
  sessionName: string,
  workerId: string,
): Promise<TerminalOverviewReplayLoopWorker> {
  const text = await fs.readFile(terminalOverviewReplayLoopWorkerPath(projectRoot, sessionName, workerId), "utf8");
  return JSON.parse(text) as TerminalOverviewReplayLoopWorker;
}

async function writeTerminalOverviewReplayLoopWorker(projectRoot: string, worker: TerminalOverviewReplayLoopWorker): Promise<void> {
  await fs.writeFile(
    terminalOverviewReplayLoopWorkerPath(projectRoot, worker.session, worker.workerId),
    `${JSON.stringify(toStoredTerminalOverviewReplayLoopWorker(worker), null, 2)}\n`,
  );
}

function toStoredTerminalOverviewReplayLoopWorker(worker: TerminalOverviewReplayLoopWorker): TerminalOverviewReplayLoopWorker {
  return {
    session: worker.session,
    workerId: worker.workerId,
    baseUrl: worker.baseUrl,
    startedAt: worker.startedAt,
    command: worker.command,
    pid: worker.pid,
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
    dryRun: worker.dryRun,
    commandSurfaces: worker.commandSurfaces,
    actions: worker.actions,
    maxSteps: worker.maxSteps,
    ...(worker.stoppedAt !== undefined ? { stoppedAt: worker.stoppedAt } : {}),
    ...(worker.stopResult !== undefined ? { stopResult: worker.stopResult } : {}),
    ...(worker.retiredAt !== undefined ? { retiredAt: worker.retiredAt } : {}),
    ...(worker.restartedAt !== undefined ? { restartedAt: worker.restartedAt } : {}),
    ...(worker.restartCount !== undefined ? { restartCount: worker.restartCount } : {}),
    ...(worker.previousPid !== undefined ? { previousPid: worker.previousPid } : {}),
  };
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

function terminalOverviewReplayLoopWorkerRootDir(projectRoot: string): string {
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "terminal-overview-replay-loop-workers");
}

function terminalOverviewReplayLoopWorkerDir(projectRoot: string, sessionName: string): string {
  return path.join(terminalOverviewReplayLoopWorkerRootDir(projectRoot), sessionName);
}

function terminalOverviewReplayLoopWorkerPath(projectRoot: string, sessionName: string, workerId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(workerId);
  return path.join(terminalOverviewReplayLoopWorkerDir(projectRoot, sessionName), `${workerId}.json`);
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("worker session names may only contain letters, numbers, '.', '_', and '-'");
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function createTerminalOverviewReplayLoopWorkerId(): string {
  return `terminal-overview-replay-loop-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}
