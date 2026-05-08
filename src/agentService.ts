export type AgentStatus = "active" | "inactive" | "archived";

export type AgentRecord = {
  id: string;
  name: string;
  repoUrl: string;
  currentVersion: string;
  status: AgentStatus;
};

export type CreateAgentInput = {
  name: string;
  repoUrl: string;
  initialVersion: string;
};

export type AgentRunKind = "run" | "edit";

export type AgentRunPlan = {
  kind: AgentRunKind;
  objective: string;
  inputBranch: string;
  runBranch: string;
  outputBranch?: string;
};

export type AgentBranchMetadata = {
  timestamp: string;
  objectiveSlug: string;
  runId: string;
};

export type PlannedAgentRun = AgentRunPlan & {
  metadata: AgentBranchMetadata;
};

export type PlanRunBranchInput = {
  currentVersion: string;
  objective: string;
  runId: string;
  now: Date | string;
};

export type PlanEditBranchInput = {
  fromVersion: string;
  toVersion: string;
  objective: string;
  runId: string;
  now: Date | string;
};

export type RunAgentInput = {
  agentId: string;
  objective: string;
  runId: string;
  now?: Date | string;
};

export type PromoteRunInput = {
  agentId: string;
  runId: string;
  toVersion: string;
};

export type StreamEventsInput = {
  agentId: string;
  runId?: string;
};

export type AgentServiceEvent = {
  type: string;
  message?: string;
  data?: Record<string, unknown>;
  createdAt: string;
};

/**
 * Thin contract for the local agent orchestrator.
 *
 * Implementations should compose persistence, Git storage, template rendering,
 * and execution behind this interface. This file intentionally has no DB or Git
 * dependency so parallel workers can wire concrete modules later without making
 * the shared planning contract depend on their exact names.
 */
export interface AgentService {
  createAgent(input: CreateAgentInput): Promise<AgentRecord>;
  runAgent(input: RunAgentInput): Promise<PlannedAgentRun>;
  promoteRun(input: PromoteRunInput): Promise<AgentRecord>;
  streamEvents(input: StreamEventsInput): AsyncIterable<AgentServiceEvent>;
}

export const planRunBranch = ({
  currentVersion,
  objective,
  runId,
  now,
}: PlanRunBranchInput): PlannedAgentRun => {
  const version = validateAgentVersionName(currentVersion);
  const metadata = planMetadata({ objective, runId, now });
  const runBranch = validateBranchName(
    `threadbeat/runs/${version}/${metadata.timestamp}-${metadata.runId}-${metadata.objectiveSlug}`,
  );

  return {
    kind: "run",
    objective: normalizeObjective(objective),
    inputBranch: versionBranch(version),
    runBranch,
    metadata,
  };
};

export const planEditBranch = ({
  fromVersion,
  toVersion,
  objective,
  runId,
  now,
}: PlanEditBranchInput): PlannedAgentRun => {
  const sourceVersion = validateAgentVersionName(fromVersion);
  const targetVersion = validateAgentVersionName(toVersion);
  const metadata = planMetadata({ objective, runId, now });
  const runBranch = validateBranchName(
    `threadbeat/edits/${sourceVersion}-to-${targetVersion}/${metadata.timestamp}-${metadata.runId}-${metadata.objectiveSlug}`,
  );

  return {
    kind: "edit",
    objective: normalizeObjective(objective),
    inputBranch: versionBranch(sourceVersion),
    runBranch,
    outputBranch: versionBranch(targetVersion),
    metadata,
  };
};

export const versionBranch = (version: string): string => (
  validateBranchName(`threadbeat/versions/${validateAgentVersionName(version)}`)
);

export const isValidBranchName = (branchName: string): boolean => {
  if (typeof branchName !== "string") return false;
  if (branchName.length === 0 || branchName.length > 250) return false;
  if (branchName === "@" || branchName.startsWith("-")) return false;
  if (branchName.startsWith("/") || branchName.endsWith("/")) return false;
  if (branchName.endsWith(".") || branchName.includes("//")) return false;
  if (branchName.includes("..") || branchName.includes("@{")) return false;
  if (hasInvalidBranchCharacter(branchName)) return false;

  return branchName
    .split("/")
    .every((component) => (
      component.length > 0
      && !component.startsWith(".")
      && !component.endsWith(".lock")
    ));
};

export const validateBranchName = (branchName: string): string => {
  if (!isValidBranchName(branchName)) {
    throw new Error(`invalid branch name: ${branchName}`);
  }
  return branchName;
};

export const isValidAgentVersionName = (versionName: string): boolean => (
  typeof versionName === "string"
  && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(versionName)
  && !versionName.endsWith(".")
  && !versionName.includes("..")
  && !versionName.includes("@{")
  && !versionName.endsWith(".lock")
);

export const validateAgentVersionName = (versionName: string): string => {
  if (!isValidAgentVersionName(versionName)) {
    throw new Error(`invalid agent version name: ${versionName}`);
  }
  return versionName;
};

const planMetadata = ({
  objective,
  runId,
  now,
}: {
  objective: string;
  runId: string;
  now: Date | string;
}): AgentBranchMetadata => ({
  timestamp: formatBranchTimestamp(now),
  objectiveSlug: slugify(normalizeObjective(objective), "objective"),
  runId: slugify(validateRunId(runId), "run"),
});

const normalizeObjective = (objective: string): string => {
  if (typeof objective !== "string" || objective.trim() === "") {
    throw new Error("objective must be a non-empty string");
  }
  return objective.trim();
};

const validateRunId = (runId: string): string => {
  if (typeof runId !== "string" || runId.trim() === "") {
    throw new Error("runId must be a non-empty string");
  }
  return runId.trim();
};

const formatBranchTimestamp = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  const millis = date.getTime();
  if (!Number.isFinite(millis)) throw new Error("now must be a valid date");

  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  const second = pad(date.getUTCSeconds());

  return `${year}${month}${day}T${hour}${minute}${second}Z`;
};

const pad = (value: number): string => value.toString().padStart(2, "0");

const invalidBranchCharacters = new Set(["~", "^", ":", "?", "*", "[", "]", "\\"]);

const hasInvalidBranchCharacter = (branchName: string): boolean => {
  for (const character of branchName) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 32 || codePoint === 127 || invalidBranchCharacters.has(character)) {
      return true;
    }
  }
  return false;
};

const slugify = (value: string, fallback: string): string => {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");

  return slug === "" ? fallback : slug;
};
