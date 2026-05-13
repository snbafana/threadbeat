import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type ControlPlaneAdvanceWorker = {
  session: string;
  workerId: string;
  mode: ControlPlaneAdvanceWorkerMode;
  baseUrl: string;
  startedAt: string;
  command: string[];
  pid: number | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutStartOffset?: number;
  stoppedAt?: string;
  stopResult?: StopProcessGroupResult & { aliveBefore: boolean };
  retiredAt?: string;
  restartedAt?: string;
  restartCount?: number;
  previousPid?: number | null;
  completedAt?: string;
  completionResult?: { exitCode: number | null; signal: NodeJS.Signals | null };
  latestResult?: ControlPlaneAdvanceWorkerLatestResult | null;
};

export type ControlPlaneAdvanceWorkerMode = "advance_loop" | "confirmation_drain";

export type ControlPlaneAdvanceWorkerLifecycle = {
  state: "running" | "stopped" | "completed" | "retired" | "stopping_failed" | "exited_unrecorded";
  restartable: boolean;
  reason:
    | "worker_running"
    | "stopped_control_plane_advance_worker"
    | "worker_completed"
    | "worker_retired"
    | "stop_recorded_but_process_alive"
    | "worker_exited_without_stop_or_completion_record";
};

export type ControlPlaneAdvanceWorkerLatestResult = {
  ok?: boolean;
  session?: string;
  dryRun?: boolean;
  untilEmpty?: boolean;
  stoppedReason?: string;
  maxSteps?: number;
  intervalMs?: number;
  maxConfirmations?: number;
  executedSteps?: number;
  attemptedConfirmations?: number;
  availableConfirmations?: number;
  cycles?: number;
  results?: number;
  sourceAdvanceId?: string;
  detailCommand?: string;
};

type StopProcessGroupResult = {
  stopped: boolean;
  signalSent: boolean;
  forced: boolean;
  alive: boolean;
};

export type ControlPlaneAdvanceWorkerNextStep = {
  action: "restart_control_plane_advance_worker";
  reason: "stopped_control_plane_advance_worker";
  workerId: string;
  mode: ControlPlaneAdvanceWorkerMode;
  pid: number | null;
  stoppedAt: string;
  command: string[];
  commands: {
    restartControlPlaneAdvanceWorker: string[];
    inspectControlPlaneAdvanceWorkers: string[];
    retireControlPlaneAdvanceWorker: string[];
  };
  api: {
    restart: { method: "POST"; url: string; payload: { workerId: string } };
    inspect: { method: "GET"; url: string };
    retire: { method: "POST"; url: string; payload: { workerId: string; retire: true } };
  };
};

