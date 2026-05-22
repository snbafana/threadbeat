import { bigserial, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const eventTypeValues = [
  "thread.started",
  "thread.idle",
  "thread.completed",
  "thread.failed",
  "message.created",
  "agent.started",
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

export const heartbeatStatusValues = [
  "active",
  "paused",
  "disabled",
] as const;

export const threadStatusValues = [
  "queued",
  "running",
  "idle",
  "paused",
  "completed",
  "failed",
  "archived",
] as const;

export const messageRoleValues = [
  "human",
  "agent",
  "heartbeat",
] as const;

export const eventTypeEnum = pgEnum("event_type", eventTypeValues);
export const heartbeatStatusEnum = pgEnum("heartbeat_status", heartbeatStatusValues);
export const threadStatusEnum = pgEnum("thread_status", threadStatusValues);
export const messageRoleEnum = pgEnum("message_role", messageRoleValues);

export type EventType = (typeof eventTypeValues)[number];
export type HeartbeatStatus = (typeof heartbeatStatusValues)[number];
export type ThreadStatus = (typeof threadStatusValues)[number];
export type MessageRole = (typeof messageRoleValues)[number];

export const eventType = {
  threadStarted: "thread.started",
  threadIdle: "thread.idle",
  threadCompleted: "thread.completed",
  threadFailed: "thread.failed",
  messageCreated: "message.created",
  agentStarted: "agent.started",
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

export const heartbeatStatus = {
  active: "active",
  paused: "paused",
  disabled: "disabled",
} as const satisfies Record<string, HeartbeatStatus>;

export const threadStatus = {
  queued: "queued",
  running: "running",
  idle: "idle",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  archived: "archived",
} as const satisfies Record<string, ThreadStatus>;

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
}).enableRLS();

export const threads = pgTable("threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  status: threadStatusEnum("status").notNull().default(threadStatus.queued),
  agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
  goalJson: jsonb("goal_json").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_threads_agent_id").on(table.agentId),
  index("idx_threads_status_updated_at").on(table.status, table.updatedAt),
]).enableRLS();

export const sandboxes = pgTable("sandboxes", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  externalId: text("external_id").notNull(),
  idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  index: integer("index").notNull(),
}, (table) => [
  uniqueIndex("idx_sandboxes_thread_index").on(table.threadId, table.index),
  index("idx_sandboxes_thread_created_at").on(table.threadId, table.createdAt),
]).enableRLS();

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  role: messageRoleEnum("role").notNull(),
  contentJson: jsonb("content_json").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_messages_thread_created_at").on(table.threadId, table.createdAt),
]).enableRLS();

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  uri: text("uri").notNull(),
  contentType: text("content_type"),
  sha256: text("sha256"),
  sizeBytes: integer("size_bytes"),
  summaryJson: jsonb("summary_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_artifacts_thread_created_at").on(table.threadId, table.createdAt),
  index("idx_artifacts_kind").on(table.kind),
]).enableRLS();

export const heartbeats = pgTable("heartbeats", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  status: heartbeatStatusEnum("status").notNull().default(heartbeatStatus.active),
  cadenceSeconds: integer("cadence_seconds").notNull(),
  messageJson: jsonb("message_json").notNull().$type<Record<string, unknown>>(),
  lastTickAt: timestamp("last_tick_at", { withTimezone: true }),
  nextTickAt: timestamp("next_tick_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_heartbeats_thread_id").on(table.threadId),
  index("idx_heartbeats_due").on(table.status, table.nextTickAt, table.createdAt),
]).enableRLS();

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  seq: bigserial("seq", { mode: "number" }).notNull().unique(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  type: eventTypeEnum("type").notNull(),
  source: text("source").notNull(),
  dataJson: jsonb("data_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_events_thread_seq").on(table.threadId, table.seq),
]).enableRLS();
