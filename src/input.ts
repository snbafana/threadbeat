import { z } from "zod";

const text = z.string().trim().min(1);

export const Id = z.object({
  id: text,
});
export type Id = z.infer<typeof Id>;

export const Command = z.object({
  cmd: text,
  cwd: text.optional(),
  timeoutSeconds: z.number().int().positive().optional(),
}).passthrough();
export type Command = z.infer<typeof Command>;

export const CommandTask = z.object({
  repo: z.object({
    url: text,
    branch: text.optional(),
    commit: text.optional(),
  }).passthrough().optional(),
  setup: z.array(Command).optional(),
  main: Command,
  verify: z.array(Command).optional(),
}).passthrough();
export type CommandTask = z.infer<typeof CommandTask>;

export const AgentTask = z.object({
  ask: text,
  inputs: z.object({
    files: z.array(z.object({
      path: text,
      content: z.string(),
    })).optional(),
    repo: z.object({
      url: text,
      branch: text.optional(),
      path: text.optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  constraints: z.object({
    timeoutSeconds: z.number().int().positive().optional(),
  }).passthrough().optional(),
}).passthrough();
export type AgentTask = z.infer<typeof AgentTask>;

export const NewAgent = z.object({
  id: text.optional(),
  name: text,
  repoUrl: text,
  defaultBranch: text,
});
export type NewAgent = z.infer<typeof NewAgent>;

export const EventsQuery = z.object({
  taskId: text.optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().optional(),
});
export type EventsQuery = z.infer<typeof EventsQuery>;

export const Drain = z.object({
  limit: z.number().int().positive().optional(),
});
export type Drain = z.infer<typeof Drain>;

export function errorMessage(error: unknown) {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}
