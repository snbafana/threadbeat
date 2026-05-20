import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import type { z } from "zod";

import { agents } from "../../drizzle/schema.js";
import { db } from "./client.js";

const text = (schema: z.ZodString) => schema.trim().min(1);

export const NewAgent = createInsertSchema(agents, {
  id: (schema) => text(schema).optional(),
  name: text,
  repoUrl: text,
  defaultBranch: text,
});

export async function createAgent(input: z.infer<typeof NewAgent>) {
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
