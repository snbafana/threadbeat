import { bigserial, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tasks = pgTable("tasks", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  specJson: jsonb("spec_json").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
}, (table) => [
  index("idx_tasks_status_created_at").on(table.status, table.createdAt),
]).enableRLS();

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  sandboxId: text("sandbox_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  error: text("error"),
}, (table) => [
  index("idx_runs_task_id_created_at").on(table.taskId, table.createdAt),
  index("idx_runs_status_created_at").on(table.status, table.createdAt),
]).enableRLS();

export const events = pgTable("events", {
  id: text("id").primaryKey(),
  seq: bigserial("seq", { mode: "number" }).notNull().unique(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  source: text("source").notNull(),
  message: text("message"),
  dataJson: jsonb("data_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_events_task_seq").on(table.taskId, table.seq),
  index("idx_events_run_seq").on(table.runId, table.seq),
]).enableRLS();
