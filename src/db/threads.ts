import { randomUUID } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { threadStatus, threads, type ThreadStatus } from "../../drizzle/schema.js";
import type { ThreadInput } from "../input.js";
import { db } from "./client.js";

export async function createThread(input: ThreadInput) {
  const [thread] = await db.insert(threads).values({
    id: randomUUID(),
    title: input.title,
    status: input.status ?? threadStatus.queued,
    agentId: input.agentId,
    goalJson: input.goalJson,
  }).returning();
  return fromRow(thread);
}

export async function listThreads() {
  return (await db.select().from(threads).orderBy(desc(threads.updatedAt))).map(fromRow);
}

export async function getThread(id: string) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, id)).limit(1);
  return thread ? fromRow(thread) : null;
}

export async function updateThreadStatus(id: string, status: ThreadStatus) {
  const [thread] = await db.update(threads).set({
    status,
    updatedAt: new Date(),
  }).where(eq(threads.id, id)).returning();
  return thread ? fromRow(thread) : null;
}

export async function updateThreadGoal(id: string, goalJson: Record<string, unknown>) {
  const [thread] = await db.update(threads).set({
    goalJson,
    updatedAt: new Date(),
  }).where(eq(threads.id, id)).returning();
  return thread ? fromRow(thread) : null;
}

function fromRow(row: typeof threads.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    agentId: row.agentId ?? undefined,
    goal: row.goalJson,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type Thread = ReturnType<typeof fromRow>;
