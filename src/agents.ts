import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { agents } from "../drizzle/schema.js";
import { db } from "./db.js";

export type Agent = {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
};

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
  return fromRow(agent);
}

export async function listAgents() {
  return (await db.select().from(agents).orderBy(asc(agents.name))).map(fromRow);
}

export async function getAgent(id: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return agent ? fromRow(agent) : null;
}

function fromRow(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
  };
}
