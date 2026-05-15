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
  recentProgress?: ControlPlaneAdvanceWorkerLatestResult[];
};

export type ControlPlaneAdvanceWorkerMode = "advance_loop" | "confirmation_drain" | "topology_loop" | "result_review_loop" | "bundle_recovery_loop" | "operator_loop";
export type ControlPlaneAdvanceWorkerLatestResultSource = "recorded" | "stdout" | "none";

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
  observedAt?: string;
  dryRun?: boolean;
  untilEmpty?: boolean;
  stoppedReason?: string;
  maxSteps?: number;
  intervalMs?: number;
  maxConfirmations?: number;
  maxResults?: number;
  maxPolls?: number;
  maxIterations?: number;
  loopIntervalMs?: number;
  profileCount?: number;
  planned?: number;
  actionable?: number;
  blocked?: number;
  executed?: number;
  polls?: number;
  iterations?: number;
  executedSteps?: number;
  attemptedConfirmations?: number;
  availableConfirmations?: number;
  processed?: number;
  remainingPending?: number;
  totalCoreExecuted?: number;
  totalMutationExecuted?: number;
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
  reason: "stopped_control_plane_advance_worker" | "worker_exited_without_stop_or_completion_record";
  workerId: string;
  mode: ControlPlaneAdvanceWorkerMode;
  pid: number | null;
  stoppedAt?: string;
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
    topologyLoop?: boolean;
    includeMutationWorkers?: boolean;
    resultReview?: boolean;
    bundleRecovery?: boolean;
    reviewAction?: "reviewed" | "skipped";
    maxResults?: number;
    maxPolls?: number;
    reviewedBy?: string;
    note?: string;
    maxIterations?: number;
    loopIntervalMs?: number;
    operatorLoop?: boolean;
    maxCycles?: number;
    cycleIntervalMs?: number;
    reconcileWorkers?: boolean;
    includeRetired?: boolean;
    limit?: number | null;
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
  const mode: ControlPlaneAdvanceWorkerMode = options.operatorLoop ? "operator_loop" : options.bundleRecovery ? "bundle_recovery_loop" : options.resultReview ? "result_review_loop" : options.topologyLoop ? "topology_loop" : options.drainConfirmations ? "confirmation_drain" : "advance_loop";
  if (mode === "confirmation_drain" && !options.confirm) {
    throw new Error("control-plane confirmation drain workers require --confirm");
  }
  if (mode === "topology_loop" && options.dryRun === Boolean(options.confirm)) {
    throw new Error("control-plane topology workers require exactly one of dryRun or confirm");
  }
  if (mode === "result_review_loop" && !options.reviewAction) {
    throw new Error("control-plane result review workers require a review action");
  }
  if (mode === "operator_loop" && options.dryRun === Boolean(options.confirm)) {
    throw new Error("control-plane operator workers require exactly one of dryRun or confirm");
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
    const recordReady = fs.writeFile(recordPath, `${JSON.stringify(worker, null, 2)}\n`, { flag: "wx" });
    recordControlPlaneAdvanceWorkerCompletion(projectRoot, child, worker, recordReady);
    await recordReady;
    const alive = processIsAlive(worker.pid);
    return { ...worker, alive, lifecycle: describeControlPlaneAdvanceWorkerLifecycle(worker, alive) };
  } finally {
    await stdout.close();
    await stderr.close();
  }
}

export async function listWorkerSessionControlPlaneAdvanceWorkers(
  projectRoot: string,
  options: { sessionName?: string; workerId?: string; includeRetired?: boolean; mode?: ControlPlaneAdvanceWorkerMode },
  lines: number,
): Promise<Array<ControlPlaneAdvanceWorker & {
  alive: boolean;
  lifecycle: ControlPlaneAdvanceWorkerLifecycle;
  latestResult: ControlPlaneAdvanceWorkerLatestResult | null;
  latestProgress: ControlPlaneAdvanceWorkerLatestResult | null;
  recentProgress: ControlPlaneAdvanceWorkerLatestResult[];
  latestResultSource: ControlPlaneAdvanceWorkerLatestResultSource;
  stdout: { path: string; lines: string[] };
  stderr: { path: string; lines: string[] };
}>> {
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
          if (options.mode && (worker.mode ?? "advance_loop") !== options.mode) return null;
          let currentWorker = worker;
          const alive = processIsAlive(worker.pid);
          const recentStdoutResults = await readRecentWorkerJsonResults(worker.stdoutPath, worker.stdoutStartOffset ?? 0, 10);
          const latestStdoutResult = recentStdoutResults.at(-1) ?? null;
          const recentProgress = mergeRecentProgress(worker.recentProgress, recentStdoutResults.filter((result) => result.stoppedReason === "running"), 5);
          if (!sameRecentProgress(worker.recentProgress, recentProgress)) {
            currentWorker = await recordControlPlaneAdvanceWorkerRecentProgress(projectRoot, worker, recentProgress);
          }
          const latestProgress = currentWorker.latestResult ? null : latestStdoutResult;
          const latestResult = currentWorker.latestResult ?? latestProgress;
          const latestResultSource: ControlPlaneAdvanceWorkerLatestResultSource = currentWorker.latestResult ? "recorded" : latestProgress ? "stdout" : "none";
          return {
            ...currentWorker,
            alive,
            lifecycle: describeControlPlaneAdvanceWorkerLifecycle(currentWorker, alive),
            latestResult,
            latestProgress,
            recentProgress: currentWorker.recentProgress ?? recentProgress,
            latestResultSource,
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
  options: { workerId?: string; retire: boolean; lines: number; mode?: ControlPlaneAdvanceWorkerMode },
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
    ...(options.mode ? { mode: options.mode } : {}),
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
      ...(options.mode ? { mode: options.mode } : {}),
    }, options.lines),
  };
}

