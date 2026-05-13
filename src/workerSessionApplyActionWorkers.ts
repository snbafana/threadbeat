import { spawn } from "node:child_process";
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

type StopProcessGroupResult = {
  stopped: boolean;
  signalSent: boolean;
  forced: boolean;
  alive: boolean;
};

export type ApplyActionWorkerNextStep = {
  action: "restart_apply_action_worker";
  reason: "stopped_apply_action_worker";
  workerId: string;
  pid: number | null;
  stoppedAt: string;
  command: string[];
  commands: {
    restartApplyActionWorker: string[];
    inspectApplyActionWorkers: string[];
    retireApplyActionWorker: string[];
  };
  api: {
    restart: { method: "POST"; url: string; payload: { workerId: string } };
    inspect: { method: "GET"; url: string };
    retire: { method: "POST"; url: string; payload: { workerId: string; retire: true } };
  };
};

export async function startWorkerSessionApplyActionWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: {
    workerId?: string;
    applyId?: string;
    source?: string;
    action?: string;
    limit?: number | null;
    maxActions?: number | null;
    stopOnFailure: boolean;
    untilEmpty: boolean;
    maxPolls?: number | null;
    intervalMs?: number | null;
  },
): Promise<ApplyActionWorker & { alive: boolean; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }> {
  assertSafeWorkerSessionName(sessionName);
  const workerId = options.workerId ?? createApplyActionWorkerId();
  assertSafeWorkerSessionName(workerId);
  const workerDir = applyActionWorkerDir(projectRoot, sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = applyActionWorkerPath(projectRoot, sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`apply action worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const command = [
    "runs",
    "session-applies",
    sessionName,
    "--server",
    "--action-queue",
    "--execute-queued",
    "--record-worker",
    workerId,
    ...(options.applyId ? ["--apply-id", options.applyId] : []),
    ...(options.source ? ["--source", options.source] : []),
    ...(options.action ? ["--apply-action", options.action] : []),
    ...(options.limit ? ["--limit", String(options.limit)] : []),
    ...(options.maxActions ? ["--max-actions", String(options.maxActions)] : []),
    ...(options.stopOnFailure ? [] : ["--continue-on-failure"]),
    ...(options.untilEmpty ? ["--until-empty"] : []),
    ...(options.maxPolls ? ["--max-polls", String(options.maxPolls)] : []),
    ...(options.intervalMs ? ["--interval-ms", String(options.intervalMs)] : []),
  ];
  const stdout = await fs.open(stdoutPath, "a");
  const stderr = await fs.open(stderrPath, "a");
  try {
    const startedAt = new Date().toISOString();
    const initialWorker: ApplyActionWorker = {
      session: sessionName,
      workerId,
      baseUrl,
      startedAt,
      command,
      pid: null,
      stdoutPath,
      stderrPath,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(initialWorker, null, 2)}\n`, { flag: "wx" });
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readApplyActionWorker(projectRoot, sessionName, workerId);
    const worker: ApplyActionWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeApplyActionWorker(projectRoot, worker);
    return {
      ...worker,
      alive: processIsAlive(worker.pid),
      stdout: { path: stdoutPath, lines: await tailFileLines(stdoutPath, 0) },
      stderr: { path: stderrPath, lines: await tailFileLines(stderrPath, 0) },
    };
  } catch (error) {
    await fs.rm(recordPath, { force: true });
    throw error;
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

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

export async function stopWorkerSessionApplyActionWorkers(
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
  workers: Awaited<ReturnType<typeof listWorkerSessionApplyActionWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  const workers = await listWorkerSessionApplyActionWorkers(projectRoot, {
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`apply action worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: ApplyActionWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeApplyActionWorker(projectRoot, updated);
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
    workers: await listWorkerSessionApplyActionWorkers(projectRoot, {
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

export async function listWorkerSessionApplyActionWorkerNextSteps(
  projectRoot: string,
  sessionName: string,
): Promise<{
  session: string;
  count: number;
  nextSteps: ApplyActionWorkerNextStep[];
  actions: { restart_apply_action_worker: number };
}> {
  assertSafeWorkerSessionName(sessionName);
  const workers = await listWorkerSessionApplyActionWorkers(projectRoot, { sessionName }, 1);
  const nextSteps = workers
    .filter((worker) => !worker.alive && Boolean(worker.stoppedAt))
    .map((worker): ApplyActionWorkerNextStep => {
      const restartApplyActionWorker = ["npm", "run", "cli", "--", "runs", "restart-apply-action-workers", sessionName, "--server", "--worker-id", worker.workerId];
      const encodedSession = encodeURIComponent(sessionName);
      const encodedWorker = encodeURIComponent(worker.workerId);
      return {
        action: "restart_apply_action_worker",
        reason: "stopped_apply_action_worker",
        workerId: worker.workerId,
        pid: worker.pid,
        stoppedAt: worker.stoppedAt as string,
        command: restartApplyActionWorker,
        commands: {
          restartApplyActionWorker,
          inspectApplyActionWorkers: ["npm", "run", "cli", "--", "runs", "session-apply-action-workers", sessionName, "--server", "--worker-id", worker.workerId],
          retireApplyActionWorker: ["npm", "run", "cli", "--", "runs", "stop-apply-action-workers", sessionName, "--server", "--worker-id", worker.workerId, "--retire"],
        },
        api: {
          restart: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/apply-action-workers/restart`,
            payload: { workerId: worker.workerId },
          },
          inspect: {
            method: "GET",
            url: `/api/worker-sessions/${encodedSession}/apply-action-workers?workerId=${encodedWorker}`,
          },
          retire: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/apply-action-workers/stop`,
            payload: { workerId: worker.workerId, retire: true },
          },
        },
      };
    });
  return {
    session: sessionName,
    count: nextSteps.length,
    nextSteps,
    actions: { restart_apply_action_worker: nextSteps.length },
  };
}

export async function restartWorkerSessionApplyActionWorker(
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
  workers: Awaited<ReturnType<typeof listWorkerSessionApplyActionWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(options.workerId);
  let worker: ApplyActionWorker;
  try {
    worker = await readApplyActionWorker(projectRoot, sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`apply action worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`apply action worker '${options.workerId}' is retired; pass includeRetired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`apply action worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`apply action worker record mismatch for '${options.workerId}'`);
  }
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const restartedAt = new Date().toISOString();
    const pendingRestart: ApplyActionWorker = {
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
      lastRun: undefined,
    };
    await writeApplyActionWorker(projectRoot, pendingRestart);
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readApplyActionWorker(projectRoot, sessionName, options.workerId);
    const updated: ApplyActionWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeApplyActionWorker(projectRoot, updated);
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
      workers: await listWorkerSessionApplyActionWorkers(projectRoot, {
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

async function readApplyActionWorker(projectRoot: string, sessionName: string, workerId: string): Promise<ApplyActionWorker> {
  const text = await fs.readFile(applyActionWorkerPath(projectRoot, sessionName, workerId), "utf8");
  return JSON.parse(text) as ApplyActionWorker;
}

async function writeApplyActionWorker(projectRoot: string, worker: ApplyActionWorker): Promise<void> {
  await fs.writeFile(applyActionWorkerPath(projectRoot, worker.session, worker.workerId), `${JSON.stringify(worker, null, 2)}\n`);
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function createApplyActionWorkerId(): string {
  return `apply-action-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}
