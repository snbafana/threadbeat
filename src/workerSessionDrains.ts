import fs from "node:fs/promises";
import path from "node:path";

type SessionApplyCommand = {
  action?: string;
  command: string[];
  scope?: string;
};

type SessionApplyExecution = {
  command: string[];
  exitCode: number | null;
};

type SessionApplyRecord = {
  session: string;
  applyId: string;
  source: string;
  filter: Record<string, unknown>;
  updatedAt: string;
  selected: number;
  commands: SessionApplyCommand[];
  executions: SessionApplyExecution[];
};

type WorkerSessionApplyDrain = {
  prefix: string;
  polls: number;
  applyIds: string[];
  latestApplyId: string;
  updatedAt: string;
  selected: number;
  succeeded: number;
  failed: number;
  pending: number;
  done: boolean;
  stoppedOnFailure: boolean;
  needsContinuation: boolean;
  nextApplyId: string;
  continueCommand: string[] | null;
};

export async function listWorkerSessionApplyRecords(projectRoot: string, sessionName: string): Promise<SessionApplyRecord[]> {
  assertSafeWorkerSessionName(sessionName);
  const applyDir = workerSessionApplyDir(projectRoot, sessionName);
  try {
    const entries = await fs.readdir(applyDir, { withFileTypes: true });
    const records = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => {
        const text = await fs.readFile(path.join(applyDir, entry.name), "utf8");
        return JSON.parse(text) as SessionApplyRecord;
      }));
    return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeWorkerSessionApplyDrains(records: SessionApplyRecord[]): {
  counts: {
    total: number;
    needsContinuation: number;
    done: number;
    stoppedOnFailure: number;
  };
  drains: WorkerSessionApplyDrain[];
} {
  const groups = new Map<string, Array<ReturnType<typeof summarizeApplyRecord> & { drainPoll: number }>>();
  for (const record of records) {
    if (record.source !== "watch") continue;
    const parts = sessionApplyDrainParts(record.applyId);
    if (!parts) continue;
    const entries = groups.get(parts.prefix) ?? [];
    entries.push({ ...summarizeApplyRecord(record), drainPoll: parts.poll });
    groups.set(parts.prefix, entries);
  }
  const drains = [...groups.entries()]
    .map(([prefix, entries]) => {
      const ordered = entries.sort((left, right) => left.drainPoll - right.drainPoll);
      const latest = ordered.reduce((left, right) => left.updatedAt >= right.updatedAt ? left : right);
      const lastPollEntry = ordered.at(-1) as ReturnType<typeof summarizeApplyRecord> & { drainPoll: number };
      const nextPoll = Math.max(...ordered.map((entry) => entry.drainPoll)) + 1;
      const done = ordered.some((entry) => entry.selected === 0);
      const stoppedOnFailure = ordered.some((entry) => entry.failed > 0);
      const continueCommand = done || stoppedOnFailure
        ? null
        : sessionApplyDrainContinueCommand(prefix, lastPollEntry);
      return {
        prefix,
        polls: ordered.length,
        applyIds: ordered.map((entry) => entry.applyId),
        latestApplyId: latest.applyId,
        updatedAt: latest.updatedAt,
        selected: ordered.reduce((sum, entry) => sum + entry.selected, 0),
        succeeded: ordered.reduce((sum, entry) => sum + entry.succeeded, 0),
        failed: ordered.reduce((sum, entry) => sum + entry.failed, 0),
        pending: ordered.reduce((sum, entry) => sum + entry.pending, 0),
        done,
        stoppedOnFailure,
        needsContinuation: continueCommand !== null,
        nextApplyId: `${prefix}-${String(nextPoll).padStart(3, "0")}`,
        continueCommand,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    counts: {
      total: drains.length,
      needsContinuation: drains.filter((drain) => drain.needsContinuation).length,
      done: drains.filter((drain) => drain.done).length,
      stoppedOnFailure: drains.filter((drain) => drain.stoppedOnFailure).length,
    },
    drains,
  };
}

function summarizeApplyRecord(record: SessionApplyRecord): {
  applyId: string;
  source: string;
  filter: Record<string, unknown>;
  updatedAt: string;
  selected: number;
  succeeded: number;
  failed: number;
  pending: number;
  resumeApply: string[];
} {
  const commandStates = sessionApplyCommandStates(record);
  return {
    applyId: record.applyId,
    source: record.source,
    filter: record.filter,
    updatedAt: record.updatedAt,
    selected: record.selected,
    succeeded: record.executions.filter((execution) => execution.exitCode === 0).length,
    failed: record.executions.filter((execution) => execution.exitCode !== 0).length,
    pending: record.commands.filter((command) => !commandStates.has(commandKey(command.command))).length,
    resumeApply: sessionApplyResumeCommand(record),
  };
}

function sessionApplyDrainParts(applyId: string): { prefix: string; poll: number } | null {
  const match = /^(.*)-(\d{3})$/.exec(applyId);
  if (!match) return null;
  return { prefix: match[1], poll: Number(match[2]) };
}

function sessionApplyDrainContinueCommand(
  prefix: string,
  latest: ReturnType<typeof summarizeApplyRecord>,
): string[] | null {
  if (latest.source !== "watch") return null;
  const applyIdIndex = latest.resumeApply.indexOf("--apply-id");
  if (applyIdIndex < 0) return null;
  const command = latest.resumeApply.slice(0, applyIdIndex);
  if (!command.includes("--action") && !command.includes("--branch-action")) return null;
  if (latest.filter.includeStopped === true) command.push("--include-stopped");
  const status = stringListFromUnknown(latest.filter.status);
  if (status.length > 0) command.push("--status", status.join(","));
  const run = stringListFromUnknown(latest.filter.run);
  if (run.length > 0) command.push("--run", run.join(","));
  if (typeof latest.filter.limit === "string" || typeof latest.filter.limit === "number") {
    command.push("--limit", String(latest.filter.limit));
  }
  if (typeof latest.filter.checkoutDir === "string") command.push("--checkout-dir", latest.filter.checkoutDir);
  if (latest.filter.changedOnly === true) command.push("--changed-only");
  const changedPath = stringListFromUnknown(latest.filter.changedPath);
  if (changedPath.length > 0) command.push("--changed-path", changedPath.join(","));
  command.push("--continue-prefix", prefix, "--until-empty");
  return command;
}

function sessionApplyResumeCommand(record: SessionApplyRecord): string[] {
  const command = ["npm", "run", "cli", "--", "runs", "session-apply", record.session];
  if (record.source && record.source !== "review") command.push("--source", record.source);
  const branchAction = stringListFromUnknown(record.filter.branchAction);
  const action = stringListFromUnknown(record.filter.action);
  const fallbackActions = [...new Set(record.commands.map((item) => item.action).filter(Boolean))] as string[];
  const hasBranchCommands = record.commands.some((item) => item.scope === "branch");
  if (branchAction.length > 0) {
    command.push("--branch-action", branchAction.join(","));
  } else if (action.length > 0) {
    command.push("--action", action.join(","));
  } else if (hasBranchCommands && fallbackActions.length > 0) {
    command.push("--branch-action", fallbackActions.join(","));
  } else if (fallbackActions.length > 0) {
    command.push("--action", fallbackActions.join(","));
  }
  command.push("--apply-id", record.applyId, "--resume");
  return command;
}

function sessionApplyCommandStates(record: SessionApplyRecord): Map<string, { succeeded: boolean; failed: boolean }> {
  const states = new Map<string, { succeeded: boolean; failed: boolean }>();
  for (const execution of record.executions ?? []) {
    const key = commandKey(execution.command);
    const state = states.get(key) ?? { succeeded: false, failed: false };
    if (execution.exitCode === 0) state.succeeded = true;
    else state.failed = true;
    states.set(key, state);
  }
  return states;
}

function commandKey(command: string[]): string {
  return JSON.stringify(command);
}

function stringListFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function workerSessionApplyDir(projectRoot: string, sessionName: string): string {
  assertSafeWorkerSessionName(sessionName);
  return path.join(projectRoot, ".threadbeat", "worker-sessions", "apply", sessionName);
}

function assertSafeWorkerSessionName(value: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("session names may only contain letters, numbers, '.', '_', and '-'");
  }
}
