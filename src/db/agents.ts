import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { agents } from "../../drizzle/schema.js";
import type { AgentInput } from "../input.js";
import { db } from "./client.js";

export async function createAgent(input: AgentInput) {
  const [agent] = await db.insert(agents).values({
    id: input.id ?? randomUUID(),
    name: input.name,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch,
  }).returning();
  return agent;
}

export async function listAgents() {
  return await db.select().from(agents).orderBy(asc(agents.name));
}

export async function getAgent(id: string) {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return agent ?? null;
}