export async function startWorkerSessionControlPlaneAdvanceWorker(
  projectRoot: string,
  baseUrl: string,
  sessionName: string,
  options: {
    workerId?: string;
    dryRun: boolean;
    maxSteps: number;
    intervalMs: number;
    lines: number;
    drainConfirmations?: boolean;
    confirm?: boolean;
    maxConfirmations?: number;
    untilEmpty?: boolean;
  },
): Promise<ControlPlaneAdvanceWorker & { alive: boolean; lifecycle: ControlPlaneAdvanceWorkerLifecycle }> {
  assertSafeWorkerSessionName(sessionName);
  const workerId = options.workerId ?? createControlPlaneAdvanceWorkerId();
  assertSafeWorkerSessionName(workerId);
  const workerDir = controlPlaneAdvanceWorkerDir(projectRoot, sessionName);
  await fs.mkdir(workerDir, { recursive: true });
  const stdoutPath = path.join(workerDir, `${workerId}.out.log`);
  const stderrPath = path.join(workerDir, `${workerId}.err.log`);
  const recordPath = controlPlaneAdvanceWorkerPath(projectRoot, sessionName, workerId);
  if (await pathExists(recordPath)) {
    throw new Error(`control-plane advance worker '${workerId}' already exists for session '${sessionName}'`);
  }
  const mode: ControlPlaneAdvanceWorkerMode = options.drainConfirmations ? "confirmation_drain" : "advance_loop";
  if (mode === "confirmation_drain" && !options.confirm) {
    throw new Error("control-plane confirmation drain workers require --confirm");
  }
  const command = buildControlPlaneAdvanceWorkerCommand(sessionName, mode, options);
  const stdoutStartOffset = await fileSize(stdoutPath);
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
    const worker: ControlPlaneAdvanceWorker = {
      session: sessionName,
      workerId,
      mode,
      baseUrl,
      startedAt: new Date().toISOString(),
      command,
      pid: child.pid ?? null,
      stdoutPath,
      stderrPath,
      stdoutStartOffset,
      latestResult: null,
    };
    await fs.writeFile(recordPath, `${JSON.stringify(worker, null, 2)}\n`, { flag: "wx" });
    recordControlPlaneAdvanceWorkerCompletion(projectRoot, child, worker);
    const alive = processIsAlive(worker.pid);
    return { ...worker, alive, lifecycle: describeControlPlaneAdvanceWorkerLifecycle(worker, alive) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function listWorkerSessionControlPlaneAdvanceWorkers(
  projectRoot: string,
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean },
  lines: number,
): Promise<Array<ControlPlaneAdvanceWorker & { alive: boolean; lifecycle: ControlPlaneAdvanceWorkerLifecycle; latestResult: ControlPlaneAdvanceWorkerLatestResult | null; stdout: { path: string; lines: string[] }; stderr: { path: string; lines: string[] } }>> {
  const sessionNames = options.sessionName ? [options.sessionName] : await listControlPlaneAdvanceWorkerSessionNames(projectRoot);
  const workers = await Promise.all(sessionNames.map(async (sessionName) => {
    assertSafeWorkerSessionName(sessionName);
    try {
      const entries = await fs.readdir(controlPlaneAdvanceWorkerDir(projectRoot, sessionName), { withFileTypes: true });
      return await Promise.all(entries
        .filter((entry) => (
          entry.isFile()
          && entry.name.endsWith(".json")
          && (!options.workerId || entry.name === `${options.workerId}.json`)
        ))
        .map(async (entry) => {
          const worker = await readControlPlaneAdvanceWorker(projectRoot, sessionName, entry.name.replace(/\.json$/, ""));
          if (worker.retiredAt && !options.includeRetired) return null;
          const alive = processIsAlive(worker.pid);
          return {
            ...worker,
            alive,
            lifecycle: describeControlPlaneAdvanceWorkerLifecycle(worker, alive),
            latestResult: "latestResult" in worker ? worker.latestResult ?? null : await readLatestWorkerJsonResult(worker.stdoutPath, worker.stdoutStartOffset ?? 0),
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

export async function stopWorkerSessionControlPlaneAdvanceWorkers(
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
  workers: Awaited<ReturnType<typeof listWorkerSessionControlPlaneAdvanceWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  const workers = await listWorkerSessionControlPlaneAdvanceWorkers(projectRoot, {
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    includeRetired: true,
  }, 0);
  if (options.workerId && workers.length === 0) {
    throw new Error(`control-plane advance worker '${options.workerId}' not found for session '${sessionName}'`);
  }
  const stopped = [];
  for (const worker of workers) {
    const aliveBefore = processIsAlive(worker.pid);
    const result = await stopProcessGroup(worker.pid);
    const stoppedAt = new Date().toISOString();
    const updated: ControlPlaneAdvanceWorker = {
      ...worker,
      stoppedAt,
      stopResult: { ...result, aliveBefore },
      ...(options.retire ? { retiredAt: stoppedAt } : {}),
    };
    await writeControlPlaneAdvanceWorker(projectRoot, updated);
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
    workers: await listWorkerSessionControlPlaneAdvanceWorkers(projectRoot, {
      sessionName,
      ...(options.workerId ? { workerId: options.workerId } : {}),
      includeRetired: true,
    }, options.lines),
  };
}

export async function listWorkerSessionControlPlaneAdvanceWorkerNextSteps(
  projectRoot: string,
  sessionName: string,
): Promise<{
  session: string;
  count: number;
  nextSteps: ControlPlaneAdvanceWorkerNextStep[];
  actions: { restart_control_plane_advance_worker: number };
}> {
  assertSafeWorkerSessionName(sessionName);
  const workers = await listWorkerSessionControlPlaneAdvanceWorkers(projectRoot, { sessionName }, 1);
  const nextSteps = workers
    .filter((worker) => !worker.alive && Boolean(worker.stoppedAt))
    .map((worker): ControlPlaneAdvanceWorkerNextStep => {
      const restartControlPlaneAdvanceWorker = ["npm", "run", "cli", "--", "runs", "restart-control-plane-advance-workers", sessionName, "--server", "--worker-id", worker.workerId];
      const encodedSession = encodeURIComponent(sessionName);
      const encodedWorker = encodeURIComponent(worker.workerId);
      return {
        action: "restart_control_plane_advance_worker",
        reason: "stopped_control_plane_advance_worker",
        workerId: worker.workerId,
        mode: worker.mode ?? "advance_loop",
        pid: worker.pid,
        stoppedAt: worker.stoppedAt as string,
        command: restartControlPlaneAdvanceWorker,
        commands: {
          restartControlPlaneAdvanceWorker,
          inspectControlPlaneAdvanceWorkers: ["npm", "run", "cli", "--", "runs", "session-control-plane-advance-workers", sessionName, "--server", "--worker-id", worker.workerId],
          retireControlPlaneAdvanceWorker: ["npm", "run", "cli", "--", "runs", "stop-control-plane-advance-workers", sessionName, "--server", "--worker-id", worker.workerId, "--retire"],
        },
        api: {
          restart: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/control-plane-advance-workers/restart`,
            payload: { workerId: worker.workerId },
          },
          inspect: {
            method: "GET",
            url: `/api/worker-sessions/${encodedSession}/control-plane-advance-workers?workerId=${encodedWorker}`,
          },
          retire: {
            method: "POST",
            url: `/api/worker-sessions/${encodedSession}/control-plane-advance-workers/stop`,
            payload: { workerId: worker.workerId, retire: true },
          },
        },
      };
    });
  return {
    session: sessionName,
    count: nextSteps.length,
    nextSteps,
    actions: { restart_control_plane_advance_worker: nextSteps.length },
  };
}

export async function restartWorkerSessionControlPlaneAdvanceWorker(
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
  workers: Awaited<ReturnType<typeof listWorkerSessionControlPlaneAdvanceWorkers>>;
}> {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(options.workerId);
  let worker: ControlPlaneAdvanceWorker;
  try {
    worker = await readControlPlaneAdvanceWorker(projectRoot, sessionName, options.workerId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`control-plane advance worker '${options.workerId}' not found for session '${sessionName}'`);
    }
    throw error;
  }
  if (worker.retiredAt && !options.includeRetired) {
    throw new Error(`control-plane advance worker '${options.workerId}' is retired; pass includeRetired to restart it`);
  }
  if (processIsAlive(worker.pid)) {
    throw new Error(`control-plane advance worker '${options.workerId}' is already alive with pid ${worker.pid}`);
  }
  if (worker.session !== sessionName || worker.workerId !== options.workerId) {
    throw new Error(`control-plane advance worker record mismatch for '${options.workerId}'`);
  }
  const stdoutStartOffset = await fileSize(worker.stdoutPath);
  const stdout = await fs.open(worker.stdoutPath, "a");
  const stderr = await fs.open(worker.stderrPath, "a");
  try {
    const restartedAt = new Date().toISOString();
    const pendingRestart: ControlPlaneAdvanceWorker = {
      ...worker,
      baseUrl,
      startedAt: restartedAt,
      pid: null,
      stoppedAt: undefined,
      stopResult: undefined,
      retiredAt: undefined,
      completedAt: undefined,
      completionResult: undefined,
      stdoutStartOffset,
      latestResult: null,
      restartedAt,
      restartCount: (worker.restartCount ?? 0) + 1,
      previousPid: worker.pid,
    };
    await writeControlPlaneAdvanceWorker(projectRoot, pendingRestart);
    const child = spawn("npm", ["run", "--silent", "cli", "--", ...worker.command], {
      cwd: projectRoot,
      detached: true,
      env: { ...process.env, THREADBEAT_BASE_URL: baseUrl },
      stdio: ["ignore", stdout.fd, stderr.fd],
    });
    child.unref();
    const recordedWorker = await readControlPlaneAdvanceWorker(projectRoot, sessionName, options.workerId);
    const updated: ControlPlaneAdvanceWorker = {
      ...recordedWorker,
      pid: child.pid ?? null,
    };
    await writeControlPlaneAdvanceWorker(projectRoot, updated);
    recordControlPlaneAdvanceWorkerCompletion(projectRoot, child, updated);
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
      workers: await listWorkerSessionControlPlaneAdvanceWorkers(projectRoot, {
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

function recordControlPlaneAdvanceWorkerCompletion(projectRoot: string, child: ReturnType<typeof spawn>, worker: ControlPlaneAdvanceWorker): void {
  child.once("exit", (exitCode, signal) => {
    void (async () => {
      const current = await readControlPlaneAdvanceWorker(projectRoot, worker.session, worker.workerId).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!current || current.pid !== child.pid || current.stoppedAt || current.retiredAt) return;
      const latestResult = await readLatestWorkerJsonResult(current.stdoutPath, current.stdoutStartOffset ?? 0);
      await writeControlPlaneAdvanceWorker(projectRoot, {
        ...current,
        completedAt: new Date().toISOString(),
        completionResult: { exitCode, signal },
        latestResult,
      });
    })().catch((error) => {
      console.error(`failed to record control-plane advance worker completion: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

function describeControlPlaneAdvanceWorkerLifecycle(worker: ControlPlaneAdvanceWorker, alive: boolean): ControlPlaneAdvanceWorkerLifecycle {
  if (worker.retiredAt) {
    return { state: "retired", restartable: false, reason: "worker_retired" };
  }
  if (alive && worker.stoppedAt) {
    return { state: "stopping_failed", restartable: false, reason: "stop_recorded_but_process_alive" };
  }
  if (alive) {
    return { state: "running", restartable: false, reason: "worker_running" };
  }
  if (worker.stoppedAt) {
    return { state: "stopped", restartable: true, reason: "stopped_control_plane_advance_worker" };
  }
  if (worker.completedAt) {
    return { state: "completed", restartable: false, reason: "worker_completed" };
  }
  return { state: "exited_unrecorded", restartable: false, reason: "worker_exited_without_stop_or_completion_record" };
}

async function listControlPlaneAdvanceWorkerSessionNames(projectRoot: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(controlPlaneAdvanceWorkerRootDir(projectRoot), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readControlPlaneAdvanceWorker(projectRoot: string, sessionName: string, workerId: string): Promise<ControlPlaneAdvanceWorker> {
  const text = await fs.readFile(controlPlaneAdvanceWorkerPath(projectRoot, sessionName, workerId), "utf8");
  return JSON.parse(text) as ControlPlaneAdvanceWorker;
}

async function writeControlPlaneAdvanceWorker(projectRoot: string, worker: ControlPlaneAdvanceWorker): Promise<void> {
  await fs.writeFile(controlPlaneAdvanceWorkerPath(projectRoot, worker.session, worker.workerId), `${JSON.stringify(toStoredControlPlaneAdvanceWorker(worker), null, 2)}\n`);
}

function toStoredControlPlaneAdvanceWorker(worker: ControlPlaneAdvanceWorker): ControlPlaneAdvanceWorker {
  return {
    session: worker.session,
    workerId: worker.workerId,
    mode: worker.mode,
    baseUrl: worker.baseUrl,
    startedAt: worker.startedAt,
    command: worker.command,
    pid: worker.pid,
    stdoutPath: worker.stdoutPath,
    stderrPath: worker.stderrPath,
    ...(worker.stdoutStartOffset !== undefined ? { stdoutStartOffset: worker.stdoutStartOffset } : {}),
    ...(worker.stoppedAt !== undefined ? { stoppedAt: worker.stoppedAt } : {}),
    ...(worker.stopResult !== undefined ? { stopResult: worker.stopResult } : {}),
    ...(worker.retiredAt !== undefined ? { retiredAt: worker.retiredAt } : {}),
    ...(worker.restartedAt !== undefined ? { restartedAt: worker.restartedAt } : {}),
    ...(worker.restartCount !== undefined ? { restartCount: worker.restartCount } : {}),
    ...(worker.previousPid !== undefined ? { previousPid: worker.previousPid } : {}),
    ...(worker.completedAt !== undefined ? { completedAt: worker.completedAt } : {}),
    ...(worker.completionResult !== undefined ? { completionResult: worker.completionResult } : {}),
    ...(worker.latestResult !== undefined ? { latestResult: worker.latestResult } : {}),
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

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function readLatestWorkerJsonResult(filePath: string, startOffset: number): Promise<ControlPlaneAdvanceWorkerLatestResult | null> {
  let text: string;
  try {
    const buffer = await fs.readFile(filePath);
    if (startOffset >= buffer.length) return null;
    text = buffer.subarray(startOffset).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = parseLastJsonObject(text);
  if (!isRecord(parsed)) return null;
  return summarizeLatestWorkerJsonResult(parsed);
}

function parseLastJsonObject(text: string): unknown {
  const trimmed = text.trim();
  for (let index = trimmed.lastIndexOf("{"); index >= 0; index = trimmed.lastIndexOf("{", index - 1)) {
    try {
      return JSON.parse(trimmed.slice(index));
    } catch {
      // Keep scanning for the outer brace of the final pretty-printed JSON object.
    }
  }
  return null;
}

function summarizeLatestWorkerJsonResult(value: Record<string, unknown>): ControlPlaneAdvanceWorkerLatestResult {
  return {
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.session === "string" ? { session: value.session } : {}),
    ...(typeof value.dryRun === "boolean" ? { dryRun: value.dryRun } : {}),
    ...(typeof value.untilEmpty === "boolean" ? { untilEmpty: value.untilEmpty } : {}),
    ...(typeof value.stoppedReason === "string" ? { stoppedReason: value.stoppedReason } : {}),
    ...(typeof value.maxSteps === "number" ? { maxSteps: value.maxSteps } : {}),
    ...(typeof value.intervalMs === "number" ? { intervalMs: value.intervalMs } : {}),
    ...(typeof value.maxConfirmations === "number" ? { maxConfirmations: value.maxConfirmations } : {}),
    ...(typeof value.executedSteps === "number" ? { executedSteps: value.executedSteps } : {}),
    ...(typeof value.attemptedConfirmations === "number" ? { attemptedConfirmations: value.attemptedConfirmations } : {}),
    ...(typeof value.availableConfirmations === "number" ? { availableConfirmations: value.availableConfirmations } : {}),
    ...(Array.isArray(value.cycles) ? { cycles: value.cycles.length } : {}),
    ...(Array.isArray(value.results) ? { results: value.results.length } : {}),
    ...(typeof value.sourceAdvanceId === "string" ? { sourceAdvanceId: value.sourceAdvanceId } : {}),
    ...(typeof value.detailCommand === "string" ? { detailCommand: value.detailCommand } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function controlPlaneAdvanceWorkerRootDir(projectRoot: string): string {
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-advance-workers");
}

function controlPlaneAdvanceWorkerDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(controlPlaneAdvanceWorkerRootDir(projectRoot), sessionName);
}

function controlPlaneAdvanceWorkerPath(projectRoot: string, sessionName: string, workerId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(workerId);
  return path.join(controlPlaneAdvanceWorkerDir(projectRoot, sessionName), `${workerId}.json`);
}

function createControlPlaneAdvanceWorkerId(): string {
  return `control-plane-advance-worker-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 17)}`;
}

function buildControlPlaneAdvanceWorkerCommand(
  sessionName: string,
  mode: ControlPlaneAdvanceWorkerMode,
  options: {
    dryRun: boolean;
    maxSteps: number;
    intervalMs: number;
    lines: number;
    maxConfirmations?: number;
    untilEmpty?: boolean;
  },
): string[] {
  if (mode === "confirmation_drain") {
    return [
      "runs",
      "session-control-plane-advances",
      sessionName,
      "--server",
      "--drain-confirmations",
      "--confirm",
      "--max-confirmations",
      String(options.maxConfirmations ?? 3),
      ...(options.untilEmpty ? [
        "--until-empty",
        "--max-steps",
        String(options.maxSteps),
        "--interval-ms",
        String(options.intervalMs),
      ] : []),
      ...(options.dryRun ? ["--dry-run"] : []),
    ];
  }
  return [
    "runs",
    "session-control-plane-advance-loop",
    sessionName,
    "--server",
    "--max-steps",
    String(options.maxSteps),
    "--interval-ms",
    String(options.intervalMs),
    "--lines",
    String(options.lines),
    ...(options.dryRun ? ["--dry-run"] : []),
  ];
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("worker session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