export async function listWorkerSessionControlPlaneAdvanceWorkerNextSteps(
  projectRoot: string,
  sessionName: string,
  options: { workerId?: string; mode?: ControlPlaneAdvanceWorkerMode } = {},
): Promise<{
  session: string;
  count: number;
  nextSteps: ControlPlaneAdvanceWorkerNextStep[];
  actions: { restart_control_plane_advance_worker: number };
}> {
  assertSafeWorkerSessionName(sessionName);
  if (options.workerId) assertSafeWorkerSessionName(options.workerId);
  const workers = await listWorkerSessionControlPlaneAdvanceWorkers(projectRoot, {
    sessionName,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  }, 1);
  const nextSteps = workers
    .filter((worker) => worker.lifecycle.restartable)
    .map((worker): ControlPlaneAdvanceWorkerNextStep => {
      const mode = worker.mode ?? "advance_loop";
      const restartCommandName = mode === "topology_loop"
        ? "restart-control-plane-topology-worker"
        : mode === "result_review_loop"
          ? "restart-control-plane-result-review-worker"
          : mode === "bundle_recovery_loop"
            ? "restart-control-plane-worker-bundle-recovery-worker"
            : mode === "operator_loop"
              ? "restart-control-plane-operator-worker"
              : "restart-control-plane-advance-workers";
      const inspectCommandName = mode === "topology_loop"
        ? "session-control-plane-topology-workers"
        : mode === "result_review_loop"
          ? "session-control-plane-result-review-workers"
          : mode === "bundle_recovery_loop"
            ? "session-control-plane-worker-bundle-recovery-workers"
            : mode === "operator_loop"
              ? "session-control-plane-operator-workers"
              : "session-control-plane-advance-workers";
      const stopCommandName = mode === "topology_loop"
        ? "stop-control-plane-topology-worker"
        : mode === "result_review_loop"
          ? "stop-control-plane-result-review-worker"
          : mode === "bundle_recovery_loop"
            ? "stop-control-plane-worker-bundle-recovery-worker"
            : mode === "operator_loop"
              ? "stop-control-plane-operator-worker"
              : "stop-control-plane-advance-workers";
      const restartControlPlaneAdvanceWorker = ["npm", "run", "cli", "--", "runs", restartCommandName, sessionName, "--server", "--worker-id", worker.workerId];
      const encodedSession = encodeURIComponent(sessionName);
      const encodedWorker = encodeURIComponent(worker.workerId);
      return {
        action: "restart_control_plane_advance_worker",
        reason: worker.lifecycle.reason === "worker_exited_without_stop_or_completion_record"
          ? "worker_exited_without_stop_or_completion_record"
          : "stopped_control_plane_advance_worker",
        workerId: worker.workerId,
        mode,
        pid: worker.pid,
        ...(worker.stoppedAt ? { stoppedAt: worker.stoppedAt } : {}),
        command: restartControlPlaneAdvanceWorker,
        commands: {
          restartControlPlaneAdvanceWorker,
          inspectControlPlaneAdvanceWorkers: ["npm", "run", "cli", "--", "runs", inspectCommandName, sessionName, "--server", "--worker-id", worker.workerId],
          retireControlPlaneAdvanceWorker: ["npm", "run", "cli", "--", "runs", stopCommandName, sessionName, "--server", "--worker-id", worker.workerId, "--retire"],
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
  options: { workerId: string; includeRetired: boolean; lines: number; mode?: ControlPlaneAdvanceWorkerMode },
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
  if (options.mode && (worker.mode ?? "advance_loop") !== options.mode) {
    throw new Error(`control-plane advance worker '${options.workerId}' is mode '${worker.mode ?? "advance_loop"}', not '${options.mode}'`);
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
    const updated: ControlPlaneAdvanceWorker = {
      ...pendingRestart,
      pid: child.pid ?? null,
    };
    const recordReady = writeControlPlaneAdvanceWorker(projectRoot, updated);
    recordControlPlaneAdvanceWorkerCompletion(projectRoot, child, updated, recordReady);
    await recordReady;
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

function recordControlPlaneAdvanceWorkerCompletion(
  projectRoot: string,
  child: ReturnType<typeof spawn>,
  worker: ControlPlaneAdvanceWorker,
  recordReady: Promise<void>,
): void {
  child.once("exit", (exitCode, signal) => {
    void (async () => {
      await recordReady;
      const current = await readControlPlaneAdvanceWorker(projectRoot, worker.session, worker.workerId).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!current || current.pid !== child.pid || current.stoppedAt || current.retiredAt) return;
      const recentStdoutResults = await readRecentWorkerJsonResults(current.stdoutPath, current.stdoutStartOffset ?? 0, 10);
      const latestResult = recentStdoutResults.at(-1) ?? null;
      const recentProgress = mergeRecentProgress(current.recentProgress, recentStdoutResults.filter((result) => result.stoppedReason === "running"), 5);
      await writeControlPlaneAdvanceWorker(projectRoot, {
        ...current,
        completedAt: new Date().toISOString(),
        completionResult: { exitCode, signal },
        latestResult,
        recentProgress,
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
  return { state: "exited_unrecorded", restartable: true, reason: "worker_exited_without_stop_or_completion_record" };
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
    ...(worker.recentProgress !== undefined ? { recentProgress: worker.recentProgress } : {}),
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

async function recordControlPlaneAdvanceWorkerRecentProgress(
  projectRoot: string,
  worker: ControlPlaneAdvanceWorker,
  recentProgress: ControlPlaneAdvanceWorkerLatestResult[],
): Promise<ControlPlaneAdvanceWorker> {
  const current = await readControlPlaneAdvanceWorker(projectRoot, worker.session, worker.workerId).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return worker;
    throw error;
  });
  const merged = mergeRecentProgress(current.recentProgress, recentProgress, 5);
  if (sameRecentProgress(current.recentProgress, merged)) return current;
  const updated = { ...current, recentProgress: merged };
  await writeControlPlaneAdvanceWorker(projectRoot, updated);
  return updated;
}

function mergeRecentProgress(
  stored: ControlPlaneAdvanceWorkerLatestResult[] | undefined,
  observed: ControlPlaneAdvanceWorkerLatestResult[],
  limit: number,
): ControlPlaneAdvanceWorkerLatestResult[] {
  const merged: ControlPlaneAdvanceWorkerLatestResult[] = [];
  for (const item of [...(stored ?? []), ...observed]) {
    if (!merged.some((candidate) => JSON.stringify(candidate) === JSON.stringify(item))) {
      merged.push(item);
    }
  }
  return merged.slice(-limit);
}

function sameRecentProgress(
  left: ControlPlaneAdvanceWorkerLatestResult[] | undefined,
  right: ControlPlaneAdvanceWorkerLatestResult[],
): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right);
}

async function readRecentWorkerJsonResults(filePath: string, startOffset: number, limit: number): Promise<ControlPlaneAdvanceWorkerLatestResult[]> {
  if (limit <= 0) return [];
  let text: string;
  try {
    const buffer = await fs.readFile(filePath);
    if (startOffset >= buffer.length) return [];
    text = buffer.subarray(startOffset).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseJsonObjects(text)
    .filter(isRecord)
    .map(summarizeLatestWorkerJsonResult)
    .slice(-limit);
}

function parseJsonObjects(text: string): unknown[] {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // Ignore incomplete or non-JSON fragments in worker stdout.
        }
        start = -1;
      }
    }
  }
  return values;
}

function summarizeLatestWorkerJsonResult(value: Record<string, unknown>): ControlPlaneAdvanceWorkerLatestResult {
  const summary = isRecord(value.summary) ? value.summary : null;
  return {
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(typeof value.session === "string" ? { session: value.session } : {}),
    ...(typeof value.observedAt === "string" ? { observedAt: value.observedAt } : {}),
    ...(typeof value.dryRun === "boolean" ? { dryRun: value.dryRun } : {}),
    ...(typeof value.untilEmpty === "boolean" ? { untilEmpty: value.untilEmpty } : {}),
    ...(typeof value.stoppedReason === "string" ? { stoppedReason: value.stoppedReason } : {}),
    ...(typeof value.maxSteps === "number" ? { maxSteps: value.maxSteps } : {}),
    ...(typeof value.intervalMs === "number" ? { intervalMs: value.intervalMs } : {}),
    ...(typeof value.maxConfirmations === "number" ? { maxConfirmations: value.maxConfirmations } : {}),
    ...(typeof value.maxResults === "number" ? { maxResults: value.maxResults } : {}),
    ...(typeof value.maxPolls === "number" ? { maxPolls: value.maxPolls } : {}),
    ...(typeof value.maxIterations === "number" ? { maxIterations: value.maxIterations } : {}),
    ...(typeof value.loopIntervalMs === "number" ? { loopIntervalMs: value.loopIntervalMs } : {}),
    ...(typeof summary?.iterations === "number" ? { iterations: summary.iterations } : {}),
    ...(typeof summary?.profileCount === "number" ? { profileCount: summary.profileCount } : {}),
    ...(typeof summary?.planned === "number" ? { planned: summary.planned } : {}),
    ...(typeof summary?.actionable === "number" ? { actionable: summary.actionable } : {}),
    ...(typeof summary?.blocked === "number" ? { blocked: summary.blocked } : {}),
    ...(typeof summary?.executed === "number" ? { executed: summary.executed } : {}),
    ...(typeof summary?.polls === "number" ? { polls: summary.polls } : {}),
    ...(typeof value.executedSteps === "number" ? { executedSteps: value.executedSteps } : {}),
    ...(typeof value.attemptedConfirmations === "number" ? { attemptedConfirmations: value.attemptedConfirmations } : {}),
    ...(typeof value.availableConfirmations === "number" ? { availableConfirmations: value.availableConfirmations } : {}),
    ...(typeof value.processed === "number" ? { processed: value.processed } : {}),
    ...(typeof value.remainingPending === "number" ? { remainingPending: value.remainingPending } : {}),
    ...(typeof summary?.totalCoreExecuted === "number" ? { totalCoreExecuted: summary.totalCoreExecuted } : {}),
    ...(typeof summary?.totalMutationExecuted === "number" ? { totalMutationExecuted: summary.totalMutationExecuted } : {}),
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
    confirm?: boolean;
    includeMutationWorkers?: boolean;
    resultReview?: boolean;
    bundleRecovery?: boolean;
    reviewAction?: "reviewed" | "skipped";
    maxResults?: number;
    maxPolls?: number;
    reviewedBy?: string;
    note?: string;
    maxIterations?: number;
    loopIntervalMs?: number;
    maxCycles?: number;
    cycleIntervalMs?: number;
    reconcileWorkers?: boolean;
    includeRetired?: boolean;
    limit?: number | null;
  },
): string[] {
  if (mode === "operator_loop") {
    return [
      "runs",
      "session-control-plane-operate",
      sessionName,
      "--server",
      options.confirm ? "--confirm" : "--dry-run",
      "--max-cycles",
      String(options.maxCycles ?? options.maxSteps),
      "--cycle-interval-ms",
      String(options.cycleIntervalMs ?? options.intervalMs),
      "--lines",
      String(options.lines),
      ...(options.reconcileWorkers ? ["--reconcile-workers"] : []),
      ...(options.includeRetired ? ["--include-retired"] : []),
      ...(options.limit !== undefined && options.limit !== null ? ["--limit", String(options.limit)] : []),
      ...(options.untilEmpty ? [
        "--until-empty",
        "--max-steps",
        String(options.maxSteps),
        "--interval-ms",
        String(options.intervalMs),
      ] : []),
    ];
  }
  if (mode === "result_review_loop") {
    return [
      "runs",
      "session-result-review-next",
      sessionName,
      "--server",
      options.reviewAction === "skipped" ? "--record-skipped" : "--record-reviewed",
      "--until-empty",
      "--max-results",
      String(options.maxResults ?? options.maxSteps),
      "--interval-ms",
      String(options.intervalMs),
      ...(options.dryRun ? ["--dry-run"] : []),
      ...(options.reviewedBy ? ["--reviewed-by", options.reviewedBy] : []),
      ...(options.note ? ["--note", options.note] : []),
    ];
  }
  if (mode === "bundle_recovery_loop") {
    return [
      "runs",
      "recover-control-plane-worker-bundles",
      "--server",
      "--session",
      sessionName,
      "--loop",
      "--max-polls",
      String(options.maxPolls ?? options.maxSteps),
      "--interval-ms",
      String(options.intervalMs),
      "--lines",
      String(options.lines),
      "--progress-json",
      options.confirm ? "--confirm" : "--dry-run",
    ];
  }
  if (mode === "topology_loop") {
    return [
      "runs",
      "ensure-control-plane-topology-loop",
      sessionName,
      "--server",
      options.confirm ? "--confirm" : "--dry-run",
      "--max-iterations",
      String(options.maxIterations ?? options.maxSteps),
      "--loop-interval-ms",
      String(options.loopIntervalMs ?? options.intervalMs),
      "--lines",
      String(options.lines),
      "--progress-json",
      ...(options.includeMutationWorkers ? ["--include-mutation-workers"] : []),
    ];
  }
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
