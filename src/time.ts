import type { HeartbeatStatus } from "./types.js";

export const nowIso = (): string => new Date().toISOString();

export const nextTickIso = (cadence: number, status: HeartbeatStatus): string | null => {
  if (status !== "active") return null;
  return new Date(Date.now() + cadence * 1000).toISOString();
};
