import { randomUUID } from "node:crypto";

import { and, asc, eq, gt } from "drizzle-orm";

import { events, type EventType } from "../../drizzle/schema.js";
import { db } from "./client.js";

export async function appendEvent(
  threadId: string,
  type: EventType,
  source: string,
  data?: Record<string, unknown>,
) {
  const [event] = await db.insert(events).values({
    id: randomUUID(),
    threadId,
    type,
    source,
    dataJson: data,
  }).returning();
  return fromRow(event);
}

export async function listEvents(filter: { threadId?: string; after?: number; limit?: number }) {
  const clauses = [
    filter.threadId ? eq(events.threadId, filter.threadId) : undefined,
    filter.after !== undefined ? gt(events.seq, filter.after) : undefined,
  ].filter(Boolean);

  const query = db
    .select()
    .from(events)
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(events.seq))
    .limit(Math.min(filter.limit ?? 100, 500));

  return (await query).map(fromRow);
}

function fromRow(row: typeof events.$inferSelect) {
  return {
    id: row.id,
    seq: row.seq,
    threadId: row.threadId,
    type: row.type,
    source: row.source,
    data: row.dataJson ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}
