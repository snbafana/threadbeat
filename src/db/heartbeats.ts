import { randomUUID } from "node:crypto";

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

import { eventType, heartbeats, heartbeatStatus } from "../../drizzle/schema.js";
import type { HeartbeatInput } from "../input.js";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { appendMessage } from "./messages.js";

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

export async function drainDueHeartbeats(limit = 10, now = new Date()) {
  const due = await db
    .select()
    .from(heartbeats)
    .where(and(
      eq(heartbeats.status, heartbeatStatus.active),
      isNotNull(heartbeats.threadId),
      lte(heartbeats.nextTickAt, now),
    ))
    .orderBy(asc(heartbeats.nextTickAt))
    .limit(Math.max(1, limit));

  const messages: Array<{ heartbeatId: string; messageId: string }> = [];
  for (const row of due) {
    const claimed = await claimHeartbeatTick(row.id, row.cadenceSeconds, now);
    if (!claimed) continue;

    const message = await appendMessage(claimed.threadId, {
      role: "heartbeat",
      contentJson: claimed.messageJson,
    });
    await appendEvent(claimed.threadId, eventType.messageCreated, `heartbeat:${claimed.id}`, {
      heartbeatId: claimed.id,
      messageId: message.id,
    });
    messages.push({ heartbeatId: claimed.id, messageId: message.id });
  }

  return { processed: messages.length, messages };
}

async function claimHeartbeatTick(id: string, cadenceSeconds: number, now: Date) {
  const [heartbeat] = await db.update(heartbeats).set({
    lastTickAt: now,
    nextTickAt: new Date(now.getTime() + cadenceSeconds * 1000),
    updatedAt: now,
  }).where(and(
    eq(heartbeats.id, id),
    eq(heartbeats.status, heartbeatStatus.active),
    lte(heartbeats.nextTickAt, now),
  )).returning();
  return heartbeat ?? null;
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
