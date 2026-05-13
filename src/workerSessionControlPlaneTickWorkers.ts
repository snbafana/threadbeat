import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type ControlPlaneTickWorker = {
  session: string;
  workerId: string;
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

export type ControlPlaneTickWorkerNextStep = {
  action: "restart_control_plane_tick_worker";
  reason: "stopped_control_plane_tick_worker";
  workerId: string;
  pid: number | null;
  stoppedAt: string;
  command: string[];
  commands: {
    restartControlPlaneTickWorker: string[];
    inspectControlPlaneTickWorkers: string[];
    retireControlPlaneTickWorker: string[];
  };
  api: {
    restart: { method: "POST"; url: string; payload: { workerId: string } };
    inspect: { method: "GET"; url: string };
    retire: { method: "POST"; url: string; payload: { workerId: string; retire: true } };
  };
};

export async function startWorkerSessionControlPlaneTickWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: {
    workerId?: string;
    dryRun: boolean;
    maxTicks: number;
    intervalMs: number;
    lines: number;
  },
): Promise<ControlPlaneTickWorker & { alive: boolean }> {
  assertSafeWorkerSessionName(sessionName);
  const workerId = options.workerId ?? createControlPlaneTickWorkerId();
  assertSafeWorkerSessionName(workerId);
  const workerDir = controlPlaneTickWorkerDir(projectRoot, sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = controlPlaneTickWorkerPath(projectRoot, sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`control-plane tick worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = [
    "runs",
    "session-control-plane-tick-loop",
    sessionName,
    "--server",
    "--max-ticks",
    String(options.maxTicks),
    "--interval-ms",
    String(options.intervalMs),
    "--lines",
    String(options.lines),
    ...(options.dryRun ? ["--dry-run"] : []),
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
    const worker: ControlPlaneTickWorker = {
      session: sessionName,
      workerId,
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

export async function listWorkerSessionControlPlaneTickWorkers(
  projectRoot: string,
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<ControlPlaneTickWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  const sessionNames = options.sessionName ? [options.sessionName] : await listControlPlaneTickWorkerSessionNames(projectRoot);
  const workers = await Promise.all(sessionNames.map(async (sessionName) => {
    assertSafeWorkerSessionName(sessionName);
    try {
      const entries = await fs.readdir(controlPlaneTickWorkerDir(projectRoot, sessionName), { withFileTypes: true });
      return await Promise.all(entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && (!options.workerId || entry.name === `${options.workerId}.json`)
        ))
        .map(async (entry) => {
          const worker = await readControlPlaneTickWorker(projectRoot, sessionName, entry.name.replace(/\.json$/, ""));
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

export async function stopWorkerSessionControlPlaneTickWorkers(
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
  workers: Awaited<ReturnType<typeof listWorkerSessionControlPlaneTickWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  const workers = await listWorkerSessionControlPlaneTickWorkers(projectRoot, {
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`control-plane tick worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: ControlPlaneTickWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeControlPlaneTickWorker(projectRoot, updated);
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
    workers: await listWorkerSessionControlPlaneTickWorkers(projectRoot, {
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

export async function listWorkerSessionControlPlaneTickWorkerNextSteps(
  projectRoot: string,
  sessionName: string,
): Promise<{
  session: string;
  count: number;
  nextSteps: ControlPlaneTickWorkerNextStep[];
  actions: { restart_control_plane_tick_worker: number };
}> {
  assertSafeWorkerSessionName(sessionName);
  const workers = await listWorkerSessionControlPlaneTickWorkers(projectRoot, { sessionName }, 1);
  const nextSteps = workers
    .filter((worker) => !worker.alive && Boolean(worker.stoppedAt))
    .map((worker): ControlPlaneTickWorkerNextStep => {
      const restartControlPlaneTickWorker = ["npm", "run", "cli", "--", "runs", "restart-control-plane-tick-workers", sessionName, "--server", "--worker-id", worker.workerId];
      const encodedSession = encodeURIComponent(sessionName);
      const encodedWorker = encodeURIComponent(worker.workerId);
      return {
        action: "restart_control_plane_tick_worker",
        reason: "stopped_control_plane_tick_worker",
        workerId: worker.workerId,
        pid: worker.pid,
        stoppedAt: worker.stoppedAt as string,
        command: restartControlPlaneTickWorker,
        commands: {
          restartControlPlaneTickWorker,
          inspectControlPlaneTickWorkers: ["npm", "run", "cli", "--", "runs", "session-control-plane-tick-workers", sessionName, "--server", "--worker-id", worker.workerId],
          retireControlPlaneTickWorker: ["npm", "run", "cli", "--", "runs", "stop-control-plane-tick-workers", sessionName, "--server", "--worker-id", worker.workerId, "--retire"],
        },
        api: {
          restart: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/control-plane-tick-workers/restart`,
            payload: { workerId: worker.workerId },
          },
          inspect: {
            method: "GET",
            url: `/api/worker-sessions/${encodedSession}/control-plane-tick-workers?workerId=${encodedWorker}`,
          },
          retire: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/control-plane-tick-workers/stop`,
            payload: { workerId: worker.workerId, retire: true },
          },
        },
      };
    });
  return {
    session: sessionName,
    count: nextSteps.length,
    nextSteps,
    actions: { restart_control_plane_tick_worker: nextSteps.length },
  };
}

export async function restartWorkerSessionControlPlaneTickWorker(
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
  workers: Awaited<ReturnType<typeof listWorkerSessionControlPlaneTickWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(options.workerId);
  let worker: ControlPlaneTickWorker;
  try {
    worker = await readControlPlaneTickWorker(projectRoot, sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`control-plane tick worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`control-plane tick worker '${options.workerId}' is retired; pass includeRetired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`control-plane tick worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`control-plane tick worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const restartedAt = new Date().toISOString();
    const pendingRestart: ControlPlaneTickWorker = {
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
    await writeControlPlaneTickWorker(projectRoot, pendingRestart);
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readControlPlaneTickWorker(projectRoot, sessionName, options.workerId);
    const updated: ControlPlaneTickWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeControlPlaneTickWorker(projectRoot, updated);
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
      workers: await listWorkerSessionControlPlaneTickWorkers(projectRoot, {
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

async function listControlPlaneTickWorkerSessionNames(projectRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(controlPlaneTickWorkerRootDir(projectRoot), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readControlPlaneTickWorker(projectRoot: string, sessionName: string, workerId: string): Promise<ControlPlaneTickWorker> {
  const text = await fs.readFile(controlPlaneTickWorkerPath(projectRoot, sessionName, workerId), "utf8");
  return JSON.parse(text) as ControlPlaneTickWorker;
}

async function writeControlPlaneTickWorker(projectRoot: string, worker: ControlPlaneTickWorker): Promise<void> {
  await fs.writeFile(controlPlaneTickWorkerPath(projectRoot, worker.session, worker.workerId), `${JSON.stringify(worker, null, 2)}\n`);
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

function controlPlaneTickWorkerRootDir(projectRoot: string): string {
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-tick-workers");
}

function controlPlaneTickWorkerDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(controlPlaneTickWorkerRootDir(projectRoot), sessionName);
}

function controlPlaneTickWorkerPath(projectRoot: string, sessionName: string, workerId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(workerId);
  return path.join(controlPlaneTickWorkerDir(projectRoot, sessionName), `${workerId}.json`);
}

function createControlPlaneTickWorkerId(): string {
  return `control-plane-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("worker session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
