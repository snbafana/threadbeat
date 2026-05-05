import type { HeartbeatStatus, RunStatus } from "./types.js";

export const parseString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
};

export const parsePositiveInt = (value: unknown, field: string, fallback?: number): number => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Math.floor(value);
};

export const parseHeartbeatStatus = (value: unknown, fallback: HeartbeatStatus): HeartbeatStatus => {
  if (value === undefined) return fallback;
  if (value === "active" || value === "inactive") return value;
  throw new Error("status must be active or inactive");
};

export const parseRunStatus = (value: unknown): RunStatus => {
  if (value === "succeeded" || value === "failed" || value === "skipped") return value;
  throw new Error("run status must be succeeded, failed, or skipped");
};

export const parseContentsPath = (value: unknown): string => {
  const contents = parseString(value, "contents").replace(/^\.\/+/, "");
  if (!contents.endsWith(".md")) throw new Error("contents must end in .md");
  if (contents.startsWith("/") || contents.split("/").includes("..")) {
    throw new Error("contents must be a repo-relative path");
  }
  return contents;
};
