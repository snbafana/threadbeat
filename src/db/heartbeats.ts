import { randomUUID } from "node:crypto";

import { and, asc, eq, lte } from "drizzle-orm";

import { eventType, heartbeats, heartbeatStatus } from "../../drizzle/schema.js";
import type { AgentTask, HeartbeatInput } from "../input.js";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { createTask } from "./tasks.js";

export async function createHeartbeat(agentId: string, input: HeartbeatInput) {
  const [heartbeat] = await db.insert(heartbeats).values({
    id: randomUUID(),
    agentId,
    title: input.title,
    status: input.status ?? heartbeatStatus.active,
    cadenceSeconds: input.cadenceSeconds,
    specJson: { ask: input.prompt, inputs: input.inputs },
    nextTickAt: input.nextTickAt ?? new Date(Date.now() + input.cadenceSeconds * 1000),
  }).returning();
  return fromRow(heartbeat);
}

export async function listHeartbeats(filter: { agentId?: string } = {}) {
  return (await db
    .select()
    .from(heartbeats)
    .where(filter.agentId ? eq(heartbeats.agentId, filter.agentId) : undefined)
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
    .where(and(eq(heartbeats.status, heartbeatStatus.active), lte(heartbeats.nextTickAt, now)))
    .orderBy(asc(heartbeats.nextTickAt))
    .limit(Math.max(1, limit));

  const created: Array<{ heartbeatId: string; taskId: string }> = [];
  for (const row of due) {
    const claimed = await claimHeartbeatTick(row.id, row.cadenceSeconds, now);
    if (!claimed) continue;

    const taskSpec = claimed.specJson as AgentTask;
    const task = await createTask(taskSpec, { agentId: row.agentId });
    await appendEvent(task.id, eventType.taskCreated, `heartbeat:${row.id}`, {
      heartbeatId: row.id,
      agentId: row.agentId,
      spec: taskSpec,
      runBranch: task.runBranch,
    });
    created.push({ heartbeatId: row.id, taskId: task.id });
  }

  return { processed: created.length, created };
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
    agentId: row.agentId,
    title: row.title,
    status: row.status,
    cadenceSeconds: row.cadenceSeconds,
    spec: row.specJson as AgentTask,
    nextTickAt: row.nextTickAt.toISOString(),
    lastTickAt: row.lastTickAt?.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type Heartbeat = ReturnType<typeof fromRow>;
