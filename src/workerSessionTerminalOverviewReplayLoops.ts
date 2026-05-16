import fs from "node:fs/promises";
import path from "node:path";

export type ControlPlaneTerminalOverviewReplayLoopRecord = {
  loopId: string;
  session: string;
  startedAt: string;
  completedAt: string;
  dryRun: boolean;
  confirmed: boolean;
  commandSurfaces: string[];
  actions: string[];
  maxSteps: number;
  stoppedReason: string;
  summary: {
    steps: number;
    supported: number;
    unsupported: number;
    executed: number;
    failed: number;
  };
  steps: Array<{
    sourceExecutionId: string;
    replayExecutionId: string;
    supported: boolean;
    unsupportedReason: string | null;
    command: string[] | null;
    exitCode: number | null;
  }>;
};

export type ControlPlaneTerminalOverviewReplayLoopListOptions = {
  limit?: number;
  loopIds?: string[];
  commandSurfaces?: string[];
  actions?: string[];
};

export type ControlPlaneTerminalOverviewReplayLoopSummary = {
  attempts: number;
  dryRun: number;
  confirmed: number;
  steps: number;
  supported: number;
  unsupported: number;
  executed: number;
  failed: number;
};

export async function listControlPlaneTerminalOverviewReplayLoopRecords(
  projectRoot: string,
  sessionName: string,
  options: ControlPlaneTerminalOverviewReplayLoopListOptions = {},
): Promise<ControlPlaneTerminalOverviewReplayLoopRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const loopDir = controlPlaneTerminalOverviewReplayLoopDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(loopDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(loopDir, entry.name), "utf8");
        return JSON.parse(text) as ControlPlaneTerminalOverviewReplayLoopRecord;
      }));
    return records
      .filter((record) => matchesReplayLoopFilters(record, options))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, options.limit ?? 20);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeControlPlaneTerminalOverviewReplayLoopRecords(
  records: ControlPlaneTerminalOverviewReplayLoopRecord[],
): ControlPlaneTerminalOverviewReplayLoopSummary {
  return {
    attempts: records.length,
    dryRun: records.filter((record) => record.dryRun).length,
    confirmed: records.filter((record) => record.confirmed).length,
    steps: records.reduce((sum, record) => sum + record.summary.steps, 0),
    supported: records.reduce((sum, record) => sum + record.summary.supported, 0),
    unsupported: records.reduce((sum, record) => sum + record.summary.unsupported, 0),
    executed: records.reduce((sum, record) => sum + record.summary.executed, 0),
    failed: records.reduce((sum, record) => sum + record.summary.failed, 0),
  };
}

export async function writeControlPlaneTerminalOverviewReplayLoopRecord(
  projectRoot: string,
  record: ControlPlaneTerminalOverviewReplayLoopRecord,
): Promise<{ path: string; record: ControlPlaneTerminalOverviewReplayLoopRecord }> {
  assertSafeWorkerSessionName(record.session);
  assertSafeWorkerSessionName(record.loopId);
  const loopPath = controlPlaneTerminalOverviewReplayLoopPath(projectRoot, record.session, record.loopId);
  await fs.mkdir(path.dirname(loopPath), { recursive: true });
  await fs.writeFile(loopPath, `${JSON.stringify(record, null, 2)}\n`);
  return { path: loopPath, record };
}

function matchesReplayLoopFilters(
  record: ControlPlaneTerminalOverviewReplayLoopRecord,
  options: ControlPlaneTerminalOverviewReplayLoopListOptions,
): boolean {
  if (options.loopIds && options.loopIds.length > 0 && !options.loopIds.includes(record.loopId)) return false;
  if (options.commandSurfaces && options.commandSurfaces.length > 0 && !intersectsOrMeansAll(record.commandSurfaces, options.commandSurfaces)) return false;
  if (options.actions && options.actions.length > 0 && !intersectsOrMeansAll(record.actions, options.actions)) return false;
  return true;
}

function intersectsOrMeansAll(recordValues: string[], requestedValues: string[]): boolean {
  if (recordValues.length === 0) return true;
  return recordValues.some((value) => requestedValues.includes(value));
}

function controlPlaneTerminalOverviewReplayLoopDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "terminal-overview-replay-loops", sessionName);
}

function controlPlaneTerminalOverviewReplayLoopPath(projectRoot: string, sessionName: string, loopId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(loopId);
  return path.join(controlPlaneTerminalOverviewReplayLoopDir(projectRoot, sessionName), `${loopId}.json`);
}

function assertSafeWorkerSessionName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`unsafe worker session name: ${name}`);
  }
}
