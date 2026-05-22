import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import { artifacts } from "../../drizzle/schema.js";
import type { ArtifactInput } from "../input.js";
import { db } from "./client.js";

export async function createArtifact(threadId: string, input: ArtifactInput) {
  const [artifact] = await db.insert(artifacts).values({
    id: randomUUID(),
    threadId,
    kind: input.kind,
    uri: input.uri,
    contentType: input.contentType,
    sha256: input.sha256,
    sizeBytes: input.sizeBytes,
    summaryJson: input.summaryJson,
  }).returning();
  return fromRow(artifact);
}

export async function listArtifacts(threadId: string) {
  return (await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.threadId, threadId))
    .orderBy(asc(artifacts.createdAt))).map(fromRow);
}

function fromRow(row: typeof artifacts.$inferSelect) {
  return {
    id: row.id,
    threadId: row.threadId,
    kind: row.kind,
    uri: row.uri,
    contentType: row.contentType ?? undefined,
    sha256: row.sha256 ?? undefined,
    sizeBytes: row.sizeBytes ?? undefined,
    summary: row.summaryJson ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

export type Artifact = ReturnType<typeof fromRow>;
