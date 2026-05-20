import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import { tasks, taskStatus, type TaskStatus } from "../../drizzle/schema.js";
import type { AgentTask, CommandTask } from "../input.js";
import { db } from "./db.js";

export async function createTask(
  spec: CommandTask | AgentTask,
  options: { id?: string; agentId?: string; runBranch?: string } = {},
) {
  const id = options.id ?? randomUUID();
  const [task] = await db.insert(tasks).values({
    id,
    agentId: options.agentId,
    runBranch: options.runBranch ?? (options.agentId ? `runs/${id}` : undefined),
    status: taskStatus.queued,
    specJson: spec as Record<string, unknown>,
  }).returning();
  return fromRow(task);
}

export async function listTasks() {
  return (await db.select().from(tasks).orderBy(desc(tasks.createdAt))).map(fromRow);
}

export async function getTask(id: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return task ? fromRow(task) : null;
}

export async function claimNextTask() {
  const [task] = await db.select().from(tasks).where(eq(tasks.status, taskStatus.queued)).orderBy(asc(tasks.createdAt)).limit(1);
  if (!task) return null;
  const [claimed] = await db.update(tasks).set({ status: taskStatus.claimed }).where(and(eq(tasks.id, task.id), eq(tasks.status, taskStatus.queued))).returning();
  return claimed ? fromRow(claimed) : null;
}

export async function updateTaskStatus(id: string, status: TaskStatus, error?: string) {
  if (status === taskStatus.running) {
    await db.update(tasks).set({ status, startedAt: sql`COALESCE(${tasks.startedAt}, now())` }).where(eq(tasks.id, id));
  } else if (status === taskStatus.succeeded) {
    await db.update(tasks).set({ status, completedAt: new Date(), error: null }).where(eq(tasks.id, id));
  } else if (status === taskStatus.failed) {
    await db.update(tasks).set({ status, completedAt: new Date(), error }).where(eq(tasks.id, id));
  }
}

function fromRow(row: typeof tasks.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId ?? undefined,
    runBranch: row.runBranch ?? undefined,
    status: row.status,
    spec: row.specJson as CommandTask | AgentTask,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString(),
    completedAt: row.completedAt?.toISOString(),
    error: row.error ?? undefined,
  };
}

export type Task = ReturnType<typeof fromRow>;
