import { randomUUID } from "node:crypto";

import { asc, desc, eq, max } from "drizzle-orm";

import { sandboxes } from "../../drizzle/schema.js";
import type { SandboxInput } from "../input.js";
import { db } from "./client.js";

export async function createSandboxRecord(threadId: string, input: SandboxInput) {
  const next = await nextSandboxIndex(threadId);
  const [sandbox] = await db.insert(sandboxes).values({
    id: randomUUID(),
    threadId,
    provider: input.provider,
    externalId: input.externalId,
    idleExpiresAt: input.idleExpiresAt,
    index: next,
  }).returning();
  return fromRow(sandbox);
}

export async function listSandboxRecords(threadId: string) {
  return (await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.threadId, threadId))
    .orderBy(asc(sandboxes.index))).map(fromRow);
}

export async function getCurrentSandboxRecord(threadId: string) {
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.threadId, threadId))
    .orderBy(desc(sandboxes.index))
    .limit(1);
  return sandbox ? fromRow(sandbox) : null;
}

export async function closeSandboxRecord(id: string, closedAt = new Date()) {
  const [sandbox] = await db.update(sandboxes).set({
    closedAt,
    updatedAt: closedAt,
  }).where(eq(sandboxes.id, id)).returning();
  return sandbox ? fromRow(sandbox) : null;
}

async function nextSandboxIndex(threadId: string) {
  const [row] = await db
    .select({ value: max(sandboxes.index) })
    .from(sandboxes)
    .where(eq(sandboxes.threadId, threadId));
  return (row.value ?? 0) + 1;
}

function fromRow(row: typeof sandboxes.$inferSelect) {
  return {
    id: row.id,
    threadId: row.threadId,
    provider: row.provider,
    externalId: row.externalId,
    idleExpiresAt: row.idleExpiresAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    closedAt: row.closedAt?.toISOString(),
    index: row.index,
  };
}

export type SandboxRecord = ReturnType<typeof fromRow>;
