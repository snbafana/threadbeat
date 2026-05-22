import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { messages } from "../../drizzle/schema.js";
import type { MessageInput } from "../input.js";
import { db } from "./client.js";

export async function appendMessage(threadId: string, input: MessageInput) {
  const [message] = await db.insert(messages).values({
    id: randomUUID(),
    threadId,
    role: input.role,
    contentJson: input.contentJson,
  }).returning();
  return fromRow(message);
}

export async function listMessages(threadId: string) {
  return (await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt))).map(fromRow);
}

function fromRow(row: typeof messages.$inferSelect) {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.contentJson,
    createdAt: row.createdAt.toISOString(),
  };
}

export type Message = ReturnType<typeof fromRow>;
