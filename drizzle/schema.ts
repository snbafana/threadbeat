import { bigserial, index, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const taskStatusValues = [
  "queued",
  "claimed",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
] as const;

export const eventTypeValues = [
  "task.created",
  "task.leased",
  "task.started",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.expired",
  "message.created",
  "model.started",
  "model.delta",
  "model.completed",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "command.started",
  "command.stdout",
  "command.stderr",
  "command.completed",
  "command.failed",
  "sandbox.created",
  "sandbox.deleted",
  "sandbox.delete_failed",
  "repo.cloned",
  "artifact.created",
  "checkpoint.created",
  "error.raised",
] as const;

export const taskStatusEnum = pgEnum("task_status", taskStatusValues);
export const eventTypeEnum = pgEnum("event_type", eventTypeValues);

export type TaskStatus = (typeof taskStatusValues)[number];
export type EventType = (typeof eventTypeValues)[number];

export const taskStatus = {
  queued: "queued",
  claimed: "claimed",
  running: "running",
  waiting: "waiting",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  expired: "expired",
} as const satisfies Record<string, TaskStatus>;

export const eventType = {
  taskCreated: "task.created",
  taskLeased: "task.leased",
  taskStarted: "task.started",
  taskCompleted: "task.completed",
  taskFailed: "task.failed",
  taskCancelled: "task.cancelled",
  taskExpired: "task.expired",
  messageCreated: "message.created",
  modelStarted: "model.started",
  modelDelta: "model.delta",
  modelCompleted: "model.completed",
  toolStarted: "tool.started",
  toolCompleted: "tool.completed",
  toolFailed: "tool.failed",
  commandStarted: "command.started",
  commandStdout: "command.stdout",
  commandStderr: "command.stderr",
  commandCompleted: "command.completed",
  commandFailed: "command.failed",
  sandboxCreated: "sandbox.created",
  sandboxDeleted: "sandbox.deleted",
  sandboxDeleteFailed: "sandbox.delete_failed",
  repoCloned: "repo.cloned",
  artifactCreated: "artifact.created",
  checkpointCreated: "checkpoint.created",
  errorRaised: "error.raised",
} as const satisfies Record<string, EventType>;

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
}).enableRLS();

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  runBranch: text("run_branch"),
  status: taskStatusEnum("status").notNull(),
  specJson: jsonb("spec_json").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
}, (table) => [
  index("idx_tasks_status_created_at").on(table.status, table.createdAt),
]).enableRLS();

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  seq: bigserial("seq", { mode: "number" }).notNull().unique(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  type: eventTypeEnum("type").notNull(),
  source: text("source").notNull(),
  dataJson: jsonb("data_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_events_task_seq").on(table.taskId, table.seq),
]).enableRLS();
