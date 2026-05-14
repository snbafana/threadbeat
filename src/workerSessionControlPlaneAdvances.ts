import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type WorkerSessionControlPlaneAdvanceRecord = {
  advanceId: string;
  session: string;
  observedAt: string;
  completedAt: string;
  dryRun: boolean;
  selected: unknown | null;
  alert?: unknown | null;
  details?: unknown | null;
  detailCommand?: string;
  recovery?: unknown;
  filter?: unknown;
  executed: unknown | null;
  executionSafety?: unknown;
  before: unknown;
  after: unknown;
};

export type WorkerSessionControlPlaneAdvanceListOptions = {
  limit?: number;
  advanceIds?: string[];
  blocked?: boolean;
  mutating?: boolean;
  alertSurfaces?: string[];
  selectedSurfaces?: string[];
  selectedActions?: string[];
  detailCommands?: string[];
  loopAdvanceIds?: string[];
};

export type WorkerSessionControlPlaneAdvanceSummary = {
  total: number;
  dryRun: number;
  executed: number;
  failed: number;
  blocked: number;
  mutating: number;
};

export async function listWorkerSessionControlPlaneAdvanceRecords(
  projectRoot: string,
  sessionName: string,
  options: WorkerSessionControlPlaneAdvanceListOptions = {},
): Promise<WorkerSessionControlPlaneAdvanceRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const advanceDir = workerSessionControlPlaneAdvanceDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(advanceDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(advanceDir, entry.name), "utf8");
        return JSON.parse(text) as WorkerSessionControlPlaneAdvanceRecord;
      }));
    return records
      .filter((record) => matchesWorkerSessionControlPlaneAdvanceFilters(record, options))
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, options.limit ?? 20);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeWorkerSessionControlPlaneAdvanceRecords(
  records: WorkerSessionControlPlaneAdvanceRecord[],
): WorkerSessionControlPlaneAdvanceSummary {
  return {
    total: records.length,
    dryRun: records.filter((record) => record.dryRun).length,
    executed: records.filter((record) => Boolean(record.executed)).length,
    failed: records.filter((record) => hasFailedExecution(record)).length,
    blocked: records.filter((record) => executionSafetyBoolean(record, "blocked") === true).length,
    mutating: records.filter((record) => executionSafetyBoolean(record, "mutating") === true).length,
  };
}

export async function writeWorkerSessionControlPlaneAdvanceRecord(
  projectRoot: string,
  record: Omit<WorkerSessionControlPlaneAdvanceRecord, "advanceId"> & { advanceId?: string },
): Promise<{ path: string; record: WorkerSessionControlPlaneAdvanceRecord }> {
  assertSafeWorkerSessionName(record.session);
  const advanceRecord: WorkerSessionControlPlaneAdvanceRecord = {
    ...record,
    advanceId: record.advanceId ?? createControlPlaneAdvanceId(record.observedAt),
  };
  assertSafeWorkerSessionName(advanceRecord.advanceId);
  const advancePath = workerSessionControlPlaneAdvancePath(projectRoot, advanceRecord.session, advanceRecord.advanceId);
  await fs.mkdir(path.dirname(advancePath), { recursive: true });
  await fs.writeFile(advancePath, `${JSON.stringify(advanceRecord, null, 2)}\n`);
  return { path: advancePath, record: advanceRecord };
}

function workerSessionControlPlaneAdvanceDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "control-plane-advances", sessionName);
}

function workerSessionControlPlaneAdvancePath(projectRoot: string, sessionName: string, advanceId: string): string {
  assertSafeWorkerSessionName(sessionName);
  assertSafeWorkerSessionName(advanceId);
  return path.join(workerSessionControlPlaneAdvanceDir(projectRoot, sessionName), `${advanceId}.json`);
}

function createControlPlaneAdvanceId(observedAt: string): string {
  return `${observedAt.replace(/[^0-9A-Za-z]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
}

function matchesWorkerSessionControlPlaneAdvanceFilters(
  record: WorkerSessionControlPlaneAdvanceRecord,
  options: WorkerSessionControlPlaneAdvanceListOptions,
): boolean {
  if (options.advanceIds && options.advanceIds.length > 0 && !options.advanceIds.includes(record.advanceId)) return false;
  if (options.blocked !== undefined && executionSafetyBoolean(record, "blocked") !== options.blocked) return false;
  if (options.mutating !== undefined && executionSafetyBoolean(record, "mutating") !== options.mutating) return false;
  if (options.alertSurfaces && options.alertSurfaces.length > 0 && !options.alertSurfaces.includes(alertSurface(record))) return false;
  if (options.selectedSurfaces && options.selectedSurfaces.length > 0 && !options.selectedSurfaces.includes(selectedString(record, "surface"))) return false;
  if (options.selectedActions && options.selectedActions.length > 0 && !options.selectedActions.includes(selectedString(record, "action"))) return false;
  if (options.detailCommands && options.detailCommands.length > 0 && !options.detailCommands.includes(record.detailCommand ?? "")) return false;
  if (options.loopAdvanceIds && options.loopAdvanceIds.length > 0 && !options.loopAdvanceIds.includes(loopAdvanceId(record) ?? "")) return false;
  return true;
}

function alertSurface(record: WorkerSessionControlPlaneAdvanceRecord): string {
  const alert = record.alert;
  if (!alert || typeof alert !== "object" || Array.isArray(alert)) return "";
  const surface = (alert as Record<string, unknown>).surface;
  return typeof surface === "string" ? surface : "";
}

function selectedString(record: WorkerSessionControlPlaneAdvanceRecord, key: string): string {
  const selected = record.selected;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return "";
  const value = (selected as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function loopAdvanceId(record: WorkerSessionControlPlaneAdvanceRecord): string | null {
  return recordLoopAdvanceId(record.selected) ?? recordLoopAdvanceId(record.alert) ?? recordLoopAdvanceId(record.recovery);
}

function recordLoopAdvanceId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const loopAdvanceId = (value as Record<string, unknown>).loopAdvanceId;
  return typeof loopAdvanceId === "string" ? loopAdvanceId : null;
}

function executionSafetyBoolean(
  record: WorkerSessionControlPlaneAdvanceRecord,
  key: "blocked" | "mutating",
): boolean | undefined {
  const safety = record.executionSafety;
  if (!safety || typeof safety !== "object" || Array.isArray(safety)) return undefined;
  const value = (safety as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function hasFailedExecution(record: WorkerSessionControlPlaneAdvanceRecord): boolean {
  const executed = record.executed;
  if (!executed || typeof executed !== "object" || Array.isArray(executed)) return false;
  const exitCode = (executed as Record<string, unknown>).exitCode;
  return typeof exitCode === "number" && exitCode !== 0;
}

function assertSafeWorkerSessionName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`unsafe worker session name: ${name}`);
  }
}
