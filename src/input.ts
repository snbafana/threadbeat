import { z } from "zod";

const text = z.string().trim().min(1);
const jsonRecord = z.record(z.string(), z.unknown());

export const Id = z.object({
  id: text,
});

export const Command = z.object({
  cmd: text,
  cwd: text.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
}).passthrough();
export type Command = z.infer<typeof Command>;

export const HeartbeatInput = z.object({
  title: text,
  cadenceSeconds: z.number().int().positive(),
  messageJson: jsonRecord,
  nextTickAt: z.coerce.date().optional(),
  status: z.enum(["active", "paused", "disabled"]).optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

export const ThreadInput = z.object({
  title: text,
  agentId: text.optional(),
  goalJson: jsonRecord,
  status: z.enum(["queued", "running", "idle", "paused", "completed", "failed", "archived"]).optional(),
});
export type ThreadInput = z.infer<typeof ThreadInput>;

export const MessageInput = z.object({
  role: z.enum(["human", "agent", "heartbeat"]),
  contentJson: jsonRecord,
});
export type MessageInput = z.infer<typeof MessageInput>;

export const SandboxInput = z.object({
  provider: text,
  externalId: text,
  idleExpiresAt: z.coerce.date().optional(),
});
export type SandboxInput = z.infer<typeof SandboxInput>;

export const ArtifactInput = z.object({
  kind: text,
  uri: text,
  contentType: text.optional(),
  sha256: text.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  summaryJson: jsonRecord.optional(),
});
export type ArtifactInput = z.infer<typeof ArtifactInput>;

export function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}
