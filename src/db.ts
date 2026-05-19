import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { events, runs, tasks } from "../drizzle/schema.js";
import { config } from "./config.js";

const client = postgres(config.databaseUrl, { prepare: false });
const db = drizzle(client);

export async function bootstrap() {
  const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema/bootstrap.sql");
  await client.unsafe(await fs.readFile(schemaPath, "utf8"));
}

export async function createTask(spec: Record<string, unknown>) {
  const [task] = await db.insert(tasks).values({
    id: randomUUID(),
    status: "queued",
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
  const [task] = await db.select().from(tasks).where(eq(tasks.status, "queued")).orderBy(asc(tasks.createdAt)).limit(1);
  if (!task) return null;
  const [claimed] = await db.update(tasks).set({ status: "claimed" }).where(eq(tasks.id, task.id)).returning();
  return claimed ? taskFromRow(claimed) : null;
}

export async function updateTaskStatus(id: string, status: string, error?: string) {
  if (status === "running") {
    await db.update(tasks).set({ status, startedAt: sql`COALESCE(${tasks.startedAt}, now())` }).where(eq(tasks.id, id));
  } else if (status === "succeeded") {
    await db.update(tasks).set({ status, completedAt: new Date(), error: null }).where(eq(tasks.id, id));
  } else if (status === "failed") {
    await db.update(tasks).set({ status, completedAt: new Date(), error }).where(eq(tasks.id, id));
  }
}

export async function createRun(taskId: string) {
  const [run] = await db.insert(runs).values({
    id: randomUUID(),
    taskId,
    status: "running",
    startedAt: new Date(),
  }).returning();
  return runFromRow(run);
}

export async function updateRun(runId: string, fields: { sandboxId?: string; status?: string; error?: string }) {
  if (fields.sandboxId) await db.update(runs).set({ sandboxId: fields.sandboxId }).where(eq(runs.id, runId));
  if (fields.status === "succeeded") {
    await db.update(runs).set({ status: "succeeded", completedAt: new Date(), error: null }).where(eq(runs.id, runId));
  } else if (fields.status === "failed") {
    await db.update(runs).set({ status: "failed", completedAt: new Date(), error: fields.error }).where(eq(runs.id, runId));
  }
}

export async function listRuns() {
  return (await db.select().from(runs).orderBy(desc(runs.createdAt))).map(runFromRow);
}

export async function getRun(id: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return run ? runFromRow(run) : null;
}

export async function appendEvent(
  taskId: string,
  type: string,
  source: string,
  runId?: string,
  message?: string,
  data?: Record<string, unknown>,
) {
  const [event] = await db.insert(events).values({
    id: randomUUID(),
    taskId,
    runId,
    type,
    source,
    message,
    dataJson: data,
  }).returning();
  return eventFromRow(event);
}

export async function listEvents(filter: { taskId?: string; runId?: string; after?: number; limit?: number }) {
  const clauses = [
    filter.taskId ? eq(events.taskId, filter.taskId) : undefined,
    filter.runId ? eq(events.runId, filter.runId) : undefined,
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

function runFromRow(row: typeof runs.$inferSelect) {
  return {
    id: row.id,
    taskId: row.taskId,
    status: row.status,
    sandboxId: row.sandboxId ?? undefined,
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
    runId: row.runId ?? undefined,
    type: row.type,
    source: row.source,
    message: row.message ?? undefined,
    data: row.dataJson ?? undefined,
    createdAt: iso(row.createdAt),
  };
}

function iso(value?: Date | string | null) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
