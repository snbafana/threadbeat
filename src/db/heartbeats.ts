import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { heartbeats, heartbeatStatus } from "../../drizzle/schema.js";
import type { HeartbeatInput } from "../input.js";
import { db } from "./client.js";

export async function createThreadHeartbeat(threadId: string, input: HeartbeatInput) {
  const [heartbeat] = await db.insert(heartbeats).values({
    id: randomUUID(),
    threadId,
    title: input.title,
    status: input.status ?? heartbeatStatus.active,
    cadenceSeconds: input.cadenceSeconds,
    messageJson: input.messageJson,
    nextTickAt: input.nextTickAt ?? new Date(Date.now() + input.cadenceSeconds * 1000),
  }).returning();
  return fromRow(heartbeat);
}

export async function listHeartbeats(filter: { threadId?: string } = {}) {
  return (await db
    .select()
    .from(heartbeats)
    .where(filter.threadId ? eq(heartbeats.threadId, filter.threadId) : undefined)
    .orderBy(asc(heartbeats.nextTickAt))).map(fromRow);
}

export async function getHeartbeat(id: string) {
  const [heartbeat] = await db.select().from(heartbeats).where(eq(heartbeats.id, id)).limit(1);
  return heartbeat ? fromRow(heartbeat) : null;
}

function fromRow(row: typeof heartbeats.$inferSelect) {
  return {
    id: row.id,
    threadId: row.threadId,
    title: row.title,
    status: row.status,
    cadenceSeconds: row.cadenceSeconds,
    message: row.messageJson,
    nextTickAt: row.nextTickAt.toISOString(),
    lastTickAt: row.lastTickAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type Heartbeat = ReturnType<typeof fromRow>;
