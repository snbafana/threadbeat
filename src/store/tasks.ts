import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, sql } from "drizzle-orm";

import { tasks, taskStatus, type TaskStatus } from "../../drizzle/schema.js";
import type { AgentTask, CommandTask } from "../input.js";
import { db } from "./db.js";

export type Task = {
  id: string;
  agentId?: string;
  runBranch?: string;
  status: TaskStatus;
  spec: CommandTask | AgentTask;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
};

export type CreateTaskOptions = {
  id?: string;
  agentId?: string;
  runBranch?: string;
};

export async function createTask(spec: CommandTask | AgentTask, options: CreateTaskOptions = {}) {
  const id = options.id ?? randomUUID();
  const [task] = await db.insert(tasks).values({
    id,
    agentId: options.agentId,
    runBranch: options.runBranch ?? (options.agentId ? runBranchForTask(id) : undefined),
    status: taskStatus.queued,
    specJson: spec as Record<string, unknown>,
  }).returning();
  return fromRow(task);
}

export function runBranchForTask(id: string) {
  return `runs/${id}`;
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

function fromRow(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    agentId: row.agentId ?? undefined,
    runBranch: row.runBranch ?? undefined,
    status: row.status,
    spec: row.specJson as CommandTask | AgentTask,
    createdAt: iso(row.createdAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    error: row.error ?? undefined,
  };
}

function iso(value?: Date | string | null) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
