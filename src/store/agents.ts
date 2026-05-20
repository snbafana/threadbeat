import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

import { agents } from "../../drizzle/schema.js";
import { db } from "./db.js";

const text = (schema: z.ZodString) => schema.trim().min(1);

export const NewAgent = createInsertSchema(agents, {
  id: (schema) => text(schema).optional(),
  name: text,
  repoUrl: text,
  defaultBranch: text,
});

export const AgentUpdate = z.object({
  name: z.string().trim().min(1).optional(),
  repoUrl: z.string().trim().min(1).optional(),
  defaultBranch: z.string().trim().min(1).optional(),
}).refine((input) => Object.keys(input).length > 0, {
  message: "at least one agent field is required",
});

export async function upsertAgent(input: z.infer<typeof NewAgent>) {
  const [agent] = await db.insert(agents).values({
    id: input.id ?? randomUUID(),
    name: input.name,
    repoUrl: input.repoUrl,
    defaultBranch: input.defaultBranch,
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      name: input.name,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
    },
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

export async function updateAgent(id: string, input: z.infer<typeof AgentUpdate>) {
  const [agent] = await db.update(agents).set(input).where(eq(agents.id, id)).returning();
  return agent ?? null;
}

export async function deleteAgent(id: string) {
  const [agent] = await db.delete(agents).where(eq(agents.id, id)).returning({ id: agents.id });
  return agent ?? null;
}
