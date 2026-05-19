import type { CommandSpec, TaskSpec } from "./types.js";

export const parseTaskSpec = (value: unknown): TaskSpec => {
  if (!isRecord(value)) throw new Error("task spec must be an object");
  const repo = value.repo === undefined ? undefined : parseRepo(value.repo);
  const setup = value.setup === undefined ? [] : parseCommandArray(value.setup, "setup");
  const verify = value.verify === undefined ? [] : parseCommandArray(value.verify, "verify");
  const main = parseCommand(value.main, "main");
  return { repo, setup, main, verify };
};

export const commandLabel = (phase: "setup" | "main" | "verify", index: number): string =>
  phase === "main" ? "main" : `${phase}[${index}]`;

const parseRepo = (value: unknown): TaskSpec["repo"] => {
  if (!isRecord(value)) throw new Error("repo must be an object");
  if (typeof value.url !== "string" || !value.url.trim()) throw new Error("repo.url is required");
  if (value.branch !== undefined && typeof value.branch !== "string") throw new Error("repo.branch must be a string");
  if (value.commit !== undefined && typeof value.commit !== "string") throw new Error("repo.commit must be a string");
  return {
    url: value.url,
    branch: value.branch,
    commit: value.commit,
  };
};

const parseCommandArray = (value: unknown, name: string): CommandSpec[] => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((command, index) => parseCommand(command, `${name}[${index}]`));
};

const parseCommand = (value: unknown, name: string): CommandSpec => {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  if (typeof value.cmd !== "string" || !value.cmd.trim()) throw new Error(`${name}.cmd is required`);
  if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error(`${name}.cwd must be a string`);
  const timeoutSeconds = value.timeoutSeconds;
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1)
  ) {
    throw new Error(`${name}.timeoutSeconds must be a positive integer`);
  }
  return {
    cmd: value.cmd,
    cwd: value.cwd,
    timeoutSeconds,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
