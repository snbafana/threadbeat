import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { agents, events, tasks, taskStatus, type EventType, type TaskStatus } from "../drizzle/schema.js";
import { config } from "./config.js";

if (!config.databaseUrl) throw new Error("DATABASE_URL is required");

const client = postgres(config.databaseUrl, { prepare: false });
const db = drizzle(client);

export type CreateAgentInput = {
  id?: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
};

export async function createAgent(input: CreateAgentInput) {
  const [agent] = await db.insert(agents).values({
    id: input.id ?? randomUUID(),
    name: input.name,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch,
  }).returning();
  return agentFromRow(agent);
}

export async function listAgents() {
  return (await db.select().from(agents).orderBy(asc(agents.name))).map(agentFromRow);
}

export async function getAgent(id: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return agent ? agentFromRow(agent) : null;
}

export async function createTask(spec: Record<string, unknown>) {
  const [task] = await db.insert(tasks).values({
    id: randomUUID(),
    status: taskStatus.queued,
    specJson: spec,
  }).returning();
  return taskFromRow(task);
}

export async function listTasks() {
  return (await db.select().from(tasks).orderBy(desc(tasks.createdAt))).map(taskFromRow);
}

export async function getTask(id: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return task ? taskFromRow(task) : null;
}

export async function claimNextTask() {
  const [task] = await db.select().from(tasks).where(eq(tasks.status, taskStatus.queued)).orderBy(asc(tasks.createdAt)).limit(1);
  if (!task) return null;
  const [claimed] = await db.update(tasks).set({ status: taskStatus.claimed }).where(and(eq(tasks.id, task.id), eq(tasks.status, taskStatus.queued))).returning();
  return claimed ? taskFromRow(claimed) : null;
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

export async function appendEvent(
  taskId: string,
  type: EventType,
  source: string,
  data?: Record<string, unknown>,
) {
  const [event] = await db.insert(events).values({
    id: randomUUID(),
    taskId,
    type,
    source,
    dataJson: data,
  }).returning();
  return eventFromRow(event);
}

export async function listEvents(filter: { taskId?: string; after?: number; limit?: number }) {
  const clauses = [
    filter.taskId ? eq(events.taskId, filter.taskId) : undefined,
    filter.after !== undefined ? gt(events.seq, filter.after) : undefined,
  ].filter(Boolean);

  const query = db
    .select()
    .from(events)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(events.seq))
    .limit(Math.min(filter.limit ?? 100, 500));

  return (await query).map(eventFromRow);
}

export async function close() {
  await client.end();
}

function taskFromRow(row: typeof tasks.$inferSelect) {
  return {
    id: row.id,
    status: row.status,
    spec: row.specJson,
    createdAt: iso(row.createdAt),
    startedAt: iso(row.startedAt),
    completedAt: iso(row.completedAt),
    error: row.error ?? undefined,
  };
}

function eventFromRow(row: typeof events.$inferSelect) {
  return {
    id: row.id,
    seq: row.seq,
    taskId: row.taskId,
    type: row.type,
    source: row.source,
    data: row.dataJson ?? undefined,
    createdAt: iso(row.createdAt),
  };
}

function agentFromRow(row: typeof agents.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
  };
}

function iso(value?: Date | string | null) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
