import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

import { heartbeatStatus, heartbeats } from "../../drizzle/schema.js";
import { AgentTask } from "../input.js";
import { db } from "./db.js";

const text = (schema: z.ZodString) => schema.trim().min(1);

export const NewHeartbeat = createInsertSchema(heartbeats, {
  id: (schema) => text(schema).optional(),
  agentId: text,
  title: (schema) => text(schema).default("heartbeat"),
  cadenceSeconds: (schema) => schema.int().positive().default(60),
  specJson: () => AgentTask,
  status: () => z.enum(heartbeatStatus).default(heartbeatStatus.active),
  lastTickAt: () => z.coerce.date().optional(),
  nextTickAt: () => z.coerce.date().optional(),
}).omit({
  createdAt: true,
  updatedAt: true,
});

export async function createHeartbeat(input: z.infer<typeof NewHeartbeat>) {
  const id = input.id ?? randomUUID();
  const [heartbeat] = await db.insert(heartbeats).values({
    id,
    agentId: input.agentId,
    title: input.title,
    cadenceSeconds: input.cadenceSeconds,
    specJson: input.specJson as Record<string, unknown>,
    lastTickAt: input.lastTickAt,
    nextTickAt: input.nextTickAt ?? nextTick(input.cadenceSeconds, input.status),
    status: input.status,
  }).returning();
  return fromRow(heartbeat);
}

export async function listHeartbeats(agentId?: string) {
  const rows = agentId
    ? await db.select().from(heartbeats).where(eq(heartbeats.agentId, agentId)).orderBy(asc(heartbeats.createdAt))
    : await db.select().from(heartbeats).orderBy(asc(heartbeats.createdAt));
  return rows.map(fromRow);
}

export async function getHeartbeat(id: string) {
  const [heartbeat] = await db.select().from(heartbeats).where(eq(heartbeats.id, id)).limit(1);
  return heartbeat ? fromRow(heartbeat) : null;
}

export async function deleteHeartbeat(id: string) {
  const [heartbeat] = await db.delete(heartbeats).where(eq(heartbeats.id, id)).returning();
  return heartbeat ? fromRow(heartbeat) : null;
}

function nextTick(cadenceSeconds: number, status: string) {
  if (status !== heartbeatStatus.active) return undefined;
  return new Date(Date.now() + cadenceSeconds * 1000);
}

function fromRow(row: typeof heartbeats.$inferSelect) {
  return {
    id: row.id,
    agentId: row.agentId,
    title: row.title,
    cadenceSeconds: row.cadenceSeconds,
    spec: row.specJson as AgentTask,
    lastTickAt: row.lastTickAt?.toISOString(),
    nextTickAt: row.nextTickAt?.toISOString(),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
